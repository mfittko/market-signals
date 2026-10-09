## news24 preregistration: news-backed strong candles vs the same candles without news

Registered before any outcome run. File: `data/research/engine/audit/news24/prereg.json` (sha256 prefix `f2244ff187d7d502`). Code hashes are in the file.

**Question.** A strong M5 candle with a tick-volume spike: does it continue more often when a burst of relevant news coincides with it? Earlier candle-only tests averaged all big moves and found chance.

**Feasibility.** GDELT 2.0 GKG is 1.54 TB for 2019 on (268k 15-min files). The full series is about 5-7 days of serial download. I fetch only what the test needs: a 4-hourly baseline grid plus the two 15-min files before each event candidate. That is about 39.7k files, about 200 GB transferred and about 15 h serial (0.5 s delay, md5-checked, resume-safe). Rows are filtered in memory. The kept store is per-file counts plus matched rows, estimated at 9 GB. The DOC 2.0 API gives 15-min timelines only for spans of 1 day or less and rate-limits hard. The Events export has no themes.

**Relevance.** `relevance.json`: GKG themes, organizations, persons, URL words and an optional country filter per instrument (oil: ENV_OIL, ECON_OILPRICE, OPEC, conflict themes in producer countries; gold/silver: gold/silver themes, Fed, armed conflict; EUR/USD: ECB, Fed, eurozone inflation/rates; SPX: Fed, US macro, stock market; natgas: natural gas, LNG, US weather).

**Lookahead guard.** A GDELT file is used for a bar only if its file timestamp is at or before the bar close. Asserted in code. Live availability lags a few minutes behind this rule.

**Event.** M5 |body| >= 1.5 ATR14 (previous bar) and log tick-volume z >= 2.0 against the same UTC slot over the prior 20 days. 60-min cooldown. Spread <= 0.2 R. From 2019-01-01. M1 and M15 are secondary.

**NEWS / CONTROL.** Relevant share of all GKG rows in the two newest files with timestamp <= close, as a z-score against the 4-hourly grid of the prior 14 days. NEWS: z >= 2.0 and at least 5 relevant articles. CONTROL: the same events without that. Events with missing news files are excluded and counted.

**Outcome.** Entry at the next bar open in the event direction, bid/ask fills. Harness stop: R = 1.5 ATR14, stop -1 R, breakeven after +1 R, target +3 R, time exit after 3, 6 or 12 bars. No flip exit. Continuation rate = share of net R > 0.

**Stats.** Day-block bootstrap, block 5, 1000 reps, seed 24. Windows: dev 2019-2022 and 2023+. 2023+ is a development window, not a holdout.

**Decision (WTI M5, 6 bars).** PASS if the NEWS mean net R CI lies above 0 in both windows AND the NEWS minus CONTROL CI lies above 0 in both windows. LEAD if only part of this holds, or the PASS pattern appears in another instrument (secondary). REJECT otherwise. Cells with fewer than 30 NEWS events are flagged as underpowered.
