# Benzinga news access for Sentinel

Research date: 2026-09-07

## Bottom line

There is no current public price card for the first-party Benzinga News API. Benzinga routes API customers through sales/licensing and says its news channels can be tailored to budget. The most actionable self-serve options are:

| Route | Current published price | What it provides | Fit for Sentinel |
| --- | ---: | --- | --- |
| Benzinga direct API | Quote required | First-party REST, TCP push, and RSS delivery; structured news, full text, channels, tickers, macro coverage | Best control and licensing clarity, but requires a sales conversation and likely a commercial agreement |
| Massive + Benzinga News | **$99/month per dataset** for individual access; business pricing is contact-sales | `/benzinga/v2/news`, real-time structured articles, full text, tickers, channels/tags, history back to 2009 | Best straightforward paid adapter if $99/month is acceptable, but macro coverage must be confirmed |
| Alpaca News API | **$0 Basic** or **$99/month Algo Trader Plus** market-data plan; confirm current news-commercial terms before relying on it | REST and WebSocket stock/crypto news; Alpaca says the news is provided directly by Benzinga | Cheapest trial path, but stock/crypto oriented and not a direct macro/commodity feed |
| Interactive Brokers / Benzinga Pro feed | **$35/month retail** or **$250/month institutional** | Benzinga breaking-news access through the Trader Workstation API | Possible if Sentinel already has an IBKR account; operationally heavier because it is TWS API rather than a simple REST credential |
| Benzinga Pro web subscription | **$37/month Basic**, **$147/month Streamlined**, **$197/month Essential** monthly prices shown | Human-facing Pro product | Not an application integration; do not assume this includes API redistribution rights |

The direct Benzinga route should be quoted explicitly for Sentinel’s use case: a private, single-user/local research and alerting system, reading headlines/teasers rather than republishing full articles. Ask for the minimum channel set and whether macro/commodity topics are licensed. Benzinga’s own product page says its stock-news product covers US equities and macroeconomics, but Massive’s public Benzinga endpoint documentation does not promise a dedicated macro feed; it describes article metadata and stock/crypto ticker associations. Treat Massive macro coverage as unconfirmed until tested or confirmed by sales.

## What the first-party Benzinga API supports

The current Newsfeed API is `GET https://api.benzinga.com/api/v2/news`. It supports filtering by tickers, ISINs/CUSIPs, channels, topics, authors, content type, importance, date ranges, `publishedSince`, and `updatedSince`. Results include an ID, author, created/updated timestamps, title, teaser/body, URL, channels, stocks, and tags. Benzinga recommends delta-style ingestion using `updatedSince` for production polling.

The API authenticates with `Authorization: token <API_KEY>` (the token query parameter is also supported for testing). The API documentation exposes a removed-news endpoint; a persistent consumer should use it to mark or remove retracted stories.

Benzinga also documents TCP push and WebSocket delivery. For Sentinel, REST polling is the better first seam: the existing watcher is already staleness-gated, bounded, failure-isolated, and cache-backed. A push consumer would add a long-lived connection, reconnect state, and a second scheduling model before we know the feed’s incremental value.

## Why there are several prices

These are not necessarily interchangeable credentials:

1. **Benzinga direct** is the source/licensor and can quote based on channels, history, delivery method, and redistribution/display rights.
2. **Massive** is a direct developer-facing reseller/integration surface. Its partner dataset has its own plan and API key, even though the content is Benzinga.
3. **Alpaca** exposes Benzinga news inside its own market-data API and account/rate-limit model. The official historical-news documentation says all news is currently provided directly by Benzinga; the product was originally announced as free during beta, so current account-specific terms should be checked in the Alpaca dashboard.
4. **IBKR** exposes a Benzinga Pro feed through TWS subscriptions/API access. It is a broker-platform entitlement, not the same thing as a Benzinga Cloud API key.
5. **Benzinga Pro** is the end-user application. Its subscription price is useful as a market reference, not as an integration price.

## Sentinel integration recommendation

### Preferred order

1. **Trial Massive at $99/month** if immediate self-serve evaluation matters. It has the cleanest published price and a documented Benzinga-specific endpoint, but test whether the returned stories include the macro/commodity topics Sentinel needs.
2. **Ask Benzinga for a direct quote in parallel**, specifically for headline/teaser access, REST polling, macro channels, and no public redistribution. Direct access may be cheaper or more appropriate once licensing is clear, but the price cannot be inferred from Benzinga Pro.
3. **Use Alpaca as a low-cost control experiment** only if an Alpaca account is acceptable and the stock/crypto scope is useful. It is less attractive for Sentinel’s current WTICO/USD, XAU/USD, and other macro/commodity instruments.
4. **Use IBKR only if the existing deployment already depends on IBKR/TWS**. It is cheap at the retail tier but has the most integration friction.

### Adapter shape

Add a `benzinga` provider beside the existing NewsAPI.ai and GNews providers. Keep the provider additive: union Benzinga with the free stack and existing paid providers, then let the current canonical URL/title deduplication choose the richer copy.

Suggested normalized mapping:

```text
providerItemId <- benzinga id (or Massive benzinga_id)
provider       <- "benzinga" / "massive-benzinga" / "alpaca-benzinga"
source         <- author or "Benzinga"
title          <- title / headline
summary        <- teaser, falling back to a short body extraction
timeIso        <- published/created, preferring published
url            <- url
themes         <- channels + tags
instrument     <- Sentinel instrument whose query/ticker/topic matched
```

The existing `news` cache and `news_provider_observations` tables already have the right shape for this. The provider state table can carry the provider’s request count, last success, circuit breaker, and provenance without a new schema. Add a provider-specific watermark (`updatedSince` or last ID) if the chosen API’s delta semantics require it; do not use the current `fetched_at` value as a content watermark because a successful empty poll must still advance the poll marker.

### Query strategy for current instruments

Sentinel’s existing instruments are primarily FX, commodities, and indices, so a ticker-only news integration would be incomplete. Massive’s core Economy API is a separate macroeconomic time-series surface; it is not the same product as Benzinga News. Use two paths:

- For equity-linked instruments, map the instrument to one or more Benzinga tickers and request only those symbols.
- For WTICO/USD, gold, silver, natural gas, platinum, and broad macro instruments, first verify that the licensed Massive Benzinga dataset actually returns relevant non-equity stories. If it does, use its channels/tags/topics and apply the existing instrument query and escalation lexicon locally; otherwise retain the free macro sources or use a direct Benzinga quote.

Do not fabricate ticker mappings. Keep them explicit in `config/instruments.yaml`, just as Sentinel currently requires a committed sentinel query. A Benzinga item with no related ticker should only be assigned to an instrument when the configured topic query matched it.

### Operational defaults

- Start in `shadow` mode for 7–14 days: fetch and record Benzinga observations, but do not add stories to decision context.
- Keep polling on-demand at decision points initially, matching the existing NewsAPI.ai/GNews cost-control design. Background polling should be opt-in.
- Use a provider-specific daily/monthly budget and circuit breaker. A 401/403 should pause the provider; a 429 should follow the provider’s actual quota semantics.
- Store provider provenance and the Benzinga article ID. Preserve the Benzinga URL; do not cache or expose full bodies unless the contract explicitly permits it.
- Benchmark against the current free stack on first-seen latency, unique relevant stories, duplicate rate, and escalation recall. The goal is to measure marginal signal quality, not headline count.

## Questions to ask Benzinga sales

- What is the monthly price for REST-only access to headline + teaser, without full-body redistribution?
- Is macroeconomics/commodity news included in the proposed Stock News API channel bundle?
- Are oil/OPEC/energy/geopolitical topics queryable without equity ticker association?
- What are the request limits, historical retention, and `updatedSince` guarantees?
- Does a single local Sentinel instance need a personal, professional, or institutional license?
- May Sentinel store titles, teasers, IDs, timestamps, and URLs in a local SQLite cache?
- Is TCP/WebSocket access priced separately from REST?
- Can Benzinga provide a trial key with production-quality data for a 7–14 day shadow benchmark?

## Sources

- [Benzinga Stock Market Newswire](https://www.benzinga.com/apis/cloud-product/stock-news-api/) — coverage, formats, delivery methods, article volumes, REST/TCP/RSS, and channel tailoring.
- [Benzinga News API overview](https://docs.benzinga.com/api-reference/news-api/overview) — Newsfeed scope and available endpoint families.
- [Benzinga Get News documentation](https://docs.benzinga.com/api-reference/news-api/get-news-items) — fields and filters.
- [Benzinga Quickstart](https://docs.benzinga.com/introduction/introduction) — sales contact, REST/TCP delivery, and `updatedSince` guidance.
- [Benzinga authentication](https://docs.benzinga.com/api-reference/authentication) — header and query-key authentication.
- [Massive real-time Benzinga News](https://massive.com/docs/rest/partners/benzinga/news) — endpoint, data shape, real-time access, and article filters; public response fields emphasize stock/crypto ticker associations.
- [Massive pricing](https://massive.com/pricing) — partner dataset price and business-pricing distinction.
- [Massive Economy API overview](https://massive.com/docs/rest/economy) — separate macroeconomic-data category, distinct from Benzinga News.
- [Alpaca historical news](https://docs.alpaca.markets/us/docs/historical-news-data) — Benzinga as the current news provider and historical scope.
- [Alpaca real-time news](https://docs.alpaca.markets/us/docs/streaming-real-time-news) — WebSocket schema and Benzinga source field.
- [Alpaca market-data pricing](https://alpaca.markets/data) — Free and $99/month Algo Trader Plus tiers.
- [Interactive Brokers research/news pricing](https://www.interactivebrokers.com/en/pricing/research-news-services.php) — $35 retail and $250 institutional Benzinga API access through TWS.
- [Benzinga Pro pricing](https://www.benzinga.com/pro/pricing/) — current end-user subscription prices.
