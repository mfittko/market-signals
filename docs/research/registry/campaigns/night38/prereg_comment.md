## night38 preregistration: overnight drift in US stock index CFDs

This is registered before any outcome run. Only synthetic self-checks and availability counts ran. No return was computed.

Hypothesis (published, untested here): most of the long-run US stock index return accrues outside the cash session (Cliff, Cooper and Gulen 2008; Kelly and Clark 2011; Lou, Polk and Skouras 2019). Prior evidence here: imom34 found that the overnight return partly reverses in the last half hour of the next session (SPX500 r_on slope -0.058 [-0.107,-0.009] dev). cal37 found no calendar effect in daily index bars.

Files:
- `data/research/engine/audit/night38/prereg.json` sha256 `9768b8f9ac5f7cc53b5043e82c2f5bfc3e8c3abcd687059ef140d49c7f681eca`
- `data/research/engine/audit/night38/night38.py` sha256 `b362b1e39957a2f35fd51f2adea1eaed9e5653d4b63ccfe8717f7aa1ae00d669`
- Reused unchanged: `validate.day_boot` (`validate.py` sha256 `cb1642ed...`). Data: history.db `candles_ba` M1, read-only. Nothing fetched.

### Definitions
- Clock: America/New_York, DST per calendar date. P(T) is the mid close of the latest M1 bar that starts in [T-3, T-1] min. That is the bar ending at T, at most 2 minutes stale. Otherwise the point is missing.
- Trading days: NYSE weekdays minus full-day holidays, plus the closures on 2018-12-05 and 2025-01-09. The cash close is 16:00 ET. On early-close days (day after Thanksgiving, Dec 24 and Jul 3 when trading) it is 13:00 ET. The open is 09:30 ET.
- Day return: P(close_d) / P(open_d) - 1, in bps.
- Night return: P(open of the next trading day) / P(close_d) - 1, in bps, keyed by the close date d. Weekends and holidays span to the next trading open.
- A missing point drops only the returns that use it. There is no fallback further back.
- Net night: night minus half the median spread at the close and half the median spread at the next open (window medians), minus 3%/365 financing per calendar day spanned (three days over a weekend). Annualized = mean x 252.

### Test
- Windows by close date: dev 2018-01-02 .. 2022-12-31 and 2023-01-01 .. 2026-10-08. The 2023+ window is a development window, not a holdout.
- PRIMARY: SPX500, all nights. Mean night bps, mean day bps and night minus day. CIs from `validate.day_boot` over all trading days in the window (block 5, 1000 reps, seed 38).
- PASS if the night-mean CI lower bound is above 0 in BOTH windows AND the night-minus-day point estimate is above 0 in BOTH windows. Otherwise FAIL. This is one test, so there is no multiplicity adjustment.
- Availability (trading days / valid nights / valid days): SPX500 dev 1,259 / 1,253 / 1,252, 2023+ 944 / 944 / 944; NAS100 dev 1,259 / 1,253 / 1,253, 2023+ 944 / 943 / 943; US30 dev 1,259 / 1,253 / 1,252, 2023+ 944 / 944 / 944. Weekend/holiday nights: 273 dev, 208 2023+.
- Secondary results never decide the verdict: net night bps and annualized; hit rate; NAS100 and US30; weekday vs weekend/holiday nights; nights after an up day vs a down day; yearly means; MDE80 = 2.8 x bootstrap SD.
- A long-history check on the tsmom36 daily database is impossible for this split, because its daily bars close at 17:00 ET.

This is development evidence only. Any survivor needs prospective confirmation (https://github.com/mfittko/market-signals/issues/313) or data after 2026-10-07.
