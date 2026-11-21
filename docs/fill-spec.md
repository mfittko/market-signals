# Fill spec

This spec fixes how one completed bar closes a position at its stop or its target, and at which price. The Node engine is the reference: `simulateFills` in [`scripts/bot.mjs`](../scripts/bot.mjs) and the `fills-stop-target-gap` case in [`test/golden/portfolio.json`](../test/golden/portfolio.json). The Go function is `fill.Check` in [`platform/internal/fill`](../platform/internal/fill/fill.go). The position monitor (`monitor.Step`) and the Go backtest (`backtest.Run`) both call it.

## Rules

A bar has an open, a high and a low. A position has a side, a stop and an optional target. The checks run in this order, and the first match closes the position:

1. Gap through the stop. The open is at or beyond the stop (long: `open <= stop`; short: `open >= stop`). The position closes at the open, reason `stop`.
2. Gap through the target. A target exists and the open is at or beyond it (long: `open >= target`; short: `open <= target`). The position closes at the open, reason `target`.
3. Stop touched intrabar. Long: `low <= stop`; short: `high >= stop`. The position closes at the stop, reason `stop`.
4. Target touched intrabar. A target exists. Long: `high >= target`; short: `low <= target`. The position closes at the target, reason `target`.

Otherwise the bar closes nothing.

A gap event happens at the open, before any price inside the bar can trade. So a gap through the target wins over a later intrabar touch of the stop. When both levels trade inside the bar without a gap, the order of the two touches is unknown, and the stop wins. This is the pessimistic fill. An open exactly at a level counts as a gap; the fill price equals the level.

## Entry bar

- Node bot and Go monitor: the position is opened from a decision, and fills are checked from the next completed bar after entry.
- Go backtest: a flip is known at the close of its bar. The trade enters at the next bar's open and fills are checked on that entry bar too. The open of the entry bar is the entry price, so rules 1 and 2 cannot fire on it, because the stop and the target lie a positive distance away from the entry.

## Spread and cost

- Node ledger (`scripts/portfolio.mjs`): a fixed per-instrument spread is paid once on entry. A long enters at `price + spread`, a short at `price - spread`. Exits fill at the fill price with no spread. Commission defaults to 0 and is charged once, at open.
- `fill.Check` only decides the exit price and reason. Spread and commission are the ledger's concern and are applied around it. The Go ledger refuses an open whose target does not lie strictly beyond the entry price after spread, so a replay of the entry bar cannot gap-fill the target at the entry.
- The Go monitor records the entry it is given and applies no spread or cost. The Go backtest measures results in R from the next bar's open and applies no spread or cost.

## Spec cases

`TestSpecCases` in [`platform/internal/fill/fill_test.go`](../platform/internal/fill/fill_test.go) runs every row. Long: stop 95, target 105. Short: stop 105, target 95.

| Case | Side | Target | Open | High | Low | Exit price | Reason |
|---|---|---|---|---|---|---|---|
| gap stop | long | 105 | 94 | 96 | 93 | 94 | stop |
| gap target | long | 105 | 106 | 107 | 105.5 | 106 | target |
| gap target, stop touched intrabar | long | 105 | 106 | 107 | 94 | 106 | target |
| both touched intrabar | long | 105 | 100 | 106 | 94 | 95 | stop |
| stop only | long | 105 | 100 | 101 | 94 | 95 | stop |
| target only | long | 105 | 100 | 106 | 99 | 105 | target |
| no target | long | none | 100 | 200 | 96 | none | none |
| no target, stop touched | long | none | 100 | 200 | 94 | 95 | stop |
| no touch | long | 105 | 100 | 104 | 96 | none | none |
| open exactly at the stop | long | 105 | 95 | 106 | 94 | 95 | stop |
| open exactly at the target | long | 105 | 105 | 106 | 94 | 105 | target |
| gap stop | short | 95 | 106 | 107 | 104 | 106 | stop |
| gap target | short | 95 | 94 | 94.5 | 93 | 94 | target |
| gap target, stop touched intrabar | short | 95 | 94 | 106 | 93 | 94 | target |
| both touched intrabar | short | 95 | 100 | 106 | 94 | 105 | stop |
| stop only | short | 95 | 100 | 106 | 99 | 105 | stop |
| target only | short | 95 | 100 | 101 | 94 | 95 | target |
| no target | short | none | 100 | 104 | 1 | none | none |
| no target, stop touched | short | none | 100 | 106 | 1 | 105 | stop |
| no touch | short | 95 | 100 | 104 | 96 | none | none |
| open exactly at the stop | short | 95 | 105 | 106 | 94 | 105 | stop |
| open exactly at the target | short | 95 | 95 | 106 | 94 | 95 | target |

`TestPortfolioGoldenFills` replays the `fills` steps of the portfolio case `fills-stop-target-gap` through `fill.Check`. It compares the close price and reason of every recorded trade.

## Differences from the Node reference

- The stop is required. Node `simulateFills` skips the stop checks when a position has no stop. Every Go position has a stop: the monitor's `Position.Stop` and the backtest's ATR stop.
- `fill.Check` closes one position against one bar. The loop over open positions of an instrument and the ledger update stay with the caller.

The rule order and the fill prices are the same as in Node.

## Changed behaviour

Before this spec, the Go monitor and the Go backtest checked the stop first (a gap through the stop filled at the open) and filled every target at the target price. A gap through the target therefore filled at the target, and a gap through the target with an intrabar stop touch closed at the stop. Both now follow the Node reference.

Changed monitor golden cases in [`test/golden/monitor.json`](../test/golden/monitor.json):

| Case | Before | After | Reason |
|---|---|---|---|
| `long-gap-through-target-fills-at-open` (was `long-gap-through-target-fills-at-target`) | exit 105, target | exit 107, target | the bar opens at 107, above the target 105; rule 2 fills at the open |
| `short-gap-through-target-fills-at-open` (was `short-gap-through-target-fills-at-target`) | exit 95, target | exit 93, target | the bar opens at 93, below the target 95; rule 2 fills at the open |

Every other monitor case is unchanged.

Backtest test expectations: no existing expectation changed. `TestAGapThroughTheTargetFillsAtTheOpen` in [`platform/internal/backtest/backtest_test.go`](../platform/internal/backtest/backtest_test.go) is new. It asserts the changed behaviour: a bar that opens above the target and trades below the stop closes as a target at the open.
