## sess25 result: FAIL

The prereg was posted before this run: https://github.com/mfittko/market-signals/issues/310#issuecomment-6060988444. The code and prereg hashes are unchanged since registration. 2023+ is a development window, not a holdout.

### Primary: WTICO_USD, M5, HIGH-VOL, gross mean R at 6 bars
| event | window | n | gross R 6 bars [95% CI] | one-sided p | Holm p | pass |
|---|---|---|---|---|---|---|
| E1 asia | dev 2018-22 | 519 | +0.033 [-0.062, +0.131] | 0.245 | 0.490 | no |
| E1 asia | 2023+ | 241 | -0.029 [-0.170, +0.125] | 0.642 | 0.642 | no |
| E2 pday | dev 2018-22 | 362 | -0.016 [-0.120, +0.089] | 0.614 | 0.614 | no |
| E2 pday | 2023+ | 164 | +0.099 [-0.064, +0.304] | 0.115 | 0.230 | no |

Neither event passes, so the campaign verdict is FAIL.

### WTI M5, all horizons (gross R / continuation / net R)
| cell | window | n | gross 3 | gross 6 | gross 12 | cont 3/6/12 | net 3/6/12 |
|---|---|---|---|---|---|---|---|
| asia HIGH | dev | 519 | -0.016 | +0.033 | +0.090 | 0.44 / 0.44 / 0.41 | -0.21 / -0.16 / -0.11 |
| asia HIGH | 2023+ | 241 | +0.013 | -0.029 | -0.027 | 0.44 / 0.42 / 0.37 | -0.11 / -0.16 / -0.14 |
| asia QUIET | dev | 1282 | -0.044 | -0.038 | -0.015 | 0.44 / 0.43 / 0.37 | -0.26 / -0.25 / -0.24 |
| asia QUIET | 2023+ | 1180 | +0.023 | +0.010 | +0.064 | 0.50 / 0.46 / 0.41 | -0.16 / -0.18 / -0.14 |
| pday HIGH | dev | 362 | -0.011 | -0.016 | +0.002 | 0.44 / 0.44 / 0.42 | -0.19 / -0.19 / -0.17 |
| pday HIGH | 2023+ | 164 | +0.021 | +0.099 | +0.116 | 0.46 / 0.48 / 0.41 | -0.08 / -0.01 / -0.02 |
| pday QUIET | dev | 660 | -0.007 | +0.021 | -0.010 | 0.46 / 0.46 / 0.38 | -0.19 / -0.15 / -0.19 |
| pday QUIET | 2023+ | 631 | +0.019 | +0.019 | +0.028 | 0.50 / 0.46 / 0.40 | -0.15 / -0.14 / -0.11 |

Every WTI M5 gross CI contains 0, except asia QUIET dev at 3 bars, which is negative. HIGH-VOL minus QUIET at 6 bars:
- asia: dev +0.072 [-0.042, +0.198]; 2023+ -0.039 [-0.197, +0.127].
- pday: dev -0.036 [-0.181, +0.103]; 2023+ +0.079 [-0.105, +0.291].

### All instruments (descriptive)
- Gross R CI lower bound > 0 in BOTH windows: 1 of 144 checks (48 cells x 3 horizons). The cell is NATGAS M5 pday QUIET at 3 bars: +0.120 / +0.095 gross, about -0.57 net. One hit in 144 checks is below the chance rate.
- HIGH-VOL minus QUIET CI excludes 0 in 4 of 144 checks, and the signs are mixed (EUR M1 asia +, EUR M5 pday +, XAU M1 pday - twice). That is also below the chance rate. Volume at the break bar does not separate continuation from failure.
- WTI M1 (secondary): asia HIGH 2023+ is +0.124 [+0.005, +0.256] at 6 bars, but dev is +0.028 [-0.048, +0.103]. pday HIGH: +0.065 / +0.074, both CIs span 0.
- Net R is negative in nearly every cell. On M5 it ranges from -0.30 to +0.03 for WTI, XAU, EUR and SPX. M1 is worse. It reaches -0.5 to -0.7 for NATGAS and for XAG in dev.

Continuation means gross R > 0 after h bars with a 1.5 ATR stop. Rates fall between 0.29 and 0.58, apart from one cell with n 22. They sit below 0.5 even without an edge, because the stop closes paths that would later recover. The random-side null at 6 bars is the matched comparison, and the actual side beats it only sporadically.

### Base rates for a card line
`data/research/engine/audit/sess25/out/base_rates.json` has 48 keys of the form `<INST>_<TF>_<event>_<vol>`. Each key holds n and continuation at 3/6/12 bars [CI] over 2018-01-01 to 2026-10-07. NATGAS M1 asia has few events because M1 Asia-hour coverage is sparse, so the 80% coverage rule rejects most days.

### Files
- `audit/sess25/out/report.txt`: all cells.
- `out/results.json`, `out/base_rates.json`, `sess25.py`, `prereg.json`.

Development evidence only. Nothing qualifies. Session breakouts by themselves, with or without the tick-volume split, do not carry a gross direction edge at 15 to 60 minutes.
