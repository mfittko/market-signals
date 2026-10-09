# Sources

This page lists the external sources the research relies on. Each entry has a one-line takeaway and a credibility note. Most entries come from the 2026-10-09 desk survey and from the external reviews. Entries without a URL were cited by name in a campaign protocol; their URL was not recorded.

Credibility notes use these terms:

- Peer-reviewed and replicated: published in a refereed journal and reproduced by others.
- Peer-reviewed: published, one study.
- Working paper: SSRN, NBER or arXiv, not yet refereed or refereed later.
- Vendor or broker document: describes a product; reliable for the product's terms, not for performance.
- Practitioner or blog: unaudited analysis.
- Repository: code, no audited performance.

## Market efficiency and replication

| Source | Takeaway | Credibility |
|---|---|---|
| [McLean and Pontiff 2016](https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12365) | Published predictors lose 26% of their return out of sample and 58% after publication. | Peer-reviewed and replicated. |
| [Hou, Xue and Zhang 2020](https://academic.oup.com/rfs/article-abstract/33/5/2019/5236964) | With value weighting and NYSE breakpoints, 65% of 452 anomalies fail t > 1.96, including 96% of trading-friction anomalies. | Peer-reviewed. |
| [Jensen, Kelly and Pedersen 2023](https://onlinelibrary.wiley.com/doi/full/10.1111/jofi.13249) | Most factors replicate across 13 themes and 93 countries. | Peer-reviewed. |
| [Novy-Marx and Velikov 2016](https://www.nber.org/papers/w20721) | Anomalies with one-sided monthly turnover below about 50% survive costs; few with higher turnover do. | Peer-reviewed. |
| [Wiecki et al. 2016](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2745220) | On 888 Quantopian algorithms, backtest Sharpe predicts out-of-sample Sharpe with R squared below 0.025. | Working paper with a large real sample. |
| [Bailey and Lopez de Prado 2014, Deflated Sharpe Ratio](https://doi.org/10.3905/jpm.2014.40.5.094) | Corrects the Sharpe ratio for selection over many trials and for non-normal returns. Used by scan46. | Peer-reviewed; method paper. |

## Retail trading and costs

| Source | Takeaway | Credibility |
|---|---|---|
| [Barber, Lee, Liu and Odean 2014](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=529063) | Fewer than 1% of Taiwan day traders earn reliable abnormal returns net of fees. | Peer-reviewed, full-market data. |
| [Plus500 risk disclosure](https://x.com/Plus500/status/2023405296966611228) | About 76 to 82% of retail CFD accounts lose money. | Mandatory broker disclosure. |
| [Beckmeyer, Branger and Gayda](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4404704) | Retail 0DTE option traders lose. | Working paper. |
| [Baron, Brogaard, Hagstromer and Kirilenko 2019](https://econpapers.repec.org/RePEc:cup:jfinqa:v:54:y:2019:i:03:p:993-1024_00) | Market-making profits concentrate in the fastest firms. | Peer-reviewed. |

## Brokers and vehicles

| Source | Takeaway | Credibility |
|---|---|---|
| [OANDA financing costs](https://help.oanda.com/bvi/en/faqs/financing-costs.htm) | Longs pay the basis rate plus 2.5% a year; shorts receive the basis minus 2.5%. | Broker document. |
| [OANDA commodity financing](https://help.oanda.com/uk/en/faqs/commodity-financing-cost-variation.htm) | Commodity CFDs are priced from the next futures contract; contango and backwardation reach the trader through financing. | Broker document. |
| [OANDA financing methodology (UK)](https://www.oanda.com/uk-en/trading/financing-costs/) and [commodity funding (BVI)](https://www.oanda.com/bvi-en/cfds/financing-costs/) | Separate long and short rates, possible credits, commodity basis link. Cited by the external review. | Broker document; terms differ by entity. |
| [BrokerChooser on Plus500 financing](https://brokerchooser.com/broker-reviews/plus500-review/cfd-financing-rate) | S&P 500 long financing estimated at about 8.9% a year. | Third-party estimate; check on the platform. |
| [Plus500 rollover](https://www.plus500.com/en-ae/tradingacademy/tradersguide/what-is-a-rollover~5) | Oil and gas CFDs are futures-based with a valuation change at rollover. | Broker document. |
| [PRIIPs and US ETFs](https://ucitsincome.com/learn/why-cant-i-buy-us-etfs) | EU retail investors cannot buy US-domiciled ETFs at EU brokers. | Practitioner explainer. |

## Momentum, trend and carry

| Source | Takeaway | Credibility |
|---|---|---|
| [Hurst, Ooi and Pedersen 2017](https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing) | Trend following worked over a century and 67 markets. | Peer-reviewed; long sample. |
| Moskowitz, Ooi and Pedersen 2012, time-series momentum | Base reference for tsmom36. | Peer-reviewed and replicated. URL not recorded. |
| Asness, Moskowitz and Pedersen 2013 | Value and momentum appear across asset classes. | Peer-reviewed and replicated. URL not recorded. |
| [Menkhoff et al. 2012](https://ideas.repec.org/a/bla/jfinan/v67y2012i2p681-718.html) | FX carry returns are replicated. | Peer-reviewed. |
| [Daniel, Hodrick and Lu 2017](https://www.nber.org/papers/w20433) | FX carry is mostly the dollar component; dollar-neutral carry is negatively skewed. | Peer-reviewed. |
| [Koijen, Moskowitz, Pedersen and Vrugt 2018](https://ideas.repec.org/a/eee/jfinec/v127y2018i2p197-225.html) | Carry predicts returns across asset classes, including commodities. | Peer-reviewed. |
| [Szymanowska et al. 2014](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1343809) | Commodity term-structure premia. | Peer-reviewed. |
| [Bakshi, Gao and Rossi 2019](https://pubsonline.informs.org/doi/10.1287/mnsc.2017.2840) | Commodity factor model with carry. | Peer-reviewed. |
| [Gorton, Hayashi and Rouwenhorst](https://www.nber.org/papers/w13249) | Commodity futures returns link to inventories and the basis. Cited by the external review. | Working paper, later published. |
| [iShares CCRV record](https://etfdb.com/etf/CCRV/) | A commodity carry ETF returned about 3.5% a year over 3 years and was liquidated in August 2025. | Live product record. |
| Moskowitz and Grinblatt 1999 | Industry momentum. | Peer-reviewed. URL not recorded. |
| [quant4free on dual momentum](https://quant4free.com/analysis/dual-momentum/) | Out-of-sample dual momentum is weak. | Practitioner. |
| [Faber, tactical asset allocation](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=962461) | Trend timing of asset classes; later evidence mixed. | Working paper. |
| [Smart Beta Mirage](https://www.cambridge.org/core/services/aop-cambridge-core/content/view/35CA1CEA091A485DDA960BB2D9930BC9/S0022109023000674a.pdf/the-smart-beta-mirage.pdf) | Smart-beta indexes beat the market by about 2.8% a year before ETF listing and about -0.4% after. | Peer-reviewed. |

## Short-term reversal and daily patterns

| Source | Takeaway | Credibility |
|---|---|---|
| [Baltussen, van Bekkum and Da 2019](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2786516) | Index serial dependence switched from positive to negative after 2000 in 20 indices, linked to index products. Supports the daily pullback. | Peer-reviewed. |
| Connors and Alvarez 2008 | The RSI(2) pullback rule tested in swing43. | Practitioner book. URL not recorded. |
| Jegadeesh 1990, Lehmann 1990 | Short-term reversal in single stocks. | Peer-reviewed and replicated. URL not recorded. |
| [de Groot, Huij and Zhou 2012](https://repub.eur.nl/pub/25718) | Large-cap reversal nets 30 to 50 bps per week with low-turnover construction. | Peer-reviewed. |
| [Blitz et al. 2013](https://ideas.repec.org/a/eee/finmar/v16y2013i3p477-504.html) | Residual reversal. | Peer-reviewed. |
| Gao, Han, Li and Zhou 2018 | Market intraday momentum: the first half hour predicts the last half hour. Failed on SPX500 CFDs in imom34. | Peer-reviewed. URL not recorded. |
| Cliff, Cooper and Gulen 2008; Kelly and Clark 2011; Lou, Polk and Skouras 2019 | Equity returns accrue overnight. Not supported net in night38. | Peer-reviewed. URLs not recorded. |
| Wen et al. | The EIA release half hour predicts the last half hour in oil. Reversed in 2023+ in orb15. | Cited by name in the orb15 protocol. Full reference and status not recorded. |

## Volatility

| Source | Takeaway | Credibility |
|---|---|---|
| Moreira and Muir 2017; Cederburg et al. 2020 | Volatility-managed portfolios: claimed Sharpe gains, later disputed out of sample. vm40 finds a drawdown limiter, not a Sharpe gain. | Peer-reviewed. URLs not recorded. |
| [Bondarenko 2019, Cboe PUT index](https://cdn.cboe.com/resources/education/research_publications/PutWriteCBOE19_v14_by_Prof_Oleg_Bondarenko_as_of_June_14.pdf) | PUT 1986-2018 Sharpe 0.65 vs 0.49 for SPX; max drawdown 33% vs 51%. | Index-provider research by an academic. |
| [Israelov and Nielsen](https://papers.ssrn.com/sol3/Papers.cfm?abstract_id=2444999) | The short-volatility component of covered calls has a Sharpe near 1. | Working paper. |
| [XIV closure, Nasdaq](https://www.nasdaq.com/articles/volatility-spike-triggers-inverse-etf-xiv-closure-2018-02-07) | An inverse volatility product lost about 96% on 5 February 2018. | News record of a tail event. |

## Events, news and order flow

| Source | Takeaway | Credibility |
|---|---|---|
| [Andersen, Bollerslev, Diebold and Vega](https://www.nber.org/papers/w8959) | Macro announcement surprises drive exchange-rate jumps. | Peer-reviewed. |
| [EIA Weekly Petroleum Status Report](https://www.eia.gov/petroleum/supply/weekly/) | Release content, archive and schedule; the schedule has exceptions. | Official data source. |
| [EIA, factors affecting natural gas prices](https://www.eia.gov/energyexplained/natural-gas/factors-affecting-natural-gas-prices.php) | Weather, storage, production and trade drive gas prices. | Official explainer. |
| [NOAA GEFS](https://emc.ncep.noaa.gov/emc/pages/numerical_forecast_systems/gefs.php/) | Operational forecasts and reforecasts are different datasets. | Official data source. |
| [Cont, Kukanov and Stoikov](https://arxiv.org/abs/1011.6402) | Order-flow imbalance including limit orders and cancellations explains short-interval price changes better than trade volume. | Peer-reviewed. |
| Martineau, [PEAD for large caps](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3111607) | Post-earnings drift is gone for large caps since about 2006. | Working paper, later published. |
| Frazzini and Lamont 2007; [Savor and Wilson 2016](https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12361); [global replication, JFE 2013](https://www.sciencedirect.com/science/article/abs/pii/S0304405X12002188) | Earnings announcement premium. | Peer-reviewed and replicated. |
| [Greenwood and Sammon 2025](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4294297) | The S&P 500 addition effect fell from 7.4% in the 1990s to under 1% in the 2010s. | Working paper. |

## Crypto

| Source | Takeaway | Credibility |
|---|---|---|
| [BIS WP 1087](https://ideas.repec.org/p/bis/biswps/1087.html) | Crypto funding-rate carry above 40% a year at times; Sharpe falls in 2024 and turns negative in 2025 per the update. | Central-bank working paper. |
| [Liu, Tsyvinski and Wu 2022](https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.13119) | Crypto momentum. Short sample. | Peer-reviewed. |
| [Do and Faff 2010](https://research.monash.edu/en/publications/does-simple-pairs-trading-still-work/) | Pairs trading profits decline over time. | Peer-reviewed. |

## LLMs and machine learning in trading

| Source | Takeaway | Credibility |
|---|---|---|
| [TradingAgents paper](https://arxiv.org/abs/2412.20138), [repo](https://github.com/TauricResearch/TradingAgents) | Reports +23 to +27% over about 3 months on 3 stocks, no costs. | Working paper; short backtest. |
| [TradingAgents critique](https://dev.to/trow126/the-most-starred-llm-trading-paper-claims-buy-and-hold-lost-523-it-actually-gained-912-1jj6) | The AAPL buy-and-hold baseline is wrong: +9.12%, not -5.23%. | Blog; checkable claim. |
| [FINSABER](https://arxiv.org/abs/2505.07078) | LLM strategies lose their reported advantage over 20 years and 100+ symbols. | Working paper. |
| [FinRL-Crypto](https://arxiv.org/abs/2209.05559) | Backtest overfitting is a core problem of deep RL trading. | Working paper. |
| [ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) | LLM persona agents; makes no trades; educational. | Repository. |

## Open-source trading repositories

| Source | Takeaway | Credibility |
|---|---|---|
| [freqtrade-strategies](https://github.com/freqtrade/freqtrade-strategies) | Community TA strategies, stated as educational only. | Repository; no live record. |
| [Jesse example strategies](https://github.com/jesse-ai/example-strategies) | States it ships no ready profitable strategies. | Repository. |
| [QuantConnect Lean alphas](https://github.com/QuantConnect/Lean/tree/master/Algorithm.Framework/Alphas), [forum](https://www.quantconnect.com/forum/discussion/13441/alpha-streams-refactoring-2-0/) | Alpha Streams v1 alphas performed poorly out of sample. | Vendor statement. |
| [Hummingbot liquidity mining paper](https://hummingbot.org/liquidity-mining.pdf) | Market-making economics depend on rebates and incentives. | Vendor paper. |
| [OctoBot](https://github.com/Drakkar-Software/OctoBot) | Grid, DCA and LLM bots without published evidence. | Repository. |
| [Microsoft qlib](https://github.com/microsoft/qlib) | ML models on cross-sectional stock features; the one repo built around the structure the literature supports. | Repository; backtest only. |
| [awesome-quant](https://github.com/wilsonfreitas/awesome-quant) | Library list; points to pysystemtrade and machine-learning-for-trading. | List. |

## Data vendors

| Source | Takeaway | Credibility |
|---|---|---|
| [Databento MBP-1 schema](https://databento.com/docs/schemas-and-data-formats/mbp-1) | Best bid and offer updates, absent from a trades-only download. | Vendor document. |
| [Benzinga stock news API](https://www.benzinga.com/apis/cloud-product/stock-news-api/), [API docs](https://docs.benzinga.com/api-reference/news-api/overview) | First-party news API by quote; REST and push delivery. | Vendor document (2026-09-07). |
| [Massive Benzinga news](https://massive.com/docs/rest/partners/benzinga/news), [pricing](https://massive.com/pricing) | Benzinga dataset at $99 per month for individuals; macro coverage unconfirmed. | Vendor document (2026-09-07). |
| [Alpaca news](https://docs.alpaca.markets/us/docs/historical-news-data), [data pricing](https://alpaca.markets/data) | Benzinga-sourced stock and crypto news; free and $99 per month tiers. | Vendor document (2026-09-07). |
| [Interactive Brokers news pricing](https://www.interactivebrokers.com/en/pricing/research-news-services.php) | Benzinga feed via TWS at $35 retail or $250 institutional per month. | Vendor document (2026-09-07). |
| [Benzinga Pro pricing](https://www.benzinga.com/pro/pricing/) | End-user product; not an integration price. | Vendor document. |

<!-- campaign link definitions -->

