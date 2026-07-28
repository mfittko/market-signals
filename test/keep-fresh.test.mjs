import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDb, storeCandles } from '../scripts/supertrend.mjs';
import {
  configuredCombos, comboUniverse, sweepAll, startKeepFresh,
  MAX_GAP_REPAIRS_PER_COMBO,
} from '../scripts/keep-fresh.mjs';
import { buildServer } from '../scripts/signal-server.mjs';

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

test('configuredCombos: watchers CSV ∪ bot.bots keys, normalized', () => {
  const cfg = { watchers: 'XAU/USD|M15', bot: { bots: { 'WTICO/USD | M5': {} } } };
  assert.deepEqual(
    configuredCombos(cfg).map((c) => `${c.instrument}|${c.granularity}`).sort(),
    ['WTICO/USD|M5', 'XAU/USD|M15'],
  );
});

test('configuredCombos: coerces a non-string watchers value instead of throwing', () => {
  assert.deepEqual(configuredCombos({ watchers: undefined }), []);
});

test('comboUniverse: union of configured combos and DISTINCT (instrument, granularity) pairs in candles — no cross-product fan-out', () => {
  const dbPath = tmpDb();
  const dir = mkdtempSync(join(tmpdir(), 'keep-fresh-cfg-'));
  storeCandles(dbPath, 'BCO/USD', 'M1', [candle(0)]);
  const settingsPath = settingsFile(dir, {
    watchers: 'XAU/USD|M15',
    bot: { bots: { 'WTICO/USD|M5': {} } },
  });
  assert.deepEqual(
    comboUniverse(dbPath, settingsPath).map((c) => `${c.instrument}|${c.granularity}`).sort(),
    ['BCO/USD|M1', 'WTICO/USD|M5', 'XAU/USD|M15'],
  );
});

test('sweepAll: skips a fresh combo (newest OPEN time within 2×granMs, bar-close aware) with no request', async () => {
  const dbPath = tmpDb();
  const dir = mkdtempSync(join(tmpdir(), 'keep-fresh-cfg-'));
  const granMs = 60000;
  const now = Date.now();
  // review pin: candle time is the bar OPEN — a fully-current series' newest
  // bar opened up to ~1×granMs ago, so seed at 1.5×granMs (fresh under the
  // 2×granMs rule, stale under the naive 1× rule this test guards against)
  storeCandles(dbPath, 'BCO/USD', 'M1', [candle(now - granMs * 1.5)]);
  const settingsPath = settingsFile(dir, { bot: { bots: { 'BCO/USD|M1': {} } } });
  let calls = 0;
  const fetcher = async () => { calls++; return []; };
  const res = await sweepAll(dbPath, settingsPath, { fetcher, now: () => now });
  assert.equal(calls, 0, 'no request for a fresh combo');
  assert.deepEqual(res, { fetched: 0, skipped: 1 });
});

test('sweepAll: a stale combo tail-fetches and stores the newest bars', async () => {
  const dbPath = tmpDb();
  const dir = mkdtempSync(join(tmpdir(), 'keep-fresh-cfg-'));
  const granMs = 60000;
  const now = Date.now();
  storeCandles(dbPath, 'BCO/USD', 'M1', [candle(now - granMs * 20)]); // stale
  const settingsPath = settingsFile(dir, { bot: { bots: { 'BCO/USD|M1': {} } } });
  const fetcher = async ({ instrument, granularity, count }) => {
    assert.equal(instrument, 'BCO/USD');
    assert.equal(granularity, 'M1');
    assert.ok(count > 0 && count <= 2500);
    return Array.from({ length: count }, (_, i) => candle(now - i * granMs)).reverse();
  };
  const res = await sweepAll(dbPath, settingsPath, { fetcher, now: () => now, attempted: new Set() });
  assert.deepEqual(res, { fetched: 1, skipped: 0 });
  const { n } = withDb(dbPath, (db) => db.prepare('SELECT COUNT(*) AS n FROM candles WHERE instrument=? AND granularity=?').get('BCO/USD', 'M1'));
  assert.ok(n > 1, 'newly fetched bars were stored alongside the stale one');
});

test('sweepAll: skips a combo the on-read path (lastLiveFetch) fetched within its own gate window', async () => {
  const dbPath = tmpDb();
  const dir = mkdtempSync(join(tmpdir(), 'keep-fresh-cfg-'));
  const granMs = 60000;
  const now = Date.now();
  storeCandles(dbPath, 'BCO/USD', 'M1', [candle(now - granMs * 20)]); // stale by the freshness rule alone
  const settingsPath = settingsFile(dir, { bot: { bots: { 'BCO/USD|M1': {} } } });
  let calls = 0;
  const fetcher = async () => { calls++; return []; };
  const lastLiveFetch = new Map([[`${dbPath}|BCO/USD|M1`, { at: now - 1000, tail: null }]]); // fetched 1s ago
  const res = await sweepAll(dbPath, settingsPath, { fetcher, now: () => now, lastLiveFetch, liveGateMs: 8000 });
  assert.equal(calls, 0, 'the on-read gate suppressed the request even though the stored bar is stale');
  assert.deepEqual(res, { fetched: 0, skipped: 1 });
});

test('sweepAll: one combo throwing does not stop the sweep (error isolation)', async () => {
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
  const res = await sweepAll(dbPath, settingsPath, { fetcher, now: () => now, attempted: new Set(), logFn: (m) => logs.push(m), delayMs: 0 });
  assert.deepEqual(touched, ['GOOD/USD']);
  assert.equal(res.fetched, 1);
  assert.ok(logs.some((l) => l.includes('BAD/USD') && l.includes('failed')));
});

test('sweepAll: caps gap repairs at MAX_GAP_REPAIRS_PER_COMBO per combo per sweep', async () => {
  const dbPath = tmpDb();
  const dir = mkdtempSync(join(tmpdir(), 'keep-fresh-cfg-'));
  const granMs = 60000;
  const now = Date.now();
  storeCandles(dbPath, 'BCO/USD', 'M1', [candle(now - granMs * 20)]);
  const settingsPath = settingsFile(dir, { bot: { bots: { 'BCO/USD|M1': {} } } });
  let gapFetches = 0;
  const fetcher = async ({ from, count }) => {
    if (from) { // a repairGap ranged fetch: return nothing so every gap "fails to close" and stays a gap
      gapFetches++;
      return [];
    }
    // the tail fetch: produce a series with 5×granMs spacing (> the 3×granMs
    // gap threshold) so more than MAX_GAP_REPAIRS_PER_COMBO gaps exist in the
    // fetched window
    const rows = [];
    for (let i = 0; i < count; i += 5) rows.push(candle(now - i * granMs));
    return rows.reverse();
  };
  await sweepAll(dbPath, settingsPath, { fetcher, now: () => now, attempted: new Set(), delayMs: 0 });
  assert.ok(gapFetches <= MAX_GAP_REPAIRS_PER_COMBO, `expected at most ${MAX_GAP_REPAIRS_PER_COMBO} gap-repair fetches, got ${gapFetches}`);
  assert.ok(gapFetches > 0, 'sanity: this fixture does produce gaps');
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
  // an explicitly-resolved deferred promise (not a timer race) gates the first
  // fetch, so the second tick's re-entry check is deterministic, not timing-based
  let releaseFirstFetch;
  const gate = new Promise((r) => { releaseFirstFetch = r; });
  const fetcher = async ({ count }) => {
    await gate;
    return Array.from({ length: count }, (_, i) => candle(Date.now() - i * 60000)).reverse();
  };
  const handle = startKeepFresh({ dbPath, settingsPath, fetcher });
  let firstSweepDone = false;
  const p1 = handle.tick().then(() => { firstSweepDone = true; });
  const p2 = handle.tick(); // must see inFlight and return immediately, before the gate releases
  await p2;
  assert.equal(firstSweepDone, false, 'the overlapping tick resolved before the in-flight sweep finished (guard, no re-entry)');
  releaseFirstFetch([]);
  await p1;
  handle.stop();
});

test('buildServer: server.on(close) stops the keep-fresh loop so no further ticks fire', async (t) => {
  const dbPath = tmpDb();
  const dir = mkdtempSync(join(tmpdir(), 'keep-fresh-cfg-'));
  storeCandles(dbPath, 'BCO/USD', 'M1', [candle(Date.now())]);
  const settingsPath = settingsFile(dir, { bot: { bots: { 'BCO/USD|M1': {} } } });
  let calls = 0;
  const fetcher = async () => { calls++; return []; };
  t.mock.timers.enable({ apis: ['setInterval'] });
  const server = buildServer({ dbPath, settingsPath, fetcher });
  await new Promise((resolve) => server.close(resolve)); // close before any tick fires
  t.mock.timers.tick(120000); // well past two 60s ticks, had the interval survived close()
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 0, 'no tick fired after close, even though the interval period elapsed');
});
