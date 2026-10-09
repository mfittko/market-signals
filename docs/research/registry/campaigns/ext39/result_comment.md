## ext39 result: continuation or reversal after an extreme daily move (33 daily markets pooled)

Prereg: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078544479 (prereg.json sha256 `02e41df4...`, ext39.py sha256 `ebe6e14b...`, unchanged for the run).

### Verdict: FAIL

The primary mean is positive (continuation) in both windows, but neither CI excludes 0. The 2023+ window cannot detect an effect below about 0.38 sigma.

### Primary: threshold 2.5, h = 3, entry at the event close (17:00 NY), all 33 markets pooled

| Window | n events (weeks) | Mean signed move, sigma [95% CI] | Gross bps [CI] | Hit rate | Net bps [CI] | MDE80 sigma |
|---|---|---|---|---|---|---|
| dev 2005-2022 | 3,272 (763) | +0.116 [-0.022, +0.261] | +8.0 [-6.4, +23.2] | 0.521 | +0.1 [-14.3, +15.5] | 0.21 |
| 2023-01..2026-10 | 625 (161) | +0.034 [-0.227, +0.301] | +4.3 [-25.6, +35.7] | 0.480 | -3.7 [-33.8, +27.5] | 0.38 |

Event counts (threshold 2.5, dev / 2023+): FX 992 / 200, indices 829 / 133, commodities 1,110 / 228, bonds 341 / 64. Up 1,466 / 288, down 1,806 / 337.

Power: the realized MDE80 (0.21 and 0.38 sigma) is about twice the ex-ante estimate. The 3-day outcome SD is 2.5-2.7 sigma_t, because volatility rises after the event, and week clustering costs further power.

### Secondary (never decides the verdict)

- Horizons, pooled: h = 1 +0.015 / +0.068; h = 5 +0.126 / +0.195; h = 10 +0.124 / -0.030 sigma (dev / 2023+). No CI excludes 0.
- Thresholds, h = 3 pooled: 2.0 +0.079 [-0.007, +0.170] / -0.021; 3.0 +0.154 / +0.026. No CI excludes 0.
- Entry at the next close, h = 3: +0.150 [-0.003, +0.313] dev, +0.031 [-0.313, +0.387] 2023+.
- Up vs down events, h = 3: up +0.088 / -0.007, down +0.139 / +0.070. There is no index crash-rebound pattern: index down events -0.019 dev, -0.685 [-1.516, +0.239] 2023+ (n 84).
- Asset class, h = 3 (dev / 2023+): FX +0.164 / +0.020; indices -0.047 / -0.481 [-1.074, +0.149]; bonds +0.012 / +0.463; commodities +0.227 [+0.046, +0.409] / +0.227 [-0.139, +0.635].
- Commodities show continuation at every horizon in dev: h = 1 +0.100, h = 3 +0.227, h = 5 +0.255 [+0.022, +0.466], h = 10 +0.295 [+0.020, +0.581]. At h = 5 the CI also clears 0 in 2023+: +0.451 [+0.018, +0.853] (n 227), net +14 / +64 bps. Per commodity in the primary cell (dev): WTI +0.51, WHEAT +0.48, XAU +0.31, XPT +0.31, NATGAS +0.30, XAG +0.27, BCO +0.27, XCU +0.24, CORN -0.11, SUGAR -0.04, SOYBN -0.03. This cell is one of 720 and was not the registered test. It is a candidate for a separate prereg with prospective data only.
- Indices lean toward reversal in 2023+ only (h = 3 -0.481, h = 10 next-close down events -1.707 [-3.076, -0.076], n 83). Dev does not show it.
- Grid count: 57 of 720 cells have a CI that excludes 0 (52 positive, 5 negative). About 36 are expected by chance, and the cells are strongly correlated. 22 of the 57 are in 2023+, mostly bond cells with n 21-64.
- Costs: half-spread per side plus 0.822 bps per calendar night take about 8 bps from a 3-day hold. Net is about 0 in dev and negative in 2023+.

POST-HOC (not registered): the dev mean depends on 2020 (yearly mean +1.03 sigma; other years -0.37 to +0.38, 11 of 18 positive). The largest outcomes are crisis events (JP225 2011-03-11, March 2020 indices and XAG). Winsorizing at 1%/99% gives +0.111 [-0.017, +0.245] dev and +0.033 [-0.229, +0.295] 2023+. The 2023+ median is -0.078 sigma.

### Files (data/research/engine/audit/ext39)
- `ext39.py` (check / describe / register / run), `prereg_body.json`, `prereg.json`, `prereg_comment.md`, `result_comment.md`
- `out/describe.json` (event counts), `out/results.json` (720 cells, per-instrument primary means, verdict), `out/posthoc.json` (tails, winsorized means, years)
- `posthoc.py` (POST-HOC diagnostics)
- 720 rows in `trials.jsonl` (exp `ext39`)

This is development evidence only. Any follow-up on commodity continuation needs prospective confirmation (https://github.com/mfittko/market-signals/issues/313) or data after 2026-10-07.
