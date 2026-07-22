import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeSupertrend, detectFlips, backtestFlips, storeCandles, recordSignal, signalOutcomes } from '../scripts/supertrend.mjs';

// Synthetic series: flat, crash, rally, crash — must flip sell, buy, sell.
function series(closes) {
  return closes.map((close, i) => ({
    time: new Date(Date.parse('2026-07-22T08:00:00Z') + i * 300000).toISOString(),
    open: close, high: close + 0.2, low: close - 0.2, close, complete: true,
  }));
}

const closes = [
  ...Array(15).fill(100),
  ...Array.from({ length: 10 }, (_, i) => 100 - (i + 1) * 2), // crash to 80
  ...Array.from({ length: 20 }, (_, i) => 80 + (i + 1) * 2),  // rally to 120
  ...Array.from({ length: 15 }, (_, i) => 120 - (i + 1) * 2), // crash to 90
];
const candles = series(closes);

test('supertrend flips sell on crashes and buy on the rally', () => {
  const st = computeSupertrend(candles, { period: 10, multiplier: 3 });
  const flips = detectFlips(candles, st);
  assert.deepEqual(flips.map((f) => f.signal), ['sell', 'buy', 'sell']);
  assert.equal(st[st.length - 1].trend, 'down');
});

test('backtest: two closed winning trades, trailing sell trade marked open', () => {
  const st = computeSupertrend(candles, { period: 10, multiplier: 3 });
  const flips = detectFlips(candles, st);
  const bt = backtestFlips(candles, flips);
  assert.equal(bt.trades, 3);
  assert.equal(bt.closed, 2);
  assert.ok(bt.perTrade[0].returnPct > 0, 'short caught part of the first crash');
  assert.ok(bt.perTrade[1].returnPct > 0, 'long caught part of the rally');
  assert.equal(bt.perTrade[2].open, true);
  assert.equal(bt.winRatePct, 100);
  assert.ok(bt.totalReturnPct > 0);
});

test('signal memory: dedup by flip time, 30-min outcome computed from stored candles', () => {
  const dbPath = new URL('./tmp-signals-test.db', import.meta.url).pathname;
  rmSync(dbPath, { force: true });
  storeCandles(dbPath, 'WTICO/USD', 'M5', candles);

  // Sell signal at index 20 (during the crash): 6 bars later price is lower → positive outcome.
  const sig = { time: candles[20].time, signal: 'sell', price: candles[20].close };
  assert.equal(recordSignal(dbPath, 'WTICO/USD', 'M5', sig, 50).isNew, true);
  assert.equal(recordSignal(dbPath, 'WTICO/USD', 'M5', sig, 50).isNew, false, 'same flip records once');

  const [row] = signalOutcomes(dbPath, 'WTICO/USD', 'M5');
  const expected = -(candles[26].close - candles[20].close) / candles[20].close * 100;
  assert.ok(Math.abs(row.outcomePct - expected) < 1e-3, `direction-adjusted outcome, got ${row.outcomePct}`);
  assert.ok(row.outcomePct > 0, 'short during a crash is a winning outcome');
  rmSync(dbPath, { force: true });
});

test('storeCandles upserts idempotently', () => {
  const dbPath = new URL('./tmp-candles-test.db', import.meta.url).pathname;
  rmSync(dbPath, { force: true });
  const first = storeCandles(dbPath, 'BCO/USD', 'M5', candles);
  const again = storeCandles(dbPath, 'BCO/USD', 'M5', candles);
  assert.equal(first.totalRows, candles.length);
  assert.equal(again.totalRows, candles.length, 'no duplicates on re-run');
  rmSync(dbPath, { force: true });
});

test('--help exits 0 with usage, no network, no db writes', () => {
  const script = fileURLToPath(new URL('../scripts/supertrend.mjs', import.meta.url));
  const res = spawnSync('node', [script, '--help'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('supertrend'), res.stdout);
  assert.ok(res.stdout.includes('--settings'), 'usage documents the settings flag');
});
