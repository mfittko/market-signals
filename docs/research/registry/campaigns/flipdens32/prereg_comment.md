## flipdens32 preregistration: does recent flip density before a supertrend flip predict whether that flip pays off?

This is registered before any outcome run. Nothing was computed on market data for this design before the prereg. Only synthetic self-checks ran.

Operator question: flipday30 showed in hindsight that flips on quiet days earn +0.20..+0.43 R gross and flips on choppy days lose, but the 07:00 UTC day-level prediction failed. This test uses an intraday, rolling, causal look-back at every flip instead.

Files:
- `data/research/engine/audit/flipdens32/prereg.json` sha256 `7f13023c2e0830005b71b53d67091fbd013c8bfd894b1313d453721bdeae0d23`
- `data/research/engine/audit/flipdens32/fd32.py` sha256 `7ec8df7a71ea304a7f28eb1496ea1a3d84d89d563bc408dbc5829e1066ee2468`
- Evaluator v2, digest `1b66053d`. Trade rule, day table and bootstrap are imported unchanged from flipday30 (`fd30.day_counts`, `fd30.features`, `nt12.frame`, `labels_v2.simulate`, `x_recompute.mid`, `validate.day_boot`).

### Trade rule (flipday30, unchanged, every flip at all hours)
- Every supertrend flip (production supertrend, ATR 10) with finite ATR, on flipday30 valid days.
- `labels_v2.simulate` POLICY k=1.5, m=1.0, T=3.0, H=72. Entry at the next bar open. Stop 1 R, breakeven at +1 R, target 3 R, exit at the next open after an opposite flip, time stop 72 bars.
- Gross on mid bars (primary). Net on bid/ask (secondary).
- The flipday30 pickles keep only post-07:00 trades without timestamps. The frames are rebuilt with the same functions. The build asserts that its post-07:00 subset equals the flipday30 trades exactly.

### Feature (causal)
- For flip bar i opening at t_i: c_H = number of flip bars that opened in [t_i - H hours, t_i), so only closed bars strictly before bar i. H in {1, 3, 6}.
- Normalized, for every row: x_H = (c_H + 1) / (m_H + 1). m_H is the median, over the previous 20 open occurrences of the same UTC clock hour (about 20 trading days), of the flip count in the H hours before that hour's start. The current occurrence is excluded. With fewer than 20 earlier occurrences x_H is missing and the flip is not scored. No raw-count fallback.
- Quintiles: for a flip on valid day d, edges = 20/40/60/80% quantiles of x_H over all scored flips on the previous 250 valid days (strictly before d). A tie at an edge goes to the lower bin, so bin shares can deviate from 20%. Counts are reported.

### Primary and pass rule
- WTI M5. For each H, per window: D_low = gross mean R of the lowest-density quintile minus gross mean R of all scored flips.
- Day-block bootstrap: `validate.day_boot`, block 5, 1000 reps, seed 32. One-sided p = (1 + #reps with D_low <= 0) / 1001. Holm over the three H values per window.
- PASS iff for at least one H, in BOTH dev (2018-2022, scoring starts after the 250-day burn-in) and 2023+ (to 2026-10-07): Holm-adjusted one-sided p < 0.025 (the Holm-adjusted 95% CI excludes 0 upward) AND the low-quintile gross mean R > 0. Otherwise FAIL.
- 2023+ is a development window, not a holdout. Binding confirmation is prospective (https://github.com/mfittko/market-signals/issues/313) or post-2026-10-07 data.

### Key secondary (never decides the verdict)
- D_high = highest-density quintile minus all, as a "chop, skip this flip" veto candidate. Point estimate, 95% CI, Bonferroni-3 CI, one-sided p(D_high < 0) with Holm over H, both windows.

### Other secondary (descriptive, never decides the verdict)
- Net (bid/ask) per quintile; trade counts and gross per quintile; the other five instruments (XAU, XAG, NATGAS, SPX500, EUR/USD); M15. M1 is not run: no flipday30 M1 frames exist.
- Time-of-day confound check: the primary repeated with quintile edges computed within UTC hour-of-day buckets (same 250-day trailing rule).
- Power: MDE80 = 2.8 x bootstrap SD of D.
