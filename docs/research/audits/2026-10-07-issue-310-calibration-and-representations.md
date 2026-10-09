# Audit: Post-results addendum: audit calibration and test richer representations in a bounded new campaign

- Date: 2026-10-07T21:37:59Z (UTC)
- Source: https://github.com/mfittko/market-signals/issues/310#issuecomment-6047355796
- Posted by the operator on behalf of the external auditor.

## Follow-up

- Calibration and abstention (point 1): [v1](../registry/campaigns/v1/) and [v2](../registry/campaigns/v2/).
- Representation benchmark (point 3): [bench1](../registry/campaigns/bench1/). Candidate coverage (point 4): [ablate4](../registry/campaigns/ablate4/). Embeddings and retrieval (point 5): [fm2](../registry/campaigns/fm2/).
- Fixed vs rolling training (point 6) and exits (point 7): [risk8](../registry/campaigns/risk8/).

## Verbatim text

## Post-results addendum: audit calibration and test richer representations in a bounded new campaign

Companion to the [evaluator-audit proposal on #308](https://github.com/mfittko/market-signals/issues/308#issuecomment-6047337937), following the operator's research summary and request to explore statistical errors, machine learning and embeddings.

**Evidence boundary:** the [interim D–E report](https://github.com/mfittko/market-signals/issues/310#issuecomment-6046831326) reports no qualifying combination, no tree comparison because LightGBM was unavailable, and backwards empirical calibration on the XAU test. These are reported findings, not independently reproduced here. They justify a targeted audit and a different representation experiment; they do not prove a bug or establish that all intraday prediction is impossible. The earlier short-history experiments and the latest multi-year campaign are distinct studies.

**Preserve the original verdicts and locked campaign.** The work below is a proposed, separately registered follow-up with its own finite budget, not permission to keep reopening the same holdout or modifying the original experiment until it wins. No model proposed here has demonstrated a CFD trading edge.

### 1. Resolve the calibration/abstention question before searching for more models

Export the full chain on a fixed diagnostic sample: row and episode ID, side, feature vector, target label, raw score, positive-class mapping, calibrated probability, threshold inputs, and final decision. Check sorting and joins, dropped-row alignment, side signs, class order, feature order/scaling and the score representation passed to the calibrator.

Report raw ranking and calibration separately, by chronological window and side where sample support permits. Distinguish a reversed class/score implementation from outcome rates that happen to run backwards across score bins. Do not invert a model after inspecting the test unless a reproducible defect is established; otherwise that is a new selected hypothesis. Calibration is a separately fitted mapping, not proof of discrimination or economic value. [R1]

For E's **zero-entry result**, retain scores and rejection reasons for the whole candidate population. Report zero coverage and the resulting portfolio outcome, but mark R/trade and accepted-population calibration as undefined/no support, not successful calibration or 0R per trade. Identify whether abstention is caused by poor raw ranking, calibration, costs, insufficient evidence or the threshold policy. Do not lower the threshold simply to obtain trades.

### 2. Separate four possible bottlenecks

The audit and next benchmark should distinguish:

- **Measurement:** can #308 recover observable, planted relationships through the entire pipeline?
- **Candidate coverage:** does D exclude potentially useful market states before E ever sees them?
- **Representation/model:** do a few indicator values or an additive linear model discard useful sequence information?
- **Policy/economics:** is any forecast information lost through management rules or overwhelmed by executable costs?

A negative result for one combination does not isolate which bottleneck caused it. Diagnose first; do not change all four at once.

### 3. Register a small representation benchmark

Start on verified WTI data, with XAU as an explicitly scoped comparison. Keep targets, opportunity timestamps, costs, management and evaluation windows identical within each model comparison. Include the logistic baseline on each applicable engineered feature set so an improvement is not incorrectly attributed solely to the learner.

| Candidate | Proposed inputs and purpose |
| --- | --- |
| Existing logistic baseline | Reproduce the original result and its score/threshold behavior. |
| Logistic regression plus one histogram-gradient-boosted tree model | Compare both on the same compact lag/geometry/context features. `HistGradientBoostingClassifier` is a practical nonlinear comparator in the existing scikit-learn stack; lack of LightGBM need not leave this comparison unperformed. [R2] |
| MiniRocket features plus a small classifier | Test sequence shape using trailing normalized returns, with scale/spread/session context retained separately. MiniRocket provides a convolutional time-series transform used with a linear classifier. Start with a return-series baseline rather than silently assuming a particular multivariate implementation. [R3] |
| TS2Vec embedding plus a small supervised head | Test learned representations of trailing multivariate market windows. Compare engineered features alone, embedding alone, and their combination. TS2Vec is a self-supervised time-series representation method, not a financial probability model by itself. [R4] |

Proposed numeric inputs: normalized lagged returns, candle body/wick/range structure, volatility over several backward-looking scales, spread level/change, session-normalized tick activity, and as-of instrument/session context. Fix a small set of lookbacks before evaluation. Preserve scale context when normalizing; otherwise similar shapes at very different cost/volatility levels become indistinguishable.

Count feature sets, lookbacks, seeds, hyperparameters, thresholds and instruments in the budget. Pin versions, record failed/dependency-blocked candidates, and report compute and inference costs. Avoid a large Cartesian search.

For boosted-tree early stopping, use a chronological validation set supported by the pinned version, or disable internal early stopping and choose iteration counts in the permitted development procedure. The estimator's automatic validation split is not a substitute for temporal validation. [R2]

### 4. Test candidate coverage separately from model choice

After the like-for-like comparison, register a separate candidate-population ablation:

`existing D decision population` versus `a broader market-state sample at a fixed, declared cadence`.

The broader population need not originate from a Supertrend flip, volume impulse or volatility gate. Evaluate side-specific paths from those timestamps, with observable data/market-validity rules and explicit episode/position constraints. Retain both no-entry episodes and selected entry times.

This does not remove the operator's requirement for price confirmation: any proposed entry policy must still specify causal price confirmation before entry. It tests whether the current discovery rules are too restrictive, not whether an ML score can bypass confirmation.

Evaluate the **first eligible decision produced by the complete policy**, not a hindsight-selected best timestamp. Repeated windows from one move do not become independent observations. Counterfactual long/short labels do not imply simultaneously tradable positions.

### 5. Treat embeddings and retrieval as fitted components

Every learned scaler, feature transform, encoder, clustering model and calibrator must fit inside the permitted training period. At inference, the representation can use the full observed trailing window, but no later observations. Test this explicitly; an encoder applied to a complete historical sequence can expose future context.

Unsupervised fitting is not exempt from leakage controls: preprocessing fitted before splitting can bias model evaluation. [R5] Review augmentations for the market task; transformations that erase order or direction require explicit justification.

An optional interpretation experiment can retrieve similar **past** episodes in embedding space and summarize their subsequent outcomes under a fixed policy. Only neighbors whose outcomes had matured by the decision time are eligible. Exclude overlapping copies of the same episode and report support/dispersion. Similarity and distance-based abstention must earn their place in chronological evaluation; they are not automatic confidence estimates. An LLM must not cherry-pick appealing analogues.

### 6. Compare a fixed model with a frozen rolling-training procedure

Register two procedures: fit once and leave unchanged; versus refit/recalibrate on a predetermined schedule using only then-available observations and matured labels. Freeze lookback lengths, update cadence, hyperparameter selection, calibration and threshold rules before evaluation.

The procedure can be fixed while its fitted parameters change over time. Record each artifact's lineage and training cutoff. Do not retrain opportunistically after losses. This requires an explicit refinement of #307/#313's fixed-candidate contract before formal deployment evaluation; do not silently substitute rolling updates into the existing campaign.

The campaign-level holdout audit belongs to #308. Already-inspected 2023–2026 outcomes do not become untouched evidence through a new model name. Corrected runs, development replays and fresh prospective tests must remain distinguishable.

### 7. Keep target and exit experiments separate

Initially compare representations on the same targets. A later registered experiment may jointly report side-specific milestone-before-stop probability, runner outcome under the bound management policy, time-to-milestone and the net-R distribution. Entry-time estimates cannot use post-milestone information.

Keep market-path information, conversion by exits and net executable outcomes separate in diagnostics. #311 owns changed exit/protection policies; changing them can change labels and require recalibration. Longer horizons are separate hypotheses, with #314 owning multi-day costs and gaps. No improvement in raw AUC alone grants a lifecycle stage.

### 8. Optional follow-ups, not part of the first benchmark

A compact PatchTST model or one pretrained time-series challenger can follow only with a separate justified budget. PatchTST is a sequence-forecasting/representation architecture; its published benchmarks do not establish a trading edge. [R6] For pretrained candidates, document training-data provenance and possible evaluation overlap. Marginal forecast quantiles alone do not establish the joint path distribution needed for first-passage outcomes.

For text, sentence embeddings can support news deduplication, similarity and clustering. [R7] Proposed market-signals uses are event novelty, relevance and escalation context—not direction. News-feature modeling remains in the parked news workstream and uses actual available-at timestamps. The approximately 73k headlines in the operator summary are not necessarily 73k independent shocks, and the shorter news history cannot silently be backfilled into older price-only periods.

### Deliverable and gate

Publish one audit disposition plus a bounded benchmark report with raw predictive metrics, calibration, support, risk-versus-coverage, full sequential-policy net outcomes, cost sensitivity and paired dependence-aware comparisons. Preserve negative, skipped and inconclusive results. Require #308's positive-control evidence before interpreting another broad failure as absence of learnable information.

Logistic coefficient export is an implementation choice, not a scientific restriction. New model families remain research-only until an explicit #310/#312 artifact/runtime extension preserves full-pipeline parity and backend enforcement. Go remains the permission authority; a richer numerical scorer cannot override mandatory data, confirmation, economics or risk gates.

**Research sequence:** evaluator audit -> like-for-like nonlinear/sequence benchmark -> separately budgeted population or target ablation -> frozen full-policy replay -> prospective confirmation under #313. No deployment follows merely from proposing this campaign.

### Primary literature and implementation documentation

- [R1: scikit-learn probability calibration](https://scikit-learn.org/stable/modules/calibration.html).
- [R2: HistGradientBoostingClassifier, including validation and early-stopping behavior](https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.HistGradientBoostingClassifier.html).
- [R3: MiniRocket: A Very Fast (Almost) Deterministic Transform for Time Series Classification](https://arxiv.org/abs/2012.08791).
- [R4: TS2Vec: Towards Universal Representation of Time Series, including the authors' implementation link](https://arxiv.org/abs/2106.10466).
- [R5: Moscovich & Rosset, On the cross-validation bias due to unsupervised pre-processing](https://arxiv.org/abs/1901.08974).
- [R6: PatchTST: A Time Series is Worth 64 Words](https://arxiv.org/abs/2211.14730).
- [R7: Sentence-BERT: Sentence Embeddings using Siamese BERT-Networks](https://arxiv.org/abs/1908.10084).

**Grilling question:** After validating the evaluator, does a genuinely different representation add executable selection value over the same baseline—and can we tell whether any improvement comes from representation, candidate coverage, adaptation or changed trading rules?
