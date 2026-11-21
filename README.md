# Market Signals

Market Signals is a signal desk for one trader. It alerts you when a market move starts. Agents read the context and advise you. Plain rules guard the exits of every open position. Every trade uses paper money.

Project site: https://market-signals.io (vision, architecture and a usage guide).

Version 0.1.0. Stage: advisory prototype. Agents propose and the trader decides. Version numbers stay below 1.0 until the system is stable. The next release is v0.2.0 (see [Roadmap](#roadmap)).

## Architecture

The system has four layers. Each kind of state has exactly one component that may change it.

| Layer | Stack | Owns |
|---|---|---|
| Engine | Node, SQLite (`scripts/`) | Candles, signals and alerts, the paper ledger and the paper bots, provider spend budgets. |
| Control plane and worker | Go, Postgres (`platform/`) | Agent runs with leases and fencing, agents, advisory positions, strategies, news triage, the run audit trail. |
| Position monitor | Go, rules only (`platform/`) | Stops, targets, trailing stops, time stops and the kill switch for advisory positions, on completed bars. |
| Console | Next.js (`platform/web/`) | The desk, instrument charts, runs, positions, strategies, alerts and settings, updated live over server-sent events. |

The control plane reads the engine and has no write path to the paper portfolio. The engine keeps deciding when the control plane is down.

Read more:

- [docs/decisions/0001-one-database-and-shared-agent-surfaces.md](docs/decisions/0001-one-database-and-shared-agent-surfaces.md): one database, no Redis, shared agent surfaces, and the ownership table during migration.
- [platform/README.md](platform/README.md): the control plane, its guarantees and where they are tested.
- [docs/engine.md](docs/engine.md): the engine reference.
- The architecture page on the site: https://market-signals.io/architecture.html

## Quickstart

You need Node 22.18 or later and a language model key. The launchd install and the desktop notifications need macOS. The console stack also needs docker, go, pnpm, jq and openssl.

### 1. Run the engine

```sh
git clone https://github.com/mfittko/market-signals
cd market-signals
node scripts/signal-server.mjs        # dashboard on http://127.0.0.1:8787
```

Open http://127.0.0.1:8787. Press ⚙ to configure the LLM provider, and press 🔔 on the combos you want alerts for. Settings live in `data/settings.json`, which is gitignored. See [docs/engine.md](docs/engine.md) for the full engine reference.

### 2. Run the console dev stack

```sh
cd platform
scripts/dev.sh db        # once: creates the shared Postgres container on 127.0.0.1:5544
scripts/dev.sh up        # development stack (needs the Postgres container dev.sh db creates; database ms_dev), control plane :8081, worker, console :3000
scripts/smoke.sh         # end-to-end check with the mock agent, about 10 seconds
# open http://127.0.0.1:3000 in a browser
scripts/dev.sh down      # --db also stops the shared Postgres server, which the live stack uses too
```

`scripts/dev.sh status` shows what runs, and `scripts/dev.sh logs` tails the logs. Do not pipe the launcher into another command. The stack connects to the engine at `MS_ENGINE_URL`. Without it, the stack uses `127.0.0.1:8787` when that answers. `dev.sh up` writes its own tokens and a copy of the shared database password into `platform/.dev/dev/env` (mode 600, gitignored). All checkouts share the development database `ms_dev` and one password, kept once in `~/.config/market-signals/dev-db-password`, so a second checkout's `dev.sh up` leaves the first one connected. One development stack runs at a time: a second concurrent `dev.sh up` waits only while it creates the role and databases, and otherwise fails with a clear message that names this checkout's `.dev/dev/up.lock` or the port 8081 or 3000 another checkout's stack holds. The launchd jobs run the live stack from `platform/.dev/env` on database `ms`, API 8080 and console 3737, so both stacks run at once. The LLM agent takes its endpoint, model and key from the engine's `data/settings.json`. Without a key only the mock agent runs. Details are in [platform/README.md](platform/README.md).

### 3. Install under launchd

The engine runs as the LaunchAgent `com.market-signals.signal-server`. Install it first, as described in [docs/launch-agents.md](docs/launch-agents.md).

Then run `platform/scripts/switch-launchd.sh` from the main checkout. It points that LaunchAgent at the checkout and keeps `data/` in place. `up` refuses in any other checkout, such as a git worktree, because it sets the live database password. It also installs the console stack as three KeepAlive jobs (`com.market-signals.platform-api`, `-worker` and `-web`) and sets `consoleUrl` in `data/settings.json`, so alert links open the console.

```sh
platform/scripts/switch-launchd.sh status                          # read-only
MS_ALLOW_LIVE_SWITCH=1 platform/scripts/switch-launchd.sh up       # asks first; -y skips the question
platform/scripts/switch-launchd.sh rollback [--with-watcher]       # restore the original engine plist
```

`up` refuses to run without `MS_ALLOW_LIVE_SWITCH=1`, because it moves the live engine. It backs up the original plists to `~/Library/LaunchAgents/.ms-backup`, retires the old five-minute watcher job and stops the `dev.sh` processes, which use the same ports. The launchd console listens on port 3737 (`MS_CONSOLE_PORT` overrides it). Every step is idempotent, so run `up` again after a pull to rebuild and reload. `rollback` removes the console jobs, the daily jobs and `consoleUrl`. It restores the old watcher only with `--with-watcher`.

`up` keeps the previous build in `platform/.dev/bin.prev` and `platform/web/.next.prev`. `GET /api/v1/health` reports the running commit in `build.commit`, `build.dirty` and `build.builtAt`, and the Runs page shows it next to the console build. When the Go build or the console build fails, the console does not answer on its port within 60 seconds, the console serves another commit than `git rev-parse HEAD`, or the deploy stops after it saved the previous build and before that commit check (a job that fails to reload, Ctrl-C), `up` restores the previous build, reloads the jobs and exits non-zero. `up` also installs `com.market-signals.platform-rotate-logs`, which runs `platform/scripts/rotate-logs.sh` every day at 04:00. It gzips each `platform/.dev/*.launchd.log` over 10 MB, truncates the live file and keeps 7 copies per log.

`platform/scripts/backup.sh` dumps the Postgres database and copies the engine's SQLite files, settings and notes. Its header lists the restore and prune commands.

Daily backups need a target off the main disk. Set `backupDir` in `data/settings.json` once, to an absolute path outside the checkout on a second disk or in a synced folder. `up` installs the `com.market-signals.platform-backup` job, which runs `backup.sh scheduled` every day at 03:30 and logs to `platform/.dev/backup.launchd.log`. `rollback` removes it. The scheduled run fails with a logged reason, and creates no directory, when `data/settings.json` is missing or not valid JSON, or when `backupDir` is unset, not absolute, contains a single quote, is inside the checkout, missing or not writable. `up` also passes `backupDir` to the control plane as `MS_BACKUP_DIR`, and `GET /api/v1/health` reports it in `backup.configured`, with the newest marked backup in `backup.newestAt` and `backup.ageSeconds`. The scheduled job reads `backupDir` on every run, but the control plane reads it only when `up` runs, so run `up` again after you set or change `backupDir`.

```sh
platform/scripts/backup.sh restore <backup-dir>          # Postgres: replaces the console database (asks first)
platform/scripts/backup.sh restore-sqlite <backup-dir>   # engine: candles.db, signals.db and settings.json (asks first)
```

`restore-sqlite` first checks the integrity of the backup files. It then stops the engine job, keeps the current files in `data/.pre-restore-<timestamp>/`, copies the backup files into `data/`, checks their integrity and starts the engine job again, also after a failed copy or a stop that times out. It refuses, with nothing changed, while another process holds `candles.db` or `signals.db`, for example an engine started with `node scripts/signal-server.mjs`.

## Testing

Engine unit tests. They use a fixture database and fake provider binaries, assert the served page, and make no network calls. They include the golden-fixture replay and the engine side of the control-plane hook.

```sh
npm test
npm run verify            # packaging check + unit tests (+ console typecheck and Go tests when installed)
```

Node and npm are the toolchain. The `packageManager: bun` pin in package.json exists only so the dev-loops gate validation runner can pick a runtime for these same scripts.

The golden fixtures in [test/golden/](test/golden/README.md) record what the engine computes for fixed synthetic inputs: indicators, fills, sizing, halts and attribution. A port or refactor replays them. `node scripts/golden-fixtures.mjs` verifies the committed fixtures, and `--write` regenerates them.

Browser walkthrough (dashboard and all five modals across four viewport orientations). This is dev-only. CI runs it as an opt-in matrix job when the served page changes.

```sh
npm i && npx playwright install webkit
npm run test:e2e
```

Go suite. The tests need Postgres and run one package at a time because they share the database. With the dev stack up:

```sh
(cd platform && set -a && . .dev/dev/env && go test -p 1 -race -count=1 ./...)
```

`platform/.dev/dev/env` provides `MS_TEST_DATABASE_URL` (database `ms_dev_test`). Without it the database tests skip. They fail instead when `MS_REQUIRE_DB=1` or `CI` is set. CI sets `MS_TEST_DATABASE_URL` to a throwaway Postgres service and `MS_REQUIRE_DB=1`.

Console type check:

```sh
(cd platform/web && pnpm install --frozen-lockfile && pnpm typecheck)
```

Site build. It renders `site/content/*.md` into `_site/` (gitignored).

```sh
npm i --no-save --no-package-lock marked@18.0.14
node scripts/build-site.mjs
```

## Engine reference

The engine reference lives in [docs/engine.md](docs/engine.md). It covers:

- the decision cycle and the two signal kinds (supertrend flips and volume impulses),
- the dashboard on port 8787,
- per-combo bots, versioned strategies and the virtual CFD portfolio,
- trader memory,
- the four gates and their prompts,
- market-sentinel news and the NewsAPI.ai and GNews providers,
- provider configuration in `data/settings.json`, the verdict budget, the fallback provider and Pushover,
- opt-in live prediction (`TYPESAFE_API_KEY`, `predictionEnabled`, `/api/predict` and `/api/predictions`),
- the `data/` layout,
- the agent skills, backtesting and packaging.

## Roadmap

The milestones and their issues are public at https://github.com/mfittko/market-signals/milestones.

| Version | Goal |
|---|---|
| [v0.2.0](https://github.com/mfittko/market-signals/milestone/1) | Ship the advisory foundation |
| [v0.3.0](https://github.com/mfittko/market-signals/milestone/2) | Daily driver on loopback |
| [v0.4.0](https://github.com/mfittko/market-signals/milestone/3) | Alert quality |
| [v0.5.0](https://github.com/mfittko/market-signals/milestone/4) | Evidence and research baseline |
| [v0.6.0](https://github.com/mfittko/market-signals/milestone/5) | Paper execution, opt-in |

The agent platform arrived in https://github.com/mfittko/market-signals/pull/232. The umbrella epic is https://github.com/mfittko/market-signals/issues/229.
