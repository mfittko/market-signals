## swing44 result: FAIL (positive, but the CI touches 0)

Preregistration: https://github.com/mfittko/market-signals/issues/310#issuecomment-6082862968 (prereg.json sha256 `77ac580a...`, swing44.py `b4cc06dc...`, swing43.py imported unchanged).

Universe: 6 new indices (FR40, EU50, NL25, CH20, SG30, US2000). All 12 candidates were served; ESPIX, CN50, IN50, TWIX, CHINAH and JP225Y were dropped because their history starts after 2010 (JP225Y is also a 0.999 copy of JP225).

### Primary: 6 new indices pooled, RSI(2) < 10, 2005-01..2026-10 (bps per trade, week bootstrap seed 44)

| window | n | weeks | gross | drift | excess [95% CI] | hit (gross > 0) | days held | futures-style | CFD [95% CI] | MDE80 |
|---|---|---|---|---|---|---|---|---|---|---|
| full (decides) | 902 | 405 | +22.9 [+3.5, +43.2] | +5.1 | **+17.9 [-1.7, +38.4]** | 70% | 3.7 | +19.1 | +14.8 [-4.9, +35.2] | 29 |
| 2005-2022 | 704 | 320 | +22.7 | +4.1 | +18.6 [-6.3, +40.7] | 70% | 3.7 | +18.9 | +14.4 | 33 |
| 2023+ | 198 | 85 | +24.0 | +8.8 | +15.2 [-25.0, +50.3] | 71% | 3.6 | +20.2 | +16.0 | 55 |

Verdict: **FAIL**. Both windows are positive, but the full-period CI lower bound is -1.7 bps. The point estimate (+17.9) is almost the same as swing43's dev value (+16.9). The effect replicates in size; the sample cannot separate it from 0. MDE80 is 29 bps, so this test had well under 80% power for an effect of this size.

### Per index (excess, full period)
FR40 +27.3 [-0.4, +52.8], EU50 +33.7 [+2.8, +64.9], NL25 +23.6 [-7.5, +55.4], CH20 +8.0 [-24.3, +37.6], SG30 -26.5 [-67.6, +10.4], US2000 +32.8 [-6.0, +67.6]. Five of six are positive. SG30 is negative in both windows. CH20 is -45 in 2023+ (27 trades).

### Secondary (never decide)
- 3 consecutive down closes (first clean test): +20.9 [+3.4, +36.5] full, n 943; +20.8 [+3.0, +38.2] dev, +21.1 [-15.7, +50.5] 2023+. CFD net +17.9 [+0.3, +33.4]. This variant meets the PASS criterion that applied to the primary. It is one of 2 secondary variants tested here, so it is a strong candidate to register, not a result.
- RSI(2) < 5 (first clean test): +27.5 [-3.6, +54.8] full, n 452; +25.8 dev, +33.7 2023+. Larger per trade, half the trades, CI spans 0.
- 14 indices pooled (swing43 8 + new 6, NOT independent): primary +19.5 [+1.0, +36.0] full (dev +17.6 [-6.1, +36.8], 2023+ +26.4 [-1.0, +52.4]); down3 +20.9 [+6.4, +34.1]; RSI<5 +26.7 [-0.1, +47.9].
- Loss years (excess per trade, primary): 2018 -139 (32 trades, hit 38%), 2016 -38, 2020 -38, 2015 -29, 2022 -22, 2011 -15, 2025 -13. Only 2 trades in 2008 (few closes above SMA200). Best years 2009 +135, 2010 +69, 2017 +61.
- Worst trades: US2000 2011-07-27 -1,852 bps (10 days, August 2011); CH20 2025-03-27 -956 (April 2025 tariff drop); EU50 and NL25 2020-02-21 -899 / -845 (Covid); EU50 and FR40 2015-08-12 -885 / -845. Losers are time-exits during a crash that started inside an uptrend.
- Costs: spreads from history.db only for EU50 (1.41 bps per side); 2 bps per side elsewhere. Futures-style +19.1, CFD +14.8 per trade on 3.7 days held.
- 72 cells in trials.jsonl (exp swing44).

### Reading for a trader holding index CFDs for days
Buying an index after a sharp 2-day dip while it is above its 200-day average, and selling at the first close back above the 5-day average, made about +15 bps per trade after CFD costs on these 6 indices, on top of the normal uptrend drift. That is about 0.15% per trade, 70% winners, held 3 to 4 days, roughly 7 trades per index per year. The losers are rare but large: a dip that turns into a crash (Aug 2011, Aug 2015, Feb 2018, Feb 2020, Apr 2025) costs 8-18% in one trade. The data supports the edge being real and small, but not proven at 95%. The 3-down-closes trigger did better and is the variant to test next.

This is development evidence. A survivor still needs prospective confirmation (https://github.com/mfittko/market-signals/issues/313) or data after 2026-10-07.

Files: `data/research/engine/audit/swing44/` fetch.py, fetch.log, daily.db, swing44.py, prereg_body.json, prereg.json, prereg_comment.md, result_comment.md, out/describe.json, out/results.json, out/run.log, out/trades_{primary,down3,rsi5}.csv.
