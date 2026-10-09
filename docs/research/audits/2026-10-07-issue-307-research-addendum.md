# Audit: Research addendum: tradable continuation, validated thresholds, and what to reuse

- Date: 2026-10-07T17:04:19Z (UTC)
- Source: https://github.com/mfittko/market-signals/issues/307#issuecomment-6042752365
- Posted by the operator on behalf of the external auditor.

## Follow-up

- The pre-audit ladder campaign tested A to C (https://github.com/mfittko/market-signals/issues/309#issuecomment-6046593404) and D to E (https://github.com/mfittko/market-signals/issues/310#issuecomment-6046831326). Its trial rows are the `ladder (pre-audit)` row of [trials-summary.csv](../registry/trials-summary.csv).
- Execution-matched nulls and bid/ask fills are part of the evaluator (`nulls.py`, `fills.py` in [evaluator](../registry/evaluator/)).
- Waiting and passive entries: [limit13](../registry/campaigns/limit13/) (all FAIL). Regime-conditional policy: [daytype14](../registry/campaigns/daytype14/) (all REJECTED).

## Verbatim text

## Research addendum: tradable continuation, validated thresholds, and what to reuse

Companion to the [state-based EntryGuard proposal](https://github.com/mfittko/market-signals/issues/307#issuecomment-6042709055). Research review dated 2026-10-07. I read this issue/comments, #230, the description of #303, selected existing implementation paths, and the primary references below. **I did not rerun the four local spikes or inspect their underlying datasets/reports:** this issue identifies those artifacts as local/untracked. None of the following claims a demonstrated new trading edge.

### 1. Label the path we actually want to trade

Start from an immutable proposal: instrument/venue, side, decision time, executable entry convention and latency, initial stop, planned cash-risk unit `R`, maximum holding horizon `H`, and management-policy version. Keep the original R denominator throughout the trade.

Use the triple-barrier/meta-labeling framework from López de Prado's *Advances in Financial Machine Learning*, [Chapter 3](https://www.oreilly.com/library/view/advances-in-financial/9781119482086/c03.xhtml), but extend it to the operator's two-stage objective:

| Target | What it measures |
|---|---|
| `p_arm` | Probability of reaching a specified favorable milestone **before** the initial stop and before H. The milestone is large enough for the intended profit-protection policy; it is not simply an uptick. |
| `p_runner` | Probability of reaching a further meaningful net-profit target before the policy-managed stop, **conditional on having reached the milestone**. Preserve both stages' ordering. |
| Policy outcome distribution | Net realized R, time to milestone/exit, adverse excursion before protection, drawdown after protection, and loss/gap tails under the complete frozen policy. |

A milestone touch is not an acknowledged stop modification. Replay initial-stop protection, modification latency/rejection, and the resulting managed stop separately. For ordinary stops, “stop above entry” is not a guarantee of a nonnegative fill. [Plus500's own stop-order documentation](https://cdn-main.plus500.com/en/tradingacademy/faq/trading/whatiscloseatlossorder) explicitly describes slippage; [guaranteed stops](https://cdn-main.plus500.com/en/tradingacademy/faq/trading/whatisguaranteedstoporder) are a distinct product with conditions and cost. Include spread, commissions, financing and applicable conversion costs when defining net protection.

**MFE/MAE alone are insufficient:** a favorable excursion after the initial stop is not a successful entry. Store the ordered path or sufficient event timestamps. For censored/incomplete records, do not silently label them successful or unsuccessful. A fixed horizon with complete data is simplest initially; competing-risk/time-to-event analysis is a later extension.

Measure **remaining opportunity from the current executable price**, not what the move achieved before the alert. Keep separate intraday and multi-day targets, costs and policies.

### 2. “Better than chance” needs an execution-matched null

A mathematical illustration: for continuous zero-drift Brownian price movement, no costs and no deadline, the probability of hitting +0.25R before -1R is already `1 / (1 + 0.25) = 80%`. The corresponding expectancy is `0.8 × 0.25R - 0.2 × 1R = 0` before costs. This is not a market estimate; it shows why an impressive success percentage can be economically empty.

Compare against the same barriers, holding limits, cost assumptions, entry opportunities and capital/risk limits—not a generic 50% coin flip. Include both simple signal baselines and matched random/lagged controls. Use null constructions that retain relevant temporal dependence, volatility and session structure; simple label shuffling is not the only required null.

Likewise, a direction-to-close result near 50% neither rules out every path-dependent strategy nor establishes that trailing stops create an edge. [Kaminski & Lo, *When do stop-loss rules stop losses?*](https://dspace.mit.edu/entities/publication/bb69ca4b-0cdc-487f-831d-63b2e84fafee) studies when stops add or subtract value. Its portfolio/futures evidence is not proof for our intraday CFD implementation. Test exit policies rather than assuming their benefit.

### 3. A threshold should express a qualified decision, not a confidence aesthetic

Proposed permission structure:

```text
eligible = data_and_venue_valid
        && policy_is_qualified_for_this_domain
        && side_and_setup_rules_pass
        && calibrated_path_estimate_passes_selected_threshold
        && estimated_net_payoff_passes_selected_margin
        && risk_and_execution_limits_pass
```

Thresholds/margins above are parameters to determine on permitted development data, not suggested numerical defaults. Qualification should include uncertainty in **out-of-sample accepted-cohort performance** and adequate effective sample support. A confidence interval for a cohort mean is not a confidence bound guaranteeing the next trade.

**Do not fix regime drift by forcing alerts.** A trailing-rank threshold can prioritize research attention or normalize an opportunity score, but the best 5% of a bad population may still be bad trades. Keep an absolute evidence/economics floor and allow zero actionable alerts. Any adaptive recalibration/ranking rule must itself be frozen, use only previously available observations and matured outcomes, and be replayed exactly.

Use reliability curves plus Brier/log loss for probabilistic quality, and precision/recall plus risk-versus-coverage curves for the selected entries. ROC-AUC for big-day detection does not establish useful precision at the alert threshold. Report counts and dependence-aware uncertainty, especially in the high-score tail. Do not multiply marginal volatility/direction/continuation probabilities as though independent, or count several price-derived indicators as independent corroboration.

Relevant established methods: [probability calibration](https://scikit-learn.org/stable/modules/calibration.html), [decision-threshold tuning](https://scikit-learn.org/stable/modules/classification_threshold.html), and [Geifman & El-Yaniv, selective classification](https://arxiv.org/abs/1705.08500). Borrow the reject-option/risk-coverage formulation; the latter's image-classification guarantees do not transfer automatically to nonstationary financial returns.

### 4. Research candidates beyond another indicator vote

These are hypotheses to compare, not prerequisites to stack indiscriminately:

| Candidate information | Concrete as-of features / question |
|---|---|
| Path persistence versus chop | Backward-looking directional efficiency `abs(net price change) / sum(abs(price changes))`, bar overlap, reversal frequency, recent failed breaks, and setup age. Does any improve future barrier outcomes beyond volatility? |
| Entry geometry | Distance to causal invalidation and breakout levels; ATR-normalized extension; pullback depth/duration; remaining reward relative to stop and spread. Can waiting improve the trade rather than merely delay it? |
| Liquidity/session | Actual spread relative to expected movement, observation freshness, session/time-of-day, and correctly defined activity/volume relative to that session. |
| Cross-instrument context | Time-aligned stress and relative strength/weakness, tested incrementally. Correlated assets must not masquerade as independent confirmation. |
| Richer market data, only if justified | Genuine signed order-flow imbalance and depth, rather than a raw volume spike. Validate data access, instrument mapping, latency and costs before investing. |

[Corsi's HAR-RV paper](https://academic.oup.com/jfec/article-abstract/7/2/174/856522) is a sound reference for a parsimonious **volatility** baseline, not a directional/continuation model. [Cont, Kukanov & Stoikov](https://arxiv.org/abs/1011.6402) find order-flow imbalance more robustly related to short-interval price changes than trade volume in their equity sample. That is motivation for a separate data experiment, not evidence that our candle feed predicts subsequent returns. Broker tick/activity volume cannot be assumed to be consolidated traded volume; OHLCV cannot reconstruct an order book.

Start with regularized logistic regression and one small tree-based challenger. Where per-instrument episodes are sparse, compare an appropriately normalized pooled baseline with instrument-specific models rather than assuming 18 separate models are superior. The negative meta-labeling result already recorded in spike 3 matters: changing the label or adding abstention cannot manufacture information absent from the inputs.

### 5. Validation must include waiting and repeated observation

Freeze train → calibration → threshold/policy selection → later evaluation windows, followed by prospective shadow capture. Fit preprocessing and feature selection inside the permitted windows. Purge overlaps between training label intervals and evaluation intervals; group repeated observations by setup/episode, and use calendar-aligned splits across correlated assets.

For between-event entry, replay the **entire sequential policy**: every scheduled eligible decision point, WAIT, invalidation, first accepted entry, expiry, cooldown and rearm. Do not select the best later bar retrospectively. Do not train only at flips and report confidence at arbitrary later bars. Repeated polling and selecting the first threshold crossing change the selected population; validate calibration and economics at those actual stopping times.

The named crisis intervals are useful stress suites, but selecting them after seeing the crises does not make them untouched final holdouts. Testing another instrument during the same globally observed episode is also not a substitute for forward chronological evidence. Register hypotheses, trial budgets and failed attempts; protect final outcomes from the bounded research agents in #231. [Bailey et al., *The Probability of Backtest Overfitting*](https://scholarworks.wmich.edu/math_pubs/42/) motivates selection-aware evaluation; [arch's SPA/Reality Check procedures](https://arch.readthedocs.io/en/latest/multiple-comparison/multiple-comparison-reference.html) provide reusable multiple-comparison tools, not an immunity certificate.

**Execution fidelity is especially important here.** The issue specifies M1 bid candles. Those alone do not identify ask-side fills, intraminute barrier ordering, or a stop replacement taking effect before a reversal. Use qualified bid/ask data and finer paths where needed; otherwise report conservative/alternative path bounds and the ambiguity rate. Do not certify sub-bar profit protection from an optimistic OHLC ordering. Preserve the existing [simulateFills](https://github.com/mfittko/market-signals/blob/main/scripts/bot.mjs) gap-first and conservative both-touched behavior as fixtures, while extending timing/cost semantics for the new policy. Forming-candle and higher-timeframe inputs need actual as-of snapshots, not final OHLC values backfilled into earlier decisions.

Publish the local research code/configuration and result summaries, plus immutable dataset manifests/checksums where licensing permits. Raw market data need not be committed. An independently reproducible run should precede treating the current spike findings as qualification evidence.

### 6. Reuse shortlist: components, not an untested platform replacement

| Source | Recommended use | Important limit |
|---|---|---|
| [RiskLabAI.py](https://github.com/RiskLabAI/RiskLabAI.py) | Reference implementations of triple-barrier/meta-labeling, sample weighting, purged validation and backtest diagnostics. [BSD-3-Clause license](https://github.com/RiskLabAI/RiskLabAI.py/blob/main/LICENSE) inspected. | The inspected [triple_barrier implementation](https://github.com/RiskLabAI/RiskLabAI.py/blob/main/src/RiskLabAI/data/labeling/labeling.py) follows a supplied **close-price** series. It is not a bid/ask, order-latency or trailing-stop simulator. Audit reused methods with our own fixtures. |
| [scikit-learn](https://scikit-learn.org/stable/modules/calibration.html) | Small numeric baselines, calibration and threshold evaluation. | Supply chronological, overlap-aware splits; do not inherit default random/stratified CV. |
| [arch](https://github.com/bashtage/arch) | HAR/volatility baselines, stationary/block bootstrap and SPA/Reality Check analytics. | Uncertainty and test validity still depend on appropriate sampling/block assumptions and a recorded candidate search. |
| [NautilusTrader](https://github.com/nautechsystems/nautilus_trader) | Candidate event-driven ResearchRunner, consistent with #230; test a small compatibility slice before adoption. | Its [bar-execution documentation](https://nautilustrader.io/docs/latest/concepts/backtesting/bar-execution/) explicitly describes synthetic OHLC ordering, and [fill models](https://nautilustrader.io/docs/latest/concepts/backtesting/fill-models/) require configuration. Engine sophistication cannot recover missing intrabar history. Pin a release and check its API/adapter fit. |
| [pysystemtrade](https://github.com/pst-group/pysystemtrade) | Reference for systematic forecasting, risk sizing, production controls and separation of concerns. The repository moved to `pst-group`; use the current location. | A futures system, not a drop-in CFD predictor. Its [GPLv3 license](https://github.com/pst-group/pysystemtrade/blob/develop/LICENSE) needs consideration before code reuse. |
| [scikit-survival competing risks](https://scikit-survival.readthedocs.io/en/stable/api/nonparametric.html) | Later investigation of time-to-protection versus time-to-stop, with censoring represented explicitly. | An analysis primitive, not a ready-made conditional trading predictor or execution model. |

Recommendation: keep numeric research offline in a small Python environment, export versioned artifacts and test inference parity in the existing runtime where practical. Keep the live EntryGuard deterministic. Do not introduce six new production services or replace the platform to run the first experiment. Pin dependencies and record preprocessing, label, policy and model versions together.

### 7. Small experiment ladder and acceptance objective

Start with one instrument/horizon and a finite, registered candidate set:

| Variant | What the comparison isolates |
|---|---|
| A: current follower, original event-time entries | Baseline with frozen sizing/exits/costs; include no-trade as an economic reference. |
| B: A plus the proposed volatility gate | Whether volatility filtering alone improves executable outcomes. |
| C: deterministic setup/path rules without that gate | Whether chop/entry geometry contributes independently of exceptional volatility. |
| D: C with sequential wait/confirm entry | Whether between-event entry adds value after its delay and missed trades. |
| E: D with a calibrated statistical accept/skip policy; ablate volatility | Whether ML improves the accepted population beyond the deterministic setup and whether the volatility layer earns its place. |
| F: a few frozen protection/trailing policies on matched entries | Whether profit protection helps or cuts off the large winners; then validate the selected full loop separately. |

Measure net portfolio outcome and drawdown, cost-aware R, protection-before-stop rate, runner capture, avoided losers, blocked winners, opportunity coverage, detection/entry delay, and alerts per independent episode. Include adverse cost/latency assumptions and parameter-neighborhood stability. Count all attempts, abstentions and expired setups; do not score only executed winners or only alerts that were noticed.

**Promotion requires evidence of useful selection, not simply fewer trades, a high hit rate, or positive in-sample P&L.** Predeclare acceptable risk/coverage and uncertainty criteria, then require frozen-policy out-of-sample and prospective results. Until then the product can provide explicit warnings and an experimental journal, but should not claim an entry is statistically safe.

The practical goal is not to eliminate uncertainty. It is to make unsupported entries difficult, profitable-looking noise easy to falsify, and any eventual agent unable to bypass the controls.
