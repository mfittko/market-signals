## flow29 result: PASS REVERSAL (k = 3). Strong aggressor imbalance over 3 M5 candles is followed by a move against the flow.

Preregistration: https://github.com/mfittko/market-signals/issues/310#issuecomment-6076320299

### Data
- Databento GLBX.MDP3 `trades`, `CL.v.0`, 2025-10-01 to 2026-10-08 23:00 UTC. 13 monthly chunks, each downloaded once. Billed cost (sum of per-chunk quotes): $35.98.
- 28,747,892 trades: 13,006,509 buy aggressor (`B`), 12,947,601 sell aggressor (`A`), 2,793,782 no side (`N`, excluded).
- 72,399 open M5 bars. 63,803 bars with a valid 6-bar outcome after the 20-day warm-up, over 245 trading days.

### Primary (M5, N = 6, gross trade prices)
| k | events (buy / sell) | P(continue) | matched baseline | D | 95% CI | Holm p | MDE80 | pass |
|---|---|---|---|---|---|---|---|---|
| 1 | 3,187 (1,633 / 1,554) | 47.1% | 50.0% | -2.9 pp | [-4.5, -1.5] | 0.002 | 2.4 pp | no (below 3 pp) |
| 3 | 3,135 (1,625 / 1,510) | 44.9% | 50.0% | -5.1 pp | [-7.0, -3.3] | 0.002 | 2.9 pp | yes, REVERSAL |

Verdict: PASS REVERSAL on k = 3. k = 1 is significant in the same direction but its point estimate (-2.9 pp) is below the 3 pp bar.

### Secondary (never decide the verdict)
- Horizons: k = 3 is -4.3 pp at N = 3 [-6.1, -2.7] and -3.3 pp at N = 12 [-5.6, -1.1]. k = 1 is -3.1 pp at N = 3 and -1.5 pp at N = 12 (CI spans 0).
- M1 bars: k = 1 -3.0 pp [-4.0, -2.2], k = 3 -2.5 pp [-3.6, -1.5]. Same sign, smaller.
- OANDA WTICO/USD mid on the same CL event timestamps: k = 3 -4.8 pp [-6.8, -3.0], k = 1 -1.9 pp [-3.9, -0.2]. The mid-price score rules out bid-ask bounce in the CL last-trade closes as the main driver.
- Mean flow-signed 6-bar move: -0.16 ATR(10) for k = 3 and -0.12 ATR for k = 1 (drift-adjusted values are the same). Buy events reverse more than sell events (k = 3: -0.19 vs -0.13 ATR; k = 1: -0.20 vs -0.04 ATR).
- Absorption does not explain the reversal. For k = 3, absorbed events (830) go against the flow 54.5% of the time and pushed events (2,277) 55.2%, both against a 50% baseline. For k = 1: absorbed 51.8% (CI of D spans 0), pushed 53.4%.
- Thresholds: the 95th percentile of |I| was 0.41 (k = 1, range 0.28 to 0.55) and 0.27 (k = 3, range 0.19 to 0.39). 6% of k = 1 events have |I| = 1.

### Caveats
- Single-year test: one regime, includes the 2026 escalation period. The reversal must be confirmed on 2024-10 to 2025-10 before any live use.
- Gross only. -0.16 ATR over 30 minutes is small next to OANDA spreads. This result does not yet show a tradable edge.
- Events cluster in time. The 5-day block bootstrap covers that, but the effective sample is smaller than 3,135.

### Deviations from the prereg (both before any outcome was seen)
- The Databento licence ends before 2026-10-08 23:21 UTC. The October request was refused with HTTP 422 (not billed). `fetch.py` end changed to 2026-10-08 23:00 UTC; new sha256 `89c35034faf52deca556175c7ce14b59c88679391168ccde64e0c6f61d436fb9`.
- The first `run` crashed in the OANDA secondary on a timestamp unit bug (pandas microsecond resolution). Nothing was printed or written. The one-line fix changes `flow29.py` to sha256 `55d85d483ce36dadcdb6b81cd7134307cff4203ccb02b592fe3f1183e48f4f85`. The primary code path is unchanged.

Files: `data/research/engine/audit/flow29/` (`prereg.json`, `flow29.py`, `fetch.py`, `fetch_log.jsonl`, `out/results.json`, `out/bars_summary.json`, `raw/`). 11 rows in `trials.jsonl` with exp `flow29`.
