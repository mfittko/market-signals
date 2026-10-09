## cmd41 result: FAIL. The ext39 commodity continuation does not replicate on 10 new CME commodities

Preregistration: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078874337 (prereg.json sha256 `c4e96738...`, posted before the outcome run). Data: Databento GLBX.MDP3 ohlcv-1d, volume-ranked front month HO, RB, PA, LE, HE, ZL, ZM, KE, ZO, GF, 2010-06..2026-10-08, billed $0.43 once. Bars are UTC-day aggregates, not settlements; entry "at the close" is the last trade before 00:00 UTC. Development evidence only.

### Primary (threshold 2.5, h = 5, entry at the event close, 10 markets pooled)

| Window | Events | Roll drops | n | Mean sigma [95% CI] | Gross bps | Hit | Net CFD bps [CI] | Net futures bps | MDE80 sigma |
|---|---|---|---|---|---|---|---|---|---|
| dev 2010-06..2022 | 595 | 89 | 506 | +0.154 [-0.164, +0.480] | +24.0 | 0.49 | +14.1 [-35, +65] | +20.0 | 0.46 |
| 2023-01..2026-10 | 183 | 34 | 149 | -0.058 [-0.508, +0.421] | -22.3 | 0.50 | -32.2 [-107, +42] | -26.3 | 0.64 |

Verdict: FAIL. Neither lower bound is above 0. The 2023+ point estimate has the wrong sign. Power is low: MDE80 is 0.46 / 0.64 sigma, above ext39's commodity estimates (+0.255 / +0.451). This result cannot rule out an effect of ext39's size. It gives no support for one either.

Roll handling: a contract change from t-1 to t removes that return from sigma and from event detection. 123 of 778 h = 5 outcomes spanned a roll and were dropped (RB 24, HO 16, LE 16; PA 4). At h = 10, 214 of 778 were dropped.

### Secondary (never decides the verdict)
- Horizons (close entry): h1 +0.124 [-0.010, +0.271] dev, +0.173 [-0.037, +0.382] 2023+. h3 +0.07 / -0.06. h10 -0.12 / -0.12. No pooled CI clears 0.
- Next-close entry: h5 +0.09 dev, -0.14 2023+. h1 is -0.194 [-0.396, -0.006] in 2023+, so the h1 close-entry lean sits in the first bar after the event.
- Thresholds (h5): 2.0 gives +0.125 [-0.066, +0.316] dev and -0.204 [-0.516, +0.110] 2023+. 3.0 gives +0.10 / -0.30.
- Groups (h5): energy (HO, RB) +1.10 [+0.23, +2.01] dev and -1.02 [-2.06, +0.15] 2023+, a sign flip on 114 / 23 events. Grains/oilseeds +0.14 / +0.37 (CIs span 0). Livestock -0.35 / -0.30 (lean to reversal). PA -0.40 / +0.54.
- Per market (h5): GF reverses in dev at -1.27 [-1.98, -0.62]. HO and RB continue in dev with CIs above 0. Their 2023+ point estimates reverse (CIs span 0). HE 2023+ is -1.14 [-2.37, -0.01]. Per-market n is 11-66, and MDE80 is 1-2.7 sigma.
- Up vs down (h5): up +0.20 / +0.54. Down +0.10 dev, -0.53 [-1.09, -0.03] 2023+.
- Net: costs are assumed (2 bps per side, plus 0.822 bps per night for CFDs). No net CI is above 0 in the primary or the pooled horizon cells.
- Grid: 2,160 cells were logged to trials.jsonl (1,981 with n >= 5). 79 have CI > 0 and 153 have CI < 0. About 99 per side are expected by chance.
- Combined with ext39's 11 commodities. This view is NOT independent, because ext39 selected the cell post hoc. Both are restricted to cmd41's windows, so ext39 dev starts 2010-06 here. ext39 alone: +0.267 [-0.007, +0.558] dev, +0.451 [+0.018, +0.853] 2023+. Pooled with cmd41: +0.224 [-0.039, +0.493] dev (n 1,323), +0.249 [-0.120, +0.572] 2023+ (n 376).

### Conclusion
The ext39 lead does not transfer to commodities outside its own data. The only consistent pieces are a small h1 close-entry lean in both windows and a dev-only energy continuation that reverses after 2022. I recommend dropping the commodity continuation lead. No prospective shadow is proposed.

Files: `data/research/engine/audit/cmd41/` (fetch.py, fetch_log.jsonl, raw/ohlcv1d_10.dbn.zst, raw/symbology.json, cmd41.py, summarize.py, prereg_body.json, prereg.json, out/describe.json, out/results.json, out/summary.txt).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
