import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeCandles, recordSignal, sendNotification } from '../scripts/supertrend.mjs';
import { buildServer, writeSettings, maskedSettings, chartData } from '../scripts/signal-server.mjs';

const INSTRUMENT = 'WTICO/USD';

function series(closes, startMs = Date.parse('2026-07-22T08:00:00Z')) {
  return closes.map((close, i) => ({
    time: new Date(startMs + i * 300000).toISOString(),
    open: close, high: close + 0.2, low: close - 0.2, close, volume: 10, complete: true,
  }));
}

function fixtureDb(dir) {
  const dbPath = join(dir, 'db.sqlite');
  const closes = [...Array(30).fill(100), ...Array.from({ length: 30 }, (_, i) => 100 - i)];
  const candles = series(closes);
  storeCandles(dbPath, INSTRUMENT, 'M5', candles);
  const sig = candles[40];
  recordSignal(dbPath, INSTRUMENT, 'M5', { time: sig.time, signal: 'sell', price: sig.close }, 42);
  return { dbPath, sigTime: sig.time };
}

async function withServer(dir, fn) {
  const { dbPath, sigTime } = fixtureDb(dir);
  const settingsPath = join(dir, 'settings.json');
  const server = buildServer({ dbPath, settingsPath, fetcher: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, sigTime, settingsPath, dbPath });
  } finally {
    server.close();
  }
}

test('GET / serves the self-contained chart page', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('<canvas'), 'has chart canvas');
    assert.ok(html.includes('<dialog id="cfgdlg"'), 'settings live in a dialog, hidden by default');
    assert.ok(html.includes('id="cfgbtn"'), 'gear button opens the settings modal');
    assert.ok(!/src=["']http/.test(html), 'no external assets');
  });
});

test('GET /api/chart returns candles, supertrend, and the deep-linked signal', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base, sigTime }) => {
    const d = await (await fetch(`${base}/api/chart?t=${encodeURIComponent(sigTime)}`)).json();
    assert.equal(d.instrument, INSTRUMENT);
    assert.ok(d.candles.length > 30, 'window around the signal');
    assert.ok(Date.parse(d.candles[d.candles.length - 1].time) >= Date.parse(sigTime) + 19 * 300000, 'deep-link window extends to the newest stored candle, not signal+36 bars');
    assert.ok(d.supertrend.length > 0, 'supertrend overlay computed');
    assert.equal(d.signal.time, sigTime);
    assert.equal(d.signal.signal, 'sell');
    assert.ok(d.signals.length >= 1, 'history included');
  });
});

test('settings round-trip: unknown keys rejected, secrets masked and preserved, atomic file', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base, settingsPath }) => {
    let res = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ provider: 'pi', OPENAI_API_KEY: 'sk-secret', port: 9000 }) });
    assert.equal(res.status, 200);
    const got = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(got.provider, 'pi');
    assert.equal(got.port, 9000);
    assert.equal(got.OPENAI_API_KEY, '•••', 'secret masked on read');
    assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).OPENAI_API_KEY, 'sk-secret', 'secret stored');

    // Re-saving the masked value must not clobber the stored secret.
    await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ OPENAI_API_KEY: '•••', model: 'x' }) });
    assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).OPENAI_API_KEY, 'sk-secret');

    res = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ nope: 1 }) });
    assert.equal(res.status, 400);
    res = await fetch(`${base}/api/settings`, { method: 'POST', body: 'not json' });
    assert.equal(res.status, 400);
    res = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ port: 'abc' }) });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).provider, 'pi', 'rejected writes never corrupt the file');
  });
});

test('chartData with no t returns the latest signal; empty db yields empty shapes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  const { dbPath } = fixtureDb(dir);
  const d = await chartData(dbPath, INSTRUMENT, { fetcher: null });
  assert.equal(d.signal.signal, 'sell');
  const empty = await chartData(join(dir, 'fresh.sqlite'), INSTRUMENT, { fetcher: null });
  assert.deepEqual(empty.candles, []);
  assert.equal(empty.signal, null);
});

test('stale data triggers a live refresh through the injected fetcher; fetch failure serves stale', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  const { dbPath } = fixtureDb(dir); // fixture times are hours old -> stale
  const fresh = series([200, 201], Date.now() - 600000).map((c) => ({ ...c, complete: true }));
  fresh[1] = { ...fresh[1], complete: false }; // the forming candle
  let calls = 0;
  const d = await chartData(dbPath, INSTRUMENT, { fetcher: async () => { calls++; return fresh; } });
  assert.equal(calls, 1, 'stale db pulled live candles once');
  assert.equal(d.quote.last, 201, 'forming candle drives the quote');
  assert.equal(d.quote.partial, true, 'quote marked partial');
  assert.equal(d.candles[d.candles.length - 1].partial, true, 'forming candle shown on the chart tail');
  // Second call: now fresh enough, no fetch.
  await chartData(dbPath, INSTRUMENT, { fetcher: async () => { calls++; return []; } });
  assert.equal(calls, 1, 'fresh db does not re-fetch');
  // Failure path: stale again with a throwing fetcher still serves stored data.
  const dir2 = mkdtempSync(join(tmpdir(), 'ss-'));
  const { dbPath: db2 } = fixtureDb(dir2);
  const d2 = await chartData(db2, INSTRUMENT, { fetcher: async () => { throw new Error('offline'); } });
  assert.equal(d2.quote.last, 71, 'stale view beats none');
});

test('writeSettings validates directly (unit)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  const p = join(dir, 's.json');
  assert.throws(() => writeSettings(p, [1]), /JSON object/);
  assert.throws(() => writeSettings(p, { port: 0 }), /port/);
  writeSettings(p, { provider: 'none' });
  assert.equal(maskedSettings(p).provider, 'none');
  writeSettings(p, { provider: '' }); // empty deletes
  assert.equal(maskedSettings(p).provider, undefined);
});

test('sendNotification prefers terminal-notifier with -open deep link, falls back to osascript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  const argsFile = join(dir, 'args.txt');
  const notifier = join(dir, 'terminal-notifier');
  writeFileSync(notifier, `#!/bin/sh\necho "$@" > ${argsFile}\n`);
  chmodSync(notifier, 0o755);

  sendNotification('WTI SELL @ 88.0', 'http://127.0.0.1:8787/?t=x', { notifierBin: notifier });
  const args = readFileSync(argsFile, 'utf8');
  assert.ok(args.includes('-open http://127.0.0.1:8787/?t=x'), args);
  assert.ok(args.includes('WTI SELL @ 88.0'), args);

  // Fallback: notifierBin missing → osascript path (shadowed via PATH, no real notification).
  const fakeOsa = join(dir, 'osascript');
  writeFileSync(fakeOsa, `#!/bin/sh\necho osascript-called > ${join(dir, 'osa.txt')}\n`);
  chmodSync(fakeOsa, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}:${prevPath}`;
  try {
    sendNotification('msg', 'http://x', { notifierBin: join(dir, 'missing') });
    assert.equal(readFileSync(join(dir, 'osa.txt'), 'utf8').trim(), 'osascript-called');
  } finally {
    process.env.PATH = prevPath;
  }
});

test('signal-server --help exits 0 with usage, no listen', () => {
  const script = fileURLToPath(new URL('../scripts/signal-server.mjs', import.meta.url));
  const res = spawnSync('node', [script, '--help'], { encoding: 'utf8', timeout: 20000, cwd: mkdtempSync(join(tmpdir(), 'ss-help-')) });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('signal-server'), res.stdout);
});

test('watcher fields round-trip and oversize body gets 413', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    let res = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ instrument: 'BCO/USD', granularity: 'M5', freshBars: 2 }) });
    assert.equal(res.status, 200);
    const got = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(got.instrument, 'BCO/USD');
    assert.equal(got.freshBars, 2);
    res = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ freshBars: -1 }) });
    assert.equal(res.status, 400);
    res = await fetch(`${base}/api/settings`, { method: 'POST', body: `{"model":"${'x'.repeat(70 * 1024)}"}` });
    assert.equal(res.status, 413);
  });
});

test('page escapes db-backed fields (no raw script injection vector)', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('const esc ='), 'esc helper present');
    assert.ok(!html.includes("+ s.reason +"), 'reason interpolations go through esc()');
  });
});

test('granularity flows: query param and settings default reach queries and response', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base, dbPath }) => {
    storeCandles(dbPath, INSTRUMENT, 'M15', series(Array(20).fill(50)));
    let d = await (await fetch(`${base}/api/chart?granularity=M15`)).json();
    assert.equal(d.granularity, 'M15');
    assert.equal(d.candles.length, 20, 'M15 candles served');
    // settings default picks up the configured watcher granularity
    await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ granularity: 'M15' }) });
    d = await (await fetch(`${base}/api/chart`)).json();
    assert.equal(d.granularity, 'M15');
  });
});

test('clearing port via empty string deletes it instead of 400', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ port: 9000 }) });
    const res = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ port: '' }) });
    assert.equal(res.status, 200);
    const got = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(got.port, undefined);
  });
});

test('deep link to a signal older than the history window still resolves', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base, dbPath }) => {
    // 60 newer signals push the old one out of the 50-row history window.
    const old = series([100], Date.parse('2026-07-01T00:00:00Z'))[0];
    storeCandles(dbPath, INSTRUMENT, 'M5', series(Array(10).fill(100), Date.parse('2026-07-01T00:00:00Z')));
    recordSignal(dbPath, INSTRUMENT, 'M5', { time: old.time, signal: 'buy', price: 100 }, 10);
    for (let i = 0; i < 60; i++) {
      recordSignal(dbPath, INSTRUMENT, 'M5', { time: new Date(Date.parse('2026-07-21T00:00:00Z') + i * 300000).toISOString(), signal: 'sell', price: 90 }, 10);
    }
    let d = await (await fetch(`${base}/api/chart?t=${encodeURIComponent(old.time)}`)).json();
    assert.ok(d.signal, 'old signal found via direct lookup');
    const short = old.time.replace('.000Z', 'Z').replace(/\.\d+Z$/, 'Z');
    d = await (await fetch(`${base}/api/chart?t=${encodeURIComponent(short)}`)).json();
    assert.ok(d.signal, 'second-precision t resolves via nanosecond variant');
    assert.equal(d.signal.time, old.time);
    assert.equal(d.signal.signal, 'buy');
  });
});

test('chart page ships the hover tooltip (self-contained, escaped fields)', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('id="tip"'), 'tooltip element present');
    assert.ok(html.includes("addEventListener('mousemove'"), 'hover handler wired');
    assert.ok(html.includes('supertrend '), 'tooltip includes supertrend detail');
    assert.ok(html.includes('maxVol'), 'volume underlay drawn');
    assert.ok(html.includes('d.flips'), 'flip markers drawn where the indicator fired');
    assert.ok(!/src=["']http/.test(html), 'still no external assets');
  });
});

test('/api/chart carries the current-course quote from the latest candles', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const d = await (await fetch(`${base}/api/chart`)).json();
    assert.ok(d.quote, 'quote present');
    assert.equal(d.quote.last, 71, 'last close of the fixture crash series');
    assert.ok(d.quote.dayHigh >= d.quote.dayLow);
    assert.ok(d.quote.supertrend && ['up', 'down'].includes(d.quote.supertrend.trend));
    assert.equal(typeof d.quote.change24hPct, 'number');
    // Deep-linked historical windows still quote the LATEST data.
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('id="quote"'), 'quote strip element present');
  });
});
