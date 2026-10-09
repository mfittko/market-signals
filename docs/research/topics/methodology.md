# Methodology

This page states how the research separates evidence from noise, and the lessons that shaped those rules. The rules apply to every new campaign.

## Preregistration

- Write `prereg.json` before any outcome run. Record a timezone-explicit `created` timestamp, what ran before registration, the hypotheses, the primary metric, the pass rule, the nulls and the sha256 of the code.
- Post the preregistration and the result as comments on the research issue. They are the primary record.
- An amendment states whether it came before or after outcomes. A post-outcome change is POST-HOC and counts as development evidence only. Example: alert7 amendment A1 added a population after seeing results for four instruments, and says so ([alert7]).
- Report every registered cell, including failures. Keep negative, skipped and blocked results.

## Windows

- Develop on 2018-2022 with purged walk-forward folds.
- 2023-01-01 to the run date is a second development window. It was inspected twice before the 2026-10 campaigns, so it is never an untouched holdout.
- Only prospective data or data after 2026-10-07 can confirm a winner. The pre-audit ladder used a scored-once test window; the audit reclassified it as development evidence.
- Crisis windows (2020H1, 2022H1, 2025Q4 to 2026Q1) are stress tests, not holdouts.

## Statistics

| Tool | Use | Where |
|---|---|---|
| Day-, week- or month-block bootstrap | Confidence intervals that respect serial dependence | `validate.day_boot` in the evaluator; each protocol names its block |
| Holm correction | Several primaries or many cells in one campaign | most campaigns since notrade12; rescan26 across 418 rows |
| Bonferroni | The early ladder and evaluator v2 verdicts | ladder, v2 |
| Deflated Sharpe ratio (Bailey and Lopez de Prado) | Selection over hundreds of rule sets | [scan46] |
| MDE80 | The smallest effect with 80% power; states what "inconclusive" means | most campaigns since xvol9 |
| Random-thinning, random-side, random-timing and same-time-of-day nulls | Separate skill from cost avoidance and drift | ladder, notrade12, limit13, risk8, filter316 |
| Positive controls (planted effects) | Measure the evaluator's power | [v1], [v2], [bench1] |

An interval that spans 0 means insufficient evidence, not proof of no effect. State the MDE80 next to every inconclusive verdict.

## Evaluator

Evaluator v2 (digest 1b66053d) is the frozen harness for entry-policy campaigns. Its code and checksums are in [registry/evaluator/](../registry/evaluator/). Facts about it:

- 15 of 15 accounting fixtures pass; intrabar ambiguity moves R per trade by at most 0.002 ([v1]).
- False qualification 0 of 40 on both nulls, Wilson upper bound 0.088 ([v2]).
- Power is low for small effects: 0% detection at 0.10 to 0.20 R for LR and gradient boosting, 5 to 6% at 0.20 to 0.40 R ([v2]). It misses most subset-confined signals. A rare-opportunity control is still open.

## Trial accounting

Every configuration, seed, lookback, threshold and secondary cell is one row in `trials.jsonl`, tagged by campaign. The snapshot has 42,810 rows through trend49; scan46 alone has 23,331. Counts per campaign are in [registry/trials-summary.csv](../registry/trials-summary.csv).

## Lessons

| Lesson | Evidence |
|---|---|
| A single significant pass is a hypothesis. Replicate it on independent data before any use. | flow29 passed with Holm p 0.002 and failed on the next year in flow42 ([flow29], [flow42]). The ext39 commodity continuation (1 of 720 cells) failed on new commodities in cmd41 ([ext39], [cmd41]). The 15-minute ORB beat its nulls in dev and lost in 2023+ ([orb15]). |
| Filter gains are usually cost or timing effects. Compare with random thinning and the same-time-of-day null. | Filter C and follower D beat raw flips but not the time-of-day null ([ladderac], [ladder]). Limit fills and gating equal random thinning ([limit13], [risk8]). |
| A high AUC can answer the wrong question. Check what the target measures. | T2 reaches AUC 0.76 to 0.87 by learning the session clock ([alert7]). |
| Hindsight selection creates convincing patterns. | Continuation on big days, counter-legs and quiet-day flips appear only on outcome-selected days ([lean21], [legs27], [flipday30]). |
| Selection over many candidates must be priced in. | season17 survivors match random selection. scan46: 254 naive p < 0.05 instrument cells, 0 after Deflated Sharpe ([season17], [scan46]). |
| Changing the learner rarely fixes a weak label. | bench1, fm2, ablate4: richer models do not move direction AUC off chance. |
| Report gross and net separately. | rescan26 made gross the judgement of direction and net the judgement of tradability. |
| A mechanical label can create its own effect. | vol33's range-after-spike ratio was inflated by ATR including the spike bar ([vol33]). The flipday30 hindsight effect is partly the exit rule ([flipday30]). |

## Open method questions

- Validate the scan46 Deflated Sharpe application on synthetic libraries with realistic correlation and cost. Do not lower the hurdle ([external-review.md](../external-review.md#methodology)).
- Add a rare-opportunity positive control to the evaluator.
- State the assumptions behind multi-year power estimates (significance, power, overlap and correlation) ([external-review.md](../external-review.md#costs-and-vehicles)).

<!-- campaign link definitions -->
[alert7]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6051635292
[bench1]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6050315703
[cmd41]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078887870
[ext39]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078559927
[flipday30]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077614604
[flow29]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6076402618
[flow42]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6079878152
[ladder]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6046831326
[ladderac]: https://github.com/mfittko/market-signals/issues/309#issuecomment-6046593404
[lean21]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6059927619
[legs27]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6061919607
[limit13]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054340144
[orb15]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054798153
[risk8]: https://github.com/mfittko/market-signals/issues/311#issuecomment-6051369045
[scan46]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084524130
[season17]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6055192654
[v1]: https://github.com/mfittko/market-signals/issues/308#issuecomment-6048120221
[v2]: https://github.com/mfittko/market-signals/issues/308#issuecomment-6048905005
[vol33]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077914731
