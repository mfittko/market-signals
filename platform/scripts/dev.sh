#!/usr/bin/env bash
# One-command local stack: Postgres (docker), Go control plane, Go worker, Next.js console.
# The only thing the two stacks share is the Postgres server on 127.0.0.1:5544. Each has its own database, run
# directory, env file and ports.
#   development (up, down, status, logs): run directory .dev/dev, database ms_dev with role ms_dev, API 8081, console 3000
#   live (run, db; the launchd jobs):     run directory .dev, database ms with role ms, API 8080, console MS_CONSOLE_PORT (3737)
#   scripts/dev.sh up      start the development stack (idempotent)
#   scripts/dev.sh down    stop the development app processes (--db also stops the shared Postgres server, which
#                          the live stack uses too)
#   scripts/dev.sh status  show what of the development stack is running
#   scripts/dev.sh logs    tail the development logs
#   scripts/dev.sh db      start Postgres and set the live role password (switch-launchd.sh calls it)
#   scripts/dev.sh run api|worker|web   one live service in the foreground, for a supervisor such as launchd
# Environment: MS_ENGINE_URL (default: the engine on 127.0.0.1:8787 when reachable). The control plane reads it with
#              GETs, but a chart GET can make the engine fetch upstream candles and upsert them into its SQLite;
#              the console proxy also forwards POST /settings, POST /chat and DELETE /threads.
#              MS_SETTINGS (engine settings.json; supplies the LLM endpoint, model and key to the worker and to the
#              control plane for strategy coaching; the console starts without them).
# Secrets: each stack's env file (.dev/env live, .dev/dev/env development; mode 600, gitignored) holds its own worker
#          and ingest tokens, generated once, and its stack's database password. It also holds MS_DATABASE_URL for the
#          binaries and MS_TEST_DATABASE_URL for go test. Every development checkout uses the one ms_dev password in
#          $XDG_CONFIG_HOME/market-signals/dev-db-password (~/.config when XDG_CONFIG_HOME is unset or relative), so
#          they share the role ms_dev.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"
. "$ROOT/scripts/api-origins.sh"

# use_stack dev|live sets the run directory and the API address of one stack. MS_RUN_DIR overrides the directory
# of both, so a test can use a scratch directory.
use_stack() {
  STACK="$1"
  if [ "$STACK" = dev ]; then
    RUN="${MS_RUN_DIR:-$ROOT/.dev/dev}"
    # the worker and the console proxy reach the development control plane, never the live one on 8080
    export MS_API_ADDR=127.0.0.1:8081 MS_API_URL=http://127.0.0.1:8081
  else
    RUN="${MS_RUN_DIR:-$ROOT/.dev}"
  fi
  mkdir -p "$RUN/bin"
}
use_stack live

# every line this script prints carries a time and a level, like the Go services' slog text output
log() { local level="$1"; shift; echo "time=$(date +%Y-%m-%dT%H:%M:%S%z) level=$level msg=\"$*\""; }
die() { log ERROR "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "$1 is required"; }

# A pid file can outlive its process, and the number can then belong to an unrelated program. So a pid counts as
# ours only when it is running and its command line is the expected program: the built binary for api and worker,
# and the pnpm or next process for web.
alive() {
  [ -f "$RUN/$1.pid" ] || return 1
  local pid cmd; pid="$(cat "$RUN/$1.pid")"
  kill -0 "$pid" 2>/dev/null || return 1
  cmd="$(ps -o command= -p "$pid" 2>/dev/null)" || return 1
  case "$1" in
    api|worker) [[ "$cmd" == *"$RUN/bin/$1"* ]] ;;
    web) [[ "$cmd" == *pnpm* || "$cmd" == *next* ]] ;;
    *) return 1 ;;
  esac
}

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
  # exec makes the background pid the program itself, so alive() and stop_one see the real process
  (cd "$dir" && exec "$@" </dev/null >"$RUN/$name.log" 2>&1 & echo $! >"$RUN/$name.pid")
}

wait_http() { # url name seconds
  for _ in $(seq 1 "$3"); do
    curl -fsS -m 2 "$1" >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "$2 did not become ready (see $RUN/*.log)"
}

# dev_config_home: $XDG_CONFIG_HOME when it is absolute, else ~/.config. The XDG spec ignores a relative value, and
# dev.sh runs from each checkout's platform/, so a relative one would give every checkout its own password file.
dev_config_home() { if [[ "${XDG_CONFIG_HOME:-}" == /* ]]; then echo "$XDG_CONFIG_HOME"; else echo "$HOME/.config"; fi; }

# dev_db_password [seed]: the one ms_dev password of every checkout of this user. All checkouts share one Postgres
# server and its role ms_dev, so a password per checkout would lock the other checkouts out. The file lives outside
# every checkout, in dev_config_home. The first development command that loads the env file (up, status or down)
# writes it from the seed (the password of an older env file, so that checkout keeps working) or a new random one.
# load_env calls it in a command substitution, where set -e is off, so each step that could leave an invalid shared
# file dies explicitly before the link.
dev_db_password() {
  local dir f tmp pw seed="${1:-}"
  dir="$(dev_config_home)/market-signals"
  f="$dir/dev-db-password"
  if [ ! -e "$f" ]; then
    [[ "$seed" =~ ^[0-9a-f]{48}$ ]] || seed="$(openssl rand -hex 24)" || true
    [[ "$seed" =~ ^[0-9a-f]{48}$ ]] || die "could not generate a development database password with openssl"
    mkdir -p "$dir" || die "cannot create $dir"
    tmp="$(mktemp "$dir/.dev-db-password.XXXXXX")" || die "cannot create a temporary file in $dir"
    echo "$seed" >"$tmp" || { rm -f "$tmp"; die "cannot write $tmp"; }
    # ln refuses an existing name, so when two first runs race, both keep the file the faster one linked
    ln "$tmp" "$f" 2>/dev/null || true
    rm -f "$tmp"
  fi
  pw="$(cat "$f")"
  # the value goes into SQL and URLs, so only the generated form is accepted
  [[ "$pw" =~ ^[0-9a-f]{48}$ ]] || die "$f does not hold a development database password (48 hex digits); delete it and run again"
  echo "$pw"
}

load_env() {
  if [ ! -f "$RUN/env" ]; then
    # the file holds secrets, so it must never exist with wider permissions, even briefly
    ( umask 077; { echo "MS_WORKER_TOKEN=$(openssl rand -hex 16)"; echo "MS_INGEST_TOKEN=$(openssl rand -hex 16)"; } >"$RUN/env" )
    chmod 600 "$RUN/env"
  fi
  # MS_RUN_DIR can point both stacks at one file; the later MS_DATABASE_URL line would then move a stack to the
  # other stack's database, so a file holding the other stack's password is refused before anything is appended
  if [ "$STACK" = dev ]; then
    ! grep -q '^MS_DB_PASSWORD=' "$RUN/env" || die "$RUN/env belongs to the live stack; the development stack needs its own run directory"
  elif grep -q '^MS_DEV_DB_PASSWORD=' "$RUN/env"; then
    die "$RUN/env belongs to the development stack; the live stack needs its own run directory"
  fi
  # the database password is generated once; an env file from before it existed gains it here. The development
  # password is the shared one of dev_db_password, so an env file with another password gets the shared one.
  if [ "$STACK" = dev ]; then
    local pw; pw="$(dev_db_password "$(grep -m1 '^MS_DEV_DB_PASSWORD=' "$RUN/env" | cut -d= -f2- || true)")"
    if ! grep -qx "MS_DEV_DB_PASSWORD=$pw" "$RUN/env"; then
      # a unique temp name (mode 600), so two commands in one checkout never write the same file
      local tmp; tmp="$(mktemp "$RUN/.env.XXXXXX")"
      { grep -v -e '^MS_DEV_DB_PASSWORD=' -e '^MS_DATABASE_URL=' -e '^MS_TEST_DATABASE_URL=' "$RUN/env" || true
        echo "MS_DEV_DB_PASSWORD=$pw"
        echo "MS_DATABASE_URL=postgres://ms_dev:$pw@127.0.0.1:5544/ms_dev"
        echo "MS_TEST_DATABASE_URL=postgres://ms_dev:$pw@127.0.0.1:5544/ms_dev_test"; } >"$tmp"
      mv -f "$tmp" "$RUN/env"
    fi
  elif ! grep -q '^MS_DB_PASSWORD=' "$RUN/env"; then
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
    [ -n "$MS_LLM_MODEL" ] || log WARN "no model in $s; the llm agent fails until MS_LLM_MODEL is set"
    log INFO "LLM runtime: enabled (endpoint and key read from $s)"
  else
    log INFO "LLM runtime: disabled (set MS_SETTINGS or MS_LLM_BASE_URL / MS_LLM_API_KEY / MS_LLM_MODEL). The mock agent still works; strategy coaching is off."
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

# docker compose needs MS_DB_PASSWORD only to read the compose file; the development env file has no such line.
# Never run `dc up` with it: compose would create or recreate the container with the development password.
dc() { MS_DB_PASSWORD="${MS_DB_PASSWORD:-${MS_DEV_DB_PASSWORD:-}}" docker compose "$@"; }

# dev_db: role ms_dev and its databases ms_dev and ms_dev_test in the shared Postgres server. A running Postgres is
# used as it is. A stopped container is started as it is (`dc start` keeps its config and sets no password). With no
# container, the live checkout must create it with `scripts/dev.sh db`. The development path never runs db_up, never
# reads or creates a live env file and never sets the role ms password.
dev_db() {
  need docker; need openssl
  load_env
  if ! dc ps --status running postgres 2>/dev/null | grep -q postgres; then
    [ -n "$(dc ps -a -q postgres 2>/dev/null)" ] || die "no Postgres container; run scripts/dev.sh db from the live checkout first"
    dc start postgres >/dev/null
  fi
  for _ in $(seq 1 30); do
    dc exec -T postgres pg_isready -U ms -d ms >/dev/null 2>&1 && break
    sleep 1
  done
  # One psql session holds an advisory lock while it creates the role and the databases, so `dev.sh up` runs from
  # several checkouts at once take turns instead of failing on a duplicate role or database. The lock ends with the
  # session. CREATE DATABASE cannot run in a DO block, so \gexec runs it only for a missing database. The password is
  # the shared one, so setting it again changes nothing for the other checkouts. The SQL goes through stdin, off the
  # process list.
  { echo "SELECT pg_advisory_lock(hashtext('ms_dev'));"
    echo "DO \$\$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='ms_dev') THEN CREATE ROLE ms_dev LOGIN; END IF; END\$\$;"
    printf "ALTER ROLE ms_dev PASSWORD '%s';\n" "$MS_DEV_DB_PASSWORD"
    for d in ms_dev ms_dev_test; do
      echo "SELECT 'CREATE DATABASE $d OWNER ms_dev' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='$d')\\gexec"
    done
  } | dc exec -T postgres psql -q -v ON_ERROR_STOP=1 -U ms -d ms >/dev/null
}

# run <api|worker|web>: one service in the foreground, for a supervisor such as launchd.
# The engine URL is not probed here: the engine may start after this service, and the control plane retries.
run() {
  load_env; llm_env
  case "${1:-}" in
    api) cd "$ROOT"
      MS_ALLOWED_ORIGINS="$(api_origins)" \
        MS_ENGINE_URL="${MS_ENGINE_URL:-http://127.0.0.1:8787}" exec "$RUN/bin/api" ;;
    worker) cd "$ROOT"; exec "$RUN/bin/worker" ;;
    web) cd "$ROOT/web"
      # same rule as `up`: the console inherits no model key, database password or service token
      exec env -u MS_LLM_API_KEY -u MS_LLM_BASE_URL -u MS_LLM_MODEL \
        -u MS_DB_PASSWORD -u MS_DEV_DB_PASSWORD -u MS_DATABASE_URL -u MS_TEST_DATABASE_URL -u MS_WORKER_TOKEN -u MS_INGEST_TOKEN \
        pnpm exec next start -p "${MS_CONSOLE_PORT:-3737}" -H 127.0.0.1 ;;
    *) die "usage: $0 run api|worker|web" ;;
  esac
}

up() {
  need docker; need go; need pnpm; need jq; need openssl
  load_env
  dev_db

  go build -o "$RUN/bin/" ./cmd/api ./cmd/worker
  local engine; engine="$(engine_url)"

  llm_env

  if ! alive api; then
    MS_ENGINE_URL="$engine" start api "$ROOT" "$RUN/bin/api"
  fi
  wait_http "$MS_API_URL/api/v1/health" "control plane" 20

  if ! alive worker; then
    start worker "$ROOT" "$RUN/bin/worker"
  fi

  if ! alive web; then
    [ -d web/node_modules ] || (cd web && pnpm install --silent)
    # the console never calls a model or the database and holds no service token, so it inherits no LLM key, database password, worker token or ingest token
    start web "$ROOT/web" env -u MS_LLM_API_KEY -u MS_LLM_BASE_URL -u MS_LLM_MODEL \
      -u MS_DB_PASSWORD -u MS_DEV_DB_PASSWORD -u MS_DATABASE_URL -u MS_TEST_DATABASE_URL -u MS_WORKER_TOKEN -u MS_INGEST_TOKEN pnpm dev
  fi
  wait_http http://127.0.0.1:3000/api/v1/health "console" 90

  echo
  echo "Console:        http://127.0.0.1:3000"
  echo "Control plane:  $MS_API_URL/api/v1/health"
  echo "Database:       ${MS_DATABASE_URL##*/}"
  echo "Engine (read):  ${engine:-not connected; demo runs work, live-engine runs do not}"
  echo "Ingest token for the engine hook: $RUN/env"
}

down() {
  load_env
  for p in web worker api; do stop_one "$p"; done
  if [ "${1:-}" = "--db" ]; then dc stop postgres >/dev/null; fi
  echo "stopped"
}

status() {
  load_env
  for p in api worker web; do
    if alive "$p"; then echo "$p: running (pid $(cat "$RUN/$p.pid"))"; else echo "$p: stopped"; fi
  done
  if dc ps --status running postgres 2>/dev/null | grep -q postgres; then echo "postgres: running"; else echo "postgres: stopped"; fi
}

# sourcing the file (the launcher test does) loads the helpers without running a command
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
case "${1:-up}" in
  up|down|status|logs) use_stack dev ;;
esac
case "${1:-up}" in
  up) up ;;
  down) down "${2:-}" ;;
  status) status ;;
  db) db_up ;;
  run) run "${2:-}" ;;
  logs) tail -n 40 -f "$RUN"/api.log "$RUN"/worker.log "$RUN"/web.log ;;
  *) die "usage: $0 up|down|status|logs|db|run" ;;
esac
fi
