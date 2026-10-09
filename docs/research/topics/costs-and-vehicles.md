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
- The campaigns before trend49 used a flat 0/3/6% model on both sides. The external review calls this a sensitivity model and asks for broker-, account- and side-specific rates ([external-review.md](../external-review.md#costs-and-vehicles)). trend49 is the first to model the OANDA long and short rates separately; commodity basis adjustments are still open.

- trend49 modelled OANDA financing with US 3-month T-bill annual averages from the FRED series DTB3 as the basis (for example 5.07% in 2023, 4.97% in 2024, 4.07% in 2025). A long CFD held all the time then costs about 6 to 7% of notional a year in 2023-26. That alone cut buy-and-hold NAS100 from +181% to +116% and XAU from +127% to +74% over 2023-01-01 to 2026-10-08, and turned TS12 on NAS100 from +30% into +3%. A futures-style account without the financing markup keeps almost the whole gross result ([trend49], [trend49-lev]). The flat T-bill proxy is approximate for commodities, and index dividend adjustments were not modelled ([trend49]).

## Leverage and survival

trend49 amendment 2 simulated fixed 1x, 3x and 10x leverage and a volatility-targeted size (VT20: 20% divided by 20-day realized volatility, capped at the ESMA limit) with CFD costs, margin close-out at 50% of required margin, negative balance protection and re-entry on the next signal. It is descriptive ([trend49-lev]).

- At 10x, all 12 TS12 and TS6 accounts (six instruments each) ended 2018-22 at 0.06 or less of the starting equity. In 2023+, 11 of 12 ended below 0.5 ([trend49-lev]).
- On XAG, WTI and NATGAS the ESMA cap is 10x, so 10x uses the whole equity as margin and an adverse move of about 5% closes the position. The trend rules at 10x had up to 22 close-outs per window ([trend49-lev]).
- The 10x accounts that grew in 2023+ were long-only on markets that rose without a deep fall (SMA200 NAS100 20.3x with a -60% drawdown; buy-and-hold NAS100 14.1x, XAU 9.4x, SPX500 7.3x). They paid financing of 285 to 890% of the starting equity because the notional grew with price ([trend49-lev]).
- At 3x the trend rules had no close-out, but TS12 and TS6 drawdowns were 54 to 99% ([trend49-lev]).
- Re-entry after a close-out made 10x results worse in most cells, because each entry restarted the same thin margin buffer ([trend49-lev]).
- VT20 was never closed out. It ran at about 1x on gold and the indices and well below 1x on silver, oil and gas, with results close to 1x and lower drawdowns on the commodities ([trend49-lev]).
- Above about 3x on these instruments, survival rather than capture decides the result ([trend49-lev]).

Consequence for the product: size positions by volatility and warn about leverage in the bots and on the card ([open-questions.md](../open-questions.md)).

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
[trend49-lev]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6087525298
[trend49]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6087457614
[tsmom36]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078272501
[xvol9]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6053439954
