#!/usr/bin/env bash
# One-command local stack: Postgres (docker), Go control plane, Go worker, Next.js console.
#   scripts/dev.sh up      start everything (idempotent)
#   scripts/dev.sh down    stop app processes (add --db to stop Postgres too)
#   scripts/dev.sh status  show what is running
#   scripts/dev.sh logs    tail all logs
# Environment: MS_ENGINE_URL (default: the engine on 127.0.0.1:8787 when reachable). The control plane reads it with
#              GETs; the console proxy also forwards POST /settings, /chat, /memories and DELETE /threads.
#              MS_SETTINGS (engine settings.json; supplies the LLM endpoint, model and key to the worker only).
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

up() {
  need docker; need go; need pnpm; need jq; need openssl
  load_env
  docker compose up -d postgres >/dev/null
  for _ in $(seq 1 30); do
    docker compose exec -T postgres pg_isready -U ms -d ms >/dev/null 2>&1 && break
    sleep 1
  done
  docker compose exec -T postgres psql -U ms -d ms -tc "SELECT 1 FROM pg_database WHERE datname='ms_test'" | grep -q 1 \
    || docker compose exec -T postgres psql -U ms -d ms -c "CREATE DATABASE ms_test" >/dev/null

  go build -o "$RUN/bin/" ./cmd/api ./cmd/worker
  local engine; engine="$(engine_url)"

  # the model settings feed the worker (agent runs) and the control plane (strategy coaching)
  local s; s="$(settings_file)"
  if [ -n "$s" ] && [ -n "$(jq -r '.OPENAI_API_KEY // empty' "$s")" ]; then
    export MS_LLM_BASE_URL MS_LLM_API_KEY MS_LLM_MODEL
    MS_LLM_BASE_URL="$(jq -r '.OPENAI_BASE_URL // "https://api.openai.com/v1"' "$s")"
    MS_LLM_API_KEY="$(jq -r '.OPENAI_API_KEY' "$s")"
    # these speak the OpenAI-compatible API, so take that model even when the chat provider is something else (claude-code, pi)
    MS_LLM_MODEL="$(jq -r '(.models // {}) as $m | ($m["openai-compatible"] // $m["openai"] // $m[.provider // ""] // .model // empty)' "$s")"
    [ -n "$MS_LLM_MODEL" ] || echo "note: no model in $s; the llm agent fails until MS_LLM_MODEL is set"
    echo "LLM runtime: enabled (endpoint and key read from $s)"
  else
    echo "LLM runtime: disabled (set MS_SETTINGS or MS_LLM_BASE_URL / MS_LLM_API_KEY / MS_LLM_MODEL). The mock agent still works; strategy coaching is off."
  fi

  if ! alive api; then
    MS_ENGINE_URL="$engine" start api "$ROOT" "$RUN/bin/api"
  fi
  wait_http http://127.0.0.1:8080/api/v1/health "control plane" 20

  if ! alive worker; then
    start worker "$ROOT" "$RUN/bin/worker"
  fi

  if ! alive web; then
    [ -d web/node_modules ] || (cd web && pnpm install --silent)
    start web "$ROOT/web" pnpm dev
  fi
  wait_http http://127.0.0.1:3000/api/v1/health "console" 90

  echo
  echo "Console:        http://127.0.0.1:3000"
  echo "Control plane:  http://127.0.0.1:8080/api/v1/health"
  echo "Engine (read):  ${engine:-not connected; demo runs work, live-engine runs do not}"
  echo "Ingest token for the engine hook: $RUN/env"
}

down() {
  for p in web worker api; do stop_one "$p"; done
  if [ "${1:-}" = "--db" ]; then docker compose stop postgres >/dev/null; fi
  echo "stopped"
}

status() {
  for p in api worker web; do
    if alive "$p"; then echo "$p: running (pid $(cat "$RUN/$p.pid"))"; else echo "$p: stopped"; fi
  done
  if docker compose ps --status running postgres 2>/dev/null | grep -q postgres; then echo "postgres: running"; else echo "postgres: stopped"; fi
}

case "${1:-up}" in
  up) up ;;
  down) down "${2:-}" ;;
  status) status ;;
  logs) tail -n 40 -f "$RUN"/api.log "$RUN"/worker.log "$RUN"/web.log ;;
  *) die "usage: $0 up|down|status|logs" ;;
esac
