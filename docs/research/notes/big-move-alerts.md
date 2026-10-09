> Superseded by (2026-10-09): the step 5 plan ran as campaigns.
> The multi-week layer found no qualifying policy ([mw6](../registry/campaigns/mw6/)).
> The ATR-relative big-move target replicates on six instruments but acts as a session clock and misses price-scale big moves ([alert7](../registry/campaigns/alert7/)).
> The absolute (% of price) big-day model ranks well (AUC 0.78 to 0.90) but fails its registered recall rule ([abs11](../registry/campaigns/abs11/), [abs48](../registry/campaigns/abs48/)).
> The body below is the original note.

# Big-move alerts: design notes and step 5 plan

Date: 2026-10-07. Source: spike 4 and the operator discussion that followed.

Operator goal: signals on big moves (+/- 2-5% days and multi-week moves), prefer neutral, never miss the big ones. Price confirmation is mandatory before entry. News never sets direction.

## Agreed architecture (not built yet)

1. **Volatility gate, always on, cheap.** Per-instrument logistic regression, no LLM. States: off, armed, fired. It never sets direction.
   - Day layer: P(big day) from trailing realized volatility (HAR) plus intraday excursion against the time-of-day norm. Fires only before the day crosses its threshold, and only with a confirmation gate |close-open| >= 0.4-0.5 x threshold.
   - Multi-day layer (planned): cross-instrument stress index plus a "big week" state (top-10% 5- or 20-day excursion).
2. **Arm/fire raises polling cadence** of that instrument's trend follower (M5/M15). Use the existing per-granularity `cycleMinutes` as a cadence override, not a new scheduler.
3. **Trend follower confirms direction.** Deterministic rules, not an LLM agent. Supertrend must agree on two timeframes (M15+H1 intraday, H4+D1 multi-day). Optional pullback-resume or range break. No confirmation means stay neutral.
4. **Exits carry the edge.** Stop at entry, supertrend or ATR trailing exit, no averaging down.
5. **Disarm** at the day close, or when stress stays low for N days. Open positions are still managed to their exit.
6. **Notifications:** "armed"/"fired" become the third alert type next to supertrend and volume alerts. The payload is instrument, P(big), excursion/threshold, side so far, time and threshold %, with no long/short call. A trade notice goes out only after confirmation.
7. **Prediction widget:** drop long/short. Show today's P(big day), an excursion-vs-threshold bar and the gate state. Jev or an LLM may write the explanation only.

## Evidence (EUR/USD only, 2023-2024 test, not a clean holdout)

- P(big day) at the open: AUC 0.77 from HAR volatility. Day of week, gap and calendar flags add nothing. LightGBM is not better.
- Direction intraday: continuation to the close is 48-52% at every checkpoint, and MFE equals MAE after alerts. Big days look directional only in hindsight (survivorship).
- No rule reached recall >= 0.70 with high precision. The realistic operating point is about 2 alerts/month, recall about 0.63, precision about 0.45, alerts around 10:00 UTC with about 45% of the move still ahead. The naive "excursion >= 0.8 x threshold" rule gets similar precision but alerts about 4 hours later.
- A fixed probability cutoff breaks on regime change: 0 alerts in 2023. The cutoff must be per instrument and adaptive, as a trailing-rank cutoff chosen walk-forward.
- Big-day scorer at 10:00 UTC, 150 days: local model AUC 0.76, Jev 0.68, DeepSeek-V4.1-Flash 0.68, naive excursion ratio 0.69.
- The EUR/USD big-day threshold is 0.8-1.2%; the 2-5% framing fits oil, gas and silver.

## Step 5 plan (waiting on data and on operator go-ahead)

- **Data needed:** WTI, XAU, XAG, SPX500 and NATGAS in data/research/history.db through at least 2026-03-31. The download was throttled by HTTP 429 on 2026-10-07.
- **Features:** cross-instrument stress (median volatility rank, count of instruments above the 90th percentile, correlation spike, SPX realized volatility and drawdown, lead-lag).
- **Labels:** a "big week" label, plus a fixed per-instrument floor (for example WTI >= 3% always counts), because the trailing-year threshold drifts during long crises.
- **Crisis holdouts:** 2020 H1 (lockdown), 2022 H1 (war), 2025 Q4-2026 Q1 (gold/silver spike then reversal). Report first-alert lag, recall and calm-week false alerts.
- **Continuation:** over the next 5/20 days after a big-week alert.
- **Backtest the full loop:** gate arms, follower polls, confirms, enters, trails. Compare with the same follower always on. The gate earns its place only through payoff per trade or fewer false entries at similar profit.

## Files

- Scripts: `/private/tmp/claude-503/-Users-mfittko-github-market-signals/5e1c82d0-8142-4d27-860e-57431e4cdd2d/scratchpad/modellab/spike4/` (`data.py`, `run.py`, `report.py`, `pool.py`, `llm_export.py`, `llm_run.mjs`, `llm_score.py`). The scratchpad may be cleaned up. Earlier lab report: `../REPORT.md`.
- Run: `../.venv/bin/python run.py "<INST>" ...`, then `report.py`, then `pool.py`.
- Jev call ledger: 1953 of 3000 used.
