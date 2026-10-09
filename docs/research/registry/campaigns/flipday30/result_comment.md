## flipday30 result: FAIL

Prereg: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077588331 (no amendments). Code and prereg unchanged since registration.

The hindsight part of the hypothesis is true: flips on days that end with few flips earn, and flips on days with many flips lose. The flip count cannot be predicted at 07:00 UTC, so the effect cannot be traded. The primary test fails in both windows.

### Step 1: how well the 07:00 model predicts the post-07:00 flip count (M5, model M0)
Spearman rank correlation of the predicted vs the realized post-07:00 flip count. Dev = 2019-02 to 2022 (after the 250-day burn-in), 2023+ to 2026-10-07.

| Instrument | rho dev | rho 2023+ | best single feature |
|---|---|---|---|
| WTI | +0.04 | +0.06 | 20-day median, +0.05 / +0.08 |
| XAU | +0.13 | -0.03 | 20-day median, +0.18 / -0.01 |
| XAG | +0.13 | +0.11 | 20-day median, +0.14 / +0.09 |
| NATGAS | +0.21 | +0.11 | 20-day median, +0.19 / +0.12 |
| SPX500 | -0.06 | -0.00 | none above 0.05 |
| EUR/USD | -0.02 | +0.07 | 20-day median, +0.02 / +0.10 |

M15 is similar (rho -0.06 to +0.11). Adding the A1 big-day probability (M1) changes rho by at most 0.09. Yesterday's count and the pre-07:00 count carry almost no information (|rho| <= 0.13). For WTI M5 the mean post-07:00 count by predicted quintile is 4.3 / 4.3 / 4.4 / 4.3 / 4.5 (dev) and 4.4 / 4.7 / 4.3 / 5.0 / 4.8 (2023+). The model does not separate days.

HINDSIGHT (not a policy): gross mean R per flip by realized post-07:00 flip-count quintile, M5.

| Instrument | window | Q1 (fewest) | Q2 | Q3 | Q4 | Q5 (most) |
|---|---|---|---|---|---|---|
| WTI | dev | +0.34 | +0.20 | +0.13 | +0.05 | -0.18 |
| WTI | 2023+ | +0.26 | +0.37 | +0.12 | +0.08 | -0.14 |
| XAU | dev | +0.26 | +0.17 | -0.04 | -0.05 | -0.24 |
| NATGAS | 2023+ | +0.43 | +0.21 | +0.14 | -0.04 | -0.14 |
| SPX500 | dev | +0.39 | +0.14 | +0.08 | +0.04 | -0.14 |
| EUR/USD | dev | +0.35 | +0.06 | -0.05 | -0.11 | -0.20 |

In every instrument, timeframe and window the fewest-flip quintile is positive and the most-flip quintile is negative and the lowest. (M15 counts have ties, so some quintiles are empty.) Part of it is mechanical: the trade exits on the next opposite flip, so a day with many flips cuts every trade short. The pattern is exactly what the operator sees on a chart, and it exists only after the day is over.

### Step 2 (primary): WTI M5, model M0, gross R per flip after 07:00

| Window | all flips: n, gross | lowest predicted quintile: n, gross [CI] | D = Q1 minus all [CI] | Q1 net [CI] | MDE80 of D |
|---|---|---|---|---|---|
| dev 2019-02..2022 | 4,421, +0.014 | 847, +0.030 [-0.059, +0.122] | +0.017 [-0.063, +0.100] | -0.121 [-0.213, -0.029] | 0.12 R |
| 2023+ | 4,512, +0.028 | 1,001, +0.106 [+0.009, +0.200] | +0.078 [-0.002, +0.164] | -0.117 [-0.193, -0.025] | 0.12 R |

Verdict: FAIL. CI(D) includes 0 in both windows. The Q1 gross CI includes 0 in dev. Net is negative in every quintile (all flips net -0.15 R in both windows).

Highest predicted quintile (predicted chop), WTI M5: gross -0.057 [-0.143, +0.038] dev, -0.022 [-0.098, +0.061] 2023+; Q5 minus all -0.070 [-0.151, +0.018] and -0.049 [-0.120, +0.025]. The sign agrees with the hypothesis in both windows, but no CI excludes 0. Trades per day: 4.4 (dev), 4.7 (2023+).

### Secondary highlights
- No other instrument or timeframe has CI(D) above 0 in both windows. Only two cells have a D CI above 0 in one window: SPX500 M15 M1 2023+ (D +0.15 [+0.04, +0.27], dev +0.004) and XAU M15 M1 dev for Q5 (+0.18, wrong direction). That is 4 of 96 window tests (Q1 and Q5, 48 cells) with a CI off 0, two in each direction, which is about the false-positive rate.
- Q1 has a CI below 0 in XAU M15 M0 dev (-0.16) and XAG M5 M1 dev (-0.09). The lowest predicted quintile is not consistently better.
- Net R is negative for nearly every quintile on every instrument (XAG and NATGAS M5 -0.3 to -1.1 R). Low-flip prediction does not fix costs.
- The A1 big-day probability (M1) adds nothing: WTI M5 M1 D +0.032 dev, +0.034 2023+, both CIs span 0.
- Power: MDE80 of D is 0.10-0.14 R on M5 and 0.15-0.25 R on M15. The hindsight gap between realized Q1 and all flips is about 0.3 R, so an effect of that size would be detected. The predicted gap is small because the predictor carries almost no information.

### Reading
Flip-count days are real in hindsight but unpredictable at the open from counts and the A1 probability. The flip count is mostly made by what happens after 07:00. This joins daytype14 (trend/range day classifier) and wave23 (flips on A1-armed days) as a rejected route to a day-level flip filter. Development evidence only.

Files (in `data/research/engine/audit/flipday30/`): `fd30.py`, `prereg.json`, `prereg_comment.md`, `summarize.py`, `out/results.json`, `out/report.txt`, `out/b_<INST>_<TF>.pkl`, `out/a1_<INST>.pkl`, `out/build.log`, `out/run.log`. Trials in `engine/trials.jsonl` (exp flipday30, 24 cells + PRIMARY).
