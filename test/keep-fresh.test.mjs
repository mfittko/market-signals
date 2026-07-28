import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDb, storeCandles } from '../scripts/supertrend.mjs';
import {
  CADENCE_MS, dueGranularities, instrumentUniverse, tailFetchCount,
  sweepCombo, sweepGranularity, startKeepFresh,
} from '../scripts/keep-fresh.mjs';

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'keep-fresh-'));
  const dbPath = join(dir, 'db.sqlite');
  withDb(dbPath, () => {}); // create schema
  return dbPath;
}
function settingsFile(dir, obj) {
  const p = join(dir, 'settings.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
function candle(ms) {
  return { time: new Date(ms).toISOString(), open: 70, high: 70.1, low: 69.9, close: 70, volume: 10, complete: true };
}

test('dueGranularities: a never-swept bucket is due immediately (cold start)', () => {
  assert.deepEqual(dueGranularities({}, 0).sort(), Object.keys(CADENCE_MS).sort());
});

test('dueGranularities: only buckets whose cadence has elapsed are due', () => {
  const lastSweepAt = { M1: 0, M5: 0, M15: 0, M30: 0, H1: 0, H4: 0 };
  const now = 6 * 60000; // 6 minutes: M1/M5 (5min cadence) due, M15/M30/H1/H4 not
  assert.deepEqual(dueGranularities(lastSweepAt, now).sort(), ['M1', 'M5']);
});

test('tailFetchCount: bounded by staleness, padded by 2, capped at 2500', () => {
  const granMs = 60000;
  assert.equal(tailFetchCount(5 * granMs, granMs), 7);
  assert.equal(tailFetchCount(granMs * 1e6, granMs), 2500);
  assert.equal(tailFetchCount(0, granMs), 2);
});

test('instrumentUniverse: union of bot combos, watchers, and DISTINCT candles instruments', () => {
  const dbPath = tmpDb();
  const dir = mkdtempSync(join(tmpdir(), 'keep-fresh-cfg-'));
  storeCandles(dbPath, 'BCO/USD', 'M1', [candle(0)]);
  const settingsPath = settingsFile(dir, {
    watchers: 'XAU/USD|M15',
    bot: { bots: { 'WTICO/USD|M5': {} } },
  });
  assert.deepEqual(instrumentUniverse(dbPath, settingsPath).sort(), ['BCO/USD', 'WTICO/USD', 'XAU/USD']);
});

test('sweepCombo: skip-when-fresh issues no request when the newest stored bar is within one period', async () => {
  const dbPath = tmpDb();
  const granMs = 60000;
  const now = Date.now();
  storeCandles(dbPath, 'BCO/USD', 'M1', [candle(now - granMs / 2)]);
  let calls = 0;
  const fetcher = async () => { calls++; return []; };
  const logs = [];
  const res = await sweepCombo(dbPath, 'BCO/USD', 'M1', { fetcher, now: () => now, log: (m) => logs.push(m) });
  assert.equal(calls, 0, 'no request for a fresh combo');
  assert.equal(res.fetched, false);
  assert.ok(logs.some((l) => l.includes('skip') && l.includes('fresh')));
});

test('sweepCombo: a stale combo tail-fetches and stores the newest bars', async () => {
  const dbPath = tmpDb();
  const granMs = 60000;
  const now = Date.now();
  storeCandles(dbPath, 'BCO/USD', 'M1', [candle(now - granMs * 20)]); // stale
  const fetcher = async ({ instrument, granularity, count }) => {
    assert.equal(instrument, 'BCO/USD');
    assert.equal(granularity, 'M1');
    assert.ok(count > 0 && count <= 2500);
    return Array.from({ length: count }, (_, i) => candle(now - i * granMs)).reverse();
  };
  const res = await sweepCombo(dbPath, 'BCO/USD', 'M1', { fetcher, now: () => now, attempted: new Set() });
  assert.equal(res.fetched, true);
  assert.ok(res.stored > 0);
  const { n } = withDb(dbPath, (db) => db.prepare('SELECT COUNT(*) AS n FROM candles WHERE instrument=? AND granularity=?').get('BCO/USD', 'M1'));
  assert.ok(n > 1, 'newly fetched bars were stored alongside the stale one');
});

test('sweepGranularity: one combo throwing does not stop the sweep (error isolation)', async () => {
  const dbPath = tmpDb();
  const dir = mkdtempSync(join(tmpdir(), 'keep-fresh-cfg-'));
  const settingsPath = settingsFile(dir, { bot: { bots: { 'BAD/USD|M1': {}, 'GOOD/USD|M1': {} } } });
  const now = Date.now();
  const touched = [];
  const fetcher = async ({ instrument, count }) => {
    if (instrument === 'BAD/USD') throw new Error('provider blew up');
    touched.push(instrument);
    return Array.from({ length: count }, (_, i) => candle(now - i * 60000)).reverse();
  };
  const logs = [];
  await sweepGranularity(dbPath, settingsPath, 'M1', { fetcher, now: () => now, attempted: new Set(), log: (m) => logs.push(m), delayMs: 0 });
  assert.deepEqual(touched, ['GOOD/USD']);
  assert.ok(logs.some((l) => l.includes('BAD/USD') && l.includes('failed')));
});

test('startKeepFresh: fetcher:null (fixture) never creates a timer / never sweeps', async () => {
  const dbPath = tmpDb();
  const dir = mkdtempSync(join(tmpdir(), 'keep-fresh-cfg-'));
  const settingsPath = settingsFile(dir, {});
  const handle = startKeepFresh({ dbPath, settingsPath, fetcher: null });
  await handle.tick(); // no-op, must not throw or call anything
  handle.stop();
  assert.ok(true, 'no throw with a null fetcher');
});

test('startKeepFresh: keepFresh:false disables the sweep on the very next tick', async () => {
  const dbPath = tmpDb();
  const dir = mkdtempSync(join(tmpdir(), 'keep-fresh-cfg-'));
  storeCandles(dbPath, 'BCO/USD', 'M1', [candle(Date.now() - 20 * 60000)]);
  const settingsPath = settingsFile(dir, { keepFresh: false, bot: { bots: { 'BCO/USD|M1': {} } } });
  let calls = 0;
  const fetcher = async () => { calls++; return []; };
  const handle = startKeepFresh({ dbPath, settingsPath, fetcher, now: () => Date.now() });
  await handle.tick();
  handle.stop();
  assert.equal(calls, 0, 'keepFresh:false blocks the sweep even though a combo is due');
});

test('startKeepFresh: an overlapping tick returns immediately instead of re-entering an in-flight sweep', async () => {
  const dbPath = tmpDb();
  const dir = mkdtempSync(join(tmpdir(), 'keep-fresh-cfg-'));
  storeCandles(dbPath, 'BCO/USD', 'M1', [candle(Date.now() - 20 * 60000)]);
  const settingsPath = settingsFile(dir, { bot: { bots: { 'BCO/USD|M1': {} } } });
  const fetcher = async ({ count }) => {
    await new Promise((r) => setTimeout(r, 30));
    return Array.from({ length: count }, (_, i) => candle(Date.now() - i * 60000)).reverse();
  };
  const handle = startKeepFresh({ dbPath, settingsPath, fetcher });
  let firstSweepDone = false;
  const p1 = handle.tick().then(() => { firstSweepDone = true; });
  let secondSawFirstStillRunning = null;
  const p2 = handle.tick().then(() => { secondSawFirstStillRunning = !firstSweepDone; });
  await p2;
  assert.equal(secondSawFirstStillRunning, true, 'the overlapping tick resolved (guard, no re-entry) before the in-flight sweep finished');
  await p1;
  handle.stop();
});
