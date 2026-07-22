# market-signals

A local, self-hosted trading-signals pipeline for macOS: supertrend flip alerts
with an LLM sanity filter, a live chart dashboard with a trading-copilot chat,
and agent skills for market analysis — all plain Node (stdlib only, no npm
dependencies; the one chart library is vendored).

```
┌─ LaunchAgent (per candle close) ─────────────┐   ┌─ LaunchAgent (KeepAlive) ─────────────┐
│ scripts/supertrend.mjs                       │   │ scripts/signal-server.mjs             │
│  fetch M5 candles → supertrend(10,3) flips   │   │  http://127.0.0.1:8787                │
│  → LLM verdict (pi/Anthropic/OpenAI)         │   │  Chart.js candlesticks + supertrend   │
│  → macOS notification (deep link to chart)   │   │  quote strip · signals · settings     │
│  → sqlite: candles + signals + outcomes      │   │  chat sidebar (threads, streaming,    │
└──────────────┬───────────────────────────────┘   │  tool calling into the repo skills)   │
               └────────── data/candles.db ────────┴───────────────────────────────────────┘
```

## The alert watcher — `scripts/supertrend.mjs`

Runs once per candle close (candle-aligned LaunchAgent). For every configured
watcher combo (`watchers` CSV in settings, e.g. `WTICO/USD|M5, XAU/USD|M15`):

- fetches live Oanda M5/M15/H1 candles (FXEmpire proxy), computes
  Supertrend(10,3), detects flips, and runs an inline flip-following backtest
  so every alert carries its recent track record;
- persists candles and every fresh flip into `data/candles.db` (`node:sqlite`);
  past signals get realized 30-minute outcomes computed from stored candles;
- filters each fresh flip through the configured LLM provider (context: recent
  candles, backtest, past signal outcomes, volume vs 20-bar average, trader
  notes) — fail-open: a filter error alerts anyway;
- notifies via `terminal-notifier` (clicking opens the chart deep link for
  exactly that signal; osascript fallback), with at-most-once delivery per
  flip: exact dedup by timestamp plus a 3-bar lock-in cooldown against
  window-shift re-detections.

```bash
node scripts/supertrend.mjs --instrument WTICO/USD --granularity M5 --notify true
node scripts/supertrend.mjs --help
```

## The dashboard — `scripts/signal-server.mjs`

Always-on localhost web app (`http://127.0.0.1:8787`, binds 127.0.0.1 only):

- **Chart**: Chart.js candlesticks (vendored under `vendor/`, no CDN) with the
  supertrend overlay, flip markers, volume underlay, hover OHLC tooltips, and
  x/y scales. Data is minute-fresh and includes the forming candle; deep links
  (`/?instrument=…&granularity=…&t=<flip-time>`) render the signal context
  through to the present.
- **Quote strip**: last price, 1h/24h change, day range, supertrend distance,
  `live · candle forming` freshness.
- **Signals**: verdict panel + clickable history with realized outcomes.
  Browsing any instrument/granularity lazily backfills its historical flips
  (verdict `backfill`) without ever swallowing live watcher alerts.
- **Watch toggle**: the 🔔 button watches/unwatches the current combo (writes
  the `watchers` CSV the alert watcher loops over).
- **Settings modal** (⚙): watcher fields, provider, models, API keys (masked,
  atomic writes), and the resolved active provider.
- **Chat sidebar**: a trading copilot on the configured provider with
  persistent threads (`chat_threads`/`chat_messages` in the same db),
  SSE streaming, markdown rendering, and per-message context (current view,
  quote, candles, signal history, notes). The copilot can expand its context
  via tools: FXEmpire news articles, Trump Truth Social posts, and live rates
  (Anthropic gets the tools plus server-side web search, OpenAI the tools, via
  native tool-use loops; pi answers from the provided context — no provider
  gets shell access, and the clamped tool registry is the entire surface).

```bash
node scripts/signal-server.mjs [--port 8787] [--db data/candles.db] [--settings data/settings.json]
```

## Provider configuration — `data/settings.json`

Edited from the settings modal, or by hand. Provider resolution: explicit
`"provider": "pi"` forces the pi coding agent CLI, `"none"` disables LLM
features, and **empty/absent = auto**: `ANTHROPIC_API_KEY` wins over
`OPENAI_API_KEY`. Optional keys: `model`, `notesFile`, `piBin`, `notifierBin`,
`port`, `instrument`, `instruments` (dropdown CSV), `granularity`, `freshBars`,
`watchers`.

Everything under `data/` (db, settings with keys, notes, logs) is gitignored.

## Setup

1. `brew install terminal-notifier` (optional — clickable notifications).
2. Install the two LaunchAgents: [docs/launch-agents.md](docs/launch-agents.md)
   (candle-aligned watcher schedule + KeepAlive server).
3. Open `http://127.0.0.1:8787`, hit ⚙ to configure the provider, and 🔔 the
   combos you want alerts for.
4. Optional: keep trading notes in `data/notes.md` — the filter and the chat
   read them.

`npm test` runs the full suite (fixture db, fake provider binaries, served-page
syntax guard — no live network).

## Agent skills

Self-contained `SKILL.md` + Node scripts, runnable from an agent/cron prompt or
directly with `node` — also exposed to the dashboard chat as tools:

| Skill | What it does |
|-------|--------------|
| [`fxempire-analysis`](skills/fxempire-analysis/SKILL.md) | Multi-asset rates + news/forecasts → in-depth markdown report. |
| [`fxempire-live-data`](skills/fxempire-live-data/SKILL.md) | Near-real-time candles/rates (FXEmpire/Oanda) — JSON for automation. |
| [`briefing-publisher`](skills/briefing-publisher/SKILL.md) | Publish a markdown briefing to a GitHub Pages repo. |
| [`hormuz-ais-watch`](skills/hormuz-ais-watch/SKILL.md) | Strait of Hormuz AIS vessel watcher — oil/geopolitics signal. |
| [`truthsocial-trump-watch`](skills/truthsocial-trump-watch/SKILL.md) | Poll `@realDonaldTrump`, detect new posts, emit alert blocks. |

## Backtesting

- **Supertrend**: every watcher run reports the flip-following backtest for its
  window; the accumulating `candles`/`signals` tables support longer studies.
- **Event studies**: a 2-week Truth Social → market-impact harness
  (`scripts/fetch-trump-posts.mjs`, `classify-post.mjs`, `event-study.mjs`,
  `backtest.mjs`) with per-instrument routing (F1), single-feed windows (F2),
  and validated candle symbols (F3, `config/candle-symbols.json` — also the
  dashboard's instrument catalog).

```bash
node scripts/fetch-trump-posts.mjs --since 2026-06-27T00:00:00Z --until 2026-07-11T00:00:00Z --out posts.json
node scripts/backtest.mjs --posts posts.json --since 2026-06-27T00:00:00Z --until 2026-07-11T00:00:00Z --format markdown
```

## Packaging

The skills ship as a Claude Code plugin and Pi extension (`plugin.yaml`,
`.claude-plugin/`); `npm run verify` checks packaging integrity.
