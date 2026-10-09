## cal37 preregistration: calendar effects in 8 stock-index CFDs (turn of the month, pre-FOMC, pre-holiday)

This is registered before any outcome run. Only the FOMC date parse, synthetic self-checks and event counts ran. No return on real data was computed for any event or comparison.

Why: every intraday test failed (queue rows 1-35). tsmom36 (row 36) found daily trend following positive but underpowered. The operator prefers multi-day effects. Calendar effects need no forecasting model and have the longest literature record in stock indices.

Files:
- `data/research/engine/audit/cal37/prereg.json` sha256 `cea72b06af2dc4502b9fb1744e80543fb8413e4c03afbd2f02bd157fb2078238`
- `data/research/engine/audit/cal37/cal37.py` sha256 `8c678ec49413fd1b7e57bb325252b3f92dfa5aea657456d89ed1b78aa45eec74`
- `data/research/engine/audit/cal37/fomc_parse.py` sha256 `00c4cc603d30f7f34cbc222a26c86e2166361abb77cacdeb095bc08b115bc933`
- `data/research/engine/audit/cal37/fomc_dates.json` sha256 `a103a1ec1bbf3dbd950ff7153c18e34d6a7150c187b6bb6619dc52532d3ce5bb`

### Data
- `audit/tsmom36/daily.db`, read-only. OANDA daily mid bars that close at 17:00 New York. Trading date = bar close date. Saturday/Sunday stubs dropped, as in tsmom36. Data end 2026-10-08.
- Indices: SPX500, NAS100, US30, DE30, UK100, JP225, AU200, HK33.
- A trading day is a bar date in the index's own series. CFD bars exist on some exchange holidays (US July 4, Thanksgiving). Christmas and New Year bars are absent.

### FOMC dates
- Source: Federal Reserve calendars, https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm (2021-2026) and https://www.federalreserve.gov/monetarypolicy/fomchistorical2005.htm through fomchistorical2020.htm. Raw HTML is kept in `audit/cal37/fed_raw/`.
- Rule: scheduled meetings only. Statement date = last meeting day. Unscheduled meetings (2020-03-03, 2020-03-15), conference calls (e.g. 2008-01-22, 2008-10-08), notation votes and the cancelled 2020-03-17/18 meeting are excluded.
- 175 dates 2005-2026 (8 per year, 7 in 2020). The last two (2026-10-28, 2026-12-09) lie after the data end.

### US holidays
- Regular NYSE full-day holidays by rule: New Year (Sunday moves to Monday, Saturday not observed), MLK, Presidents, Good Friday, Memorial, Juneteenth (2022+), July 4, Labor, Thanksgiving, Christmas. Special closures (2007-01-02, 2012-10-29/30, 2018-12-05, 2025-01-09) are excluded.
- Pre-holiday day = the last weekday before the holiday that is not itself a holiday.
- Local exchange calendars for DE30, UK100, JP225, AU200, HK33 are not available here. H3 therefore uses US holidays only.

### Hypotheses (definitions fixed)
- H1 turn of the month (Lakonishok and Smidt 1988; McConnell and Xu 2008). TOM days are the last trading day of the month (-1) and the first three of the next (+1, +2, +3). The trade is long from the close of day -2 to the close of day +3, which is the four daily returns -1, +1, +2, +3. Statistic per index: mean daily return on TOM days minus the mean on all other days. PRIMARY: equal-weight mean of this difference over the 8 indices.
- H2 pre-FOMC drift (Lucca and Moench 2015). Event day = the bar whose close date is the statement date D. With 17:00 New York bars, this bar runs from 17:00 ET on D-1 to 17:00 ET on D. It holds 21 of the 24 hours of the Lucca-Moench window (14:00 ET D-1 to 14:00 ET D). It misses 14:00-17:00 ET on D-1. It includes the statement (14:00 ET, 14:15 ET before 2013) and 3 hours of reaction and press conference. The daily test is therefore a pre-plus-announcement-day test. PRIMARY: SPX500 event-day mean minus the mean of all other days.
- H2 exact window (secondary, 2018+): SPX500 M1 mid from history.db (read-only). Pre window = mid open of the 14:00 ET bar on the previous NYSE trading day to mid open of the 13:59 ET bar on D. Comparison: the same window on all other NYSE trading days. The post window 13:59-16:59 ET is reported.
- H3 pre-holiday. Event day = the bar whose close date is a US pre-holiday day. PRIMARY: SPX500 event-day mean minus the mean of all other days.

### Windows
- dev 2005-01-01..2022-12-31 (return dates).
- w2023 2023-01-01..2026-10-08. This is a second development window, not a holdout.

### Event counts (describe, no returns)
- H1: 216 turns dev, 47 w2023 per index.
- H2 SPX500/NAS100/US30: 143 dev, 30 w2023. H3 SPX500/NAS100/US30: 161 dev, 37 w2023.
- No FOMC or pre-holiday date lacks an SPX500 bar.

### Statistics and decision
- Block bootstrap by month: blocks resampled with replacement, 1000 reps, seed 37. Pooled statistics use the same block draw for all indices. H1 block = the turn month (day -1 of month m joins the block of month m+1, so each TOM window stays in one block). H2 and H3 block = calendar month. Percentile CIs.
- Two-sided bootstrap p = 2 x (min(#draws <= 0, #draws >= 0) + 1) / (B + 1).
- Holm over the three primaries within each window. The hypothesis at Holm rank k (k = 0 for the smallest p) gets the percentile CI at level 1 - 0.05 / (3 - k).
- PASS if, in BOTH windows, the Holm-adjusted p < 0.05 with a positive difference, i.e. the Holm-level CI lower bound is above 0. Otherwise FAIL. Only the three primaries decide.

### Net and secondary (never decide the verdict)
- Net per event: compound gross over the held days minus a round trip (2 x half the median M1 close spread from history.db candles_ba, all hours 2018+, the tsmom36 spreads; HK33 has none and gets 2 bps per side) minus financing of 3%/yr per calendar night held (an ASSUMPTION). Side costs: SPX500 0.47, NAS100 0.57, US30 0.34, DE30 0.63, UK100 1.05 bps; HK33 2.0.
- Annualized contribution if traded alone = mean net per event x events per year.
- Each index alone for H1, H2 and H3 (H2/H3 on non-US indices use the US dates). H1 by TOM day position. Yearly differences and the count of positive years. Power: MDE80 = 2.8 x bootstrap sd of the difference. SPX500 intraday pre-FOMC window. All cells go to `trials.jsonl` with exp `cal37`.
