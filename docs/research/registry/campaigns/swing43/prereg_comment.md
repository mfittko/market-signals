## swing43 preregistration: RSI(2) pullback in a long-term uptrend, held for days (swing loop, test 1)

This is registered before any outcome run. Only synthetic self-checks and trade counts ran. No trade return, drift or excess was computed.

Question: when an instrument is in a long-term uptrend and has a short pullback, does buying and holding a few days earn more than the trend's normal drift? Published claim: Connors-style short-term pullback buying, strongest on equity indices.

Files:
- `data/research/engine/audit/swing43/prereg.json` sha256 `b11f1508e36138c59dce3f99b19e0c337f651c74a0e9428c9e8afdd8f29c5ba2`
- `data/research/engine/audit/swing43/swing43.py` sha256 `52be7a2df33fe8d3b0fcaa45c8cea5b7c04c31bfd85ba770843cf59325148e75` (imports `ext39.py` for data loading, week bootstrap and cost constants)
- Data: `audit/tsmom36/daily.db` (33 OANDA daily mid series, bars close 17:00 New York, weekend stubs dropped), read-only. Spreads: `audit/tsmom36/out/spreads.json`. Nothing fetched.

### Definitions
- Setup at the close of day t: close > SMA(200) and Wilder RSI(2) on closes < 10. Long only.
- Entry at the close of day t. Exit at the first later close above SMA(5), or at the close 10 trading days after entry, whichever comes first.
- One open trade per instrument. The next entry needs a setup bar after the previous exit bar. Trades with no exit bar in the data are dropped.
- Trade return: ln(exit close / entry close).
- Matched drift: mean daily log return of the same instrument over all days in the same window whose prior close was above SMA(200), times the trading days held. Excess = trade return minus matched drift. This removes the plain uptrend drift.
- Windows by entry date: dev 2005-01-01..2022-12-31; 2023-01-01..2026-10-08. The 2023+ window is a development window, not a holdout.
- Costs (reported only): futures-style = gross minus half the median spread per side (2 bps per side where no spread exists, e.g. HK33). CFD = futures-style minus 0.822 bps per calendar night held (3%/365).

### Test
- PRIMARY: the 8 equity indices (SPX500, NAS100, US30, DE30, UK100, JP225, HK33, AU200) pooled, equal weight per trade. Statistic: mean excess in bps per trade.
- CI: cluster bootstrap by ISO calendar week of the entry date, 1000 reps, seed 43, percentile 95% (ext39 helper).
- PASS if the pooled index mean excess is above 0 with CI lower bound above 0 in BOTH windows. Otherwise FAIL. One test.
- Trade counts: dev 1,043 trades in 410 weeks (AU200 128, DE30 141, HK33 120, JP225 108, NAS100 151, SPX500 139, UK100 120, US30 136). 2023+ 304 trades in 113 weeks (35, 40, 31, 38, 37, 45, 33, 45).
- Ex-ante power: with an assumed trade SD of about 220 bps, MDE80 is about 19 bps dev and 35 bps 2023+.
- Secondary results never decide the verdict: RSI(2) < 5 and < 25; 2 and 3 consecutive down closes instead of RSI; fixed 5-day exit; short mirror in downtrends (close < SMA200, RSI(2) > 90, exit below SMA5, financing charged on shorts too); groups commodities, FX, bonds, our 6 trading instruments (WTI, XAU, XAG, NATGAS, SPX500, EUR/USD), all 33; per instrument; per year; gross, drift, futures-style and CFD net with CIs; hit rate; days held; trades per year; MDE80. All cells go to trials.jsonl (exp swing43).

This is development evidence only. Any survivor needs prospective confirmation (https://github.com/mfittko/market-signals/issues/313) or data after 2026-10-07.
