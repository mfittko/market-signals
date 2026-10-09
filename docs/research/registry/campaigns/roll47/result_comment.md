## roll47 result: rolling 1-hour move checked every 15 minutes, continue or revert: FAIL

Preregistration: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084779140. The run used the registered code unchanged (`roll47.py` sha256 `6751af51...`). 720 rows in `trials.jsonl` (exp `roll47`).

### Verdict
FAIL. No WTI cell clears Holm in either window. The smallest Holm p is 0.27 (dev) and 0.55 (2023+). No WTI cell has a net CI above 0 in either window. The gross effect is about 0 for every threshold and horizon. The spread costs 4-6 bps per trade, which is larger than every gross mean.

### WTI signals and trades per day (dev / 2023+)
Signals are decisions above the threshold. Trades are what remains after the no-stacking rule (h = 60).

| Threshold | signals/day | trades/day at h 60 |
|---|---|---|
| 0.4% | 23.2 / 21.4 | 8.7 / 8.3 |
| 0.8% | 8.6 / 6.8 | 3.6 / 3.0 |
| 1.2% | 3.9 / 2.6 | 1.7 / 1.2 |
| 2 x med20 | 16.5 / 16.7 | 7.3 / 7.4 |
| 3 x med20 | 7.7 / 7.4 | 3.8 / 3.7 |

### WTI table (gross and net bps per trade, 95% CI, Holm p)
| Cell | dev gross | dev net | Holm | 2023+ gross | 2023+ net | Holm |
|---|---|---|---|---|---|---|
| 0.4% CONTINUE h60 (best dev) | +1.69 [+0.35,+3.05] | -4.40 | 0.27 | -0.91 [-2.32,+0.45] | -5.60 | 1.00 |
| 1.2% REVERT h30 (best 2023+) | -1.37 [-4.25,+1.54] | -9.67 | 1.00 | +4.24 [+0.44,+7.79] | -0.61 | 0.55 |
| 1.2% REVERT h60 (best net) | -0.46 [-5.22,+4.13] | -8.43 | 1.00 | +6.06 [-0.04,+11.61] | +1.28 [-4.86,+6.68] | 0.79 |
| 3 x med20 CONTINUE h60 | +1.30 [-0.83,+3.49] | -4.59 | 1.00 | -1.02 [-3.28,+1.36] | -6.06 | 1.00 |
| 2 x med20 CONTINUE h15 | +0.15 [-0.32,+0.63] | -5.71 | 1.00 | -0.04 [-0.51,+0.40] | -5.02 | 1.00 |
| 1.2% CONTINUE h60 (worst 2023+) | +0.46 [-4.13,+5.22] | -7.51 | 1.00 | -6.06 [-11.61,+0.04] | -10.84 | 1.00 |
| 0.4% REVERT h60 (worst dev) | -1.69 [-3.05,-0.35] | -7.78 | 1.00 | +0.91 [-0.45,+2.32] | -3.78 | 1.00 |

- The sign flips between windows. Dev leans CONTINUE (20 of 20 trade lists have a positive CONTINUE mean). 2023+ leans REVERT (17 of 20). Only one dev cell and one 2023+ cell have a gross CI that excludes 0, and they point in opposite directions.
- Volatility-scaled cells: every gross mean is within +/-1.3 bps, and no CI excludes 0. In sigma units the means are within +/-0.06 sigma for all 40 cells.
- Hit rates: CONTINUE 0.46-0.50, REVERT 0.50-0.54. The frequency lean toward reversal at h 15 is the same as in the up/down tables. It does not turn into mean return, as in fade31.
- MDE80 (2.8 x SE): 0.7 bps (0.4%, h 15) to 11 bps (1.2%, h 120). The spread share (mean cost / mean |gross|) is 0.25 at h 15 and 0.05-0.10 at h 120. Net is negative in 79 of 80 WTI cells. The 2023+ 1.2% REVERT h 60 cell (+1.28 net, CI spans 0) comes from 2026 (POST-HOC: 646 trades, +11.0 bps; 2023 +0.8, 2024 -6.9, 2025 +6.2).
- Time of day (CONTINUE, h 60, point estimates by decision time): dev is positive in Asia, London and NY for most thresholds (+0.2 to +2.6 bps). In 2023+, London and NY are negative (0.4%: -0.6/-1.8; 1.2%: -11.3/-7.2) and Asia is positive (1.2%: +10.6, n 154). Nothing replicates across windows.
- Exits without a bar (weekend and daily close) are dropped: 0-705 per WTI cell over the full period.

### Secondary instruments (never decide)
- 312 secondary trade lists (8 instruments x 20 x 2 windows; EUR/USD 1.2% has under 10 trades). 26 have a gross CI that excludes 0 (8%, against 5% by chance). Only 3 of 624 directional cells have a net CI above 0. All 3 are fixed-threshold REVERT cells with few trades: NAS100 1.2% h120 dev +8.69 net (n 467; 2023+ +5.30 [-9.18,+21.58], n 169), US30 1.2% h30 2023+ +14.93 net (n 68; dev +1.83, CI spans 0), EUR/USD 0.8% h60 dev +10.42 net (n 35; 2023+ -1.02).
- XAG 0.4% REVERT h60 is the only secondary cell with a gross CI above 0 in both windows: +1.80 [+0.67,+2.95] dev, +1.47 [+0.05,+2.86] 2023+. Net is -8.93 / -5.29, because the XAG spread costs 7-10 bps.
- EUR/USD volatility-scaled REVERT h 15/30: +0.14 to +0.24 bps gross in dev (CI > 0), +0.04 to +0.18 in 2023+ (CI spans 0). Net about -1.1 to -1.4 bps.
- NATGAS: net -18 to -20 bps in every cell (spread about 20 bps).

### Fixed percent versus volatility-scaled thresholds
- Volatility-scaled thresholds fire at a near-constant rate (2x: 12-19 per day, 3x: 5-10 per day on every instrument and window except NATGAS). Their gross means sit at 0 within +/-1.3 bps on WTI and within +/-4 bps on all instruments (largest NATGAS 3x h60 2023+, 3.98). They describe the same "unusual for this hour" event everywhere, and that event carries no direction.
- Fixed-percent thresholds fire at rates that change with the regime. Index signals at 0.8-1.2% drop by 50-80% from dev to 2023+. XAU 0.8% signals double. EUR/USD almost never reaches 0.8%. So a fixed-percent rule is mostly a volatility-regime selector.
- The large fixed-threshold index cells lean REVERT and are the only net-positive cells. They are rare and concentrated in crisis years (POST-HOC, REVERT gross by year: NAS100 1.2% h120 2020 +20.8 bps on 174 of 636 trades; SPX500 1.2% h120 2020 +13.6 on 139 of 290; US30 1.2% h30 2020 +6.9 on 275 of 470). A rule that trades only after 1%+ index hours is a bet that crisis-day overshoots revert. It has too few trades to test here (MDE80 above 10 bps).

### Plain-language reading
A 1-hour move above a threshold, checked every 15 minutes, does not tell you which way the next 15 minutes to 2 hours go on WTI. This holds whether the threshold is a fixed percent or a multiple of the usual move for that hour. The direction that looked best in 2018-2022 (continue) reversed in 2023+. Reversion wins slightly more often than it loses, but the losing reversions are bigger, so the average is about 0 before costs. After the bid/ask spread every WTI version loses 4-11 bps per trade. This agrees with fade31, imom34, xvol9/10 and scan46: short-term moves on these instruments do not continue or revert enough to pay the spread.

This is development evidence only. Nothing is registered for prospective follow-up. The index crisis-reversion lean could be registered later, but it needs years of new data to reach usable power.

### Files
- `data/research/engine/audit/roll47/roll47.py` (registered code), `summarize.py`, `posthoc.py` (POST-HOC per-year check)
- `data/research/engine/audit/roll47/prereg.json`, `prereg_comment.md`, `result_comment.md`
- `data/research/engine/audit/roll47/out/counts.json`, `cells.json` (all 720 cells), `verdict.json`, `run.log`, `posthoc.txt`, `cache/*.npz` (M1 extracts of history.db)
- `data/research/engine/trials.jsonl` (720 rows, exp `roll47`)
