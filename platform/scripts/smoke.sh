#!/usr/bin/env bash
# End-to-end check of a running stack (scripts/dev.sh up). Uses only the mock agent, so it needs no model or network.
# Safe against a live stack (set MS_CONSOLE_PORT when the console is not on port 3000): every agent, event and run it creates uses the private agent smoke-mock on the private
# instrument SMOKE/TEST, which no real agent shares, so no real agent receives its events or opens a position.
# On exit the smoke agent is switched off and its private shadow position is deleted.
set -euo pipefail
cd "$(dirname "$0")/.."
. .dev/env
API=http://127.0.0.1:8080/api/v1
WEB=http://127.0.0.1:${MS_CONSOLE_PORT:-3000}/api/v1
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok   $*"; }

wait_status() { # run_id status seconds
  local s=""
  for _ in $(seq 1 "$3"); do
    s="$(curl -fsS "$API/runs/$1" | jq -r .run.status)"
    [ "$s" = "$2" ] && return 0
    sleep 1
  done
  fail "run $1 did not reach $2 (is $s)"
}

curl -fsS "$WEB/health" | jq -e '.ok and (.stats.workers | map(select(.online)) | length > 0)' >/dev/null \
  || fail "no online worker via the console proxy"
ok "console proxy reaches the control plane and a worker is online"

smoke_agent() { # enabled: true or false
  curl -fsS -XPOST "$API/agents" -d '{"id":"smoke-mock","name":"Smoke test (deterministic mock)","instrument":"SMOKE/TEST","granularity":"M5","runtime":"mock",
    "allowedTools":["get_snapshot","get_portfolio","get_recent_candles","get_recent_signals","schedule_followup"],"enabled":'"$1"'}' >/dev/null
}
# The engine-event step makes the mock agent open a shadow position on SMOKE/TEST. There is no close route, so the exit
# cleanup removes that private position (its events go with it), and nothing of the smoke run is left in the book.
smoke_cleanup() {
  smoke_agent false >/dev/null 2>&1 || true
  printf "DELETE FROM shadow_positions WHERE agent_id='smoke-mock' AND instrument='SMOKE/TEST';\n" \
    | MS_DB_PASSWORD="$MS_DB_PASSWORD" docker compose exec -T postgres psql -q -U ms -d ms >/dev/null 2>&1 || true
}
trap smoke_cleanup EXIT
smoke_agent true || fail "could not create the mock agent"
ok "registered the private mock agent smoke-mock"

R="$(curl -fsS -XPOST "$WEB/runs" -d '{"agentId":"smoke-mock","source":"demo"}' | jq -r '.runs[0].runId')"
wait_status "$R" succeeded 20
curl -fsS "$API/runs/$R" | jq -e '.run.validation.valid and (.run.validation.committed|not) and .run.proposal.action=="open"' >/dev/null \
  || fail "demo proposal invalid"
ok "demo event, snapshot, mock agent, validated shadow proposal (run $R)"

KEY="smoke-$(date +%s)"
PAYLOAD='{"close":93.02,"quote":{"last":93.02},"trend":"down","supertrend":93.6,"flip":{"signal":"sell","price":93.02},"portfolio":{"equity":10000,"cash":10000,"halted":false,"positions":[]}}'
E="$(curl -fsS -XPOST "$API/events" -H "Authorization: Bearer $MS_INGEST_TOKEN" \
  -d "{\"idempotencyKey\":\"$KEY\",\"instrument\":\"SMOKE/TEST\",\"granularity\":\"M5\",\"event\":\"flip\",\"payload\":$PAYLOAD}" \
  | jq -r '.runs[] | select(.agentId=="smoke-mock") | .runId')"
wait_status "$E" succeeded 20
curl -fsS -XPOST "$API/events/$KEY/legacy" -H "Authorization: Bearer $MS_INGEST_TOKEN" \
  -d '{"decision":{"action":"open","side":"short"}}' >/dev/null
curl -fsS "$API/runs/$E" | jq -e '.run.comparison=="agree"' >/dev/null || fail "engine comparison is not agree"
ok "engine event ingested; agent and engine agree (run $E)"

curl -fsS -XPOST "$API/events" -H "Authorization: Bearer $MS_INGEST_TOKEN" \
  -d "{\"idempotencyKey\":\"$KEY\",\"instrument\":\"SMOKE/TEST\",\"granularity\":\"M5\",\"event\":\"flip\",\"payload\":{\"close\":1}}" \
  | jq -e '.newSnapshot|not' >/dev/null || fail "replay created a new snapshot"
ok "replaying the same event key is idempotent"

[ "$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$API/runtime/claim" -d '{}')" = 401 ] || fail "worker endpoint accepts anonymous calls"
ok "worker protocol rejects anonymous callers"

STREAM="$(curl -m 3 -sN "$WEB/stream?after=0" || true)"
grep -q '^event: run' <<<"$STREAM" || fail "no events through the console proxy stream"
ok "live event stream works through the console proxy"
echo "smoke passed"
