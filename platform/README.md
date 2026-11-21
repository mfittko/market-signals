# Agent control plane (spike)

Prototype of the agent-native runtime from the stack-migration epic. It runs beside the existing Node
engine in shadow mode. Agents propose decisions, and the engine decides and executes them as it does today.
The control plane has no write path to the portfolio.

```
Node engine ──snapshot──▶ Go control plane ──claim (lease + fence)──▶ Go worker ──▶ runtime (mock | llm)
     │  ▲                      │  ▲  Postgres                              │
     │  └──engine decision─────┘  └── run events, tool audit ◀── tool gateway (allowlist, budget, scope)
     └── deterministic exits, fills, kill switch (unchanged)         │
                                                                     ▼
                                     Next.js console ◀── SSE ── durable event log
```

## Run it

Needs docker, go, pnpm, jq, openssl. Do not pipe the launcher into another command.

```sh
cd platform
scripts/dev.sh db        # once: creates the shared Postgres container on 127.0.0.1:5544
scripts/dev.sh up        # development stack (needs the Postgres container dev.sh db creates): control plane :8081, worker, console :3000
scripts/smoke.sh         # end-to-end check, about 10 seconds
open http://127.0.0.1:3000
scripts/dev.sh down
```

### Two stacks

The development stack and the live stack run side by side. The only thing the two stacks share is the Postgres
server on `127.0.0.1:5544`. `dev.sh down --db` stops that shared server, so it also stops the database of the live
stack.

| | Development | Live |
|---|---|---|
| Commands | `dev.sh up`, `down`, `status`, `logs` | `dev.sh run api\|worker\|web` (the launchd jobs from `switch-launchd.sh`), `dev.sh db` |
| Run directory (binaries, pid files, logs) | `platform/.dev/dev/` | `platform/.dev/` |
| Env file (mode 600, gitignored) | `platform/.dev/dev/env` | `platform/.dev/env` |
| Database and role | `ms_dev`, role `ms_dev`; Go tests use `ms_dev_test` | `ms`, role `ms`; Go tests use `ms_test` |
| Control plane | `127.0.0.1:8081` | `127.0.0.1:8080` |
| Console | `127.0.0.1:3000` (`pnpm dev`) | `127.0.0.1:$MS_CONSOLE_PORT` (3737 by default) |

Each env file holds its own worker token, ingest token and database password. `dev.sh up` creates the role
`ms_dev` and its two databases in the running Postgres server and never changes the role `ms`. `backup.sh` dumps
the live database `ms` only. `MS_RUN_DIR` overrides the run directory of both stacks, for tests.

Upgrade step: a development stack started before the two stacks existed runs from `platform/.dev/`, and the new
`dev.sh down` cannot see it. Stop it before the first `dev.sh up` or `switch-launchd.sh up`: run the old
`scripts/dev.sh down` before you pull this change. After the pull, run
`bash -c 'source scripts/dev.sh; for p in web worker api; do stop_one "$p"; done'` from `platform/`.
`MS_RUN_DIR=.dev scripts/dev.sh down` does not work: `dev.sh` refuses an env file that holds the other stack's
database password, so neither stack can append its lines to the other stack's env file.

One control plane runs per database. At start the control plane takes a Postgres session advisory lock on a
dedicated connection named `ms-api <listen address>`. A second control plane on the same database exits with
code 1 before it binds a port, and its message names the database and the holder (backend pid,
`application_name`, start time). Postgres releases the lock when the holder's session ends, also after `kill -9`.
The lock is per database, so the two stacks do not block each other.

In the console:

1. Start a run. The "New research run" picker lists only LLM agents that have a strategy, so it stays empty
   on a stack without an LLM key. `scripts/smoke.sh` registers the private mock agent `smoke-mock` (instrument `SMOKE/TEST`, so no real agent is touched) and runs it. After
   that, start more mock runs through the API:
   `curl -XPOST http://127.0.0.1:3000/api/v1/runs -d '{"agentId":"smoke-mock","source":"demo"}'`. The `"source":"demo"` field uses
   the bundled fixture instead of the engine. `smoke-mock` has no engine candles, so the same request without `"source":"demo"` returns 502. To freeze what the engine sees, register a mock agent on a real engine instrument first. A run without `"source":"demo"` freezes what the engine sees now,
   so the engine must be reachable. The launcher connects to `127.0.0.1:8787` when it is up, or to `MS_ENGINE_URL`.
2. The control plane reads the engine with GET calls. The one exception is the agent `get_prediction` tool, which
   always calls `POST /api/predict` with `reuse: true`. The engine makes a paid provider call only when no valid
   stored prediction exists. The GET calls have side effects: when the
   engine's stored candles are stale, a chart GET makes the engine fetch live candles from its upstream provider
   and upsert them into its SQLite. The position monitor polls M1 charts every 15 seconds for each instrument
   with an open shadow position, and tool calls, snapshots and the live route read charts too. The console proxy also forwards a fixed allowlist of engine
   writes: `POST /settings`, `POST /chat`, `DELETE /threads` and `POST /predict` (one paid TypeSafe call that
   stores an advisory prediction), plus the read `GET /predictions`. A settings write may carry only
   the keys the console Settings page edits (model, watchers, alerts, signal filter, news, and the prediction
   keys `TYPESAFE_API_KEY` and `predictionEnabled`). The proxy refuses
   every other key with 403, including the paper bot switches and allocation (`bot`), executable paths (keys
   ending in `Bin`) and file paths such as `notesFile`. `POST /chat` reaches the engine copilot and its
   write tools. The copilot can save a standing note with `save_memory`, and the signal filter and the paper
   bot's deliberation read that note as advisory text. It can also save strategy and gate-prompt drafts,
   which stay inactive until the operator activates them in the engine. Chat cannot place, close or change a
   trade, and it cannot change the paper bot settings.
3. Open a run to see the audit trail: tool calls, model rounds, the proposal, the deterministic checks and the frozen snapshot.
4. Cancel a run from its page. A queued run stops at once. A running one stops at its next heartbeat.

The LLM agent uses the endpoint, model and key from the engine's `data/settings.json`. The launcher
passes them to the control plane, which uses them for strategy coaching, and to the worker. The console
dev server starts without them. Without a key only the mock agent runs, and it runs through `scripts/smoke.sh`
or the API.

To open the console from another host name, list it in `MS_ALLOWED_ORIGINS` as comma-separated entries. The
default is `localhost:3000,127.0.0.1:3000`. Each entry is `host:port` (`console.lan:3000`) or an origin
(`http://console.lan:3000`). The control plane drops the scheme and any path, so both forms name the same host.
`dev.sh run api`, which the launchd jobs use, defaults `MS_ALLOWED_ORIGINS` to `localhost` and `127.0.0.1` on `MS_CONSOLE_PORT` (3737 by default) only, so a dev server on port 3000 is not trusted, when the variable is unset.

The mock agent schedules a 15 second follow-up when the price comes from a forming candle. Start a mock run through the API without `"source":"demo"` to see
the run wait, release the worker and resume as a second attempt.

## Feed it real engine events

Start the engine with the hook enabled. Use a copy of `data/` so nothing touches the live database. The copy
listens on port 4123, so start the stack with `MS_ENGINE_URL=http://127.0.0.1:4123 scripts/dev.sh up` to make
live-engine runs read the same copy.

```sh
MS_NO_NOTIFY=1 MS_CONTROL_PLANE_URL=http://127.0.0.1:8081 MS_INGEST_TOKEN=$(grep INGEST platform/.dev/dev/env | cut -d= -f2) \
  node scripts/signal-server.mjs --port 4123 --db <copy>/candles.db --settings <copy>/settings.json
```

Each bot deliberation sends one immutable snapshot before the decision and the engine's own decision after it.
The console then shows whether the agent agreed. Delivery failures are swallowed, so an absent control plane never
changes or delays a bot decision.

## Guarantees and where they are tested

| Guarantee | Test |
|---|---|
| Same event key enqueues nothing new; snapshot and runs commit together | `queue_test.go` ingest idempotency |
| Snapshots cannot be updated or deleted | `queue_test.go` immutability |
| Concurrent workers never claim the same run | `queue_test.go` concurrent claims |
| A worker that lost its lease cannot complete, heartbeat or overwrite | `queue_test.go`, `runtime_test.go` reassigned worker |
| Duplicate completion is a no-op | `queue_test.go` duplicate completion |
| An agent's `leaseSeconds` budget sets the lease at claim and heartbeat; without it the lease is 30 s | `queue_test.go` agent lease, `runtime_test.go` short lease |
| A taken port fails before any reaper or monitor pass; shutdown ends open streams and stops both loops before the pool closes | `cmd/api/main_test.go` |
| Cancel discards a racing completion and leaves no proposal | `queue_test.go`, `runtime_test.go` cancel |
| Tool allowlist and budget are enforced at execution, every denial audited | `queue_test.go`, `api_test.go` |
| Instrument scope comes from the snapshot and ignores model arguments | `api_test.go` |
| Forming candles never reach an agent | `api_test.go` |
| Failure, malformed output, exhausted attempts and expiry all end in a recorded hold | `queue_test.go`, `runtime_test.go` |
| An invalid proposal (wrong-side stop, halted, stale, foreign position) is rejected and stays uncommitted | `domain/decision_test.go`, `queue_test.go` |
| Timed follow-up releases the worker and resumes with a fresh attempt | `queue_test.go` |
| The engine keeps deciding when the control plane is down | `test/control-plane.test.mjs` |

Run everything:

```sh
(cd platform && set -a && . .dev/dev/env && go test -p 1 -race -count=1 ./...)   # database ms_dev_test, from scripts/dev.sh up
node --test test/control-plane.test.mjs                                          # from the repo root
```

No database password is committed. `scripts/dev.sh up` generates one into `platform/.dev/dev/env` (mode 600,
gitignored) and sets the role `ms_dev` to it. The live `platform/.dev/env` holds `MS_DB_PASSWORD` for the role `ms`,
which `dev.sh db` sets and Docker Compose reads. Each file holds `MS_DATABASE_URL`, which `cmd/api` and `cmd/import`
require, and `MS_TEST_DATABASE_URL` for the Go tests. Tests skip without it, or fail when `MS_REQUIRE_DB=1` or `CI`
is set. To run `docker compose` by hand, export the live file first with `set -a && . .dev/env`.

## Deliberate simplifications

| Epic text | Prototype |
|---|---|
| Chi, pgx, sqlc | stdlib `net/http`, pgx, hand-written SQL |
| WebSocket | Server-Sent Events over the durable event log, resumable with `Last-Event-ID` |
| Tailwind, shadcn, TanStack Query | plain CSS and `fetch` |
| Awaiting approval state | present in the schema, unused because nothing executes |
| Pi runtime | not built; see the spike findings |
| Checkpoint and resume | reported as unsupported; an interrupted attempt is recorded and a bounded replacement starts fresh |
| Auth | loopback only, bearer tokens for worker and engine endpoints, origin guard on browser writes |
| Go port of the portfolio engine | not built |

## Import the legacy history

`go run ./cmd/import` copies the SQLite history (candles, signals, trades, bot journal, account, strategies, chat,
standing rules, prompt versions and rechecks) and the bot map into
Postgres in one transaction. Without `-commit` it is a dry run that rolls back. It commits only when every
invariant holds, including that cash reconciles with realized profit. Open positions in the source fail that
check, so close them first. It reads the database from `MS_DATABASE_URL` or `-db`, so export `.dev/dev/env` first
to fill the development database `ms_dev` from a disposable copy of the engine SQLite file.
`go run ./cmd/import -h` lists the flags.
