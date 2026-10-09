## swing44 preregistration: out-of-sample replication of swing43 on 6 new equity indices (swing loop, test 2)

This is registered before any outcome run. Only the data fetch, self-checks, history and correlation checks and trade counts ran. No trade return, drift or excess was computed.

Question: swing43 found a positive excess for the RSI(2) pullback on 8 equity indices that missed only the dev CI. Does the same rule, unchanged, earn more than the uptrend drift on indices that swing43 never saw?

Files:
- `data/research/engine/audit/swing44/prereg.json` sha256 `77ac580a69f4e571a5777bbcf0aa4eada6c03d9f199110e3b8cecfa7dc1d6878`
- `data/research/engine/audit/swing44/swing44.py` sha256 `b4cc06dc5041a4477f9a1981b56eef777a1a73dabc156716aaca759a6b5bab70` (imports `swing43.py` unchanged, sha `52be7a2d...` pinned and checked)
- `data/research/engine/audit/swing44/fetch.py` sha256 `75cb7fa86efbe74e383653f43092c8524f50189b235eddf2eac283f47cee0576` (reuses the tsmom36 proxy request: same URL, headers, 3 s throttle)
- Data: `audit/swing44/daily.db` (new, sha256 `a9dd8347...`), OANDA daily mid, bars close 17:00 New York, last close 2026-10-08.

### Universe
All 12 candidates were served. Rule: first close on or before 2010-12-31 and daily return correlation with every swing43 index at most 0.95.
- Kept (6): FR40 (max corr 0.92 with DE30), EU50 (0.93 DE30), NL25 (0.82 DE30, from 2008-01), CH20 (0.69 DE30), SG30 (0.50 HK33), US2000 (0.89 SPX500).
- Dropped, history starts after 2010: ESPIX (2016-12), CN50 (2011-08), IN50 (2011-08, ends 2022-07), TWIX (2011-08, ends 2023-10), CHINAH (2020-11; 0.97 with HK33), JP225Y (2020-04; 0.999 with JP225, also a near copy).
- Caveat: FR40 and EU50 move closely with DE30, and all trades fall in the same calendar weeks as swing43 trades. The test is independent in instruments, not in market episodes.

### Rule and statistic (unchanged from swing43)
- Setup at the 17:00 NY close: close > SMA(200) and Wilder RSI(2) < 10. Long at that close. Exit at the first close above SMA(5) or after 10 trading days. One open trade per index.
- Excess = trade log return minus the window's mean daily log return on uptrend days (prior close > SMA200) times days held, with the dev drift for 2005-22 trades and the 2023+ drift for 2023+ trades.
- Costs reported only: futures-style = gross minus the median spread (EU50 2.82 bps from history.db; 2 bps per side for the other five). CFD = futures-style minus 0.822 bps per calendar night.

### Test
- PRIMARY: the 6 new indices pooled, all trades with entry 2005-01-01..2026-10-08, mean excess per trade. CI: week-clustered bootstrap (ext39 helper), 1000 reps, seed 44.
- PASS: pooled excess > 0 with CI lower bound > 0, AND the point estimate positive in both 2005-2022 and 2023+. Otherwise FAIL. One test.
- Trade counts: 902 (FR40 156, EU50 153, NL25 144, CH20 148, SG30 131, US2000 170); 704 in 2005-22, 198 in 2023+.
- Ex-ante power: swing43 had MDE80 30 bps for 1,043 trades, so here MDE80 is about 30-33 bps. The swing43 effect (+17 to +34 bps) is at or below that. A FAIL is weak evidence against a small effect.

### Secondary (never decide)
- 3 consecutive down closes and RSI(2) < 5 instead of RSI(2) < 10. Both looked stronger in swing43 but were not registered there, so this is their first clean test.
- Per index; per window; gross, drift, futures-style and CFD net with CIs; hit rate; days held; MDE80; per year and crash years; 10 worst trades.
- Pooled swing43 8 + new 6 (14 indices), labelled not independent.
- 72 cells in trials.jsonl (exp swing44). Only the primary cell decides.

This is development evidence. Any survivor still needs prospective confirmation (https://github.com/mfittko/market-signals/issues/313) or data after 2026-10-07.
