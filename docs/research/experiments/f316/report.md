# F316: live LLM filter verdicts scored under E0 (WTICO/USD)

This report claims no edge and no profitable strategy. The untracked filter316 campaign (https://github.com/mfittko/market-signals/issues/316#issuecomment-6055138146) already scored these verdicts under a different management. This run is a reproduction on frozen exports and no independent test.

Question: Do the live LLM alert filter's stored suppressions, overall and per reason category, block signals that are better or worse than average under the E0 rules?

## Inputs

| Item | Value |
|---|---|
| F316 spec | `docs/research/experiments/f316/spec.json`, sha256 `187eba570fac2b1ef73b37263fa900bc7d62dc33a1023da3b522c43f53e155e7` |
| E0 spec | `docs/research/experiments/e0/spec.json`, sha256 `cc038758f1101cbb789a34d861d92200e6df9d40423ef17111da432f2b82f2fb` |
| Outcome export | `tmp/research-export/wtico-usd-m1-ba-2023-2026q3.csv`, sha256 `4177965517fb5697dd8579844c3960cc030f20bd5800d45fac46b1f38b26f488`, 1293832 rows |
| Verdict export | `tmp/research-export/wtico-usd-filter-verdicts-to-2026-09-30.csv`, sha256 `e8756656bb8085aff066d1aba6f7e1577f5ed47ad6a8bddc65d9daf204f648af`, 2013 rows |

Both exports are one-time owner exports and are not committed. Every cost and timing value is the E0 value, labelled in the [E0 declared values](../e0/report.md#declared-values). Every F316 setting is labelled assumed or measured with a source in the F316 spec.

## Rules

The granularities, join, exclusions, reason categories, statistics and decision rule are preregistered in the [F316 spec](spec.json). For each granularity, the M1 bid and ask bars are resampled and `research.Run` replays E0 (Supertrend 10/3 on bid bars, 1.5 ATR stop, 2 R target, reversal, 200-bar time stop in bars of that granularity, 2212 ms decision delay, spread and financing). A suppressed signal is scored as if traded.

## Population

Scored: 1490 of 2013 verdicts, over 61 UTC days.

Excluded verdicts by reason. E0 holds every flip that arrives while a trade is open, so `unmatched` can be large.

| Reason | Verdicts |
|---|---|
| fail_open | 223 |
| unsupported_granularity | 0 |
| unmatched | 300 |
| censored | 0 |

## Allowed and suppressed

Mean net R per signal with its block-bootstrap CI.

| Group | Signals | Mean net R [CI] |
|---|---|---|
| all scored | 1490 | -0.421 [-0.525, -0.321] |
| allowed | 314 | -0.507 [-0.745, -0.298] |
| suppressed | 1176 | -0.398 [-0.494, -0.310] |

## Blocking rules and recommendations

Delta is the blocked mean minus the all mean, in net R. The random-thinning percentile is the share of 500 random draws of the same blocked count whose delta is below the observed delta. The recommendation follows the preregistered decision rule. It describes the stored log under E0 rules only and is no evidence of a profitable strategy.

| Rule | Blocked | Share | Blocked mean | Kept mean | All mean | Delta [CI] | Random-thinning percentile | Recommendation |
|---|---|---|---|---|---|---|---|---|
| all suppressions | 1176 | 78.9% | -0.398 | -0.507 | -0.421 | +0.023 [-0.018, +0.064] | 86.2 | insufficient evidence |
| late_chasing | 669 | 44.9% | -0.425 | -0.418 | -0.421 | -0.004 [-0.074, +0.077] | 46.8 | insufficient evidence |
| against_trend | 528 | 35.4% | -0.368 | -0.451 | -0.421 | +0.053 [-0.065, +0.168] | 86.2 | insufficient evidence |
| low_volume | 1022 | 68.6% | -0.395 | -0.478 | -0.421 | +0.026 [-0.023, +0.072] | 85.2 | insufficient evidence |
| chop_weak_setup | 1114 | 74.8% | -0.388 | -0.519 | -0.421 | +0.033 [-0.013, +0.075] | 94.6 | insufficient evidence |
| news_event | 64 | 4.3% | -0.312 | -0.426 | -0.421 | +0.109 [-0.335, +0.425] | 74.2 | insufficient evidence |
| other | 0 | 0.0% | n/a | n/a | n/a | n/a | n/a | insufficient evidence |

## Late/chasing

By the preregistered rule (late_chasing delta CI lower bound above 0: blocks better-than-average signals; upper bound below 0: worse-than-average; else not distinguishable from average), late/chasing suppressions block signals that are not distinguishable from average: 669 blocked, delta -0.004 [-0.074, +0.077].

## By filter model

Counts and mean net R without CIs. `unknown` is a signal without a snapshot row.

| Model | Allowed | Allowed mean | Suppressed | Suppressed mean |
|---|---|---|---|---|
| anthropic-default | 7 | -0.138 | 6 | +0.126 |
| claude-opus-4-8 | 22 | -0.182 | 22 | -0.505 |
| claude-sonnet-5 | 11 | -1.216 | 13 | -0.308 |
| deepseek-ai/DeepSeek-V4-Flash | 146 | -0.547 | 608 | -0.448 |
| deepseek-ai/DeepSeek-V4.1-Flash | 60 | -0.283 | 317 | -0.292 |
| unknown | 8 | -0.968 | 2 | +2.000 |
| zai-org/GLM-5.2-FP8 | 57 | -0.583 | 186 | -0.505 |
| zai-org/GLM-5.3 | 3 | -1.000 | 22 | +0.040 |

## filter316 reference

Source: filter316 result comment, https://github.com/mfittko/market-signals/issues/316#issuecomment-6055138146, labelled measured. These numbers describe a different management and a different population, so they are a reference and no target. filter316 used another management (1.5 ATR stop, breakeven after 1 R, 3 R target, opposite flip exit, 72-bar horizon, overlapping trades allowed) and another population (all live instruments with bid/ask history except DE30/EUR, 2026-07-22 to 2026-10-08). Its random-thinning percentile ranks kept-minus-all, which falls when blocked-minus-all rises, so it reads roughly as 100 minus the percentile here. Its keep rule also needed the null q97.5 and a Holm-adjusted p below 0.05.

- Scored: 5,455 signals over 61 trading days; 1,007 allowed, 4,448 suppressed (82%).
- Mean net R: all -0.286 [-0.338, -0.233]; allowed -0.276 [-0.373, -0.167]; suppressed -0.288 [-0.339, -0.236].

| Rule | Blocked share | Blocked minus all [CI] | Random-thinning percentile (kept-minus-all) | Decision |
|---|---|---|---|---|
| all suppressions | 82% | -0.002 [-0.019, +0.015] | 59th | insufficient evidence |
| late_chasing | 50% | +0.024 [-0.013, +0.058] | 9th | insufficient evidence |
| against_trend | 33% | -0.041 [-0.090, +0.011] | 91st | insufficient evidence |
| low_volume | 72% | +0.009 | 22nd | insufficient evidence |
| chop_weak_setup | 78% | +0.000 | 49th | insufficient evidence |
| news_event | 1% | +0.056 | 32nd | insufficient evidence |

## Limits

- The filter316 outcomes were seen before this spec was written, so this run is a reproduction and no independent test.
- One instrument, WTICO/USD. The outcome export ends at 2026-09-30T23:59:00Z.
- No multiple-comparison correction across the rules.
- The filter316 drop rule also fired on a delta below the null q2.5 of its random thinning. This rule drops on the delta CI alone, so a filter316 drop can read here as insufficient evidence.
- The regexes run under Go RE2, where `\b` and `\d` are ASCII-only; filter316 ran them under Python `re`, where they also match non-ASCII word characters and digits.
- Rows rewritten by the refilter script cannot be told apart and are kept.

## Run

From `platform/`:

```
go run ./cmd/research-f316 --spec ../docs/research/experiments/f316/spec.json --out <report path>
```
