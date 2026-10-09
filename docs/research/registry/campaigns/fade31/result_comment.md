## fade31 result: FAIL. Fading fast moves without news loses before spread

Preregistration: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077701852. The run followed it with no amendment. This is development evidence only, and 2023+ is a development window.

### Event counts, WTI M5 (no-news / news / excluded for missing GDELT files)
| Window | no-news | news | excluded |
|---|---|---|---|
| dev 2019-2022 | 3,419 | 161 | 24,324 |
| 2023+ | 3,042 | 58 | 24,036 |

The one-trade-at-a-time filter removed almost nothing: 2 excluded signals in dev and none in 2023+. GDELT files cover only about 12% of fast-move signals. The covered bars lie within 15-30 minutes after a news24 strong high-volume candle on some instrument. The covered subset is therefore not a random sample.

### Primary: WTI M5 no-news fades, primary exits (+0.5 R target, -1 R stop, time exit at bar 6)
| Window | n | gross R [95% CI] | net R (bid/ask) [CI] | hit rate | trades/day | MDE80 |
|---|---|---|---|---|---|---|
| dev | 3,419 | -0.074 [-0.098, -0.051] | -0.273 [-0.301, -0.245] | 0.616 | 3.3 | 0.035 |
| 2023+ | 3,042 | -0.102 [-0.128, -0.075] | -0.337 [-0.375, -0.308] | 0.593 | 3.1 | 0.037 |

Verdict: FAIL. The CI lies below 0 in both windows, so these fades lose gross. The +0.5 / -1 bracket breaks even at a 66.7% hit rate, and the observed rate is 59-62%. The test can detect 0.035-0.037 R with 80% power. The expected bounce of about 0.16 ATR would have been visible.

### Key secondary: news fades minus no-news fades (gross R, primary exits)
- WTI M5: dev +0.031 [-0.063, +0.134] (news n 161), 2023+ +0.007 [-0.248, +0.258] (news n 58). News fades also lose (-0.042 and -0.095), but they do not lose more than no-news fades.
- The other 34 cells show no consistent sign. EUR/USD M5 dev is -0.140 [-0.221, -0.053], which supports the rule, but EUR/USD M5 2023+ is +0.019 [-0.088, +0.124]. XAU M1 2023+ is +0.155 [+0.016, +0.261], which points the other way. The news groups are small (12-283 trades per cell at M5).
- The data neither supports nor refutes "don't fade news". The useful point is that fades lose with or without news.

### Highlights (secondary, never decide the verdict)
- Every instrument and every timeframe fails the same way. No-news gross R with primary exits is negative with CI below 0 in all 36 cells, from -0.042 to -0.145 R.
- Without the coverage filter, fades are still no edge. All fast-move signals on WTI M5, including the excluded ones (n about 27k per window): -0.008 [-0.017, +0.000] in dev and -0.026 [-0.038, -0.015] in 2023+. The time-exit-only variant gives +0.013 [-0.011, +0.038] in dev and -0.008 [-0.036, +0.022] in 2023+.
- The only all-signal fade with a CI above 0 in both windows is EUR/USD M5 time-exit-only (+0.082 [+0.056, +0.109] dev, +0.038 [+0.014, +0.063] 2023+). Its net R is about -0.3 to -0.5 R, so it is not tradable.
- With a 1.0 R target, the WTI M5 no-news result is -0.056 [-0.089, -0.023] in dev and -0.078 [-0.114, -0.044] in 2023+. With time exit only it is -0.123 [-0.200, -0.037] and -0.161 [-0.253, -0.063]. M1 and M15 match this.
- Net R with bid/ask is -0.19 to -1.86 R per trade. The worst values are on NATGAS and XAG at M1.
- The up/down tables show a lean back in frequency (P(move >= 0.25 ATR against) > P(with)). That lean does not turn into mean R. The hit rate of the time-exit-only variant is about 0.50, and continuation moves are larger than the reversals.

Files (in `data/research/engine/audit/fade31/`): `fade31.py`, `prereg.json`, `summarize.py`, `prereg_comment.md`, `result_comment.md`, `out/results.json`, `out/report.txt`, `out/plumb.json`, `out/run.log`. Trials are logged in `engine/trials.jsonl` (exp `fade31`, 108 cells plus the PRIMARY verdict row).
