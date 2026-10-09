# Survey: open-source trading strategies and replicated evidence (2026-10-09)

Scope: read-only desk research. Inputs were the campaign queue (items 0 to 48) and public sources cited inline. "Evidence" means peer-reviewed and replicated results, or audited live or index records. "Claim" means a README, a marketing page, a short backtest, or a third-party blog.

## Summary

The harness design is sound. The search space is where the edge is missing. The 48 campaigns mostly test single-instrument direction timing at M1 to D1 on six of the most efficient markets. The literature has almost no replicated, cost-surviving evidence for that kind of timing. Its replicated, cost-surviving results come from three other places:

- Risk premia: carry, the volatility risk premium, and the equity premium itself.
- Cross-sectional sorts over many assets, rebalanced weekly to monthly.
- Low-turnover factor tilts.

The vehicle matters too. CFDs are cheap for intraday trading, but intraday has no edge. CFDs are expensive for anything held for weeks: OANDA charges the basis rate plus 2.5% a year. They also cannot express options. For commodities, OANDA puts the term-structure carry into the financing line, so mid-price candles never contain it. The flat 3% financing that tsmom36 assumed therefore mis-states commodity returns in both directions.

## 1. Open-source trading repositories

| Repo | Strategy types shipped | Asset class, frequency | Evidence status |
|---|---|---|---|
| freqtrade + freqtrade-strategies ([link](https://github.com/freqtrade/freqtrade-strategies)) | Community TA strategies: RSI/BB/EMA/MACD combinations | Crypto spot and perps, mostly 5m to 1h | Backtest and dry-run only. The README says the strategies are for educational purposes only and are a starting point, not ready to use. No live record. |
| Jesse ([example-strategies](https://github.com/jesse-ai/example-strategies)) | Dual Thrust, Donchian, IFR2, KDJ, MACD_EMA, RSI2, SMA crossover, Bollinger, Turtle rules | Crypto, intraday to daily | The repo states it does not provide ready-to-go profitable strategies. No live record. |
| QuantConnect Lean ([alpha models](https://github.com/QuantConnect/Lean/tree/master/Algorithm.Framework/Alphas)) | EmaCross, Macd, Rsi, HistoricalReturns, pairs trading | Multi-asset, minute to daily | Framework examples only. QuantConnect states that Alpha Streams v1 alphas showed generally poor performance out of sample ([forum](https://www.quantconnect.com/forum/discussion/13441/alpha-streams-refactoring-2-0/)). |
| Hummingbot | Pure market making, cross-exchange market making, AMM arbitrage | Crypto CEX/DEX, sub-second to minutes | No audited live record. Economics depend on exchange rebates and liquidity-mining payments ([paper](https://hummingbot.org/liquidity-mining.pdf)). |
| nautilus_trader | Demonstration strategies: ema_cross, grid market making, delta-neutral volatility | Multi-venue, tick to bar | An engine. No performance claims. |
| OctoBot ([repo](https://github.com/Drakkar-Software/OctoBot)) | Grid, DCA, TradingView signal relay, LLM "AI trading" | Crypto | No published backtest or live evidence. |
| FinRL | Deep RL agents (PPO, A2C, DDPG, ensembles) | US stocks daily, crypto | Backtest only. The authors cite backtest overfitting as a core problem ([FinRL-Crypto](https://arxiv.org/abs/2209.05559)). |
| TradingAgents ([repo](https://github.com/TauricResearch/TradingAgents), [paper](https://arxiv.org/abs/2412.20138)) | LLM analyst, researcher, trader and risk agents | 3 US stocks, daily | Paper reports +23 to +27% over about 3 months, no costs modelled. An independent check found the AAPL buy-and-hold baseline wrong: the paper says -5.23%, the actual figure is +9.12% ([critique](https://dev.to/trow126/the-most-starred-llm-trading-paper-claims-buy-and-hold-lost-523-it-actually-gained-912-1jj6)). |
| ai-hedge-fund ([repo](https://github.com/virattt/ai-hedge-fund)) | LLM investor-persona agents | US stocks | The system does not make trades. Educational only. |
| Microsoft qlib ([repo](https://github.com/microsoft/qlib)) | 20+ ML models on Alpha158/Alpha360 features | China CSI300 stocks, daily, cross-sectional | Backtest only. The only repo built around the cross-sectional, many-asset structure the literature supports. |
| Zipline, backtrader, vectorbt examples | MA crossovers, simple momentum, RSI | Generic | Tutorials only. |
| awesome-quant ([list](https://github.com/wilsonfreitas/awesome-quant)) | Library list | n/a | Points to pysystemtrade and machine-learning-for-trading. |

Cross-cutting findings:

- On Quantopian, 888 algorithms with at least 6 months out of sample showed that backtest Sharpe predicts out-of-sample Sharpe with R² below 0.025 ([Wiecki et al.](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2745220)).
- LLM strategies lose their reported advantage over 20 years and 100+ symbols ([FINSABER](https://arxiv.org/abs/2505.07078)).
- None of these repos has an independent live or out-of-sample record of a profitable strategy. Their shipped strategies are the TA families that scan46 rejected under Deflated Sharpe.

## 2. Strategy families with replicated evidence

General calibration:

- Published predictors lose 26% of their return out of sample and 58% after publication ([McLean and Pontiff 2016](https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12365)).
- With value weighting and NYSE breakpoints, 65% of 452 anomalies fail t > 1.96, including 96% of the trading-frictions group ([Hou, Xue and Zhang 2020](https://academic.oup.com/rfs/article-abstract/33/5/2019/5236964)).
- Most factors replicate across 13 themes and 93 countries ([Jensen, Kelly and Pedersen 2023](https://onlinelibrary.wiley.com/doi/full/10.1111/jofi.13249)).
- Anomalies with one-sided monthly turnover below about 50% survive costs. Few with higher turnover do ([Novy-Marx and Velikov 2016](https://www.nber.org/papers/w20721)).

| Family | Evidence quality | Survives retail costs? | Instrument, frequency, vehicle |
|---|---|---|---|
| Equity factors (value, momentum, quality, low vol), monthly | Replicated (JKP 2023). Momentum works across asset classes (Asness, Moskowitz and Pedersen 2013). | Factors yes at low turnover. Productised smart-beta indexes beat the market by about 2.8% a year before ETF listing and about -0.4% after ([Smart Beta Mirage](https://www.cambridge.org/core/services/aop-cambridge-core/content/view/35CA1CEA091A485DDA960BB2D9930BC9/S0022109023000674a.pdf/the-smart-beta-mirage.pdf)). | Hundreds of stocks, monthly, cash equities or factor ETFs. |
| Post-earnings announcement drift | Strong originally. Gone for large caps since about 2006 ([Martineau](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3111607)). | No for liquid names. | Single stocks, days to weeks. |
| Earnings announcement premium | Frazzini and Lamont 2007; [Savor and Wilson 2016](https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12361); global replication ([JFE 2013](https://www.sciencedirect.com/science/article/abs/pii/S0304405X12002188)). | Plausibly. | Single stocks, days. Needs an earnings calendar. |
| Short-term reversal in single stocks | Jegadeesh 1990, Lehmann 1990. Net 30-50 bps/week in large caps with low-turnover construction ([de Groot, Huij and Zhou 2012](https://repub.eur.nl/pub/25718)). Residual reversal ([Blitz et al. 2013](https://ideas.repec.org/a/eee/finmar/v16y2013i3p477-504.html)). | Only with careful construction. | Liquid stocks, weekly, long-short. |
| Index reconstitution | S&P 500 addition effect fell from 7.4% in the 1990s to under 1% in the 2010s ([Greenwood and Sammon 2025](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4294297)). | No. | Single stocks, event days. |
| FX carry | Replicated ([Menkhoff et al. 2012](https://ideas.repec.org/a/bla/jfinan/v67y2012i2p681-718.html)). Mostly the dollar component; dollar-neutral carry is negatively skewed ([Daniel, Hodrick and Lu 2017](https://www.nber.org/papers/w20433)). | Doubtful on CFDs. | Forwards or futures, monthly. |
| Commodity carry / term structure | [Koijen, Moskowitz, Pedersen and Vrugt 2018](https://ideas.repec.org/a/eee/jfinec/v127y2018i2p197-225.html); [Szymanowska et al. 2014](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1343809); [Bakshi, Gao and Rossi 2019](https://pubsonline.informs.org/doi/10.1287/mnsc.2017.2840). Weak live record: iShares CCRV returned about 3.5% a year over 3 years and was liquidated in Aug 2025 ([etfdb](https://etfdb.com/etf/CCRV/)). | Yes as futures, monthly roll. | 15-25 commodity futures, monthly. |
| Volatility risk premium (option selling) | Cboe PUT 1986-2018: Sharpe 0.65 vs 0.49 for SPX, max drawdown 33% vs 51% ([Bondarenko 2019](https://cdn.cboe.com/resources/education/research_publications/PutWriteCBOE19_v14_by_Prof_Oleg_Bondarenko_as_of_June_14.pdf)). Short-vol component Sharpe near 1 ([Israelov and Nielsen](https://papers.ssrn.com/sol3/Papers.cfm?abstract_id=2444999)). Tail: XIV lost about 96% on 5 Feb 2018 ([Nasdaq](https://www.nasdaq.com/articles/volatility-spike-triggers-inverse-etf-xiv-closure-2018-02-07)). | Yes for monthly index puts. Retail 0DTE traders lose ([Beckmeyer, Branger and Gayda](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4404704)). | SPX/SPY options, monthly. Not possible on CFDs. |
| Crypto funding-rate carry / basis | Above 40% a year at times ([BIS WP 1087](https://ideas.repec.org/p/bis/biswps/1087.html)); the update says Sharpe falls in 2024 and turns negative in 2025. | Decayed. | Crypto perps and spot. |
| Crypto momentum | [Liu, Tsyvinski and Wu 2022](https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.13119). Short sample. | Uncertain. | Many coins, weekly. |
| Pairs / stat-arb | Gatev et al. 2006; declining over time ([Do and Faff 2010](https://research.monash.edu/en/publications/does-simple-pairs-trading-still-work/)). | Marginal after costs. | Many stocks, daily. |
| Market making | Profits concentrate in the fastest firms ([Baron, Brogaard, Hagströmer and Kirilenko 2019](https://econpapers.repec.org/RePEc:cup:jfinqa:v:54:y:2019:i:03:p:993-1024_00)). | No for retail. limit13 measured adverse selection cancelling the spread saving. | Colocated access with maker rebates. |
| Sector/country ETF momentum, dual momentum | Moskowitz and Grinblatt 1999; Asness, Moskowitz and Pedersen 2013. Practitioner out-of-sample weak ([quant4free](https://quant4free.com/analysis/dual-momentum/)); Faber timing mixed ([SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=962461)). | Yes on cost. Moderate edge evidence. | 10-30 ETFs, monthly. |
| Time-series momentum / trend | A century over 67 markets ([Hurst, Ooi and Pedersen 2017](https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing)). Audited CTA index records exist. | Yes as futures. Killed on CFDs by financing (tsmom36). | 30-60 futures. |
| Daily index short-term reversal (swing43/44 pullback) | Index serial dependence switched from positive to negative after 2000 in 20 indices, linked to index products ([Baltussen, van Bekkum and Da 2019](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2786516)). | Yes at daily frequency. Not intraday (swing45). | Index futures, ETFs or CFDs, days. |

## 3. Mapping against the campaign queue

| Family | Status | Campaigns |
|---|---|---|
| Intraday TA (supertrend, fades, ORB, session breaks, volume, flow, lead-lag, rolling thresholds) | Tested, failed | items 1-16, 24-35, 45, 47 |
| Classic indicator families (what the repos ship) | Tested, failed | scan46 |
| LLM-as-judge filters | Tested, failed | filter316 |
| Time-series momentum | Partly tested on CFD mids with flat financing; commodity carry mis-specified | tsmom36, mw6 |
| Volatility-managed exposure | Tested, failed | vm40 |
| Calendar, overnight, intraday momentum | Tested, failed | cal37, night38, imom34 |
| Extreme-move continuation | Tested, failed out of sample | ext39, cmd41 |
| Pairs / relative value | Partly tested (no equity cross-section) | pairs16 |
| Daily index pullback | Partly tested, positive, not significant; forward test pending | swing43, swing44 |
| Intraday seasonality | Queued, not run | item 17 |
| Commodity carry, FX carry, volatility risk premium, single-stock factors, single-stock reversal, earnings premium, sector/country ETF momentum | Not tested | |
| Index reconstitution, PEAD, crypto carry | Not tested; evidence says they are gone or need other accounts | |
| Market making | Effectively tested | limit13 |

## 4. Wrong instruments, wrong frequency or wrong vehicle?

All three apply, in this order.

Frequency is the main problem. In swing45 the spread is 50-60% of the mean absolute move at M1, 25-30% at M5, 4-5% at H4 and 1-2% at daily. No replicated result supplies an intraday direction edge large enough for index, oil, metals or EUR/USD. Fewer than 1% of Taiwan day traders earn reliable abnormal returns net of fees ([Barber, Lee, Liu and Odean 2014](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=529063)). Plus500's mandatory disclosure is about 76-82% of retail CFD accounts losing money ([Plus500](https://x.com/Plus500/status/2023405296966611228)).

Instrument breadth is the second problem. Six instruments allow only time-series timing, the weakest-evidence category. The replicated premia are cross-sectional or structural.

The vehicle is the third problem once holding periods lengthen.

- OANDA charges the basis rate plus 2.5% on longs and credits basis minus 2.5% on shorts ([OANDA](https://help.oanda.com/bvi/en/faqs/financing-costs.htm)).
- A third-party measurement puts Plus500's S&P 500 long financing at about 8.9% a year ([BrokerChooser](https://brokerchooser.com/broker-reviews/plus500-review/cfd-financing-rate)). This is an estimate; check it on the platform.
- Futures embed financing at about the risk-free rate. A cash ETF has only an expense ratio and a spread under 1 bp. Options have no CFD equivalent.
- tsmom36 runs about 2.3x gross notional, so a 2.5% markup costs about 5.8% a year, more than its gross return of about 3.4%.
- For the swing43/44 pullback (3.6 days held), a full rate of about 8.9% costs about 9 bps per trade, roughly half of the +17-21 bps edge.

Commodity mis-specification: OANDA prices commodity CFDs from the next futures contract at a basis rate derived from the futures curve, so contango and backwardation reach the trader through financing, not price ([OANDA](https://help.oanda.com/uk/en/faqs/commodity-financing-cost-variation.htm)). OANDA mid candles contain no roll yield. Plus500's oil and gas CFDs are futures-based with a valuation change at rollover ([Plus500](https://www.plus500.com/en-ae/tradingacademy/tradersguide/what-is-a-rollover~5)). The correct research series for commodities is futures data.

EU caveat: PRIIPs blocks retail purchase of US-domiciled ETFs at EU brokers ([explainer](https://ucitsincome.com/learn/why-cant-i-buy-us-etfs)). Confirm what an Alpaca international account allows.

## 5. Shortlist of untested, feasible ideas

1. Commodity carry (term structure), monthly. Rank about 20 CME commodities by annualized log(F1/F2); long the top tercile, short the bottom tercile at equal risk. Data: Databento front and second contracts, a few dollars. PASS: Sharpe CI lower bound > 0 over 2010-22, positive 2023+, positive net after financing.
2. Volatility risk premium via monthly index put writing. Test the Cboe PUT index excess return over its beta-matched SPX and T-bill mix, 2007-22 and 2023+, with 2008, 2018 and 2020 drawdowns reported. Data free. Vehicle: options, not CFDs.
3. Weekly residual short-term reversal in the top 500 US stocks, market-neutral, 3 bps per side. Data: Massive daily bars with delisted tickers. Vehicle: Alpaca.
4. Sector and country ETF relative momentum, top 3 of about 30 by 12-1 month return, monthly. Data: Massive. Vehicle: ETFs (UCITS if EU).
5. Earnings announcement premium in large caps, t-5 to t-1. Gating item: a historical earnings calendar.
6. FX carry on CFD terms, G10, monthly, 2.5% per leg. Data local, cost zero. Expected to fail; it closes the question.

Left out on purpose: PEAD and index reconstitution (gone), crypto carry (decayed, needs a perp account), market making (no retail rebates; limit13), single-stock factor tilts (an allocation, not a tradable edge), managed futures (history cannot settle it at tsmom36's power).

The daily index pullback keeps the strongest combined evidence: our own data plus Baltussen et al. 2019. It stays the forward-test priority in https://github.com/mfittko/market-signals/issues/323. Run it on a futures or ETF vehicle alongside the CFD to measure the financing difference directly.
