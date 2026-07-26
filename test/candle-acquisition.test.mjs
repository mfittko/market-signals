import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { acquireWindow, loadRecentCandles, storeCandles, TAIL_COUNT } from '../scripts/supertrend.mjs';

// #145: hermetic — the fetcher is injected, no network. A tiny M1 window (count:5)
// keeps the fixtures readable.
const T0 = Date.parse('2026-07-22T08:00:00Z');
const bar = (i, { complete = true } = {}) => ({
  time: new Date(T0 + i * 60000).toISOString(),
  open: 100 + i, high: 100 + i + 0.5, low: 100 + i - 0.5, close: 100 + i, volume: 10 + i, complete,
});
const tmp = (name) => fileURLToPath(new URL(`./tmp-acq-${name}.db`, import.meta.url));

test('acquireWindow: cold DB (< count warm bars) does a full backfill fetch', async () => {
  const dbPath = tmp('cold'); rmSync(dbPath, { force: true });
  let gotCount = null;
  const fetcher = async ({ count }) => { gotCount = count; return [bar(0), bar(1), bar(2), bar(3), bar(4), bar(5, { complete: false })]; };
  const r = await acquireWindow({ instrument: 'BCO/USD', granularity: 'M1', count: 5, db: dbPath }, { fetcher });
  assert.equal(r.mode, 'backfill', 'cold DB backfills');
  assert.equal(gotCount, 5, 'backfill fetches the full window');
  assert.equal(r.candles.length, 5, 'only complete bars in the window');
  assert.ok(r.candles.every((c) => c.complete), 'no forming bar in the window');
  assert.equal(r.forming.complete, false, 'forming bar returned separately');
  assert.equal(loadRecentCandles(dbPath, 'BCO/USD', 'M1', 10).length, 5, 'complete bars persisted (forming not)');
  rmSync(dbPath, { force: true });
});

test('acquireWindow: warm DB uses a small TAIL fetch and merges the new bar', async () => {
  const dbPath = tmp('warm'); rmSync(dbPath, { force: true });
  // seed a full 5-bar window (bars 0..4)
  storeCandles(dbPath, 'BCO/USD', 'M1', [bar(0), bar(1), bar(2), bar(3), bar(4)]);
  let gotCount = null;
  // tail returns the overlapping newest completes + a NEW complete bar 5 + forming 6
  const fetcher = async ({ count }) => { gotCount = count; return [bar(3), bar(4), bar(5), bar(6, { complete: false })]; };
  const r = await acquireWindow({ instrument: 'BCO/USD', granularity: 'M1', count: 5, db: dbPath }, { fetcher });
  assert.equal(r.mode, 'tail', 'warm DB takes the tail path');
  assert.equal(gotCount, TAIL_COUNT, 'routine tick fetches only the tail, not the full window');
  assert.equal(r.candles.length, 5, 'window stays capped at count');
  assert.equal(r.candles[r.candles.length - 1].time, bar(5).time, 'newest completed bar (5) merged in');
  assert.equal(r.candles[0].time, bar(1).time, 'oldest bar dropped to keep the window at count');
  assert.equal(r.forming.time, bar(6).time, 'forming bar surfaced separately');
  assert.equal(loadRecentCandles(dbPath, 'BCO/USD', 'M1', 10).length, 6, 'new complete bar persisted; forming not');
  rmSync(dbPath, { force: true });
});

test('acquireWindow: an unsorted (newest-first) tail still takes the tail path, no spurious backfill', async () => {
  const dbPath = tmp('unsorted'); rmSync(dbPath, { force: true });
  storeCandles(dbPath, 'BCO/USD', 'M1', [bar(0), bar(1), bar(2), bar(3), bar(4)]);
  // fetcher returns the tail NEWEST-first — the gap check must use the min time, not [0]
  const fetcher = async () => [bar(6, { complete: false }), bar(5), bar(4), bar(3)];
  const r = await acquireWindow({ instrument: 'BCO/USD', granularity: 'M1', count: 5, db: dbPath }, { fetcher });
  assert.equal(r.mode, 'tail', 'min-time gap check keeps the tail path despite newest-first ordering');
  assert.equal(r.candles[r.candles.length - 1].time, bar(5).time, 'new bar merged, window still sorted ascending');
  rmSync(dbPath, { force: true });
});

test('acquireWindow: a gap the tail cannot bridge forces a full backfill', async () => {
  const dbPath = tmp('gap'); rmSync(dbPath, { force: true });
  storeCandles(dbPath, 'BCO/USD', 'M1', [bar(0), bar(1), bar(2), bar(3), bar(4)]); // newest stored = bar 4
  let calls = 0; let lastCount = null;
  // tail jumps to bars 20..22 (downtime) — oldest tail (20) >> newest stored (4)
  const fetcher = async ({ count }) => {
    calls++; lastCount = count;
    if (count === TAIL_COUNT) return [bar(20), bar(21), bar(22), bar(23, { complete: false })];
    return [bar(19), bar(20), bar(21), bar(22), bar(23, { complete: false })]; // backfill window
  };
  const r = await acquireWindow({ instrument: 'BCO/USD', granularity: 'M1', count: 5, db: dbPath }, { fetcher });
  assert.equal(r.mode, 'backfill', 'gap triggers a reconcile backfill');
  assert.equal(calls, 2, 'tail probe then full backfill');
  assert.equal(lastCount, 5, 'the second fetch is the full window');
  rmSync(dbPath, { force: true });
});

test('acquireWindow: no DB → full fetch every time (prior behavior preserved)', async () => {
  let gotCount = null;
  const fetcher = async ({ count }) => { gotCount = count; return [bar(0), bar(1), bar(2, { complete: false })]; };
  const r = await acquireWindow({ instrument: 'BCO/USD', granularity: 'M1', count: 500 }, { fetcher });
  assert.equal(r.mode, 'full');
  assert.equal(gotCount, 500);
  assert.equal(r.candles.length, 2);
});

test('acquireWindow: the full/backfill path returns ascending time even if the fetcher is unsorted', async () => {
  const fetcher = async () => [bar(3), bar(1), bar(2, { complete: false }), bar(0)]; // shuffled, one forming
  const r = await acquireWindow({ instrument: 'BCO/USD', granularity: 'M1', count: 500 }, { fetcher });
  const times = r.candles.map((c) => Date.parse(c.time));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'window is sorted ascending regardless of fetcher order');
  assert.ok(r.candles.every((c) => c.complete), 'forming bar excluded from the window');
});

test('acquireWindow: repeated tail runs are idempotent (upsert keys, no dup rows)', async () => {
  const dbPath = tmp('idem'); rmSync(dbPath, { force: true });
  storeCandles(dbPath, 'BCO/USD', 'M1', [bar(0), bar(1), bar(2), bar(3), bar(4)]);
  const fetcher = async () => [bar(3), bar(4), bar(5), bar(6, { complete: false })];
  await acquireWindow({ instrument: 'BCO/USD', granularity: 'M1', count: 5, db: dbPath }, { fetcher });
  await acquireWindow({ instrument: 'BCO/USD', granularity: 'M1', count: 5, db: dbPath }, { fetcher });
  assert.equal(loadRecentCandles(dbPath, 'BCO/USD', 'M1', 20).length, 6, 'bars 0..5, no duplicates');
  rmSync(dbPath, { force: true });
});
