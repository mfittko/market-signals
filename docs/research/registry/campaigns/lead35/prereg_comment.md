## lead35 preregistration: short-horizon lead-lag (leader moves sharply, follower has not moved yet)

This is registered before any outcome run. Only synthetic self-checks and signal counts ran. The counts read prices up to the signal bar only. No follower path after the signal and no cross-correlation was computed.

Question: does one instrument lead another by a few minutes? If a leader makes a sharp M1 move and a related follower has not moved yet, does the follower catch up over the next minutes?

How lead35 differs from earlier rows. xvol9/xvol10 (queue row 9) studied simultaneous cross-instrument bursts and found that moves ended inside the burst bar. pairs16 (row 16) traded spread mean reversion and found that spreads revert slower than the holds. lead35 conditions on the follower NOT having moved yet and trades the catch-up in the leader's direction.

Files:
- `data/research/engine/audit/lead35/prereg.json` sha256 `b1d78c67a9092eead7f3313ca2a226cd0b32c1207fef2105e76d7e3d7af401d9`
- `data/research/engine/audit/lead35/lead35.py` sha256 `13f51c31d4a613d7bcdb1993db85de5144e2cf261a8c6c0034971f413c8bcad1`
- Reused unchanged: `validate.day_boot` (`validate.py` sha256 `cb1642ed...`) and the engine M1 bid/ask cache (history.db `candles_ba`), cut 2026-10-07 18:30 UTC.

### Definitions
- Pairs (leader -> follower): XAU -> XAG (PRIMARY), XAG -> XAU, SPX500 -> WTI, WTI -> SPX500, EUR/USD -> XAU, WTI -> NATGAS.
- Windows: dev 2018-01-01..2022-12-31. 2023-01-01..2026-10-07 is a second development window, not a holdout.
- Mid = (bid + ask) / 2 per OHLC field. M5 bars are built from M1 per instrument.
- ATR(10): Wilder ATR on each instrument's own mid bars, taken as of bar t-k. This is the bar before the return window, so the leader's move does not inflate its own denominator.
- Signal at the close of M1 bar t, k in {1, 3}: zL = (leader close[t] - close[t-k]) / ATR_L. The signal needs |zL| >= 2.0. The direction is s = sign(zL). The follower must lag: s x zF < 0.5, with zF defined the same way on the follower. Opposite follower moves count as lagging. Bars t-k..t must be present for both instruments. One signal per 10 minutes per pair (greedy in time; M5: 2 bars).
- Trade: the follower in direction s. Entry at the open of bar t+1, which must exist. Exit at the close of the last follower bar in [t+1, t+h]. h = 5 is primary.
- Gross = s x (exit - entry) on mid, in follower ATR units (primary) and in bps. Net: a long buys ask_o[t+1] and sells bid_c[exit]; a short does the reverse.

### Step 0 (descriptive, no verdict)
Pearson correlation of M1 log mid-close returns, corr(rL[m - lag], rF[m]) for lag 0..5. Only minutes where both instruments have the bar and the previous bar count. Per pair and window.

### Primary test
- XAU -> XAG, M1, k = 1, h = 5, mean gross move in follower ATR units.
- Day-block bootstrap: `validate.day_boot`, block 5 trading days, 1000 reps, seed 35. All trading days with a bar in the window are resampled.
- PASS if the 95% CI lower bound is above 0 in BOTH windows. Otherwise FAIL.

### Pre-outcome signal counts (M1, k = 1, lagging)
| pair | dev | 2023+ |
|---|---|---|
| XAU -> XAG (primary) | 1,893 | 1,766 |
| XAG -> XAU | 5,053 | 3,580 |
| SPX500 -> WTI | 10,651 | 13,119 |
| WTI -> SPX500 | 12,897 | 14,572 |
| EUR/USD -> XAU | 12,364 | 9,545 |
| WTI -> NATGAS | 10,297 | 7,489 |

### Secondary (never decides the verdict)
k = 3; the other five pairs; exits at h = 2 and h = 10; the M5 version; hit rate; signal counts; time-of-day split of the signal close (Asia 22-07, London 07-13, NY 13-21 UTC); MDE80 = 2.8 x bootstrap sd; net results; a control "nolag" that keeps the leader signal and drops the follower condition. Every cell is logged to `trials.jsonl` with exp `lead35`.
