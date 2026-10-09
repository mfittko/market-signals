## imom34 preregistration: market intraday momentum (overnight + first half hour -> last half hour)

This is registered before any outcome run. Only synthetic self-checks and valid-day counts ran. No return was read.

Hypothesis (published, untested here): Gao, Han, Li and Zhou (2018, Journal of Financial Economics, "Market intraday momentum") find that the S&P 500 return over the first half hour of the cash session plus the overnight return predicts the return over the last half hour. Similar effects are reported for other futures, including crude oil.

How imom34 differs from orb15 (queue row 15). orb15 mom30 traded the sign of the first 30 minutes into the last HOUR on M5 bars, scored net R with a spread rule, and had no overnight return. It was rejected (SPX gross -0.146 R dev, -0.033 R 2023+). That result is a negative prior for this test. imom34 runs the paper's rule instead:
- The predictor adds the overnight return.
- The position is held only for the last half hour.
- Prices are M1 mids at exact clock points.
- The primary is SPX500 alone, gross bps, with no spread rule.
- The 12th-half-hour predictor and regression slopes are reported.
- EUR/USD uses the NY session 08:00-17:00 ET (orb15 used London).

Files:
- `data/research/engine/audit/imom34/prereg.json` sha256 `b0246f106b0a451ea3db9d6ab2baf97f7cff7f9e4cd44d14f4621222d44cc687`
- `data/research/engine/audit/imom34/imom34.py` sha256 `726a7003aea5cf475c34b9b6f75b7065bfadfc58d29a5265277fe4b0ab92cb19`
- Reused unchanged: `validate.day_boot` (`validate.py` sha256 `cb1642ed...`) and the engine M1 bid/ask cache (history.db `candles_ba`), cut 2026-10-07 18:30 UTC.

### Definitions
- Clock: America/New_York, DST per calendar date. P(T) is the mid close of the M1 bar that starts at T-1 min. Mid is (bid + ask) / 2.
- Sessions (ET): SPX500 09:30-16:00 (primary). WTI and NATGAS 09:00-14:30. XAU and XAG 08:20-13:30. EUR/USD 08:00-17:00.
- r_on = P(open) / P(previous valid session close) - 1. The previous session must lie at most 5 calendar days back.
- r1 = P(open+30) / P(open) - 1. r12 = P(close-30) / P(close-60) - 1 (the paper's 12th half hour for SPX). y = P(close) / P(close-30) - 1.
- Valid day: Mon-Fri ET. The five price bars exist. At least 24 of 30 M1 bars are present in each of the first, second-to-last and last half hour. A previous valid close exists. Holidays and half days drop out by missing bars.
- Trade: s = sign(r_on + r1). Enter at close-30 in the direction of s and exit at close. Gross bps = s x y x 1e4.
- Net bps: a long buys at the ask and sells at the bid of the same M1 bars; a short does the reverse. The result is divided by the mid entry.
- R unit: the median |y| in bps over the previous 60 valid days of the instrument (at least 20 days). Gross R = gross bps / R.

### Test
- Windows: dev 2018-01-01 .. 2022-12-31 and 2023-01-01 .. 2026-10-07. The 2023+ window is a development window, not a holdout.
- PRIMARY: SPX500, s = sign(r_on + r1), gross mean bps per day with a position. The CI comes from `validate.day_boot` over all ET weekdays with session bars (block 5, 1000 reps, seed 34).
- PASS if the 95% CI lower bound is above 0 in BOTH windows. Otherwise FAIL. This is one test, so there is no multiplicity adjustment.
- Valid days dev / 2023+: SPX500 1,207 / 930; WTI 1,256 / 957; XAU 1,255 / 968; XAG 886 / 961; NATGAS 733 / 522; EUR/USD 960 / 632. EUR/USD loses many days because 16:30-17:00 ET is the daily rollover and is thin.
- Secondary results never decide the verdict: gross R, net bps, hit rate, always-long drift; signals sign(r1), sign(r12), and sign(r_on + r1) only when sign(r12) agrees; OLS slopes of y on (r_on, r1) and on (r_on, r1, r12) with day-block bootstrap CIs; |r1| in the top tercile and first-half-hour realized volatility in the top tercile (edges from the previous 250 valid days, at least 60); the other five instruments; MDE80 = 2.8 x bootstrap SD.

This is development evidence only. Any survivor needs prospective confirmation (https://github.com/mfittko/market-signals/issues/313) or data after 2026-10-07.
