## scan46 preregistration: mass backtest of classic chart strategies with a trial-count correction and a locked holdout

This is registered before any outcome run. Only self-checks, the grid listing and bar/day counts ran. No strategy return was computed.

Question: about 45 campaigns found no robust direction edge. Does any strategy in a fixed library of classic TradingView-style strategies earn a positive net Sharpe that survives (1) a Deflated Sharpe Ratio correction for the number of trials, (2) a validation window, and (3) a locked holdout touched once by at most 5 pre-frozen finalists?

Files:
- `data/research/engine/audit/scan46/prereg.json` sha256 `6e7bce2894eb982ea3ffc2b144bb53ef0489fa6780054ff125511f5417db1aa6`
- `data/research/engine/audit/scan46/scan46.py` sha256 `de490de68c2e506751a9e879777cb31ea75c7f716b96a1992a4009ffe08ce268` (`run` refuses to start if the code changed after registration)

### Data and splits
- Daily: `audit/tsmom36/daily.db`, 33 markets (10 FX, 8 indices, 11 commodities, 4 bonds), mid candles closing 17:00 New York. Discovery 2005-01-01..2018-12-31. Validation 2019-01-01..2022-12-31. Second check 2023-01-01..2026-10-08: seen by earlier campaigns, reported as context, never decides.
- H4 and H1: built from `history.db` M1 mid, 2018+. H1 = UTC hours; H4 = 4-hour buckets anchored at 17:00 New York (as swing45). Open = first M1 open, high/low = M1 mid extremes, close = last M1 close. Discovery 2018-2021, validation 2022-2023. The scan builds no intraday bar after 2023-12-31.
- Intraday instruments (all with M1 data): FX EUR/USD, GBP/USD, USD/JPY; indices SPX500, NAS100, US30, DE30, UK100, JP225, AU200, EU50; commodities WTICO, BCO, NATGAS, XAU, XAG, XPT. BTC/USD is excluded (no asset class in this design). No bond has M1 data.
- LOCKED daily holdout: `audit/swing44/daily.db`, only FR40, EU50, NL25, CH20, SG30, US2000, full period. The file is opened only by `scan46.py locked`, which runs after the finalists comment is posted.
- LOCKED intraday window: 2024-01-01..2026-10-08 for H4/H1 finalists. No selection step of this campaign uses it. Earlier campaigns did see this M1 history.
- Day counts: daily discovery 3,319-3,638 days per market, validation 1,007-1,039, 2023+ 925-979; H4/H1 discovery 1,013-1,039 trading dates per instrument, validation 501-518 (H4 8,674-9,347 bars, H1 29,598-37,351 bars per instrument through 2023-12-31). Full list: `audit/scan46/out/describe.json`.

### Execution and costs
- Position +1/0/-1 decided at the bar close from bars up to that close, filled at the next bar open, returns open to open on mid. `tsmom_vol` is the one continuous family (position in [-2, 2]). A fixture changes every bar after t for each of the 303 parameter sets and asserts identical positions up to t (no lookahead, no repainting).
- Costs per side: half the median bid/ask spread from the history.db M1 medians (`tsmom36/out/spreads.json`) where the instrument has one, else 2 bps (as in ext39), charged on each change of position. Financing 0.822 bps per held night (3%/365) on the position; weekends count 3 nights. All selection uses NET returns.
- Pooling per asset class and trading day: mean over instruments with a bar that day of w x net daily return, w = 1% / std of the instrument's previous 60 daily open-to-open returns (inverse-vol, causal). Intraday bar returns are summed per trading date (17:00 NY roll). Sharpe of that pooled daily series, annualized by sqrt(days per year observed).

### Strategy library (27 families, 303 parameter sets per timeframe, 909 parameter-set x timeframe combinations)
Lengths are in bars of the timeframe. Symmetric long/short unless noted.
```
sma_cross (14): fast in {5, 10, 20, 50}; slow in {30, 50, 100, 200}   [fast < slow only]
ema_cross (14): fast in {5, 10, 20, 50}; slow in {30, 50, 100, 200}   [fast < slow only]
price_sma (6): n in {20, 50, 100, 150, 200, 250}
donchian (15): n in {10, 20, 40, 55, 100}; exit_frac in {0.5, 1.0, 0.25}
turtle (4): entry in {20, 55}; exit in {10, 20}; stop_atr in {0, 2}   [pairs (entry, exit) = (20,10), (55,20)]
bb_breakout (18): n in {10, 20, 50}; k in {1.5, 2.0, 2.5}; exit in {mid, opposite}
bb_meanrev (12): n in {14, 20, 50}; k in {1.5, 2.0, 2.5, 3.0}
keltner_breakout (12): n in {10, 20, 50}; mult in {1.0, 1.5, 2.0, 2.5}
rsi_meanrev (16): n in {2, 3, 5, 14}; lo in {5, 10, 15, 20, 25, 30, 35}   [n 2: lo 5,10,20,30; n 3: 5,10,20,30; n 5: 10,15,20,30; n 14: 20,25,30,35; short at 100 - lo]
rsi2_pullback (16): trend in {100, 200}; thr in {5, 10, 15, 25}; exit in {sma5, rsi70}
macd_signal (18): fast in {6, 8, 12}; slow in {17, 26, 39}; signal in {5, 9}
macd_zero (9): fast in {6, 8, 12}; slow in {17, 26, 39}
stoch_meanrev (9): n in {5, 14, 21}; lo in {10, 20, 30}
stoch_cross (6): n in {5, 14, 21}; smooth in {3, 5}
williams_r (12): n in {5, 10, 14, 20}; lo in {5, 10, 20}
cci (18): n in {14, 20, 40}; thr in {100, 150, 200}; mode in {trend, meanrev}
adx_di (15): n in {7, 14, 28}; adx_min in {0, 15, 20, 25, 30}
supertrend (16): atr in {7, 10, 14, 20}; mult in {1.5, 2.0, 3.0, 4.0}
psar (9): step in {0.01, 0.02, 0.03}; max in {0.1, 0.2, 0.3}
ichimoku (8): tenkan in {5, 7, 9, 20}; kijun in {15, 22, 26, 60}; senkou in {30, 44, 52, 120}; cloud in {0, 1}   [tuples (tenkan, kijun, senkou) = (9,26,52), (7,22,44), (20,60,120), (5,15,30)]
heikin_ashi (9): confirm in {1, 2, 3}; smooth in {0, 5, 10}
nbar_mom (7): n in {5, 10, 20, 40, 60, 120, 250}
tsmom_vol (8): lookback in {21, 63, 126, 252}; vol in {20, 60}
aroon (12): n in {14, 25, 50, 100}; thr in {0, 40, 70}
inside_bar (8): hold in {1, 3, 5, 10}; filter in {none, sma200}
nr_breakout (8): k in {4, 7}; hold in {1, 3, 5, 10}
consec_pullback (4): down in {2, 3, 4, 5}
```
Rules in brief: crosses and sign rules are always in the market (sma/ema cross, price vs SMA, MACD signal and zero, stochastic K vs its SMA, N-bar momentum, tsmom_vol, ADX/DI with adx_min 0, Supertrend, PSAR, Ichimoku without cloud). Donchian: close beyond the prior n-bar high/low enters, exit beyond the prior (n x exit_frac)-bar opposite extreme (frac 1.0 = always in). Turtle: same with 20/10 and 55/20, optional 2 x ATR(20) stop. Bollinger breakout: close beyond the band, exit at the middle or by reversal at the opposite band. Bollinger, RSI, Williams %R, stochastic and CCI mean reversion: enter at the extreme, exit at the middle (50 / -50 / 0). Keltner: close beyond EMA +- mult x ATR, exit at the EMA. ADX: DI+ vs DI- only while ADX > adx_min. Ichimoku cloud: Tenkan/Kijun sign only when the close is beyond the displaced cloud. Heikin-Ashi: switch after k candles of one color, optional EMA pre-smoothing. Aroon: up minus down beyond +-thr. Inside bar / NRk: close beyond the pattern bar's range within 3 bars, held `hold` bars (inside bar optionally only with the SMA200 side). RSI(2) pullback and consecutive-close pullback (the swing44 rule as reference): long only, close > SMA(trend) and the dip trigger, exit close > SMA5 (or RSI(2) > 70) or after 10 bars.

### Selection (fixed)
1. Trial cell = parameter set x timeframe x asset class. Discovery net Sharpe per cell.
2. Deflated Sharpe Ratio per timeframe. N = class cells in that timeframe: daily 303 x 4 = 1,212; H4 303 x 3 = 909; H1 303 x 3 = 909 (3,030 in total). V = sample variance of the per-day discovery Sharpe across those cells. SR0 = sqrt(V) x ((1 - g) x Phi^-1(1 - 1/N) + g x Phi^-1(1 - 1/(N e))), g = 0.5772. DSR = Phi((SR - SR0) x sqrt(T - 1) / sqrt(1 - skew x SR + (kurt - 1)/4 x SR^2)) with each cell's own T, skew and kurtosis. Keep DSR > 0.95. (The fixture reproduces the paper's example, DSR 0.9004.)
3. Keep cells with pooled net Sharpe > 0 on validation in the same class.
4. Rank by min(discovery, validation) annualized net Sharpe. Freeze at most 5 finalists, no de-duplication. Post them as a second comment before the locked data is opened. Zero survivors = FAIL with no locked test.
5. Locked test: daily index finalists on the 6 swing44 indices pooled (EU50 half its median spread per side, the others 2 bps). Daily finalists of another class: no locked data exists; prospective paper tracking only. H4/H1 finalists: 2024-01-01..2026-10-08 on the same class instruments.
6. PASS per finalist: locked net Sharpe > 0 and moving-block bootstrap 95% CI lower bound > 0 (20-day blocks, 1,000 reps, seed 46).

### Reported, never decides
- Overfitting illustration: class cells with naive one-sided p < 0.05 (PSR against 0 > 0.95) versus DSR > 0.95, per timeframe; approximate naive count over the 20,301 instrument cells.
- Shrinkage: Spearman rho of discovery vs validation Sharpe; validation Sharpe of the discovery top 10 and top 1%.
- Rank of `consec_pullback(down=3)` on daily indices (the swing44 rule, here with next-open fill and net Sharpe).
- Finalists: discovery / validation / 2023+ / locked net Sharpe with block-bootstrap CIs, trades per year per instrument, max drawdown at 10% annualized vol.

### Trials log
`trials.jsonl`, exp `scan46`: one row per parameter set x timeframe x instrument (Sharpe per window), 303 x (33 + 17 + 17) = 20,301 rows; one row per class cell with DSR (3,030 rows); one row per locked test.

### Power
Annualized Sharpe SE is about 1 / sqrt(years). The daily locked set (about 20 years) can confirm a Sharpe of about 0.45 or more; the 2.8-year intraday locked window only about 1.2 or more.

This is development evidence. A PASS still needs prospective confirmation (https://github.com/mfittko/market-signals/issues/313).
