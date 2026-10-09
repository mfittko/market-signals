## swing43 result: RSI(2) pullback in an uptrend, held for days: FAIL

Prereg: https://github.com/mfittko/market-signals/issues/310#issuecomment-6082764613 (code and prereg hashes unchanged at run time).

Verdict: FAIL. The pooled index excess is positive in both windows, but the dev CI includes 0. The 2023+ CI clears 0.

### Primary: 8 equity indices pooled, setup close > SMA200 and RSI(2) < 10, exit first close > SMA5 or 10 days (bps per trade, log returns)

| window | n trades | gross mean [CI] | matched drift | excess [CI] | hit (gross / excess) | days held | futures-style net [CI] | CFD net [CI] | MDE80 excess |
|---|---|---|---|---|---|---|---|---|---|
| dev 2005-22 | 1,043 | +24.0 [+1.7, +43.1] | +7.1 | **+16.9 [-6.0, +36.4]** | 0.72 / 0.71 | 3.67 (5.3 nights) | +21.9 [-0.3, +41.0] | +17.5 [-5.0, +36.7] | 29.9 |
| 2023+ (dev window) | 304 | +47.8 [+21.8, +72.8] | +14.1 | **+33.7 [+6.7, +59.8]** | 0.73 / 0.69 | 3.53 (5.2 nights) | +45.7 [+19.7, +70.7] | +41.5 [+15.1, +66.8] | 37.7 |

Trades per year: 58 dev and 81 2023+ across the 8 indices (about 7 and 10 per index). Time in the market is about 10% of days per index.

Ex-ante MDE80 was 19 bps dev. The realized MDE80 is 30 bps, because losing trades in crash years are large. A true excess of about +17 bps per trade cannot be detected in dev with this sample.

Per index, excess dev / 2023+ (n): SPX500 +17.0 / +56.1 [+18.5, +91.1] (139 / 45); NAS100 +12.9 / +50.8 (151 / 37); US30 +8.9 / +21.8 (136 / 45); DE30 +6.5 / +20.4 (141 / 40); UK100 +24.2 / -12.4 (120 / 33); JP225 +22.7 / +81.1 [+25.8, +136.7] (108 / 38); HK33 +33.7 / +44.7 (120 / 31); AU200 +14.0 / -0.8 (128 / 35). All 8 are positive in dev, none with CI above 0. 6 of 8 are positive in 2023+.

Per year (index trades, gross mean excess): positive in 18 of 24 years. The losing years are crash or high-volatility years: 2008 -194 (6 trades), 2011 -110, 2018 -88, 2020 -71, 2022 -44. The hit rate stays at 0.55-0.84 in every year. The loss is in size: a few pullbacks keep falling for 10 days.

### Secondary (never decide the verdict)

- Threshold: RSI(2) < 5 indices excess +19.7 [-11.0, +50.0] dev (n 534), +49.1 [+9.6, +86.0] 2023+ (n 149). RSI(2) < 25 +11.9 [-2.5, +26.0] dev, +9.2 [-12.2, +29.6] 2023+. The deeper the pullback, the larger the excess, as published.
- Down closes: 3 consecutive down closes indices +21.4 [+1.0, +38.9] dev (n 1,078), +19.1 [-5.8, +43.6] 2023+ (n 312). This is the only setup with dev CI above 0 for indices. 2 down closes +6.8 / +7.1, CIs span 0.
- Fixed 5-day exit: indices +11.2 [-11.7, +34.0] dev, +21.1 [-12.6, +54.2] 2023+; hit rate drops to 0.57. The SMA5 exit adds about 5-12 bps and raises the hit rate.
- Short mirror (close < SMA200, RSI(2) > 90): indices +63.5 [+26.7, +98.2] dev (n 497), +11.1 [-79.7, +90.1] 2023+ (n 42). The dev result comes from bear markets (2008, 2022); 2023+ has too few trades.
- Other asset classes: commodities -7.3 [-36.8, +21.0] dev, -63.9 [-134.3, -1.2] 2023+ (pullbacks keep falling). FX +6.8 / +11.8, bonds +7.8 / +14.1, CIs span 0; both are about cost-neutral after CFD financing. All 33 markets +5.5 / +1.4.
- Our 6 trading instruments: -8.3 [-38.3, +20.1] dev, -30.6 [-87.9, +23.0] 2023+. WTI -4.4 / +10.3, XAU +22.6 / +2.2, XAG -62.1 / -103.0, NATGAS -34.9 / -289.9, SPX500 +17.0 / +56.1, EUR/USD -12.6 / -2.6. Only SPX500 is useful from this set.
- Multiplicity: 546 cells logged (7 variants x 6 groups x 2 windows + per instrument). Excess CI above 0 in 47, below 0 in 5. The cells overlap heavily (same trades in several groups and variants), so this count is not a clean multiple-test statistic. It leans positive, mostly in index and short-index cells.

### Reading for a trader who holds index CFDs for days

Buying an equity index CFD at the 17:00 New York close after a 2-day RSI(2) dip below 10, while the index is above its 200-day average, and selling at the first close above the 5-day average, won about 7 of 10 trades. It held about 3.6 trading days. After costs and CFD financing it averaged +17.5 bps per trade in 2005-22 and +41.5 bps in 2023+. That is about 10-25 bps more than holding the same index for the same days in an uptrend. The edge is not proven on 2005-22 data: the confidence interval includes zero. The losses come in crashes (2008, 2011, 2018, 2020, 2022), when a dip becomes a 10-day slide. Without a stop, one such trade erases many winners. On commodities, silver and natural gas the same rule loses. If this is used at all, use it on indices only, at small size, and treat it as a prospective candidate (https://github.com/mfittko/market-signals/issues/313). The 3-down-closes variant and the RSI(2) < 5 variant are the strongest index cells, but they were not the registered test.

### Files
- `data/research/engine/audit/swing43/swing43.py` (imports `audit/ext39/ext39.py`), `prereg_body.json`, `prereg.json`, `prereg_comment.md`, `result_comment.md`
- `data/research/engine/audit/swing43/out/describe.json`, `results.json`, `run.log`, `trades_<variant>.csv` (7 files)
- `data/research/engine/trials.jsonl`: 546 rows, exp swing43
