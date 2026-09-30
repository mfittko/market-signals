#!/usr/bin/env bash
# One-command local stack: Postgres (docker), Go control plane, Go worker, Next.js console.
#   scripts/dev.sh up      start everything (idempotent)
#   scripts/dev.sh down    stop app processes (add --db to stop Postgres too)
#   scripts/dev.sh status  show what is running
#   scripts/dev.sh logs    tail all logs
# Environment: MS_ENGINE_URL (default: the engine on 127.0.0.1:8787 when reachable). The control plane reads it with
#              GETs, but a chart GET can make the engine fetch upstream candles and upsert them into its SQLite;
#              the console proxy also forwards POST /settings, POST /chat and DELETE /threads.
#              MS_SETTINGS (engine settings.json; supplies the LLM endpoint, model and key to the worker and to the
#              control plane for strategy coaching; the console starts without them).
# Secrets: .dev/env (mode 600, gitignored) holds the worker and ingest tokens and the Postgres password, generated
#          once. It also holds MS_DATABASE_URL for the binaries and MS_TEST_DATABASE_URL for go test.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
RUN="$ROOT/.dev"
mkdir -p "$RUN/bin"

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "$1 is required"; }

alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }

stop_one() {
  if alive "$1"; then
    local pid; pid="$(cat "$RUN/$1.pid")"
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$RUN/$1.pid"
}

# start <name> <dir> <command...>: run detached, record the pid, log to .dev/<name>.log
start() {
  local name="$1" dir="$2"; shift 2
  (cd "$dir" && "$@" </dev/null >"$RUN/$name.log" 2>&1 & echo $! >"$RUN/$name.pid")
}

wait_http() { # url name seconds
  for _ in $(seq 1 "$3"); do
    curl -fsS -m 2 "$1" >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "$2 did not become ready (see $RUN/*.log)"
}

load_env() {
  if [ ! -f "$RUN/env" ]; then
    { echo "MS_WORKER_TOKEN=$(openssl rand -hex 16)"; echo "MS_INGEST_TOKEN=$(openssl rand -hex 16)"; } >"$RUN/env"
    chmod 600 "$RUN/env"
  fi
  # the database password is generated once; an env file from before it existed gains it here
  if ! grep -q '^MS_DB_PASSWORD=' "$RUN/env"; then
    local pw; pw="$(openssl rand -hex 24)"
    { echo "MS_DB_PASSWORD=$pw"
      echo "MS_DATABASE_URL=postgres://ms:$pw@127.0.0.1:5544/ms"
      echo "MS_TEST_DATABASE_URL=postgres://ms:$pw@127.0.0.1:5544/ms_test"; } >>"$RUN/env"
  fi
  set -a
  . "$RUN/env"
  set +a
}

engine_url() {
  if [ -n "${MS_ENGINE_URL:-}" ]; then echo "$MS_ENGINE_URL"; return; fi
  if curl -fsS -m 6 http://127.0.0.1:8787/api/health >/dev/null 2>&1; then echo http://127.0.0.1:8787; else echo ""; fi
}

settings_file() {
  if [ -n "${MS_SETTINGS:-}" ]; then echo "$MS_SETTINGS"; return; fi
  local common main
  common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  main="$(dirname "$common")"
  for f in "$ROOT/../data/settings.json" "$ROOT/../../data/settings.json" "$main/data/settings.json"; do
    [ -f "$f" ] && { echo "$f"; return; }
  done
  return 0
}

llm_env() {
  # the model settings feed the worker (agent runs) and the control plane (strategy coaching)
  local s flavor=""; s="$(settings_file)"
  # The engine's rule (resolveProvider, openaiEndpoint and effectiveModel in scripts/supertrend.mjs):
  # a non-blank OPENAI_BASE_URL means the openai-compatible flavor and its base URL; a blank one means
  # official OpenAI at its fixed URL. An explicit openai-compatible provider without a base URL is a
  # misconfiguration, so the key goes nowhere. The model comes from models[flavor], then the flat model
  # when the flavor is the active provider, then the engine default for official OpenAI.
  if [ -n "$s" ] && [ -n "$(jq -r '.OPENAI_API_KEY // empty' "$s")" ]; then
    flavor="$(jq -r '(.OPENAI_BASE_URL // "" | gsub("^\\s+|\\s+$"; "")) as $b
      | if $b != "" then "openai-compatible" elif .provider == "openai-compatible" then "" else "openai" end' "$s")"
  fi
  if [ -n "$flavor" ]; then
    export MS_LLM_BASE_URL MS_LLM_API_KEY MS_LLM_MODEL
    if [ "$flavor" = openai ]; then
      MS_LLM_BASE_URL="https://api.openai.com/v1"
    else
      MS_LLM_BASE_URL="$(jq -r '.OPENAI_BASE_URL | gsub("^\\s+|\\s+$"; "")' "$s")"
    fi
    MS_LLM_API_KEY="$(jq -r '.OPENAI_API_KEY' "$s")"
    MS_LLM_MODEL="$(jq -r --arg f "$flavor" '(.provider // "") as $p
      | (if ($p | IN("pi","claude-code","none","anthropic","openai","openai-compatible"))
           then (if $p == "openai" then $f else $p end)
         elif .ANTHROPIC_API_KEY then "anthropic" else $f end) as $active
      | (.models // {})[$f] // (if $active == $f then .model else null end)
        // (if $f == "openai" then "gpt-5.4-mini" else null end) // empty' "$s")"
    [ -n "$MS_LLM_MODEL" ] || echo "note: no model in $s; the llm agent fails until MS_LLM_MODEL is set"
    echo "LLM runtime: enabled (endpoint and key read from $s)"
  else
    echo "LLM runtime: disabled (set MS_SETTINGS or MS_LLM_BASE_URL / MS_LLM_API_KEY / MS_LLM_MODEL). The mock agent still works; strategy coaching is off."
  fi
}

db_up() {
  need docker; need jq; need openssl
  load_env
  docker compose up -d postgres >/dev/null
  for _ in $(seq 1 30); do
    docker compose exec -T postgres pg_isready -U ms -d ms >/dev/null 2>&1 && break
    sleep 1
  done
  # POSTGRES_PASSWORD applies only when the volume is first created, so set the role password
  # to the generated one every time; a volume created before the password existed keeps working.
  # The local socket in the container needs no password. The SQL goes through stdin, off the process list.
  printf "ALTER ROLE ms PASSWORD '%s';\n" "$MS_DB_PASSWORD" | docker compose exec -T postgres psql -q -U ms -d ms >/dev/null
  docker compose exec -T postgres psql -U ms -d ms -tc "SELECT 1 FROM pg_database WHERE datname='ms_test'" | grep -q 1 \
    || docker compose exec -T postgres psql -U ms -d ms -c "CREATE DATABASE ms_test" >/dev/null
}

# run <api|worker|web>: one service in the foreground, for a supervisor such as launchd.
# The engine URL is not probed here: the engine may start after this service, and the control plane retries.
run() {
  load_env; llm_env
  case "${1:-}" in
    api) cd "$ROOT"; MS_ENGINE_URL="${MS_ENGINE_URL:-http://127.0.0.1:8787}" exec "$RUN/bin/api" ;;
    worker) cd "$ROOT"; exec "$RUN/bin/worker" ;;
    web) cd "$ROOT/web"
      # same rule as `up`: the console inherits no model key, database password or service token
      exec env -u MS_LLM_API_KEY -u MS_LLM_BASE_URL -u MS_LLM_MODEL \
        -u MS_DB_PASSWORD -u MS_DATABASE_URL -u MS_TEST_DATABASE_URL -u MS_WORKER_TOKEN -u MS_INGEST_TOKEN \
        pnpm exec next start -p "${MS_CONSOLE_PORT:-3737}" -H 127.0.0.1 ;;
    *) die "usage: $0 run api|worker|web" ;;
  esac
}

up() {
  need docker; need go; need pnpm; need jq; need openssl
  load_env
  db_up

  go build -o "$RUN/bin/" ./cmd/api ./cmd/worker
  local engine; engine="$(engine_url)"

  llm_env

  if ! alive api; then
    MS_ENGINE_URL="$engine" start api "$ROOT" "$RUN/bin/api"
  fi
  wait_http http://127.0.0.1:8080/api/v1/health "control plane" 20

  if ! alive worker; then
    start worker "$ROOT" "$RUN/bin/worker"
  fi

  if ! alive web; then
    [ -d web/node_modules ] || (cd web && pnpm install --silent)
    # the console never calls a model or the database and holds no service token, so it inherits no LLM key, database password, worker token or ingest token
    start web "$ROOT/web" env -u MS_LLM_API_KEY -u MS_LLM_BASE_URL -u MS_LLM_MODEL \
      -u MS_DB_PASSWORD -u MS_DATABASE_URL -u MS_TEST_DATABASE_URL -u MS_WORKER_TOKEN -u MS_INGEST_TOKEN pnpm dev
  fi
  wait_http http://127.0.0.1:3000/api/v1/health "console" 90

  echo
  echo "Console:        http://127.0.0.1:3000"
  echo "Control plane:  http://127.0.0.1:8080/api/v1/health"
  echo "Engine (read):  ${engine:-not connected; demo runs work, live-engine runs do not}"
  echo "Ingest token for the engine hook: $RUN/env"
}

down() {
  load_env # docker compose needs MS_DB_PASSWORD to read the compose file
  for p in web worker api; do stop_one "$p"; done
  if [ "${1:-}" = "--db" ]; then docker compose stop postgres >/dev/null; fi
  echo "stopped"
}

status() {
  load_env
  for p in api worker web; do
    if alive "$p"; then echo "$p: running (pid $(cat "$RUN/$p.pid"))"; else echo "$p: stopped"; fi
  done
  if docker compose ps --status running postgres 2>/dev/null | grep -q postgres; then echo "postgres: running"; else echo "postgres: stopped"; fi
}

case "${1:-up}" in
  up) up ;;
  down) down "${2:-}" ;;
  status) status ;;
  db) db_up ;;
  run) run "${2:-}" ;;
  logs) tail -n 40 -f "$RUN"/api.log "$RUN"/worker.log "$RUN"/web.log ;;
  *) die "usage: $0 up|down|status|logs|db|run" ;;
esac
