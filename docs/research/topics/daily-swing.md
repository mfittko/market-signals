# Daily swing

Question: do short pullbacks in equity indices, held for days, earn a premium?

Answer: possibly. The RSI(2) and three-down-closes pullback rules are positive in two independent index sets, but the primary confidence interval includes 0 in at least one window. The effect is a daily-bar effect. It is the only forward candidate, tested prospectively in https://github.com/mfittko/market-signals/issues/323.

## Results

| Campaign | Design | Result |
|---|---|---|
| [swing43] | 8 indices, close above SMA200 and RSI(2) below 10, long at the 17:00 New York close, exit at the first close above SMA5 or after 10 bars; excess over the drift | Indices +16.9 bps [-6.0, +36.4] dev (n 1,043), +33.7 bps [+6.7, +59.8] 2023+ (n 304). Hit rate 0.72 and 0.73. 3.6 days held. All 8 indices positive in dev, none with a CI above 0. Losses in 2008, 2011, 2018, 2020 and 2022. Commodities negative. |
| [swing44] | Same rule unchanged on 6 new indices (FR40, EU50, NL25, CH20, SG30, US2000) | +17.9 bps [-1.7, +38.4] (n 902); dev +18.6, 2023+ +15.2. Three down closes: +20.9 bps [+3.4, +36.5]. 5 of 6 indices positive. Loss year 2018 -139 bps. Worst trades are 10-day time exits in crashes. |
| [swing45] | Same rule on M1 to H4 bars, 8 indices | FAIL. On M1, 8 cells clear Holm with excess +0.07 to +0.17 bps, net -1.3 to -2.3 bps. No cell clears on M15 to H4. |
| [scan46] | 303 rule sets on daily, H4 and H1 | The swing44 down3 rule ranks 1st of 303 daily index cells (Sharpe +0.52 discovery, +0.12 validation, +0.66 2023+) but its Deflated Sharpe is 0.001. |

## External evidence

Baltussen, van Bekkum and Da 2019 find that index serial dependence turned from positive to negative after 2000 in 20 indices, and link it to index products. This is the mechanism the pullback rule would harvest. Connors and Alvarez 2008 is the practitioner source of the RSI(2) rule. The survey rates the daily pullback as the idea with the strongest combined evidence: our data plus a peer-reviewed mechanism.

## Costs

- At daily frequency the spread is 1 to 2% of the mean absolute move ([swing45]), so the spread is not the problem.
- Financing is. The survey estimates about 9 bps per trade at a full rate of about 8.9% (a Plus500 estimate), roughly half the edge. OANDA's basis plus 2.5% applies to its own CFDs. A futures or ETF leg beside the CFD would measure the difference directly.

## Risk profile

The external review stresses that this is a mean-reversion strategy with substantial left-tail exposure. It reports crash losses approaching 18.5% in swing44. It is not rapid profit protection. A tight stop would change the effect under test ([external-review.md](../external-review.md#daily-index-pullback)).

## Forward test rules

- Freeze one disclosed version and keep its selection history.
- Do not retune RSI thresholds, index subsets, stops or holding periods on the same evidence.
- Treat the observations as research only, separate from the formal shadow lifecycle.
- Define return and tail criteria before the first observation.

<!-- campaign link definitions -->
[scan46]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084524130
[swing43]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6082779550
[swing44]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6082874730
[swing45]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084121700
