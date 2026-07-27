---
name: market-sentinel
description: Fetch breaking geopolitical/macro news from free, query-driven sources (Google News, GDELT, Al Jazeera, OilPrice.com, Yahoo Finance) and flag escalation. Use when you need fast-moving news the FXEmpire scrape or the Truth Social archive would miss (e.g. a tanker attack or a war-powers story that moves crude).
---

# market-sentinel

`scripts/sentinel_news.mjs` fetches, normalizes, dedups, and escalation-flags breaking news for one instrument's query.

## Quick start

```bash
# By instrument (resolves the query + Yahoo symbol from config/instruments.yaml)
node skills/market-sentinel/scripts/sentinel_news.mjs --instrument WTICO/USD --hours 12 --json

# Explicit query (bypasses the config lookup)
node skills/market-sentinel/scripts/sentinel_news.mjs --query '(oil OR OPEC OR Hormuz)' --json
```

Output defaults to markdown; `--json` emits `{items, escalation, asOf, meta}`, where each item is
`{source, title, timeIso, summary, url, tone, themes, escalation}`.

## Sources (all free, keyless)

- Google News RSS (`news.google.com/rss/search`) — primary breaking aggregator
- GDELT DOC 2.0 (`api.gdeltproject.org/api/v2/doc/doc`) — breadth + tone/themes, rate-limited to ~1 req/5s per IP
- Al Jazeera (`aljazeera.com/xml/rss/all.xml`) — Middle-East/conflict backstop
- OilPrice.com (`oilprice.com/rss/main`) — dedicated energy
- Yahoo Finance per-symbol headline RSS — instrument-tagged (only when a `yahooSymbol` is configured)

Every source is failure-isolated: a dead feed logs and yields `[]`, never throws the whole call.

## Escalation

The top-level `escalation` boolean is true when a GDELT tone score is below `GDELT_TONE_ESCALATION_THRESHOLD` (-5) OR the
title/summary hits a word in the `ESCALATION_LEXICON` constant (attack, strike, sanction, embargo, Hormuz,
tanker, missile, drone, escalat*, war, OPEC cut, supply disruption).

## Per-instrument config

`config/instruments.yaml` carries a hand-maintained `sentinel` query string + `yahooSymbol` per rate slug
(oil, gold, silver, natural gas, platinum, spx). An instrument without a committed entry is never guessed —
`--instrument` on one resolves nothing and errors instead of fabricating a query.

## Briefing digest (issue #91)

`scripts/sentinel_briefing.mjs` renders a markdown digest (title, asOf, an escalation
summary, and top headlines grouped per instrument) across every instrument with a
committed sentinel query. It feeds `skills/briefing-publisher/scripts/publish_briefing.mjs --series sentinel`
— the replacement for the FXEmpire market-analysis briefing input, which dried out (#11/#28).

```bash
node skills/market-sentinel/scripts/sentinel_briefing.mjs --output-file /tmp/sentinel-briefing.md
# offline/test path (no network): --fixture <path-to-json-array>
```

## Background cache + context injection (issue #86)

`scripts/news.mjs`'s `refreshNewsCache` polls this skill in-process on every watcher tick, staleness-gated
per instrument (~8 min), bounded, and cache-only (no signals/notifications/bot decisions). The alert filter
and bot deliberation contexts (`scripts/supertrend.mjs`) read a compact `sentinel: {escalation, headlines,
asOf}` block from that cache, only when it has recent rows for the instrument — advisory context, never a
reason to bypass the stop/risk clamps.

## NewsAPI.ai preferred provider (issue #104)

When `NEWSAPI_AI_KEY` is set, NewsAPI.ai (Event Registry) is the **preferred, effectively-primary** provider.
**NewsAPI.ai-first, union (#115 revisited, #149):** in-window NewsAPI.ai and free-stack items are **merged**,
not either/or — completeness beats speed. NewsAPI.ai items go first, so on a canonical (url/fuzzy-title)
collision the richer NewsAPI.ai item wins the dedup. `out.newsApiAi.authoritative` is now diagnostic only: it
flags that the paid provider returned in-window items and is not in shadow mode. The free sources are also
recorded in the provenance log (`observed`) for the trial benchmark. Without a key, behavior is
byte-for-byte the free stack. Never a single point of failure: any error/timeout/quota falls back to the free
sources, and news stays advisory — it never bypasses the deterministic risk clamps or opens a trade.

**Primary path is on-demand at decision points.** A fresh flip being filtered, or a bot deliberation, triggers
a live NewsAPI.ai pull (`getArticles`, query-filtered) at that moment via `sentinelDecisionContext` — so a
trial token is spent when a decision is actually weighed, not on every tick. The filter + bot judging the same
flip share one pull (a ~5-min throttle). The persisted budget hard-caps spend and, once exhausted, silently
falls back to the free stack.

Config lives in **`data/settings.json`** (like `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`) — the running watcher/bot resolve it from settings first, then the process env as a fallback (the LaunchAgent never loads `.env`). Set it in the settings modal or by hand; in `auto` mode adding the key is the only opt-in needed:

```jsonc
// data/settings.json
{
  "NEWSAPI_AI_KEY": "<trial key>",       // enables NewsAPI.ai
  "NEWSAPI_AI_MODE": "auto",             // auto | shadow | off
  "NEWSAPI_AI_INSTRUMENTS": "WTICO/USD", // allowlist; empty ⇒ all sentinel instruments
  "NEWSAPI_AI_REQUEST_BUDGET": "1800",   // persisted global chargeable-request cap
  "NEWSAPI_AI_BACKGROUND": "1"           // OPT-IN: also poll every tick (off by default; latency benchmark)
}
```

**Source footnotes (issue #116).** Off by default. **Settings-only** (unlike the
`NEWSAPI_AI_*` keys above, this toggle is not read from the process env). Set
`sentinelSourceFootnotes: "1"` in `data/settings.json` (or the News tab in the
settings modal) and the copilot will add a footnote to each headline naming the
feed it was fetched from — `newsapi-ai` vs `google-news`/`gdelt` — separately from
the publisher's markdown link. The fetch provider is persisted on the `news` cache
(nullable `provider` column) so filter/bot decision blocks can surface it too;
`newsContextFor(..., { sourceFootnotes: true })` opts a caller in.

(The same names also work as process env vars for the CLI / local dev.)

The background poller (`refreshNewsCache`) is **off by default** — set `NEWSAPI_AI_BACKGROUND=1` only to run
continuous sampling for the latency benchmark. Provenance is logged to `news_provider_observations`; the trial
report reads it (read-only, spends no tokens):

```bash
node scripts/news-provider-report.mjs --instrument WTICO/USD --since 2026-07-24 [--json]
```

## Options

- `--instrument <sym>` candle symbol (e.g. `WTICO/USD`)
- `--query <text>` explicit search query (overrides `--instrument`)
- `--yahoo-symbol <sym>` explicit Yahoo Finance symbol, used alongside `--query`
- `--hours <n>` lookback window (default 12)
- `--max-items <n>` total cap after dedup (default 30)
- `--json` structured output
