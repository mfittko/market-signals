# Costs and vehicles

Question: what does it cost to trade an idea on OANDA CFDs, and when does another vehicle fit better?

Answer: the spread dominates intraday, financing dominates beyond a few days, and commodity carry and options are not reachable through CFD mid prices at all. The vehicle must match the holding period.

## Spread by timeframe

The spread share of the mean absolute move on index CFDs ([swing45]):

| Timeframe | Spread share of the mean absolute move |
|---|---|
| M1 | 0.5 to 0.6 |
| M5 | 0.25 to 0.3 |
| H4 | 0.04 to 0.05 |
| Daily | 0.01 to 0.02 |

Consequences:

- Any M1 or M5 edge must be large to survive. The M1 pullback excess of +0.07 to +0.17 bps is real and still loses -1.3 to -2.3 bps against a spread of about 2 bps ([swing45]).
- Typical costs per trade in R units: about 0.11 R for xvol9 entries, 0.116 R mean spread for the limit13 signals, 0.08 R for 15-minute ORB, 0.11 to 0.13 R for daytype14 ([xvol9], [limit13], [orb15], [daytype14]).
- Spread relative to ATR swings with the hour. Blocking entries with spread above 0.2 R and in fixed thin hours cuts losses per signal by about 70 to 80%. The remaining signals still lose about -0.12 R ([notrade12]).
- Thin hours (UTC) per instrument: WTI 4, 5, 22, 23; XAU 4, 21, 22, 23; XAG 0, 21, 22, 23; NATGAS 3, 4, 22, 23; SPX500 3, 4, 5, 6; EUR/USD 4, 21, 22, 23 ([notrade12]).
- Passive limit orders do not save the spread. They fill on failing signals and miss winners ([limit13]).

Data caveat: OANDA candles aggregate bid and ask separately, so bid and ask highs need not occur together. A candle's high-ask minus high-bid is not a spread path ([external-review.md](../external-review.md#labels-and-execution-realism)).

## Financing

- OANDA charges the basis rate plus 2.5% a year on longs and credits the basis minus 2.5% on shorts (broker document; see [sources.md](../sources.md#brokers-and-vehicles)).
- In the multi-week policies financing is 70 to 95% of all costs for metals, SPX500 and EUR/USD ([mw6]).
- tsmom36 runs about 2.3x gross notional. The survey estimates a 2.5% markup costs about 5.8% a year there, more than the gross return of about 3.4% a year ([tsmom36]; survey).
- For the daily pullback (3.6 days held) the survey estimates about 9 bps of financing per trade at a full rate near 8.9%, about half of the +17 to +21 bps edge. The 8.9% figure is a third-party estimate for Plus500, not OANDA.
- All campaigns so far used a flat 0/3/6% model on both sides. The external review calls this a sensitivity model and asks for broker-, account- and side-specific rates ([external-review.md](../external-review.md#costs-and-vehicles)). Open.

## Commodity carry sits in the financing line

OANDA prices commodity CFDs from the next futures contract and passes contango and backwardation through financing, not price (broker document). OANDA mid candles therefore contain no roll yield. Two consequences:

- The flat 3% financing in tsmom36 and mw6 mis-states commodity returns in both directions.
- Commodity carry and curve research needs futures data, for example Databento front and second contracts ([data.md](../data.md), [open-questions.md](../open-questions.md)).

Plus500 oil and gas CFDs are also futures-based, with a valuation change at rollover.

## Other vehicles

| Vehicle | Cost structure | Fits |
|---|---|---|
| OANDA CFD | Spread; financing at basis +/- 2.5% | Short holds with low turnover where the move is large relative to the spread |
| Futures | Exchange fees and spread; financing at about the risk-free rate inside the price | Trend, carry, commodity curve work |
| Cash ETF | Expense ratio; spread under 1 bp for liquid funds | Sector and country momentum, index exposure |
| Options | Premium, spread; not available as CFDs | Volatility risk premium (put writing) |
| Single stocks (Alpaca) | Commission-free; spread | Cross-sectional reversal, earnings premium |

Figures in this table are from the 2026-10-09 survey. EU caveat: PRIIPs blocks retail purchase of US-domiciled ETFs at EU brokers, so UCITS equivalents are needed. What an Alpaca international account allows is not confirmed.

## Rules derived

- Report gross and net. Gross shows information; net shows tradability ([rescan26] made gross the primary judgement of direction).
- Apply the spread rule (no entry above about 0.2 R) and the thin-hour rule in every intraday policy.
- For holds longer than a day, model side-specific financing before claiming a net edge.
- Test commodity carry on futures data, not on CFD mids.

<!-- campaign link definitions -->
[daytype14]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054636254
[limit13]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054340144
[mw6]: https://github.com/mfittko/market-signals/issues/314#issuecomment-6051504954
[notrade12]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054177967
[orb15]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054798153
[rescan26]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6061163925
[swing45]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084121700
[tsmom36]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078272501
[xvol9]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6053439954
