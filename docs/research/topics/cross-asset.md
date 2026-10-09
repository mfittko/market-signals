# Cross-asset

Question: do relationships between instruments (bursts across markets, lead-lag, relative-value spreads, extreme moves pooled across markets) give a tradable signal?

Answer: no. Cross-asset responses happen within the triggering bar, spreads revert slower than practical holds, and pooled extreme-move effects do not replicate.

## Results

| Campaign | Design | Result |
|---|---|---|
| [xvol9] | At least 3 of 8 instruments above their activity 95th percentile in the same M5 bar; continuation, lead-lag and fade | No variant has a positive point estimate in either window. The burst bar moves +2.6 ATR, then the path is flat. Laggards do not catch up. MDE about 0.16 to 0.48 R. |
| [xvol10] | The same on M1 | NO-GO. About minus the spread at +5 and +10 minutes in both windows. |
| [lead35] | Leader moves at least 2 ATR on M1, follower has not moved; 6 pairs, primary XAU to XAG | Gross -0.034 ATR [-0.147, +0.078] dev. Lag-0 correlation 0.11 to 0.73; lag 1 at most +0.017; lags 2 to 5 about 0. The lag condition adds nothing over the no-lag control. |
| [pairs16] | Rolling-hedge z-score spreads: XAU/XAG, SPX500/NAS100, EUR/USD vs XAU | All lose. M15 half-lives 32 to 66 hours vs a 24-hour hold. The declared pairs do no better than 25 unrelated control pairs. |
| [ext39] | Extreme daily moves (at least 2.5 sigma), 33 markets pooled | No pooled continuation or reversal. Commodities continued in dev, 1 of 720 cells. |
| [cmd41] | The commodity continuation on 10 new CME commodities | Did not replicate. Energy flipped sign between windows. |
| [tsmom36] | Diversified 33-market momentum | Correlation with SPX buy-and-hold 0.00 dev and 0.54 2023+. Not significant net. |

## Interpretation

- Information spreads across liquid markets within a bar. By the time a lagging market is identified, it has already moved.
- Relative-value spreads in these pairs mean-revert mainly because the trailing mean catches up, not because the spread snaps back ([pairs16]).
- Pooling across many markets raises the number of cells, so a few will clear by chance (ext39: 57 of 720 cells exclude 0, about 36 expected).

## External evidence

The survey finds that cross-sectional sorts over many assets carry the replicated premia (momentum, carry, reversal). Our cross-asset tests were time-series timing on a few pairs, not cross-sectional sorts. Cross-sectional work needs a broader universe and other vehicles ([trend-and-carry.md](trend-and-carry.md), [open-questions.md](../open-questions.md)). Pairs trading profits decline over time (Do and Faff 2010).

<!-- campaign link definitions -->
[cmd41]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078887870
[ext39]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078559927
[lead35]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078095798
[pairs16]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6055023857
[tsmom36]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078272501
[xvol10]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6053719226
[xvol9]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6053439954
