# market-signals

A local, self-hosted trading-signals pipeline for macOS: supertrend flip alerts
with an LLM sanity filter, per-combo paper-trading bots with versioned
strategies, a live chart dashboard with a trading-copilot chat, trader memory,
free breaking-news context, and agent skills for market analysis — all plain
Node (stdlib only, no npm dependencies; the one chart library is vendored).

```
┌─ LaunchAgent (KeepAlive) ────────────────────────────────────────────────┐
│ scripts/signal-server.mjs — single process                               │
│  http://127.0.0.1:8787 — chart · quote strip · signals · settings · bot  │
│  · chat copilot                                                          │
│  heartbeat (scripts/keep-fresh.mjs), candle-aligned per watcher combo:   │
│   fetch candles → supertrend(10,3) flips → LLM filter verdict            │
│   → notification → per-combo bot deliberation (paper trades)             │
│   → refresh HTF cache (M15/M30/H1/H4) → refresh sentinel news cache      │
└──────────────────────────────────────────────────────────────────────────┘
                            │
                            └── data/candles.db
```

The LaunchAgent's only job is `KeepAlive` — the server's own heartbeat owns
candle fetching, decisions, and alerts (see
[docs/launch-agents.md](docs/launch-agents.md)).

## The decision cycle — `scripts/keep-fresh.mjs` (server heartbeat)

Runs on each watched combo's own candle-aligned cadence (`cycleMinutes[gran]`,
default: the bar length capped at 5, so M1 cycles every bar — see #195), owned by the signal-server process. For every
configured watcher combo (`watchers` CSV in settings, e.g.
`WTICO/USD|M5, XAU/USD|M15`):

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
- polls the market-sentinel breaking-news cache (see below) for the tracked
  instruments that have a committed sentinel query in `config/instruments.yaml`
  (others are skipped — it never guesses a query), staleness-gated (~8 min per
  instrument), so filter/bot prompts read from a warm cache instead of fetching
  live on the signal
  path.

The cycle emits two signal kinds: **supertrend flips** (LLM-filtered, above)
and **volume impulses** — two consecutive same-direction bars each carrying
volume ≥ `impulseVolMult`× the average of the preceding `impulseVolWindow` bars
(defaults 2× / 20 / 10-bar cooldown), notification-only with no LLM filter,
so continuation moves mid-trend still alert even when no flip occurs. Impulse
rows are labeled distinctly in the signal-history table and excluded from
flip win-rate statistics.

Set `MS_DEBUG_LLM=1` in the environment to log a one-line
provider/model/token-usage summary per LLM completion (filter and bot) to
stderr — a local dev flag, not a persisted setting.

`scripts/supertrend.mjs` also exists as a manual/debug CLI running this same
cycle for one combo — useful for one-off checks or backtests, but not run on
a schedule (the server heartbeat is the sole cycle owner). Running it while
the server is up against a combo the server already watches can
double-execute that cycle (duplicate notify/store); that's the operator's
responsibility, not guarded against.

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
  settings, 💬 chat toggle) and a per-instrument row (instrument/granularity
  selects, 🔔/🔕 watch toggle, 🤖 bot for this view, indicator toggles). Memories
  and gates live inside the settings modal's tabs (no redundant header buttons).
  Icon buttons carry `aria-label`s; the canvases expose `role="img"` text
  alternatives.
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
- **Bot modal** (🤖): per-combo (instrument|granularity) bot configuration
  (enable, strategy binding, risk%/allocation% overrides) and a dedicated
  strategy tab for drafting or activating that combo's strategy. Stays a
  per-view modal — bot config is instrument-specific, not global settings.
- **Settings modal** (⚙, #108): one tabbed modal of **global** config (reopens on
  the last-used tab), four tabs:
  - **LLM provider** — contextual provider/model/key panel (masked keys, atomic writes);
  - **News provider** — every `NEWSAPI_AI_*` setting (masked key);
  - **Gates & notes** — per-gate transparency (filter/recheck/bot/chat): effective
    system prompt + declared toolset, drafted overrides, human-only activation for
    the filter and recheck gates; plus the standing notes (add, reweight, edit,
    archive). Both stores are global, hence this tab rather than the bot modal;
  - **Advanced** — watcher fields, launch plumbing, and the info-overlays toggle.

  LLM/News/Advanced commit together via one **Save** (per-tab dirty dot); the
  gates/notes panel auto-saves each edit, so it renders outside that form and
  keeps no Save button of its own.
- **Chat sidebar** (💬, collapsible — collapsed by default so the chart claims
  the full width; the toggle reveals it and remembers your choice): a trading
  copilot on the configured provider with persistent threads
  (`chat_threads`/`chat_messages` in the same db), SSE streaming, markdown
  rendering, and per-message context (current view, quote,
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

Each `instrument|granularity` combo can have its own paper-trading bot
(`settings.bot.bots["INSTRUMENT|GRAN"]`, unset fields inherit global bot
defaults). A bot only *deliberates* on ticks the watcher actually iterates —
i.e. combos in `settings.watchers`; a bot configured for an unwatched combo
stays configured (its higher-timeframe cache still refreshes, since that
tracks watchers ∪ bot combos; the news cache also refreshes it only if the
instrument has a committed sentinel query in `config/instruments.yaml`) but
won't trade until that combo is
watched. Deterministic work — candle fills,
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
- **Position sizing sizes to budget instead of rejecting an oversized order.**
  The LLM's requested notional is only an upper-bound hint; the server clamps
  it down to whatever fits the risk%/allocation% caps for that instrument (and
  journals the requested vs. effective notional and which cap bound). When the
  budget is fully exhausted the bot falls back to a `hold`. (The pre-existing
  hard invariants still apply — a halted portfolio, the max-concurrent-positions
  limit, or insufficient cash for margin+commission still stop an open.)
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
conversational side effect (`save_memory` tool); the settings modal's **Gates &
notes** tab is the manual add/edit/reweight/archive surface. Archiving hides a memory from
context but never deletes the row.

## Gates & prompts

Four LLM surfaces ("gates"), all sharing one design: an effective system
prompt is always resolvable, and only two of the four accept operator-drafted
revisions:

| Gate | What it does | Overridable? |
|------|---------------|---------------|
| **Filter** | Single-shot sanity check on every fresh flip; no tools. | Yes — draft via chat or the Gates & notes tab, human-activated. |
| **Bot** | Tool-loop deliberation (fxempire articles, sentinel news, Truth Social posts, live rates; plus Anthropic-only server-side web search) that opens/closes/holds. | No — strategy-owned, not gate-owned. |
| **Chat** | The copilot; full tool loop including the save-draft tools. | No — constant system prompt. |
| **Recheck** | Operator-initiated 🔁 re-check of a past signal's verdict. | Yes — draft via chat or the Gates & notes tab, human-activated. |

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

**NewsAPI.ai preferred provider (issue #104):** add `NEWSAPI_AI_KEY` to
`data/settings.json` (like the other API keys — the live watcher/bot read it from
settings, with the process env as a fallback; `.env` is not loaded by the
LaunchAgent) and it layers on as the preferred source — fresher, with publisher
domain, `eventUri`, and sentiment — merged first so it wins the canonical dedup. It's pulled **on-demand
at decision points** (a fresh flip being filtered, a bot deliberating), so a trial
token is spent when a decision is weighed, not every tick; the persisted
`NEWSAPI_AI_REQUEST_BUDGET` hard-caps spend and falls back to the free stack when
exhausted. Modes: `auto`/`shadow`/`off`. The every-tick background
poller is opt-in (`NEWSAPI_AI_BACKGROUND=1`, for the latency benchmark only).
`node scripts/news-provider-report.mjs --instrument WTICO/USD --since <date>`
reports coverage, latency, and trading relevance from the provenance log. Without
a key, behavior is byte-for-byte the free stack. See
`skills/market-sentinel/SKILL.md`.

## Provider configuration — `data/settings.json`

Edited from the settings modal, or by hand. Provider resolution is
**explicit-first** (`resolveProvider`): `"provider": "pi"` forces the pi
coding agent CLI, `"anthropic"` forces the Anthropic API, `"openai"` forces the
official OpenAI API, `"openai-compatible"` forces any OpenAI-compatible endpoint
(`OPENAI_BASE_URL` required), `"none"` disables LLM features; empty/absent falls
back to key-derived auto (`ANTHROPIC_API_KEY` wins over `OPENAI_API_KEY`; an
`OPENAI_BASE_URL` present resolves to `openai-compatible`). The model **binds
per provider** via a `models` map (`models[provider]`) so switching providers
never sends one provider's model slug to another; the flat `model` is the active
provider's fallback. The settings modal renders a **contextual provider panel**
— pick a provider and only its relevant fields (model, base URL, key,
`maxCompletionTokens`) appear. Optional keys: `model`, `models`, `notesFile`, `piBin`,
`notifierBin`, `port`, `instrument`, `instruments` (dropdown CSV),
`granularity`, `freshBars`, `watchers`, `bot` (per-combo bot config), `info`
(overlays toggle). Speech-to-text (chat mic button, #137): `sttOpenaiKey` (a
**real** OpenAI key — kept separate from the LLM `OPENAI_API_KEY`, which may be a
chat-only proxy with no transcription endpoint), `sttOpenaiBaseUrl` (default
`https://api.openai.com/v1`), `sttModel` (default `gpt-4o-mini-transcribe`),
`sttMode` (`openai`|`local`, default OpenAI when `sttOpenaiKey` is set), `sttBin`
(a local command invoked as `sttBin <audiofile>` printing the transcript to
stdout — wrap whisper.cpp here for a fully-offline backend).

### Pushover push notifications (opt-in)

Off by default; nothing changes until you configure it. When enabled, every
alert (a supertrend flip, a volume-impulse alert, the bot's kill-switch halt)
is pushed to your phone via [Pushover](https://pushover.net), **in addition
to** the existing desktop notification — not instead of it, so the desktop one
still fires as a safety net if a push fails or the monthly quota is hit. A
one-off ~$5 iOS licence covers iPhone/iPad/Apple Watch; free tier is 10,000
messages/month. The alert text (instrument, direction, price) leaves this
machine over Pushover's hosted service — that's inherent to any hosted push
target, so weigh it before enabling.

To activate: ⚙ settings modal → **Advanced** tab → set `PUSHOVER_ENABLED` on
and fill in `PUSHOVER_TOKEN` (your Pushover application API token) and
`PUSHOVER_USER` (your user key), then Save. This writes to `data/settings.json`,
**not** `.env` — the LaunchAgent never loads `.env`, so that's the only place
that reaches the live watcher/bot. Both fields are masked write-only secrets,
same as the LLM API keys. Enabling the toggle without both keys set is inert
(no call attempted, a one-time log line) rather than erroring on every alert.

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
- `db.sqlite`, if present, is not read by default — both scripts default their
  `--db` to `data/candles.db` (a stray `db.sqlite` is leftover cruft, and the
  name otherwise only appears as a test-fixture filename). It *would* be used
  only if you explicitly pass `--db data/db.sqlite`.

## Setup

1. `brew install terminal-notifier` (optional — clickable notifications).
2. Install the LaunchAgent: [docs/launch-agents.md](docs/launch-agents.md)
   (KeepAlive server; its own heartbeat runs the candle-aligned decision
   cycle).
3. Open `http://127.0.0.1:8787`, hit ⚙ to configure the provider, and 🔔 the
   combos you want alerts for.
4. Optional: keep trading notes in `data/notes.md`, arm a bot for a watched
   combo in the 🤖 Bot modal, and add standing rules in the ⚙ settings modal's
   **Gates & notes** tab.

`npm test` runs the full unit suite (fixture db, fake provider binaries,
served-page assertions — no live network, zero deps). `npm run test:e2e` runs the
Playwright/WebKit feature walkthrough (dashboard + all five modals across four
viewport/orientations) — dev-only (`npm i && npx playwright install webkit`), and
in CI it's an opt-in matrix job that only fires when the served page changes.

## Agent skills

Self-contained `SKILL.md` + Node scripts, runnable from an agent/cron prompt or
directly with `node` — also exposed to the dashboard chat/bot as tools:

| Skill | What it does |
|-------|--------------|
| [`market-sentinel`](skills/market-sentinel/SKILL.md) | Free breaking geopolitical/macro news, escalation-flagged; backs the watcher's news cache and the sentinel briefing digest. |
| [`fxempire-analysis`](skills/fxempire-analysis/SKILL.md) | Multi-asset rates + news/forecasts → in-depth markdown report; also backs the `fxempire_articles` chat tool. |
| [`fxempire-live-data`](skills/fxempire-live-data/SKILL.md) | Near-real-time candles/rates (FXEmpire/Oanda) — JSON for automation. |
| [`briefing-publisher`](skills/briefing-publisher/SKILL.md) | Publish a markdown briefing to a GitHub Pages repo; the market-sentinel digest is now the recommended input, published as `--series sentinel` (the FXEmpire `--series market` input is deprecated; `publish_briefing.mjs` still defaults `--series` to `market`). |
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
