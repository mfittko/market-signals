## legs27 preregistration: chop and counter-legs (two operator claims)

This is registered before any outcome run. Nothing was computed on market data before the prereg. Only synthetic self-checks ran.

Files:
- `data/research/engine/audit/legs27/prereg.json` sha256 `57d356dea3a8ec2563ed367d4f226dd5a2a06a040b201eaa7af0ac4696fa4ca5`
- `data/research/engine/audit/legs27/legs27.py` sha256 `fda8d73e55ffc169eae67d96e394639e8c7d5a8af186ac3636050000b903c58b`
- Evaluator v2, digest `1b66053d`. The campaign imports `validate.day_boot` and `de_v2.supertrend` (via `nt12.frame`) unchanged.

### Common rules
- Instruments: WTICO_USD, XAU_USD, XAG_USD, EUR_USD, SPX500_USD, NATGAS_USD. Data: engine M1 bid/ask cache, cut at 2026-10-07T18:30 UTC.
- Primary metrics are GROSS (mid price). Latency is realistic: every outcome starts at the open of the bar after the condition is known.
- Net (bid/ask) is secondary and applies only to the H2 fade.
- Windows: dev 2018-01-01 to 2022-12-31; 2023+ to 2026-10-07. 2023+ is a development window, not a holdout. Earlier campaigns inspected it.
- Bootstrap: moving-block day bootstrap (`validate.day_boot`, block 5, 1000 reps, seed 27).
- ATR: the production supertrend ATR (`flips.mjs`, Wilder ATR(10)). The request said ATR14 and named the production ATR. The production ATR is used.

### H1: chop means no direction
- Timeframes: M5 primary. M1 and M15 secondary, with the same rules in bars of that timeframe.
- Measures at each closed bar t, over the last 12 bars (bars must be contiguous):
  - ER = |c_t - c_(t-12)| / sum |c_i - c_(i-1)| (mid closes).
  - Wick share = mean of (h - l - |c - o|) / (h - l). Bars with h = l are skipped.
  - Range-to-spread = median(h - l) / median(ask_c - bid_c).
- Quintile edges per instrument, timeframe and measure come from dev-window bars only. 2023+ uses the same edges.
- Outcome: move = mid open of bar t+1+N minus mid open of bar t+1, for N = 3, 6, 12. a = |move| / ATR_t.
  - Clear move: a >= 0.5. No direction: a < 0.25.
  - Continuation: sign(move) = sign(c_t - c_(t-12)). Signed continuation = sign(last 12 bars) x move / ATR.
- Primary: WTICO_USD M5 N=6. Three separate tests of P(clear) in the chop quintile minus P(clear) in the clean quintile:
  - ER: lowest minus highest quintile.
  - Wick share: highest minus lowest quintile.
  - Range-to-spread: lowest minus highest quintile.
- Decision rule: a measure PASSES if the 95% CI upper bound is < 0 in BOTH dev and 2023+. Each measure has its own verdict.
- Secondary (descriptive): P(no direction) difference, mean |move|/ATR, continuation rate and signed continuation per quintile. These answer whether chop predicts a reversal or only a lack of continuation. All instruments, M1, M15, N = 3 and 12.

### H2: a long leg, then a longer counter-leg
- Timeframe: M5 only.
- Session: the trading day of `validate.day_of` (22:00 UTC rollover), Mon-Fri keys. Session end = mid close of the last bar of that trading day.
- Daily ATR (DATR): mean of (day mid high - day mid low) over the previous 14 trading days with >= 50% of their bars. Strictly earlier days only.
- Leg (causal, fixed): up-leg_t = c_t - min(mid low of the last 48 bars of the same trading day). Down-leg_t = max(mid high of the same bars) - c_t.
- Events: for each L in {0.3, 0.6, 1.0} and each direction, the first closed bar per day with leg >= L x DATR. The next bar must be in the same day. For WTI, DATR is about 2.5-3% of price, so L is about 0.75%, 1.5% and 2.5%.
- Outcomes from P0 = mid open of the next bar, on mid closes to the session end:
  - race = 1 if a 50% retrace of the leg (from P0) comes before a 50% extension. Races unresolved at session end are excluded.
  - counter = 1 if the drawdown from the running extreme in the leg direction reaches the full leg size S before session end.
  - sess = signed move in the leg direction to the session-end close / DATR. Also +12 and +48 bars.
  - fade_net (secondary) = the opposite-side trade at bid/ask from the next bar open to the session-end close / DATR.
- Null: per event, 200 driftless paths of the same length, resampled from the event day's demeaned M5 close increments. The race and counter statistics are compared with the null per event. The signed-move null is 0.
- Primary: WTICO_USD M5 L = 0.6.
  - (a) mean (race - null race) has a 95% CI lower bound > 0 in BOTH windows.
  - (b) mean sess has a 95% CI upper bound < 0 in BOTH windows.
  - H2 PASS iff (a) and (b).
- Hindsight version, labelled separately and descriptive only: the same statistics on days whose close is within ±0.3% of the open. This selects on the day end. It shows how much of the impression comes from that selection.

Development evidence only. Any survivor is confirmed only by prospective data (https://github.com/mfittko/market-signals/issues/313) or by data after 2026-10-07.
