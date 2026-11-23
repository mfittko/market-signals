# Engine reuse decision

## Status

Accepted, 2026-11-23 (https://github.com/mfittko/market-signals/issues/259). The decision itself was taken in code by https://github.com/mfittko/market-signals/issues/343. This note records it and the limits of the code it keeps.

## Context

The research epic https://github.com/mfittko/market-signals/issues/230 needs one reproducible, cost-aware baseline and a prospective forecast record. Before that work starts, one question must have a written answer: which component fills orders and keeps the account? The options were an external engine (NautilusTrader or LEAN) behind a subprocess boundary, a narrow extension of our own components, or the existing baseline with stated limits.

https://github.com/mfittko/market-signals/issues/343 moved the paper ledger and the bar fill rules from the Node engine to Go. The result is:

- `fill.Check` in [`platform/internal/fill/fill.go`](../../platform/internal/fill/fill.go) decides the exit price and reason of one bar. [`docs/fill-spec.md`](../fill-spec.md) is its spec. The Go ledger, the position monitor and the Go backtest all call it.
- The Go ledger in [`platform/internal/ledger/ledger.go`](../../platform/internal/ledger/ledger.go) books positions, trades, cash, margin and the halt in Postgres. Each operation runs in one transaction with an idempotency key.
- The Go backtest in [`platform/internal/backtest/backtest.go`](../../platform/internal/backtest/backtest.go) replays Supertrend flips in R units with a chronological train and test split. It applies no spread, financing or margin, so its results are an authoring diagnostic.

The research evaluator in [`registry/evaluator/engine/fills.py`](registry/evaluator/engine/fills.py) resolves fills on bid and ask bars for research campaigns. It is a separate research tool.

## Decision

Extend. `fill.Check` and the Go ledger are the one execution and accounting authority for the paper mode and the Go backtest mode. A missing effect is added to them in a narrow change, with a spec case in `docs/fill-spec.md` and a Go test. NautilusTrader and LEAN are not adopted. The Python research evaluator stays a research-only tool outside the execution and accounting authority.

### Candidates

Checked on 2026-11-23 from the public release pages listed in [sources.md](sources.md#backtest-engines).

| Candidate | Pinned release | Core license | Runtime and deployment cost | Reason it is not adopted |
|---|---|---|---|---|
| NautilusTrader | [v1.231.0](https://github.com/nautechsystems/nautilus_trader/releases/tag/v1.231.0), 2026-08-02, labelled Beta on GitHub. The 2.0 line is only on pre-release wheels. | LGPL-3.0 | A Python 3.12 to 3.14 runtime with prebuilt wheels, a second strategy and data model next to Go, and a 1.x to 2.x core change already announced in the release notes. | It would be a second execution and accounting authority next to the Go ledger. It documents a `Cfd` instrument, but our venue costs, financing and margin would still be our own configuration, so it adds no verified venue realism. |
| LEAN | No versioned engine release: the newest GitHub release is [v2.4.0.1](https://github.com/QuantConnect/Lean/releases/tag/v2.4.0.1) from 2017. The maintained distribution is the [lean CLI 1.0.234](https://pypi.org/project/lean/), 2026-11-18, which runs the `quantconnect/lean` Docker image. | Apache-2.0 | Docker, the .NET engine image, a Python CLI, and an image tag that defaults to `latest` unless pinned. | It would also be a second authority. Its reality models (fill, fee, slippage, buying power, margin interest) are configurable, but the venue values would still be ours, and the engine needs Docker and .NET for a bar-based CFD account. |

Both feature statements come from documentation, not from a run on our account or instrument.

### Dimensions

Each row names the Go code that handles the dimension today, or states "not modelled". "Not modelled" is a limitation of every result the Go code produces.

| Dimension | Go code today | Limitation |
|---|---|---|
| Event ordering | `ledger.Replay` judges stored completed bars oldest first and stores the last judged bar in the same transaction. | Bar granularity only; no tick or quote events. |
| Fills | `fill.Check`, called by `ledger.Fill`, `ledger.Replay`, `monitor.Step` and `backtest.Run`. | Bar open, high and low only; no intrabar path. |
| Ambiguous stop-and-target bar | `fill.Check`: the stop wins when both levels trade inside one bar. | Pessimistic by convention, not measured. |
| Gaps | `fill.Check`: a gap through the stop or the target fills at the open. | None beyond bar data. |
| Cash | `ledger.Open` takes margin and commission from cash; `closeIn` returns margin plus realized profit. | One account. |
| Realized and unrealized equity | `closeIn` books realized profit; `equitySQL` and `ledger.Mark` compute equity at the last mark. | Equity is as fresh as the last mark. |
| Margin | `ledger.Open` books margin as notional divided by leverage; `ledger.Mark` closes a position whose loss reaches its margin. | No venue margin rates, margin call levels or margin closeout order. |
| Spread | `ledger.Open` adds the spread once to the entry. | Not modelled on the exit. The value is the caller's input. The Go backtest and the monitor apply none. |
| Commission | `ledger.Open` charges it once, at open. | The value is the caller's input. |
| Financing | Not modelled. | No overnight financing on any position. |
| Currency conversion | Not modelled. | Profit is in the instrument's quote currency; the account has no currency. |
| Contract sizing | `ledger.Open` sets units to notional divided by price. | No lot size, tick size or minimum trade size. |
| Pending exposure | Not modelled. | No pending orders; a position exists from `ledger.Open`. |
| Delayed decisions | `backtest.Run` enters at the next bar's open after the flip bar closes. `ledger.Open` takes the price and time from the caller. | The ledger does not check that the decision existed before the entry time. |
| Order rejection | `ledger.Open` refuses invalid input, a halted account and insufficient cash. | No venue rejections. |
| Concurrent strategies | One account row; positions carry no strategy id. | No per-strategy cash or attribution. https://github.com/mfittko/market-signals/issues/272 is the shared-cash spike. |
| Partial fills | `ledger.ClosePartial` closes part of a position on request. | No partial fill from liquidity; bar data has no queue or depth. |

## Consequences

- Two follow-up slices are listed under "Follow-up slices" in https://github.com/mfittko/market-signals/issues/259: the experiment contract with the E0 baseline, and the forecast-attempt journal with its comparison report. Both use `fill.Check` and the Go ledger rules. Each declares every cost it adds and labels each value as assumed or measured.
- Each "not modelled" row stays visible in every result the Go code produces until a narrow change adds the effect.
- Results from the Go backtest stay an authoring diagnostic until a baseline applies declared costs.
- Reopen this decision when a required effect, for example multi-currency accounting, venue margin or partial fills from liquidity, cannot be added to the Go ledger in one narrow change. Owner: the research epic https://github.com/mfittko/market-signals/issues/230.
- No broker credentials, live orders or protected holdout access follow from this decision.
