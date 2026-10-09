## vol33 preregistration: extreme tick volume as climax or absorption

This is registered before any outcome run. Before the prereg, only synthetic self-checks and signal counts ran. No price after a signal bar was read.

Question: does an extreme tick-volume bar mark the end of a move? H1 tests a climax: a fast move whose last bar has extreme volume, traded against the run. H2 tests absorption: an extreme-volume bar with a small body and one long wick, traded in the direction of the rejection. Prior evidence: plain fades of fast moves lose before spread everywhere (fade31). Volume adds nothing on breakouts (sess25). A strong candle plus a volume spike earns about 0 R (news24 control group). CL order flow over 3 M5 bars reverses (flow29). Volume here is the OANDA tick count.

Files:
- `data/research/engine/audit/vol33/prereg.json` sha256 `71a690690802ae92c9d7d0ad695c6e777ae0df5ef43492bc7dfad5a3198f37d5`
- `data/research/engine/audit/vol33/vol33.py` sha256 `6130aa9732ab993e3b0af798477e29b6751097df73186f5a8a30f316fa702152`
- Reused unchanged: `updown.features` (the Python port of `nowMotion`), `labels_v2.simulate`, `fills.resolve`, `validate.day_boot`, and the news24 bar cache (history.db M1 bid/ask, resampled, production ATR 10). The prereg records the hashes.

### Definitions
- Volume ratio v: bar tick volume divided by the median volume of the same UTC time-of-day slot over the prior 20 trading days. The median needs at least 10 such bars. Otherwise the bar has no v and is skipped.
- Extreme thresholds: percentiles of v over all bars of the previous 250 trading days. The bar's own day is excluded, so there is no lookahead. At least 60 trading days of history are required. Early 2018 therefore uses a shorter expanding window.
- H1 climax: a fast move by the Now-line definition (run of same-direction closed mid bars capped at 6, |move| >= 1.5 ATR(10)). The signal bar is any fast bar whose own v is at or above the trailing 99th percentile. The trade goes against the run at the next bar open.
- H2 absorption: v at or above the trailing 98th percentile, and the mid body is at most 25% of the mid range. The trade goes long when the lower wick is longer and short when the upper wick is longer. The bar is skipped when the wicks differ by at most 10% of the longer wick. Entry is at the next bar open.

### Trade
- Stop 1.0 ATR(10) at the signal bar = 1 R. Target +1 R. Time exit at the close of bar 12 (the entry bar is bar 1). No flip exit. When the stop and the target touch in one bar, the stop counts first.
- Gross uses mid prices and is the primary measure. Net uses bid/ask fills.
- One open trade per instrument and strategy. A signal is skipped while the previous kept trade is open.

### Windows and test
- Windows: dev 2018-01-01 .. 2022-12-31 and 2023-01-01 .. the last cached bar (2026-10-07). The 2023+ window is a development window, not a holdout.
- PRIMARY: WTI M5, gross mean R per trade for H1 (top 1%) and H2 (top 2%). The CI comes from `validate.day_boot` over all trading days in the window (block 5, 1000 reps, seed 33). The one-sided p is the share of replicates at or below 0. Holm runs over the two hypotheses within each window.
- PASS if, for at least one hypothesis, the Holm-adjusted CI lower bound is above 0 in BOTH windows. The adjusted lower bound is the 1.25th percentile for the hypothesis with the smaller p and the 2.5th percentile for the other. The Holm-adjusted p must also be below 0.025. Otherwise FAIL.
- Signal counts before the one-trade filter, WTI M5 dev / 2023+: H1 1,326 / 1,318; H2 1,083 / 1,526; all fast bars 59,129 / 50,190.
- Secondary results never decide the verdict, and no multiplicity correction is claimed for them: net R with bid/ask; hit rate; M1 and M15; XAU, XAG, NATGAS, SPX500 and EUR/USD; H1 minus all fast-move fades (difference of gross means with a pooled day-block CI); thresholds top 0.5% and top 5%; MDE80 = 2.8 x bootstrap SD; event counts.
- H3 is side-free. Does v in the top 2% predict a larger range over the next 12 bars? The measure is the range (max mid high minus min mid low over bars i+1..i+12) divided by ATR. Spike bars are compared with bars at the same UTC hour whose v lies between the trailing 25th and 75th percentiles. H3 is reported as a ratio with a day-block CI, also at the top 0.5% and top 5%.

This is development evidence only. Any survivor needs prospective confirmation (https://github.com/mfittko/market-signals/issues/313) or data after 2026-10-07.
