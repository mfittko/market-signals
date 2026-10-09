## legs27 result: H1 FAIL (all three chop measures), H2 FAIL

The prereg was posted before any outcome run: https://github.com/mfittko/market-signals/issues/310#issuecomment-6061778970. The code and prereg hashes are unchanged since registration (`legs27.py` `fda8d73e`, `prereg.json` `57d356de`). No amendments. 2023+ is a development window, not a holdout. All primary metrics are gross (mid) with entry at the next bar open.

### H1: chop means no direction
Primary: WTICO_USD M5, N = 6 bars. P(clear move) = P(|move| >= 0.5 ATR). Chop minus clean quintile, predicted < 0.

| measure (chop vs clean) | dev 2018-22 | 2023+ | pass |
|---|---|---|---|
| ER lowest vs highest | -0.005 [-0.011, +0.001] | +0.005 [-0.002, +0.012] | no |
| wick share highest vs lowest | +0.003 [-0.004, +0.010] | +0.009 [+0.002, +0.017] | no (2023+ wrong sign) |
| range-to-spread lowest vs highest | +0.022 [+0.015, +0.029] | +0.029 [+0.023, +0.037] | no (wrong sign, both windows) |

WTI M5 N=6 per quintile, P(clear) / P(no direction) (Q1 = lowest value of the measure; ~65k bars per quintile in dev, ~40-66k in 2023+):

| measure | window | Q1 | Q2 | Q3 | Q4 | Q5 |
|---|---|---|---|---|---|---|
| ER | dev | 0.721 / 0.143 | 0.720 / 0.142 | 0.722 / 0.143 | 0.722 / 0.140 | 0.726 / 0.140 |
| ER | 2023+ | 0.739 / 0.133 | 0.735 / 0.135 | 0.735 / 0.134 | 0.730 / 0.137 | 0.734 / 0.138 |
| wick | dev | 0.723 / 0.143 | 0.719 / 0.143 | 0.721 / 0.142 | 0.723 / 0.140 | 0.726 / 0.140 |
| wick | 2023+ | 0.730 / 0.139 | 0.732 / 0.136 | 0.739 / 0.132 | 0.736 / 0.135 | 0.739 / 0.134 |
| range/spread | dev | 0.737 / 0.133 | 0.723 / 0.143 | 0.724 / 0.140 | 0.714 / 0.146 | 0.715 / 0.147 |
| range/spread | 2023+ | 0.750 / 0.128 | 0.728 / 0.138 | 0.738 / 0.134 | 0.733 / 0.137 | 0.721 / 0.142 |

The quintiles are flat to within about 2 percentage points on a base rate of about 72%. Note that a 0.5 ATR move in 6 M5 bars is the normal case, so "clear move" is a low bar under this prereg.

Reversal or lack of continuation (WTI M5 N=6). P(next move has the sign of the last 12 bars) is 0.47-0.50 in every quintile. Low ER does not predict a reversal: P(cont) is 0.499 in the lowest ER quintile vs 0.472 in the highest (dev), and 0.500 vs 0.493 (2023+). If anything, the clean 12-bar trends revert slightly more often. Signed continuation in the chop quintile is within ±0.04 ATR of 0 for all three measures.

Per-instrument summary (descriptive, chop minus clean P(clear)):
- ER: at N = 3, low ER has 1-2.5 points fewer clear moves on XAU, XAG, EUR/USD and NATGAS in both windows (WTI and SPX500 in dev only). The effect fades by N = 6 and is gone by N = 12. M1 shows the same N = 3 pattern. M15 shows it only for XAU at N = 3.
- Wick share: the sign changes with the instrument and window. NATGAS is the only consistent case: about 3 points fewer clear moves in the top wick quintile at every N, in both windows, on M1, M5 and M15.
- Range-to-spread: the opposite of the claim on all 6 instruments, all timeframes, both windows (+1 to +12 points). This is partly mechanical. The outcome is in ATR units, and the ATR shrinks in quiet, low-range stretches.

Verdict H1: FAIL on all three measures. In ATR units, chop as measured here does not reduce the chance of a clear move over the next 30 minutes on WTI M5. It does not predict a reversal either.

### H2: a long leg, then a longer counter-leg
Leg = close minus the extreme of the last 48 M5 bars of the same trading day. L is in units of the prior 14-day daily ATR (DATR). race = P(50% retrace before 50% extension, from the next bar open). Null for the race = driftless resampled same-day increments. sess = signed move in the leg direction to session end, in DATR (negative = reversal).

| inst | L | window | n (resolved) | P(race) vs null | race - null [CI] | sess [CI] |
|---|---|---|---|---|---|---|
| WTI | 0.3 | dev | 2400 (2302) | 0.510 vs 0.498 | +0.012 [-0.007, +0.031] | +0.005 [-0.005, +0.014] |
| WTI | 0.3 | 2023+ | 1824 (1762) | 0.499 vs 0.498 | +0.001 [-0.023, +0.025] | +0.001 [-0.010, +0.013] |
| WTI | 0.6 (primary) | dev | 1159 (787) | 0.503 vs 0.496 | +0.007 [-0.028, +0.042] | -0.014 [-0.035, +0.006] |
| WTI | 0.6 (primary) | 2023+ | 872 (607) | 0.501 vs 0.499 | +0.002 [-0.035, +0.043] | +0.018 [-0.008, +0.042] |
| WTI | 1.0 | dev | 267 (121) | 0.463 vs 0.506 | -0.043 [-0.139, +0.048] | -0.022 [-0.079, +0.039] |
| WTI | 1.0 | 2023+ | 192 (91) | 0.462 vs 0.508 | -0.046 [-0.151, +0.068] | +0.041 [-0.031, +0.109] |

Hindsight version (labelled; selects days that closed within ±0.3% of the open; descriptive only):

| inst | L | window | n (resolved) | P(race) vs null | race - null [CI] | sess [CI] |
|---|---|---|---|---|---|---|
| WTI | 0.3 | dev | 343 (324) | 0.552 vs 0.494 | +0.059 [-0.001, +0.122] | -0.054 [-0.068, -0.040] |
| WTI | 0.3 | 2023+ | 195 (180) | 0.539 vs 0.500 | +0.039 [-0.036, +0.113] | -0.063 [-0.083, -0.041] |
| WTI | 0.6 | dev | 136 (91) | 0.824 vs 0.494 | +0.330 [+0.235, +0.410] | -0.226 [-0.253, -0.192] |
| WTI | 0.6 | 2023+ | 72 (46) | 0.674 vs 0.500 | +0.174 [+0.027, +0.338] | -0.160 [-0.201, -0.120] |
| WTI | 1.0 | both | < 20 events | | | |

Other instruments (L = 0.6, all days): race - null spans 0 in both windows for XAU, XAG, EUR/USD and SPX500. NATGAS leans the other way (dev -0.033 [-0.065, -0.001]), with a positive drift to session end in dev (+0.024 [+0.003, +0.046]). The hindsight subset shows race - null of +0.17 to +0.33 and sess of -0.16 to -0.23 DATR on every instrument. Those numbers come from the selection on the day end, not from the leg.

P(counter-leg >= leg before session end) exceeds the null on most cells (WTI L 0.6: +0.074 dev, +0.052 2023+, both CIs above 0). The symmetric race shows no asymmetry, so this is most likely higher volatility after a long leg than the day's average (volatility clustering). It is not a directional reversal. Net fade (secondary, bid/ask, entry at the next bar open, exit at session end) is negative in almost every all-days cell (WTI L 0.6: -0.008 dev, -0.034 2023+ DATR).

Verdict H2: FAIL. (a) race - null spans 0 in both windows. (b) the signed move to session end spans 0 in both windows, with opposite signs. On days you cannot select in advance, a long leg is followed by a 50/50 race and no mean reversal to the close. The impression of "long leg, then longer counter-leg" appears in full only when you select days that ended flat.

### Files
- `data/research/engine/audit/legs27/` (legs27.py, prereg.json, summarize.py, out/results.json sha256 `353a052d`, out/report.txt)
- 390 trial rows in `trials.jsonl` (exp `legs27`).

Development evidence only. Nothing qualified.
