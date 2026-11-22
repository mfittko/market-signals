# Golden fixtures

Recorded inputs and expected outputs of the Node engine and, for the monitor area, of the Go platform. A port or refactor replays the inputs and compares with the expected values.

## Files

- `indicators.json`: Supertrend, ATR, ADX, RSI, EMA, MACD, Bollinger, VWAP, volume ratio, resampling, higher-timeframe Supertrend and the axis snapshot.
- `portfolio.json`: scenarios for sizing, fills (rules in [the fill spec](../../docs/fill-spec.md)), mark-to-market exits, halts, the drawdown kill-switch, the halt reset, attribution and the strategy scoreboard.
- `monitor.json`: position monitor scenarios (fills, trailing, time stop, kill switch, invalidation, tripwires and their cooldown), recorded from Go.
- `strategies.json`: per-combo bot resolution (`resolveBotFor` and `resolvedStrategy` in `scripts/bot.mjs`), recorded from Node and replayed in Go (`platform/internal/strategy`). An input is `{ "kind": "resolve", instrument, granularity, settings, rows }`. A row is `[name, version, active, archived]`, its prompt is `<name> v<version> rules` and its engine id is its 1-based position. `expected` is `{ botFor, resolved }`, where `resolved` is `{ name, version }` or `null`.

## Format (version 1)

Every file is plain JSON:

```
{ "version": 1, "area": "indicators" | "portfolio" | "strategies" | "monitor", "series": { "<name>": [candle, ...] }, "cases": [ { "name", "input", "expected" } ] }
```

- `series` exists only in `indicators.json`. A candle is `{ time, open, high, low, close, volume, complete }`. Times are ISO-8601 UTC.
- `input.kind` is `indicators`, `axis-snapshot`, `scenario`, in `strategies.json` `resolve`, or, in `monitor.json`, `step`.
- `indicators` and `axis-snapshot` inputs name a `series`. Their expected values are the engine outputs; `null` marks a warm-up slot; `{ "error": "<message>" }` marks a thrown error.
- A `scenario` has `config` (`bot` settings, inline `spreads`, optional `allocationPct`), an optional `settings` object for `runBot`, and ordered `steps`. Step ops: `open`, `close`, `fills`, `mark`, `journal`, `journalRaw`, `runBot`, `resetHalt`, `attribution`. `expected.steps` holds one result per step. `expected.final` holds the portfolio state after the last step. Wall-clock fields (timestamps) are not recorded.
- The age-based stale path of `markToMarket` depends on the wall clock and never fires in these scenarios. The unusable-quote stale path is recorded.
- All prices and instruments are synthetic (`SYNTH/USD`, `B/USD`, `C/USD`, `D/USD`, `OTHER/USD`). Nothing is recorded from live data.
- A change in the shape bumps `version`.

## Monitor area (`monitor.json`)

The position monitor rules are Go code (`platform/internal/monitor`, function `Step`), so this file is recorded and replayed in Go. The Node replay skips it.

- A case is a multi-bar scenario. `input` is `{ "kind": "step", "position", "bars": [ { "bar", "env" } ] }`.
- `position` is `{ side, entry, stop, target?, plan?, barsHeld?, best?, lastClose?, lastFired? }`. `plan` holds `invalidation`, `trail` (`{ kind: "atr" | "supertrend", mult }`), `maxBars` and `tripwires`. A missing `target` means no target, so no target exit fires. A missing `plan.invalidation` means no invalidation, so no invalidation exit fires. Every other missing number means 0.
- `bar` is `{ open, high, low, close }`. `env` is `{ atr, supertrend, halted, oppositeFlip, impulse, newsEscalation, feedStaleMinutes }`; a missing field is 0 or false.
- The replay feeds the bars in order and carries the returned position into the next bar. No bar follows an exit.
- `expected.steps` holds one result per bar: `{ position, exit?, trailed, fired? }`. `exit` is `{ price, reason }`. The recorded `position` omits `plan`, because `Step` never changes it; the replay asserts that instead.
- A `lastFired` key is the tripwire as compact JSON, its value the `barsHeld` count when it last fired. The replay compares keys as exact strings, so a port must build the same bytes: the fields in `domain.Tripwire` order (`kind`, `level`, `dir`, `pct`, `atr`, `bars`, `minProfitAtr`, `minutes`), zero and empty fields omitted, no whitespace, and numbers in the shortest round-trip form of Go `encoding/json`. Example: `{"kind":"close_beyond","level":99.5,"dir":"below"}`.
- Stop and target fills follow [the fill spec](../../docs/fill-spec.md). `Step` calls the shared Go function `fill.Check`.
- A ledger fill function can reuse the same shape: a position, ordered bars and one expected result per bar.

## Comparing numbers

The Node replay compares exactly. A consumer in another language, such as the Go reader `platform/internal/golden`, compares numbers with a relative tolerance of 1e-9 (absolute 1e-12 near zero). `NaN` and `Infinity` are written as `null`.

## Regenerating

```
node scripts/golden-fixtures.mjs           # verify: exit 1 when the engine output differs from the files
node scripts/golden-fixtures.mjs --write   # re-record after an intended engine change
```

Review the fixture diff like any other change: it is the behaviour change. `npm test` runs `test/golden.test.mjs`, which replays every indicators, portfolio and strategies case. The monitor cases replay in Go through `TestGoldenReplay`, the strategies cases also through `TestGoldenResolve`.

The monitor fixtures are recorded from Go:

```
cd platform
go test ./internal/monitor -run TestGoldenReplay            # verify
go test ./internal/monitor -run TestGoldenReplay -update    # re-record expected values after an intended rule change
```

The inputs live in `monitor.json`. `-update` rewrites only the expected values. `TestGoldenCoversEveryRuleBranch` fails when an exit reason, a trail kind or a tripwire kind has no recorded outcome.
