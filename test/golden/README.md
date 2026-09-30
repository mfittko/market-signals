# Golden fixtures

Recorded inputs and expected outputs of the Node engine. A port or refactor replays the inputs and compares with the expected values.

## Files

- `indicators.json`: Supertrend, ATR, ADX, RSI, EMA, MACD, Bollinger, VWAP, volume ratio, resampling, higher-timeframe Supertrend and the axis snapshot.
- `portfolio.json`: scenarios for sizing, fills, mark-to-market exits, halts, the drawdown kill-switch, the halt reset, attribution and the strategy scoreboard.

## Format (version 1)

Every file is plain JSON:

```
{ "version": 1, "area": "indicators" | "portfolio", "series": { "<name>": [candle, ...] }, "cases": [ { "name", "input", "expected" } ] }
```

- `series` exists only in `indicators.json`. A candle is `{ time, open, high, low, close, volume, complete }`. Times are ISO-8601 UTC.
- `input.kind` is `indicators`, `axis-snapshot` or `scenario`.
- `indicators` and `axis-snapshot` inputs name a `series`. Their expected values are the engine outputs; `null` marks a warm-up slot; `{ "error": "<message>" }` marks a thrown error.
- A `scenario` has `config` (`bot` settings, inline `spreads`, optional `allocationPct`), an optional `settings` object for `runBot`, and ordered `steps`. Step ops: `open`, `close`, `fills`, `mark`, `journal`, `journalRaw`, `runBot`, `resetHalt`, `attribution`. `expected.steps` holds one result per step. `expected.final` holds the portfolio state after the last step. Wall-clock fields (timestamps) are not recorded.
- The age-based stale path of `markToMarket` depends on the wall clock and never fires in these scenarios. The unusable-quote stale path is recorded.
- All prices and instruments are synthetic (`SYNTH/USD`). Nothing is recorded from live data.
- A change in the shape bumps `version`.

## Comparing numbers

The Node replay compares exactly. A consumer in another language compares numbers with a relative tolerance of 1e-9 (absolute 1e-12 near zero). `NaN` and `Infinity` are written as `null`.

## Regenerating

```
node scripts/golden-fixtures.mjs           # verify: exit 1 when the engine output differs from the files
node scripts/golden-fixtures.mjs --write   # re-record after an intended engine change
```

Review the fixture diff like any other change: it is the behaviour change. `npm test` runs `test/golden.test.mjs`, which replays every case.
