# External review

An external auditor reviewed the research plan and results between 2026-10-07 and 2026-10-09. The operator posted each review as an issue comment. This page synthesises the points by theme. It does not quote the reviews; the source comments are the record.

Status values:

- Answered: a campaign or a document addressed the point. The link names it.
- Partly answered: some of the point is addressed, some is open.
- Open: not addressed yet.
- Lost its basis: a later result removed the reason for the point.

## Review comments

| Date | Review | Source |
|---|---|---|
| 2026-10-07 | Design clarification: state-based alerts and an EntryGuard | https://github.com/mfittko/market-signals/issues/307#issuecomment-6042709055 |
| 2026-10-07 | Research addendum: tradable continuation, validated thresholds, reuse | https://github.com/mfittko/market-signals/issues/307#issuecomment-6042752365 |
| 2026-10-07 | Reassessment of the restructured epic | https://github.com/mfittko/market-signals/issues/307#issuecomment-6043133933 |
| 2026-10-07 | Grilling index | https://github.com/mfittko/market-signals/issues/307#issuecomment-6043313447 |
| 2026-10-07 | Grilling input: research foundation as an executable contract | https://github.com/mfittko/market-signals/issues/308#issuecomment-6043257973 |
| 2026-10-07 | Grilling input: a useful filter is not permission to trade | https://github.com/mfittko/market-signals/issues/309#issuecomment-6043269653 |
| 2026-10-07 | Grilling input: qualify the sequential policy, not just its classifier | https://github.com/mfittko/market-signals/issues/310#issuecomment-6043278331 |
| 2026-10-07 | Grilling input: protection must preserve economic value | https://github.com/mfittko/market-signals/issues/311#issuecomment-6043285160 |
| 2026-10-07 | Grilling input: the production guard must enforce eligibility | https://github.com/mfittko/market-signals/issues/312#issuecomment-6043294771 |
| 2026-10-07 | Grilling input: prospective evidence must qualify a frozen policy | https://github.com/mfittko/market-signals/issues/313#issuecomment-6043303061 |
| 2026-10-07 | Post-results addendum: evaluator sensitivity | https://github.com/mfittko/market-signals/issues/308#issuecomment-6047337937 |
| 2026-10-07 | Post-results addendum: calibration and richer representations | https://github.com/mfittko/market-signals/issues/310#issuecomment-6047355796 |
| 2026-10-07 | Post-results reassessment | https://github.com/mfittko/market-signals/issues/307#issuecomment-6047361441 |
| 2026-10-08 | Review of the audit and research results | https://github.com/mfittko/market-signals/issues/307#issuecomment-6053046878 |
| 2026-10-09 | Research direction after scan46 | https://github.com/mfittko/market-signals/issues/310#issuecomment-6084872152 |

The operator adopted the epic-level proposals on 2026-10-07: https://github.com/mfittko/market-signals/issues/307#issuecomment-6043680106.

## Qualification and product framing

| Point | Status | Source |
|---|---|---|
| Separate an observation (flip, impulse), a setup and an actionable entry. A volatility gate is attention, not permission. | Answered in the adopted plan. The research confirms it: the gate does not separate chop from trend ([ladder]), and the big-day alert adds no direction ([lean21]). | [6042709055](https://github.com/mfittko/market-signals/issues/307#issuecomment-6042709055) |
| Use one qualification contract with lifecycle stages separate from per-entry states. | Answered in the adopted plan. | [6043133933](https://github.com/mfittko/market-signals/issues/307#issuecomment-6043133933) |
| Do not make event-time filtering a prerequisite for between-event entries. | Answered. The D-E campaign ran after A-C failed ([ladder]). | [6043133933](https://github.com/mfittko/market-signals/issues/307#issuecomment-6043133933) |
| Judge filters by economic value, not by fewer losers. Compare with random thinning. | Answered. notrade12, limit13, risk8 and filter316 all report a random-thinning null ([notrade12], [filter316]). | [6043269653](https://github.com/mfittko/market-signals/issues/309#issuecomment-6043269653) |
| Enforce eligibility in the backend, test continuous discovery, export the whole pipeline. | Open. Production work, not research. | [6043294771](https://github.com/mfittko/market-signals/issues/312#issuecomment-6043294771) |
| Qualify a frozen policy on prospective data; keep it revocable. | Open. No policy has qualified for shadow. | [6043303061](https://github.com/mfittko/market-signals/issues/313#issuecomment-6043303061) |

## Labels and execution realism

| Point | Status | Source |
|---|---|---|
| Test both sides of the round trip (long ask in, bid out; short bid in, ask out) and stop ordering. | Answered. 15 of 15 fixtures pass; an independent simulator matches ([v1]). | [6043257973](https://github.com/mfittko/market-signals/issues/308#issuecomment-6043257973) |
| Report admissible-path bounds for ambiguous bars. | Answered. Ambiguity moves R per trade by at most 0.002 ([v1]). | [6043133933](https://github.com/mfittko/market-signals/issues/307#issuecomment-6043133933) |
| OANDA candle volume is a price-update count, not traded volume. | Answered. Campaigns state it (xvol9, vol33). | [6043133933](https://github.com/mfittko/market-signals/issues/307#issuecomment-6043133933) |
| Bind labels to the management policy; a new exit invalidates the calibration. | Answered for research: every campaign freezes its management policy. | [6043133933](https://github.com/mfittko/market-signals/issues/307#issuecomment-6043133933) |
| A checksum alone cannot reproduce an inaccessible local snapshot. | Partly answered. [data.md](data.md) and [registry/LOCAL-EVIDENCE.md](registry/LOCAL-EVIDENCE.md) give fetch scripts and sha256. The live `history.db` has no immutable snapshot. | [6043133933](https://github.com/mfittko/market-signals/issues/307#issuecomment-6043133933) |

## Evaluator sensitivity

| Point | Status | Source |
|---|---|---|
| Add positive controls, a power study, a trade trace and falsification fixtures. | Answered ([v1], [v2]). | [6047337937](https://github.com/mfittko/market-signals/issues/308#issuecomment-6047337937) |
| 0 of 40 false qualifications means "none observed", with a Wilson upper bound near 8.8%. | Answered in wording; the limit stands. | [6053046878](https://github.com/mfittko/market-signals/issues/307#issuecomment-6053046878) |
| V4 still has poor power near the useful effect and misses subset-confined signals. Add a rare-opportunity control. | Open. | [6053046878](https://github.com/mfittko/market-signals/issues/307#issuecomment-6053046878) |

## Models and targets

| Point | Status | Source |
|---|---|---|
| Compare representations under identical targets, costs and policies. | Answered. No useful advantage demonstrated ([bench1], [fm2]). | [6047355796](https://github.com/mfittko/market-signals/issues/310#issuecomment-6047355796) |
| Test candidate coverage separately from model choice. | Answered. The label is the dead end, not the population ([ablate4]). | [6047355796](https://github.com/mfittko/market-signals/issues/310#issuecomment-6047355796) |
| Compare a fixed model with a scheduled refit. | Answered. Refit changes little; the data drifts ([risk8]). | [6047355796](https://github.com/mfittko/market-signals/issues/310#issuecomment-6047355796) |
| Do not ship T2 as a big-move alert; it measures relative volatility. | Answered. The recommendation in fm2 is superseded by [alert7]. | [6053046878](https://github.com/mfittko/market-signals/issues/307#issuecomment-6053046878) |
| Register an absolute forward-move target measured from the assessment time. | Answered. [abs11] and [abs48] tested it. Both failed their registered rules, mainly on recall; the ranking holds (AUC 0.78 to 0.90). | [6053046878](https://github.com/mfittko/market-signals/issues/307#issuecomment-6053046878) |
| Separate the monitoring population from entry eligibility. | Answered in abs48, which scores all valid sessions with no entry filter. | [6053046878](https://github.com/mfittko/market-signals/issues/307#issuecomment-6053046878) |

## Risk and exits

| Point | Status | Source |
|---|---|---|
| Protection must preserve economic value and runners; compare with random thinning. | Answered. No overlay qualifies ([risk8]). | [6043285160](https://github.com/mfittko/market-signals/issues/311#issuecomment-6043285160) |
| The volatility-scaled stop is an exploratory lead, not permission. | Open as a lead; needs a new registration on prospective data. | [6053046878](https://github.com/mfittko/market-signals/issues/307#issuecomment-6053046878) |

## Costs and vehicles

| Point | Status | Source |
|---|---|---|
| Uniform 0/3/6% financing is a sensitivity model. Use broker-specific, side-specific financing with commodity basis adjustments. | Open. The survey documents the OANDA terms ([topics/costs-and-vehicles.md](topics/costs-and-vehicles.md)); no campaign has used them yet. | [6053046878](https://github.com/mfittko/market-signals/issues/307#issuecomment-6053046878) |
| The multi-week result does not disprove medium-horizon trend effects. | Answered in wording ([mw6] power statement). | [6053046878](https://github.com/mfittko/market-signals/issues/307#issuecomment-6053046878) |

## Methodology

| Point | Status | Source |
|---|---|---|
| A trial register and block bootstrap do not correct selection. Specify a multiple-comparison procedure. | Answered. Later campaigns use Holm; scan46 uses Deflated Sharpe ([topics/methodology.md](topics/methodology.md)). | [6043133933](https://github.com/mfittko/market-signals/issues/307#issuecomment-6043133933) |
| Treat already-inspected windows as development evidence. | Answered. 2023+ is a development window in every campaign since the audit. | [6047361441](https://github.com/mfittko/market-signals/issues/307#issuecomment-6047361441) |
| Validate the scan46 DSR application on synthetic strategy libraries before another large campaign. Do not lower the hurdle. | Open. | [6084872152](https://github.com/mfittko/market-signals/issues/310#issuecomment-6084872152) |
| Publish evaluator, protocols, controls, targets, training counts and reports; keep raw data out; use timezone-explicit timestamps. | Answered by this folder and [registry/](registry/README.md). Protocol timestamps carry an offset (for example +0200). | [6053046878](https://github.com/mfittko/market-signals/issues/307#issuecomment-6053046878) |

## Research direction after scan46

| Point | Status | Source |
|---|---|---|
| Stop broad chart-rule and move-threshold scans. | Answered. No further scan was registered after [scan46] and [roll47]. | [6084872152](https://github.com/mfittko/market-signals/issues/310#issuecomment-6084872152) |
| Priority 1: one release family (EIA, WTI), its surprise against prior expectations, and the confirmed price response. | Open, not tested. | [6084872152](https://github.com/mfittko/market-signals/issues/310#issuecomment-6084872152) |
| Priority 2: order-book dynamics around the frozen flow29 signal, after replicating flow29 on another period. | Lost its basis. The prerequisite replication ran as [flow42] and failed: continuation 49.5% against a 50.0% baseline, and heavy flow adds nothing beyond the price move. | [6084872152](https://github.com/mfittko/market-signals/issues/310#issuecomment-6084872152) |
| Priority 3: inventory and curve state for WTI, weather-forecast revisions with storage for natural gas. | Open. OANDA commodity mids contain no roll yield, so this needs futures data ([topics/costs-and-vehicles.md](topics/costs-and-vehicles.md)). | [6084872152](https://github.com/mfittko/market-signals/issues/310#issuecomment-6084872152) |
| Use LLMs as auditable event-fact extractors, not as direction callers. | Open. | [6084872152](https://github.com/mfittko/market-signals/issues/310#issuecomment-6084872152) |
| Freeze one version of the daily index pullback and collect prospective observations. | Planned in https://github.com/mfittko/market-signals/issues/323. | [6084872152](https://github.com/mfittko/market-signals/issues/310#issuecomment-6084872152) |

## Daily index pullback

The review reads swing44 as a modest, uncertain candidate with crash losses near 18.5% and substantial left-tail exposure. It is a mean-reversion candidate, not rapid profit protection. A tight stop would change the effect under test. The selection history must stay attached to the frozen version. See [topics/daily-swing.md](topics/daily-swing.md).

<!-- campaign link definitions -->
[ablate4]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6050530948
[abs11]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6053999202
[abs48]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6085151801
[alert7]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6051635292
[bench1]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6050315703
[filter316]: https://github.com/mfittko/market-signals/issues/316#issuecomment-6055138146
[flow42]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6079878152
[fm2]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6051264073
[ladder]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6046831326
[lean21]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6059927619
[mw6]: https://github.com/mfittko/market-signals/issues/314#issuecomment-6051504954
[notrade12]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054177967
[risk8]: https://github.com/mfittko/market-signals/issues/311#issuecomment-6051369045
[roll47]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084812980
[scan46]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084524130
[v1]: https://github.com/mfittko/market-signals/issues/308#issuecomment-6048120221
[v2]: https://github.com/mfittko/market-signals/issues/308#issuecomment-6048905005
