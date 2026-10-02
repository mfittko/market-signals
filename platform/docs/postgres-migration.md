# Moving the engine fully to Postgres

Today two databases are in use.

- **SQLite (`data/candles.db`)** is the live engine's source of truth. It holds candles, signals, the paper portfolio, bots, chat and strategies.
- **Postgres** holds the console's data: runs, agents, advisory positions and audit trails. It also holds a one-way copy of the SQLite history, made by the importer.

The copy is safe to repeat. The importer refuses to commit unless the books balance.

## Recommended order

Each step can be reverted on its own. Do not start a step before the previous one has run cleanly for several days.

1. **Strategies.** The console already edits them. Make Postgres the owner and let the engine read the active version from it. This closes the gap where console edits never reach the engine.
2. **Candles and signals.** The engine writes to both databases. The console reads only Postgres. Compare row counts per instrument and timeframe every day.
3. **Portfolio and bots.** Port the fills, stops and cash logic. Run it beside the SQLite ledger in shadow mode and compare every trade and the equity curve.
4. **Cutover.** SQLite becomes import-only. The backup script keeps a dated snapshot of it.

## Why not in one step

The paper ledger, the bots and the alert state all live in SQLite and are written by a single Node process. A rushed cutover puts the live paper account and the alerts at risk. The shadow comparison in step 3 is what proves the port is correct.

## Before each step

- Run `platform/scripts/backup.sh` and keep the output in `tmp/`.
- Run the importer as a dry run and read its invariants.
- Check that `platform/scripts/switch-launchd.sh rollback` still restores the previous server.
