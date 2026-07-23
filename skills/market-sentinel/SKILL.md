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

## Options

- `--instrument <sym>` candle symbol (e.g. `WTICO/USD`)
- `--query <text>` explicit search query (overrides `--instrument`)
- `--yahoo-symbol <sym>` explicit Yahoo Finance symbol, used alongside `--query`
- `--hours <n>` lookback window (default 12)
- `--max-items <n>` total cap after dedup (default 30)
- `--json` structured output
