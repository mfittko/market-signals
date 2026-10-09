## fade31 preregistration: fade fast moves that come without a news burst

This is registered before any outcome run. Before the prereg, only synthetic self-checks and signal counts ran. No price after a signal bar was read.

Question: after a fast move without a news burst, does entering against the move make money before spread? Prior evidence: the up/down tables show fast moves lean back about 4-5 pp over 6 M5 bars. flow29 found that heavy order flow reverses by 5.1 pp (about -0.16 ATR). In news24, news-backed strong candles tended to continue, within noise. The expected bounce is small, about 0.16 ATR.

Files:
- `data/research/engine/audit/fade31/prereg.json` sha256 `3b7e2b8d00449170e64f06dfa6c905f49e8626b5ed220f1f3ccca49e26b5b3bc`
- `data/research/engine/audit/fade31/fade31.py` sha256 `84b4457a784869c9d5b7f5c2f5c4f5b476df4fe6eb4fdee86516956e8c732153`
- Reused unchanged: `updown.features` (the Python port of `nowMotion`), `news24.news_features` / `news24.classify` with `relevance.json`, `labels_v2.simulate`, `validate.day_boot`. The script records the hashes of all of them.

### Definitions
- Fast move: the Now-line definition. The run is the current streak of closed mid bars in one direction, capped at 6 bars. move = (last close - first open of the run) / supertrend ATR(10). A move is fast when |move| >= 1.5 ATR. The signal is the first bar of a same-direction streak that becomes fast, so each streak gives at most one signal.
- News burst: the news24 NEWS rule exactly. It needs a relevant-article share z >= 2.0 and >= 5 relevant articles in the two newest 15-minute GDELT files at or before the bar close, with a 14-day baseline. A bar whose GDELT files or baseline are missing is excluded from both groups and counted.
- Coverage caveat: GDELT files exist only on the news24 4-hourly grid and around news24 candidate events. The covered subset is therefore selected toward bars near strong high-volume candles. WTI M5 signals: dev has 3,419 no-news, 161 news and 24,324 excluded. 2023+ has 3,042 no-news, 58 news and 24,036 excluded. These counts are before the one-trade-at-a-time filter.

### Trade
- Entry is against the move at the next bar open. R = 1.0 ATR(10) at the signal bar.
- Primary exits: target +0.5 R, stop -1 R, and a time exit at the close of bar 6. In `labels_v2.simulate` this is k=1.0, m=T=0.5, H=6, with no flip exit.
- Gross uses mid prices and is the primary measure. Net uses bid/ask fills.
- One open trade per instrument at a time. Signals of all groups are processed in time order. A signal is skipped while the previous kept trade is open, measured to that trade's gross exit bar.

### Windows and test
- Windows: dev 2019-01-01 .. 2022-12-31 and 2023-01-01 .. 2026-10-07. The 2023+ window is a development window, not a holdout.
- PRIMARY: WTI M5 no-news fades, gross mean R per trade. CI from a day-block bootstrap (`validate.day_boot` over all trading days in the window, block 5, 1000 reps, seed 31, percentile 95% CI).
- PASS if the CI lower bound is above 0 in BOTH windows. Otherwise FAIL.
- KEY SECONDARY: news fades minus no-news fades, gross mean R difference with a day-block CI, per window. This tests the operator rule "don't fade news". The rule counts as supported when the difference is negative and the CI upper bound is below 0.
- Other secondaries never decide the verdict: net with bid/ask; a 1.0 R target; a time-exit-only variant (no stop and no target); M1 and M15; XAU, XAG, NATGAS, SPX500 and EUR/USD; hit rate; trades per day; MDE80 = 2.8 x bootstrap SD; all signals including the excluded ones as coverage-free context. No multiplicity correction is claimed.

This is development evidence only. Any survivor needs prospective confirmation (https://github.com/mfittko/market-signals/issues/313) or data after 2026-10-07.
