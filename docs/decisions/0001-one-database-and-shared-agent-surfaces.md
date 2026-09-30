# 0001. One database, no Redis, and shared agent surfaces

## Status

Proposed

## Context

Two earlier epics predate the platform prototype.

- https://github.com/mfittko/market-signals/issues/123 makes the system portable. It chose Node with Postgres and Redis, and a dual backend where SQLite stays for local development and tests.
- https://github.com/mfittko/market-signals/issues/36 makes the system consumable by other agents through an MCP server, a unified CLI and a documented HTTP API. All three are read-only.

The prototype in https://github.com/mfittko/market-signals/pull/232 adds a Go and Postgres control plane under `platform/`. It has a queue with leases and fencing tokens, a tool gateway, server-sent events with durable event ids, and a one-way importer from SQLite. The engine (Node, SQLite) still owns the live paper portfolio. The umbrella epic is https://github.com/mfittko/market-signals/issues/229. This record is phase B of the adapted plan in [epic-status-and-plan.md](https://github.com/mfittko/market-signals/blob/spike/epic-229/platform/docs/epic-status-and-plan.md) on the prototype branch. The migration order comes from [postgres-migration.md](https://github.com/mfittko/market-signals/blob/spike/epic-229/platform/docs/postgres-migration.md) on the same branch.

Both earlier epics assumed the engine itself would move. The prototype shows the engine can stay authoritative while the platform runs beside it. The decisions below revise the two epics accordingly.

## Decision

1. The end state is one database, PostgreSQL. SQLite remains only as an import source and a legacy concern. This retires the dual-backend decision in the portability epic. Until the cutover (step 4 of the migration note: SQLite becomes import-only) the ownership table below applies per domain, and no dual-backend abstraction is built in the engine.
2. Redis is not planned. This revises the portability epic, which listed Redis for caches, throttles, locks and sessions. Revisit Redis only on a measured need. The triggers are:
   - more than one API instance, or
   - a latency target that Postgres notifications cannot meet.
3. Task ownership, portfolio state and paid-provider budgets never live in Redis, whatever the outcome of a revisit. A cache eviction must never re-grant paid API spend or lose an owner.
4. Live updates use server-sent events with durable event ids, so a client resumes from its last id. The implementation is the event stream handler in [server.go](https://github.com/mfittko/market-signals/blob/spike/epic-229/platform/internal/api/server.go). WebSockets are revisited only if the console must send control messages.
5. The read-only agent surfaces (MCP server, unified CLI, HTTP API) reuse the platform's tool gateway for validation, scoping, budgets and audit. The read-only constraint of the agent surfaces epic is unchanged: no trade execution and no portfolio mutation through any surface. The gateway authorizes per run attempt, so a surface without a run needs a caller identity (open question 1).
6. During migration each domain has exactly one authoritative writer at any time. A second store may hold a copy for comparison. It never accepts writes that the authoritative store does not also see.

### Ownership during migration

| Domain | Authoritative writer now | Flip condition |
|---|---|---|
| Strategies | Engine (SQLite) until migration step 1 (strategies) completes, then the platform (Postgres), with the engine reading the active version from Postgres. | Console edits reach the engine, and the engine has run on the Postgres version for several days without incident. |
| Candles and signals | Engine, which also writes a copy to Postgres. | Daily row counts per instrument and timeframe match for several days. Then the platform becomes the reader of record and the writer moves in the cutover step. |
| Portfolio and bots | Engine (SQLite ledger). The platform never writes to it. | The Go port runs in shadow beside the ledger and every trade and the equity curve match. |
| Paper execution (later) | Engine, through a narrow validating API. The agent never touches the ledger. | None. The engine stays the writer. The authority ladder is in the epic status note. |
| Chat threads | Engine (SQLite). | None scheduled. Set once open question 2 is answered. |
| Alert state | Engine (SQLite). | Moves with portfolio and bots. |
| Provider budgets and circuit state | Engine (SQLite). | The importer gap (budgets, circuit state, correlation state) is closed, then the writer moves with the engine domain that spends the budget. |

Each step needs a backup, a dry-run import and a working rollback, as listed in the [migration note](https://github.com/mfittko/market-signals/blob/spike/epic-229/platform/docs/postgres-migration.md).

## Consequences

- The portability epic loses its Redis and dual-backend work. Its Kubernetes packaging, authentication and secrets work stays, and follows the cutover.
- The agent surfaces epic keeps its scope and its read-only rule. Its MCP, CLI and HTTP API children are built on the gateway, not on separate script wrappers.
- The gateway authorizes per run attempt and fencing token. A surface with no run needs a caller identity. This is open question 1.
- SQLite stays in the engine until the cutover step. Local tests for the engine keep running against it.
- Running more than one API instance is a trigger to reopen decision 2, not a reason to add Redis by default.

### Open questions

1. Caller identity for read-only surfaces that have no run attempt: a service principal, a scoped read token, or a synthetic read-only attempt. Owner: mfittko.
2. Where chat threads live at the end state, and whether the console chat and the engine chat merge. Owner: mfittko.
3. Which runtime hosts the MCP server and the unified CLI (Go beside the gateway, or Node calling the HTTP API). Owner: mfittko.
4. The date each domain flips, and the date SQLite becomes import-only. Owner: mfittko.
