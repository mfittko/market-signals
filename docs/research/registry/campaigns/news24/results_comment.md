## news24 result: REJECT (WTI direction consistent, no CI clears)

Registered rule (amendment 1, gross primary): WTI M5, 6 bars, GROSS NEWS mean R CI above 0 in both windows AND GROSS NEWS minus CONTROL CI above 0 in both windows. Not met.

Preregistration: https://github.com/mfittko/market-signals/issues/310#issuecomment-6060706463
Amendment 1: https://github.com/mfittko/market-signals/issues/310#issuecomment-6060897166
Code hash news24.py `48876a10` matches the amendment. Files: `data/research/engine/audit/news24/` (out/report.txt, out/results.json).

### Data
GDELT GKG, 38,939 15-min files fetched (4-hourly baseline grid plus the two files before each event), 717 missing at the source, 26 HTTP 404. Filtered store 6.7 GB. Events with a missing news file are excluded (1-3% per cell).

NEWS events are rare: 2-7% of the price/volume events per instrument.

### Primary: WTI M5 (R = 1.5 ATR14, stop -1 R, breakeven after +1 R, target 3 R, time exit; entry next bar open)

| Window | H | n NEWS / CTRL | GROSS NEWS R [95% CI] | GROSS CTRL R | NEWS - CTRL [95% CI] | cont % NEWS / CTRL | NET (bid/ask) NEWS R | NET NEWS - CTRL |
|---|---|---|---|---|---|---|---|---|
| dev 2019-22 | 3 | 64 / 1010 | +0.234 [+0.013, +0.503] | +0.014 | +0.220 [-0.020, +0.504] | 56 / 43 | +0.089 | +0.206 [-0.023, +0.487] |
| dev 2019-22 | 6 | 64 / 1010 | +0.275 [+0.015, +0.576] | +0.030 | +0.245 [-0.025, +0.552] | 45 / 37 | +0.045 | +0.144 [-0.088, +0.419] |
| dev 2019-22 | 12 | 64 / 1010 | +0.241 [-0.065, +0.606] | +0.056 | +0.185 [-0.136, +0.554] | 38 / 31 | -0.002 | +0.094 [-0.176, +0.412] |
| 2023+ | 3 | 21 / 888 | +0.161 [-0.213, +0.621] | +0.040 | +0.120 [-0.256, +0.580] | 43 / 44 | +0.059 | +0.138 [-0.284, +0.619] |
| 2023+ | 6 | 21 / 888 | +0.140 [-0.239, +0.546] | +0.036 | +0.105 [-0.278, +0.490] | 33 / 38 | +0.036 | +0.122 [-0.264, +0.530] |
| 2023+ | 12 | 21 / 888 | +0.023 [-0.295, +0.513] | +0.057 | -0.034 [-0.368, +0.447] | 33 / 33 | -0.080 | -0.019 [-0.369, +0.463] |

2023+ is a development window, not a holdout. n = 21 NEWS events there is below the registered 30-event flag.

### Reading
- In WTI, NEWS candles do better than CONTROL candles in both windows (+0.25 R and +0.11 R gross at 6 bars). The 6-bar NEWS mean clears 0 in dev only. No difference CI clears 0.
- Power is the limit. The 80% minimum detectable difference is about 0.4 R (dev) and 0.55 R (2023+). The observed differences are smaller.
- CONTROL candles are flat gross (about 0 R) and lose about 0.1 R net. This matches the earlier candle-only tests. The hypothesis that non-news moves revert is not supported: they are flat, not negative, gross.
- Spread costs about 0.15-0.25 R per trade at these events. Net NEWS means are near 0.
- Secondary instruments are mixed. SPX M5 dev: NEWS +0.50 R [+0.10, +0.90], difference +0.50 [+0.09, +0.88] (n 40); 2023+ reverses to -0.09 (n 40). EUR/USD is positive in 2023+ only. XAU is flat. XAG and NATGAS have fewer than 11 NEWS events per cell. M15 and M1 for WTI point the same way as M5 (except M15 2023+, n 15) and are also inside noise.

### Decision
REJECT under the registered rule. Nothing ships. The only defensible follow-up is prospective: log WTI NEWS events from live GDELT going forward and test once about 60 new events exist. A re-test on the same history with other thresholds would be a forking-path search.
