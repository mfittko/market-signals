# Spike

## Question

Can the full implementation of the Multica-inspired stack migration epic (https://github.com/mfittko/market-signals/issues/229) land in a single PR as the first delivery step?

## Approach

Measured the current codebase and the epic's own text, then built a prototype of the agent boundary to test the answer. The PR holds that prototype: the Go control plane, worker, importer and Next.js console in `platform/`, the engine hook and its bridge in `scripts/`, their tests, a CI job for the Go and console code, and this report.

- Counted tracked files and lines of code per area.
- Listed SQLite tables and server routes that a Go and Postgres port must cover.
- Read the epic's phase list, invariants, and stated first slice.
- Compared the total scope with what a time-boxed spike can cover.

## Findings

Current code that the epic would replace or wrap:

| Area | Size |
|---|---|
| `scripts/*.mjs` (server, bot, portfolio, signals, news, evaluation) | about 9,200 lines |
| `vendor/app.html` (embedded dashboard) | about 2,800 lines |
| `test/*.mjs` | about 13,200 lines, 35 test files |
| `skills/` (independent CLIs, kept via adapters) | about 5,300 lines |

- The two largest files are `supertrend.mjs` (1,971 lines) and `signal-server.mjs` (1,818 lines, 26 route branches).
- SQLite holds about 20 tables: signals, candles, portfolio, positions, bot trades and journal, strategies, memories, gate prompts, chat, news, provider state, correlation windows, rechecks, migrations.
- No Go module, Next.js app, pnpm workspace, or Compose file exists yet. The toolchain (go, pnpm, docker) is installed locally.

Scope of the epic as written:

- Phases P0 to P6 cover an ADR, a Go and Next.js skeleton, an importer, a new agent runtime with leases and fencing, a UI port, a domain port to Go, and a controlled cutover.
- The epic requires go/no-go decisions inside the sequence. P0 ends with a go/no-go on the runtime spike, and P5 requires shadow qualification before P6 cutover.
- The epic states it is a raw plan that needs architecture review, and that child issues come after that review.
- Rough size of a full port: 12,000 to 15,000 lines of new production code plus a matching test suite, before the new runtime, importer, and Compose or Kubernetes packaging. Estimate 25,000 to 40,000 changed lines.

Constraints that still hold for a one-PR spike:

1. A spike is throwaway and has no size threshold. The size budget, gate fan-out and partial-merge concerns do not apply. The spike profile makes gates advisory and skips required CI.
2. The spike produces the go/no-go at the end of the first phase as one of its results. If the restricted-runtime check fails, the spike records that finding and discards the rest.
3. Parity needs shadow runs on recorded data over time. One pass yields no such runs. The spike shows that the boundaries work. Migration safety stays open until the shadow runs exist.
4. Cutover, rollback and backup rehearsal are operational steps. The prototype scripts them. Proving them takes a rehearsal on the real setup.
5. Epics 123 and 36 conflict with parts of the plan. The spike must record which decisions it assumed.
6. The prototype runs its own Postgres, control plane and console on separate ports. It leaves the live KeepAlive server running unchanged and reaches the live engine only through a small sanctioned surface. `platform/scripts/dev.sh` sets `MS_ENGINE_URL` to the live engine on 127.0.0.1:8787 by default. Chart polls through that engine fetch upstream candles and upsert them into the live SQLite database. The console Settings page writes the live `settings.json`, limited to an allowlist of keys. `platform/scripts/switch-launchd.sh up` is the one operator tool that repoints the live server, and it refuses to run without `MS_ALLOW_LIVE_SWITCH=1`. It also stops and disables the supertrend watcher LaunchAgent. `switch-launchd.sh rollback` restores the original server and leaves that watcher off unless the operator adds `--with-watcher`.

What a one-PR spike can cover:

- The epic's recommended first slice: keep the Node engine, enqueue one immutable decision snapshot, run one restricted agent in shadow mode, show its run history.
- A Go and Postgres skeleton with a dry-run importer against a disposable copy of the SQLite data.
- A Next.js shell reading the Go API.
- A Go port of one domain module, portfolio and fills, to measure the true cost of the full port. The full domain port is the part most likely to exceed a time box.
- One engine change outside the first slice: a `claude-code` LLM provider. It adds a provider path to `llmRequest` (alert filter, rechecks, bot) and `llmChat`, sends chat tool events over the SSE stream, and adds the provider to the dashboard options. The engine uses it only when the `provider` setting or the `llmFallbackProvider` setting selects it.

Prototype results (branch `spike/epic-229`, directory `platform/`, run guide in `platform/README.md`):

| Epic phase | Outcome |
|---|---|
| Runtime spike: restricted tools, denied tool, cancellation | Works. Allowlist, budget and scope are enforced at execution in the gateway. Cancel discards a racing completion. |
| Snapshot and enqueue | Works. One transaction commits snapshot and runs. Same key is idempotent. Snapshot rows are immutable by trigger. |
| Agent, session, run, attempt lifecycle | Works. Leases, fencing tokens, bounded retry, expiry, wake from timed follow-up. Interrupted attempts start a fresh replacement. |
| Shadow run of a real bot | Works. The Node engine sends the snapshot before its decision and its own decision after. The change to `bot.mjs` adds 8 lines and edits 2: one snapshot before the decision and one report of the engine's decision after it. It fails open. |
| Run history UI | Works. Next.js 16 console with live updates, audit trail, cancel, dark mode, phone width. |
| Postgres and Go skeleton | Works with stdlib HTTP and hand-written SQL, which was enough to prove the boundary. Chi and sqlc stay optional for the delivery phase. |
| Restricted runtime on Pi | Not built. `pi --help` shows a `--tools` allowlist and `--no-builtin-tools`, so a Pi worker needs an extension that exposes the market tools. That extension is the open question. |
| SQLite importer | Built (`platform/cmd/import`). One transaction, dry run by default. It commits only when every invariant holds, including cash reconciliation, so open source positions block a commit. |
| Go port of portfolio and fills | Not built. Estimated as the largest remaining cost. |
| Parity and shadow qualification | Not provable in a spike. Needs recorded data and time. |

Test evidence: 138 Go tests (race detector clean, real Postgres), 737 Node tests including the 8 control-plane bridge tests, an end-to-end smoke script, and a browser check of both themes and phone width.

Behavior worth knowing before deciding:

- A reasoning model (DeepSeek on the configured endpoint) spent its whole completion budget on hidden reasoning at 2,048 tokens and returned no answer. The runtime now defaults to 16,384 and fails safe to a hold when a reply is empty.
- An operator run against the live engine sees the latest signal, which can be hours old. Snapshots now carry the flip age, and the mock agent holds on a stale flip. The LLM agent still sometimes acts on one.
- The control plane's GET calls to the engine have side effects. A chart GET on stale data makes the engine fetch live candles from its upstream provider and upsert them into its SQLite. The position monitor polls M1 every 15 seconds for each instrument with an open shadow position.
- The forming candle is dropped from snapshots and from the candle tool. The live quote is labelled provisional. Agents that see a provisional price can schedule a follow-up.

## Recommendation

Graduate. The agent boundary is proven end to end, and it fits the epic's first slice at a small size. Turn the prototype into a phased plan:

1. Land the boundary: Postgres schema, control plane, worker protocol, gateway, tests, and the engine hook in `bot.mjs` (8 added lines and 2 edited lines) behind an off-by-default flag.
2. Land the console.
3. Decide the Pi question with an extension spike before choosing a runtime for execution-eligible bots.
4. Only then harden the importer and start the Go domain port, each against recorded fixtures.

Keep the design. The prototype does not merge as the final architecture, and follow-up issues carry the remaining work. The merge decision stays with the owner. The queue tests are the most reusable part.
