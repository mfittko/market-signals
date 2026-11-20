#!/usr/bin/env bash
# Seeds the isolated console-e2e stack with one instrument, one demo run and one shadow position.
# It uses the same API calls as platform/scripts/smoke.sh and the deterministic mock agent, so it
# needs no model, no provider key and no network. Point it only at a disposable test database.
set -euo pipefail
API="${MS_E2E_API:-http://127.0.0.1:18080}/api/v1"
: "${MS_INGEST_TOKEN:?set MS_INGEST_TOKEN}" "${MS_DATABASE_URL:?set MS_DATABASE_URL}"
fail() { echo "FAIL: $*" >&2; exit 1; }

wait_status() { # run_id status seconds
  local s=""
  for _ in $(seq 1 "$3"); do
    s="$(curl -fsS "$API/runs/$1" | jq -r .run.status)"
    [ "$s" = "$2" ] && return 0
    sleep 1
  done
  fail "run $1 did not reach $2 (is $s)"
}

# instruments come only from the legacy importer, so the private test instrument is inserted directly
psql "$MS_DATABASE_URL" -qc "INSERT INTO instruments (symbol,name,market) VALUES ('SMOKE/TEST','Smoke test','test') ON CONFLICT DO NOTHING"

curl -fsS -XPOST "$API/agents" -d '{"id":"smoke-mock","name":"Smoke test (deterministic mock)","instrument":"SMOKE/TEST","granularity":"M5","runtime":"mock",
  "allowedTools":["get_snapshot","get_portfolio","get_recent_candles","get_recent_signals","schedule_followup"],"enabled":true}' >/dev/null

R="$(curl -fsS -XPOST "$API/runs" -d '{"agentId":"smoke-mock","source":"demo"}' | jq -r '.runs[0].runId')"
wait_status "$R" succeeded 30
echo "seeded demo run $R"

KEY="e2e-flip-1"
# the snapshot carries its own candles, so the run chart renders without asking the engine
C='{"time":"2026-11-20T11:4%s:00Z","open":93.4,"high":93.7,"low":92.9,"close":93.1,"volume":100}'
CANDLES="$(printf "$C,$C,$C,$C,$C" 0 1 2 3 4)"
PAYLOAD='{"asOf":"2026-11-20T11:44:00Z","candles":['"$CANDLES"'],"close":93.02,"quote":{"last":93.02},"trend":"down","supertrend":93.6,"flip":{"signal":"sell","price":93.02},"portfolio":{"equity":10000,"cash":10000,"halted":false,"positions":[]}}'
E="$(curl -fsS -XPOST "$API/events" -H "Authorization: Bearer $MS_INGEST_TOKEN" \
  -d "{\"idempotencyKey\":\"$KEY\",\"instrument\":\"SMOKE/TEST\",\"granularity\":\"M5\",\"event\":\"flip\",\"payload\":$PAYLOAD}" \
  | jq -r '.runs[] | select(.agentId=="smoke-mock") | .runId')"
wait_status "$E" succeeded 30
curl -fsS -XPOST "$API/events/$KEY/legacy" -H "Authorization: Bearer $MS_INGEST_TOKEN" \
  -d '{"decision":{"action":"open","side":"short"}}' >/dev/null
curl -fsS "$API/positions?limit=50" | jq -e '[.positions[]? | select(.instrument=="SMOKE/TEST")] | length > 0' >/dev/null \
  || fail "the flip event opened no shadow position"
echo "seeded engine flip run $E and its shadow position"
