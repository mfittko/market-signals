## roll47 preregistration: rolling 1-hour move checked every 15 minutes, continue or revert

This is registered before any outcome run. Only synthetic self-checks and signal counts ran. The counts use r60 and the thresholds only. No forward return was computed.

Question (operator): a rolling 1-hour window is checked every 15 minutes. When the window's move exceeds a threshold, is that a valid signal? Prior evidence: fade31 (fading 1.5 ATR fast moves loses gross in all 36 cells), the up/down tables (fast moves lean back 4-5 pp in frequency, no mean R), imom34 (intraday momentum fails), xvol9/xvol10 and lead35 (moves end inside the burst bar), scan46 (H1 N-bar momentum fails after DSR). New here: fixed-percent thresholds next to volatility-scaled ones, and a 15-minute decision grid over overlapping 1-hour windows.

Files:
- `data/research/engine/audit/roll47/prereg.json`
- `data/research/engine/audit/roll47/roll47.py` sha256 `6751af51d56495b2048bc571c8fc65298432800ec2fa046599c7e41b229efa93`
- Reused unchanged: `validate.day_boot` (`validate.py` sha256 `cb1642ed...`). Data: history.db `candles_ba` M1 bid/ask, read-only, before 2026-10-09 00:00 UTC. Nothing fetched.

### Definitions
- Decision times T: every 15 minutes on the UTC clock (:00, :15, :30, :45). The window is the M1 bars that start in [T-60, T-1]. These bars are closed by T. A decision is valid if at least 50 of the 60 bars exist and the first and last bars exist.
- r60 = mid close of bar T-1 / mid open of bar T-60 - 1.
- Fixed thresholds: |r60| >= 0.4%, 0.8%, 1.2%.
- Volatility-scaled thresholds: |r60| >= 2 or 3 x med20. med20 is the median |r60| over the previous 20 valid decisions at the same UTC clock slot (earlier days only, at least 15).
- CONTINUE enters in the sign of r60. REVERT enters against it.
- Entry: the open of the next M1 bar (first bar starting in [T, T+4]). Gross uses mid. Net buys the ask and sells the bid.
- Exit: the M1 close h = 15, 30, 60, 120 minutes after entry (latest bar starting in [e+h-5, e+h-1]). No stop and no target. A trade without an exit bar is dropped and counted.
- No stacking: per instrument, threshold and h, signals before the planned exit are skipped. CONTINUE and REVERT share one trade list. Their gross means are exact mirror images. Their net means differ by the spread.
- Units: bps per trade, and gross / sig20. sig20 is the RMS of r60 over all valid decisions of the previous 20 trading days.

### Test
- Windows by trading day (22:00 UTC rollover): dev 2018-01-01 .. 2022-12-31 and 2023-01-01 .. 2026-10-08. The 2023+ window is a development window, not a holdout.
- Inference: `validate.day_boot` over all trading days with a valid decision, block 5 days, 1000 reps, seed 47. SE = bootstrap SD. One-sided p = 1 - Phi(mean / SE). Holm over the 40 primary cells, per window.
- PRIMARY: WTI (WTICO/USD), 5 thresholds x 2 directions x 4 horizons = 40 cells, gross mean bps.
- PASS if some primary cell clears Holm (adjusted p < 0.05) in BOTH windows with the same sign, AND its net mean is above 0 in both windows. Otherwise FAIL.
- Secondary results never decide the verdict: the same grid on XAU, XAG, NATGAS, SPX500, NAS100, US30, DE30, EUR/USD; hit rates; signals and trades per day; spread as a share of mean |gross|; time of day by T (Asia 22-07, London 07-13, NY 13-22 UTC); sigma-unit means; MDE80 = 2.8 x SE per cell; fixed-percent versus volatility-scaled thresholds. A news-burst split is not included.

### Signals per day (decisions above threshold, before the no-stacking rule)
| Instrument | window | 0.4% | 0.8% | 1.2% | 2x med20 | 3x med20 |
|---|---|---|---|---|---|---|
| WTI | dev | 23.2 | 8.6 | 3.9 | 16.5 | 7.7 |
| WTI | 2023+ | 21.4 | 6.8 | 2.6 | 16.7 | 7.4 |
| XAU | dev / 2023+ | 3.4 / 6.1 | 0.55 / 1.16 | 0.15 / 0.38 | 17.3 / 18.6 | 8.0 / 8.6 |
| XAG | dev / 2023+ | 13.2 / 19.8 | 3.5 / 6.4 | 1.3 / 2.8 | 12.3 / 18.1 | 5.6 / 8.3 |
| NATGAS | dev / 2023+ | 20.7 / 19.0 | 11.5 / 11.5 | 6.3 / 6.4 | 7.2 / 5.8 | 3.2 / 2.3 |
| SPX500 | dev / 2023+ | 7.0 / 3.6 | 1.6 / 0.59 | 0.54 / 0.15 | 16.4 / 17.5 | 8.3 / 8.5 |
| NAS100 | dev / 2023+ | 10.6 / 7.0 | 2.8 / 1.35 | 0.95 / 0.40 | 19.4 / 18.4 | 9.7 / 8.8 |
| US30 | dev / 2023+ | 6.6 / 3.2 | 1.5 / 0.48 | 0.51 / 0.10 | 19.0 / 17.9 | 9.7 / 8.5 |
| DE30 | dev / 2023+ | 7.9 / 3.9 | 1.7 / 0.50 | 0.55 / 0.12 | 15.8 / 16.1 | 7.8 / 7.5 |
| EUR/USD | dev / 2023+ | 0.58 / 0.45 | 0.04 / 0.03 | 0.006 / 0.004 | 17.8 / 19.0 | 7.8 / 8.2 |

Consecutive decisions share 45 of 60 minutes, so signals cluster. The no-stacking rule turns them into far fewer trades. Fixed thresholds fire at very different rates across instruments and across windows. Volatility-scaled thresholds fire at a near-constant rate.

This is development evidence only. Any survivor needs prospective confirmation (https://github.com/mfittko/market-signals/issues/313) or data after 2026-10-08.
