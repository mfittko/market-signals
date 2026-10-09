# Audit: Grilling input: distinguish a useful filter from permission to trade

- Date: 2026-10-07T17:32:23Z (UTC)
- Source: https://github.com/mfittko/market-signals/issues/309#issuecomment-6043269653
- Posted by the operator on behalf of the external auditor.

## Follow-up

- Ladder A to C verdict: https://github.com/mfittko/market-signals/issues/309#issuecomment-6046593404.
- Filters scored as filters: [notrade12](../registry/campaigns/notrade12/) and [filter316](../registry/campaigns/filter316/).

## Verbatim text

## Grilling input: distinguish a useful filter from permission to trade

Issue-specific follow-up to the [epic reassessment](https://github.com/mfittko/market-signals/issues/307#issuecomment-6043133933). A/B/C is a good first comparison. The main amendments concern the experiment contract and interpretation, not adding more indicators.

### 1. Freeze the opportunity stream and what C changes

Identify the exact baseline strategy/version, signal kinds, executable event-time entry rule, sizing, stop, exit, horizon and position-overlap rules. State explicitly whether C is **A plus geometry/chop filtering at the same original entry opportunities**, with no volatility filter. Do not silently change entry timing or stops in C; those are later experiments.

Define every proposed feature causally. A swing/invalidation level must be discoverable at the decision time; an ATR must not use future bars; “spread relative to expected move” needs a backward-looking estimate rather than the subsequently realized move. Specify zero-denominator/missing-input behavior. Predeclare a small set of rule configurations and record their thresholds in the trial register.

### 2. Replace the ambiguous go/no-go rule with separate decisions

The current condition, improved R/trade **or fewer losing trades**, can identify a useful research direction without establishing an economically usable strategy.

Illustration only: improving from -0.12R/trade to -0.03R/trade is genuine improvement but remains loss-making. Blocking almost all entries trivially reduces the number of losers. Therefore report separately:

- **Incremental selection value:** paired improvement versus A and an appropriate execution/opportunity-matched null, with dependence-aware uncertainty.
- **Economic qualification:** the complete selected policy meets the epic's predeclared net-return/risk objective against its economic reference, including no-trade, under the declared execution assumptions.
- **Research continuation:** whether another bounded, preregistered hypothesis is justified. This is not deployment approval.

Choose a primary objective and minimum useful effect before evaluation, with return/runner-retention, risk and coverage constraints. Include calendar-period net outcomes under common capital/risk assumptions alongside R/trade, because the strategies can take different numbers of trades. Coverage is an evaluation safeguard against winning by blocking everything, not a daily alert quota.

### 3. Make uncertainty and selection controls explicit

Use paired calendar-block results for A/B/C, report effective episode support, and show concentration by session and period. Preserve the complete opportunity stream, including rejected entries and their frozen-policy counterfactual outcomes. Report avoided losses and blocked gains in economic magnitude, not only counts.

The trial budget, block bootstrap and final protected evaluation serve different purposes. Specify how selection across rule variants and thresholds is handled; an interval around the chosen winner alone does not correct for trying many candidates. The existing `arch` dependency has [multiple-comparison procedures](https://arch.readthedocs.io/en/stable/multiple-comparison/multiple-comparisons.html), but the chosen procedure and assumptions must be documented.

Return **supported / rejected / inconclusive** against predeclared criteria. An interval spanning zero is not proof of no effect. Conversely, a statistically detectable tiny effect need not be economically useful. Include the adverse cost/latency case already requested, and carry forward #308's intrabar-ambiguity sensitivity.

### 4. Do not block #310 merely because filtering at the original flip fails

This issue evaluates original event-time entries. D in #310 evaluates waiting and entering later. Failure of B/C does not falsify D. Change #310's dependency to **validated foundation and completion of this baseline study**, with one finite, preregistered D/E campaign permitted even after a negative B/C result. Failed filters need not be carried forward.

The report can recommend stopping a particular component without claiming that every different entry-timing hypothesis has been rejected. Keep a bounded research budget; do not turn an inconclusive result into indefinite search.

**Suggested acceptance additions:** a frozen opportunity/feature contract; paired baseline/null/economic-reference comparisons; separate incremental-value and deployment-qualification decisions; an explicit inconclusive outcome; and a D/E dependency based on completed valid research rather than mandatory B/C success.

**Grilling question:** If this experiment reports success, can we show that it retained economically useful opportunities rather than merely traded less—and can we state precisely what that success does and does not authorize?
