## swing45 preregistration: the swing43 index pullback rule on intraday bars (M1 to H4) with variable dip triggers

This is registered before any outcome run. Only self-checks, bar counts and trade counts ran. No trade return, drift, excess or spread cost was computed.

Question: swing43 and swing44 found about +17 to +18 bps per trade beyond the uptrend drift for a Connors-style pullback on daily index candles. Does the same rule earn more than the drift when every length is counted in bars of an intraday resolution, and with different dip triggers?

Files:
- `data/research/engine/audit/swing45/prereg.json` sha256 `5e286fddfa7b798525bb2392fcb4c3bdd04864d24c7a326f15386ff7076a3a72`
- `data/research/engine/audit/swing45/swing45.py` sha256 `63f04ae293ffc5cfb31b992fa53f357885a9de7f311ed216adc14e2666f4fd8a` (imports `swing43.py` unchanged, sha `52be7a2d...` pinned and checked)

### Data
- `history.db` candles_ba M1 bid/ask, read-only, 2018-01-01 to 2026-10-08 21:00 UTC.
- Indices with M1 data: SPX500, NAS100, US30, DE30, UK100, JP225, AU200, EU50 (8). FR40, HK33 and the other swing44 indices have no M1 data there.
- Mid = (bid + ask) / 2 of the last M1 in each bar. M5, M15, M30 and H1 use UTC buckets. H4 bars start at 17:00, 21:00, 01:00, 05:00, 09:00 and 13:00 New York time. Bars exist only where M1 bars exist.
- Daily regime from the tsmom36 and swing44 daily databases (17:00 NY closes since 2003-2006), read-only.

### Rule (all lengths in bars of the tested resolution)
- Trend filter, two variants: (a) close > SMA(200 bars); (b) daily regime: the last daily close at or before the bar > daily SMA(200). Variant (b) replaces (a).
- Dip triggers: N consecutive lower closes with N = 2, 3, 4, 5; Wilder RSI(2) < 5, 10, 25.
- Long at the trigger bar close. Exit at the first close above SMA(5 bars) or after 10 bars. One open trade per instrument. The trigger, filter and exit code reproduce `swing43.setup_mask` and `swing43.trades` exactly (asserted in the check).

### Statistic and costs
- Excess = trade log return minus the mean bar log return on in-trend bars (prior bar in the cell's trend state) of that instrument, resolution and window, times bars held. This is the swing43 statistic per bar.
- Net = gross minus half the bid/ask spread at the entry bar and half at the exit bar, each from that bar's own last M1 quote. No fixed fallback. CFD net (reported) also subtracts 0.822 bps per 17:00 NY roll crossed.

### Test
- Windows: dev 2018-01-01 to 2022-12-31; second 2023-01-01 to 2026-10-08 (a development window, already used for other rules, not a holdout).
- Primary family: 8 indices pooled, 6 resolutions x 7 triggers x 2 trend filters = 84 cells. CI: swing43.ci (week-clustered bootstrap, 1000 reps, seed 45).
- One-sided test of excess > 0 with p = 1 - Phi(excess / bootstrap SE). Holm across the 84 cells, separately per window, alpha 0.05.
- PASS: at least one cell clears Holm in both windows, and its mean net after the spread is > 0 in both windows. Otherwise FAIL. Every cell is reported.
- Power: the first Holm step needs z of about 3.4, so the MDE80 under Holm is about 4.2 bootstrap SE. SE per cell will be reported.
- Trade counts per cell and window: M1 43k-794k, M5 11k-167k, M15 3.9k-57k, M30 2.0k-29k, H1 1.0k-14.6k, H4 236-4.1k.

### Secondary (never decide)
- Per index; short mirror in downtrends (RSI(2) > 100 - thr or N higher closes, exit below SMA5).
- WTI, XAU, XAG, NATGAS, SPX500, EUR/USD per instrument and pooled.
- Hit rate, bars held, trades per day per instrument, spread cost as a share of the mean absolute gross move, MDE80.
- Reference: the daily swing43 rule (same 7 triggers) on the same 8 indices, entries 2018 to 2026-10-08.

This is development evidence. Any survivor still needs prospective confirmation (https://github.com/mfittko/market-signals/issues/313) or data after 2026-10-08.
