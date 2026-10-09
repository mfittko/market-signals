# Order flow

Question: does trading activity (volume, aggressor imbalance) predict the next move?

Answer: not reliably. A strong CL aggressor-imbalance reversal passed in one year and failed in the next. OANDA tick counts carry no direction. The order-book extension proposed by the external review has lost its basis.

## Results

| Campaign | Data | Result |
|---|---|---|
| [flow29] | Databento CL.v.0 trades 2025-10-01 to 2026-10-08 | PASS REVERSAL. Imbalance over 3 M5 bars at or above the trailing 95th percentile: continuation minus matched baseline -5.1 pp [-7.0, -3.3], Holm p 0.002, 3,135 events. -0.16 ATR gross. Held on OANDA mid, M1 and other horizons. |
| [flow42] | Databento CL.v.0 trades 2024-10-01 to 2025-10-01 | FAIL. Same test: -0.5 pp [-2.3, +1.7] on 3,101 events; continuation 49.5% vs 50.0%. Heavy vs normal flow matched on the price move: +1.2 pp new year, pooled -1.2 pp [-3.0, +0.9]. Fade net -7.2 bps at the OANDA spread. |
| [vol33] | OANDA tick counts, top 1 to 2% by slot | FAIL. Climax and absorption rules have gross CIs spanning 0; no net CI above 0 in 252 cells. Tick counts carry no direction or range information here. |
| [sess25] | Session breakouts split by tick-volume ratio | FAIL. High and quiet volume do not differ consistently. |
| [xvol9], [xvol10] | Cross-instrument activity bursts | Negative. The move ends inside the burst bar. |

## Interpretation

- flow29 is the textbook case for replication. A Holm p of 0.002 in one year did not survive the next year. Treat any single-period pass as a hypothesis ([methodology.md](methodology.md)).
- On the flow42 M1 data the reversal still showed (-4.3 pp), but without a mid-price check it is likely bid-ask bounce ([flow42]).
- OANDA candle volume is a count of price updates, not traded volume. Campaigns that use it state this ([xvol9]).

## External evidence and the lost extension

Cont, Kukanov and Stoikov show that order-flow imbalance including limit orders and cancellations explains short-interval price changes better than trade volume. That is evidence about price formation, not about future returns. The external review proposed book-response features around the flow29 signal, with a flow29 replication as the prerequisite ([external-review.md](../external-review.md#research-direction-after-scan46)). flow42 was that replication and it failed, so the extension has no basis now. Databento MBP-1 would supply the book data if a new mechanism justifies it.

<!-- campaign link definitions -->
[flow29]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6076402618
[flow42]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6079878152
[sess25]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6061199017
[vol33]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077914731
[xvol10]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6053719226
[xvol9]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6053439954
