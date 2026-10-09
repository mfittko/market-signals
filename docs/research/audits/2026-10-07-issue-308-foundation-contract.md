# Audit: Grilling input: make the research foundation an executable contract

- Date: 2026-10-07T17:31:44Z (UTC)
- Source: https://github.com/mfittko/market-signals/issues/308#issuecomment-6043257973
- Posted by the operator on behalf of the external auditor.

## Follow-up

- The bid/ask M1 history (`history.db`, see the [registry manifest](../registry/README.md#reproduce)) gives both sides of the round trip.
- Labels, nulls, uncertainty and reproducibility: evaluator audit [v1](../registry/campaigns/v1/) and evaluator v2 [v2](../registry/campaigns/v2/).

## Verbatim text

## Grilling input: make the research foundation an executable contract

Issue-specific follow-up to the [epic reassessment](https://github.com/mfittko/market-signals/issues/307#issuecomment-6043133933). These are proposed specification amendments, not findings from rerunning the local database or experiments. The foundation is the right first step; the points below should be settled before its outputs count as qualification evidence.

### 1. Specify availability and execution time, not just candle timestamps

Define the complete clock: source candle start/end, completion, historical availability assumption or actual receipt/availability time, feature computation, decision, and earliest permitted fill after processing/execution latency. Add tests proving that completed higher-timeframe bars and cross-instrument features cannot enter an earlier decision.

A decision using a candle's final range must not fill retrospectively within that range. An order already active before the candle is a different case and needs explicit event ordering. Include resampling, missing bars, stale inputs, warm-up, session changes and daylight-saving boundaries in fixtures.

OANDA documents its candle timestamp as the **start** time and its candle volume as the number of prices created, not traded contract volume. Preserve those meanings when normalizing data and testing volume impulses. See the [official candle schema](https://developer.oanda.com/rest-live-v20/instrument-df/). Verify that the FXEmpire proxy actually preserves the claimed fields and semantics; upstream documentation is not proof of proxy behavior.

### 2. Test both sides of the round trip and the limits of M1 data

Expand “longs at ask, shorts at bid” into:

| Action | Executable price component under the declared model |
|---|---|
| Open long | Ask |
| Close long | Bid |
| Open short | Bid |
| Close short | Ask |

Declare stop-trigger conventions separately from fill conventions; OANDA treats those as distinct concepts in its [order definitions](https://developer.oanda.com/rest-live-v20/order-df/). Include gaps, costs without double-counting spread, unavailable/nontradable periods, and execution latency. Keep original planned cash risk as the R denominator and report losses exceeding 1R where adverse fills produce them.

Bid/ask OHLC is better than bid-only history but does not recover an intrabar quote path. Bid and ask extrema need not occur together, so subtracting their highs/lows is not an observed spread time series. Do not silently invent synchronization or favorable barrier order.

Report the ambiguity rate **and sensitivity of the qualification conclusion to admissible intrabar scenarios under declared fill assumptions**. Require finer data when ambiguity can change the decision. Keep ambiguous observations visible; dropping difficult paths can change the evaluated population. Some ambiguity need not stop all exploratory work, but a favorable result dependent on unknown ordering cannot qualify the policy. Passing legacy fixtures is a starting compatibility check, not proof of execution realism.

### 3. Separate labels, forecasts and protection state

Use realized labels such as `y_arm` and `y_runner`; reserve `p_arm` and `p_runner` for predicted probabilities. Define exact barrier values, horizon origin and end, timeout behavior, and censored/unknown outcomes.

State whether runner probability is conditional on reaching the milestone and whether it is predicted at entry or recomputed using post-milestone information. Later information cannot enter an entry-time forecast.

A runner label already depends on a managed stop: freeze a baseline management policy here. Distinguish **milestone touched**, **stop modification requested**, **modification effective**, and **eventual net outcome**. A touched milestone is not evidence of effective protection. Version the labels with the stop/horizon/management policy so #311 cannot change the meaning without regenerating affected labels and re-evaluating #310's probabilities.

### 4. Specify exactly what the null and uncertainty procedure test

An execution-matched null must destroy the hypothesized predictive relation while retaining the relevant opportunity, cost, volatility/session and temporal structure. “Preserves temporal dependence” needs an implementable construction and stated assumptions, not a generic shuffle. Compare with the frozen baseline and no-trade as distinct references; a null is not a replacement for either.

Define episode IDs and label intervals before splitting. Fit preprocessing, model, calibration and thresholds only in allowed development windows. Use common calendar blocks for paired candidate/baseline results; where instruments share shocks, preserve that dependence too. Document block-length sensitivity and effective episode support. Trade-level R intervals alone do not establish a portfolio-level improvement.

Register the primary objective, minimum useful effect, candidate budget, and protected evaluation protocol before looking at selection results. Recording trials and bootstrapping the selected winner do not themselves address multiple selection attempts. The existing `arch` dependency offers [multiple-comparison procedures](https://arch.readthedocs.io/en/stable/multiple-comparison/multiple-comparisons.html); choose an appropriate method rather than merely listing the package.

### 5. Make reproducibility and ownership concrete

The manifest needs an immutable dataset identifier and a retrievable archive or documented authorized restoration path, not only a checksum of a local DB. Record provider/proxy, exact product identity, bid/ask basis, session/alignment/smoothing settings, verified coverage, gaps, revisions and applicable costs. Distinguish “backfill running” from coverage verified. WTI foundation work can start once its own required data passes, without waiting for all 18 instruments.

Define exact equality for deterministic labels/trades/decisions and a justified tolerance for platform-dependent floating-point outputs. Pin dependencies, seeds and solver settings.

Start minimal append-only forward capture now in coordination with #313; formal frozen shadow evaluation remains later. Closing #306 is sensible, but its existing live-prediction outcome tracking needs an explicit owner in #312/#313 or an explicit retirement decision: it is not automatically replaced by this offline harness.

**Grilling question:** Can another engineer reconstruct precisely what was knowable, what order could execute, and why a path received its label—and show that every uncertainty capable of changing qualification is either measured or blocks qualification?
