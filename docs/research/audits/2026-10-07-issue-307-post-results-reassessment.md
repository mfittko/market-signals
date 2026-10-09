# Audit: Post-results reassessment: evaluator audit and a bounded representation benchmark

- Date: 2026-10-07T21:38:22Z (UTC)
- Source: https://github.com/mfittko/market-signals/issues/307#issuecomment-6047361441
- Posted by the operator on behalf of the external auditor.

## Follow-up

- Evaluator audit: [v1](../registry/campaigns/v1/). Corrections and the registered E redesign: [v2](../registry/campaigns/v2/).
- Representation benchmark: [bench1](../registry/campaigns/bench1/). Population ablation: [ablate4](../registry/campaigns/ablate4/). Foundation models and retrieval: [fm2](../registry/campaigns/fm2/). Fixed vs scheduled refit: [risk8](../registry/campaigns/risk8/).

## Verbatim text

## Post-results reassessment: evaluator audit and a bounded representation benchmark

The operator asked whether statistical/experimental errors or limited model representations could explain the negative findings, and requested that the follow-up be recorded in the relevant issues.

**Updated interpretation:** the tested combinations have not qualified. That is not evidence that every intraday model or representation must fail. Conversely, a possible methodological problem is not evidence that a profitable strategy exists. The original numerical results and verdicts remain unchanged pending a reproducible correction, if any.

The [current D–E report](https://github.com/mfittko/market-signals/issues/310#issuecomment-6046831326) explicitly says the tree comparison was not run because LightGBM was unavailable and describes backwards calibration on XAU. Both deserve follow-up, but neither is a confirmed implementation defect. No local experiment was rerun for this review.

### Amendments recorded with their owners

| Owner | Addendum | Main deliverable |
| --- | --- | --- |
| #308 | [Evaluator sensitivity and statistical audit](https://github.com/mfittko/market-signals/issues/308#issuecomment-6047337937) | End-to-end positive controls and power estimates; traceable label/score/fill cases; accounting and intrabar-ordering evidence; campaign-level holdout lineage; confirmed / ruled-out / unresolved audit findings. |
| #310 | [Calibration diagnostics and richer-representation benchmark](https://github.com/mfittko/market-signals/issues/310#issuecomment-6047355796) | Investigate raw versus calibrated scores and zero-entry behavior; compare the logistic baseline with boosted trees, MiniRocket features and TS2Vec embeddings; separately test candidate coverage and fixed versus scheduled rolling training. Primary literature and implementation references are included. |

### Proposed sequence for grilling

`Validate the evaluator -> compare representations under identical targets/costs/policies -> separately test candidate coverage or target changes -> evaluate the complete executable policy -> prospective confirmation.`

Keep the campaign finite and preregistered. Do not change evaluator assumptions, features, targets, thresholds and exits together and then attribute the improvement to ML. Already-inspected historical results remain development evidence where they informed later choices; a new configuration name does not restore an untouched holdout.

The current safeguards already address many audit concerns in specification. The task is to produce implementation evidence, not assume they are missing or broken. Zero entries can be correct abstention, but accepted-population calibration and R/trade then have no sample support.

### Scope and downstream boundaries

This is a proposed new campaign, not an automatic extension of the locked D–E trial budget. The historical verdicts, lifecycle stages and qualification requirements are not relaxed.

- #311 continues to own exit/protection changes and their effect on policy-dependent labels. A loss under one entry/exit combination does not isolate the source of the loss.
- #312 remains the deterministic permission boundary. A scientifically useful richer scorer is not prohibited by logistic coefficient export, but needs an explicitly supported full-pipeline artifact/runtime and parity tests before deployment.
- #313 owns fresh prospective confirmation. A scheduled retraining procedure would require an explicit versioned protocol and lifecycle refinement; it must not be silently introduced into a fixed-candidate evaluation.
- #314 retains multi-day horizons. News embeddings remain an optional attention/risk workstream, never independent directional authority. More expensive transformer/foundation-model experiments stay optional and separately budgeted.

**No new performance result, confirmed statistical error or trading permission is claimed by these addenda.** The immediate decision is whether to approve the bounded audit/benchmark protocol, not whether to deploy another predictor.
