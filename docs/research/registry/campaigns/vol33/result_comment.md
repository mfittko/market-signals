## vol33 result: extreme tick volume as climax or absorption. FAIL

Prereg: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077853501 (prereg.json sha256 `71a69069...f37d5`). The outcome run followed the prereg. One amendment was made after the outcomes. It is a serialization fix only: `strip()` now recurses into lists, because results.json failed to write after the verdict and all trial rows were logged. The rerun with `VOL33_NOLOG=1` reproduced the same numbers. No definition, threshold, trade rule or statistic changed.

### Primary: WTI M5, gross mean R per trade (mid), stop 1 R = 1 ATR(10), target +1 R, time exit at bar 12

| Hypothesis | Window | Signals | Trades | Gross R [95% CI] | Holm p | Holm-adj. LB | Net R (bid/ask) | Hit | MDE80 |
|---|---|---|---|---|---|---|---|---|---|
| H1 climax (top 1%) | dev 2018-22 | 1,326 | 1,221 | +0.027 [-0.030, +0.084] | 0.344 | -0.039 | -0.318 | 0.512 | 0.080 |
| H1 climax (top 1%) | 2023+ | 1,318 | 1,155 | -0.001 [-0.053, +0.060] | 0.726 | -0.053 | -0.319 | 0.500 | 0.078 |
| H2 absorption (top 2%) | dev 2018-22 | 1,083 | 910 | +0.019 [-0.038, +0.075] | 0.344 | -0.038 | -0.300 | 0.510 | 0.081 |
| H2 absorption (top 2%) | 2023+ | 1,526 | 1,188 | +0.008 [-0.045, +0.063] | 0.726 | -0.054 | -0.326 | 0.503 | 0.077 |

Verdict: FAIL. Neither hypothesis has a Holm-adjusted lower bound above 0 in either window. Both point estimates are near 0. The design detects about 0.08 R per trade with 80% power, so an edge of that size is unlikely. A smaller edge cannot be excluded, but it would sit far below the cost. At the signal bar the median spread is 0.23 R, and net R is about -0.32 in both windows.

### Secondary results (none decides the verdict)
- **Costs.** No net CI lies above 0 in any of the 252 instrument, timeframe, variant and window cells. The net mean is negative in 250 cells. The two exceptions are SPX M5 H2 top 0.5% in dev (+0.047 [-0.066, +0.147]) and SPX M15 H1 top 0.5% in dev (+0.032 [-0.131, +0.168]). Extreme-volume bars carry wide spreads. The median spread at the signal bar is 0.08-0.23 R on M5 for SPX, WTI and XAU, 0.24-0.54 R for EUR and XAG, and about 0.9-1.2 R for NATGAS. On M1 it is 0.17-1.7 R.
- **H1 against all fast-move fades.** H1 is the top 1% subset of all fast-move fades, which have the same trade and their own one-trade sequence. The H1-minus-all difference on WTI M5 is +0.015 [-0.039, +0.073] in dev and -0.003 [-0.053, +0.055] in 2023+. Across the 36 cells, 2 CIs lie above 0 (XAG M5 dev, XAU M1 dev) and 1 lies below 0 (XAG M5 2023+). Extreme volume adds nothing to a fast-move fade.
- **All fast-move fades with this symmetric exit** (+1 R / -1 R / 12 bars) are slightly positive gross in 19 of 36 cells. On WTI M5 the result is +0.012 [+0.003, +0.021] in dev and +0.003 [-0.009, +0.016] in 2023+. The effect is 0.01-0.05 R, against a spread of 0.2-1.9 R. This fits fade31: moves reverse slightly more often, and the edge is far too small to trade. The fade31 exit (+0.5 R / -1 R) lost.
- **Other H1 cells.** The top 1% gross CI is above 0 only in dev and never in 2023+: WTI M1 +0.038, XAU M1 +0.064, XAG M1 +0.035, NATGAS M1 +0.049, EUR M1 +0.053, XAG M5 +0.057, XAG M15 +0.086. The top 5% CI is above 0 in both windows for EUR M5 and for WTI, XAU, NATGAS and EUR on M1. In each of these cells, all fast-move fades are also positive in both windows, so the volume filter adds nothing. The top 0.5% CI is never above 0 in both windows.
- **Other H2 cells.** H2 is weaker than H1. Across 108 gross cells, 3 CIs lie above 0 (SPX M5 dev +0.089, XAU M15 dev +0.104, NATGAS M5 top-5% dev) and 15 lie below 0. EUR is negative on M5 and M1 (M5 dev -0.091 [-0.139, -0.044]). NATGAS M5 2023+ is -0.131.
- **Thresholds on WTI M5.** H1 top 0.5% gives +0.019 / -0.007, and top 5% gives +0.027 [+0.003, +0.054] / -0.006. H2 top 0.5% gives +0.033 / -0.002, and top 5% gives +0.020 / +0.015. All are dev / 2023+, and only the dev top-5% H1 CI excludes 0. No threshold gives a gradient.
- **H3, side-free.** The registered measure divides the range over the next 12 bars by ATR(10) at the spike bar. Under that measure, spike bars (top 2%) show a SMALLER forward range than same-hour normal-volume bars. WTI M5 gives 0.890 [0.867, 0.914] in dev and 0.919 [0.892, 0.945] in 2023+. All instruments fall between 0.85 and 0.99 on every timeframe, and most CIs lie below 1. The cause is mechanical: the spike bar's own true range inflates ATR at bar i. A POST-HOC check divides by ATR at bar i-1 instead. With that change the ratio moves to about 1. WTI M5 gives 0.993 [0.969, 1.022] in dev and 0.984 [0.957, 1.012] in 2023+. The 36 cells range from 0.93 to 1.09, with no consistent sign. Only XAU M5 and EUR M5/M15 lie above 1 in both windows, by 3-9%. SPX M1 lies below 1 in both windows (0.967, 0.941). Extreme tick volume does not predict a larger move over the next hour beyond what the recent ATR already shows.
- **Power.** WTI M5 MDE80 is 0.08 R for the primary cells, 0.11-0.19 R at top 0.5%, 0.04-0.05 R at top 5%, and 0.03-0.05 R on WTI M1.

### Conclusion
On OANDA tick counts, an extreme-volume bar marks neither a climax worth fading nor an absorption worth following. This holds on WTI and on the five other instruments, on M1, M5 and M15. The wide spread on these bars makes them worse entries than average. This result joins sess25, news24 and fade31 as volume-conditioned tests with a null result. The only directional volume finding remains flow29: aggressor-side CL order flow, which needs exchange trade data. OANDA tick counts do not carry that information.

Files (`data/research/engine/audit/vol33/`): `vol33.py`, `prereg.json` (with the amendment), `prereg_body.json`, `prereg_comment.md`, `summarize.py`, `posthoc_h3.py`, `out/results.json`, `out/report.txt`, `out/posthoc_h3.json`, `out/posthoc_h3.txt`, `out/plumb.json`, `out/run.log`, `out/run2.log`, and the feature caches `out/feat_*.npz`. Trials are logged as exp `vol33` in `trials.jsonl`: 252 cells, 36 H3 rows, PRIMARY, and 18 POSTHOC rows.

This is development evidence only. The 2023+ window is a development window, not a holdout.
