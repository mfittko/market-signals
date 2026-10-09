# Audit: Design clarification: state-based opportunity alerts and an EntryGuard, not more raw signal notifications

- Date: 2026-10-07T17:02:36Z (UTC)
- Source: https://github.com/mfittko/market-signals/issues/307#issuecomment-6042709055
- Posted by the operator on behalf of the external auditor.

## Follow-up

- The pre-audit ladder campaign tested A to C (https://github.com/mfittko/market-signals/issues/309#issuecomment-6046593404) and D to E (https://github.com/mfittko/market-signals/issues/310#issuecomment-6046831326). Its trial rows are the `ladder (pre-audit)` row of [trials-summary.csv](../registry/trials-summary.csv).
- [notrade12](../registry/campaigns/notrade12/) quantified the no-trade reasons. The spread rule (> 0.2 R) and the thin-hours rule pass. [filter316](../registry/campaigns/filter316/) found the live LLM filter no better than random thinning.
- Open: the EntryGuard and the notification policy in production (https://github.com/mfittko/market-signals/issues/312).

## Verbatim text

## Design clarification: state-based opportunity alerts and an EntryGuard, not more raw signal notifications

**Operator intent, clarified during this review (2026-10-07):** separate signal from noise; notify only when a statistically qualified setup passes deterministic gates. Supertrend flips and volume impulses are observations, not sufficient trade recommendations. Entry may become appropriate **between** these events. First provide an operator decision aid; later let an agent choose among permitted actions without overriding the same gates.

### 1. Separate an event, a setup, and an actionable entry

Proposed flow:

```text
Market observations, including flips and impulses
    -> continuously maintained, side-specific setup state
    -> statistical assessment of entering at the CURRENT price
    -> deterministic EntryGuard
    -> eligible-state transition notification
    -> operator now / constrained agent later
```

A flip can seed or update a setup. Subsequent candles can confirm it, improve its entry geometry, invalidate it, or make it too extended. We must not require another flip/impulse to reconsider entry. Also allow the scanner to discover an already-established setup after startup or without a recent event.

**Illustrative sequence, not a market recommendation:** 10:00 bullish flip, but spread/path risk fails: no actionable alert. 10:07 a pullback-resume condition satisfies the frozen policy and the statistical threshold: alert, despite no new flip. 10:12 price leaves the permitted entry window: expire eligibility; do not invite chasing.

Start with evaluation on every completed base candle using the existing scheduler. Event updates can trigger additional checks; finer intrabar decisions require appropriately timestamped data and their own replay validation. Higher polling frequency is not additional independent evidence. Persist state across restarts and use only higher-timeframe information actually available at that decision time.

### 2. A volatility gate cannot stand in for entry quality

Keep `P(big day/week)` as an **attention/monitoring feature**, not trade permission. A large range can include violent two-sided movement. Conversely, an orderly trend can be useful without qualifying as a statistically exceptional day. Test both a volatility gate and a path-quality filter independently, then in combination.

The entry question is side- and price-specific:

> From this executable entry, with this initial stop, holding horizon and management policy, is there evidence of sufficient favorable movement **before** adverse movement invalidates the trade, and sufficient remaining continuation after costs?

`P(big day)` and `P(successful entry now)` are different targets. Once the day's large-move threshold is already crossed, the first target can be resolved while the second remains uncertain. Neither a volatility percentile nor multiple correlated technical indicators should be presented as a probability of trade success.

**Proposed changes to the issue's current architecture:** do not merely add armed/fired as a third equally prominent alert alongside all existing flip/volume alerts. Do not replace the entire entry-facing widget with volatility alone. Show volatility context separately from long/short eligibility. “Exits carry the edge” should become a hypothesis tested on the full strategy, not an implementation premise.

### 3. Deterministic permission, statistically estimated outcomes

For a proposed side, entry range, stop and horizon, return:

| State | Meaning |
|---|---|
| `ELIGIBLE` | All mandatory gates pass under a qualified policy. Permission to consider entry, not certainty or an instruction to trade. |
| `WAIT` | A defined setup exists but confirmation or entry conditions are not satisfied. Include the condition and expiry. |
| `REJECTED` | A known policy condition fails. Return specific reason codes. |
| `UNAVAILABLE` | Required data, execution assumptions, model qualification or evidence support are missing/suspended. No new exposure. |

Rejecting a short does **not** recommend a long. Both may be ineligible. Before evidence qualification, show `experimental / insufficient evidence`, not a statistically approved green card.

The mandatory gates should cover data/venue validity, model/policy qualification, side/setup compatibility, cost-aware entry-path estimates, and risk limits. A favorable technical score cannot compensate for stale quotes or an unacceptable risk limit. Numeric models can estimate outcomes; frozen code determines permission. Identical recorded inputs and artifact versions must reproduce the decision.

Keep probability calibration separate from threshold selection: they are distinct statistical and decision problems. Scikit-learn documents both [calibration](https://scikit-learn.org/stable/modules/calibration.html) and [cost-sensitive threshold tuning](https://scikit-learn.org/stable/modules/classification_threshold.html). Its default stratified cross-validation is **not** the appropriate default for our chronological, overlapping trading observations.

### 4. Notification policy must enforce the distinction

Default actionable notifications should be emitted on a transition into `ELIGIBLE`, not for every raw event or every above-threshold poll. Raw flip/volume/armed events remain visible in a research/debug stream; any watch notifications should be separately opt-in and clearly non-actionable. Position-risk and operational-failure alerts must not be suppressed by the entry filter.

Use a persisted setup/episode ID, idempotent delivery, expiry, and explicit rearm rules. Evaluate hysteresis or confirmation dwell time to reduce threshold oscillation, but validate their delay cost. Hysteresis may retain a WATCH state; it must not preserve permission after a mandatory entry gate fails. Update or invalidate an existing opportunity rather than sending repeated buy/sell notices. No obligatory daily alert quota: zero eligible setups is a valid result.

Payload: instrument/venue, side, entry window, initial stop/risk, horizon, confirmation/invalidation conditions, data timestamp, expiry, reason codes, policy/model versions and a qualification-report reference. Only show outcome probabilities that have been evaluated for that target and selection policy.

### 5. Same boundary for the operator and eventual agent

Proposed contract: `assessEntry(snapshot, proposal, qualifiedPolicy) -> EntryAssessment`. The agent may investigate, wait, decline, or propose an eligible action; it cannot relax thresholds, reinterpret a failed gate, change the approved model or widen risk limits. Backend submission must revalidate price, expiry and portfolio risk; a cached green notification is not an execution capability.

Route all platform-managed manual/API/agent entry paths through that validator. Existing positions require independent deterministic management even when new exposure is blocked. For a manually operated external broker, the initial panel can warn and record overrides, but cannot physically prevent orders placed outside this platform.

**Important research implication:** a model trained only on flip/impulse timestamps is not automatically qualified for between-event entries. Record the full candidate timeline—including WAIT, rejected, expired and no-event opportunities—and replay the exact wait/enter policy. Keep repeated checks within one setup grouped rather than counting them as independent successes.

This is the immediate product milestone under #230: **a quiet, evidence-qualified entry guard**, with agent autonomy added behind it later. The existing issue's local research remains exploratory evidence; this comment does not assert that a profitable filter has already been demonstrated.
