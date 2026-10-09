## cmd41 preregistration: out-of-sample check of the ext39 commodity continuation lead (10 CME commodities not in ext39)

This is registered before any outcome run. Only synthetic self-checks, roll counts and event counts ran. No forward return was inspected.

Question: ext39 found one post-hoc lead (1 of 720 cells). After an extreme daily move, its 11 commodity CFDs continued over the next 5 days in both windows: +0.255 sigma [+0.022, +0.466] dev, +0.451 [+0.018, +0.853] 2023+. cmd41 fixes that rule in advance and tests it on 10 commodities that were not in ext39's data.

Files:
- `data/research/engine/audit/cmd41/prereg.json` sha256 `c4e96738148946dd151ae52e470940a7ab7729727d0caa633ab84c1bf34d6ffb`
- `data/research/engine/audit/cmd41/cmd41.py` sha256 `888f56fbb6246e50efff1979258f1534e5f23db07ae1e702e52148a0d2c3d704` (imports the event rule constants, `stats` and `week_boot` from ext39.py unchanged, sha256 `ebe6e14b...`)
- Data: Databento GLBX.MDP3 ohlcv-1d, continuous volume-ranked front month HO, RB, PA, LE, HE, ZL, ZM, KE, ZO, GF (`.v.0`), 2010-06-06..2026-10-08, one request, billed $0.43. `raw/ohlcv1d_10.dbn.zst` sha256 `f465d5cc...`. KE starts 2013-12-16.

### Data notes
- Databento daily bars are UTC-day aggregates of trades, not exchange settlements. The bar dated D closes at the last trade before 00:00 UTC on D+1. Entry "at the close" therefore means 00:00 UTC. For HO, RB, PA this falls in the evening Globex session. For grains and livestock the last trade of the UTC day is near the day-session close.
- Saturday and Sunday UTC bars are thin stubs and are dropped, as ext39 drops weekend stubs.
- Every bar carries instrument_id, so contract rolls are known. A roll return (contract change from t-1 to t) is excluded from sigma and is never an event. An outcome window that contains a roll is dropped and counted.

### Definitions (ext39 unless stated)
- r_t = close[t] / close[t-1] - 1. sigma_t = std of the last 60 non-roll returns before t.
- Event: |r_t / sigma_t| >= 2.5. Direction d = sign(r_t). One event per market per 5 bars.
- Outcome: d x (close[t+h] / close[t] - 1) in sigma_t units and bps, h in {1, 3, 5, 10}.
- PRIMARY entry at the event bar's close. SECONDARY entry at the next bar's close.
- Net: CFD-style = gross - 2 x 2 bps - 0.822 bps per calendar night held. Futures-style = gross - 2 x 2 bps. Both costs are assumptions.
- Windows by event date: dev 2010-06-06..2022-12-31; 2023-01-01..2026-10-08 (development window, not a holdout).

### Test
- PRIMARY: threshold 2.5, h = 5, entry at the event close, all 10 markets pooled, equal weight per event. Statistic: mean signed forward return in sigma units.
- CI: ext39 week-clustered bootstrap (ISO calendar week of the event date), 1000 reps, seed 39, percentile 95%.
- PASS if the CI lower bound is above 0 in BOTH windows. Otherwise FAIL. The test is one-sided because ext39 specified continuation. One test, no multiplicity adjustment.
- Event counts (threshold 2.5): dev 595 in 345 weeks (energy 137, grains/oilseeds 221, livestock 167, metal 70); 2023+ 183 in 106 weeks (40 / 68 / 56 / 19). At h = 5 with close entry, 123 of 778 outcomes span a roll and are dropped (655 kept). At h = 10, 214 are dropped.
- Ex-ante power: with an outcome SD near 3 sigma, MDE80 is about 0.38 sigma dev and 0.67 sigma 2023+. ext39's commodity estimates (+0.255, +0.451) are below both. A PASS needs an effect larger than ext39 measured. A FAIL is weak evidence against an effect of ext39's size.
- Secondary results never decide the verdict: h = 1, 3, 10; thresholds 2.0 and 3.0; per market; energy (HO, RB) vs grains/oilseeds (ZL, ZM, KE, ZO) vs livestock (LE, HE, GF) vs metal (PA); up vs down; next-close entry; CFD and futures net; hit rate; MDE80; roll drops; a combined view with ext39's 11 commodities (labelled not independent). 2,160 cells, all logged to trials.jsonl.

This is development evidence only. Any survivor needs prospective confirmation (https://github.com/mfittko/market-signals/issues/313) or data after 2026-10-07.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
