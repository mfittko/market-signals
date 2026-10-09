# Trend and carry

Question: do slow trend and carry premia, which the literature documents, pay on our vehicles?

Answer: trend did not qualify on CFDs, mostly because of financing and low power. Carry was not tested, because OANDA mid prices do not contain it. The replicated, cost-surviving evidence in the literature is in exactly these premia and in cross-sectional sorts, so this is the most promising untested area.

## Our tests

| Campaign | Design | Result |
|---|---|---|
| [mw6] | 8 policies (time-series momentum 60/20, 120/20, 20/5; D1 supertrend; H4+D1 agreement; Donchian 20/10; two big-week-gated variants) on 6 instruments, financing 0/3/6% on both sides | No policy qualifies. 3 of 96 Sharpe CIs above 0, 7 below. WTI momentum 20/5 dev Sharpe +1.17 [+0.25, +2.21] and 2023+ +0.00. Pooled portfolio dev Sharpe at most +0.01. Trend followers made money in the 2020H1, 2022H1 and 2025Q4 crisis windows. |
| [tsmom36] | 33 daily OANDA markets, sign of the 252-day return, 40% target volatility, monthly | Gross Sharpe +0.25 [-0.18, +0.69] dev (+3.4% a year, max drawdown -38%) and +0.65 [-0.16, +1.73] 2023+. Net -0.28 and -0.07 under 3% financing on about 2.3x gross notional. MDE80 Sharpe 0.64 and 1.35. FX shows no premium. |
| [vm40] | Volatility-managed long-only index exposure | Drawdown limiter, not a Sharpe gain. See [findings.md](../findings.md). |
| [ext39], [cmd41] | Continuation after extreme daily moves | No pooled continuation. The commodity continuation in ext39 did not replicate on new commodities. |

## Why the CFD tests cannot settle the question

- Power: one 4-year window gives a Sharpe CI half-width of about +/-1.0 per instrument. Detecting a Sharpe of 0.3 to 0.5 needs 15 to 40 years ([mw6]). The external review adds that this estimate needs its assumptions stated; overlapping trades and correlated instruments are not independent years.
- Financing: 70 to 95% of costs at this horizon ([mw6]). The flat 3% model mis-states commodity returns because OANDA passes the term structure through financing ([costs-and-vehicles.md](costs-and-vehicles.md)).
- Breadth: six instruments allow only time-series timing. The literature's strongest results are cross-sectional.

## External evidence

| Premium | Evidence | Vehicle |
|---|---|---|
| Time-series momentum | A century over 67 markets (Hurst, Ooi and Pedersen 2017); Moskowitz, Ooi and Pedersen 2012 | 30 to 60 futures |
| Commodity carry | Koijen, Moskowitz, Pedersen and Vrugt 2018; Szymanowska et al. 2014; Bakshi, Gao and Rossi 2019. Weak live record: iShares CCRV returned about 3.5% a year over 3 years and was liquidated in August 2025. | 15 to 25 commodity futures, monthly roll |
| FX carry | Menkhoff et al. 2012; mostly the dollar factor, dollar-neutral carry negatively skewed (Daniel, Hodrick and Lu 2017) | Forwards or futures; doubtful on CFDs |
| Sector and country momentum | Moskowitz and Grinblatt 1999; Asness, Moskowitz and Pedersen 2013; weak practitioner out-of-sample record | ETFs, monthly |
| Volatility risk premium | Cboe PUT 1986-2018 Sharpe 0.65 vs 0.49 for SPX (Bondarenko 2019); tail risk shown by the 2018 XIV loss of about 96% | Index options, monthly |
| Equity factors | Most replicate across 93 countries (Jensen, Kelly and Pedersen 2023); productised smart beta earns about -0.4% a year after listing | Stocks or factor ETFs, monthly |

All grade C until tested here. See [open-questions.md](../open-questions.md) for the ranked tests: commodity carry on futures, put writing, sector ETF momentum and FX carry on CFD terms.

<!-- campaign link definitions -->
[cmd41]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078887870
[ext39]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078559927
[mw6]: https://github.com/mfittko/market-signals/issues/314#issuecomment-6051504954
[tsmom36]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078272501
[vm40]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078668435
