## abs48 preregistration: abs11 A1 big-day alert scored on the move that is still ahead

This is registered before any outcome run. Only synthetic self-checks ran. No remaining-move outcome, score or alert was computed.

Question: the external audit ([review, section 3](https://github.com/mfittko/market-signals/issues/307#issuecomment-6053046878)) asks that the excursion start at the assessment time, that notification latency is included, and that the remaining move after the alert is reported. abs11 A1 measured the session excursion from the session OPEN. A move that already happened could make a late alert count as a success. abs48 rescores the same abs11 model on the move after the alert.

Files:
- `data/research/engine/audit/abs48/prereg.json`
- `data/research/engine/audit/abs48/abs48.py` sha256 `5d70def7b9b5296db4411c8a1b45bd7a21a1650f96e67f2a40b881f7a70387ab`
- Reused unchanged by import: `audit/abs11/abs11.py` sha256 `21228f08...` (same hash as the abs11 registration), `bars.py` `433b9687...`. Data: abs11's cached 30-min mid bars, history.db M1 bid/ask (read-only). Nothing fetched.

### Reused from abs11
- Sessions roll at 22:00 UTC; valid session >= 8 30-min bars. T1 per instrument from the abs11 prereg (WTI 5.38%, XAU 1.82%, XAG 3.53%, NATGAS 7.19%, SPX500 2.48%, EUR/USD 0.94%).
- Features, the A1 intraday population (every 30-min close while the session excursion so far is below T1), and the quarterly walk-forward A1 logistic regression with its rv and tod baselines. These are fitted by `abs11.walk` exactly as in abs11, on the abs11 big-day label. Nothing is refitted to the new outcome.
- The session open (abs11 open model) gets a secondary AUC only. abs11's alerts used the intraday model only.

### New outcome
- Latency L = 5 min. The alert counts from the mid open of the first M1 bar opening at or after t + 5 min in the same session. If no bar is left in the session, the remaining move is 0 and the alert fails.
- M_rem = max over M1 bars from that bar to the session end of max(high / P - 1, 1 - low / P), mid, in %.
- PRIMARY: Y_rem = 1 when M_rem >= T1 - (session excursion already realised at t). The alert must still have the rest of a big day ahead.
- SECONDARY: Y_rem = 1 when M_rem >= T1 / 2 (a meaningful remaining move regardless of the past).

### Operating point
- One threshold per instrument on the A1 probability. It is the (2 x dev months)-th largest per-session maximum score over dev 2019-2022 rows. It is frozen and applied unchanged to 2023+. The alert is the first row per session at or above the threshold. 2/month is registered; 4/month is reported.
- Windows: dev 2019-2022; 2023+ (development window, not a holdout).

### Metrics
- AUC of the LR vs baselines on the outcome over all alert-stream rows, day-cluster bootstrap 95% CI (200 reps, seed 48). Pooled over the six instruments with the session day as the cluster.
- Baselines: abs11 rv LR, abs11 tod LR, and already-moved = realised excursion so far / T1. The already-moved score is the same as abs11's naive A1 score, so it is reported once.
- Precision = share of alerts with Y_rem = 1. Base rate = share of all alert-stream rows with Y_rem = 1 (a randomly timed alert). The big-session share is also reported.
- Recall: big sessions are valid sessions whose excursion from the open reaches T1 (abs11 definition, all valid sessions, including ones that crossed before any assessment). A big session is caught when it has an alert with Y_rem = 1.
- Mean and median remaining excursion % at alerts vs all rows. Lead time from t + 5 min to the end of the first M1 bar where the session reaches T1 (big sessions with an alert), and the share of those alerts that came after the crossing.
- Precision on the abs11 label at the same alerts, for the comparison.
- Monitoring population: all valid sessions. No spread or R entry filter.

### Decision rule
PASS for silent shadow logging (not promotion; [issue 313](https://github.com/mfittko/market-signals/issues/313) rules still apply) iff, on the PRIMARY outcome, pooled over the six instruments, in BOTH windows at 2/month: recall of big sessions >= 0.5, precision >= 2 x the row base rate, and the LR AUC CI lower bound above the best baseline's pooled point AUC. Per-instrument results are reported and do not decide. Otherwise FAIL.

Budget: 6 instruments, 2 outcomes, 2 rates, 1 model, 3 baselines, 1 latency value, 0 tuned hyperparameters.
