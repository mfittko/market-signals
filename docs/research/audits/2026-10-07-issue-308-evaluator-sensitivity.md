# Audit: Post-results addendum: validate the evaluator's sensitivity, not only its false-positive controls

- Date: 2026-10-07T21:36:47Z (UTC)
- Source: https://github.com/mfittko/market-signals/issues/308#issuecomment-6047337937
- Posted by the operator on behalf of the external auditor.

## Follow-up

- Positive controls, power study, trade trace, falsification fixtures and holdout scope: [v1](../registry/campaigns/v1/) (https://github.com/mfittko/market-signals/issues/308#issuecomment-6048120221).
- Corrections D1 to D4 and the verdict wording: [v2](../registry/campaigns/v2/) (https://github.com/mfittko/market-signals/issues/308#issuecomment-6048905005).

## Verbatim text

## Post-results addendum: validate the evaluator's sensitivity, not only its false-positive controls

Follow-up to the operator's 2026-10-07 research summary and the [D–E interim results](https://github.com/mfittko/market-signals/issues/310#issuecomment-6046831326). **This is an audit proposal, not a finding that the implementation is defective.** The current body already specifies many safeguards below; the next task is to produce implementation evidence and diagnostic outputs, not repeat the specification. No local scripts or datasets were rerun for this addendum.

The existing verdicts remain recorded. Their scope is the tested configurations, populations and execution assumptions—not every possible intraday predictor. Model/representation experiments belong to #310; this issue should establish whether the evaluator can reliably measure them.

### 1. Add end-to-end positive controls and a power study

Shuffled labels and null entries test whether the procedure invents skill. They do not establish that it can detect a known, economically useful predictive relationship.

Run the **whole pipeline**—candidate generation, features, labels, fitting, calibration, thresholds, fills, costs and qualification—on registered synthetic controls:

| Control | Diagnostic purpose |
| --- | --- |
| No predictive information, with session-dependent volatility and spreads | Measure false qualification under the chosen procedure. |
| An observable feature predicts subsequent drift | Verify label alignment, feature availability, class mapping and recovery of a simple known relationship. |
| A nonlinear feature interaction predicts drift, with weak or zero individual linear effects | Verify that an appropriate nonlinear comparator can recover an effect the additive linear baseline may miss. |
| Predictability confined to an observable subset of episodes | Test candidate coverage and selective-entry thresholds without diluting the effect across all rows. |
| Signal strengths below, near and above the minimum useful effect | Estimate detection probability and inconclusive/rejection rates for the actual episode counts and multiplicity procedure. |

Use multiple registered random seeds and report uncertainty; do not demand that every realization pass. Evaluate the planted relationship's **economic value under the same costs and policy**, rather than equating an injected drift parameter with +0.05R. Keep control-development data distinct from the controls used for the final diagnostic report.

Success here validates a measurement capability, not a market edge. A failure must identify whether it lies in candidate generation, representation, learner, calibration, decision thresholds, execution or statistical power.

### 2. Add a small, hand-auditable trade and score trace

Export representative long/short, accepted/rejected, milestone, timeout and ambiguous cases with immutable row/episode IDs:

`source observations -> as-of features -> intended label -> raw score -> class probability -> calibrated probability -> threshold result -> order/fill events -> net R`

Check label/feature alignment after sorting, resampling and dropping missing rows; long/short sign conventions; class ordering; consistent feature order/scaling; and whether a calibrator receives the same score type in fitting and inference. Include delayed label maturity in training eligibility.

The D–E report says XAU calibration runs backwards. Separate **an implementation inversion** from **an empirical reversal of observed outcome rates across score bands** caused by noise or changed conditions. Inspect raw and calibrated outputs separately; do not invert a model after seeing the test unless a specific implementation defect is established. Calibration is a separately fitted mapping; fitting it on the predictor's own training predictions can bias it. [R1]

### 3. Verify accounting and ordering with explicit falsification fixtures

An elementary round trip, with bid fixed at 100.00, ask fixed at 100.10, unit multiplier and no other fees, loses **0.10 per unit** for either a long or short. It must not lose 0.20 from subtracting spread again after executable-side fills. Apply the R denominator separately and transparently.

Add evidence for already-specified rules: no fill before the decision exists; no retroactive stop modification; correct active stop while a modification is pending; no favorable movement counted after an earlier stop; price breakeven distinct from net-of-cost breakeven.

M1 bid/ask OHLC does not reveal quote ordering inside a bar. OANDA's schema describes separate OHLC components and start timestamps, not a joint tick path. [R2] Preserve the conservative result, but also publish the result range under admissible ordering assumptions and compare a representative finer-data sample where available. A pessimistic scenario is not an unbiased estimate of unknown ordering. Do not select favorable ordering or drop ambiguous trades to rescue a candidate.

If a correction is established, archive the original run, add a regression fixture and rerun with a new code/result version. A corrected rerun is a correction—not a new untouched market test.

### 4. Audit the scope of the holdout across campaigns

The ledger must record **which results informed which later decisions**, not only that each configuration was scored once. Check preregistration timestamps and whether A–C test feedback affected the spread filter, features, candidates or objectives used for D–E on the same 2023–2026 interval.

A prior frozen study and a later study can use the same dates without direct label fitting, yet the later researcher may already have learned from those outcomes. Model-selection feedback can bias subsequent evaluation. [R3] This concern does not explain away negative point estimates; it limits the independence of future positive claims.

Label already-inspected periods honestly as development evidence when applicable. Use chronological outer evaluations for a frozen research procedure and fresh prospective confirmation under #313. Register the correction/new-campaign distinction and the total comparison family; do not reset the trial count or holdout status by renaming configurations.

### 5. Separate technical validity from policy rejection and insufficient power

Report three distinct layers: market-path predictability, conversion by the frozen management policy, and net execution economics. A negative full-loop result may reflect any of these; diagnosing the source does not authorize changing the objective retrospectively.

Report row counts, episode counts, residual cross-episode dependence and block-length sensitivity. Grouping by episode does not itself prove independence. A supported foundation means the evaluator works under declared assumptions; it must not require a real-market strategy to show positive returns.

**Suggested deliverable:** a versioned `evaluator-audit` report and fixtures, with each concern marked confirmed defect / ruled out by evidence / unresolved, plus positive-control recovery and power results. Publish the code, configuration and manifests supporting the report. Freeze evaluator changes before #310 compares new representations.

### Primary references

- [R1: scikit-learn probability calibration](https://scikit-learn.org/stable/modules/calibration.html).
- [R2: OANDA candle schema](https://developer.oanda.com/rest-live-v20/instrument-df/).
- [R3: Cawley & Talbot, On Over-fitting in Model Selection and Subsequent Selection Bias in Performance Evaluation](https://www.jmlr.org/papers/v11/cawley10a.html).

**Grilling question:** Would this exact evaluator recover a known, observable and cost-adjusted advantage near our minimum useful effect, and can we show precisely why it rejects or abstains when it does not?
