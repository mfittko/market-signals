## Evaluator audit v1 (development diagnostics; no frozen variant re-scored)

Addresses the [evaluator-audit addendum](https://github.com/mfittko/market-signals/issues/308#issuecomment-6047337937). Artifacts: `data/research/engine/audit/v1/` (controls, fixtures, ambiguity, calibration trace, layers, lineage, 760-run control registry, code hashes). Recorded verdicts on https://github.com/mfittko/market-signals/issues/309 and https://github.com/mfittko/market-signals/issues/310 are unchanged.

### Dispositions
| Concern | Disposition |
|---|---|
| False qualification (null, hidden-drift null) | Ruled out at tested sizes: 0/40 each for LR and HGB (Wilson upper 0.09) |
| Sensitivity near the 0.05 R minimum useful effect | **Confirmed design defect: E has almost no power** (not an implementation bug) |
| Signal confined to a subset | **Confirmed design defect:** never qualifies, even with the true planted driver as score (0/200); threshold rule needs >=30 trades at one p in one quarter |
| Nonlinear comparator (HGB vs LR) | Unresolved (interaction AUC 0.535 vs 0.541; small fit windows) |
| XAU "backwards calibration" | Implementation inversion ruled out (class order, feature order/scaling, signs, calibrator fit data, label maturity all pass). Empirical reversal: the 2022 Q3 calibration window had raw AUC 0.455 and an unconstrained Platt slope of -0.61, which inverted ranking on test. No disposition effect: every raw-score quintile on test is net negative |
| Spread accounting, fill timing, stop ordering | Ruled out: 15/15 fixtures pass (bid 100.00 / ask 100.10 round trip loses exactly 0.10); an independent simulator matches on 6000 random paths and every real A-D trade |
| Intrabar ordering | Ambiguity 0.2-0.5% of trades; pessimistic, admissible-optimistic and M1-resolved R/trade agree within 0.002; no disposition can change |
| Reproducibility | Confirmed: all published A-D numbers reproduce exactly |
| Holdout lineage | **Confirmed dependence:** D-E preregistration followed the A-C test look by 10 minutes and carried the spread rule. 2023-01-01..2026-10-07 has 8 frozen looks on WTI and 5 on XAU with no joint correction. It is development evidence from now on |

### Confirmed defects (not rerun; corrections get a new code version)
- **D1** `labels.py` optimistic bound admits impossible paths (milestone and stop0 in one bar). Bound fields only (A: -0.281 vs admissible -0.285). Regression fixture F8.
- **D2** WTI E was never fitted (15 calibration rows vs 100 required) but reported "rejected". Correct disposition: undefined / no support.
- **D3** Ledger records no code hash; `de.py` changed 2 s before the D-E test look (current version reproduces results exactly).
- **D4** (latent) freeze calls `e_fit` before its support guard.

### Power (planted drift on real WTI 2018-2022 M1 bid/ask, full unmodified pipeline, seeds 2001-2040)
| Planted economic value (R/trade) | Runs | LR qualified | HGB qualified | Oracle score qualified |
|---|---|---|---|---|
| 0-0.05 | 60 | 0 | 0 | 0 |
| 0.05-0.10 | 56 | 0 | 0 | 0 |
| 0.10-0.20 | 93 | 0 | 0 | 7.5% |
| 0.20-0.40 | 152 | 2% | 3% | 47% |
| > 0.40 | 187 | 18% | 24% | 46% |

Loss is dominated by the threshold stage, then the Bonferroni qualification rule and calibration; the learner is secondary.

### D on WTI, three layers (test window, development diagnostic)
Path predictability P(+1R before -1R) 0.490 vs null 0.497; gross conversion -0.020 vs +0.025; net -0.108 with cost 0.087 R/trade.

### Consequence
A negative or abstaining E result says little about learnable information. Before https://github.com/mfittko/market-signals/issues/310 compares new representations, E needs a registered redesign (longer/pooled calibration and threshold windows, a coverage rule that admits subset signals, a sign-constrained calibrator), validated against these controls. Evaluator code is frozen at the hashes in `audit/v1/out/code_hashes.txt`.
