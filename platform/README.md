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
scripts/dev.sh db        # once, main checkout only: creates the shared Postgres container on 127.0.0.1:5544
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

Each env file holds its own worker token and ingest token. The live env file holds the password of the role `ms`,
and every development env file holds the shared `ms_dev` password described below. `dev.sh up` creates the role
`ms_dev` and its two databases in the running Postgres server and never changes the role `ms`. `backup.sh` dumps
the live database `ms` only. `MS_RUN_DIR` overrides the run directory of both stacks, for tests.

The live-stack commands `dev.sh db` and `dev.sh run` run only in the main checkout, which `switch-launchd.sh` finds
the same way: the checkout that holds the git directory. Every checkout shares the one Postgres container and its
role `ms`. `dev.sh db` from a worktree would recreate that container and set a new `ms` password that the live jobs
do not hold, so the live API would go down. In a worktree they refuse before they write a file or call Docker, and
the message names the main checkout. A separate clone counts as its own main checkout. The development commands work
in every checkout.

Several checkouts (the main checkout and its worktrees, or other clones) share the one development database. Each
checkout has its own run directory and env file, but all of them use the role `ms_dev`, the databases `ms_dev` and
`ms_dev_test`, and one password. The password lives once per user in
`$XDG_CONFIG_HOME/market-signals/dev-db-password` (`~/.config` when `XDG_CONFIG_HOME` is unset or relative, mode
600), outside every checkout. So a `dev.sh up` in a second checkout leaves the first checkout's stack able to
connect. The first development command after this change (`dev.sh up`, `status` or `down`, in any checkout) keeps
the password its env file already holds, and later checkouts adopt it. An env file with another password gets the
shared one at its next development command; restart that checkout's running stack with `dev.sh down` and
`dev.sh up`. The checkouts also share the ports 8081 and 3000 and the one-control-plane rule below, so one
development stack runs at a time. A second concurrent `dev.sh up` waits on a Postgres advisory lock only while it
creates the role and the databases, and otherwise fails with a clear message. In the same checkout it refuses at once
with `another scripts/dev.sh up runs in this checkout` and names the lock directory `.dev/dev/up.lock`; a killed run
can leave that directory behind, so remove it and run again. From another checkout, `dev.sh up` refuses before it
builds anything, or fails once its own api or console exits, when the other checkout's stack answers on port 8081 or
3000, and the message names the port: stop that stack with `scripts/dev.sh down` there.

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
| A taken port fails before any reaper or monitor pass; shutdown ends open streams, lets in-flight requests finish and stops both loops before the pool closes | `cmd/api/main_test.go`, `api_test.go` stop streams |
| Cancel discards a racing completion and leaves no proposal | `queue_test.go`, `runtime_test.go` cancel |
| Tool allowlist and budget are enforced at execution, every denial audited | `queue_test.go`, `api_test.go` |
| Instrument scope comes from the snapshot and ignores model arguments | `api_test.go` |
| Forming candles never reach an agent | `api_test.go` |
| Failure, malformed output, exhausted attempts and expiry all end in a recorded hold | `queue_test.go`, `runtime_test.go` |
| An invalid proposal (wrong-side stop, halted, stale, foreign position) is rejected and stays uncommitted | `domain/decision_test.go`, `queue_test.go` |
| Timed follow-up releases the worker and resumes with a fresh attempt | `queue_test.go` |
| The engine keeps deciding when the control plane is down | `test/control-plane.test.mjs` |
| A settings write with an unknown key, a wrong type or a path is refused and stores nothing; secrets read masked | `settings/store_test.go`, `api/settings_test.go` |
| The settings import is idempotent and a changed file adds one revision with only the changed keys | `settings/store_test.go` |
| An enabled bot without its watcher pair is refused in the write transaction; job owner flags change only through the operator route | `settings/store_test.go`, `api/settings_test.go` |

Run everything:

```sh
(cd platform && set -a && . .dev/dev/env && go test -p 1 -race -count=1 ./...)   # database ms_dev_test, from scripts/dev.sh up
node --test test/control-plane.test.mjs                                          # from the repo root
```

No database password is committed. The first development command creates the shared development password once
(see above), and `scripts/dev.sh up` writes it into `platform/.dev/dev/env` (mode 600, gitignored) and sets the role `ms_dev` to it. The live `platform/.dev/env` holds `MS_DB_PASSWORD` for the role `ms`,
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

## Settings store

Go keeps a typed copy of the engine settings in Postgres (`internal/settings`). The engine's `data/settings.json`
stays the live source until the Go store owns settings writes
(https://github.com/mfittko/market-signals/issues/365). The mirror is one way:

- `go run ./cmd/settings-import --settings ../data/settings.json` copies the file into the store. It reads
  `MS_DATABASE_URL` or `-db`. An unchanged file adds no revision. A changed file adds one revision that names only
  the changed keys. Unknown or invalid keys keep their stored value. The report lists each refused key with the
  reason it was refused, never a value.
- `GET /api/v1/settings` returns the store and its `revision`, with every secret masked. `PATCH /api/v1/settings`
  refuses unknown keys, wrong types, any file or executable path, and an enabled bot whose pair is not in the
  watcher list. Secret values are opaque tokens and are not scanned for paths. A refused write stores nothing. The next import overwrites what this route wrote.
- Job owner flags (`candles`, `alerts`, `bot`, `news`, each `node` or `go`, default `node`) exist only in Postgres.
  `GET` and `PUT /api/v1/operator/job-owners` read and set them with `Authorization: Bearer $MS_OPERATOR_TOKEN`.
  Without `MS_OPERATOR_TOKEN` the operator routes answer 401.

## Paper ledger

`internal/ledger` is the Go paper ledger in Postgres (`ledger_*` tables, migration `008_ledger.sql`). Open, close,
partial close, fill, mark, halt and halt reset each run in one transaction and take an idempotency key: a repeated key
books nothing, and a failed operation writes nothing. Fills use the shared fill function (`internal/fill`). A second
close of a position is refused by the UNIQUE key on `ledger_trades.position_id`. The Node ledger stays live until a
later slice of https://github.com/mfittko/market-signals/issues/343 switches the bots.
