## tsmom36 result: FAIL. Diversified 12-month momentum is positive in both windows, but no CI clears 0

Preregistration: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078259026

Data: all 33 requested OANDA daily mid series were served (`audit/tsmom36/daily.db`). Starts: FX 2002-05 (NZD_USD 2002-09, AUD_JPY 2004-06), indices 2003-02..03 (AU200 2004-03), commodities 2003 (XPT 2005-01, XAU/XAG 2006-03), bonds 2003-03..06. Nothing was missing. Dev = 2005-01-01..2022-12-31 (28 eligible instruments in 2005, 33 from 2008). The second window 2023-01-01..2026-10-08 is development evidence, not a holdout.

### Primary: all 33, lookback 252, 40% target vol per instrument, cap 3x, monthly, gross mid
| window | days | gross ann. return | ann. vol | Sharpe [95% CI, 20-day blocks] | net Sharpe | max DD | MDE80 Sharpe |
|---|---|---|---|---|---|---|---|
| dev 2005-2022 | 4,680 | +3.4% | 13.5% | +0.25 [-0.18, +0.69] | -0.28 | -38% | 0.64 |
| 2023+ | 980 | +6.6% | 10.1% | +0.65 [-0.16, +1.73] | -0.07 | -11% | 1.35 |

Verdict: **FAIL**. The CI lower bound is below 0 in both windows.

- The point estimate is positive in both windows, and it fits the weaker post-2009 trend-following record. The test cannot separate it from 0. With 18 years the MDE80 is a Sharpe of 0.64. With 3.75 years in the second window it is 1.35. A true Sharpe of about 0.3-0.5 is undetectable here by construction.
- The dev years are uneven: 2007 +25%, 2008 +12%, 2013 +31%, 2014 +15%; 2011 -15%, 2012 -13%, 2016 -17%. 2023 -1%, 2024 +1%, 2025 +19%, 2026 YTD +6%.
- Net is negative in both windows. Spread cost is small (0.16-0.19% per year). The assumed 3% financing on absolute notional costs about 7% per year, because the average gross notional is about 2.3x equity. Most FX and bond positions sit at the 3x cap. Financing decides net, so a real CFD book would lose money on this design unless financing is far below 3%.
- Correlation with buy-and-hold SPX500: -0.00 in dev, +0.54 in 2023+ (the book was long equities in a rising market). Buy-and-hold SPX500 Sharpe: 0.43 dev, 1.34 2023+.

### Secondary (no verdict)
| cell | dev Sharpe [CI] | 2023+ Sharpe [CI] | net dev / 2023+ |
|---|---|---|---|
| lookback 63 | +0.13 [-0.30, +0.58] | -0.54 [-1.44, +0.38] | -0.40 / -1.30 |
| lookback 126 | +0.26 [-0.19, +0.73] | +0.19 [-0.76, +1.11] | -0.29 / -0.53 |
| blend 63/126/252 | +0.24 [-0.19, +0.71] | +0.13 [-0.74, +1.13] | -0.21 / -0.51 |
| FX (10), 252 | -0.08 [-0.51, +0.42] | -0.12 [-0.99, +0.74] | -0.60 / -0.92 |
| indices (8), 252 | +0.21 [-0.19, +0.68] | +0.80 [+0.03, +1.71] | -0.03 / +0.52 |
| commodities (11), 252 | +0.29 [-0.21, +0.78] | +0.43 [-0.44, +1.49] | +0.03 / +0.13 |
| bonds (4), 252 | +0.26 [-0.22, +0.67] | -0.21 [-1.15, +0.82] | -0.26 / -0.67 |
| our 6 instruments, 252 | +0.27 [-0.21, +0.72] | +0.89 [-0.01, +1.92] | -0.04 / +0.58 |
| our 6 instruments, 126 | +0.47 [+0.01, +0.94] | +0.68 [-0.37, +1.51] | +0.16 / +0.37 |

- Diversification did not help here. The 33-market book has a lower Sharpe than our 6 instruments alone in every lookback. FX has no trend premium in either window. Bonds earned in 2022 (+81% for the class) and little elsewhere.
- Our 6 instruments with lookback 126 are the closest match to mw6 B2 (120 days). Dev clears 0 just barely (+0.01). 2023+ does not. This agrees with mw6 and rescan26: positive, not significant with 20-day blocks.
- 2 of 48 logged cells have a CI above 0 (indices 252 in 2023+, our 6 with 126 in dev), and 2 have a CI below 0 (bonds 63 and FX 126 in 2023+). That is about what chance gives across 48 cells.

Files in `data/research/engine/audit/tsmom36/`: `fetch.py`, `daily.db`, `fetch.log`, `tsmom36.py`, `prereg_body.json`, `prereg.json`, `prereg_comment.md`, `out/describe.json`, `out/spreads.json`, `out/results.json` (all cells, yearly returns), `out/primary_daily.csv`, `out/run.log`, `result_comment.md`. 48 rows in `trials.jsonl` (exp `tsmom36`).
