## tsmom36 preregistration: diversified slow time-series momentum on 33 daily markets

This is registered before any outcome run. Only the data fetch, synthetic self-checks and a data description ran. No strategy return was computed on real data.

Why: every intraday test so far failed (queue rows 1-35). The strongest published evidence is slow time-series momentum across many markets (Moskowitz, Ooi and Pedersen 2012; Hurst, Ooi and Pedersen 2017). mw6 (row 6) and rescan26 (row 26) tested 120-day momentum on only 6 instruments. The pooled gross was about +0.07-0.08 R in both windows, but it failed with the 20-day block bootstrap. Diversification across many weakly correlated markets is what makes the effect detectable. tsmom36 tests that.

Files:
- `data/research/engine/audit/tsmom36/prereg.json` sha256 `8a7792a9b2ee290741445cc7442b36d04b541771a920f73a5f2bada0b50580e8`
- `data/research/engine/audit/tsmom36/tsmom36.py` sha256 `74ba7bfd60076dc89b0348a28d03526eeab7cd5d1bc20e217fbfe35fbdd53e30`
- `data/research/engine/audit/tsmom36/fetch.py` sha256 `087880eac46e0936e8d4eb70fac92c3a4703b311e44a2a9b1bd05b5b7ee4872b`
- Data: `audit/tsmom36/daily.db` (new). OANDA daily mid candles through the FXEmpire proxy that `pipeline/history.py` uses, dailyAlignment 17:00 America/New_York, fetched 2026-10-09. history.db is opened read-only, for spreads only.

### Universe (33 of 33 requested were served)
- FX (10): EUR_USD, GBP_USD, USD_JPY, AUD_USD, USD_CAD, USD_CHF, NZD_USD, EUR_JPY, EUR_GBP, AUD_JPY. Start 2002-05 (NZD_USD 2002-09, AUD_JPY 2004-06).
- Indices (8): SPX500, NAS100, US30, DE30, UK100, JP225, AU200, HK33. Start 2003-02..2003-03 (AU200 2004-03).
- Commodities (11): WTICO, BCO, NATGAS, XAU, XAG, XCU, XPT, CORN, WHEAT, SOYBN, SUGAR. Start 2003 (XPT 2005-01, XAU/XAG 2006-03).
- Bonds (4): USB10Y, USB30Y, DE10YB, UK10YB. Start 2003-03..2003-06.
- Data rule: trading date = bar close date. Early-year weekend stub bars (close on Saturday/Sunday) are dropped.

### Strategy (fixed)
- At the last trading date m of each month: s = sign of the trailing 252-bar return of each instrument (own bars).
- Ex-ante vol: annualized (x261) exponentially weighted variance of daily returns, center of mass 60 days (as in MOP 2012), using closes up to m.
- Position w = s x min(0.40 / vol, 3). Eligible: at least 300 own bars at m.
- Portfolio weight = w / N_m, where N_m is the eligible count (equal risk weight).
- No lookahead: the decision is at the close of m and the trade fills at the close of the next trading date m+1. The first return it earns is on m+2. Weights are held constant for the month.
- Daily portfolio return = sum of weight x instrument daily mid return. Gross, mid.

### Windows
- dev 2005-01-01..2022-12-31. 2005 is the first full year with at least 10 eligible instruments (minimum 28 in 2005, all 33 from 2008).
- w2023 2023-01-01..2026-10-08. This is a second development window, not a holdout.

### Primary test
- All 33 instruments, lookback 252, gross annualized Sharpe ratio of daily portfolio returns.
- Moving-block bootstrap of daily returns, block 20, 1000 reps, seed 36, percentile 95% CI.
- PASS if the Sharpe CI lower bound is above 0 in BOTH windows. Otherwise FAIL.

### Net (secondary)
- Cost per side = half the median M1 close spread (relative to mid, all hours, 2018+) from history.db `candles_ba` for the 16 instruments there. Examples: SPX500 0.95 bps, EUR_USD 1.31, XAU 1.76, WTICO 4.62, NATGAS 22.5, XPT 20.2 (full spread). A flat 2 bps per side applies to the other 17. Cost is charged on the change in portfolio weight at each rebalance.
- Financing is an ASSUMPTION: 3% per year of absolute notional, long and short alike, charged daily.

### Secondary (never decides the verdict)
Lookbacks 63 and 126; the equal-weight blend of the 63/126/252 position vectors (Hurst et al.); per asset class; our 6 trading instruments alone (compare with mw6); net Sharpe; max drawdown; correlation with buy-and-hold SPX500; yearly returns; power (MDE80 = 2.8 x bootstrap sd of the Sharpe). Every cell is logged to `trials.jsonl` with exp `tsmom36`.

### Declared deviations from the literature
OANDA CFD mid prices instead of futures excess returns. Non-USD indices and bonds use the local-currency price change. Commodity and bond CFD prices follow OANDA's rolled reference. Rebalance at the next day's close instead of the month-end close.
