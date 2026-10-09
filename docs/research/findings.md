# Findings

This page holds the canonical claims of the research. Each claim has a grade, the key numbers, the scope and its sources. The grades are defined in [README.md](README.md#evidence-grades).

Rules for this page:

- A number appears only if a campaign record, a local output or a cited source contains it. The campaign links point to the GitHub result comments, which are the primary record.
- "dev" is the development window 2018-2022 (2019-2022 or 2020-2022 where the campaign says so). "2023+" is the second development window from 2023-01-01 to the run date. Neither is an untouched holdout.
- R is the campaign's risk unit, usually 1.5 x ATR14 on the entry timeframe. bps are basis points of price.
- "Net" includes the OANDA bid/ask spread. "Gross" uses mid prices.
- The six CFD instruments are WTI (WTICO/USD), XAU/USD, XAG/USD, NATGAS/USD, SPX500/USD and EUR/USD on OANDA.

## Summary by grade

| Grade | Count | Claims |
|---|---|---|
| A | 2 | F01, F13 |
| B | 31 | F02 to F12, F14 to F33 |
| C | 4 | F34 to F37 |
| D | 3 | F38 to F40 |

## Direction

### F01. Intraday direction has no edge after CFD costs on the six instruments

Grade A. Our data and the external literature agree.

- Supertrend flips on WTI M5 lose -0.286 R per trade [-0.320, -0.259] on 7,441 trades in 2023+, and they are indistinguishable from execution-matched random entries ([ladderac]).
- Entry-time models stay at chance: AUC for "+1 R before -1 R" and for direction given a big move is 0.48 to 0.55 on every population, learner and window ([ablate4], [bench1]).
- A gross re-scoring of 418 campaign rows finds 3 rows with a gross CI above 0 in both windows and 0 rows after Holm ([rescan26]).
- 3,030 asset-class cells of 303 classic rule sets reach 0 cells with a Deflated Sharpe above 0.95 ([scan46]).
- External: fewer than 1% of Taiwan day traders earn reliable abnormal returns net of fees (Barber, Lee, Liu and Odean 2014). Plus500 discloses that about 76 to 82% of retail CFD accounts lose money. See [sources.md](sources.md#retail-trading-and-costs).

Scope: M1 to H1 entries, held minutes to hours, on OANDA CFDs, 2018 to 2026-10. It does not cover order-book data, event content, or other vehicles.

### F02. Richer learners and representations do not fix the direction labels

Grade B.

- In bench1, raw AUC for the entry label is 0.485 to 0.534 in every fold for LR, gradient boosting, MiniRocket and TS2Vec. Unselected D entries lose -0.118 R [-0.177, -0.056] (2020-22) and -0.117 R [-0.177, -0.061] (2023+) ([bench1]).
- Zero-shot foundation models (Chronos, Chronos-Bolt, Chronos-2, TimesFM 2.5, Moirai) score direction AUC 0.47 to 0.52 ([fm2]).
- The positive controls show the limit of this conclusion. Evaluator v2 detects a planted 0.10 to 0.20 R effect in 0 of 93 LR runs, so small real effects can be missed ([v2]).

Scope: WTI and XAU M5, D and fixed-cadence populations. Interpretation from the external review: "no useful advantage demonstrated for these targets", not "nothing is learnable" ([external-review.md](external-review.md#models-and-targets)).

### F03. Waiting for confirmation and regime switching add no entry skill

Grade B.

- The D follower improves on raw flips but does not beat the same-time-of-day null: WTI +0.059 [-0.166, +0.307], XAU +0.041 [-0.026, +0.115]. Waiting adds nothing over entering at discovery ([ladder]).
- Trend days are predictable at 4 h into the session (AUC 0.80 to 0.87 on five instruments), but every trend-follow, fade and switch policy loses -0.110 to -0.223 R per trade with CI upper bounds below 0 in both windows ([daytype14]).
- The predicted trend days are the days whose move already happened before the checkpoint ([daytype14]).

### F04. Session-open breakouts, fades and open-to-close momentum do not pay

Grade B.

- 15-minute opening-range breakout: net -0.017 R [-0.053, +0.018] dev, -0.056 R [-0.098, -0.013] 2023+. Gross +0.066 R dev is less than the 0.08 R cost and fades to +0.017 R in 2023+ ([orb15]).
- Market intraday momentum (Gao, Han, Li and Zhou 2018) on SPX500: -1.87 bps [-3.71, -0.05] dev on 1,207 days and +0.59 bps [-0.82, +2.07] 2023+ on 930 days ([imom34]).

### F05. Fading fast moves loses before the spread

Grade B.

- WTI M5 fades of 1.5 ATR moves without news: gross -0.074 R [-0.098, -0.051] dev (n 3,419) and -0.102 R [-0.128, -0.075] 2023+ (n 3,042). All 36 instrument, timeframe and window cells are negative with CI below 0 ([fade31]).
- Extreme tick volume as climax or absorption: WTI M5 gross +0.027 R [-0.030, +0.084] (H1) and +0.019 R [-0.038, +0.075] (H2) in dev. No net CI is above 0 in 252 cells ([vol33]).
- A rolling 1-hour move checked every 15 minutes: minimum Holm p 0.27 dev and 0.55 2023+ on WTI. Net is -11 to -3 bps, 79 of 80 cells below 0 ([roll47]).

### F06. Cross-instrument and lead-lag responses end inside the triggering bar

Grade B.

- Cross-instrument M5 bursts: the burst bar moves +2.6 ATR, then the path is flat from +1 to +60 minutes ([xvol9]).
- M1 bursts: the executable return after a confirmed entry is about minus the spread, -0.106 to -0.143 R at +5 and +10 minutes, CI below 0 in both windows ([xvol10]).
- XAU leading XAG on M1: gross -0.034 ATR [-0.147, +0.078] dev and -0.042 ATR [-0.152, +0.059] 2023+. Lag-1 correlations are at most +0.017 ([lead35]).

### F07. Supertrend flip density and flip-count forecasts do not mark good flips

Grade B.

- A Poisson model of the flip count after 07:00 UTC has rho -0.06 to +0.21. Trading only on predicted low-flip days gives +0.017 R [-0.063, +0.100] dev and +0.078 R [-0.002, +0.164] 2023+ on WTI M5 ([flipday30]).
- Causal flip density before a flip does not separate good flips. Holm p is at least 0.64 for WTI M5 ([flipdens32]).
- In hindsight, few-flip days earn +0.20 to +0.43 R per flip. The effect comes from flips after entry (exit on the opposite flip), so it is partly mechanical ([flipday30], [flipdens32]).

### F08. Operator chart claims about chop and counter-legs do not hold

Grade B.

- Chop measures (efficiency ratio, wick share, range-to-spread) do not lower the chance of a clear move. Range-to-spread points the opposite way on all instruments ([legs27]).
- A long leg is not followed by a longer counter-leg more often than a driftless race. The impression appears only on days selected for a flat close ([legs27]).
- The big-day alert plus a strong move so far does not continue: pooled H12 continuation 47% dev and 45% 2023+, net -0.10 R [-0.15, -0.04] and -0.11 R [-0.19, -0.04]. On days that end as big days (not knowable in advance) continuation is 61 to 72% ([lean21]).
- Riding the wave with tight stops on alert days loses -0.07 to -0.26 R per armed day. The alert makes this policy worse than on non-armed days ([wave23]).

## Volatility and big days

### F09. Volatility and session timing are learnable

Grade B.

- The side-free big-move label T2 (excursion over 72 M5 bars of at least 6 ATR) reaches AUC 0.70 to 0.81 on every population ([ablate4]).
- A 12-coefficient logistic regression on time of day and volatility state scores WTI AUC 0.782 dev and 0.795 2023+. Time of day alone scores 0.743 and 0.758 ([fm2]).
- The same model replicates on six instruments with AUC 0.757 to 0.866 ([alert7]).

Scope: M5, 2018 to 2026.

### F10. The ATR-relative big-move target is a session clock

Grade B.

- At 2 alerts per week precision is 0.93 to 1.00, but recall of the largest moves in % of price is 5 to 22% ([alert7]).
- Alerts cluster at 04:00 to 06:00 and 22:00 to 00:00 UTC, before sessions open. The median forward move at an alert is equal to or below the overall median (XAG 0.69% vs 0.95%) ([alert7]).
- Major-move recall in the 2020H1, 2022H1 and 2025Q4 to 2026Q1 crisis windows is 0.00 to 0.11 ([alert7]).

### F11. The absolute big-day model ranks well but fails its recall bar

Grade B.

- abs11: A1 "is today becoming a big day" AUC 0.779 to 0.862 dev and 0.783 to 0.900 2023+, calibration within +/-0.05 in every dev year. It fails the registered rule, mainly on recall at 2 alerts per month ([abs11]).
- abs48: scored on the move still ahead after the alert, pooled AUC 0.856 [0.846, 0.866] dev and 0.864 [0.854, 0.875] 2023+, against 0.807 and 0.815 for realized volatility alone. Dev recall 0.454 is below the 0.5 bar ([abs48]).
- Median lead time is 6.6 to 6.75 hours. Mean remaining move at alerts is 2.3 to 3 times the mean over all rows ([abs48]).
- At 4 alerts per month (not registered) recall and precision pass in both windows ([abs48]).

Scope: six instruments, day-level, 22:00 UTC session, 2018 to 2026-10. The frozen thresholds drift in 2023+ (XAU 5.2 alerts per month instead of 2).

### F12. Big days look directional only in hindsight

Grade B.

- The alert adds no direction beyond "price already moved": main minus moved-without-alert is +0.02 R (H12) in 2023+ ([lean21]).
- On days that end as big days, continuation is 61 to 72%. This cannot be known at decision time ([lean21]).
- The earlier EUR/USD lab found continuation to the close of 48 to 52% at every checkpoint (grade D on its own; see [topics/volatility-and-big-days.md](topics/volatility-and-big-days.md)).

## Costs and vehicles

### F13. The spread share of the typical move falls steeply with the timeframe

Grade A. Measured in our data and consistent with every external source on retail intraday trading.

- On index CFDs the spread is 0.5 to 0.6 of the mean absolute move at M1, 0.25 to 0.3 at M5, 0.04 to 0.05 at H4 and 0.01 to 0.02 at daily ([swing45]).
- The index pullback has a real M1 excess of +0.07 to +0.17 bps per bar that clears Holm, and the spread of about 2 bps turns it into -1.3 to -2.3 bps net ([swing45]).

### F14. Spread and thin-hour filters cut losses but leave signals negative

Grade B.

- Blocking entries with spread above 0.2 R improves kept R per signal by +0.371 R [+0.351, +0.394] dev and +0.254 R [+0.238, +0.269] 2023+. Blocking thin hours adds +0.045 and +0.037 R ([notrade12]).
- The filtered signals still average -0.120 R (dev) and -0.116 R (2023+) ([notrade12]).
- Chase and stretched-move filters are harmful. They block better-than-average entries ([notrade12]).

### F15. Passive limit entries do not save the spread

Grade B. Consistent with external evidence that market-making profits go to the fastest firms (Baron, Brogaard, Hagstromer and Kirilenko 2019).

- All 8 limit variants lose -0.109 to -0.135 R per filled signal. Limits fill mostly on failing signals (market R -0.23 to -0.62) and miss winners ([limit13]).

### F16. Financing dominates CFD costs at multi-week horizons

Grade B.

- Financing is 70 to 95% of costs for metals, SPX500 and EUR/USD in the multi-week policies, about 1 R per year for XAU and 1.5 R per year for EUR/USD ([mw6]).
- Diversified 12-month momentum on 33 markets earns gross Sharpe +0.25 [-0.18, +0.69] dev and +0.65 [-0.16, +1.73] 2023+, but net Sharpe is -0.28 and -0.07 under the assumed 3% financing on about 2.3x gross notional ([tsmom36]).
- External: OANDA charges the basis rate plus 2.5% on longs and credits the basis minus 2.5% on shorts ([sources.md](sources.md#brokers-and-vehicles)). The flat 3% model of the earlier campaigns is a sensitivity, not verified broker economics ([external-review.md](external-review.md#costs-and-vehicles)).
- trend49 models these long and short rates with the FRED DTB3 T-bill as the basis (2023 5.07%, 2024 4.97%, 2025 4.07%). A long CFD held all the time costs about 6 to 7% of notional a year in 2023-26. Over 2023-01-01 to 2026-10-08 that alone cut buy-and-hold NAS100 from +181% to +116% and XAU from +127% to +74%, and turned TS12 on NAS100 from +30% into +3%. A futures-style account without the markup keeps almost the whole gross result. Descriptive ([trend49]).

### F17. Risk overlays cannot rescue a losing baseline

Grade B.

- 1 of 24 overlay cells passes, at chance level. Every variant stays negative, best -0.061 R per entry ([risk8]).
- Gating improves drawdown only by trading less, and it is worse than random thinning ([risk8]).
- The volatility-scaled stop is positive in 7 of 8 cells (+0.046 R [+0.007, +0.083] on WTI 2023+) but fails the runner-retention rule. It is a lead for a new registration only ([risk8]).

## Daily and multi-day

### F18. The daily index pullback is positive but not significant

Grade B. External support: index serial dependence turned negative after 2000 in 20 indices (Baltussen, van Bekkum and Da 2019).

- swing43, 8 indices: excess +16.9 bps [-6.0, +36.4] dev (n 1,043) and +33.7 bps [+6.7, +59.8] 2023+ (n 304), hit rate 0.72 and 0.73, 3.6 days held ([swing43]).
- swing44, 6 new indices: excess +17.9 bps [-1.7, +38.4] (n 902), dev +18.6, 2023+ +15.2. The secondary "three down closes" rule gives +20.9 bps [+3.4, +36.5] ([swing44]).
- scan46 ranks the swing44 down3 rule first of 303 daily index cells, with Deflated Sharpe 0.001 ([scan46]).
- Worst trades are 10-day time exits in crashes. The external review reads crash losses approaching 18.5% ([swing44], [external-review.md](external-review.md#daily-index-pullback)).

Scope: equity index CFDs, daily close entries, 2005 to 2026-10. It is the only forward candidate: https://github.com/mfittko/market-signals/issues/323.

### F19. The pullback edge is a daily-bar effect

Grade B.

- On M15 to H4 no cell clears Holm. On M1 eight cells clear Holm, but net is negative ([swing45]).

### F20. Slow momentum and trend following on CFDs do not qualify

Grade B for our tests. Time-series momentum on futures is externally replicated (Hurst, Ooi and Pedersen 2017), so this claim is about the vehicle and the power, not the premium.

- No multi-week policy meets the rule on any instrument. One 4-year window gives a Sharpe CI half-width of about +/-1.0, so effects of 0.3 to 0.5 need 15 to 40 years to detect ([mw6]).
- MDE80 for the 33-market book is Sharpe 0.64 dev and 1.35 2023+ ([tsmom36]).
- trend49 (descriptive, hindsight-selected episodes, grade D on its own): TS12, TS6 and SMA200 kept 88 to 100% of the 2025-26 gold and silver rallies gross (84 to 96% after CFD costs), because those rallies were already under way. They were still long at the 2026-01-28 top and gave back 40 to 53% in the next six months ([trend49]).
- The same rules miss rallies that start right after a crash. On the NAS100 2023-26 rally TS12 and TS6 kept 24 to 30% gross and 2 to 9% net (TS12 2%). SMA200 kept 77% gross and 54% net. No rule kept clearly more than buy-and-hold after CFD costs; the closest case is SMA200 on XAU, +77% against +74% ([trend49]).

### F21. Volatility-managed exposure limits drawdowns but adds no Sharpe

Grade B. It contradicts the external claim of Moreira and Muir 2017 for these index CFDs.

- SPX500 Sharpe difference +0.05 [-0.31, +0.40] dev and -0.51 [-1.08, +0.07] 2023+. Max drawdown falls from -57% to -22% in dev ([vm40]).

### F22. Extreme daily moves do not continue; the commodity lead did not replicate

Grade B.

- Pooled over 33 markets, h3 continuation +0.116 sigma [-0.022, +0.261] dev and +0.034 sigma [-0.227, +0.301] 2023+. Commodities continued in dev (+0.227 [+0.046, +0.409]) as 1 of 720 cells ([ext39]).
- On 10 new CME commodities the h5 effect is +0.154 sigma [-0.164, +0.480] dev and -0.058 sigma [-0.508, +0.421] 2023+ ([cmd41]).

### F23. Calendar and overnight effects do not pass in these CFDs

Grade B.

- Turn of the month on 8 indices: +0.9 bps per day [-7.1, +8.2] dev. Pre-FOMC: +24.8 bps [+3.8, +46.7] dev (Holm p 0.060), -14.9 bps 2023+. Pre-holiday: positive in 16 of 16 cells but MDE80 20 to 27 bps ([cal37]).
- SPX500 overnight drift: +4.01 bps [+0.23, +7.94] dev and +2.42 bps [-1.70, +6.09] 2023+. Night minus day is not positive in both windows ([night38]).
- Intraday hour and weekday drifts: 2 of 27 selected windows survive validation, as random selection does (2.01 on average) ([season17]).

### F24. Relative-value spreads revert slower than the holding horizons

Grade B.

- XAU/XAG, SPX500/NAS100 and EUR/USD vs XAU on M15 lose -0.049 to -0.162 R per trade. M15 half-lives are 32 to 66 hours against a 24-hour hold ([pairs16]).

## Order flow and news

### F25. The CL aggressor-flow reversal was a single-year effect

Grade B. It is the clearest example of a pass that failed replication.

- flow29 (2025-10 to 2026-10): k=3 continuation minus baseline -5.1 pp [-7.0, -3.3], Holm p 0.002, 3,135 events ([flow29]).
- flow42 (2024-10 to 2025-10): -0.5 pp [-2.3, +1.7] on 3,101 events. Continuation 49.5% vs a 50.0% baseline. Heavy flow adds nothing reliable beyond the price move ([flow42]).

### F26. GDELT news bursts do not significantly mark continuation

Grade B.

- WTI M5, 6 bars: NEWS +0.28 R [+0.02, +0.58] dev (n 64) and +0.14 R [-0.24, +0.55] 2023+ (n 21). NEWS minus CONTROL +0.25 R [-0.03, +0.55] dev. MDE80 of the difference is about 0.4 to 0.55 R ([news24]).
- News bursts are rare: 2 to 6% of events ([news24]).
- The news24 relevance rule is imprecise. The Jev-relevant share is WTI 0.32, XAU 0.31, XAG 0.19, EUR 0.54, SPX 0.39 and NATGAS 0.12 (news28, closed without a rerun; see [campaigns.md](campaigns.md)).

### F27. Fading moves is not safer when no news is present

Grade B.

- News fades minus no-news fades: +0.031 R [-0.063, +0.134] dev, +0.007 R [-0.248, +0.258] 2023+. "Do not fade news" is neither supported nor refuted ([fade31]).

## LLMs and filters

### F28. The live LLM alert filter is no better than random thinning

Grade B.

- 5,455 scored flips, 82% suppressed. Allowed -0.276 R [-0.373, -0.167] vs suppressed -0.288 R [-0.339, -0.236]. The filter sits at the 59th percentile of random thinning. All Holm p are at least 0.41 ([filter316]).

### F29. Calibrated P(profit) is possible on some pairs, but no decile has positive expected R

Grade B.

- Calibration passes on M5 for WTI, XAU (borderline), SPX500 and EUR/USD, and on M15 for WTI, XAG, SPX500 and EUR/USD. AUC is 0.57 to 0.80 per side, mostly from spread and hour ([pprofit20]).
- No decile has a CI above 0 on any instrument, timeframe, window or side ([pprofit20]).
- The card's side lean hits 48.7 to 52.1% on the "up" target cells in 2023+, with negative mean R in every cell (lean22, local report `out/report.txt`).

## Methodology

### F30. The evaluator is valid but has low power for small effects

Grade B.

- Spread accounting, fill timing and stop ordering pass 15 of 15 fixtures. An independent simulator matches on 6,000 random paths. Intrabar ambiguity moves R per trade by at most 0.002 ([v1]).
- False qualification is 0 of 40 on both nulls, Wilson upper bound 0.088 ([v2]).
- Detection of a planted 0.10 to 0.20 R effect is 0% for LR and gradient boosting; 0.20 to 0.40 R is detected 5 to 6% of the time ([v2]).

### F31. A single significant pass needs a replication before any use

Grade B.

- flow29 passed with Holm p 0.002 and failed on the next year ([flow29], [flow42]).
- The ext39 commodity continuation (1 of 720 cells) failed on new commodities ([ext39], [cmd41]).
- The 15-minute ORB beat its nulls in dev (Holm p 0.021) and lost in 2023+ ([orb15]).

### F32. Classic chart rules do not survive selection correction

Grade B. Consistent with external results on backtest overfitting (Wiecki et al. 2016, R squared below 0.025 between backtest and out-of-sample Sharpe).

- 0 of 3,030 cells reach Deflated Sharpe 0.95. Naive p below 0.05 holds for 22 class cells and 254 of 20,301 instrument cells ([scan46]).
- The top 10 daily cells shrink from Sharpe +0.54 (discovery) to +0.40 (validation) to -0.04 (2023+) ([scan46]).
- The DSR hurdles are high (SR0 1.35 daily, 2.16 H4, 6.31 H1). The external review asks for a synthetic validation of this application ([external-review.md](external-review.md#methodology)).

### F33. 2023+ is development evidence

Grade B (a rule, recorded as a finding because every campaign depends on it).

- The window was inspected twice before the 2026-10 campaigns. Only prospective data or data after 2026-10-07 can confirm a winner ([topics/methodology.md](topics/methodology.md)).

## External claims not tested here

### F34. Risk premia and cross-sectional sorts carry the replicated, cost-surviving evidence

Grade C.

- Most equity factors replicate across 93 countries (Jensen, Kelly and Pedersen 2023). Anomalies with monthly turnover below about 50% survive costs (Novy-Marx and Velikov 2016). Published predictors lose 26% out of sample and 58% after publication (McLean and Pontiff 2016).
- None of this was tested here. See [topics/trend-and-carry.md](topics/trend-and-carry.md) and [open-questions.md](open-questions.md).

### F35. Commodity carry and the volatility risk premium are documented but need other vehicles

Grade C.

- Commodity term-structure carry: Koijen, Moskowitz, Pedersen and Vrugt 2018. Cboe PUT 1986-2018 Sharpe 0.65 vs 0.49 for SPX, max drawdown 33% vs 51% (Bondarenko 2019).
- OANDA puts commodity carry into financing, so mid candles contain no roll yield. Options are not available as CFDs ([topics/costs-and-vehicles.md](topics/costs-and-vehicles.md)).

### F36. Event surprises, not article counts, move prices at releases

Grade C.

- Andersen, Bollerslev, Diebold and Vega link macro announcement surprises to exchange-rate jumps. Our tests used article counts and fixed release windows, not surprises ([topics/news.md](topics/news.md)).

### F37. Order-book imbalance explains short-interval price changes better than trade volume

Grade C.

- Cont, Kukanov and Stoikov. This is price-formation evidence, not a forecast of future returns ([topics/order-flow.md](topics/order-flow.md)).

## Anecdote and backtest-only claims

### F38. LLM trading agents report large gains that do not hold up

Grade D.

- TradingAgents reports +23 to +27% over about 3 months with no costs. An independent check found its AAPL buy-and-hold baseline wrong (+9.12%, not -5.23%). FINSABER finds that LLM strategies lose their advantage over 20 years and 100+ symbols ([topics/llm-in-trading.md](topics/llm-in-trading.md)).

### F39. The TypeSafe Jev prompt was miscalibrated in the 2026 model lab

Grade D (a lab test on 11 weeks of data, not preregistered).

- Log loss was 42 to 54% worse than the base rate. Directional hit rate pooled 53% [49%, 57%]. As a big-move scorer Jev reached AUC 0.50 to 0.59 against about 0.60 for a local model ([topics/llm-in-trading.md](topics/llm-in-trading.md)).

### F40. Above about 3x leverage, survival decides the result of a trend account

Grade D (descriptive leverage simulation on hindsight-selected episodes and full windows; post-hoc, not a test).

- trend49 amendment 2 simulated 1x, 3x, 10x and volatility-targeted sizing (VT20: 20% divided by 20-day realized volatility, capped at the ESMA limit) on six OANDA daily series. The simulation includes CFD spread and financing, close-out at 50% of required margin, negative balance protection and re-entry on the next signal ([trend49-lev]).
- At 10x, all 12 TS12 and TS6 accounts ended 2018-22 at 0.06 or less of the starting equity. In 2023+, 11 of 12 ended below 0.5 ([trend49-lev]).
- On XAG, WTI and NATGAS the ESMA cap is 10x. At 10x the whole equity is margin, so an adverse move of about 5% closes the position. The trend rules at 10x had up to 22 close-outs per window ([trend49-lev]).
- The 10x accounts that grew in 2023+ were long-only on markets that rose without a deep fall: SMA200 NAS100 20.3x with a -60% drawdown, buy-and-hold NAS100 14.1x, XAU 9.4x and SPX500 7.3x. They paid financing of 285 to 890% of the starting equity ([trend49-lev]).
- At 3x the trend rules had no close-out, but the TS12 and TS6 drawdowns were 54 to 99% ([trend49-lev]).
- VT20 was never closed out. It ran at about 1x on gold and the indices and well below 1x on silver, oil and gas. Its results were close to 1x with lower drawdowns on the commodities ([trend49-lev]).
- The rule decides whether an account is in a rally. Leverage decides whether it survives the drawdowns between rallies. See [topics/costs-and-vehicles.md](topics/costs-and-vehicles.md#leverage-and-survival) and the backlog item on volatility-based sizing and a leverage warning in [open-questions.md](open-questions.md).

<!-- campaign link definitions -->
[ablate4]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6050530948
[abs11]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6053999202
[abs48]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6085151801
[alert7]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6051635292
[bench1]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6050315703
[cal37]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078391261
[cmd41]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078887870
[daytype14]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054636254
[ext39]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078559927
[fade31]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077727397
[filter316]: https://github.com/mfittko/market-signals/issues/316#issuecomment-6055138146
[flipday30]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077614604
[flipdens32]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077760304
[flow29]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6076402618
[flow42]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6079878152
[fm2]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6051264073
[imom34]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078006875
[ladder]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6046831326
[ladderac]: https://github.com/mfittko/market-signals/issues/309#issuecomment-6046593404
[lead35]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078095798
[lean21]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6059927619
[legs27]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6061919607
[limit13]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054340144
[mw6]: https://github.com/mfittko/market-signals/issues/314#issuecomment-6051504954
[news24]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6072144766
[night38]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078494080
[notrade12]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054177967
[orb15]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054798153
[pairs16]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6055023857
[pprofit20]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6055442748
[rescan26]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6061163925
[risk8]: https://github.com/mfittko/market-signals/issues/311#issuecomment-6051369045
[roll47]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084812980
[scan46]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084524130
[season17]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6055192654
[swing43]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6082779550
[swing44]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6082874730
[swing45]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084121700
[trend49]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6087457614
[trend49-lev]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6087525298
[tsmom36]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078272501
[v1]: https://github.com/mfittko/market-signals/issues/308#issuecomment-6048120221
[v2]: https://github.com/mfittko/market-signals/issues/308#issuecomment-6048905005
[vm40]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078668435
[vol33]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077914731
[wave23]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6060307764
[xvol10]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6053719226
[xvol9]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6053439954
