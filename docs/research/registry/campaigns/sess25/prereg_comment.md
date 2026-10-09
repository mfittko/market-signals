## sess25 preregistration: session-level breakouts split by tick volume

This is registered before any outcome run. Nothing was computed on market data before the prereg. Only synthetic self-checks ran.

Files:
- `data/research/engine/audit/sess25/prereg.json` sha256 `6a43ea757e3bece54559db6e0e6ff3d560215ee554d34c4665d47591ee435753`
- `data/research/engine/audit/sess25/sess25.py` sha256 `b8d2fb15f2a3d22028fe8f1d9b34b53cf584a1cebca28ed5aa9a200c78fe5a32`
- Evaluator v2, digest `1b66053d`. The campaign imports `dt14.range_sim` (which calls `fills.resolve`, stop first) and `validate.day_boot` unchanged.

### Scope
- Instruments: WTICO_USD, XAU_USD, XAG_USD, EUR_USD, SPX500_USD, NATGAS_USD.
- Timeframes: M5 is primary. M1 is secondary and uses the same rules, with horizons counted in M1 bars.
- Data: the engine M1 bid/ask cache, cut at 2026-10-07T18:30 UTC. Tick volume is the OANDA candle volume summed per bar.

### Clock (UTC, DST-aware via zoneinfo)
- Trading day: `validate.day_of`, which rolls over at 22:00 UTC. Mon-Fri calendar dates only.
- Asia range: mid high and mid low of the bars that start in 00:00-07:00 UTC. This equals Tokyo 09:00-16:00, and Japan has no DST. The range is valid only if at least 80% of its bars exist.
- Break window: from 08:00 Europe/London to 17:00 America/New_York on the same date. This covers the London and New York sessions. It is 07:00/08:00 to 21:00/22:00 UTC, depending on DST.
- Prior trading day: mid high and mid low of the most recent earlier trading day that has at least 50% of its bars.

### Events
- E1 `asia`: the first bar in the break window whose mid close is above the Asia high while the previous close was not (long). Separately, the first close below the Asia low (short).
- E2 `pday`: the same rule, with the prior trading day high and low as the levels.
- Only the first break per level per day counts.

### Volume split
- ratio = break-bar tick volume / median tick volume of the same UTC minute-of-day slot over the previous 20 occurrences. Only strictly earlier days count, and all 20 are required.
- HIGH-VOL if ratio >= 2.0. Otherwise QUIET. An event without a ratio is excluded.

### Trade
- Entry is at the open of the bar after the break bar, in the break direction.
  - Gross fills at the mid open. This is the primary measure (operator decision).
  - Net fills long at the ask and short at the bid. This is secondary.
- Stop: entry -/+ 1.5 ATR at the break bar. This is the harness stop (`labels_v2` POLICY k), so R = 1.5 ATR. There is no target.
- Exit at the open of bar entry + h, for h = 3, 6, 12 bars.
- No spread filter. The operator carries the spread risk.

### Metrics
- Per instrument x TF x event x volume class x window:
  - n
  - gross mean R [95% CI]
  - continuation rate, defined as gross R > 0 [CI]
  - net mean R [CI] at 3, 6 and 12 bars
- Bootstrap: day-block (`validate.day_boot`, block 5, 1000 reps, seed 25). MDE = 2.8 x SE.
- Random-side null at 6 bars.
- HIGH-VOL minus QUIET difference [CI].

### Windows
- dev: 2018-01-01 to 2022-12-31.
- 2023+: 2023-01-01 to 2026-10-07. This is a development window, not a holdout. Earlier campaigns inspected it.

### Primary test and decision rule
- Primary: WTICO_USD, M5, HIGH-VOL, gross mean R at 6 bars. E1 and E2 are tested separately.
- An event passes if both conditions hold in both dev and 2023+:
  - the 95% CI lower bound is > 0;
  - the Holm-adjusted (2 events) one-sided bootstrap p (mean <= 0) is < 0.05.
- The campaign verdict is PASS if any event passes.
- Reported descriptively:
  - all other instruments;
  - M1;
  - the 3- and 12-bar horizons;
  - net results;
  - HIGH-VOL minus QUIET.
- Base rates for a later card line go to `out/base_rates.json`. Keys are `<INST>_<TF>_<event>_<vol>`, with n and continuation at 3/6/12 bars with CI over 2018-2026.

Development evidence only. Any survivor is confirmed only by prospective data (https://github.com/mfittko/market-signals/issues/313) or by data after 2026-10-07.
