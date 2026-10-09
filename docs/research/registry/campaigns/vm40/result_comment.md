## vm40 result: volatility-managed long-only index exposure vs buy-and-hold: FAIL

Prereg: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078627422 (code unchanged since registration, `vm40.py` sha256 `b14418a6...`).

### Primary: SPX500, RV 21 days, cap 2.0, causal c, gross on mid

| Window | Days | B&H return / vol / Sharpe | Managed return / vol / Sharpe | Sharpe diff [95% CI] | Max DD B&H / managed | MDE80 |
|---|---|---|---|---|---|---|
| dev 2005-2022 | 4,651 | +8.2% / 19.5% / +0.42 | +6.0% / 12.8% / +0.47 | +0.05 [-0.31, +0.40] | -56.9% / -22.2% | 0.49 |
| 2023-01..2026-10 | 975 | +19.3% / 14.5% / +1.32 | +11.2% / 13.8% / +0.81 | -0.51 [-1.08, +0.07] | -18.9% / -16.7% | 0.83 |

Verdict: FAIL. The dev CI spans 0 and the 2023+ point estimate is negative. Mean managed weight 0.96 dev, 1.02 2023+. Turnover 12.8 and 16.6 units a year; 1 bp per unit costs about 0.2% a year and does not change the picture (net diff +0.04 dev, -0.52 2023+).

### Secondary (never decides)
- Alpha on buy-and-hold (paper regression): +2.7% a year [-1.6%, +6.9%] dev, beta 0.40; -3.6% [-12.2%, +4.5%] 2023+, beta 0.77. The dev alpha has the published sign but its CI spans 0.
- Drawdown is the one clear difference. The managed dev max drawdown is -22% vs -57% for buy-and-hold, because the weight fell to 0.22 on average in 2008 and 0.29 in 2022. The return also falls (+6.0% vs +8.2%), so the Sharpe ratio barely moves.
- Full-sample c (uses future data): +0.02 [-0.33, +0.38] dev, -0.51 [-1.08, +0.07] 2023+. Same picture.
- RV 10 days: +0.11 [-0.26, +0.46] dev, -0.54 [-1.18, +0.06] 2023+. RV 63 days: +0.03 [-0.28, +0.34] dev, -0.49 [-0.92, -0.06] 2023+ (CI below 0).
- Other indices, primary settings, dev / 2023+ diff: NAS100 +0.06 / -0.20, US30 +0.04 / -0.43, DE30 -0.04 / -0.30, UK100 -0.32 [-0.65, -0.02] / -0.14, JP225 +0.05 / +0.03, AU200 -0.11 / -0.29, HK33 -0.00 / -0.02. POOL8 (per-date mean of the 8): -0.00 [-0.29, +0.34] dev, -0.19 [-0.65, +0.23] 2023+; max DD -52.8% / -23.1% dev.
- Grid: 0 of 432 rows have a Sharpe-diff CI above 0. 16 rows have it below 0 (SPX RV 63 in 2023+, UK100 RV 21 dev, AU200 RV 10 and 63 in 2023+, one POOL8 row).
- Yearly SPX diff: managed is ahead in 4 of 22 years (2006 +0.42, 2010 +0.34, 2018 +0.48, 2020 +0.54). It is behind in 2008 (-0.66) and 2022 (-0.59) despite the smaller losses, and in every year 2023-2026 (-0.35, -0.56, -0.63, -0.85). The rule cuts exposure after volatility spikes and misses the fast rebounds (full-year sums of daily returns: 2009 +6.0% vs +25.5%; 2025, after the April crash, +3.4% vs +16.8%).
- Power: MDE80 0.49 dev, 0.83 2023+. The published gain (about 0.1-0.2 Sharpe) is below both, as stated before the run. The 2023+ estimate (-0.51) is large and negative, so the data lean against the rule rather than being merely silent.

### Cap 1.0 (unleveraged ETF variant): degenerate as registered
With cap 1.0 and a mean weight of 1, the only solution is w = 1 every day. The registered cap-1.0 rows therefore equal buy-and-hold exactly (diff 0.00, turnover 0). This is a design error in the preregistration, reported as is.

POST-HOC (after the run, never decides): cap 1.0 with a causal target mean weight T below 1, cash earning 0.
- T 0.75, SPX: Sharpe diff +0.13 [-0.15, +0.44] dev, -0.21 [-0.61, +0.18] 2023+; mean weight 0.70 / 0.84; max DD -18.7% vs -56.9% (a constant 0.75 weight: -45.8%); return +5.2% vs +6.1% for the constant 0.75 weight in dev, +12.1% vs +14.5% in 2023+. POOL8: +0.05 dev, -0.07 2023+.
- T 0.5 is the primary cell scaled by one half (min(c/RV, 2) / 2 = min((c/2)/RV, 1)), so its Sharpe diff is identical.

### Reading for the operator
Volatility management does not raise the Sharpe ratio of these indices in either window. It reliably cuts the deepest drawdowns (2008, 2020, 2022) and costs return in calm rising markets. For an unleveraged ETF holding it works as a drawdown limiter that gives up return against a constant exposure with the same average weight: about 0.9% a year in dev (at 9.6% vs 14.6% vol) and about 2.4% a year in 2023+ (at equal vol). It is not a reliable Sharpe improvement.

### Files
- `data/research/engine/audit/vm40/vm40.py` (registered code), `prereg.json`, `prereg_body.json`, `prereg_comment.md`
- `data/research/engine/audit/vm40/out/results.json` (all 432 cells, yearly, mean weights)
- `data/research/engine/audit/vm40/posthoc.py`, `out/posthoc.json` (POST-HOC cap-1 targets, CI-below-0 list)
- `data/research/engine/audit/vm40/summarize.py`, `result_comment.md`
- `data/research/engine/trials.jsonl`: 432 registered rows plus 8 post-hoc rows, exp `vm40`
