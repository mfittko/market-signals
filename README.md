# market-signals

Agent skills for market analysis and market-moving signal watching.

Each skill is a self-contained `SKILL.md` plus its Node scripts, runnable from
an agent/cron prompt or directly with `node`.

## Skills

| Skill | What it does |
|-------|--------------|
| [`fxempire-analysis`](skills/fxempire-analysis/SKILL.md) | Reproducible market analysis pipeline: multi-asset rates + news/forecasts → in-depth markdown report. |
| [`fxempire-live-data`](skills/fxempire-live-data/SKILL.md) | Near-real-time candles/rates (FXEmpire/Oanda) across indices, commodities, FX, crypto — JSON for automation. |
| [`briefing-publisher`](skills/briefing-publisher/SKILL.md) | Publish a generated markdown briefing to a GitHub Pages repo with timestamped paths + a stable `latest.md`. |
| [`hormuz-ais-watch`](skills/hormuz-ais-watch/SKILL.md) | Strait of Hormuz AIS vessel watcher (aisstream.io) — cron-friendly, deduped alerts. Oil/geopolitics signal. |
| [`truthsocial-trump-watch`](skills/truthsocial-trump-watch/SKILL.md) | Poll `@realDonaldTrump` on Truth Social, detect new posts, emit alert blocks for cron delivery. |

## Usage

Each skill's `SKILL.md` documents its own trigger prompts and flags. Scripts are
plain `node`, no build step. Most read credentials from env (`GH_TOKEN`, an
aisstream.io key, etc.) — see the individual skill for what it needs.

```bash
node skills/fxempire-live-data/scripts/fxempire_live_data.mjs \
  --mode candles --provider oanda --instrument NAS100/USD \
  --granularity M1 --count 500 --alignmentTimezone Europe/Berlin
```

## Backtest: Truth Social posts → market impact

A 2-week event-study harness (issue #7) that measures how high-signal Trump
Truth Social posts move markets. Post sourcing uses the free CNN-hosted archive.
Pipeline scripts under `scripts/` (stdlib only):

| Script | Role |
|--------|------|
| `fetch-trump-posts.mjs` | Pull + normalize the CNN archive for a window (dedupe by id, strip HTML). |
| `classify-post.mjs` | Rule-based high-signal classifier + **per-instrument routing** (F1). |
| `event-study.mjs` | **Single-feed** (F2) pre/post impact of one event, market-hours aware (next-open roll). |
| `backtest.mjs` | Ingest → classify → event-study each post on its mapped instruments → markdown/CSV report. |

Three load-bearing methodology rules are enforced:

- **F1 — per-instrument routing.** Geopolitical/oil posts route to Brent/WTI,
  Fed to indices+gold, tariff to indices. Aggregates are per-instrument; a broad
  index proxy hides the strongest signal (Trump Iran posts → oil while equities dip).
- **F2 — single-feed windows.** Pre and post candles come from ONE provider
  (fxempire `--from T−pre`, split at the first candle ≥ T). Mixing feeds
  (oanda-pre + fxempire-post) produced a sign-flipped artifact.
- **F3 — validated candle symbols.** `config/candle-symbols.json` holds the
  candle symbols that actually return data (NAS100/USD, BCO/USD, XAU/USD, …),
  distinct from the rates slugs in `config/instruments.yaml`.

```bash
# Fetch the last 2 weeks, then run the backtest (live; smoke-only in CI).
node scripts/fetch-trump-posts.mjs --since 2026-06-27T00:00:00Z --until 2026-07-11T00:00:00Z --out posts.json
node scripts/backtest.mjs --posts posts.json --since 2026-06-27T00:00:00Z --until 2026-07-11T00:00:00Z --format markdown
```

### First-party source: truthbrush ingestion (issue #8)

The CNN archive is a third-party mirror. `scripts/ingest-truthbrush.mjs` is a
first-party pull: it shells out to the [`truthbrush`](https://github.com/stanfordio/truthbrush)
Python CLI and **upserts by post `id`** into a durable JSON store, so history no
longer depends on the mirror.

```bash
# Backfill a window, then keep an incremental tail (cron-friendly). Live pull is
# credential-gated (env only, never committed); fails loud if truthbrush/creds absent.
export TRUTHSOCIAL_USERNAME=... TRUTHSOCIAL_PASSWORD=...   # or TRUTHSOCIAL_TOKEN, or --no-auth
node scripts/ingest-truthbrush.mjs --since 2026-06-27T00:00:00Z --until 2026-07-11T00:00:00Z
node scripts/ingest-truthbrush.mjs --tail                 # pull newest-stored → now
node scripts/ingest-truthbrush.mjs --tail --interval 900  # scheduled worker (every 15m)

# The store IS a normalized post array — feed it to the backtest unchanged:
node scripts/backtest.mjs --posts data/truth-posts.json --since 2026-06-27T00:00:00Z --until 2026-07-11T00:00:00Z
```

Both sources emit the **same normalized schema** (`{id, createdAtISO, text, url,
engagement}`), and the backtest already consumes a normalized array via
`--posts`. That existing seam is the source abstraction: CNN
(`fetch-trump-posts --out`) or truthbrush (`ingest-truthbrush --store`) — the
backtest runs unchanged against either. Persistence is idempotent (id-keyed
upsert: re-ingesting a window is a no-op, late edits update in place), which is
the load-bearing, unit-tested behavior. Deployment/health-endpoint infra is out
of scope — a cron/systemd-timer running `--tail` is the scheduled worker.

Unit tests (`npm test`) cover the classifier, the F2 pre/post split + next-open
roll, and ingestion normalization with fixtures — no live calls. Live paths run
only in the smoke workflow.

## Install as a plugin / extension

The same `skills/` directory is the single source of truth for both packagings —
no skill bodies or scripts are duplicated. A smoke check keeps the manifests in
sync with `skills/`:

```bash
npm run verify
```

### Claude Code plugin

Manifests live in `.claude-plugin/` (`plugin.json` + `marketplace.json`), with
this repo root as the plugin source. Add the marketplace and install:

```bash
/plugin marketplace add mfittko/market-signals
/plugin install market-signals@market-signals
```

The five skills then surface as `/`-invocable skills. (Local checkout:
`/plugin marketplace add /path/to/market-signals`.)

### Pi extension

`plugin.yaml` at the repo root is the harness-agnostic manifest; its
`provides_skills:` list points at the `skills/` directory. Install by referencing
this repo/checkout from your Pi extensions config, then invoke a skill with
`/skill:<name>` (e.g. `/skill:fxempire-analysis`).
