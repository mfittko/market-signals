# Audit: Reassessment of the restructured epic: keep the structure, tighten the qualification contract

- Date: 2026-10-07T17:24:28Z (UTC)
- Source: https://github.com/mfittko/market-signals/issues/307#issuecomment-6043133933
- Posted by the operator on behalf of the external auditor.

## Follow-up

- The operator adopted the epic-level proposals in the grill results: https://github.com/mfittko/market-signals/issues/307#issuecomment-6043680106.
- Data and execution contract (point 4): evaluator audit [v1](../registry/campaigns/v1/) and corrections [v2](../registry/campaigns/v2/).
- Between-event population (point 2) and target binding (point 5): [ablate4](../registry/campaigns/ablate4/). Protection for https://github.com/mfittko/market-signals/issues/311: [risk8](../registry/campaigns/risk8/).
- Points 6 to 8 (https://github.com/mfittko/market-signals/issues/312, https://github.com/mfittko/market-signals/issues/313): Open. This point concerns production or prospective work. No research campaign in the registry answers it.

## Verbatim text

## Reassessment of the restructured epic: keep the structure, tighten the qualification contract

Reviewed #307, all six children (#308-#313), the adopted-plan and parked-news comments, and the closure of #306. This is a specification/dependency review, not a rerun of the local research or verification of the backfilled database.

**Verdict: the restructuring is a substantial improvement. Keep these six issues and the Python-research / Go-production split. Start the foundation work. Before the ladder results can qualify anything for use, fix the distinctions between research progress, evidence of selection value, and permission to enter.** There is no need for another platform rewrite or another large issue tree.

What is now right: volatility is attention rather than permission; C tests geometry without the volatility gate; D evaluates between-event decisions; E separates calibration and threshold selection; F evaluates exits on matched entries; historical crises are stress suites, not untouched holdouts; notifications follow eligibility transitions; prospective qualification precedes bot use. These are substantive changes, not just issue organization.

### 1. #307: make the current specification unambiguous

The new outcome conflicts with retained sections still headed **Agreed architecture**, **Step 5 plan**, and **Next**. Those still say that exits carry the edge, armed/fired become a third alert type, the widget drops long/short, and five instruments are clean holdouts. The newer children correctly supersede these ideas, but an implementation agent can still follow the old instructions.

Move the old plan into an explicitly **superseded, non-normative research-history appendix**, with the current outcome and children as the sole implementation authority. Retain the evidence and failed experiments; do not retain competing active instructions. Also distinguish backfill *running* from coverage actually verified in manifests.

Define one shared qualification contract referenced by every child. A useful separation is `RESEARCH_CANDIDATE -> HISTORICALLY_SUPPORTED -> SHADOW -> PAPER_APPROVED`, with suspension/retirement and separately scoped future live authorization. These lifecycle states are separate from the per-entry ELIGIBLE/WAIT/REJECTED/UNAVAILABLE states.

### 2. #309/#310: do not make successful event-time filtering a prerequisite for testing between-event entries

#310 currently requires a **go** from #309. But #309 evaluates entries at the original event timestamps, while D asks whether waiting and entering later improves them. Failure of B/C at a flip is not evidence that a later pullback/confirmation entry is worthless.

Change the dependency to: **foundation validated and #309 completed; one bounded, preregistered D/E campaign may run even if B/C fail.** Retaining a component, extending the research budget, and deploying a strategy are different decisions. Failed components need not be carried into D. The same principle applies to the parked news hypothesis: price-only failure does not logically falsify an independently budgeted hypothesis using additional information.

Keep a finite campaign budget and a stop/rethink decision; this is not permission for endless parameter search. Return **supported, rejected, or inconclusive**. An interval spanning zero means insufficient evidence, not proof of no effect.

Also scope promotion by instrument and policy. Requiring improvement on more than one instrument is useful for a *cross-instrument generalization claim*, but should not block shadow testing of a genuinely supported WTI-only policy. Record the instrument selection as part of the trial history rather than choosing the winner after inspecting everything.

### 3. #309-#313: strengthen the economic go/no-go criteria

#309 allows advancement for improved R/trade **or fewer losing trades**; #310 says improved accepted population; #313 names risk and coverage criteria. These are useful measurements, but are not yet a common qualification rule. #309 does include no-trade as a reference, which is good; its go/no-go text should explicitly use the relevant economic hurdle.

Illustration only: improving from -0.12R/trade to -0.03R/trade is a meaningful research result but still does not justify actionable entry permission. Rejecting most opportunities can trivially reduce the number of losers. Tightening every exit can reduce drawdown while removing the runners the operator actually wants.

Before evaluation, specify a primary economic objective, a minimum useful improvement, and risk/coverage/runner-retention constraints. Evaluate the selected full policy's net outcome against no-trade and compare its incremental value with the baseline and appropriate matched null. For a risk-reduction overlay on an independently qualified strategy, a predeclared return-noninferiority/risk-improvement objective is also reasonable; do not switch objectives after seeing the result.

Use paired calendar-block outcomes under common risk/capital assumptions, alongside R/trade. Include effective episode support, adverse execution assumptions, net return, loss tails, retained winners and exposure. Cross-instrument results need calendar-aligned treatment of shared shocks. Coverage is a research guard against winning by blocking everything, **not an operational alert quota**.

A trial register and block bootstrap do not by themselves correct selection over many models, thresholds, exits and instruments. Specify the multiple-comparison procedure and reserve genuinely uninspected evaluation data, or explicitly treat the ladder windows as development and rely on frozen prospective confirmation. `arch` already provides relevant multiple-comparison procedures [R3].

### 4. #308: tighten the data and execution contract before trusting labels

The move to bid/ask history is useful, but `price=BA` is not tick-level execution history. Add explicit fixtures for both sides of the round trip: **long entry ask / exit bid; short entry bid / exit ask**, with the declared stop trigger convention. OANDA documents that trigger and fill components are distinct concepts [R2].

Require an explicit event clock: source candle start/end, availability/receipt or historical availability assumption, decision time, and earliest permissible fill after decision/processing latency. Completed higher-timeframe bars must become visible only when actually available. Add leakage tests for resampling, rolling features, cross-asset as-of joins, and decisions near session boundaries. No decision using a candle's final range may fill retroactively inside that same range.

Separately aggregated bid and ask highs/lows need not occur together; subtracting them does not reconstruct a historical spread path. OANDA's candle `volume` is a count of prices, not exchange-traded volume [R1]. Name that semantic explicitly when testing the existing volume impulses. Record the FXEmpire proxy path, missing-data handling, session/alignment/smoothing settings, price/product identity, relevant costs, and verified coverage. A checksummed manifest also needs a retrievable immutable dataset location or equivalent documented restoration procedure; a checksum alone cannot reproduce an inaccessible local snapshot.

For ambiguous bars, report admissible-path scenario bounds under declared fill assumptions, not just an ambiguity percentage. **Require finer data when ambiguity can change the qualification conclusion.** This is more useful than either assuming a favorable intrabar ordering or stopping all exploratory research merely because some M1 bars are ambiguous. Do not silently discard the ambiguous observations. Passing existing fixtures establishes compatibility, not complete execution realism.

WTI foundation work need not wait for every other instrument's backfill. Gate each experiment on its own verified data coverage.

### 5. #308/#310/#311: bind the prediction target to the complete policy

Distinguish realized labels (`y_arm`, `y_runner`, explicit censored/unknown states) from predicted probabilities (`p_arm`, `p_runner`). State whether runner probability is conditional on reaching the milestone and whether it is estimated **at entry** or updated using information observed later. A post-milestone assessment must not appear as an entry-time prediction.

Freeze a baseline management policy in #308, because the runner label already depends on a managed stop. A milestone touch and an acknowledged/effective stop modification should be separate outcomes. #311 correctly introduces modification latency, but the earlier label contract must not imply that a touch alone made the trade protected.

**Changing the exit policy in F can change the labels and invalidate E's calibration.** For a selected new exit, regenerate policy-dependent labels and refit/recalibrate the same approved model family as needed; freeze and evaluate that full combination on later data. Alternatively retain the old exit and its qualification. Do not attach an old probability estimate to a new trailing policy merely because the entry code is unchanged.

Qualification should bind instrument/feed, side/setup family, feature and label versions, entry policy, stop/horizon/management policy, model, calibrator, thresholds and execution assumptions. Unsupported arbitrary operator/agent stops or horizons should return UNAVAILABLE unless the model and evaluation explicitly cover those parameters.

### 6. #312: explicitly test continuous discovery and backend enforcement

The state machine is well described, but the production scope does not explicitly require the behavior that motivated D: **reassess at every declared base-candle decision time without requiring a fresh flip or impulse**. Add acceptance fixtures for:

- A flip occurs and fails; subsequent no-event candles produce a qualifying entry; a later candle invalidates it. Exactly one entry notification is emitted for that opportunity.
- An already-established setup is discovered after startup, without a recent flip, using valid warm-up data.
- A volatility-off state does not suppress the minimum evaluation cadence of a policy that was qualified without that gate.

Cadence/waiting/deduplication/rearm are part of the evaluated policy, not notification-only plumbing.

“All entry paths call assessEntry” is weaker than “all entry paths enforce its result.” Add server-side rejection tests for failed gates, stale snapshots, expired assessments, changed price/stop/side/size, unsupported configurations and tampered policy identifiers. The server resolves approved artifacts; callers cannot supply arbitrary qualification. Recheck current market and portfolio risk immediately before creating platform-managed exposure. Existing positions retain independent management while new exposure is blocked.

Research cards can show `would_be_eligible`, but an unqualified/experimental policy must not gain actionable permission simply through a green UI state. Define precisely when operator-actionable notifications become available versus research previews and paper-agent permissions. External manually placed broker orders remain outside this enforcement boundary.

### 7. #310/#312: export and test the whole pipeline, not just coefficients

Coefficient artifacts fit the logistic baseline, but #310 also permits a tree challenger. Either make that challenger research-only for v1 or specify an explicit supported artifact/runtime before promoting it. A tree does not become a logistic coefficient vector.

Export feature order/definitions, transforms and rolling-state rules, missing-data behavior, model parameters, calibrator, threshold policy, allowed scope, evidence reference and artifact integrity/version information. Calibration is a fitted mapping separate from the underlying predictor [R4].

Use two parity layers: raw timestamped replay -> identical feature/snapshot state, and snapshot -> scores plus **identical final eligibility decisions**. Numerically close scores can fall on opposite sides of a hard threshold. Include boundary/tie cases, NaNs/missing fields, session changes, insufficient warm-up, restarts and rejected artifacts. A tolerance-only dot-product test is not enough for a deterministic permission boundary.

### 8. #313: capture early, promote late, and retain the ability to suspend

Starting the formal frozen shadow evaluation after #312 is reasonable. Waiting until then to start collecting live availability, candidate and outcome evidence is not necessary. Add minimal append-only capture alongside #308; once a candidate is frozen, start its separately identified prospective evaluation. Earlier development-era observations do not become untouched evidence retrospectively.

Record proposed side/entry/stop/horizon, probability/score outputs, state/reasons, data availability, failures, policy hashes and counterfactual outcomes, including the matched baseline. Non-executed shadow paths are **simulated counterfactual outcomes**, not realized broker fills. Missing data should remain censored/unknown rather than inventing results for every UNAVAILABLE assessment.

Predeclare the information/sample requirement in independent episodes, evaluation schedule, minimum useful economic effect, risk limits, calibration tolerance and success/failure/inconclusive decisions. Do not inspect ordinary intervals every day and promote on the first favorable one. Fixed evaluation checkpoints are the simple starting point; time-uniform methods exist but require suitable assumptions for this dependent data [R5].

Add ongoing data-quality and performance monitoring, suspension criteria, rollback and requalification. Manual initial approval is not permanent permission after a feed change or material deterioration. Automatic suspension can fail closed for new exposure without automatically promoting a replacement model.

### Scope and sequencing recommendation

Keep the six issues, but use this execution order:

`#308 WTI foundation + early capture -> #309 baseline/ablations -> bounded #310 sequential/selection campaign -> optional #311 exit comparison -> #312 frozen shadow-capable runtime -> #313 scoped approval`

The structural dependency is validated inputs and an executable baseline, not a requirement that every prior hypothesis show alpha. A supported simpler policy may bypass later complexity. Broader instrument replication can proceed after the first supported WTI candidate enters shadow; do not make all five instruments or all exit variants prerequisites for collecting forward evidence.

The current children primarily deliver an intraday entry guard. Explicitly defer the original 5/20-day and multi-week layer unless its horizons, financing, overnight gaps and validation are added. The parked news layer can remain optional. Capture available-at timestamps and scheduled-event metadata early, even while news-based feature modeling stays deferred; a predeclared release-risk veto is a safety-policy candidate, not a claim of predictive alpha.

Closing #306 as superseded is sensible, but give its existing live-prediction outcome-tracking responsibility an explicit new owner (#312 migration / #313 journal), or explicitly retire that old surface. #308 alone only owns the offline foundation.

**Bottom line:** approve the direction and foundation work. Tighten the shared qualification and execution contracts before promotion. The main remaining risk is not a missing indicator; it is accidentally promoting an improvement in a research metric into entry permission for a different policy, population or execution path.

### Primary references checked for this reassessment

- [R1: OANDA candle schema, timestamps, bid/ask OHLC and volume semantics](https://developer.oanda.com/rest-live-v20/instrument-df/)
- [R2: OANDA order trigger and fill conventions](https://developer.oanda.com/rest-live-v20/order-df/)
- [R3: arch multiple-comparison procedures](https://arch.readthedocs.io/en/stable/multiple-comparison/multiple-comparisons.html)
- [R4: scikit-learn probability calibration](https://scikit-learn.org/stable/modules/calibration.html) and [decision-threshold tuning](https://scikit-learn.org/stable/modules/classification_threshold.html)
- [R5: Howard et al., Time-uniform, nonparametric, nonasymptotic confidence sequences](https://arxiv.org/abs/1810.08240)
