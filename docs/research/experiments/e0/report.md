# E0: WTICO/USD M1 Supertrend baseline

Status: baseline, run 2026-11-23. This report claims no edge and no profitable strategy.

E0 is the first cost-aware baseline under the engine reuse decision in `docs/research/engine-reuse-decision.md`. Entries use the Go ledger entry rule (`ledger.EntryPrice`), and exits use the Go fill rule (`fill.Check`).

## Contract and manifest

The frozen contract is `docs/research/experiments/e0/spec.json`. It holds the instrument, feed, dataset and experiment specs.

| Item | Value |
|---|---|
| Instrument | WTICO/USD, quote currency USD |
| Feed | M1 bars, separate bid and ask OHLC per bar, time is the bar open in UTC |
| Dataset | one-time owner export of the `candles_ba` table, not committed |
| Dataset sha256 | `4177965517fb5697dd8579844c3960cc030f20bd5800d45fac46b1f38b26f488` |
| Dataset rows | 1,293,832 |
| Dataset range | 2023-01-02T23:00:00Z to 2026-09-30T23:59:00Z |
| Spec sha256 | `940781b54d0e10ae4af98ce45229eae758a287927d2559c6721664e625547eb1` |

The loader refuses a dataset whose sha256 does not match the manifest. The spec parser refuses a cost or timing value that is not labelled assumed or measured.

## Rules

- Signal: a Supertrend flip (period 10, multiplier 3) on the bid bars. The ATR for the stop comes from the same bid bars.
- Decision delay: the decision exists 2,212 ms after the flip bar closes. An entry fills at the open of the first bar that starts at or after the decision time. Without missing bars, this is the second bar after the flip bar.
- Entry: a long enters at the ask open, a short at the bid open.
- Exits: a stop at 1.5 ATR, a target at 2 R, a reversal on the opposite flip (it fills at the open of the first bar at or after that flip's decision time), or a time stop after 200 bars. A long exits on bid bars, a short on ask bars. A bar that touches both the stop and the target exits at the stop.
- Financing: one day of financing at each 17:00 America/New_York rollover that a position holds across.
- A candle revision after a decision is unavailable to that decision.

## Declared values

| Value | Setting | Label | Source |
|---|---|---|---|
| Spread | per-bar bid and ask prices | measured | the export's bid and ask OHLC |
| Commission | 0 | assumed | `docs/fill-spec.md`, Spread and cost |
| Financing basis | 4.7% a year | assumed | mean of the 2023 to 2025 DTB3 annual averages in `docs/research/data.md` |
| Financing markup | 2.5% a year | assumed | the OANDA financing costs page in `docs/research/sources.md` |
| Rollover time | 17:00 America/New_York | assumed | the OANDA financing costs page in `docs/research/sources.md` |
| Decision delay | 2,212 ms | measured | the maximum completion delay in https://github.com/mfittko/market-signals/pull/153 |

## Run

From `platform/`:

```
go run ./cmd/research-e0 -spec ../docs/research/experiments/e0/spec.json -data <path to the export CSV> -out <artifact JSON path>
```

Two runs with the network denied gave the identical artifact sha256 `beb389bd41e55beeadb881419e85ce3831d711fd58c86ead2c829204a42a0a58`.

## Results

All results are in R, the distance from entry to the initial stop. Net results include the spread and financing.

| Measure | Value |
|---|---|
| Supertrend flips | 40,068 |
| Trades | 37,373 |
| Win rate | 13.7% |
| Mean net result | -0.83 R |
| Total net result | -30,891 R |
| Profit factor | 0.24 |
| Financing, total | 12.8 R over 93 trades that held across a rollover |
| Entry spread, 25th / 50th / 75th percentile | 0.33 / 0.56 / 1.09 R |

By exit reason:

| Exit | Trades | Mean net result |
|---|---|---|
| Stop | 31,400 | -1.29 R |
| Target | 4,879 | 2.03 R |
| Reversal | 1,094 | -0.39 R |
| Time | 0 | n/a |

By year: 2023 -0.72 R, 2024 -0.98 R, 2025 -1.03 R, 2026 (to 2026-09-30) -0.48 R per trade.

By side: longs -0.82 R, shorts -0.84 R per trade.

## Reading

The median entry spread is 0.56 R, so the spread alone costs about half of the risk on a typical trade. With a stop of 1.5 ATR on M1 bars, 84% of trades end at the stop. E0 therefore measures the cost of trading this rule on M1 bars. It is a floor for later experiments to beat.

## Limits

- One instrument, one granularity and one parameter set. No parameter search ran.
- Commission, the financing basis, the markup and the rollover time are assumed, as the table states.
- The decision delay is one measured maximum, applied to every decision.
- The Go Supertrend port was not cross-checked against the Node implementation on the real export.
- The export is a single snapshot, so its own revisions are not tested.
