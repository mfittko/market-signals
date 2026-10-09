## swing45 result: FAIL. The index pullback rule has a real but tiny edge on M1, and the spread is 10 to 20 times larger

Prereg: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084026498. Code and data unchanged since registration (`swing45.py` sha `63f04ae2...`). One run.

### Verdict
- 24 of 168 primary cell-windows clear Holm. 16 of them are the 8 M1 cells that clear in BOTH windows: down3, down4, RSI<5 and RSI<10, each with both trend filters. Two M5 cells clear in dev only (down2/daily, RSI<25/daily).
- All 8 both-window cells have excess +0.07 to +0.17 bps per trade, and their net after the bid/ask spread is -1.3 to -2.3 bps per trade in both windows. The PASS needs net > 0, so the verdict is **FAIL**.
- No cell on M15, M30, H1 or H4 clears Holm in either window. No primary CI is below 0 in dev. One is below 0 in 2023+ (M30).

### Indices pooled, long (8 indices; best = highest min(dev, 2023+) excess of the 14 trigger x filter cells; median = middle cell). bps per trade

| Res | Cell | Window | n | gross | excess [95% CI] | net | hit | bars held | spread / mean abs gross |
|---|---|---|---|---|---|---|---|---|---|
| M1 | best rsi5/bar | dev | 154,629 | +0.17 | +0.17 [+0.11,+0.23] | -2.30 | 0.63 | 4.1 | 0.63 |
| M1 | best rsi5/bar | 2023+ | 120,561 | +0.16 | +0.15 [+0.10,+0.20] | -1.59 | 0.63 | 4.1 | 0.55 |
| M1 | median down4/daily | dev | 162,090 | +0.11 | +0.11 [+0.06,+0.16] | -1.93 | 0.65 | 3.9 | 0.55 |
| M1 | median down4/daily | 2023+ | 158,803 | +0.10 | +0.09 [+0.04,+0.13] | -1.41 | 0.64 | 4.0 | 0.43 |
| M5 | best rsi5/bar | dev | 31,976 | +0.24 | +0.27 [-0.07,+0.57] | -2.32 | 0.66 | 4.0 | 0.30 |
| M5 | best rsi5/bar | 2023+ | 25,097 | +0.27 | +0.16 [-0.06,+0.40] | -1.53 | 0.65 | 4.1 | 0.26 |
| M5 | median rsi10/daily | dev | 85,640 | +0.27 | +0.26 [+0.08,+0.42] | -2.04 | 0.65 | 4.0 | 0.30 |
| M5 | median rsi10/daily | 2023+ | 88,977 | +0.14 | +0.07 [-0.08,+0.21] | -1.58 | 0.64 | 4.1 | 0.23 |
| M15 | best rsi25/daily | dev | 53,741 | +0.25 | +0.21 [-0.17,+0.60] | -2.09 | 0.67 | 3.8 | 0.18 |
| M15 | best rsi25/daily | 2023+ | 55,317 | +0.16 | -0.03 [-0.39,+0.29] | -1.56 | 0.66 | 3.9 | 0.14 |
| M15 | median rsi10/bar | dev | 20,558 | +0.56 | +0.48 [-0.18,+1.09] | -1.98 | 0.67 | 4.0 | 0.18 |
| M15 | median rsi10/bar | 2023+ | 16,083 | +0.00 | -0.18 [-0.78,+0.38] | -1.77 | 0.65 | 4.0 | 0.14 |
| M30 | best down5/bar | dev | 1,960 | +0.62 | +0.36 [-2.00,+2.41] | -1.88 | 0.67 | 3.7 | 0.13 |
| M30 | best down5/bar | 2023+ | 1,641 | +0.65 | +0.19 [-1.73,+1.86] | -1.09 | 0.67 | 3.8 | 0.11 |
| M30 | median rsi5/daily | dev | 8,469 | -0.18 | -0.26 [-1.59,+1.02] | -2.52 | 0.65 | 4.1 | 0.10 |
| M30 | median rsi5/daily | 2023+ | 9,059 | +0.13 | -0.28 [-1.55,+0.85] | -1.64 | 0.64 | 4.1 | 0.09 |
| H1 | best rsi25/daily | dev | 13,521 | +0.32 | +0.17 [-1.31,+1.63] | -2.05 | 0.68 | 3.7 | 0.09 |
| H1 | best rsi25/daily | 2023+ | 13,833 | +0.51 | -0.24 [-1.60,+0.97] | -1.25 | 0.66 | 3.8 | 0.07 |
| H1 | median rsi10/bar | dev | 5,441 | +1.30 | +0.89 [-1.41,+3.08] | -1.20 | 0.67 | 3.9 | 0.09 |
| H1 | median rsi10/bar | 2023+ | 4,322 | +0.34 | -0.53 [-2.50,+1.40] | -1.40 | 0.64 | 4.0 | 0.07 |
| H4 | best rsi25/bar | dev | 3,198 | +2.26 | +1.39 [-3.74,+6.63] | -0.24 | 0.70 | 3.7 | 0.05 |
| H4 | best rsi25/bar | 2023+ | 2,752 | +4.81 | +2.52 [-2.23,+7.27] | +3.08 | 0.69 | 3.7 | 0.04 |
| H4 | median rsi5/bar | dev | 810 | +1.22 | +0.15 [-11.03,+9.77] | -1.13 | 0.70 | 4.0 | 0.04 |
| H4 | median rsi5/bar | 2023+ | 725 | +2.75 | +0.01 [-8.83,+7.82] | +1.07 | 0.66 | 4.3 | 0.03 |
| D (ref) | rsi10 (swing43 primary) | dev | 259 | +5.6 | +2.9 [-44.9,+42.1] | +3.6 | 0.68 | 3.4 | 0.01 |
| D (ref) | rsi10 | 2023+ | 309 | +48.3 | +33.7 [+7.2,+59.3] | +46.4 | 0.73 | 3.4 | 0.02 |
| D (ref) | down3 | dev | 274 | +14.3 | +11.5 [-24.0,+44.9] | +12.4 | 0.71 | 3.4 | 0.01 |
| D (ref) | down3 | 2023+ | 321 | +37.1 | +22.6 [+0.5,+44.9] | +35.1 | 0.73 | 3.4 | 0.02 |

### How excess and net change from M1 to H4 to daily (median over the 14 cells, dev / 2023+)
- Excess: M1 +0.09 / +0.10, M5 +0.25 / +0.06, M15 +0.20 / -0.16, M30 +0.00 / -0.26, H1 +0.15 / -0.41, H4 +1.50 / +0.23, daily reference +6 / +23 bps.
- Spread cost per round trip: about 2.0-2.5 bps in dev and 1.6-1.8 bps in 2023+ at every intraday resolution. The mean absolute move per trade grows from 3.5 bps (M1) to 8 (M5), 13 (M15), 18 (M30), 25 (H1), 52 (H4) and 120 bps (daily). The spread share falls from 0.50-0.61 (M1) to 0.25-0.30 (M5), 0.14-0.18 (M15), 0.10-0.13 (M30), 0.07-0.09 (H1), 0.04-0.05 (H4) and 0.01-0.02 (daily).
- Net median: M1 -2.13 / -1.51, M5 -2.13 / -1.52, M15 -2.13 / -1.69, M30 -2.28 / -1.61, H1 -2.09 / -1.39, H4 -0.11 / +1.04, daily +8 / +35.
- Power: MDE80 per cell (unadjusted) is about 0.05-0.09 bps (M1), 0.25-0.31 (M5), 0.8-0.9 (M15), 1.4-1.6 (M30), 2.7-3.0 (H1), 10-12 (H4), 37-62 (daily, 2018+ only). Under Holm add about 50%. Only M1 and M5 can detect an edge of the size seen there, and that size is below the spread.
- Hit rate is 0.63-0.70 at every resolution. Bars held are 3.7-4.1. Trades per day per index: about 15-20 (M1), 3-11 (M5), 2-7 (M15), 0.2-1.2 (M30), 0.5-1.8 (H1), 0.1-0.4 (H4).

### Secondary (never decide)
- Per index: the M1 excess is positive with CI > 0 in many cells for EU50, AU200, SPX500, NAS100, US30 and JP225 (2-14 of 14 cells per index and window), small for DE30 and UK100. Net median is negative on every index from M1 to H1. On H4, UK100 has 6 of 14 cells with CI > 0 in 2023+ (2 in dev), median excess +4.6 / +5.9 and net +0.9 / +4.0; SPX500, NAS100 and US30 have positive H4 net medians without CI support. UK100 H4 down3/bar is the only notable per-index cell: excess +9.5 [+1.4,+17.5] dev (n 199), +10.9 [+3.8,+17.0] 2023+ (n 175), net +6.2 / +8.1 (down4/bar similar, n 79/74). It is one of about 1,260 secondary dev/2023+ cell pairs (84 cells x 15 units) and would not survive any family correction; a prospective candidate at most.
- Short mirror on indices: excess is positive on M1-H1 in dev (M5 14 of 14 cells CI > 0; H1 median +4.4), but 2023+ is smaller (M5 0 of 14). Net is negative except H1 dev. Short excess partly reflects mean reversion in both directions on short bars.
- Trading6 (WTI, XAU, XAG, NATGAS, SPX500, EUR/USD): excess CI > 0 in 13-14 of 14 cells on M1 and M5 in both windows (median +0.17 to +0.67 bps), but net medians are -4 to -6 bps because of wider spreads (NATGAS -19 to -25 bps net, XAG -6 to -10). H4 turns negative (median excess -5 to -8; XAU 8 of 14 dev CIs < 0). EUR/USD has the most consistent M1-M15 excess (+0.1 to +0.5) and still loses about 1 bps net. WTI M1 excess +0.28 dev, +0.08 2023+, net about -4.8.
- Daily reference (swing43 rule, same 8 indices, 2018+): positive in every cell, CI > 0 only in 2023+ (rsi10 +33.7, rsi5 +52.1, down3 +22.6, down5 +50.9). In 2018-22 the daily rule earned only +3 to +12 bps excess with wide CIs.

### Plain reading
The dip-buy after a short pullback in an uptrend works on every timeframe in the sense that it wins about two trades out of three. Beyond the uptrend drift, the edge per trade on intraday bars is tiny: about 0.1-0.2 bps on M1 and a few tenths of a bp on M5. On M1 it is statistically certain in both windows, but the spread is about 2 bps per round trip, so every M1 and M5 version loses about 1.5-2.3 bps per trade. From M15 to H1 the edge is indistinguishable from zero. H4 is the first resolution where the spread is small relative to the move; its net is slightly positive in 2023+, but its excess is not distinguishable from drift (CIs about +/-5 to 10 bps). Only the daily rule gives an edge (tens of bps) that dwarfs the spread, and only that row reproduces the swing43/swing44 result. The M1 edge likely reflects quote noise mean reversion (it also appears in the short mirror). For product use, the pullback rule belongs on daily bars; intraday versions are not worth trading.

### Caveats
- 2023+ is a development window. Pooled indices share calendar weeks (EU50 and DE30 move together); the week-clustered bootstrap covers part of that.
- Net excludes financing; on intraday holds of 4 bars it is near zero, on H4 about 0.5-1 roll per trade (CFD net in results.json).
- Bars exist only where M1 bars exist; quiet minutes are absent, so "10 bars" on M1 can span more than 10 minutes.

Files: `data/research/engine/audit/swing45/` (`swing45.py`, `report.py`, `prereg_body.json`, `prereg.json`, `prereg_comment.md`, `result_comment.md`, `out/describe.json`, `out/results.json`, `out/run.log`, `out/trades.parquet`, `out/cache/*.npz`); 2,702 trials.jsonl rows (exp swing45).
