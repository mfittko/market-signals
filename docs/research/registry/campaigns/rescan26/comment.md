## rescan26: gross re-scoring of existing campaigns (POST-HOC)

This is a post-hoc re-scoring of completed campaigns, so it has no new prereg. It follows the operator decision on spread:
- Direction signals are judged GROSS: mid fills, no spread.
- Entry is realistic: the next bar open after the signal is known.
- Net (bid/ask) is reported as a secondary figure.

2023+ is a development window, not a holdout.

### Method
- Campaigns that persisted per-trade gross were re-read: orb15, daytype14, season17.
- The other campaigns were recomputed with their own code, imported unchanged: pairs16, mw6, xvol9, xvol10, lean21, wave23, notrade12, the limit13 market baseline, and the evaluator-v2 entry sets (ladder A, de_v2 D, bench1, ablate4 P1/P2, risk8 base). The same entries were simulated on bars with bid = ask = mid. Entry selection (spread rules, confirmation) always uses the real bid/ask.
- Statistics: `validate.day_boot`, block 5, 1000 reps, seed 26.
- Windows: dev (2018-2022, or 2019-2022 where the campaign used that) and 2023+.
- HOLDS_GROSS: the gross mean R CI lower bound is > 0 in both windows.
- Holm runs across all checked rows. Its input is the one-sided normal p from the bootstrap SE, taking the larger p of the two windows. The bootstrap p has a floor of 1/1001, and Holm over 418 rows needs p < 0.00012.

### Totals
- Rows: 453. Rows checked (n >= 20 in both windows): 418.
- HOLDS_GROSS raw: 3 rows. After Holm: 0 rows.

| campaign | variant | unit | dev n | dev gross R [CI] | dev hit | dev net | 2023+ n | 2023+ gross R [CI] | 2023+ hit | 2023+ net | Holm p |
|---|---|---|---|---|---|---|---|---|---|---|---|
| mw6 | B2_tsmom120_h20 | POOLED | 6228 | +0.074 [+0.027, +0.121] | 0.514 | +0.008 | 5762 | +0.081 [+0.027, +0.136] | 0.515 | +0.018 | 0.81 |
| mw6 | B2_tsmom120_h20 | XAU/USD | 1037 | +0.140 [+0.007, +0.251] | 0.495 | +0.070 | 959 | +0.412 [+0.271, +0.544] | 0.617 | +0.353 | 1.00 |
| orb15 | orb15 | SPX500/USD | 1240 | +0.089 [+0.013, +0.168] | 0.397 | +0.041 | 933 | +0.098 [+0.003, +0.184] | 0.409 | +0.072 | 1.00 |

Caveats on the three raw survivors:
- mw6 holds daily tranches for 20 days, so the tranches overlap. With the campaign's own 20-day bootstrap block, neither mw6 row holds:
  - POOLED dev: [-0.010, +0.154].
  - XAU dev: [-0.073, +0.321].
- After that adjustment, orb15 SPX500/USD is the only raw survivor. It is one of 418 rows, and its CI lower bounds are close to 0 (+0.013 and +0.003). Under multiple testing this is the expected rate of chance hits.

### Pooled gross R at realistic entry, selected rows (dev / 2023+)
- orb15 orb15: +0.066 [+0.027, +0.107] / +0.017 [-0.031, +0.062]. orb30: +0.034 [+0.004, +0.069] / +0.017 [-0.021, +0.053].
- notrade12 M15 impulse (all): +0.036 [+0.010, +0.059] / +0.023 [-0.007, +0.058]. M5 flips (all): -0.025 / -0.018 (both CIs < 0).
- limit13 market baseline M15 impulse (filtered): +0.054 [+0.017, +0.083] / +0.021 [-0.019, +0.064].
- xvol9 K3 H1 M72: +0.090 [-0.023, +0.207] / -0.003. xvol10 confirmed, exit +10 min: +0.001 / -0.024.
- lean21 main H48: +0.168 [-0.028, +0.379] / +0.010. wave23 primary cells: dev -0.07 to -0.19.
- daytype14: all 8 variants have gross between -0.13 and +0.02.
- pairs16 pooled M15: +0.018 / -0.046.
- dev2 (WTI+XAU): flipsA -0.011 / +0.030; cfgX +0.007 / +0.032.

Several signals have a small positive gross edge in one window, mostly dev. None holds in both windows after multiplicity. The gross view does not reverse any earlier verdict. For spread-filtered intraday signals, the spread costs about 0.07-0.13 R per trade. Unfiltered streams cost more. No family's gross CI clears 0 in both windows.

### Coverage
- Not recomputed:
  - fm2 and ablate4 P3 (classification only, no trades);
  - ablate4 P3c, the bench1 E-stage selections, the risk8 stop/sizing overlays, lean22, and filter316 (live window only).
- limit13 passive fills have no defined gross. Its market baseline is reported instead.

### Files
- `data/research/engine/audit/rescan26/out/report.txt`: the full table of 453 rows and the notes.
- `out/results.json`, `out/report_mw6_b20.txt`.
- Code: `stats.py`, `x_stored.py`, `x_recompute.py`.
