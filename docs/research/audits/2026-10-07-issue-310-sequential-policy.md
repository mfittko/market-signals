# Audit: Grilling input: qualify the sequential decision policy, not just its classifier

- Date: 2026-10-07T17:32:52Z (UTC)
- Source: https://github.com/mfittko/market-signals/issues/310#issuecomment-6043278331
- Posted by the operator on behalf of the external auditor.

## Follow-up

- Ladder D to E interim verdict: https://github.com/mfittko/market-signals/issues/310#issuecomment-6046831326.
- Population the model will see (point 3): [ablate4](../registry/campaigns/ablate4/).

## Verbatim text

## Grilling input: qualify the sequential decision policy, not just its classifier

Issue-specific follow-up to the [epic reassessment](https://github.com/mfittko/market-signals/issues/307#issuecomment-6043133933). D directly addresses the operator's requirement: a valid entry can develop between flips/impulses. Preserve that as an independently testable hypothesis.

### 1. Fix the prerequisite and the comparator

Require #308 to be valid and #309 to be completed, not necessarily positive. Unprofitable filtering at the original event timestamp does not establish that a later confirmation/pullback entry is unprofitable. Permit one bounded, preregistered D/E campaign after a negative B/C result; do not automatically carry a failed filter into D.

Declare the comparator before testing. D should be compared with the applicable frozen immediate-entry baseline, including missed/abandoned opportunities and waiting costs. E should be compared with **the same D policy without statistical selection**. C is a useful additional comparator when applicable, not automatically the only valid baseline. Report the full economic result as well as incremental improvement.

### 2. Make between-event discovery and stopping times testable

Freeze the evaluation cadence, causal setup-discovery rule, side, confirmation/invalidation rules, entry window, expiry, rearm and position-overlap behavior. Discover established setups without requiring a recent flip, including after startup with sufficient warm-up data.

Replay decisions using only information available at each evaluation time. A historical best entry candle is not a permissible choice. Count every candidate episode, including no-entry outcomes; report how much waiting avoids losses, misses winners, changes fill price, and leaves remaining opportunity.

At minimum, include an end-to-end fixture: **flip rejected -> several no-event evaluations -> confirmation/eligible entry -> eventual expiry or invalidation**, and a second fixture where no qualifying entry ever occurs. D's clock/cadence and lifecycle must be exported to #312, not reimplemented there as unrelated UI behavior.

### 3. Evaluate E on the population it will actually see

A model trained only at flip/impulse timestamps is not automatically qualified at every subsequent candle. Specify the training population, episode grouping/weights, and outcome windows for the actual between-event decisions. Evaluate the final selected entry timestamps produced by the complete D+E policy, not only aggregate metrics across all repeated candidate rows.

Keep preprocessing/model fitting, calibration, threshold selection and final evaluation chronologically separated within the declared validation protocol. Prevent overlapping-label and same-episode leakage; do not let default random/stratified splits decide the protocol. Scikit-learn documents [calibration](https://scikit-learn.org/stable/modules/calibration.html) as a fitted mapping and [threshold tuning](https://scikit-learn.org/stable/modules/classification_threshold.html) as a separate decision problem.

Reliability curves need sample support/uncertainty in the accepted score bands. Brier score and log loss are useful predictive scores, but neither by itself demonstrates calibration or positive net economic value. Check behavior by the preregistered side/instrument/operating scope where evidence permits, and report sparse support honestly rather than presenting unstable percentages as precise.

Do not force a fixed alert quota through a top-percentile threshold. A rank may prioritize attention; entry permission still needs the absolute, predeclared quality/economic/risk requirements. Zero entries can be a correct operational outcome, while persistently negligible coverage remains a research concern.

### 4. Bind forecasts and qualification to the complete policy

Version the initial stop, horizon, milestone and management policy with the labels and probability estimates. Distinguish entry-time runner probability from a post-milestone update. When #311 changes a policy-dependent outcome, regenerate affected labels and refit/recalibrate within a fresh permitted development/evaluation sequence as needed. Do not keep old probabilities attached to a different trailing policy.

Qualification must specify the supported entry/stop/horizon configurations. Arbitrary operator/agent proposals outside that scope return UNAVAILABLE unless explicitly modeled and evaluated. Rejecting one side is not evidence supporting the other.

### 5. Scope generalization, artifacts and decisions honestly

A requirement for positive evidence on multiple instruments fits a cross-instrument claim, but should not block shadow testing of a supported WTI-only candidate. Predeclare instrument selection/replication and record all attempts; do not retrospectively choose the best instrument and call it an untouched confirmation. Preserve shared calendar shocks in pooled comparisons. Crisis suites remain stress tests, as this issue correctly states.

The tree challenger conflicts with the coefficient-only production contract. Either label it research-only for v1 or define an explicitly supported artifact/runtime before selection for deployment. Export the **whole inference/decision pipeline**: feature definitions/order, transforms, missing-data handling, model, calibrator, thresholds, label/management versions, allowed scope and evidence reference.

Use supported/rejected/inconclusive results. A useful D can progress without a useful E; a simpler statistically supported policy should not be forced to acquire an ML layer. Neither relative improvement nor successful calibration alone grants actionable entry permission.

**Grilling question:** Can we replay the exact first permitted entry the deployed system would choose, demonstrate improvement over its unfiltered sequential baseline, and reproduce the same decision from the exported artifacts without relying on hindsight or an event-time-only training population?
