# Audit: Grilling input: prospective evidence must qualify a frozen policy and remain revocable

- Date: 2026-10-07T17:34:13Z (UTC)
- Source: https://github.com/mfittko/market-signals/issues/313#issuecomment-6043303061
- Posted by the operator on behalf of the external auditor.

## Follow-up

- Open. This point concerns production or prospective work. No research campaign in the registry answers it. The registry treats prospective data as the only binding confirmation.

## Verbatim text

## Grilling input: prospective evidence must qualify a frozen policy and remain revocable

Issue-specific follow-up to the [epic reassessment](https://github.com/mfittko/market-signals/issues/307#issuecomment-6043133933). Forward evaluation and recorded approval before bot adoption are the right requirements. This issue needs a more explicit evidence, activation and suspension contract.

### 1. Capture early; define the formal shadow start separately

Start minimal append-only availability/candidate capture with #308. Formal qualification evaluation begins only after the complete candidate and protocol are frozen. Earlier development observations can help research but cannot retrospectively become untouched confirmation data.

Give each evaluation a candidate hash, protocol version, approved scope and start point. Freeze features/model, calibrator, threshold policy, cadence, entry and stop/horizon/management rules, execution assumptions and risk limits. Any material revision creates a new candidate and a declared evaluation decision, not an in-place improvement to the original test. Where a policy has deterministic rolling state, freeze the update rule and initial state rather than ambiguously requiring every derived value to remain constant.

#312 is required for testing the final Go runtime; it is not a reason to postpone preserving live inputs that will later be impossible to reconstruct.

### 2. Journal forecasts, failures and outcomes without inventing fills

Record the proposed side, executable-entry convention/range, stop, size/risk, horizon, policy identifiers, as-of inputs and availability timestamps, score/probability outputs and target, decision/reasons, expiry, candidate episode, and inference/data failures. Include all WAIT/rejected/unavailable/no-entry episodes and the frozen matched baseline, not just attractive alerts.

Make forecasts immutable and append separately versioned outcome events after maturity. A late correction must not overwrite the original information set. Distinguish:

- market-path labels;
- simulated counterfactual trade outcomes under the frozen execution policy;
- actual paper or later broker order/fill records, where available.

Shadow trades that were never submitted have no realized broker fill. Missing paths remain unknown/censored. An UNAVAILABLE assessment with no valid proposed entry or trustworthy data need not have a fabricated trade outcome. Repeated checks of one setup are not independent trials.

### 3. Predeclare an economic decision, not only risk and coverage targets

Before the shadow period, specify the primary economic objective, minimum useful effect, risk/loss-tail bounds, calibration tolerance where probabilities are used, relevant coverage/runner-retention constraints, and required effective episode support. Include the common-risk/capital baseline, no-trade reference and applicable matched null from the earlier research contract.

Compare paired calendar-period results and model/selected-population behavior under the same execution assumptions. Check concentration and adverse cost/latency sensitivity. Merely resembling a historical interval, reducing alert count, or reducing losses by blocking nearly everything is insufficient qualification.

Separate **pass, fail and inconclusive**. Insufficient independent opportunities should not force approval or an assertion that no edge exists. Zero eligible setups is valid operational behavior; it may also mean the evaluation has not acquired enough information to decide. Do not force additional alerts to meet a sample quota.

### 4. Prevent promotion by repeated peeking or selective reporting

Predeclare evaluation checkpoints and the information requirement. Do not inspect ordinary confidence intervals every day and promote at the first favorable crossing. The simplest starting point is a frozen endpoint or properly planned checkpoints, with early risk-based suspension allowed. Report all candidates considered and account for selection across candidates/instruments in the evaluation protocol.

Safety monitoring can operate continuously without turning every check into a new opportunity to declare statistical success. Extending or redesigning a test after seeing results must be recorded with the consequences for its evidence status; it is not a way to preserve an untouched-test label.

### 5. Scope approval and enforce it independently

Specify separate lifecycle/use permissions for research preview, actionable operator alerts and paper-agent operation. A research `would_be_eligible` result is not execution permission. #312 should resolve server-side approved scope and reject absent, mismatched, expired or suspended qualification.

Approval binds instrument/feed, side/setup family, permitted stop/horizon/management rules, model/calibrator/threshold versions, execution assumptions and risk limits. A supported WTI-only candidate may qualify for that scope; it does not automatically authorize the other instruments. Conversely, lack of cross-instrument generalization should not prevent an honestly scoped evaluation.

The agent may decline an allowed trade but must not choose a different unqualified proposal or redefine the thresholds. If discretionary selection or management by an agent materially changes the evaluated policy, evaluate that full agent-plus-guard behavior as an additional paper candidate; passing the guard alone does not establish the agent's economic performance. Live execution remains separately authorized and out of scope here.

### 6. Define suspension, rollback and requalification

Add ongoing input-quality, artifact/scope and performance monitoring with predeclared suspension rules. Define what happens after missing data, feed/schema changes, broken parity, unacceptable calibration/performance deterioration, or exceeded risk limits. Suspension blocks new exposure while independent position management continues.

Manual initial approval is not permanent permission. Rollback may select only an appropriate already-approved artifact or disable new entries; it must not automatically promote an unqualified replacement. Record investigations and requalification decisions. Give #306's old live-prediction outcome tracking an explicit migration/retirement owner with #312 so it does not disappear between scopes.

**Suggested acceptance additions:** immutable forecast/outcome lineage; baseline and unknown-outcome handling; a complete preregistered pass/fail/inconclusive protocol; scope-bound server-side activation; and tested suspension/rollback behavior.

**Grilling question:** Could we obtain approval merely by waiting for a favorable report, dropping inconvenient assessments, changing the candidate mid-test, or applying evidence beyond its approved scope? If not, can the system still suspend that approval safely when conditions change?
