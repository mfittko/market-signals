## flow29 preregistration: aggressor-side volume imbalance vs WTI direction

This is registered before any outcome run. Before this comment: Databento cost quotes, the trade download, a bar-build smoke test on three months (trade and side counts only), and synthetic self-checks. No outcome was computed.

Files:
- `data/research/engine/audit/flow29/prereg.json` sha256 `46e57136faac2eb8ec7948c8d2c320efffbef4e191340e7f0dab8c4d89737509`
- `data/research/engine/audit/flow29/flow29.py` sha256 `9347892e79361e0ffcd666bd941266eef6e26f10497f91c8b55c8f963f6e4cf5`
- `data/research/engine/audit/flow29/fetch.py` sha256 `8f0701eddd8ce19f871c02f85cdab667e2bdfcb3895a9cf4637a186c310a360a`
- `validate.py` (unchanged, `day_of`, `day_boot`) sha256 `cb1642edb11efc214e1cdc360b4b5d5adc353ed4067270282719836e7e6abddd`

### Data
- Databento GLBX.MDP3, schema `trades`, continuous symbol `CL.v.0` (volume-ranked front month). Window 2025-10-01 to 2026-10-08.
- Cost quotes: `CL.c.0` $32.61, `CL.v.0` $35.98. The rule allowed `CL.v.0` up to $40, so `CL.v.0` is used. It follows the liquid contract through rolls.
- Side convention, from the `databento_dbn` `Side` enum: `B` = buy aggressor, `A` = sell aggressor, `N` = no side. `N` is excluded from the imbalance.
- This is a single-year test. It covers one regime and includes the 2026 escalation period. A pass needs confirmation on 2024-10 to 2025-10 before any live use.

### Bars and windows
- M5 bars from the trades: close = last trade price, total volume, signed volume = buy-aggressor size minus sell-aggressor size.
- Complete 5-minute grid. A bar without trades keeps the previous close and has volume 0. Runs of trade-free bars of 60 minutes or more are closed (session breaks, weekends).
- Every imbalance window and every outcome window must be open and on one contract. No move spans a roll.
- Trading day key: 22:00 UTC rollover.

### Primary test (one, fixed)
- I_k = signed volume / (buy + sell volume) over the last k closed bars, k = 1 and k = 3.
- Event: |I_k| at or above the 95th percentile of |I_k| over the previous 20 trading days (causal). The first 20 trading days are skipped.
- Outcome: close[t+6] vs close[t]. Continuation = the move has the sign of I_k. Ties are dropped.
- Baseline: the up-share over all bars of the same period with a valid outcome window. A buy event gets p_up, a sell event gets 1 - p_up. This handles drift.
- Statistic per k: D_k = P(continue | event) minus the matched baseline.
- Inference: moving-block day bootstrap (block 5 days, 1000 reps, seed 29), two-sided bootstrap p, Holm over k = 1 and k = 3.
- PASS if for at least one k the Holm-adjusted p < 0.05 and |D_k| >= 3 pp. A positive D_k is labelled CONTINUATION. A significant negative D_k of at least 3 pp is a pass labelled REVERSAL.

### Secondary (reported, never decide the verdict)
- Horizons N = 3 and 12.
- M1 bars from the same trades, N = 6 M1 bars.
- Absorption: event bars where the price moved less than 0.25 ATR(10) in the flow direction over the imbalance bars, or against it. Reported: P(next 6 bars go against the flow) vs pushed events and baselines.
- The same CL events scored on OANDA WTICO/USD mid (history.db, read-only), aligned by UTC time.
- Mean move in ATR units, raw and drift-adjusted.
- Power: minimum detectable difference at 80% power, (2.24 + 0.84) x bootstrap SE.
