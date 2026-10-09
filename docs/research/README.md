# Research

This folder is the canonical documentation of the market-signals research: our campaigns, other people's research and the external sources. It interprets and condenses. GitHub issue comments stay the primary record, and every claim here links to them or to a cited source.

Use it as the grounding for new research. Before proposing a campaign, check [findings.md](findings.md) for what is already known, [open-questions.md](open-questions.md) for the ranked backlog, and [topics/methodology.md](topics/methodology.md) for the rules.

## Layout

| Path | Content |
|---|---|
| [findings.md](findings.md) | The canonical claims, each with a grade, key numbers, scope and sources. |
| [topics/](topics/) | One page per theme, synthesised across campaigns and literature. |
| [campaigns.md](campaigns.md) | All 48 campaigns with question, verdict, key number, grade and links. |
| [sources.md](sources.md) | External papers, repositories, broker documents and data vendors with takeaways and credibility notes. |
| [external-review.md](external-review.md) | The external auditor's points by theme, each with its status. |
| [open-questions.md](open-questions.md) | The ranked research backlog. |
| [data.md](data.md) | Data sources, fetch methods, costs and local paths. |
| [registry/](registry/README.md) | The reproducibility layer: protocols, amendments, scripts, the evaluator, trial counts, manifests and the list of local evidence. |

Topic pages: [intraday-direction](topics/intraday-direction.md), [volatility-and-big-days](topics/volatility-and-big-days.md), [costs-and-vehicles](topics/costs-and-vehicles.md), [news](topics/news.md), [order-flow](topics/order-flow.md), [daily-swing](topics/daily-swing.md), [trend-and-carry](topics/trend-and-carry.md), [calendar-and-seasonality](topics/calendar-and-seasonality.md), [cross-asset](topics/cross-asset.md), [llm-in-trading](topics/llm-in-trading.md), [methodology](topics/methodology.md).

## Evidence grades

| Grade | Meaning |
|---|---|
| A | Replicated externally and in our data. |
| B | Our preregistered result. Positive or negative. |
| C | External claim not tested here. |
| D | Anecdote, post-hoc analysis or backtest only. |

A grade describes the evidence, not the size of the effect. A negative result can be grade A or B.

## What we know (2026-10-09)

All campaign results are development evidence. 2023 onward was inspected before this series, so it is a second development window, never an untouched holdout.

| Claim | Grade | Where |
|---|---|---|
| Intraday direction has no edge after CFD costs on the six instruments (WTI, XAU, XAG, NATGAS, SPX500, EUR/USD), from M1 to H1. Richer models, foundation models, chart-rule libraries and news bursts did not change this. | A | [findings F01](findings.md#f01-intraday-direction-has-no-edge-after-cfd-costs-on-the-six-instruments), [topics/intraday-direction.md](topics/intraday-direction.md) |
| Volatility and session timing are learnable (AUC 0.76 to 0.87), but a target relative to ATR mostly learns the session clock. | B | [findings F09, F10](findings.md#volatility-and-big-days), [topics/volatility-and-big-days.md](topics/volatility-and-big-days.md) |
| The absolute big-day model ranks well (AUC 0.78 to 0.90) and fails its registered recall bar (abs11, abs48). It gives no direction. | B | [findings F11](findings.md#f11-the-absolute-big-day-model-ranks-well-but-fails-its-recall-bar), [abs11], [abs48] |
| The cost shield works: skipping entries with spread above 0.2 R and thin hours cuts losses by about 70 to 80%. The remaining signals still lose about -0.12 R. | B | [findings F14](findings.md#f14-spread-and-thin-hour-filters-cut-losses-but-leave-signals-negative), [notrade12] |
| The spread is 0.5 to 0.6 of the typical M1 move and 0.01 to 0.02 of the daily move on index CFDs. Financing dominates beyond a few days. | A (spread), B (financing) | [topics/costs-and-vehicles.md](topics/costs-and-vehicles.md) |
| The daily index pullback is the only forward candidate: positive in two index sets, not significant, with a left tail. Forward test: https://github.com/mfittko/market-signals/issues/323. | B, with external support | [findings F18](findings.md#f18-the-daily-index-pullback-is-positive-but-not-significant), [topics/daily-swing.md](topics/daily-swing.md) |
| A single significant pass needs replication. flow29 (Holm p 0.002) failed in flow42; the ext39 commodity lead failed in cmd41. | B | [topics/methodology.md](topics/methodology.md) |
| The replicated, cost-surviving premia (carry, volatility risk premium, cross-sectional sorts) are untested here and need other vehicles. | C | [topics/trend-and-carry.md](topics/trend-and-carry.md), [open-questions.md](open-questions.md) |
| LLM direction calls and the live LLM filter add nothing measurable. | B (filter), D (lab) | [topics/llm-in-trading.md](topics/llm-in-trading.md) |

## Rules for this documentation

- Interpret, but never invent numbers. Every number traces to a campaign record, a local output or a cited source. Mark uncertainty plainly.
- Link campaigns to their GitHub result comments. Use full URLs for issues and PRs.
- Keep run outputs, databases and raw data out of git. [registry/LOCAL-EVIDENCE.md](registry/LOCAL-EVIDENCE.md) lists them.
- Update [findings.md](findings.md), the relevant topic page and [campaigns.md](campaigns.md) when a campaign finishes. Change a grade only with a new campaign or a new source.

## Add a campaign

1. Check [findings.md](findings.md) and [open-questions.md](open-questions.md). Answer the registration questions in the backlog header: mechanism, new measurement, availability, why an effect remains, stop rule.
2. Create `data/research/engine/audit/<id>/` with the campaign script. The id is a short name plus the queue number, for example `roll47`.
3. Write `prereg.json` before any outcome run and post the preregistration comment on the research issue.
4. Run the campaign. Post the result comment. Add a row to `data/research/engine/QUEUE.md`.
5. Copy `prereg.json`, amendments and the scripts under 60 KB to `docs/research/registry/campaigns/<id>/`. Leave every run output out.
6. Add the trial counts to `registry/trials-summary.csv` and refresh the local evidence list with `python3 -I docs/research/registry/tools/local_evidence.py`.
7. Add the campaign to [campaigns.md](campaigns.md), update the claims in [findings.md](findings.md) and the topic page, and move the backlog item in [open-questions.md](open-questions.md).
8. Search the new files for "key", "token", "Authorization" and "api_key" before the commit. Credentials come only from environment variables.

<!-- campaign link definitions -->
[abs11]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6053999202
[abs48]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6085151801
[notrade12]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054177967
