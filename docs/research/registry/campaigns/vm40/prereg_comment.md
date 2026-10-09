## vm40 preregistration: volatility-managed long-only index exposure vs buy-and-hold

This is registered before any outcome run. Only synthetic self-checks, day counts and a list of |daily return| > 10% dates ran. No strategy return, Sharpe ratio or weight average was computed on real data.

Question: does scaling long index exposure inversely to recent realized variance raise the Sharpe ratio over buy-and-hold? Moreira and Muir 2017 ("Volatility-Managed Portfolios", Journal of Finance) report that it does for the US market. Cederburg et al. 2020 find the out-of-sample gains unreliable. This matters for a move of multi-day exposure from CFDs to unleveraged ETFs.

Files:
- `data/research/engine/audit/vm40/prereg.json` sha256 `ef8b532fb74e3e36ef9ebde4e4fc6331dd6129f92ac4f567e0863539af0eb90f`
- `data/research/engine/audit/vm40/vm40.py` sha256 `b14418a64ab8f8803e85a7fe53d6f16cf257b59c409b975fd361fa3029086d1c`
- Data: `audit/tsmom36/daily.db` read-only (8 index CFDs, daily mid closes at 17:00 New York, weekend stubs dropped). Nothing fetched.

### Definitions
- r_t = close[t] / close[t-1] - 1. RV_t = mean of r^2 over the 21 own bars t-21..t-1 (known at the close of t-1).
- Buy-and-hold: weight 1 every day.
- Managed: w_t = min(c / RV_t, cap), return w_t x r_t, rebalanced daily at the close. PRIMARY cap 2.0. No cash rate and no financing for either strategy.
- Causal c (PRIMARY): c_t solves mean over all RVs known so far of min(c / RV_s, cap) = 1, expanding from the series start, after 250 RV values.
- Full-sample c (SECONDARY): one c per index over 2005-01-01..2026-10-08. This uses future data, as in the paper.
- Net (secondary): 1 bp per unit of daily turnover |w_t - w_{t-1}|.
- Sharpe: mean / std x sqrt(252), no risk-free rate.
- Windows by return date: dev 2005-01-01..2022-12-31; 2023-01-01..2026-10-08 is a development window, not a holdout.

### Primary test
- Cell: SPX500_USD, RV 21 days, cap 2.0, causal c, gross on mid.
- Statistic: Sharpe(managed) - Sharpe(buy-and-hold), annualized.
- CI: paired moving-block bootstrap of daily return pairs, 20-day blocks, 1000 reps, seed 40, percentile 95%.
- PASS if the CI lower bound is above 0 in BOTH windows. One test.

### Secondary (never decides)
Alpha of managed on buy-and-hold (OLS, intercept x 252) with CI, and beta; return, vol and max drawdown for both; turnover; cap 1.0 (no leverage, ETF-like); full-sample c; RV 10 and 63 days; net of costs; the other 7 indices; an equal-weight pool of all 8 (POOL8); yearly Sharpe differences; mean weight per window; MDE80. Grid of 432 rows, all logged to trials.jsonl.

### Power, stated before the run
SPX500 has 4,651 dev days and 975 days in 2023+. The SE of a Sharpe difference between two correlated strategies is about sqrt(2 (1 - rho) / years). With rho 0.7-0.8 the MDE80 is about 0.45-0.5 in dev and about 0.9-1.1 in 2023+. The published market-level gain is about 0.1-0.2 Sharpe. A FAIL is the expected outcome even if the published effect is real. The result will report the observed difference against MDE80.

### Known limits
CFD index levels are price indices except DE30 (total return). A 17:00 New York rebalance is not tradable at the mid for European and Asian indices. Development evidence only; a survivor needs prospective confirmation (https://github.com/mfittko/market-signals/issues/313) or data after 2026-10-07.
