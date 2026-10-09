# Audit: Grilling input: protection must preserve economic value, not just produce reassuring stops

- Date: 2026-10-07T17:33:14Z (UTC)
- Source: https://github.com/mfittko/market-signals/issues/311#issuecomment-6043285160
- Posted by the operator on behalf of the external auditor.

## Follow-up

- [risk8](../registry/campaigns/risk8/) tested T2-conditioned stop width and sizing on fixed entries: negative for product use (https://github.com/mfittko/market-signals/issues/311#issuecomment-6051369045).

## Verbatim text

## Grilling input: protection must preserve economic value, not just produce reassuring stops

Issue-specific follow-up to the [epic reassessment](https://github.com/mfittko/market-signals/issues/307#issuecomment-6043133933). Testing a few exits on matched entries is the right design. Keep this optional: retaining the baseline exit is a valid outcome.

### 1. Freeze the complete exit experiment

Register the baseline exit, milestone definition, permitted modifications, update cadence, initial cash-risk denominator, maximum horizon and the small candidate set before selection. Keep R fixed at the original planned risk throughout the trade. Specify whether breakeven means the entry price or an estimated **net-of-cost** outcome; do not equate the two.

A change to the exit policy can change the entry model's target. #308's runner labels already depend on a managed stop, and #310 may predict those labels. For a selected new management policy, regenerate affected labels and refit/recalibrate the approved model family as needed, then freeze the complete combination for later evaluation. This is a required dependency, not permission to reopen unrestricted entry-model search.

An alternative is to retain the baseline policy and its existing qualification. In either case, bind the evidence to the exact entry/stop/horizon/management/model/threshold combination.

### 2. Test protection as an event sequence

Distinguish:

`milestone observed -> modification requested -> modification effective or rejected -> later exit and net outcome`

Add fixtures for a reversal before the modification takes effect, rejection, duplicate/retried requests, and a gap through the active stop. Specify which old stop remains active while an update is pending; do not assume an unacknowledged replacement already protects the trade. A same-bar milestone and reversal must not get favorable ordering merely because that produces a successful protection label.

Use #308's executable bid/ask and ambiguous-path handling. Stop placement is a control instruction under the fill model, not a guaranteed net payoff. Report separately the milestone-reach rate, effective-modification rate, and eventual profitable-exit rate, with explicit denominators and unknown/censored outcomes.

### 3. Tighten the objective beyond “net R or drawdown improves”

Choose the objective before seeing results. A reasonable contract is either improved net outcome subject to risk/runner-retention constraints, or reduced risk subject to a predeclared return-noninferiority constraint. Do not choose whichever metric looks better after the test.

Report net return, drawdown and tail losses, runner capture, winner truncation, trading costs, time in exposure, and dependence-aware paired differences. A lower drawdown achieved by closing every trade immediately does not establish a useful big-move strategy. Conditional protection success among trades that reached the milestone must not replace the all-entry economic result.

Include adverse modification latency, rejection and fill assumptions. When results are sensitive to unknown intrabar ordering, the qualification decision must reflect that uncertainty rather than selecting an optimistic path.

### 4. Separate matched-entry attribution from the actual full loop

Identical-entry comparisons isolate the exit effect, which is useful. But earlier exits can change later capacity, reentry and available capital. The later full-loop validation must replay those consequences under the actual position/risk rules, not assume that the diagnostic list of matched entries remains executable for every exit policy.

Reserve later data for the frozen selected combination; count exit-policy variants in the campaign's total selection budget. Return supported/rejected/inconclusive and keep the baseline when no justified improvement is established. A risk-reduction overlay cannot confer economic qualification on an otherwise unqualified strategy simply because its drawdown is lower.

**Suggested acceptance additions:** explicit protection event-order fixtures; a net-of-cost protection definition; policy-bound label/calibration handling with #310; a predeclared economic/risk trade-off; and full-loop replay after matched-entry attribution.

**Grilling question:** Did this policy genuinely improve the complete strategy, or did it merely make the stop look safer while removing the few large winners that justified taking risk?
