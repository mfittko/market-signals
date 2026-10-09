## flow42 result: FAIL on both primaries. The flow29 reversal does not replicate on 2024-10 to 2025-10, and heavy flow adds nothing reliable beyond the price move.

Preregistration: https://github.com/mfittko/market-signals/issues/310#issuecomment-6079863088

### Data
- Databento GLBX.MDP3 `trades`, `CL.v.0`, 2024-10-01 to 2025-10-01 (end exclusive). 12 monthly chunks, each downloaded once. Billed $28.27 (sum of per-month quotes).
- 22,587,228 trades: 10,391,673 buy aggressor, 10,303,354 sell aggressor, 1,892,201 no side (excluded).
- 70,902 open M5 bars. 61,528 bars with a valid 6-bar outcome after the 20-day warm-up, over 239 trading days. No outcome window spans a roll.

### H1 replication (primary): flow29 k = 3 test unchanged
| window | events (buy / sell) | P(continue) | matched baseline | D | 95% CI | MDE80 | pass | \|D\| >= 3 pp |
|---|---|---|---|---|---|---|---|---|
| 2024-10 to 2025-10 (new) | 3,101 (1,519 / 1,582) | 49.5% | 50.0% | -0.5 pp | [-2.3, +1.7] | 3.1 pp | no | no |
| 2025-10 to 2026-10 (flow29, for reference) | 3,135 | 44.9% | 50.0% | -5.1 pp | [-7.0, -3.3] | 2.9 pp | yes | yes |

H1 FAIL. The sign is right, but the effect is about one tenth of flow29's and the CI spans 0. The test could detect 3.1 pp at 80% power, so a 5 pp effect would have shown.

### H2 incremental (primary): heavy flow vs normal flow with the same 3-bar price move (decile bin) and UTC hour
| window | heavy | matched | P(continue) heavy | P(continue) matched normal | D_inc | 95% CI | MDE80 |
|---|---|---|---|---|---|---|---|
| 2024-10 to 2025-10 | 3,085 | 3,085 | 49.5% | 48.3% | +1.2 pp | [-1.3, +3.9] | 4.2 pp |
| 2025-10 to 2026-10 | 3,107 | 3,107 | 45.0% | 48.5% | -3.5 pp | [-5.6, -0.7] | 3.9 pp |
| pooled | 6,192 | 6,192 | 47.2% | 48.4% | -1.2 pp | [-3.0, +0.9] | 3.0 pp |

H2 FAIL. The pooled CI spans 0 and the new year's point estimate is positive. All heavy events found controls in their cell. In the flow29 year heavy flow did add about 3.5 pp beyond the price move, but it does not carry over. Matched normal-flow bars continue only about 48% of the time in both years: part of flow29's reversal is the price move reverting, not the flow.

### Secondary (never decides)
- k = 1: D +0.1 pp [-1.5, +2.2] (flow29 -2.9 pp).
- Horizons, k = 3: N = 3 -1.5 pp [-3.2, +0.5], N = 12 -1.0 pp [-3.3, +1.5]. k = 1 N = 3 -2.3 pp [-4.0, -0.8] is the only M5 CI below 0.
- M1 on CL trade prices: k = 1 -4.8 pp [-5.8, -3.7], k = 3 -4.3 pp [-5.5, -3.1]. This holds, but the OANDA mid check below finds nothing at M5. At 1-minute bars the last trade sits on the aggressor's side of the book, so bid-ask bounce is the likely cause. No mid-price M1 check was run.
- OANDA WTICO/USD mid on the same event times: k = 3 -0.3 pp [-2.2, +2.1], k = 1 +0.6 pp [-1.1, +2.6]. In flow29 the mid confirmed the effect (-4.8 pp). Here it does not.
- Buy vs sell (k = 3): buy events continue 48.3% vs 50.5% base, sell events 50.7% vs 49.5% base. Pooled H2 split: buy -2.1 pp [-4.7, +0.5], sell -0.2 pp [-3.0, +3.0].
- Absorption flips sign against flow29. k = 3 absorbed events (674) continue more than the baseline: +4.3 pp [+0.2, +9.2]. Pushed events (2,411) go against the flow 51.8% of the time. In flow29 both groups reversed.
- Mean flow-signed 6-bar move: +0.00 ATR (k = 3), -0.01 ATR (k = 1). flow29: -0.16 ATR.
- Fade trade against the flow at OANDA mid, close t to close t+6 (k = 3, n 3,066): gross -0.17 bps, net -7.2 bps after half the spread at entry and exit (median cost $0.04), gross hit 49.8%, net hit 27.6%. k = 1 is the same (gross -0.20 bps, net -7.4 bps). Even flow29's -0.16 ATR gross would not have covered this spread.
- H2 with 20 bins: +1.7 pp (new year), -3.4 pp (flow29 year), so bin width does not drive H2. H2 at N = 3 / 12: +0.3 / -0.6 pp (new year), -2.5 / -2.7 pp (flow29 year).
- Thresholds (new year): 95th pct of |I_3| median 0.30 (range 0.26 to 0.37), flow29 0.27.

### Verdict
The flow29 reversal is a single-year effect. On the independent earlier year, heavy 3-bar aggressor imbalance does not predict the next 30 minutes of WTI: 49.5% against 50.0%. Flow also adds no stable information beyond the price move it comes with. A live flow feed at $199/month is not justified by this evidence. The card should not show an imbalance-reversal line.

### Caveats
- The flow29 year includes the 2026 escalation. A regime-dependent effect is possible, but it cannot be found or used without a third, prospective sample.
- The pooled H2 includes the year that selected the H1 effect. This favours a pass, and H2 still failed.
- Databento flags 2025-09-17 and 2025-09-24 as degraded quality. Both days are included.

### Deviations from the prereg
None. `flow42.py`, `fetch.py` and `prereg.json` match the hashes in the prereg comment.

Files: `data/research/engine/audit/flow42/` (`prereg.json`, `prereg_comment.md`, `flow42.py`, `fetch.py`, `fetch_log.jsonl`, `download.out`, `run.out`, `out/results.json`, `out/f29_run_results.json`, `out/bars_summary.json`, `out/bars_m1.parquet`, `raw/`). 23 rows in `trials.jsonl` with exp `flow42` (4 primary).
