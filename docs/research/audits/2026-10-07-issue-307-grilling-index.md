# Audit: Grilling index: issue-specific feedback and decisions to settle at epic level

- Date: 2026-10-07T17:34:49Z (UTC)
- Source: https://github.com/mfittko/market-signals/issues/307#issuecomment-6043313447
- Posted by the operator on behalf of the external auditor.

## Follow-up

- The shared decisions were settled in the grill results: https://github.com/mfittko/market-signals/issues/307#issuecomment-6043680106.
- The per-issue reviews are filed separately in this folder.

## Verbatim text

## Grilling index: issue-specific feedback and decisions to settle at epic level

At the operator's request, the [reassessment](https://github.com/mfittko/market-signals/issues/307#issuecomment-6043133933) is now expanded into focused comments on every child. These are proposed amendments for the grilling process; issue bodies, dependencies and states have not been changed.

| Issue | Review comment | Main challenge |
|---|---|---|
| #308 | [Foundation review](https://github.com/mfittko/market-signals/issues/308#issuecomment-6043257973) | Prove as-of timing, executable round trips, label meaning, ambiguity handling and reproducibility. |
| #309 | [Baseline/filter review](https://github.com/mfittko/market-signals/issues/309#issuecomment-6043269653) | Separate relative selection improvement from economic qualification; do not win merely by trading less. |
| #310 | [Sequential-entry/model review](https://github.com/mfittko/market-signals/issues/310#issuecomment-6043278331) | Test actual between-event decisions without requiring successful event-time filtering; qualify the exact population and policy. |
| #311 | [Protection/exit review](https://github.com/mfittko/market-signals/issues/311#issuecomment-6043285160) | Model effective stop changes, preserve runners, and revalidate forecasts when management changes their target. |
| #312 | [Runtime/enforcement review](https://github.com/mfittko/market-signals/issues/312#issuecomment-6043294771) | Discover setups continuously, reproduce full-pipeline decisions, and reject bypasses, stale proposals and concurrent over-allocation. |
| #313 | [Shadow/promotion review](https://github.com/mfittko/market-signals/issues/313#issuecomment-6043303061) | Capture early, evaluate a frozen candidate without selective peeking, scope approval and retain suspension/rollback. |

### Shared decisions that belong here, not six inconsistent local interpretations

**One authoritative specification.** Move the retained old “Agreed architecture”, “Step 5” and “Next” instructions into an explicitly superseded, non-normative research-history appendix. Preserve findings, but remove competing active instructions about raw notifications, the volatility-only widget, clean holdouts and assumed exit edge. Describe data availability through verified manifests rather than treating a running backfill as completed coverage.

**One qualification contract.** Define research progress, historical support, formal shadow evaluation, operator-alert activation and paper-agent approval separately. A per-entry ELIGIBLE state is not a policy lifecycle state. Approval must bind the complete instrument/feed/entry/stop/horizon/management/model/calibrator/threshold/execution combination, with suspension and retirement. Each child should reference the same contract and report supported/rejected/inconclusive against predeclared economic and risk criteria.

**Dependencies should track evidence readiness, not require every previous hypothesis to succeed.** #310 needs valid data and a completed baseline comparison; a bounded preregistered between-event-entry hypothesis can still run after negative event-time filters. A supported simpler policy can bypass unhelpful complexity. Replication across instruments is needed for a generalization claim, not as a blanket prerequisite for a WTI-only shadow candidate. These distinctions preserve a finite research budget without prematurely falsifying different hypotheses.

**Keep the immediate product requirement visible.** Minimum declared evaluation cadence continues without fresh flips/impulses; raw observations remain non-actionable; notifications reflect newly qualified current-price opportunities. A volatility feature cannot suppress a policy explicitly qualified without that gate. Human and agent proposals pass the same enforced backend boundary, with independently managed existing positions.

**Scope the first delivery honestly.** The current children primarily establish an intraday guard. Explicitly defer the original multi-week layer unless financing, overnight gaps, longer horizons and suitable evidence are added. The parked news layer can remain deferred, but capture as-of/event metadata early. Failure of a price-only experiment does not logically reject a separately budgeted additional-information hypothesis. Avoid coupling all 18 backfills or every exit variant to the first verified WTI research/shadow result.

**Resolve ownership and compatibility.** #308/#313 share early capture versus formal evaluation; #310/#311 share policy-dependent labels and calibration; #310/#312 share the supported artifact format; #312/#313 share activation and suspension. Explicitly migrate or retire #303/#306's legacy prediction surface and outcome tracking rather than assuming the offline foundation replaced them.

**Review position remains:** retain the six issues and the Python/Go split, start the foundation work, and tighten these contracts before any research improvement becomes actionable permission. No new platform rewrite or additional large epic is needed.
