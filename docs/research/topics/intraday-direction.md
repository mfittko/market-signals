# Intraday direction

Question: can we predict the direction of the next minutes to hours on the six OANDA CFD instruments well enough to trade after costs?

Answer: no. Every tested approach fails after the spread, and most fail before it. This is the most heavily tested question in the research. Grade A in [findings.md](../findings.md#f01-intraday-direction-has-no-edge-after-cfd-costs-on-the-six-instruments).

## What was tested

| Approach | Campaigns | Result |
|---|---|---|
| Supertrend flips, volatility gate, chop/geometry/spread filters | [ladderac] | Flips lose -0.286 R per trade on WTI M5. The filter gain is spread and session timing, not skill. |
| Waiting for confirmation, an accept/skip model | [ladder] | No gain over the same-time-of-day null. The model takes no entries. |
| Richer learners and representations | [bench1], [fm2], [ablate4] | Direction AUC stays at 0.47 to 0.55. |
| Day-type switching, session breakouts, open momentum | [daytype14], [orb15], [imom34] | All negative net; dev gains do not replicate. |
| Fades of fast moves, climax and absorption volume | [fade31], [vol33] | Fades lose gross. Volume carries no direction. |
| Rolling move thresholds, flip density, flip-count forecasts | [roll47], [flipdens32], [flipday30] | Nothing survives Holm; signs flip between windows. |
| Cross-instrument bursts and lead-lag | [xvol9], [xvol10], [lead35] | The response ends inside the triggering bar. |
| Operator chart claims (chop, counter-legs, continuation on big days) | [legs27], [lean21], [wave23] | Each claim holds only on days selected in hindsight. |
| News and order flow | [news24], [flow29], [flow42] | See [news.md](news.md) and [order-flow.md](order-flow.md). |
| Gross re-scoring of completed campaigns | [rescan26] | 0 of 418 rows hold gross after Holm. |
| 303 classic chart rules on H1, H4 and D | [scan46] | 0 of 3,030 class cells pass the Deflated Sharpe hurdle. |

## Synthesis

Three mechanisms explain the failures.

1. The spread is large relative to the move. At M1 the spread is 0.5 to 0.6 of the mean absolute move on index CFDs; at M5 it is 0.25 to 0.3 ([swing45]). An edge must exceed this before it shows up net. See [costs-and-vehicles.md](costs-and-vehicles.md).
2. Moves end inside the bar that reveals them. Cross-instrument bursts, M1 bursts and leader moves are complete by the time a confirmation bar closes ([xvol9], [xvol10], [lead35]). Confirmation costs the move.
3. Hindsight selection creates the patterns people see. Continuation on big days, counter-legs after long legs and good flips on quiet days all appear only when days are selected by their outcome ([lean21], [legs27], [flipday30]).

Filters that look helpful are cost effects. The spread rule and the thin-hour rule pass because they avoid wide spreads, not because they find good entries ([notrade12], [ladderac]).

## What remains possible

- Small real effects exist below the spread. The M1 index pullback excess of +0.07 to +0.17 bps clears Holm and is still negative net ([swing45]).
- The evaluator cannot detect effects of 0.10 to 0.20 R ([v2]). A real but small intraday edge could have been missed. It would still need to exceed the cost.
- The tests used candles only. Event content and order-book data were not tested ([open-questions.md](../open-questions.md)).

## External evidence

- Fewer than 1% of Taiwan day traders earn reliable abnormal returns net of fees (Barber, Lee, Liu and Odean 2014).
- About 76 to 82% of retail CFD accounts lose money (Plus500 disclosure).
- The literature has almost no replicated, cost-surviving evidence for single-instrument intraday timing (survey 2026-10-09). See [sources.md](../sources.md#retail-trading-and-costs).

<!-- campaign link definitions -->
[ablate4]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6050530948
[bench1]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6050315703
[daytype14]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054636254
[fade31]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077727397
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
[news24]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6072144766
[notrade12]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054177967
[orb15]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054798153
[rescan26]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6061163925
[roll47]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084812980
[scan46]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084524130
[swing45]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084121700
[v2]: https://github.com/mfittko/market-signals/issues/308#issuecomment-6048905005
[vol33]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077914731
[wave23]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6060307764
[xvol10]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6053719226
[xvol9]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6053439954
