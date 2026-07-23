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
  const dbPath = fileURLToPath(new URL('./tmp-signals-test.db', import.meta.url));
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
  const dbPath = fileURLToPath(new URL('./tmp-candles-test.db', import.meta.url));
  rmSync(dbPath, { force: true });
  const first = storeCandles(dbPath, 'BCO/USD', 'M5', candles);
  const again = storeCandles(dbPath, 'BCO/USD', 'M5', candles);
  assert.equal(first.totalRows, candles.length);
  assert.equal(again.totalRows, candles.length, 'no duplicates on re-run');
  rmSync(dbPath, { force: true });
});

test('--help exits 0 with usage, no network, no db writes', () => {
  const script = fileURLToPath(new URL('../scripts/supertrend.mjs', import.meta.url));
  const cwd = mkdtempSync(join(tmpdir(), 'st-help-'));
  const res = spawnSync('node', [script, '--help'], { encoding: 'utf8', timeout: 20000, cwd });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('supertrend'), res.stdout);
  assert.ok(res.stdout.includes('--settings'), 'usage documents the settings flag');
  assert.equal(existsSync(join(cwd, 'data')), false, '--help must not create the data dir/db');
});

// --- processSignal: opt-in filter, fail-open, dedup (no real pi/osascript/network) ---
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processSignal } from '../scripts/supertrend.mjs';

function fakeBin(dir, name, script) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

function fixture(dir, { notify = true, settings = {} } = {}) {
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify(settings));
  const opts = { db: join(dir, 'db.sqlite'), instrument: 'WTICO/USD', granularity: 'M5', notify, settings: settingsPath };
  const result = {
    close: 88.0, trend: 'down', supertrend: 88.8,
    signal: { time: '2026-07-22T10:15:00Z', signal: 'sell', price: 88.35, barsAgo: 0, fresh: true },
    backtest: { winRatePct: 50, totalReturnPct: 1, trades: 4 },
  };
  return { opts, result, candles: candles.slice(0, 20) };
}

test('processSignal records fresh flips with notify off, and dedups', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const { opts, result, candles: c } = fixture(dir, { notify: false });
  const first = await processSignal(opts, result, c);
  assert.equal(first.sent, false);
  assert.match(first.reason, /recorded/);
  const [row] = signalOutcomes(opts.db, 'WTICO/USD', 'M5');
  assert.equal(row.signal, 'sell');
  const again = await processSignal(opts, result, c);
  assert.equal(again.reason, 'already processed');
});

test('processSignal suppresses when the filter says no (fake pi), no notification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const piBin = fakeBin(dir, 'pi', `echo "$@" > ${join(dir, 'pi-args.txt')}\necho '{"alert": false, "reason": "test suppress"}'`);
  const { opts, result, candles: c } = fixture(dir, { settings: { provider: 'pi', piBin } });
  const res = await processSignal(opts, result, c);
  assert.equal(res.sent, false);
  assert.match(res.reason, /suppressed by filter: test suppress/);
  assert.match(readFileSync(join(dir, 'pi-args.txt'), 'utf8'), /volumeContext/, 'filter payload carries volume context');
  const [row] = signalOutcomes(opts.db, 'WTICO/USD', 'M5');
  assert.equal(row.verdict, 'suppress');
  assert.equal(row.notified, 0);
});

test('processSignal fails open on filter error and records the verdict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  fakeBin(dir, 'osascript', 'exit 0'); // shadow real osascript via PATH
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}:${prevPath}`;
  try {
    const { opts, result, candles: c } = fixture(dir, { settings: { provider: 'pi', piBin: join(dir, 'missing-pi'), notifierBin: join(dir, 'missing-notifier') } });
    const res = await processSignal(opts, result, c);
    assert.equal(res.sent, true, res.reason);
    assert.equal(res.verdictSource, 'error');
    const [row] = signalOutcomes(opts.db, 'WTICO/USD', 'M5');
    assert.equal(row.verdict, 'alert');
    assert.match(row.reason, /filter error/);
    assert.equal(row.notified, 1);
  } finally {
    process.env.PATH = prevPath;
  }
});

test('parseWatchers: CSV combos with default granularity, falls back to single', async () => {
  const { parseWatchers } = await import('../scripts/supertrend.mjs');
  assert.deepEqual(parseWatchers({ watchers: 'WTICO/USD|M5, XAU/USD|M15, BCO/USD' }, { instrument: 'X', granularity: 'M5' }), [
    { instrument: 'WTICO/USD', granularity: 'M5' },
    { instrument: 'XAU/USD', granularity: 'M15' },
    { instrument: 'BCO/USD', granularity: 'M5' },
  ]);
  assert.deepEqual(parseWatchers({}, { instrument: 'WTICO/USD', granularity: 'M5' }), [{ instrument: 'WTICO/USD', granularity: 'M5' }]);
});

test('openaiEndpoint + explicit provider resolution (#42)', async () => {
  const { openaiEndpoint, resolveProvider } = await import('../scripts/supertrend.mjs');
  assert.equal(openaiEndpoint({}), 'https://api.openai.com/v1/chat/completions', 'default unchanged when unset');
  assert.equal(openaiEndpoint({ OPENAI_BASE_URL: 'http://localhost:8080/' }), 'http://localhost:8080/v1/chat/completions', 'trailing slash normalized');
  assert.equal(resolveProvider({ provider: 'openai', ANTHROPIC_API_KEY: 'x' }), 'openai', 'explicit choice beats key-derived resolution');
  assert.equal(resolveProvider({ provider: 'anthropic' }), 'anthropic');
  assert.equal(resolveProvider({ ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y' }), 'anthropic', 'legacy empty provider keeps key-derived behavior');
  assert.equal(resolveProvider({}), 'none');
});

test('OPENAI_BASE_URL drives the request URL and the model passes through unchanged (#42)', async () => {
  const { llmRequest } = await import('../scripts/supertrend.mjs');
  const { createServer } = await import('node:http');
  const hits = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ url: req.url, model: JSON.parse(body).model });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok-from-compatible' } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const out = await llmRequest({ provider: 'openai', OPENAI_API_KEY: 'k', OPENAI_BASE_URL: base, model: 'llama-3.3-70b-local' }, 'sys', 'user', { timeoutMs: 10000 });
    assert.equal(out, 'ok-from-compatible');
    assert.equal(hits[0].url, '/v1/chat/completions', 'compatible endpoint hit');
    assert.equal(hits[0].model, 'llama-3.3-70b-local', 'non-OpenAI model id passes through unchanged');
  } finally { srv.close(); }
});
