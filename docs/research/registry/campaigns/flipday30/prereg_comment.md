## flipday30 preregistration: predict flips per day at 07:00 UTC, trade flips only on predicted low-flip days

This is registered before any outcome run. Nothing was computed on market data before the prereg. Only synthetic self-checks ran.

Operator hypothesis: on days with few supertrend flips (trend days) each flip rides far; on days with many flips (chop) every flip loses. If the flip count can be predicted in the morning, trading flips only on predicted low-flip days could have an edge.

Files:
- `data/research/engine/audit/flipday30/prereg.json` sha256 `2d83770718a3d4f3db922a8e364e8e97966237d691efead6f5f25790bdaa48c7`
- `data/research/engine/audit/flipday30/fd30.py` sha256 `743e5097aa3af3b8094912fddaceedfe29612ef35042bd12519634236089c1ba`
- Evaluator v2, digest `1b66053d`. The trade rule, supertrend and bootstrap are imported unchanged (`nt12.frame`, `labels_v2.simulate`, `x_recompute.mid`, `validate.day_boot`).

### Trade rule (reused, unchanged)
- Population: every supertrend flip (production supertrend, ATR 10, as in `flips.mjs`), as in notrade12 `M5_flip_all` / `M15_flip_all` and the rescan26 gross re-scoring.
- Management: `labels_v2.simulate` POLICY k=1.5, m=1.0, T=3.0, H=72. Entry at the next bar open. Stop 1 R, breakeven at +1 R, target 3 R. Exit at the next open after an opposite flip. Time stop 72 bars.
- Gross = the same trade on mid bars (primary). Net = bid/ask (secondary).

### Day, decision time, outcome
- Trading day = `validate.day_of` (22:00 UTC rollover). Valid day: bar count >= 50% of the median per-day bar count, and at least one bar after 07:00.
- Decision time 07:00 UTC. Flips on bars that close at or before 07:00 are features. Flips on bars that close after 07:00 are counted for the outcome and traded.
- Outcome count: number of flips after 07:00 in the trading day.

### Model
- M0 (primary): Poisson GLM, 4 coefficients: log1p(yesterday's full-day flip count), log1p(flips up to 07:00 today), log1p(median full-day flip count of the previous 20 valid days).
- M1 (secondary): M0 plus logit of the abs11 A1 P(big day) at the latest 30-min close at or before 07:00 (walk-forward OOS, `lean21.alert_rows`; a day that already crossed T1 counts as P = 1).
- Refit at the start of each calendar month on all strictly earlier valid days (expanding). The first fit needs 250 training days.
- Predicted quintile: edges = 20/40/60/80% quantiles of the new model's fitted values on its last 250 training days. Past days only.

### Statistics
- Instruments: WTI, XAU, XAG, NATGAS, SPX500, EUR/USD. M5 primary, M15 secondary.
- Windows: dev 2018-2022 (effective start after the 250-day burn-in); 2023+ to 2026-10-07. 2023+ is a development window, not a holdout.
- Step 1 (descriptive): Spearman rank correlation of the predicted vs the realized post-07:00 flip count, per window and per single feature. HINDSIGHT check (not a policy): gross mean R per flip by realized flip-count quintile.
- Step 2 (primary): WTI M5 M0. D = gross mean R per flip on lowest-predicted-quintile days minus the gross mean R of all scored post-07:00 flips. Day-block bootstrap (`validate.day_boot`, block 5, 1000 reps, seed 30).
- PASS iff in BOTH dev and 2023+: the 95% CI of D lies above 0, AND the lowest-quintile gross mean R is above 0 with its CI lower bound above 0. Otherwise FAIL.
- Secondary (descriptive): highest predicted quintile (does predicted chop lose more?), gross and net by quintile, trades per day, MDE80 of D, all six instruments, M15, and M1 with A1.

Development evidence only. Any survivor is confirmed only by prospective data (https://github.com/mfittko/market-signals/issues/313) or by data after 2026-10-07.
