## scan46 result: FAIL, no cell survives the Deflated Sharpe hurdle; zero finalists; the locked holdout stays unopened

Prereg: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084497493 (code sha `de490de6...`, checked by `run`).

### Finalists (frozen)
None. Step 2 (DSR > 0.95 on discovery) kept 0 of 3,030 class cells, so steps 3 to 6 had nothing to test. Per the prereg, zero survivors means FAIL with no locked test. `audit/swing44/daily.db` was not opened and the intraday 2024+ window was not built. Both stay locked for a later preregistered test. This comment is also the finalists comment (the frozen list is empty, `out/finalists.json`).

### Trial counts
- 303 parameter sets in 27 families per timeframe; 909 parameter-set x timeframe combinations.
- Class cells (DSR trials): daily 1,212 (4 classes), H4 909, H1 909 (3 classes each); 3,030 in total.
- Instrument cells: daily 9,999 (33 markets), H4 5,151, H1 5,151 (17 instruments); 20,301 in total.
- `trials.jsonl` rows appended: 23,331 (exp `scan46`).

### DSR hurdle and the best cells (annualized net Sharpe)
| TF | N | SR0 (hurdle) | best discovery cell | disc | val | max DSR |
|---|---|---|---|---|---|---|
| D | 1,212 | 1.35 | keltner_breakout(n=20, mult=2.0), commodities | +0.67 | +0.39 | 0.005 |
| H4 | 909 | 2.16 | donchian(n=100, exit_frac=1.0), commodities | +1.03 | -0.14 | 0.013 |
| H1 | 909 | 6.31 | bb_breakout(n=50, k=2.5, exit=mid), commodities | +0.64 | -1.02 | ~0 |

The registered V (cross-trial variance of Sharpe) includes many cost-dominated negative cells, which inflates the hurdle, most of all on H1. POST-HOC (never decides): with V from the positive cells only and N = families x classes (108 / 81), the hurdle falls to 0.34 (D), 0.66 (H4) and 0.39 (H1), and still no cell reaches DSR 0.95 (max 0.89 D, 0.77 H4, 0.70 H1). The verdict does not depend on that choice.

### Overfitting illustration
| TF | class cells with naive one-sided p < 0.05 | after DSR | naive p < 0.05 on the wrong side | instrument cells naive p < 0.05 (approx.) |
|---|---|---|---|---|
| D | 15 of 1,212 | 0 | 646 | 163 of 9,999 |
| H4 | 7 of 909 | 0 | 257 | 75 of 5,151 |
| H1 | 0 of 909 | 0 | 524 | 16 of 5,151 |

22 class cells and 254 instrument cells look significant at face value; none survives the trial correction. Many more cells are significantly negative after costs: median discovery net Sharpe is -0.47 (D), -0.46 (H4), -1.06 (H1). Only 22% (D), 15% (H4) and 2% (H1) of class cells are positive on discovery.

### Shrinkage (discovery vs validation)
- D: Spearman rho +0.49; top 10 discovery cells average +0.54 discovery, +0.40 validation (all 10 positive), but -0.04 in 2023+ (6 of 10 negative). Nine of the top 10 are commodity trend breakouts (Keltner, Bollinger, Aroon, CCI trend). The same theme as the ext39 commodity continuation, and it fades after 2022.
- H4: rho +0.13; top 10 +0.91 discovery, -0.57 validation (0 of 10 positive). Full reversal.
- H1: rho +0.73, driven by costs (high-turnover rules lose in both windows); top 10 +0.30 discovery, -0.36 validation.
- Instrument cells: rho +0.23 (D), -0.02 (H4), +0.46 (H1).

### swing44 reference rule
`consec_pullback(down=3)` on the 8 daily indices (next-open fill, net, inverse-vol pooled): discovery +0.52 (rank 1 of 303 index cells, 7 of 1,212 daily cells, naive PSR 0.97, DSR 0.001), validation +0.12 (rank 43), 2023+ +0.66 (rank 10). It is the best daily index rule in the library, but its Sharpe of about 0.5 is far below the hurdle that 1,212 trials impose.

### Reading
No classic chart strategy in this library has a net edge strong enough to stand out from 3,030 tries. The best Sharpe values (0.5 to 1.0) are what the best of about a thousand zero-skill trials produces by chance. The few that hold into validation (daily commodity breakouts, the index pullback) are weak (about 0.4 to 0.5) and do not hold in 2023+ for commodities. The scan supports the earlier campaigns: the index pullback stays a prospective candidate only, and there is no new rule to track.

### Files
- `audit/scan46/scan46.py` (check, describe, grid, register, run, locked), `report.py`, `posthoc.py` (POST-HOC), `prereg.json`, `prereg_body.json`, `prereg_comment.md`, `result_comment.md`
- `audit/scan46/out/`: `cells.parquet` (3,030 class cells with DSR), `finalists.json` (empty), `report.json`, `posthoc.json`, `describe.json`, `grid.txt`, `run.log`, `cache/` (M1 mid OHLC per instrument)
