## lead35 result: FAIL. A lagging follower does not catch up after a sharp leader move

Preregistration: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078068454 (prereg.json sha256 `b1d78c67...`, lead35.py sha256 `13f51c31...`, both unchanged for the run). 576 cells logged to `trials.jsonl` (exp `lead35`).

### Step 0: cross-correlation of M1 mid returns, corr(rL[m - lag], rF[m])
| pair | window | n | lag 0 | lag 1 | lag 2 | lag 3 | lag 4 | lag 5 |
|---|---|---|---|---|---|---|---|---|
| XAU -> XAG | dev | 1,358,739 | +0.696 | +0.016 | -0.007 | -0.001 | -0.000 | -0.002 |
| XAU -> XAG | 2023+ | 1,308,165 | +0.729 | +0.010 | -0.006 | -0.002 | +0.002 | -0.004 |
| XAG -> XAU | dev | 1,358,739 | +0.696 | -0.001 | -0.009 | -0.001 | +0.002 | -0.000 |
| XAG -> XAU | 2023+ | 1,308,165 | +0.729 | +0.003 | -0.005 | -0.001 | +0.007 | -0.001 |
| SPX500 -> WTI | dev | 1,514,084 | +0.275 | +0.015 | -0.002 | +0.002 | -0.001 | -0.002 |
| SPX500 -> WTI | 2023+ | 1,206,614 | +0.017 | +0.004 | -0.004 | -0.003 | -0.000 | +0.003 |
| WTI -> SPX500 | dev | 1,514,084 | +0.275 | +0.010 | -0.003 | +0.003 | -0.001 | +0.000 |
| WTI -> SPX500 | 2023+ | 1,206,614 | +0.017 | -0.005 | -0.000 | -0.001 | -0.001 | -0.002 |
| EUR/USD -> XAU | dev | 1,671,384 | +0.328 | +0.004 | -0.001 | +0.001 | +0.002 | +0.000 |
| EUR/USD -> XAU | 2023+ | 1,326,138 | +0.316 | +0.007 | +0.002 | -0.002 | +0.003 | +0.003 |
| WTI -> NATGAS | dev | 960,334 | +0.110 | +0.015 | +0.001 | +0.002 | -0.000 | +0.001 |
| WTI -> NATGAS | 2023+ | 694,775 | +0.134 | +0.017 | +0.004 | -0.000 | +0.001 | +0.004 |

The co-movement happens inside the same minute. Lag 1 is +0.004..+0.017 (R² below 0.03%), and lags 2..5 are about 0. POST-HOC check of the SPX500/WTI 2023+ value: the correlation per year is +0.17..+0.34 for 2018-2023, +0.09 for 2024, +0.22 for 2025 and -0.34 for 2026. The 2026 sign flip cancels the earlier years in the pooled window. Offsets of ±60 minutes give about 0, so the clocks agree.

### Signal counts (M1, k = 1, lagging follower)
Signals / trades with follower bar t+1 present: XAU -> XAG 1,893 / 1,716 dev and 1,766 / 1,739 2023+. The other pairs have 3,580..14,572 signals per window. M5 k = 1: 168..2,840 trades.

### Primary: XAU -> XAG, M1, k = 1, exit at the close of t+5
| window | n | gross ATR [95% CI] | gross bps [CI] | net ATR / bps | hit | MDE80 |
|---|---|---|---|---|---|---|
| dev 2018-22 | 1,716 | -0.034 [-0.147, +0.078] | -0.21 [-0.83, +0.48] | -2.95 / -10.8 | 0.472 | 0.165 |
| 2023+ (dev window) | 1,739 | -0.042 [-0.152, +0.059] | +0.06 [-0.68, +0.74] | -2.61 / -7.3 | 0.479 | 0.154 |

**Verdict: FAIL.** The CI lower bound is below 0 in both windows. The point estimate is negative in both windows, so a lagging XAG does not catch up with XAU. The test could detect about 0.16 follower ATR (80% power). The XAG spread costs about 2.6..3.0 M1 ATR, so even a true effect at the MDE would not cover costs. Exits at t+2 and t+10 show the same picture: +0.008 / +0.067 at h2 and -0.092 / -0.105 at h10, with no CI above 0.

### Secondary highlights (never decide the verdict)
- Across 576 cells (6 pairs, M1/M5, k 1/3, lag/nolag control, h 2/5/10, time of day, 2 windows), 62 gross CIs lie above 0 and 36 lie below 0. The positive cells are small: about +0.02..+0.05 ATR on M1 and +0.1..+0.3 bps.
- Only 2 cells clear 0 in both windows. M1 SPX500 -> WTI k1 h5 Asia: +0.108 / +0.064 ATR, net -1.16 / -1.87 ATR. M1 EUR/USD -> XAU k3 h2: +0.038 / +0.013 ATR, net -1.13 / -0.67. Both are post-hoc picks among 288 pairs of cells, so they are consistent with chance.
- No net CI lies above 0 in any of the 576 cells. Net results range from -0.3 ATR (M5 SPX/EUR-XAU) to -3 ATR (M1 XAG), or -1 to -25 bps (NATGAS).
- The lag condition adds nothing over the nolag control. XAG -> XAU k3 h5: lag +0.023 / +0.048 vs nolag -0.040 / -0.009. The difference is at most a few hundredths of an ATR.
- M5: the primary pair is negative (k1 -0.33 / -0.19 ATR, n 168 / 186, wide CIs). WTI -> SPX500 k3 2023+ is -0.059 [-0.103, -0.016]. The gross CIs of the other M5 cells span 0.
- Hit rates are 0.45..0.52 everywhere.

This matches xvol9/xvol10. The cross-instrument response finishes inside the bar where the leader moves. M1 OANDA mid prices show no tradable catch-up a minute later. The line closes.

Files (`data/research/engine/audit/lead35/`): `lead35.py`, `prereg_body.json`, `prereg.json`, `prereg_comment.md`, `summarize.py`, `posthoc_xcorr_year.py`, `posthoc_tally.py`, `out/counts.json`, `out/results.json`, `out/report.txt`, `out/run.log`, `out/posthoc_xcorr_year.txt`, `out/tally.txt`, `result_comment.md`.
