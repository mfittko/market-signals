# News

Question: does news help predict the size or direction of the next move?

Answer: not as tested. News bursts measured by article counts are rare and do not significantly mark continuation. The relevance filter behind them is imprecise. Event content (what was announced, against what expectation) has not been tested. The operating rule stays: news may raise attention or caution, but it never sets direction, and price confirmation is mandatory.

## What was tested

| Campaign | Design | Result |
|---|---|---|
| [news24] | Strong high-volume M5 candles with a GDELT relevance-share burst (z at least 2) vs the same candles without news; gross R at 3, 6 and 12 bars | REJECT. WTI 6 bars: NEWS +0.28 R [+0.02, +0.58] dev (n 64), +0.14 R [-0.24, +0.55] 2023+ (n 21). NEWS minus CONTROL +0.25 R [-0.03, +0.55] dev. MDE80 of the difference about 0.4 to 0.55 R. Bursts are 2 to 6% of events. Other instruments mixed. |
| news28 | Jev labels on 1,000 seeded rows per instrument to measure and tighten the news24 relevance rule | Closed by operator decision without a rerun. Jev-relevant share: WTI 0.32, XAU 0.31, XAG 0.19, EUR 0.54, SPX 0.39, NATGAS 0.12. A theme and URL drop-list keeps at least 90% of relevant rows only for XAU, EUR and SPX, and drops only 15 to 44% of junk. Recorded in the local queue only. |
| [fade31] | Fades of fast moves with and without a news burst | Fades lose either way. News minus no-news +0.031 R [-0.063, +0.134] dev. GDELT covers only about 12% of the signals. |
| [notrade12] | Scheduled release windows (EIA, NFP) as a "do not enter" reason | Underpowered: 0.7% of signals blocked, effect -0.001 R. CPI and FOMC dates were skipped. |
| [orb15] | EIA Wednesday window for WTI (Wen et al.) | Matches the published sign in dev and reverses in 2023+; MDE about 0.29 R per window. |
| [cal37] | Pre-FOMC drift on SPX500 | +24.8 bps [+3.8, +46.7] dev (Holm p 0.060), -14.9 bps 2023+. |

## Interpretation

- Article counts measure attention, not information. A burst of articles does not say whether the content was a surprise.
- The GDELT relevance rule mixes in much unrelated content, especially for NATGAS and XAG. Any rerun on the same history would be a new look at spent data; only prospective WTI NEWS events could add evidence.
- The operator's continuation hypothesis for WTI points the right way in both windows, but no interval clears 0 and the sample is small.

## Not tested: event surprises

Macro announcement surprises drive exchange-rate jumps (Andersen, Bollerslev, Diebold and Vega). The external review ranks "release surprise plus confirmed price response" for EIA and WTI as the first new workstream. It needs an as-of expectation source; the EIA archive is not a consensus archive. Do not count the initial jump as profit; only the move after a realistic entry counts ([external-review.md](../external-review.md#research-direction-after-scan46), [open-questions.md](../open-questions.md)).

## Providers

The live engine uses NewsAPI.ai, GNews, FXEmpire articles and sentinel queries. Benzinga access was priced on 2026-09-07 and not bought ([data.md](../data.md#news-data)).

<!-- campaign link definitions -->
[cal37]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078391261
[fade31]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077727397
[news24]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6072144766
[notrade12]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054177967
[orb15]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054798153
