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
