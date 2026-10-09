## flipdens32 result: FAIL. Recent flip density does not mark the good flips; where it matters, dense flips do better

Prereg: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077727960 (prereg.json sha256 `7f13023c`, fd32.py sha256 `7ec8df7a`, unchanged since). Development evidence only. 2023+ is a development window, not a holdout.

Reuse check: the frames were rebuilt with flipday30's functions. On all 12 frames (6 instruments x M5/M15) the post-07:00 subset equals the flipday30 trades exactly (day, gross, net).

### Primary: WTI M5, every flip at all hours, gross mean R on mid
Low = lowest-density quintile. D = low minus all. Holm over H per window, one-sided p(D > 0).

| H | window | all flips n, gross, net | low n | low gross [95% CI] | D_low [95% CI] | Holm p | low net | MDE80 |
|---|---|---|---|---|---|---|---|---|
| 1 h | 2018-22 | 7,385, -0.007, -0.257 | 6,150 | -0.002 [-0.037,+0.038] | +0.005 [-0.009,+0.019] | 0.64 | -0.254 | 0.019 |
| 1 h | 2023+ | 7,436, +0.013, -0.285 | 6,072 | -0.004 [-0.042,+0.031] | -0.017 [-0.034,-0.003] | 1.00 | -0.304 | 0.022 |
| 3 h | 2018-22 | same | 1,924 | -0.033 [-0.090,+0.030] | -0.026 [-0.078,+0.031] | 0.84 | -0.260 | 0.076 |
| 3 h | 2023+ | same | 1,935 | +0.017 [-0.053,+0.078] | +0.004 [-0.051,+0.057] | 1.00 | -0.267 | 0.077 |
| 6 h | 2018-22 | same | 2,510 | +0.012 [-0.053,+0.070] | +0.019 [-0.029,+0.061] | 0.64 | -0.252 | 0.068 |
| 6 h | 2023+ | same | 2,373 | +0.002 [-0.055,+0.060] | -0.012 [-0.059,+0.038] | 1.00 | -0.304 | 0.070 |

Verdict: FAIL. No H has a Holm-significant D_low in either window. Low-density gross means sit at -0.03..+0.02 R, the same as all flips.

Tie caveat (registered rule, ties go to the lower bin): for H = 1 h most flips have no flip in the prior hour, so the "low quintile" is 83% of flips and the other bins are empty except the top one. For H = 3 h the middle bin is empty. H = 6 h has five populated bins. The verdict does not depend on this: no H shows a positive edge.

### Key secondary: D_high, a "chop, skip this flip" veto
| H | 2018-22 high n, gross, D_high [95% CI] | 2023+ high n, gross, D_high [95% CI] |
|---|---|---|
| 1 h | 1,235, -0.033, -0.026 [-0.095,+0.044] | 1,364, +0.089, +0.076 [+0.013,+0.150] |
| 3 h | 796, +0.010, +0.017 [-0.074,+0.118] | 857, +0.157, +0.144 [+0.045,+0.233] |
| 6 h | 1,134, -0.055, -0.049 [-0.130,+0.024] | 1,115, +0.078, +0.065 [-0.021,+0.152] |

No veto. In 2018-22 the dense flips are slightly worse (CI spans 0). In 2023+ they are better, and for H = 1 h and 3 h the CI excludes 0 on the wrong side for a veto. Skipping dense flips would have cost money in 2023+.

### Time-of-day confound check (edges within UTC hour-of-day buckets)
Same picture. WTI M5: D_low H1 +0.021 [+0.001,+0.041] in 2018-22 (Holm p 0.057) but -0.022 [-0.045,+0.002] in 2023+; H3/H6 D_low span 0 in both windows. D_high in 2023+ is again positive: H1 +0.135 [+0.041,+0.230], H6 +0.094 [+0.012,+0.186]. The density effect is not a clock effect, and it does not favour low density.

### Other instruments and M15 (descriptive, 288 cells, no correction)
- 43 cells have a D CI that excludes 0. Only 1 of them is "low density earns more" (WTI M5 tod H1 2018-22, above, reversed in 2023+). 40 say low-density flips earn less or high-density flips earn more: XAU M15 H3/H6 (both windows for H6 low), XAG M15 H3 dev, SPX M5 H1 2023+, NATGAS M15 H1 dev, EUR M5 H3/H6 2023+.
- The only veto-direction cells are NATGAS M5 H6 2023+ (high -0.086, tod -0.098). In 2018-22 the same NATGAS tod H6 high bin is +0.091, so the sign flips across windows.
- Net (bid/ask): every low and high bin loses except SPX M15 H1 2018-22 high (+0.108, n 98, reversed to -0.168 gross in 2023+) (WTI M5 low -0.25..-0.30 R, high -0.20..-0.33 R). The spread cost is about 0.25-0.30 R per M5 flip and dominates any quintile difference.
- M1 not run: no flipday30 M1 frames exist.

### Power
WTI M5 MDE80 for D_low: 0.02 R (H1, large bin), 0.07-0.08 R (H3, H6). The flipday30 hindsight gap (+0.20..+0.43 R on quiet days) is about 3 to 20 times larger than these MDEs. A causal density effect of that size would have been found.

### Reading
The flipday30 hindsight result comes from flips AFTER the trade, not before it. A flip that is followed by more flips is stopped out by the next opposite flip (exit rule), so realized chop and losses are partly the same event. The count of flips in the 1-6 hours before entry carries none of that. If anything, recent flip activity marks active markets where a new flip follows through more often (WTI, XAU, SPX in 2023+). That lean is not stable across windows and is no basis for a filter.

### Files (data/research/engine/audit/flipdens32/)
- `fd32.py` (check, register, build, run), `summarize.py`, `prereg.json`, `prereg_comment.md`, `result_comment.md`
- `out/f_<INST>_<TF>.pkl` (every flip trade with c_H, x_H), `out/results.json`, `out/report.txt`, `out/run.log`, `out/build_<INST>.log`
- `trials.jsonl`: 73 rows, exp `flipdens32` (72 cells + primary verdict)
