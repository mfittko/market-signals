# market-signals

A local, self-hosted trading-signals pipeline for macOS: supertrend flip alerts
with an LLM sanity filter, per-combo paper-trading bots with versioned
strategies, a live chart dashboard with a trading-copilot chat, trader memory,
free breaking-news context, and agent skills for market analysis — all plain
Node (stdlib only, no npm dependencies; the one chart library is vendored).

```
┌─ LaunchAgent (per candle close) ─────────────┐   ┌─ LaunchAgent (KeepAlive) ─────────────┐
│ scripts/supertrend.mjs                       │   │ scripts/signal-server.mjs             │
│  fetch candles → supertrend(10,3) flips      │   │  http://127.0.0.1:8787                │
│  → LLM filter verdict → notification         │   │  chart · quote strip · signals        │
│  → per-combo bot deliberation (paper trades) │   │  settings · portfolio/bot/memories/    │
│  → refresh HTF cache (M15/M30/H1/H4)         │   │  gates modals · chat copilot (tools)   │
│  → refresh sentinel news cache               │   │                                        │
└──────────────┬───────────────────────────────┘   └──────────────┬─────────────────────────┘
               └────────────────── data/candles.db ─────────────────┘
```

## The alert watcher — `scripts/supertrend.mjs`

Runs once per candle close (candle-aligned LaunchAgent — see
[docs/launch-agents.md](docs/launch-agents.md)). For every configured watcher
combo (`watchers` CSV in settings, e.g. `WTICO/USD|M5, XAU/USD|M15`):

- fetches live Oanda candles (FXEmpire proxy), computes Supertrend(10,3),
  detects flips, and runs an inline flip-following backtest so every alert
  carries its recent track record;
- persists candles and every fresh flip into `data/candles.db` (`node:sqlite`);
  past signals get realized 30-minute outcomes computed from stored candles;
- filters each fresh flip through the configured LLM provider — the **filter
  gate** (context: recent candles, backtest, past outcomes, volume vs 20-bar
  average, trader notes, trader memory, cached sentinel headlines) — **fail-open**:
  a filter error alerts anyway;
- notifies via `terminal-notifier` (clicking opens the chart deep link for
  exactly that signal; osascript fallback), with at-most-once delivery per
  flip: exact dedup by timestamp plus a 3-bar lock-in cooldown against
  window-shift re-detections;
- runs the configured per-combo **bot** (see below) on every fresh flip or
  adverse-move event for that combo;
- refreshes the higher-timeframe candle cache (M15/M30/H1/H4) for every
  watched-or-bot-tracked instrument, staleness-gated and rate-capped so a long
  downtime doesn't cause an unbounded fetch storm on the next tick;
- polls the market-sentinel breaking-news cache (see below) for the same
  tracked instruments, staleness-gated (~8 min per instrument), so filter/bot
  prompts always read from a warm cache instead of fetching live on the signal
  path.

Set `MS_DEBUG_LLM=1` in the environment to log a one-line
provider/model/token-usage summary per LLM completion (filter and bot) to
stderr — a local dev flag, not a persisted setting.

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
- **Header**: a two-row consolidated header — a global row (💼 portfolio, ⚙
  settings, 🧠 memories, 📜 gates & prompts) and a per-instrument row (
  instrument/granularity selects, 🔔/🔕 watch toggle, 🤖 bot for this view,
  indicator toggles).
- **Quote strip**: last price, 1h/24h change, day range, supertrend distance,
  `live · candle forming` freshness.
- **Signals**: verdict panel with an inline 🔁 operator re-check (asks the
  **recheck gate**, an on-demand LLM call, whether a past signal is still
  `valid`/`played-out`/`invalidated`; every re-check is journaled to
  `signal_rechecks`, never mutates the original signal) plus clickable history
  with realized outcomes. Browsing any instrument/granularity lazily backfills
  its historical flips (verdict `backfill`) without ever swallowing live
  watcher alerts.
- **Watch toggle**: the 🔔 button watches/unwatches the current combo (writes
  the `watchers` CSV the alert watcher loops over).
- **Portfolio modal** (💼): the virtual CFD portfolio — equity/cash/margin,
  open positions, trade history, per-strategy performance, and the audit
  journal (every open/skip/close/halt/reset row) — plus the list of activated
  bots.
- **Bot modal** (🤖): per-combo bot configuration (enable, strategy binding,
  risk%/allocation% overrides) and a dedicated strategy tab for drafting or
  activating that combo's strategy.
- **Memories modal** (🧠): add, reweight, edit, and archive trader memories.
- **Gates & prompts modal** (📜): transparency into the filter, recheck, bot,
  and chat gates — the effective system prompt and declared toolset for each,
  plus drafted overrides and human-only activation for the filter and recheck
  gates.
- **Settings modal** (⚙): watcher fields, provider, models, API keys (masked,
  atomic writes), the resolved active provider, and the info-overlays toggle;
  links out to the memories and gates modals (memories/gates management lives
  in their own modals, not this one).
- **Chat sidebar**: a trading copilot on the configured provider with
  persistent threads (`chat_threads`/`chat_messages` in the same db), SSE
  streaming, markdown rendering, and per-message context (current view, quote,
  candles, signal history, notes, trader memory, gate prompts, bot
  performance). The copilot can expand its context via tools: FXEmpire news
  articles, sentinel breaking news, Trump Truth Social posts, live rates, and
  saving a strategy/memory/gate-prompt draft (Anthropic gets the tools plus
  server-side web search, OpenAI the tools, via native tool-use loops; pi
  answers from the provided context — no provider gets shell access, and the
  clamped tool registry is the entire surface). Drafts saved via chat tools
  never take effect on their own — activation is always a separate human act.

Set `MS_DEBUG_LLM=1` to also surface the completion's provider/model/usage.
The non-streamed `/api/recheck` carries all four as response headers:
`X-LLM-Provider`/`X-LLM-Model`/`X-LLM-Usage-Input`/`X-LLM-Usage-Output`. The
chat SSE stream flushes its headers before the completion finishes, so it
carries only `X-LLM-Provider`/`X-LLM-Model` as headers and delivers the token
usage as a trailing `{type:'usage'}` SSE event. With the flag off there are no
headers, no usage event, and behavior is unchanged.

```bash
node scripts/signal-server.mjs [--port 8787] [--db data/candles.db] [--settings data/settings.json]
```

## Per-combo bots, strategies, and the virtual portfolio

Each watched or explicitly-configured `instrument|granularity` combo can run
its own paper-trading bot (`settings.bot.bots["INSTRUMENT|GRAN"]`, unset
fields inherit global bot defaults). Deterministic work — candle fills,
mark-to-market, the drawdown kill-switch — runs every candle close; the LLM
only deliberates on events (a fresh flip or an adverse move past the review
trigger), and any malformed output, timeout, or provider error is a journaled
**hold** (fail-safe, the inverse of the filter's fail-open).

- **Strategies** are versioned prompt+spec records (`strategies` table).
  Edits always append a new version — nothing is ever rewritten, so the audit
  trail stays attributed to the exact text that produced a decision. A bot
  references a strategy by **name**, not a frozen row id, and always follows
  that name's currently *active* version — drafting via chat and activating in
  the bot modal takes effect on the bot's next deliberation without touching
  its stored config. A strategy can be scoped to one dedicated combo or shared
  across several; activation is per-name, so a dedicated strategy and the
  shared pool can both be active at once.
- **Position sizing sizes to budget, it never rejects a trade outright.** The
  LLM's requested notional is only an upper-bound hint; the server clamps it
  down to whatever fits the risk%/allocation% caps for that instrument (and
  journals the requested vs. effective notional and which cap bound). Only
  when the budget is fully exhausted does the bot fall back to a `hold`.
- **One global drawdown kill-switch**: when equity falls further than the
  configured percentage below its peak, the whole portfolio halts (no new
  opens) until an operator resets it — a human act, not automatic.
- The portfolio is a **virtual CFD** book: notional-based positions with
  configurable leverage (capped) and a fixed per-instrument spread paid once
  on entry; paper money only.

## Trader memory

Durable, trader-scoped standing rules (`memories` table) ride along as
advisory context in the filter, bot deliberation, and chat prompts — never a
substitute for the fail-safe clamps above. Chat can save a memory as a
conversational side effect (`save_memory` tool); the memories modal is the
manual add/edit/reweight/archive surface. Archiving hides a memory from
context but never deletes the row.

## Gates & prompts

Four LLM surfaces ("gates"), all sharing one design: an effective system
prompt is always resolvable, and only two of the four accept operator-drafted
revisions:

| Gate | What it does | Overridable? |
|------|---------------|---------------|
| **Filter** | Single-shot sanity check on every fresh flip; no tools. | Yes — draft via chat or the gates modal, human-activated. |
| **Bot** | Tool-loop deliberation (fxempire articles, sentinel news, Truth Social posts, live rates; plus Anthropic-only server-side web search) that opens/closes/holds. | No — strategy-owned, not gate-owned. |
| **Chat** | The copilot; full tool loop including the save-draft tools. | No — constant system prompt. |
| **Recheck** | Operator-initiated 🔁 re-check of a past signal's verdict. | Yes — draft via chat or the gates modal, human-activated. |

Overridable gates store versioned drafts in `gate_prompts` (append-only,
`draft` is chat- or manual-created, `active` flips on a human act). The gates
modal is the transparency + activation surface for all four.

## Market-sentinel (breaking news)

A free, keyless breaking-news source (`skills/market-sentinel/`): Google News
RSS, GDELT, Al Jazeera, OilPrice.com, and a per-instrument Yahoo Finance feed,
deduped and escalation-flagged (negative GDELT tone or a keyword hit). The
watcher polls it into the `news` table in the background on every tick
(staleness-gated, ~8 min per tracked instrument); the filter and bot prompts
read a compact `{escalation, headlines, asOf}` block from that cache — always
advisory, never a reason to bypass the chop/volume/risk checks. It's also an
on-demand chat tool (`sentinel_news`) and the source the briefing-publisher
now uses for its default `sentinel` series — the older FXEmpire
market-analysis briefing input is deprecated (it dried out; `fxempire-analysis`
still backs the live `fxempire_articles` chat tool and its own standalone
report pipeline).

## Provider configuration — `data/settings.json`

Edited from the settings modal, or by hand. Provider resolution is
**explicit-first** (`resolveProvider`): `"provider": "pi"` forces the pi
coding agent CLI, `"anthropic"`/`"openai"` force that API, `"none"` disables
LLM features; empty/absent falls back to key-derived auto (`ANTHROPIC_API_KEY`
wins over `OPENAI_API_KEY`). `OPENAI_BASE_URL` points the openai provider at
any OpenAI-compatible endpoint. Optional keys: `model`, `notesFile`, `piBin`,
`notifierBin`, `port`, `instrument`, `instruments` (dropdown CSV),
`granularity`, `freshBars`, `watchers`, `bot` (per-combo bot config), `info`
(overlays toggle).

Everything under `data/` (db, settings with keys, notes, logs) is gitignored.

## `data/` layout

- `candles.db` — the one database the app reads/writes (`node:sqlite`):
  `candles`, `signals`, `signal_snapshots`, `signal_rechecks` (#70 re-checks),
  `chat_threads`/`chat_messages`, `portfolio`/`positions`/`bot_trades`/
  `bot_journal`/`bot_state` (the virtual CFD book), `strategies`,
  `memories`, `gate_prompts`, `news`/`articles` (sentinel + legacy article
  caches).
- `settings.json` — provider/watcher/bot config (see above).
- `notes.md` — free-form trader notes; read by the filter and chat.
- `*-launchd.log` — LaunchAgent stdout/stderr.
- `db.sqlite`, if present, is **not** used by the app — both scripts default to
  `data/candles.db`; that name only appears as a test-fixture filename.

## Setup

1. `brew install terminal-notifier` (optional — clickable notifications).
2. Install the two LaunchAgents: [docs/launch-agents.md](docs/launch-agents.md)
   (candle-aligned watcher schedule + KeepAlive server).
3. Open `http://127.0.0.1:8787`, hit ⚙ to configure the provider, and 🔔 the
   combos you want alerts for.
4. Optional: keep trading notes in `data/notes.md`, arm a bot for a watched
   combo in the 🤖 bot modal, and add standing rules in the 🧠 memories modal.

`npm test` runs the full suite (fixture db, fake provider binaries, served-page
syntax guard — no live network).

## Agent skills

Self-contained `SKILL.md` + Node scripts, runnable from an agent/cron prompt or
directly with `node` — also exposed to the dashboard chat/bot as tools:

| Skill | What it does |
|-------|--------------|
| [`market-sentinel`](skills/market-sentinel/SKILL.md) | Free breaking geopolitical/macro news, escalation-flagged; backs the watcher's news cache and the sentinel briefing digest. |
| [`fxempire-analysis`](skills/fxempire-analysis/SKILL.md) | Multi-asset rates + news/forecasts → in-depth markdown report; also backs the `fxempire_articles` chat tool. |
| [`fxempire-live-data`](skills/fxempire-live-data/SKILL.md) | Near-real-time candles/rates (FXEmpire/Oanda) — JSON for automation. |
| [`briefing-publisher`](skills/briefing-publisher/SKILL.md) | Publish a markdown briefing to a GitHub Pages repo; sentinel is now the default `market` series source. |
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
