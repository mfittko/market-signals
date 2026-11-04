# Calendar and seasonality

Question: do clock and calendar effects (hours, weekdays, month turns, holidays, central-bank days, overnight) earn a premium after costs?

Answer: no effect passed. Some point estimates are positive, but none holds in both windows with an interval above 0. Several are underpowered.

## Results

| Campaign | Effect | Result |
|---|---|---|
| [season17] | Hour-of-day and weekday drift, 9 instruments, select on 2018-20, validate on 2021-22 | 35 windows had t above 2 in selection (about 19 expected by chance). The sign held for 53% of candidates in validation. 2 of 27 selected windows survived, the same as random selection (2.01). Hourly drifts of 0.03 to 0.05 R would have been detectable. The Monday short reversed in 2023+. |
| [cal37] | Turn of the month (8 indices) | +0.9 bps per day [-7.1, +8.2] dev, +1.1 [-11.8, +14.2] 2023+. |
| [cal37] | Pre-FOMC (SPX500) | +24.8 bps [+3.8, +46.7] dev, Holm p 0.060, driven by 2007-12, 2020 and 2022; -14.9 bps 2023+. |
| [cal37] | Pre-holiday (SPX500) | +10.2 bps [-4.2, +24.3] dev; positive in 16 of 16 index cells, but MDE80 is 20 to 27 bps. Underpowered. |
| [night38] | Overnight drift (SPX500 primary) | Night +4.01 bps [+0.23, +7.94] dev, +2.42 [-1.70, +6.09] 2023+. Night minus day not positive in both windows. Net about +1.7 and +0.5 bps, CIs spanning 0. Night beats day in 4 of 9 years. |
| [imom34] | First half hour plus overnight predicts the last half hour (SPX500) | -1.87 bps [-3.71, -0.05] dev, +0.59 [-0.82, +2.07] 2023+. |
| [orb15] | EIA Wednesday window (WTI) | Published sign in dev, reversal in 2023+. |

## Interpretation

- Selecting the best calendar windows from many candidates produces winners that do not validate. season17 shows this directly: the survivors match what random selection keeps.
- Some effects may be real but too small for CFD costs and our sample: pre-holiday (16 of 16 cells positive, underpowered) and overnight (positive gross in dev).
- The weekday SPX/NAS regular-session Monday long was gross-positive in both windows post-hoc. It would need its own registration ([season17]).

## External evidence

The overnight effect (Cliff, Cooper and Gulen 2008; Kelly and Clark 2011; Lou, Polk and Skouras 2019) and market intraday momentum (Gao, Han, Li and Zhou 2018) are published. Our CFD tests do not support them net of costs. Treat them as grade C for other vehicles and as rejected for these CFDs.

<!-- campaign link definitions -->
[cal37]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078391261
[imom34]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078006875
[night38]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078494080
[orb15]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054798153
[season17]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6055192654
