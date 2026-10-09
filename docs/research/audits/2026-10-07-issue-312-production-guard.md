# Audit: Grilling input: the production guard must discover, reproduce and enforce eligibility

- Date: 2026-10-07T17:33:45Z (UTC)
- Source: https://github.com/mfittko/market-signals/issues/312#issuecomment-6043294771
- Posted by the operator on behalf of the external auditor.

## Follow-up

- Open. This point concerns production or prospective work. No research campaign in the registry answers it.

## Verbatim text

## Grilling input: the production guard must discover, reproduce and enforce eligibility

Issue-specific follow-up to the [epic reassessment](https://github.com/mfittko/market-signals/issues/307#issuecomment-6043133933). Keep the Go implementation and shared assessment boundary. The missing acceptance details are primarily about matching the evaluated policy and making its permission boundary unavoidable.

### 1. Explicitly require evaluation between raw events

The central operator requirement must be an acceptance criterion here, not only an offline experiment in #310: **evaluate at every declared base-candle decision time without requiring a new Supertrend flip or volume impulse**. Persist the candidate state and warm-up requirements. A policy evaluated without the volatility gate must not silently lose evaluation opportunities when that gate is off.

Required scenarios:

- A flip fails entry checks; later no-event candles produce a qualified entry; another candle invalidates it. Emit one opportunity notification for the eligibility episode.
- An established setup is discovered after startup with valid warm-up data and no recent flip.
- Both directions are ineligible; rejecting one side does not promote the other.
- Missing/stale input or policy suspension blocks new exposure while existing positions continue receiving deterministic management.

Cadence, confirmation, expiry, rearm and opportunity grouping are part of the evaluated policy. Changing them in production changes the strategy being evaluated. Permit the simpler rule-based qualified result too; it need not manufacture probabilities or require an ML scorer.

### 2. Export and test the whole decision pipeline

The production artifact should include feature order/definitions, preprocessing and rolling-state rules, missing-data behavior, model parameters if present, calibrator, thresholds, allowed instrument/side/setup/stop/horizon/management scope, policy/label versions and qualification reference. Validate its integrity and resolve it from the server's approved registry.

#310 allows a tree challenger whereas this issue assumes coefficients. Either keep the tree research-only for v1 or define and test its supported representation. Do not silently approximate the winner with a different model and inherit the original qualification.

Use two parity layers:

1. Recorded timestamped inputs -> feature/snapshot state, including availability and higher-timeframe aggregation.
2. Snapshot + approved artifacts -> scores, reasons and final eligibility decision.

Use justified numerical tolerances for scores, but require identical decision outcomes on the parity suite. Include scores at/near thresholds, ties, missing/NaN values, changed units/order, insufficient warm-up, session boundaries, restarts and invalid artifacts. A close dot product can still produce opposite decisions around a threshold.

### 3. Enforce the result, not merely call the function

Replace “all paths call assessEntry” with **all platform-managed new-exposure paths enforce an approved assessment and current risk validation**. The client or agent must not choose an arbitrary model or claim that a policy is qualified.

Bind the assessment to the proposed instrument, side, entry bounds, stop, size/risk, horizon, management policy, snapshot/version and expiry. Reassess or reject when those inputs change. Immediately before new exposure, recheck current market/portfolio constraints; an earlier green card is not an execution authorization.

Add negative tests for stale/expired assessments, changed proposal fields, unsupported configurations, failed mandatory gates, tampered policy identifiers and direct API/agent/manual bypass attempts. Include concurrent submissions that each fit individually but would exceed combined limits; risk reservation/checking must not allow both through a race. Retry the same proposal idempotently rather than opening duplicate exposure.

LLMs can explain, investigate or decline eligible actions; they cannot convert a failed gate into permission, widen risk limits or invent supporting probabilities. Risk-reducing/position-management actions need their own safe path and must not be blocked simply because entry qualification is unavailable. This remains paper/platform enforcement, not new live-broker integration.

### 4. Distinguish lifecycle, per-entry state and display mode

A policy's research/shadow/approved/suspended lifecycle is separate from ELIGIBLE/WAIT/REJECTED/UNAVAILABLE for one proposal. Specify when operator-actionable alerts become enabled versus experimental previews and paper-agent permission. A research screen may show `would_be_eligible`, but an “experimental” badge must not be used to smuggle unqualified results into the actionable channel.

Include approved scope, probability target where supported, entry/risk bounds, confirmation/invalidation conditions, freshness/expiry, reason codes and evidence reference in the panel and payload. Do not present an old qualification as covering a changed stop or horizon. External manual broker orders are outside platform enforcement.

### 5. Test notification delivery and invalidation across failures

Persist a stable opportunity/episode ID and eligibility-transition event key. Test crashes before/after persistence and delivery, retries, delayed/out-of-order market updates, restarts with stale snapshots, expiry and rearm. A durable delivery/outbox design can prevent duplicate creation; do not claim end-to-end exactly-once delivery when an external destination cannot provide the required idempotency/acknowledgment semantics. Record ambiguous delivery outcomes.

Above-threshold polls must not repeatedly send new entry alerts. Mandatory gate failure immediately removes permission even when hysteresis/cooldown retains an internal watch state. Any invalidation update should be distinguishable from a new entry invitation. Keep position-risk and operational-failure notifications independent from entry filtering.

### 6. Clarify handoffs

This issue can produce a **frozen shadow-capable runtime**; activation for each use remains governed by #313 and the shared qualification contract. Integrate with the early journal from #308/#313 rather than waiting until deployment to decide what must be logged.

Explicitly migrate or retire the existing #303 prediction card/tools and #306's live-outcome tracking responsibility. Old advisory endpoints must not become an alternate way to create unguarded platform exposure. Preserve historical records and label their target/version rather than relabeling old forecasts as EntryGuard evidence.

**Grilling question:** Can a stale UI, changed proposal, direct API call, concurrent request, restart or agent reinterpretation produce new exposure that the frozen policy would have rejected—and can every permitted action be reconstructed from the recorded inputs and approved artifacts?
