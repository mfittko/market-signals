## imom34 result: FAIL (market intraday momentum does not hold on SPX500 M1)

Prereg: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077992431 (code unchanged since registration, no amendment).

### Primary: SPX500, s = sign(r_on + r1), last half hour 15:30-16:00 ET

| window | days | gross bps [95% CI] | gross R [CI] | net bps [CI] | hit | MDE80 bps |
|---|---|---|---|---|---|---|
| dev 2018-2022 | 1,207 | -1.87 [-3.71, -0.05] | -0.15 [-0.29, -0.02] | -3.06 [-4.90, -1.26] | 0.476 | 2.71 |
| 2023+ (dev window) | 930 | +0.59 [-0.82, +2.07] | +0.04 [-0.09, +0.17] | -0.09 [-1.49, +1.38] | 0.499 | 2.08 |

Verdict: FAIL. The CI lower bound is below 0 in both windows. In 2018-2022 the rule loses with a CI below 0, so the sign runs against the paper there. R = median |last-half-hour move| over the previous 60 valid days (median 15.4 bps dev, 10.3 bps 2023+). Skipped days dev / 2023+: 80 / 41 for missing bars (holidays, half days, gaps) and 4 / 1 for no previous close.

### Secondary (never decides the verdict)
- Regression on SPX500, y on (r_on, r1): the r_on slope is -0.058 [-0.107, -0.009] in dev, so the overnight move partly reverses in the last half hour. The r1 slope is +0.008 [-0.094, +0.122] dev and -0.004 [-0.068, +0.071] 2023+. R2 is 0.017 dev and 0.001 2023+. The paper's first-half-hour effect is absent.
- The 12th half hour (15:00-15:30) predicts the last half hour in dev: sign(r12) earns +2.17 bps [+0.27, +3.99] and the slope is +0.175 [+0.016, +0.297]. In 2023+ it is -0.57 bps [-1.98, +0.86] and slope -0.007 [-0.130, +0.111]. It does not replicate.
- sign(r1) alone: -1.14 dev, -0.07 2023+ (both CIs span 0). on1 when r12 agrees: +0.35 dev, -0.04 2023+.
- Conditioning on SPX500 (paper reports stronger effects): |r1| top tercile -3.29 [-7.12, +0.31] dev, -1.80 [-4.74, +1.29] 2023+. High first-half-hour volatility -3.46 [-7.59, +0.55] dev, +0.97 [-2.83, +4.59] 2023+. No support.
- Other instruments, on1 gross bps dev / 2023+ (own sessions): WTI +0.18 / -1.84; XAU +0.52 / +0.09; XAG +1.72 / -0.54; NATGAS +2.07 / +1.93; EUR/USD +0.20 / +0.17. No CI clears 0 in either window. Net is negative everywhere (WTI -5.2 / -6.1, NATGAS -17 / -20, XAG -7.5 / -7.0, XAU -2.2 / -1.5, EUR/USD -2.2 / -1.6).
- Isolated CIs above 0 with no replication across windows: XAU and XAG r_on slope in dev (+0.026, +0.041); EUR/USD r1 in 2023+ (+0.33 bps, about 0.2 R); WTI on1 on high-volatility days in 2023+ is negative (-7.4 [-13.9, -1.3]). With about 120 secondary cells (96 trade cells plus regression slopes), a few such CIs are expected by chance.
- Power: the SPX500 MDE80 is 2.1-2.7 bps (about 0.15-0.2 R). A gross effect of that size would be detected with 80% power in each window. The 2023+ CI upper bound is +2.07 bps, so any effect left on this data is below about 0.2 R gross and would not cover the spread.

### Files
- `data/research/engine/audit/imom34/imom34.py`, `prereg_body.json`, `prereg.json`, `summarize.py`, `prereg_comment.md`, `result_comment.md`
- `data/research/engine/audit/imom34/out/results.json`, `report.txt`, `counts.json`, `run.log`
- 96 rows in `data/research/engine/trials.jsonl` (exp imom34)

This is development evidence only. 2023+ is a development window, not a holdout.
