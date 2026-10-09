## night38 result: overnight drift in US stock index CFDs. FAIL

Preregistration: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078463376 (prereg.json sha256 `9768b8f9...`, night38.py sha256 `b362b1e3...`, unchanged for the run).

The night CI clears 0 in dev only, and night minus day is negative in 2023+. Both conditions of the decision rule fail.

### Primary: SPX500, all nights (bps; day-block bootstrap, block 5, 1000 reps, seed 38)

| window | trading days | nights / days | skips (open, close) | night [95% CI] | day [95% CI] | night - day [CI] | hit | net night [CI] | net / yr |
|---|---|---|---|---|---|---|---|---|---|
| dev 2018-22 | 1,259 | 1,253 / 1,252 | 6, 1 | +4.01 [+0.23,+7.94] | +1.27 [-3.47,+5.79] | +2.74 [-3.51,+9.19] | 0.557 | +1.67 [-2.10,+5.60] | +4.2% |
| 2023+ | 944 | 944 / 944 | 0, 0 | +2.42 [-1.70,+6.09] | +5.49 [+1.27,+9.73] | -3.07 [-9.31,+2.91] | 0.548 | +0.46 [-3.66,+4.13] | +1.1% |

Net uses half the median spread at the close and at the next open (rt cost 1.15 bps dev, 0.77 bps 2023+) plus 3%/365 financing per calendar day (0.82 bps a weekday night, 2.47 bps over a weekend). MDE80: night 5.5-5.7 bps, difference 8.7-8.9 bps. A true night premium of 2-4 bps a night is below the detection limit with this history.

### The dev pass depends on skipped March 2020 days (POST-HOC)
All 7 skipped dev days fall in March 2020: opens 03-09, 03-12, 03-13, 03-16, 03-18, 03-24 and the close of 03-23. On limit-down mornings the CFD stops quoting until the cash market reopens (2020-03-16: no bar from Friday 15:54 ET until 09:46 ET). The 2-minute staleness rule therefore drops exactly the largest negative nights. SPX500 2020 close-to-close log sum is +887 bps, while the sum over the kept nights and days is +3,599 bps.

A post-hoc fallback (latest bar within 30 min before T, else the first bar within 29 min after T) keeps all 1,259 dev days. SPX500 dev night falls to +2.39 [-2.50,+7.02], night - day +0.99 [-6.20,+7.91], net +0.05. NAS100 and US30 dev night CIs also span 0 (+3.20 [-2.14,+8.41], +2.61 [-2.64,+7.33]). The 2023+ window has no skips and is unchanged. This sensitivity is not registered and does not change the verdict. It does mean the dev night CI > 0 is not robust.

### Secondary (never decides the verdict)
- NAS100: night +4.60 [+0.12,+9.10] dev, +4.96 [-0.30,+10.05] 2023+; night - day +2.13 dev, -2.15 2023+; net +2.29 / +3.07 bps (+5.8% / +7.7% a year), CIs span 0.
- US30: night +4.34 [+0.39,+8.30] dev, +0.08 [-3.56,+3.31] 2023+; night - day +3.90 dev, -4.76 [-10.43,+0.81] 2023+.
- Weekday vs weekend nights (SPX500): weekday +4.86 [+0.82,+8.81] dev, +2.61 [-1.49,+6.58] 2023+; weekend/holiday +0.94 [-8.52,+10.86] dev, +1.75 [-7.94,+10.71] 2023+. Net weekend nights are negative in both windows (-2.74, -1.54) because they carry three days of financing. The weekday dev CI > 0 survives the post-hoc fallback (+4.84 [+0.63,+9.33]); it does not replicate in 2023+.
- After an up day vs a down day (SPX500 night): +5.50 [+0.65,+11.07] vs +1.29 dev; +1.80 vs +3.20 2023+. The sign flips between windows. No continuation or reversal pattern.
- Yearly SPX500 night / day mean bps: 2018 +3.8/-6.6, 2019 +5.4/+5.8, 2020 +13.1/+2.6 (registered; +4.8/+3.2 with the fallback), 2021 +5.3/+4.5, 2022 -7.4/-0.0, 2023 -1.2/+9.8, 2024 +6.3/+2.9, 2025 +1.6/+5.2, 2026 +3.1/+3.6. Night beats day in 4 of 9 years.
- Long history: the tsmom36 daily database cannot split 16:00/09:30, because its daily bars close at 17:00 ET. No pre-2018 check is possible with local data.
- Caveat: CFD mid prices drop on ex-dividend opens and OANDA credits dividends in cash. Night returns here are understated by roughly the dividend yield (about 0.5 bps a night). This is far below the MDE.

### Reading
Over 2018-2026 the night and day halves of SPX500 earn similar amounts (about +2.4 to +4 bps a night, +1 to +5.5 bps a day). The published "all return accrues overnight" pattern does not show here. After spread and 3% financing, holding the CFD only overnight earns +0.5 to +1.7 bps a night with CIs spanning 0. That is less than holding through the day, which pays financing anyway.

Files: `data/research/engine/audit/night38/` night38.py, prereg_body.json, prereg.json, prereg_comment.md, result_comment.md, diag.py, posthoc.py, out/counts.json, out/results.json, out/report.txt, out/diag_spx.txt, out/posthoc/ (results.json, report.txt). trials.jsonl: 36 rows exp night38 (30 registered, 6 post-hoc).

Development evidence only. 2023+ is a development window, not a holdout.
