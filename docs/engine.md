# Engine reference

The engine is the Node part of Market Signals. It runs as one process, `scripts/signal-server.mjs`. It uses the Node standard library only and has no npm runtime dependencies. The one chart library is vendored under `vendor/`. This file is the reference for the engine. The [README](../README.md) gives the overview and the quickstart.

```
┌─ LaunchAgent (KeepAlive) ────────────────────────────────────────────────┐
│ scripts/signal-server.mjs, single process                                │
│  http://127.0.0.1:8787: chart, quote strip, signals, settings, bot,      │
│  chat copilot                                                            │
│  heartbeat (scripts/keep-fresh.mjs), candle-aligned per watcher combo:   │
│   fetch candles, supertrend(10,3) flips, LLM filter verdict,             │
│   notification, per-combo bot deliberation (paper trades),               │
│   refresh HTF cache (M15/M30/H1/H4), refresh sentinel news cache         │
└──────────────────────────────────────────────────────────────────────────┘
                            │
                            └── data/candles.db
```

The LaunchAgent only keeps the process alive (`KeepAlive`). The server's own heartbeat owns candle fetching, decisions and alerts. See [launch-agents.md](launch-agents.md).

## The decision cycle

The server heartbeat in `scripts/keep-fresh.mjs` runs the decision cycle. The signal-server process owns it. Each watched combo runs on its own candle-aligned cadence, `cycleMinutes[gran]`. The default is the bar length capped at 5 minutes, so M1 cycles every bar (https://github.com/mfittko/market-signals/issues/195). The combos come from the `watchers` CSV in settings, for example `WTICO/USD|M5, XAU/USD|M15`.

For every watched combo the cycle does the following:

- It fetches live Oanda candles through the FXEmpire proxy, computes Supertrend(10,3) and detects flips. It also runs an inline flip-following backtest, so every alert carries its recent track record.
- It stores candles and every fresh flip in `data/candles.db` (`node:sqlite`). Past signals get realized 30-minute outcomes, computed from stored candles.
- It sends each fresh flip through the configured LLM provider. This is the filter gate. Its context holds recent candles, the backtest, past outcomes, volume against the 20-bar average, trader notes, trader memory and cached sentinel headlines. The filter fails open: a filter error still sends the alert.
- It notifies through `terminal-notifier`, with an osascript fallback. A click opens the chart deep link for that exact signal. Each flip is delivered at most once. An exact timestamp check removes duplicates, and a 3-bar lock-in cooldown blocks re-detections after a window shift.
- It runs the configured per-combo bot (see below) on every fresh flip or adverse-move event for that combo.
- It refreshes the higher-timeframe candle cache (M15/M30/H1/H4) for every instrument that is watched or tracked by a bot. The refresh is staleness-gated and rate-capped, so a long downtime does not cause an unbounded fetch storm on the next tick.
- It polls the market-sentinel breaking-news cache (see below) for tracked instruments that have a committed sentinel query in `config/instruments.yaml`. It skips other instruments and never guesses a query. The poll is staleness-gated at about 8 minutes per instrument. Filter and bot prompts read a warm cache and do not fetch live news on the signal path.

The cycle emits two signal kinds.

- Supertrend flips go through the LLM filter, as described above.
- Volume impulses are two consecutive same-direction bars. Each bar carries volume of at least `impulseVolMult` times the average of the preceding `impulseVolWindow` bars. The defaults are 2x, 20 bars and a 10-bar cooldown. Impulses only notify and skip the LLM filter. This way a continuation move in the middle of a trend still alerts when no flip occurs. The signal-history table labels impulse rows separately, and flip win-rate statistics exclude them.

Set `MS_DEBUG_LLM=1` in the environment to log one line per LLM completion (filter and bot) to stderr. The line holds provider, model and token usage. This is a local dev flag and is never persisted.

`scripts/supertrend.mjs` is a manual and debug CLI. It runs the same cycle for one combo, for one-off checks or backtests. No schedule runs it, because the server heartbeat is the only cycle owner. If you run it against a combo that the live server already watches, the cycle can run twice (duplicate notify and store). Nothing guards against this. The operator is responsible.

```bash
node scripts/supertrend.mjs --instrument WTICO/USD --granularity M5 --notify true
node scripts/supertrend.mjs --help
```

## The dashboard

`scripts/signal-server.mjs` serves an always-on web app on `http://127.0.0.1:8787`. It binds 127.0.0.1 only.

```bash
node scripts/signal-server.mjs [--port 8787] [--db data/candles.db] [--settings data/settings.json]
```

The page has these parts.

- The chart uses Chart.js candlesticks, vendored under `vendor/` with no CDN. It shows the supertrend overlay, flip markers, a volume underlay, hover OHLC tooltips and x/y scales. Data is minute-fresh and includes the forming candle. Deep links (`/?instrument=…&granularity=…&t=<flip-time>`) render the signal context through to the present.
- The header has two rows. The global row holds the portfolio (💼), settings (⚙) and chat (💬) buttons. The per-instrument row holds the instrument and granularity selects, the watch toggle (🔔/🔕), the bot for this view (🤖) and the indicator toggles. Memories and gates live in tabs of the settings modal, so the header has no extra buttons for them. Icon buttons carry `aria-label`s, and the canvases expose `role="img"` text alternatives.
- The quote strip shows the last price, the 1h and 24h change, the day range, the supertrend distance and the freshness label `live · candle forming`.
- The signals panel shows the verdict and a clickable history with realized outcomes. The inline 🔁 button is the operator re-check. It asks the recheck gate, an on-demand LLM call, whether a past signal is still `valid`, `played-out` or `invalidated`. Every re-check is journaled to `signal_rechecks` and never changes the original signal (https://github.com/mfittko/market-signals/issues/70). Browsing any instrument and granularity backfills its historical flips on demand with the verdict `backfill`. A backfill never swallows a live watcher alert.
- The watch toggle (🔔) watches or unwatches the current combo. It writes the `watchers` CSV that the alert watcher loops over.
- The portfolio modal (💼) shows the virtual CFD portfolio: equity, cash, margin, open positions, trade history, per-strategy performance and the audit journal. The journal holds every open, skip, close, halt and reset row. The modal also lists the activated bots.
- The bot modal (🤖) configures the bot for one combo (instrument|granularity): enable, strategy binding, and risk% and allocation% overrides. A strategy tab drafts or activates the strategy of that combo. Bot config is instrument-specific, so it stays a per-view modal outside the global settings.
- The settings modal (⚙, https://github.com/mfittko/market-signals/issues/108) holds the global config in one tabbed modal. It reopens on the last-used tab. It has four tabs:
  - LLM provider: a contextual provider, model and key panel, with masked keys and atomic writes.
  - News provider: every `NEWSAPI_AI_*` setting with a masked key, plus the `GNEWS_*` fields for the second opt-in provider, also with a masked key.
  - Gates & notes: per-gate transparency for filter, recheck, bot and chat. It shows the effective system prompt and the declared toolset, the drafted overrides, and human-only activation for the filter and recheck gates. It also holds the standing notes (add, reweight, edit, archive). Both stores are global, so they live here and not in the bot modal.
  - Advanced: watcher fields, launch plumbing and the info-overlays toggle.

  The LLM, News and Advanced tabs commit together through one Save button. Each tab shows a dirty dot. The gates and notes panel saves each edit at once, so it renders outside that form and has no Save button.
- The chat sidebar (💬) is collapsible and starts collapsed, so the chart takes the full width. The toggle opens it and remembers your choice. It is a trading copilot on the configured provider. Threads persist in `chat_threads` and `chat_messages` in the same database. It streams over SSE and renders markdown. Each message carries context: the current view, quote, candles, signal history, notes, trader memory, gate prompts and bot performance. The copilot can widen its context with tools: FXEmpire news articles, sentinel breaking news, Trump Truth Social posts, live rates, and saving a strategy, memory or gate-prompt draft. Anthropic gets the tools plus server-side web search. OpenAI gets the tools. Both use native tool-use loops. pi answers from the provided context only. No provider gets shell access, and the clamped tool registry is the entire tool surface. A draft saved through a chat tool never takes effect on its own. Activation is always a separate human act.

With `MS_DEBUG_LLM=1` the server also reports the provider, model and usage of each completion. The non-streamed `/api/recheck` carries all four as response headers: `X-LLM-Provider`, `X-LLM-Model`, `X-LLM-Usage-Input` and `X-LLM-Usage-Output`. The chat SSE stream flushes its headers before the completion finishes. So it carries only `X-LLM-Provider` and `X-LLM-Model` as headers and sends the token usage as a trailing `{type:'usage'}` SSE event. With the flag off there are no headers and no usage event, and behavior is unchanged.

## Per-combo bots, strategies and the virtual portfolio

Each `instrument|granularity` combo can have its own paper-trading bot in `settings.bot.bots["INSTRUMENT|GRAN"]`. Unset fields inherit the global bot defaults.

A bot deliberates only on ticks that the watcher iterates, that is, on combos in `settings.watchers`. A bot for an unwatched combo stays configured but does not trade until the combo is watched. Its higher-timeframe cache still refreshes, because that cache tracks watchers and bot combos together. Its news cache refreshes only if the instrument has a committed sentinel query in `config/instruments.yaml`.

Deterministic work runs on every candle close: candle fills, mark-to-market and the drawdown kill switch. The LLM deliberates only on events: a fresh flip, or an adverse move past the review trigger. Malformed output, a timeout or a provider error becomes a journaled hold. The bot fails safe, which is the inverse of the filter's fail-open rule.

- Strategies are versioned prompt and spec records in the `strategies` table. An edit always appends a new version and never rewrites a row. So the audit trail stays attributed to the exact text that produced each decision. A bot references a strategy by name and always follows the currently active version of that name. It does not store a row id. A draft from chat that you activate in the bot modal takes effect on the next deliberation, and the bot's stored config stays unchanged. A strategy can belong to one combo or be shared across several. Activation is per name, so a dedicated strategy and the shared pool can both be active at once.
- Position sizing clamps an oversized order to the budget and does not reject it. The LLM's requested notional is an upper-bound hint. The server reduces it to what fits the risk% and allocation% caps for that instrument. It journals the requested notional, the effective notional and the cap that applied. When the budget is used up, the bot falls back to a hold. The hard invariants still stop an open: a halted portfolio, the maximum number of concurrent positions, or too little cash for margin plus commission.
- One global drawdown kill switch protects the book. When equity falls further below its peak than the configured percentage, the whole portfolio halts and opens nothing new. Only an operator reset lifts the halt. The reset is a human act and never automatic.
- The portfolio is a virtual CFD book. Positions are notional-based, with configurable leverage (capped) and a fixed per-instrument spread paid once on entry. It uses paper money only.

## Trader memory

Trader memory holds durable standing rules in the `memories` table. They ride along as advisory context in the filter, bot deliberation and chat prompts. They never replace the fail-safe clamps above. Chat can save a memory as a side effect through the `save_memory` tool. The Gates & notes tab of the settings modal is the manual surface to add, edit, reweight and archive memories. Archiving hides a memory from context and keeps the row.

## Gates and prompts

The engine has four LLM surfaces, called gates. They share one design: an effective system prompt is always resolvable. Two of the four accept operator-drafted revisions.

| Gate | What it does | Overridable |
|------|--------------|-------------|
| Filter | Single-shot sanity check on every fresh flip. No tools. | Yes. Draft through chat or the Gates & notes tab. A human activates it. |
| Bot | Tool-loop deliberation that opens, closes or holds. Tools: FXEmpire articles, sentinel news, Truth Social posts, live rates, and server-side web search on Anthropic only. | No. The strategy owns the prompt. |
| Chat | The copilot, with the full tool loop including the save-draft tools. | No. The system prompt is constant. |
| Recheck | The operator-started 🔁 re-check of a past signal's verdict. | Yes. Draft through chat or the Gates & notes tab. A human activates it. |

Overridable gates store versioned drafts in `gate_prompts`. The table is append-only. Chat or a manual edit creates a `draft`, and a human act sets `active`. The gates panel is the transparency and activation surface for all four gates.

## Market-sentinel breaking news

The market-sentinel skill (`skills/market-sentinel/`) is a free breaking-news source that needs no key. It reads Google News RSS, GDELT, Al Jazeera, OilPrice.com and a per-instrument Yahoo Finance feed. It removes duplicates and flags escalation on a negative GDELT tone or a keyword hit.

The watcher polls it into the `news` table in the background on every tick, staleness-gated at about 8 minutes per tracked instrument. The filter and bot prompts read a compact `{escalation, headlines, asOf}` block from that cache. The block is always advisory and never a reason to skip the chop, volume or risk checks. The sentinel is also an on-demand chat tool (`sentinel_news`). The briefing-publisher uses it for its default `sentinel` series.

The older FXEmpire market-analysis briefing input is deprecated because its source dried out. `fxempire-analysis` still backs the live `fxempire_articles` chat tool and its own standalone report pipeline.

### NewsAPI.ai, the preferred provider

NewsAPI.ai is the preferred news provider (https://github.com/mfittko/market-signals/issues/104).

- Add `NEWSAPI_AI_KEY` to `data/settings.json`, like the other API keys. The live watcher and bot read it from settings, with the process environment as a fallback. The LaunchAgent does not load `.env`.
- With a key, NewsAPI.ai layers on top of the free stack. Its articles are fresher and carry the publisher domain, `eventUri` and sentiment. They merge first, so they win the canonical dedup.
- The engine pulls it on demand at decision points: when a fresh flip is filtered and when a bot deliberates. So a trial token is spent when a decision is weighed, and not on every tick.
- The persisted `NEWSAPI_AI_REQUEST_BUDGET` caps spend. When the budget is used up, the engine falls back to the free stack.
- Modes are `auto`, `shadow` and `off`.
- The background poller on every tick is opt-in (`NEWSAPI_AI_BACKGROUND=1`). It exists for the latency benchmark only.
- `node scripts/news-provider-report.mjs --instrument WTICO/USD --since <date>` reports coverage, latency and trading relevance from the provenance log.
- Without a key, behavior is byte-for-byte the free stack.

See [skills/market-sentinel/SKILL.md](../skills/market-sentinel/SKILL.md).

### GNews, a second opt-in provider

GNews is a second, independent provider. It is off by default, and adding it removes nothing.

- Add `GNEWS_KEY` in the News provider tab of the settings modal. The field is masked and write-only. GNews then runs alongside NewsAPI.ai. The choice between the two comes later, based on measured coverage, precision and latency.
- `GNEWS_MODE` defaults to `off`. `off` disables it. `shadow` fetches and records to the same provider-observations log for comparison only, and its articles never reach a prompt. `auto` also merges its articles into the same deduplicated news union that every other source feeds.
- The free developer key is a delayed feed. Every article arrives 12 hours after publication, and the key is licensed for non-commercial and evaluation use only. So `auto` on a free key presents a stale feed as a live one. A paid or trial key is required before `auto` can inform a real decision. The free key is good for `shadow`: you can build and measure the adapter without spending money.
- `GNEWS_REQUEST_BUDGET` caps spend as a running lifetime total. The counter never resets. Once the total is reached, the provider stops until you raise the number.
- The fetch runs on demand at decision points by default. Background polling is a separate field on the same tab (`GNEWS_BACKGROUND`, off by default). It stays opt-in for the same reason as for NewsAPI.ai. The watcher's background cadence of about 8 minutes visits every instrument with a sentinel query, 4 of the 7 watched instruments at the time of writing. That is roughly 720 requests per day against the GNews cap of 100 per day. With polling off, spend stays tied to decisions.

For both providers, the key you set in the settings modal persists to `data/settings.json`. The long-lived server reads that file. The LaunchAgent never loads `.env`, so `.env` covers CLI and test runs only.

## Provider configuration in data/settings.json

You edit `data/settings.json` from the settings modal or by hand.

Provider resolution is explicit-first (`resolveProvider`):

- `"provider": "pi"` forces the pi coding agent CLI.
- `"claude-code"` forces the Claude Code CLI. It runs headless `claude -p` with its own tools, settings, skills and sessions off. It uses the operator's Claude Code login, so no key is stored. `claudeBin` overrides the binary path. The default is `~/.local/bin/claude`.
- `"anthropic"` forces the Anthropic API.
- `"openai"` forces the official OpenAI API.
- `"openai-compatible"` forces any OpenAI-compatible endpoint and requires `OPENAI_BASE_URL`.
- `"none"` disables LLM features.
- An empty or absent value falls back to key-derived auto. `ANTHROPIC_API_KEY` wins over `OPENAI_API_KEY`. A present `OPENAI_BASE_URL` resolves to `openai-compatible`.

The model binds per provider through the `models` map (`models[provider]`). So switching providers never sends one provider's model slug to another. The flat `model` is the fallback for the active provider. The settings modal shows a contextual provider panel: pick a provider and only its fields appear (model, base URL, key, `maxCompletionTokens`).

Optional keys: `model`, `models`, `notesFile`, `piBin`, `claudeBin`, `notifierBin`, `port`, `instrument`, `instruments` (dropdown CSV), `granularity`, `freshBars`, `watchers`, `bot` (per-combo bot config) and `info` (overlays toggle).

The platform key `consoleUrl` makes alert links open the console. You set it by hand in `settings.json`, or `platform/scripts/switch-launchd.sh up` sets it.

Speech-to-text for the chat mic button (https://github.com/mfittko/market-signals/issues/137) uses these keys:

- `sttOpenaiKey` is a real OpenAI key. It stays separate from the LLM `OPENAI_API_KEY`, which may point at a chat-only proxy with no transcription endpoint.
- `sttOpenaiBaseUrl` defaults to `https://api.openai.com/v1`.
- `sttModel` defaults to `gpt-4o-mini-transcribe`.
- `sttMode` is `openai` or `local`. It defaults to OpenAI when `sttOpenaiKey` is set.
- `sttBin` is a local command, invoked as `sttBin <audiofile>`, that prints the transcript to stdout. Wrap whisper.cpp here for a fully offline backend.

### Verdict budget and fallback provider

These settings apply to the alert filter and the recheck gate only. They never apply to the bot or chat.

- `filterMaxCompletionTokens` caps the filter and recheck completion separately from the global `maxCompletionTokens`. Its default is well above the global value. A reasoning model can otherwise spend the whole budget on chain-of-thought before it emits the verdict JSON. The result is then `finish_reason=length` with no content, or on the Anthropic shape, JSON cut off mid-string. One budget covers every provider. It is a ceiling and reserves nothing, and both vendors bill actual output, so a generous value costs nothing when the model answers fast. Keep it below the configured model's own output cap, or the provider rejects the request.
- `anthropicThinking` controls whether Anthropic models reason before they answer. Leave it unset unless you need to force `adaptive` or `disabled`. Unset sends no `thinking` field, and it is the only value that every model accepts. Some models reject an explicit `disabled`.
- `llmFallbackProvider` retries the verdict once on a second provider when the primary produces nothing usable: a transport error, a timeout, an empty reply or JSON the filter cannot parse. It is off by default. Both providers already keep their key and model side by side in `data/settings.json` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`/`OPENAI_BASE_URL` and `models[provider]` coexist). So a fallback needs no new credentials. When it fires, the signal payload (instrument, price, the flip itself) also goes to the second vendor. The two attempts share one 90-second deadline. If the primary uses all of it, the fallback is skipped. Once a fallback is configured, the stored `reason` names the provider that produced the verdict. So `signals.reason` in `candles.db` shows directly whether the fallback carries the load.

### Pushover push notifications (opt-in)

Pushover is off by default, and nothing changes until you configure it. When it is on, every alert goes to your phone through [Pushover](https://pushover.net): a supertrend flip, a volume-impulse alert and the bot's kill-switch halt. The desktop notification still fires as well. So it stays a safety net when a push fails or the monthly quota runs out.

A one-off iOS licence of about $5 covers iPhone, iPad and Apple Watch. The free allowance is 10,000 messages per month. The alert text (instrument, direction, price) leaves this machine through the hosted Pushover service. Every hosted push target works this way, so weigh this before you enable it.

To turn it on, open the settings modal (⚙), go to the Advanced tab, switch `PUSHOVER_ENABLED` on and fill in `PUSHOVER_TOKEN` (your Pushover application API token) and `PUSHOVER_USER` (your user key). Then press Save. The values go to `data/settings.json`. The LaunchAgent never loads `.env`, so settings is the only place that reaches the live watcher and bot. Both fields are masked write-only secrets, like the LLM API keys. With the toggle on and a key missing, the engine attempts no call and logs one line. It does not error on every alert.

## The data/ layout

Everything under `data/` is gitignored: the database, settings with keys, notes and logs.

- `candles.db` is the one database the engine reads and writes (`node:sqlite`). Tables: `candles`, `signals`, `signal_snapshots`, `signal_rechecks` (re-checks, https://github.com/mfittko/market-signals/issues/70), `chat_threads` and `chat_messages`, the virtual CFD book (`portfolio`, `positions`, `bot_trades`, `bot_journal`, `bot_state`), `strategies`, `memories`, `gate_prompts`, and `news` and `articles` (sentinel and legacy article caches).
- `settings.json` holds the provider, watcher and bot config (see above).
- `notes.md` holds free-form trader notes. The filter and chat read it.
- `*-launchd.log` holds the LaunchAgent stdout and stderr.
- A `db.sqlite` file, if present, is leftover. Both scripts default `--db` to `data/candles.db`, and the name otherwise appears only as a test-fixture filename. The engine uses it only if you pass `--db data/db.sqlite`.

## Engine setup

1. Optional: run `brew install terminal-notifier` for clickable notifications.
2. Install the LaunchAgent as described in [launch-agents.md](launch-agents.md). It keeps the server alive, and the server heartbeat runs the candle-aligned decision cycle.
3. Open `http://127.0.0.1:8787`. Press ⚙ to configure the provider, and press 🔔 on the combos you want alerts for.
4. Optional: keep trading notes in `data/notes.md`, arm a bot for a watched combo in the 🤖 bot modal, and add standing rules in the Gates & notes tab of the settings modal.

## Agent skills

Each skill is a self-contained `SKILL.md` with Node scripts. You can run it from an agent or cron prompt, or directly with `node`. The dashboard chat and the bot also use the skills as tools.

| Skill | What it does |
|-------|--------------|
| [`market-sentinel`](../skills/market-sentinel/SKILL.md) | Free breaking geopolitical and macro news, escalation-flagged. Backs the watcher's news cache and the sentinel briefing digest. |
| [`fxempire-analysis`](../skills/fxempire-analysis/SKILL.md) | Multi-asset rates and news or forecasts, turned into an in-depth markdown report. Also backs the `fxempire_articles` chat tool. |
| [`fxempire-live-data`](../skills/fxempire-live-data/SKILL.md) | Near-real-time candles and rates (FXEmpire/Oanda) as JSON for automation. |
| [`briefing-publisher`](../skills/briefing-publisher/SKILL.md) | Publishes a markdown briefing to a GitHub Pages repo. The recommended input is the market-sentinel digest, published as `--series sentinel`. The FXEmpire `--series market` input is deprecated, and `publish_briefing.mjs` still defaults `--series` to `market`. |
| [`hormuz-ais-watch`](../skills/hormuz-ais-watch/SKILL.md) | Strait of Hormuz AIS vessel watcher, an oil and geopolitics signal. |
| [`truthsocial-trump-watch`](../skills/truthsocial-trump-watch/SKILL.md) | Polls `@realDonaldTrump`, detects new posts and emits alert blocks. |

## Backtesting

- Supertrend: every watcher run reports the flip-following backtest for its window. The growing `candles` and `signals` tables support longer studies.
- Event studies: a 2-week harness measures Truth Social market impact (`scripts/fetch-trump-posts.mjs`, `classify-post.mjs`, `event-study.mjs`, `backtest.mjs`). It has per-instrument routing (F1), single-feed windows (F2) and validated candle symbols (F3, `config/candle-symbols.json`). That file is also the dashboard's instrument catalog.

```bash
node scripts/fetch-trump-posts.mjs --since 2026-06-27T00:00:00Z --until 2026-07-11T00:00:00Z --out posts.json
node scripts/backtest.mjs --posts posts.json --since 2026-06-27T00:00:00Z --until 2026-07-11T00:00:00Z --format markdown
```

## Packaging

The skills ship as a Claude Code plugin and a Pi extension (`plugin.yaml`, `.claude-plugin/`). `npm run verify` checks packaging integrity.
