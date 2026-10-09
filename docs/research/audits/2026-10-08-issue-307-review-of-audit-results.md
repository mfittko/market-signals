# Audit: Review of the newly logged audit and research results (2026-10-08)

- Date: 2026-10-08T05:30:32Z (UTC)
- Source: https://github.com/mfittko/market-signals/issues/307#issuecomment-6053046878
- Posted by the operator on behalf of the external auditor.

## Follow-up

- Point 3 (repair the target): [abs11](../registry/campaigns/abs11/) tested an absolute big-move target and [abs48](../registry/campaigns/abs48/) scored it on the move left after the alert. Both failed their registered rules, mainly on recall. The ranking holds (AUC 0.78 to 0.90).
- Point 6 (publish the evidence): the [research home](../README.md) and the [registry](../registry/README.md).
- Open: broker-specific financing per side for the multi-week conclusion (point 5).

## Verbatim text

## Review of the newly logged audit and research results (2026-10-08)

Reviewed the reported audit v1/v2, representation benchmark, population/target ablation, foundation-model/retrieval comparison, risk overlay, multi-week study and final six-instrument alert replication. This is a review of the posted reports, not an independent rerun: the local audit artifacts were not available in the default-branch `research/` path I checked.

**Decision: no tested combination currently earns entry permission. The audit identified genuine evaluation defects, but the corrected diagnostics do not turn the existing entries profitable. The latest finding is also a product-target failure: T2 predicts expansion relative to current ATR, not the large absolute moves the operator wants. Do not ship a big-move notification from T2.**

### 1. What the evaluator audit changes

The [v1 audit and v2 correction](https://github.com/mfittko/market-signals/issues/308#issuecomment-6048905005) substantively answer the concerns raised earlier:

- WTI E was not fitted because support was insufficient. Its old `rejected` result is correctly replaced with `undefined / unavailable; no verdict`. It is not a negative ML performance experiment.
- The original E selection procedure had very poor detection power and could miss planted subset signals even with the true driver supplied. This limits the interpretation of zero-entry results.
- XAU's calibration reversal was a fitted negative Platt slope on a weak calibration window, not a discovered class/sign wiring error. The reported negative outcomes in every raw-score quintile mean this does not rescue the tested XAU policy.
- Fill/accounting checks and the independent simulator reportedly reproduce the losses. Intrabar ambiguity changes the reported means by at most about 0.002R, so it does not explain the strategy losses.
- The optimistic-bound bug and ledger/support-guard defects have versioned corrections. The prior 2023+ windows are now appropriately identified as development evidence where earlier results informed later choices.

**Two limits remain:** V4 still has poor learner-level power near the useful-effect range and still misses most subset-confined signals. Also, 0/40 false qualifications is 'none observed', not 'false qualification ruled out': the report itself gives a Wilson upper bound around 8.8%. Keep independent synthetic-control validation, stated uncertainty, and campaign-level selection accounting. A hard 10% row-coverage floor deserves an explicit rare-opportunity control because it can dilute precisely the selective opportunities the operator seeks. Do not lower economic or safety requirements to force a pass.

### 2. The final alert replication supersedes the earlier recommendation to ship T2

The [six-instrument replication](https://github.com/mfittko/market-signals/issues/310#issuecomment-6051635292) is the decisive update. AUC around 0.76-0.87 and precision of 0.93-1.00 coexist with only 5-22% recall of the largest percentage moves and 0-11% recall in the reported crisis suites. Alerted median percentage moves can be smaller than ordinary ones.

That is internally coherent: `future excursion / current short-horizon ATR >= 6` becomes easy to satisfy after very quiet periods and difficult during an already volatile crisis. It is not necessarily future leakage; it is a valid relative-volatility question that is misaligned with the intended product.

The earlier [foundation-model report](https://github.com/mfittko/market-signals/issues/310#issuecomment-6051264073) recommended shipping the 12-coefficient model as a big-move attention layer. Mark that recommendation superseded by the later alert7 result. Optional silent logging can retain the honest name `session volatility expansion`; it must not become a big-move or entry alert through a wording change.

### 3. The next bounded experiment should repair the target, not add more models

Proposed attention target, to be registered before another campaign:

`M_t(H) = max over future times u in (t, t+H] of abs(P_u / P_t - 1)`

`Y_abs = 1 when M_t(H) >= delta(instrument, horizon)`

Use one explicit price basis. Freeze a meaningful percentage floor or a declared long-baseline percentage threshold rule in development. Do not normalize the outcome threshold by current M5 ATR. ATR remains a permissible predictor and later risk input.

Crucially, the excursion starts at the assessment time: a large move that already happened cannot make a late alert successful. Register whether the horizon is a fixed number of tradable hours, session close, or several days; these are different targets. Include delayed/expired alerts and the remaining move after notification latency.

Keep the initial comparison small: session-clock baseline, volatility baseline, their existing logistic combination, the engineered HGB comparator, and a simple already-moved/range baseline. The current work justifies pausing further T2 model shopping. It does not establish that all sequence models are intrinsically useless.

Evaluate independent event/episode recall, false alerts, lead time, remaining percentage excursion and calibration in the actionable band. Compare at common false-alert budgets without imposing an operational alert quota. Known crisis periods remain stress tests, not freshly untouched confirmation.

Separate the monitoring population from entry eligibility. The alert7 amendment demonstrates that a spread/R entry filter can remove most XAG/NATGAS observations and favor high-ATR periods. Broad market surveillance should not silently inherit that trading-selection bias. Cost and risk gates still apply before any entry.

This is only an **attention** target. Direction, favorable-before-adverse path quality and net entry economics still need their own evidence; an improved absolute-move forecast grants no permission by itself.

### 4. What the richer models and overlays do establish

The [representation and target benchmarks](https://github.com/mfittko/market-signals/issues/310#issuecomment-6050530948) close the earlier missing-tree-comparator gap and substantially weaken the hypothesis that changing learner alone fixes the current labels. The headline should be 'no useful advantage demonstrated for these targets/populations/procedures', not 'nothing is learnable'. Positive-control power and available training support limit stronger conclusions.

The [risk overlay study](https://github.com/mfittko/market-signals/issues/311#issuecomment-6051369045) also answers an open suggestion: none passes its complete product requirements. V1's reported incremental benefit is an exploratory lead, not permission to discard the failed runner-retention requirement. Keeping a fixed 1.5 ATR stop is a research-baseline decision, not endorsement of the still-losing strategy.

The foundation-model comparison is scoped to the supplied inputs and score construction. Models given trailing price levels without an explicit session clock did not beat clock-aware baselines; adding their scores to those baselines also did not help. That is sufficient to pause this branch. Unknown pretraining overlap is a provenance uncertainty, not a guarantee that any contamination must improve performance.

### 5. Keep the multi-week conclusion scoped to evidence and cost assumptions

The [multi-week report](https://github.com/mfittko/market-signals/issues/314#issuecomment-6051504954) correctly reports no qualifying policy and predominantly inconclusive outcomes. It should not be read as disproving medium-horizon trend effects.

Uniform 0/3/6% financing on both sides is a sensitivity model, not verified broker economics. Bind the actual intended OANDA entity/account/product and historical side-specific funding, including commodity basis adjustments where applicable. OANDA documents separate long/short rates, potential credits, and a link between commodity CFD pricing and financing. The model can overstate or understate costs depending on product and side. See [OANDA financing methodology](https://www.oanda.com/uk-en/trading/financing-costs/) and [commodity funding explanation](https://www.oanda.com/bvi-en/cfds/financing-costs/).

The reported 15-40-year detection requirement also needs its assumptions, significance level and desired statistical power. A confidence-interval-width estimate is not a universal data requirement; overlapping trades and correlated instruments do not supply independent years of evidence.

### 6. Concrete next action and evidence boundary

Publish the evaluator version, registered protocols/amendments, control outputs, target definitions, model-training counts and aggregate reports in a reproducible repository location. Keep raw market data out of git and refer to immutable manifests. Make preregistration timestamps timezone-explicit and retain the disclosed post-result population amendment as development evidence.

Then run one bounded **absolute-forward-move target validation** campaign, while retaining the rare-subset positive-control limitation as unresolved. No new model catalog, no promotion, and no automatic continuation of the old trial budget. Silent experimental capture is distinct from the formal SHADOW lifecycle stage and must not bypass #313's admission rules.

**Bottom line:** the audit was worthwhile and corrected real problems. The most useful new discovery is that the attractive high-AUC target was answering the wrong question. Fix that measurement before investing in another scorer or notification feature.
