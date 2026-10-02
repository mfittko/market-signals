# Epic status and adapted plan

This note compares the epic (https://github.com/mfittko/market-signals/issues/229) with what the prototype in `platform/` delivers.
The plan below reorders the epic's work where the prototype taught us something; every original idea stays in it.
The epic carries a status update dated 2026-09-30 that applies this note. The section "Epic changes" lists what was applied there.

## 1. What exists

The figures below are measured on the branch.

| Area | State |
|---|---|
| Control plane | Go, standard library router, pgx, three SQL migrations. About 8,200 lines of source, 143 tests, run with the race detector in CI. |
| Queue | Leases, fencing tokens, heartbeats, bounded retry, expiry, cancel, timed follow-ups, event catch-up over server-sent events. |
| Worker | Separate process. Two runtimes: an OpenAI-compatible model loop with a bounded tool loop, and a deterministic mock. Allowlisted read tools scoped to the agent's instrument. |
| Decisions | Typed proposals, deterministic checks, fail-safe hold on any malformed, late or failed result. |
| Position monitor | Advisory positions only. Stops, targets, trailing, time stop and kill switch run with no model. Tripwires wake the agent, which may hold, close or tighten. |
| Importer | Copies SQLite history into Postgres. Refuses to commit unless cash reconciles with realized profit. Re-runs insert nothing. |
| Console | Next.js, nine routes: desk, instrument with live chart and chat, portfolio, positions, strategies with wizard, guided grill and backtest grill, runs, alerts, settings. |
| Ops | Postgres in Docker, launchd jobs for the console stack, one idempotent install script, backup script. |
| Engine | An opt-in snapshot hook, routes for indicators, news and decision context, a `claude-code` provider, and an alert link setting. The indicators route fetches upstream candles and saves them to SQLite. The `claude-code` provider serves chat, and also the alert filter, rechecks and the bot when selected. Only the snapshot hook is off unless configured. |
| CI | Go tests and the console type check run on the PR. |

The engine keeps sole ownership of the paper portfolio. Nothing in `platform/` writes to it.

## 2. Against the epic phases

| Phase | Delivered | Still open |
|---|---|---|
| P0 review and spikes | Runtime spike with denied tools, cancellation, stale-worker and duplicate-claim fault tests. Decision record that reconciles the portability and agent-surface epics (merged, status still Proposed). Node golden fixtures for indicators, fills, sizing, halts and attribution (`test/golden`, see `test/golden/README.md`). | Golden fixtures for the position monitor and the indicator summary. Pi runtime. Multi-bot portfolio transaction. Recovery from a checkpoint. |
| P1 foundations | Go layout, migrations, health, structured logs, CI, Compose for Postgres. | User authentication. Generated queries. The Tailwind, component library and query-cache stack. Non-loopback exposure. |
| P2 boundary and import | Frozen snapshots, idempotent intake, dry-run importer with a cash check. | Transactional outbox. Provider budgets, circuit state and correlation state in the import. Content checksums. |
| P3 runtime slice | Everything except checkpoints. Every imported bot runs in advisory mode. | Checkpoint and resume. |
| P4 dashboard | Most screens. | Gate editing, memories screen, approvals, committed browser tests. |
| P5 Go domain and shadow | Not started. | All of it. |
| P6 cutover and deployment | Not started. Backup script and launchd install exist. | All of it. |

## 3. What building it taught us

1. A vertical slice with the console first found more real defects than any review. Most of the bugs fixed late were visible only in the running app. Keep slices thin and keep the console in every slice.
2. The epic stops at "the agent proposes". A proposal that opens a position needs a lifecycle: exits, trailing, wakes, budgets. The epic omits the monitor, which carries most of the safety story. It belongs in the plan.
3. A strategy is the agent's real configuration. Authoring, versioning, review by a coach and backtest evidence turned out to be a product surface.
4. Agents are only as good as the context in the snapshot. Indicator levels, freshness and news were a larger lever than the runtime choice.
5. The engine can stay authoritative for a long time. The prototype runs beside it with one opt-in hook. This makes the Go port of the domain a separate, later decision. Agents can ship before it.
6. Several review rounds found the same classes of defect: lookahead on unfinished bars, stale writers, unbounded outputs, browser-reachable settings. Each now has a regression test. These are the standing checks for any new slice.

## 4. Deviations from the epic, and whether to keep them

| Epic said | Prototype did | Recommendation |
|---|---|---|
| WebSocket live updates | Server-sent events with durable ids | Keep. One direction is enough for now. Revisit if the console needs to send control messages. |
| Chi router, sqlc | Standard library router, plain SQL through pgx | Keep. Two direct dependencies. Add generated queries only if query count grows. |
| Tailwind, shadcn, TanStack Query | Plain CSS, small hooks | Keep until a second developer or a design system needs them. |
| Pi runtime first | Native model loop first | Keep the order. Pi stays a candidate behind the same adapter. |
| Agents commit through the domain engine | Advisory only | Correct for now. See the authority ladder below. |

## 5. Adapted sequence

This sequence reaches the original phases in a new order, so value arrives earlier and risk stays bounded.

A. Review the prototype. Advisory only. The prototype does not merge as the final architecture. Follow-up issues carry the remaining work. The merge decision stays with the owner.

B. Make it the daily driver. No new trading authority.
- Separate development and live databases, and a second console port.
- Authentication before any non-loopback access.
- Transactional outbox for snapshot delivery, replacing the best-effort hook.
- Move the decision record from Proposed to Accepted, with its open questions listed and owned.
- Golden fixtures for the position monitor and the indicator summary. The indicator, fill, sizing and halt fixtures are in `test/golden`.
- Committed browser tests. Go coverage to 90% for packages that will outlive the prototype.
- Import gaps: provider budgets, circuit state, correlation state, content checksums.

C. Authority ladder. Agents earn execution one step at a time.
1. Advisory. Done.
2. Shadow comparison against the engine's own bots, with thresholds fixed before results are read.
3. Paper execution through a narrow engine API: the engine validates, sizes and books. The agent never touches the ledger.
4. Opt-in per bot, with fast disable that leaves deterministic exits running.

D. Port the domain to Go in bounded slices, each with differential tests against the fixtures from B: acquisition, signals, portfolio and fills, then strategy resolution and news. This is the original P5.

E. Cutover, backup and restore rehearsal, Kubernetes packaging. This is the original P6 and the portability epic.

The research worker profile (https://github.com/mfittko/market-signals/issues/231), the evaluation protocol (https://github.com/mfittko/market-signals/issues/230) and the read-only surfaces (https://github.com/mfittko/market-signals/issues/36) stay as designed. They plug into the queue and tool gateway that exist now.

## 6. Epic changes

All five changes below are applied in the epic's status update of 2026-09-30. The original phase list stays in the epic text, and the status update states the adapted order above it.

1. Done: the fully delivered items in P0 to P4 are ticked, and the status update links this note.
2. Done: the position monitor, strategy authoring and grill, and alerts are listed as delivered work.
3. Done: the status update gives the order B to E as the adapted sequence for P5 and P6.
4. Done: the deviations in section 4 are recorded in the status update.
5. Done: child issues exist for the delivered slice, for each item in B, and for each step of the authority ladder in C. Later issues are created when the ladder reaches them.
