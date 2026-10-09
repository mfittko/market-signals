## flow42 preregistration: confirm the flow29 reversal on 2024-10 to 2025-10, and test whether flow adds information beyond the price move

This is registered before any outcome on the new year. Before this comment: the Databento cost quote ($28.27), the monthly trade download, the M1 bar build (counts only: 22,587,228 trades, 10,391,673 B, 10,303,354 A, 1,892,201 N), and synthetic self-checks. No outcome was computed on 2024-10 to 2025-10. H2 has not been computed on either year.

flow29 (result https://github.com/mfittko/market-signals/issues/310#issuecomment-6076402618) found on CL M5 2025-10 to 2026-10: after the strongest 5% of 3-bar aggressor imbalances, P(continue) over the next 6 bars was 44.9% against a 50.0% baseline, D -5.1 pp [-7.0, -3.3].

Files:
- `data/research/engine/audit/flow42/prereg.json` sha256 `03313bf0e89140bc50c0c7d9e70f7e5ab9b60ed3ec1d4449bd0c65d7c2fc4117`
- `data/research/engine/audit/flow42/flow42.py` sha256 `ab4ceb4414e1f8a30f4b282683f91b966fefee0c1ad5f611af5786dec98122f3`
- `data/research/engine/audit/flow42/fetch.py` sha256 `f78470c053f81a9ed618679366f067ebcaa39e8e85c8ad456b0f2ff548b724e2`
- `data/research/engine/audit/flow29/flow29.py` (imported unchanged) sha256 `55d85d483ce36dadcdb6b81cd7134307cff4203ccb02b592fe3f1183e48f4f85`
- `data/research/engine/validate.py` (unchanged) sha256 `cb1642edb11efc214e1cdc360b4b5d5adc353ed4067270282719836e7e6abddd`

### Data
- Databento GLBX.MDP3, schema `trades`, `CL.v.0`, 2024-10-01 to 2025-10-01 (end exclusive). Same symbol and stype as flow29. 12 monthly chunks, each downloaded once. Billed $28.27 (sum of per-month quotes). Databento flags 2025-09-17 and 2025-09-24 as degraded quality; both days stay in.
- All bar building, imbalance, trailing thresholds, outcome, roll guard, OANDA alignment and bootstrap code is imported from `flow29.py`. No outcome window spans a contract roll.

### H1 replication (primary)
- The flow29 k = 3 test unchanged on 2024-10 to 2025-10: M5, event iff |I_3| is at or above the trailing-20-day 95th percentile, outcome close[t+6] vs close[t] on gross CL trade prices, matched up-share baseline, 5-day block bootstrap, 1000 reps, seed 29.
- PASS iff D < 0 and the 95% CI upper bound is below 0. The direction (reversal) is pre-specified by flow29.
- Also reported: whether |D| >= 3 pp (the card's display bar). This is not part of the pass.

### H2 incremental (primary; decides whether a live flow feed is worth paying for)
- Question: does heavy flow predict the next 6 bars beyond what the 3-bar price move already says?
- Heavy: the H1 event set.
- Move: x = (close[t] - close[t-3]) / ATR(10)[t], signed in the raw price direction. Bars t-3..t must be open and on one contract.
- Bins: 10 bins per trading day, edges at the deciles of x over all valid bars in the previous 20 trading days (the flow29 trailing rule, causal). Fixed before the run.
- Control: non-event bars with a valid outcome and |I_3| below the trailing-20-day median of |I_3|.
- Cell: (year, move bin, UTC hour).
- D_inc = mean over heavy events of (continue minus the control rate in the same cell). The control rate is the up share for a buy event and the down share for a sell event. Weighting is by heavy-event count. Heavy events without a control in their cell are dropped and counted.
- Windows: the new year, the flow29 year (flow29 bars, read-only), and both years pooled with cells kept within year. Pooling is allowed because H2 is new on both years. The flow29 year was used to find the H1 effect, so the pooled H2 is not fully independent of that selection.
- Bootstrap: 5-day block, 1000 reps, seed 42, control rates recomputed per replicate.
- PASS iff pooled D_inc < 0 with the CI upper bound below 0, AND the point estimate is negative in each year separately.
- Synthetic check: on a price-only model (flow pushes price, the next bars revert the price move), H1 is negative but D_inc is about 0 (20 seeds: mean -0.3 pp, SE 0.3 pp). On a flow-driven model D_inc is negative with CI below 0.

### Secondary (never decides)
k = 1; N = 3 and 12; M1; OANDA WTICO/USD mid on the same event times; buy vs sell events; absorption split; a fade trade against the flow at OANDA mid net of half the spread at entry and exit; mean flow-signed move in ATR; MDE80; H2 with 20 bins. `flow29.run()` is also executed unchanged on the new bars; its own Holm/3 pp verdict is reported only as a repeat of the flow29 rule.
