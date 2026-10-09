# Open questions

This is the ranked research backlog. Each item names the question, why it is new, its prerequisites, its data needs and the observation that would end it. The ranking weighs three things: the strength of the external evidence, the fit with what our data has already ruled out, and the cost of the data.

Every item needs a registration before any outcome run. Write down: the mechanism, the new measurement, when it is available, why an effect might remain by the time we act, the minimum useful effect, the selection budget and the stop rule. This follows the external review of 2026-10-09 (https://github.com/mfittko/market-signals/issues/310#issuecomment-6084872152).

## Ranked backlog

| Rank | Question | Why | Prerequisites | Data needs | Stop rule |
|---|---|---|---|---|---|
| 1 | Forward test of the frozen daily index pullback | Strongest combined evidence: our data plus Baltussen et al. 2019 ([topics/daily-swing.md](topics/daily-swing.md)) | Freeze one disclosed version with its selection history; define return and tail-risk criteria first | Daily index closes going forward; ideally a futures or ETF leg beside the CFD to measure financing | Prospective return or tail criteria fail; no retrospective retuning. Tracked in https://github.com/mfittko/market-signals/issues/323 |
| 2 | EIA release surprise plus confirmed price response (WTI) | Our tests used article counts and fixed windows, never the surprise content ([topics/news.md](topics/news.md)) | A defensible as-of expectation source, or an honestly labelled own-model forecast error; an EIA schedule with exceptions | EIA report archive; consensus with timestamps; M1 bid/ask around releases | The effect is absorbed before a realistic entry, or adds nothing beyond the price-response baseline |
| 3 | Commodity carry on futures data | Replicated across studies; untestable on OANDA mids, which contain no roll yield ([topics/trend-and-carry.md](topics/trend-and-carry.md)) | Futures vehicle decision; side-specific financing if a CFD leg is kept | Databento front and second contracts for about 20 CME commodities, 2010 to the present (the survey estimates a few dollars) | Sharpe CI lower bound not above 0 over 2010-22, or not positive in 2023+, or not positive net of financing |
| 4 | Validate the scan46 Deflated Sharpe application on synthetic libraries | The H1 hurdle of 6.31 is unusually high; the review asks to check the method before another large campaign ([topics/methodology.md](topics/methodology.md)) | None | Synthetic strategy libraries with correlation and cost structure like the real one | The implementation reproduces known selection bias; the verdict stays FAIL either way |
| 5 | abs49: the A1 big-day alert at 4 alerts per month with quarterly trailing thresholds | abs48 passes recall and precision at 4 per month (not registered) and its frozen thresholds drift in 2023+ ([topics/volatility-and-big-days.md](topics/volatility-and-big-days.md)) | Register the operating point and threshold rule before outcomes; attention only, no entries | `history.db` M1 bid/ask; prospective days | Recall below 0.5 or precision below 2x base rate in either window |
| 6 | Volatility risk premium via monthly index put writing | Sharpe 0.65 vs 0.49 for SPX in 1986-2018 (Bondarenko 2019); not available on CFDs | Options vehicle; tail reporting for 2008, 2018 and 2020 | Cboe PUT index (free); T-bill and SPX series | Excess return over a beta-matched SPX and T-bill mix not positive in 2007-22 and 2023+ |
| 7 | Weekly residual short-term reversal in the top 500 US stocks | Net 30 to 50 bps per week in large caps with careful construction (de Groot, Huij and Zhou 2012) | Stock vehicle (Alpaca); market-neutral construction; 3 bps per side | Daily bars with delisted tickers (survivorship-free) | Net weekly return CI not above 0 in both windows |
| 8 | Sector and country ETF relative momentum, monthly | Cheap to trade; moderate evidence; weak practitioner out-of-sample record | UCITS alternatives if the account is in the EU (PRIIPs) | Monthly ETF closes for about 30 ETFs | Top-3 portfolio does not beat the equal-weight universe net of costs |
| 9 | Earnings announcement premium in large caps, t-5 to t-1 | Replicated globally (Savor and Wilson 2016) | A historical earnings calendar (gating item) | Calendar plus daily stock bars | Premium CI not above 0 net of costs |
| 10 | Weather-forecast revisions plus storage for natural gas | A physical mechanism outside the candles (external review, priority 3) | Archived operational forecasts as of each decision time; reforecasts do not count | NOAA GEFS operational archive; EIA storage | No incremental value beyond price and context, or unreliable as-of data |
| 11 | LLM as an auditable event-fact extractor | The review assigns LLMs measurement, not direction ([topics/llm-in-trading.md](topics/llm-in-trading.md)) | A reviewed extraction sample; deterministic checks of numeric fields | Event texts with first-available timestamps | Extraction accuracy too low, or facts add nothing after the observed price response |
| 12 | FX carry on CFD terms, G10, monthly | Expected to fail at 2.5% per leg; it closes the question cheaply | Side-specific OANDA financing | Local daily data | Net CI not above 0 |

## Dropped or blocked

| Question | Status | Reason |
|---|---|---|
| Order-book dynamics around flow29 | Lost its basis | flow29 did not replicate in flow42 ([topics/order-flow.md](topics/order-flow.md)) |
| Further chart-rule or threshold scans | Stopped | scan46 and roll47 found nothing; the review asks to stop |
| Re-testing news24 on the same history | Not allowed | The history is spent; only prospective WTI NEWS events could add evidence |
| PEAD, index reconstitution, crypto carry | Not planned | External evidence says the effects are gone or decayed ([sources.md](sources.md)) |
| Market making | Not planned | No retail rebates; limit13 measured adverse selection |
| The volatility-scaled stop (risk8 V1) | Lead only | Needs its own registration on prospective data |
| The SPX/NAS Monday regular-session long (season17, post-hoc) | Lead only | Would need its own registration |

<!-- campaign link definitions -->

