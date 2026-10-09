## abs48 result: FAIL (dev recall 0.45 < 0.5). The model still ranks the move that is left after the alert well.

Prereg: https://github.com/mfittko/market-signals/issues/310#issuecomment-6085081061. The run used the registered code (`abs48.py` sha256 `5d70def7...`) with no amendment. abs11 was imported unchanged. Run time 205 s. 56 rows in trials.jsonl (exp abs48).

The question comes from the [external audit, section 3](https://github.com/mfittko/market-signals/issues/307#issuecomment-6053046878). The success test now starts at the assessment time t. The alert counts from the first M1 bar at or after t + 5 min. PRIMARY success: the move from that price to the session end is at least the part of T1 that is still missing (T1 - excursion so far). SECONDARY success: that move is at least T1 / 2.

### Primary, pooled over six instruments, 2/month operating point (frozen on dev)

| | dev 2019-22 | 2023+ (dev window) |
|---|---|---|
| assessment rows / positive | 272,408 / 44,828 | 256,324 / 37,500 |
| LR AUC [95% CI] | 0.856 [0.846, 0.866] | 0.864 [0.854, 0.875] |
| rv baseline AUC | 0.807 | 0.815 |
| tod baseline AUC | 0.601 | 0.621 |
| already-moved (excursion so far / T1) AUC | 0.740 | 0.748 |
| alerts (per instrument-month) | 576 (2.00) | 693 (2.55) |
| big sessions / caught | 716 / 325 | 634 / 354 |
| recall of big sessions (>= 0.5) | **0.454 FAIL** | 0.558 ok |
| precision [Wilson CI] | 0.826 [0.793, 0.855] | 0.788 [0.756, 0.817] |
| row base rate (x2 needed) | 0.165 | 0.146 |
| precision on the abs11 label, same alerts | 0.566 | 0.518 |
| mean / median remaining excursion % at alerts | 3.66 / 2.54 | 3.51 / 2.60 |
| mean remaining excursion % all rows | 1.43 | 1.39 |
| median lead, alert to T1 crossing (big sessions) | 6.75 h | 6.6 h |
| share of those alerts after the crossing | 4.6% | 1.4% |

Pooled % values mix instruments with different T1 (NATGAS dominates); use the per-instrument table for magnitudes.

At 4/month: recall 0.66 / 0.72, precision 0.66 / 0.61, mean remaining 3.13% / 3.08%, median lead 9.0 h / 9.9 h. The 4/month point would pass the recall and precision tests in both windows. It was reported, not registered.

Secondary (T1 / 2 remaining): AUC 0.767 [0.757, 0.777] dev, 0.780 [0.772, 0.789] 2023+. The best baseline is rv 0.722 in dev and tod 0.752 in 2023+. Precision is 0.81 in both windows against row base rates of 0.28 / 0.27. Recall is 0.40 / 0.51. The already-moved score is below chance (0.48 / 0.45): an earlier move does not predict a fixed-size later move.

Open model (secondary AUC at 22:00 UTC, primary outcome): LR 0.784 dev, 0.834 2023+. The rv baseline scores 0.796 and 0.831. The open model adds nothing over rv.

### Per instrument (primary, 2/month)

| inst | window | LR AUC [CI] | rv | tod | moved | alerts (/mo) | big / caught | recall | precision | base | abs11-label prec | mean rem % alerts / all | median lead h | recall / prec at 4/mo |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| WTI | dev | 0.868 [0.845, 0.888] | 0.818 | 0.554 | 0.776 | 96 (2.0) | 121 / 63 | 0.52 | 0.84 | 0.15 | 0.66 | 7.28 / 2.18 | 5.7 | 0.74 / 0.72 |
| WTI | 2023+ | 0.906 [0.880, 0.923] | 0.856 | 0.522 | 0.791 | 80 (1.8) | 64 / 39 | 0.61 | 0.79 | 0.10 | 0.50 | 5.01 / 1.83 | 8.5 | 0.77 / 0.57 |
| XAU | dev | 0.808 [0.787, 0.832] | 0.710 | 0.582 | 0.721 | 96 (2.0) | 121 / 48 | 0.40 | 0.82 | 0.18 | 0.50 | 1.63 / 0.74 | 7.6 | 0.58 / 0.66 |
| XAU | 2023+ | 0.844 [0.827, 0.860] | 0.797 | 0.632 | 0.725 | 236 (5.2) | 192 / 129 | 0.67 | 0.83 | 0.25 | 0.56 | 1.93 / 0.84 | 6.4 | 0.81 / 0.69 |
| XAG | dev | 0.833 [0.811, 0.861] | 0.772 | 0.612 | 0.744 | 96 (2.0) | 126 / 54 | 0.43 | 0.83 | 0.17 | 0.56 | 3.62 / 1.40 | 5.2 | 0.64 / 0.66 |
| XAG | 2023+ | 0.843 [0.824, 0.864] | 0.782 | 0.622 | 0.723 | 220 (4.9) | 199 / 129 | 0.65 | 0.82 | 0.24 | 0.59 | 4.19 / 1.62 | 6.2 | 0.78 / 0.73 |
| NATGAS | dev | 0.849 [0.830, 0.865] | 0.806 | 0.661 | 0.720 | 96 (2.0) | 120 / 47 | 0.39 | 0.79 | 0.18 | 0.50 | 5.62 / 3.01 | 7.2 | 0.59 / 0.57 |
| NATGAS | 2023+ | 0.795 [0.769, 0.817] | 0.723 | 0.552 | 0.674 | 102 (2.3) | 82 / 37 | 0.45 | 0.69 | 0.14 | 0.36 | 5.55 / 3.02 | 9.0 | 0.62 / 0.45 |
| SPX500 | dev | 0.896 [0.880, 0.914] | 0.867 | 0.551 | 0.783 | 96 (2.0) | 112 / 60 | 0.54 | 0.87 | 0.15 | 0.63 | 2.86 / 0.97 | 6.6 | 0.73 / 0.71 |
| SPX500 | 2023+ | 0.881 [0.834, 0.917] | 0.825 | 0.482 | 0.826 | 21 (0.5) | 22 / 7 | 0.32 | 0.67 | 0.05 | 0.33 | 2.70 / 0.75 | 3.3 | 0.59 / 0.59 |
| EUR/USD | dev | 0.881 [0.863, 0.900] | 0.838 | 0.656 | 0.713 | 96 (2.0) | 116 / 53 | 0.46 | 0.80 | 0.16 | 0.55 | 0.96 / 0.36 | 8.8 | 0.70 / 0.64 |
| EUR/USD | 2023+ | 0.811 [0.787, 0.837] | 0.729 | 0.572 | 0.677 | 34 (0.8) | 75 / 13 | 0.17 | 0.71 | 0.12 | 0.38 | 0.88 / 0.34 | 7.4 | 0.45 / 0.47 |

The rule applied per instrument (not deciding): only WTI passes in both windows. Every instrument passes the AUC and precision tests in both windows. Recall fails on the other five.

### Verdict
FAIL under the registered rule. Pooled dev recall is 0.454 (325 of 716 big sessions), below 0.5. Precision (5.0x / 5.4x the base rate) and AUC (CI lower bound 0.846 / 0.854 above rv 0.807 / 0.815) pass in both windows.

### What differs from abs11
- Ranking survives the audit's correction. On the move left after a 5-min delay, LR AUC is 0.86 pooled and 0.80-0.91 per instrument. abs11 reported 0.78-0.90 on the from-open target. The already-moved score is the abs11 naive score; it reaches 0.74 here and stays well below the LR.
- Latency is not the issue. Only 1.4-4.6% of big-session alerts arrive after the session has already crossed T1. The median lead is 6.6-6.75 h.
- Alerts are followed by more movement. The mean remaining move at alerts is 2.3-3x the all-row mean on every instrument (WTI 7.3% vs 2.2% in dev).
- The 2023+ pooled recall pass comes from rate drift. A threshold frozen on dev fires 5.2/month on XAU and 4.9 on XAG, but 0.5 on SPX500 and 0.8 on EUR/USD. abs11 re-set its thresholds every quarter from trailing scores, so its rate stayed near target.
- POST-HOC reading (not registered): the primary outcome is two-sided from the alert price. It also counts a later reversal of the size of the missing part. Precision on "remaining move AND the session reaches T1 from the open" is 325/576 = 0.56 dev and 354/693 = 0.51 2023+. Precision on the abs11 label at the same alerts is 0.566 / 0.518. About 26 points of the 0.83 / 0.79 precision come from sessions that never became big days but still moved enough after the alert.

### Plain-language reading for the card
A "big-day chance" line based on this model would be honest about ranking. When it says high, a big further move is several times more likely than at a random time, and on average about 2.5x as much movement follows. The move usually starts hours after the alert (median 6-7 h), so the alert is early, not late. Three limits apply. At 2 alerts per month it catches fewer than half of the big days in dev. About half of its alerts precede a day that reaches T1 from the open; the rest precede a reversal or a smaller move. The probability is fitted to the from-open label, so any number shown must be labelled as a relative level (low / elevated / high), not a calibrated chance of the remaining move. The alert rate drifts across instruments unless the threshold is re-set on a schedule.

Possible follow-up (needs its own prereg): 4/month with abs11's quarterly trailing thresholds on the same remaining-move outcome, and a one-sided variant (the remaining move in the direction of the move so far).

Files: `data/research/engine/audit/abs48/` `abs48.py`, `prereg.json`, `prereg_comment.md`, `result_comment.md`, `out/result.json`, `out/log.txt`; trials.jsonl rows with exp `abs48`.
