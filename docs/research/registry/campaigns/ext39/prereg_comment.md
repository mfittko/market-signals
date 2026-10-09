## ext39 preregistration: continuation or reversal after an extreme daily move (33 daily markets pooled)

This is registered before any outcome run. Only synthetic self-checks and event counts ran. No forward return was computed.

Question: after an extreme daily move, does the market continue or reverse over the next days? Published evidence is mixed: short-term reversal in equities (Lehmann 1990, Jegadeesh 1990), continuation after large moves in some futures. The test is two-sided. Either direction counts if it replicates.

Files:
- `data/research/engine/audit/ext39/prereg.json` sha256 `02e41df4c13ad0a402541b434ea5e388c173f2920b6514cd92853ccaddd1aac3`
- `data/research/engine/audit/ext39/ext39.py` sha256 `ebe6e14ba1d6f2f2c537a9827a4bb126d4a23bc2076f6c0e5cb66c18dec591a2`
- Data: `audit/tsmom36/daily.db` (33 OANDA daily mid series, bars close 17:00 New York, weekend stubs dropped), read-only. Spreads: `audit/tsmom36/out/spreads.json`. Nothing fetched.

### Definitions
- r_t = close[t] / close[t-1] - 1 on each instrument's own bars. sigma_t = std of the 60 returns t-60..t-1 (r_t excluded).
- Event: |r_t / sigma_t| >= 2.5. Direction d = sign(r_t). One event per instrument per 5 bars: after an event at t, candidates at t+1..t+4 are skipped.
- Outcome: d x (close[t+h] / close[t] - 1) in units of sigma_t and in bps, h in {1, 3, 5, 10} bars.
- PRIMARY entry is the event bar's own close. This assumes a trade at 17:00 New York at the close mid. SECONDARY entry is the next bar's close.
- Net bps: gross minus half the median spread per side (2 bps per side where no candles_ba spread exists) minus 0.822 bps per calendar night held (3%/365, long and short charged).
- Windows by event date: dev 2005-01-01..2022-12-31; 2023-01-01..2026-10-08. The 2023+ window is a development window, not a holdout.

### Test
- PRIMARY: threshold 2.5, h = 3, entry at the event close, all 33 instruments pooled, equal weight per event. Statistic: mean signed forward return in sigma units.
- CI: cluster bootstrap by ISO calendar week of the event date, 1000 reps, seed 39, percentile 95%.
- PASS continuation if the CI lower bound is above 0 in BOTH windows. PASS reversal if the CI upper bound is below 0 in BOTH windows. Otherwise FAIL. One test, no multiplicity adjustment.
- Event counts (threshold 2.5): dev 3,272 in 763 weeks (FX 992, indices 829, commodities 1,110, bonds 341; up 1,466, down 1,806). 2023+ 625 in 161 weeks (FX 200, indices 133, commodities 228, bonds 64; up 288, down 337). Threshold 2.0: 6,602 / 1,303. Threshold 3.0: 1,581 / 304.
- Ex-ante power: MDE80 about 0.09 sigma dev and 0.21 sigma 2023+ (random-walk SD of the 3-day outcome about 1.7-1.9 sigma).
- Secondary results never decide the verdict: h = 1, 5, 10; asset class; thresholds 2.0 and 3.0; up vs down events; next-close entry; gross and net bps; hit rate; MDE80; per-instrument means. The full grid has 720 cells, all logged to trials.jsonl.

This is development evidence only. Any survivor needs prospective confirmation (https://github.com/mfittko/market-signals/issues/313) or data after 2026-10-07.
