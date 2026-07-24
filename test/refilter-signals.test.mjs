import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeCandles, withDb } from '../scripts/supertrend.mjs';
import { runRefilter, parseArgs } from '../scripts/refilter-signals.mjs';

// Same synthetic series as supertrend.test.mjs: flat, crash, rally, crash —
// flips sell (index 20-ish), buy, sell, so there's a real reconstructable flip.
function series(closes) {
  return closes.map((close, i) => ({
    time: new Date(Date.parse('2026-07-22T08:00:00Z') + i * 300000).toISOString(),
    open: close, high: close + 0.2, low: close - 0.2, close, complete: true,
  }));
}
const closes = [
  ...Array(15).fill(100),
  ...Array.from({ length: 10 }, (_, i) => 100 - (i + 1) * 2), // crash to 80 (sell flip ~index 15)
  ...Array.from({ length: 20 }, (_, i) => 80 + (i + 1) * 2),  // rally to 120 (buy flip)
  ...Array.from({ length: 15 }, (_, i) => 120 - (i + 1) * 2), // crash to 90 (sell flip)
];
const candles = series(closes);

function fakeBin(dir, name, script) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

// Seeds candles + an errored signal row at a REAL flip (index 15, the sell flip).
function seedErroredSignal(dir) {
  const dbPath = join(dir, 'db.sqlite');
  storeCandles(dbPath, 'WTICO/USD', 'M5', candles);
  const flipTime = candles[15].time;
  const flipPrice = candles[15].close;
  withDb(dbPath, (db) => db.prepare(
    'INSERT INTO signals (instrument, granularity, time, signal, price, win_rate, verdict, reason, notified) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('WTICO/USD', 'M5', flipTime, 'sell', flipPrice, 50, 'alert', "filter error: Cannot read properties of null (reading 'match')", 1));
  return { dbPath, flipTime };
}

test('runRefilter: an errored signal at a real flip is updated to the fake provider\'s real verdict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refilter-'));
  const { dbPath, flipTime } = seedErroredSignal(dir);
  const piBin = fakeBin(dir, 'pi', `echo '{"alert": false, "reason": "chop, thin volume"}'`);
  const settings = { provider: 'pi', piBin };

  const summary = await runRefilter(dbPath, settings, { predicate: 'errored' });
  assert.equal(summary.scanned, 1);
  assert.equal(summary.updated.length, 1);
  assert.equal(summary.skipped.length, 0);
  assert.equal(summary.errored.length, 0);

  const row = withDb(dbPath, (db) => db.prepare('SELECT * FROM signals WHERE time=?').get(flipTime));
  assert.equal(row.verdict, 'suppress');
  assert.equal(row.reason, 'chop, thin volume');
  assert.equal(row.notified, 1, 'notified flag is untouched by a re-filter');
});

test('runRefilter: --dry-run computes the verdict but writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refilter-'));
  const { dbPath, flipTime } = seedErroredSignal(dir);
  const piBin = fakeBin(dir, 'pi', `echo '{"alert": true, "reason": "real signal"}'`);
  const settings = { provider: 'pi', piBin };

  const summary = await runRefilter(dbPath, settings, { predicate: 'errored', dryRun: true });
  assert.equal(summary.updated.length, 1, 'summary reports what WOULD change');
  assert.equal(summary.updated[0].to.verdict, 'alert');

  const row = withDb(dbPath, (db) => db.prepare('SELECT * FROM signals WHERE time=?').get(flipTime));
  assert.equal(row.verdict, 'alert');
  assert.match(row.reason, /filter error/, 'dry-run: original errored row untouched');
});

test('runRefilter: a signal whose stored flip cannot be reconstructed from the candles table is skipped, never fabricated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refilter-'));
  const dbPath = join(dir, 'db.sqlite');
  storeCandles(dbPath, 'WTICO/USD', 'M5', candles);
  // A "signal" at a time with no matching flip (flat region, no trend change).
  const bogusTime = candles[5].time;
  withDb(dbPath, (db) => db.prepare(
    'INSERT INTO signals (instrument, granularity, time, signal, price, win_rate, verdict, reason, notified) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('WTICO/USD', 'M5', bogusTime, 'sell', candles[5].close, 50, 'alert', 'filter error: boom', 1));
  const piBin = fakeBin(dir, 'pi', `echo '{"alert": true, "reason": "should never run"}'`);
  const settings = { provider: 'pi', piBin };

  const summary = await runRefilter(dbPath, settings, { predicate: 'errored' });
  assert.equal(summary.updated.length, 0);
  assert.equal(summary.skipped.length, 1);
  assert.match(summary.skipped[0].reason, /not reconstructable/);

  const row = withDb(dbPath, (db) => db.prepare('SELECT * FROM signals WHERE time=?').get(bogusTime));
  assert.equal(row.verdict, 'alert');
  assert.match(row.reason, /filter error/, 'unreconstructable row is left exactly as-is');
});

test('runRefilter: a re-filter call that itself errors leaves the row untouched and is reported separately', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refilter-'));
  const { dbPath, flipTime } = seedErroredSignal(dir);
  // Missing pi binary -> the llmVerdict call itself throws.
  const settings = { provider: 'pi', piBin: join(dir, 'missing-pi') };

  const summary = await runRefilter(dbPath, settings, { predicate: 'errored' });
  assert.equal(summary.updated.length, 0);
  assert.equal(summary.errored.length, 1);
  assert.equal(summary.errored[0].time, flipTime);

  const row = withDb(dbPath, (db) => db.prepare('SELECT * FROM signals WHERE time=?').get(flipTime));
  assert.equal(row.verdict, 'alert');
  assert.match(row.reason, /filter error/, 'a re-filter error never overwrites the existing row');
});

test('runRefilter: idempotent — re-running only touches rows still matching the predicate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refilter-'));
  const { dbPath, flipTime } = seedErroredSignal(dir);
  const piBin = fakeBin(dir, 'pi', `echo '{"alert": true, "reason": "real signal"}'`);
  const settings = { provider: 'pi', piBin };

  const first = await runRefilter(dbPath, settings, { predicate: 'errored' });
  assert.equal(first.updated.length, 1);
  const second = await runRefilter(dbPath, settings, { predicate: 'errored' });
  assert.equal(second.scanned, 0, 'row no longer matches the errored predicate — re-run touches nothing');

  const row = withDb(dbPath, (db) => db.prepare('SELECT * FROM signals WHERE time=?').get(flipTime));
  assert.equal(row.verdict, 'alert');
  assert.equal(row.reason, 'real signal');
});

test('runRefilter: --instrument/--granularity/--since/--limit narrow the predicate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refilter-'));
  const { dbPath } = seedErroredSignal(dir);
  // A second errored row for a different instrument, same db.
  withDb(dbPath, (db) => db.prepare(
    'INSERT INTO signals (instrument, granularity, time, signal, price, win_rate, verdict, reason, notified) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('BCO/USD', 'M5', candles[15].time, 'sell', candles[15].close, 50, 'alert', 'filter error: boom', 1));
  const piBin = fakeBin(dir, 'pi', `echo '{"alert": true, "reason": "ok"}'`);
  const settings = { provider: 'pi', piBin };

  const byInstrument = await runRefilter(dbPath, settings, { predicate: 'errored', instrument: 'WTICO/USD' });
  assert.equal(byInstrument.scanned, 1);

  const byLimit = await runRefilter(dbPath, settings, { predicate: 'errored', limit: 1 });
  assert.equal(byLimit.scanned, 1);
});

test('parseArgs: fails loud on an unknown flag (mirrors sentinel_briefing.mjs)', () => {
  assert.throws(() => parseArgs(['--nope', 'x']), /unknown flag/);
});

test('parseArgs: defaults + boolean/value flags parsed', () => {
  const out = parseArgs(['--db', 'x.db', '--predicate', 'errored', '--since', '2026-01-01', '--instrument', 'BCO/USD', '--granularity', 'M5', '--limit', '5', '--dry-run', '--json']);
  assert.equal(out.db, 'x.db');
  assert.equal(out.since, '2026-01-01');
  assert.equal(out.instrument, 'BCO/USD');
  assert.equal(out.granularity, 'M5');
  assert.equal(out.limit, 5);
  assert.equal(out.dryRun, true);
  assert.equal(out.json, true);
});

test('--help exits 0 with usage, no db access', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../scripts/refilter-signals.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'refilter-help-'));
  const res = spawnSync('node', [script, '--help'], { encoding: 'utf8', timeout: 20000, cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('refilter-signals'), res.stdout);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(dir, 'data')), false, '--help must not touch the db');
});
