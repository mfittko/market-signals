import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeCandles, recordSignal, sendNotification, withDb } from '../scripts/supertrend.mjs';
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

// Mirrors bot.mjs's journalBot DDL/insert (not exported) — just enough to seed
// a decision row for the matching logic under test.
function seedDecision(dbPath, { instrument = INSTRUMENT, granularity = 'M5', at, action = 'hold', reasoning = 'held' } = {}) {
  withDb(dbPath, (db) => {
    db.exec('CREATE TABLE IF NOT EXISTS bot_journal (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, position_id INTEGER, reason TEXT, context TEXT)');
    db.prepare('INSERT INTO bot_journal (at, action, position_id, reason, context) VALUES (?,?,NULL,?,?)')
      .run(at, 'decision', reasoning, JSON.stringify({ instrument, granularity, event: 'flip', decision: { action, reasoning } }));
  });
}

test('modal chrome (#56): every dialog closes via a top-right X; settings plumbing collapses behind advanced', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const page = await (await fetch(base + '/')).text();
    for (const id of ['pfdlg', 'botdlg', 'cfgdlg']) {
      const start = page.indexOf('<dialog id="' + id + '"');
      assert.ok(start >= 0, id + ' dialog exists');
      const end = page.indexOf('</dialog>', start);
      assert.ok(end > start, id + ' dialog is closed');
      const dlg = page.slice(start, end);
      assert.ok(dlg.includes('class="dlg-x"'), id + ' has a top-right X');
      assert.ok(!/<button[^>]*>\s*close\s*<\/button>/i.test(dlg.replace(/class="dlg-x"[^>]*>×/, '')), id + ' has no bottom close button');
    }
    assert.ok(!page.includes('dlg-close'), 'legacy bottom close style gone');
    assert.match(page, /const ADV_FIELDS = \[\['instrument'/, 'plumbing fields render behind the advanced disclosure');
    for (const k of ['watchers', 'provider', 'model']) assert.ok(page.includes("['" + k + "'"), k + ' stays a primary field');
  });
});

test('header structure: two rows — pfMini right-clusters on row 1, indicators live in hdr2 after the bot button (#63)', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const page = await (await fetch(base + '/')).text();
    const hdr = page.slice(page.indexOf('<header id="topbar">'), page.indexOf('</header>'));
    const hdr2 = hdr.slice(hdr.indexOf('<span id="hdr2">'));
    assert.ok(hdr.indexOf('id="pfMini"') < hdr.indexOf('id="pfBtn"'), 'insights precede the portfolio button on row 1');
    assert.ok(hdr.indexOf('id="pfBtn"') < hdr.indexOf('id="cfgbtn"'), 'settings is the last row-1 control');
    assert.ok(hdr.indexOf('id="cfgbtn"') < hdr.indexOf('id="hdr2"'), 'row 2 comes after all row-1 controls');
    assert.ok(hdr2.includes('id="indbar"') && hdr2.indexOf('id="botBtn"') < hdr2.indexOf('id="indbar"'), 'indicators sit in hdr2 after the bot button');
    const auto = /margin-left:\s*auto/;
    assert.ok(!auto.test(page.match(/#cfgbtn \{[^}]*\}/)[0]), 'single auto-margin: only pfMini pushes the right cluster');
    assert.match(page.match(/#pfMini \{[^}]*\}/)[0], auto);
    assert.match(page.match(/#indbar \{[^}]*\}/)[0], auto);
  });
});

test('GET / serves the self-contained chart page', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('<canvas'), 'has chart canvas');
    assert.ok(html.includes('<dialog id="cfgdlg"'), 'settings live in a dialog, hidden by default');
    assert.ok(html.includes('id="cfgbtn"'), 'gear button opens the settings modal');
    assert.ok(html.includes('id="instSel"') && html.includes('id="granSel"'), 'instrument + granularity selectors in the header');
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
    assert.ok(Array.isArray(d.instruments) && d.instruments.includes(INSTRUMENT), 'instrument list served for the selector');
  });
});

test('settings round-trip: unknown keys rejected, secrets masked and preserved, atomic file', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base, settingsPath }) => {
    let res = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ provider: 'pi', OPENAI_API_KEY: 'sk-secret', port: 9000 }) });
    assert.equal(res.status, 200);
    const got = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(got.provider, 'pi');
    assert.equal(got.activeProvider, 'pi', 'resolved provider surfaced');
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
  // Second call inside the gate window: no re-fetch, but the cached forming candle still serves.
  const d2b = await chartData(dbPath, INSTRUMENT, { fetcher: async () => { calls++; return []; } });
  assert.equal(calls, 1, 'gate window prevents a second upstream fetch');
  assert.equal(d2b.quote.last, 201, 'cached forming candle still drives the quote while the gate is closed');
  assert.equal(d2b.quote.partial, true);
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

test('sendNotification: explicit notifierBin is authoritative — used when present, SUPPRESSES when missing (no phantom osascript)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  const argsFile = join(dir, 'args.txt');
  const notifier = join(dir, 'terminal-notifier');
  writeFileSync(notifier, `#!/bin/sh\necho "$@" > ${argsFile}\n`);
  chmodSync(notifier, 0o755);

  sendNotification('WTI SELL @ 88.0', 'http://127.0.0.1:8787/?t=x', { notifierBin: notifier });
  const args = readFileSync(argsFile, 'utf8');
  assert.ok(args.includes('-open http://127.0.0.1:8787/?t=x'), args);
  assert.ok(args.includes('WTI SELL @ 88.0'), args);

  // Explicitly configured but MISSING → deliberate suppression: no osascript
  // fallback (this is how tests silence notifications; the old fallback made
  // every test run pop phantom AppleScript notifications with fixture numbers).
  const fakeOsa = join(dir, 'osascript');
  writeFileSync(fakeOsa, `#!/bin/sh\necho osascript-called > ${join(dir, 'osa.txt')}\n`);
  chmodSync(fakeOsa, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}:${prevPath}`;
  try {
    sendNotification('msg', 'http://x', { notifierBin: join(dir, 'missing') });
    assert.ok(!existsSync(join(dir, 'osa.txt')), 'no osascript fallback for a configured-but-missing notifier');
  } finally {
    process.env.PATH = prevPath;
  }
});

test('sendNotification: MS_NO_NOTIFY suppresses unconfigured fallbacks but not an explicitly-configured existing notifierBin (#71)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  const fakeOsa = join(dir, 'osascript');
  writeFileSync(fakeOsa, `#!/bin/sh\necho osascript-called > ${join(dir, 'osa.txt')}\n`);
  chmodSync(fakeOsa, 0o755);
  const prevPath = process.env.PATH;
  const prevGuard = process.env.MS_NO_NOTIFY;
  process.env.PATH = `${dir}:${prevPath}`;
  process.env.MS_NO_NOTIFY = '1';
  try {
    // Nothing configured → suppressed, no candidate (terminal-notifier/osascript) spawn.
    sendNotification('WTI SELL @ 88.0', 'http://x', {});
    assert.ok(!existsSync(join(dir, 'osa.txt')), 'MS_NO_NOTIFY blocks the unconfigured osascript fallback');

    // Explicitly configured + existing (a recorder fixture) → still delivered.
    const argsFile = join(dir, 'args.txt');
    const notifier = join(dir, 'terminal-notifier');
    writeFileSync(notifier, `#!/bin/sh\necho "$@" > ${argsFile}\n`);
    chmodSync(notifier, 0o755);
    sendNotification('WTI SELL @ 88.0', 'http://127.0.0.1:8787/?t=x', { notifierBin: notifier });
    assert.ok(readFileSync(argsFile, 'utf8').includes('WTI SELL @ 88.0'), 'a configured, existing notifierBin still delivers under MS_NO_NOTIFY');
  } finally {
    process.env.PATH = prevPath;
    if (prevGuard === undefined) delete process.env.MS_NO_NOTIFY; else process.env.MS_NO_NOTIFY = prevGuard;
  }
});

test('signal-server --help exits 0 with usage, no listen', () => {
  const script = fileURLToPath(new URL('../scripts/signal-server.mjs', import.meta.url));
  const res = spawnSync('node', [script, '--help'], { encoding: 'utf8', timeout: 20000, cwd: mkdtempSync(join(tmpdir(), 'ss-help-')) });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('signal-server'), res.stdout);
});

test('viewing a combo lazily backfills historical flips, sparing the watcher-fresh window', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base, dbPath }) => {
    // Fresh M15 series with a crash old enough to be historical.
    const closes = [...Array(20).fill(50), ...Array.from({ length: 20 }, (_, i) => 50 - i)];
    const start = Date.now() - 40 * 900000; // 40 M15 bars ago
    storeCandles(dbPath, INSTRUMENT, 'M15', closes.map((c, i) => ({
      time: new Date(start + i * 900000).toISOString(), open: c, high: c + 0.2, low: c - 0.2, close: c, volume: 5, complete: true,
    })));
    const d = await (await fetch(`${base}/api/chart?granularity=M15`)).json();
    assert.ok(d.flips.length >= 1, 'fixture produces flips');
    assert.ok(d.signals.length >= 1, 'flips backfilled into signal history');
    assert.equal(d.signals[0].verdict, 'backfill');
    assert.equal(typeof d.signals[0].outcomePct, 'number', 'outcome computed from stored candles');
    // Idempotent: second view adds nothing.
    const d2 = await (await fetch(`${base}/api/chart?granularity=M15`)).json();
    assert.equal(d2.signals.length, d.signals.length);
    // Any flip inside the fresh+cooldown horizon must NOT be backfilled (watcher owns it).
    const horizon = Date.now() - 6 * 900000;
    assert.ok(d.signals.every((s) => Date.parse(s.time) < horizon), 'fresh window left to the watcher');
  });
});

test('configured instruments CSV drives the selector list', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ instruments: 'WTICO/USD, BCO/USD , XAU/USD' }) });
    const d = await (await fetch(`${base}/api/chart`)).json();
    assert.deepEqual(d.instruments, ['WTICO/USD', 'BCO/USD', 'XAU/USD']);
  });
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
    assert.equal(d.isLatestSignal, false, '#70 follow-up: deep-linked historical signal is never the latest');
    const short = old.time.replace('.000Z', 'Z').replace(/\.\d+Z$/, 'Z');
    d = await (await fetch(`${base}/api/chart?t=${encodeURIComponent(short)}`)).json();
    assert.ok(d.signal, 'second-precision t resolves via nanosecond variant');
    assert.equal(d.signal.time, old.time);
    assert.equal(d.signal.signal, 'buy');
    assert.equal(d.isLatestSignal, false);

    const latest = await (await fetch(`${base}/api/chart`)).json();
    assert.equal(latest.isLatestSignal, true, 'no ?t deep-link — the latest view is always the latest signal');

    const latestDeepLink = await (await fetch(`${base}/api/chart?t=${encodeURIComponent(latest.signal.time)}`)).json();
    assert.equal(latestDeepLink.isLatestSignal, true, 'deep-linking to the latest signal itself still counts as latest');
  });
});

test('chart page ships the hover tooltip (self-contained, escaped fields)', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('/vendor/chart.umd.js'), 'Chart.js vendored locally');
    assert.ok(html.includes("type: 'candlestick'"), 'candlestick renderer');
    assert.ok(html.includes('supertrend '), 'tooltip includes supertrend detail');
    assert.ok(html.includes("yAxisID: 'vol'"), 'volume underlay dataset');
    assert.ok(html.includes('d.flips'), 'flip markers drawn where the indicator fired');
    assert.ok(html.includes("type: 'timeseries'"), 'x/y scales configured');
    assert.ok(!/src=["']http/.test(html), 'no external (network) assets');
  });
});

test('vendored chart assets serve locally; unknown vendor 404s', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    for (const f of ['chart.umd.js', 'chartjs-adapter-date-fns.bundle.min.js', 'chartjs-chart-financial.min.js']) {
      const res = await fetch(`${base}/vendor/${f}`);
      assert.equal(res.status, 200, f);
      assert.match(res.headers.get('content-type'), /javascript/);
    }
    assert.equal((await fetch(`${base}/vendor/evil.js`)).status, 404);
    assert.equal((await fetch(`${base}/vendor/..%2Fsupertrend.mjs`)).status, 404);
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

test('watch toggle: watchers CSV round-trips and the chart response carries watched state', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    let d = await (await fetch(`${base}/api/chart`)).json();
    assert.equal(d.watched, false);
    await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ watchers: `${INSTRUMENT}|M5, XAU/USD|M15` }) });
    d = await (await fetch(`${base}/api/chart`)).json();
    assert.equal(d.watched, true, 'current combo is watched');
    assert.deepEqual(d.watchers, [`${INSTRUMENT}|M5`, 'XAU/USD|M15']);
    d = await (await fetch(`${base}/api/chart?granularity=M15`)).json();
    assert.equal(d.watched, false, 'same instrument, different granularity: not watched');
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('id="watchBtn"'), 'bell toggle present');
  });
});

// --- chat sidebar: threads + messages + SSE with a fake pi provider ---
function sseEvents(text) {
  return text.split('\n\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
}

test('chat: SSE reply via fake pi, thread auto-created, context + messages persisted, delete cascades', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  await withServer(dir, async ({ base, settingsPath }) => {
    const piBin = join(dir, 'pi');
    writeFileSync(piBin, `#!/bin/sh\necho "Floor holds at 87.7, ceiling 88.8."\n`);
    chmodSync(piBin, 0o755);
    writeFileSync(settingsPath, JSON.stringify({ provider: 'pi', piBin }));

    const res = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ message: 'worth re-entering short here?', instrument: INSTRUMENT, granularity: 'M5' }) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = sseEvents(await res.text());
    const done = events.find((e) => e.type === 'done');
    assert.ok(done, 'done event');
    assert.match(done.reply, /Floor holds/);
    const threadEv = events.find((e) => e.type === 'thread');
    assert.equal(threadEv.title, 'worth re-entering short here?');

    const scopeQs = `instrument=${encodeURIComponent(INSTRUMENT)}&granularity=M5`;
    const { threads } = await (await fetch(`${base}/api/threads?${scopeQs}`)).json();
    assert.equal(threads.length, 1);
    assert.equal(threads[0].messages, 2, 'user + assistant persisted');
    assert.equal(threads[0].instrument, INSTRUMENT, 'new thread stamped with its view instrument');
    assert.equal(threads[0].granularity, 'M5', 'new thread stamped with its view granularity');

    const { messages } = await (await fetch(`${base}/api/messages?thread=${done.threadId}`)).json();
    assert.equal(messages[0].role, 'user');
    const ctx = JSON.parse(messages[0].context);
    assert.equal(ctx.view.instrument, INSTRUMENT, 'context snapshot attached');
    assert.ok(ctx.viewCandles.length >= 60, 'full current-view candles in context, not a tail slice');
    assert.equal(ctx.view.candleTimesAreLocal, true);
    assert.equal(ctx.view.traderTimezone, 'UTC', 'tz defaults to UTC when client omits it');
    assert.ok(ctx.quote && typeof ctx.quote.last === 'number', 'quote in context');
    assert.equal(typeof ctx.traderNotes, 'string', 'notes tail attached to context');
    assert.equal(messages[1].role, 'assistant');

    // Follow-up in the same thread includes history and persists more rows.
    const res2 = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ threadId: done.threadId, message: 'and the stop? \u{1F4C9} \u00e9\u00e9' }) });
    sseEvents(await res2.text());
    const after = await (await fetch(`${base}/api/messages?thread=${done.threadId}`)).json();
    assert.equal(after.messages.length, 4);

    // A stamped thread cannot be continued from a different view; legacy NULL threads can.
    const cross = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ threadId: done.threadId, message: 'wrong view', instrument: INSTRUMENT, granularity: 'M1' }) });
    assert.equal(cross.status, 409, 'cross-view thread reuse rejected');

    await fetch(`${base}/api/threads?id=${done.threadId}`, { method: 'DELETE' });
    const gone = await (await fetch(`${base}/api/threads?${scopeQs}`)).json();
    assert.equal(gone.threads.length, 0);
    const emptied = await (await fetch(`${base}/api/messages?thread=${done.threadId}`)).json();
    assert.equal(emptied.messages.length, 0, 'messages cascade-deleted');
  });
});

test('chat context transmits localized timestamps (#34): tz applied, invalid tz falls back to UTC', async () => {
  const { localTimeFormatters } = await import('../scripts/supertrend.mjs');
  const f = localTimeFormatters('Etc/GMT-2'); // fixed UTC+2, DST-free
  assert.equal(f.hm('2026-07-22T18:17:00Z'), '20:17', 'chart-axis time, not UTC');
  assert.equal(f.full('2026-07-22T18:17:00Z'), '22/07 20:17', 'single shared DD/MM HH:MM encoding');
  assert.equal(localTimeFormatters('No/Such_Zone').tz, 'UTC', 'invalid tz falls back');

  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  await withServer(dir, async ({ base }) => {
    const piBin = join(dir, 'pi');
    writeFileSync(piBin, '#!/bin/sh\necho ok\n');
    chmodSync(piBin, 0o755);
    await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ provider: 'pi', piBin }) });
    const res = await fetch(base + '/api/chat', { method: 'POST', body: JSON.stringify({ message: 'time check', tz: 'Etc/GMT-2', instrument: INSTRUMENT, granularity: 'M5' }) });
    const done = sseEvents(await res.text()).find((e) => e.type === 'done');
    const { messages } = await (await fetch(base + '/api/messages?thread=' + done.threadId)).json();
    const ctx = JSON.parse(messages[0].context);
    assert.equal(ctx.view.candleTimesAreLocal, true);
    assert.equal(ctx.view.traderTimezone, 'Etc/GMT-2');
    assert.equal(ctx.viewCandles[0].t, '10:00', 'first fixture candle 08:00Z shown as 10:00 local');
    assert.match(ctx.signal.time, /^22\/07 \d{2}:\d{2}$/, 'signal time carries date + local time (DD/MM)');
    assert.match(ctx.signalHistory[0].time, /^22\/07 /, 'history localized with date part');
  });
});

test('chat: no provider configured yields a clear 400; provider errors persist as error role', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  await withServer(dir, async ({ base, settingsPath }) => {
    let res = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ message: 'hi' }) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /no chat provider/);

    writeFileSync(settingsPath, JSON.stringify({ provider: 'pi', piBin: join(dir, 'missing-pi') }));
    res = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ message: 'hi' }) });
    const events = sseEvents(await res.text());
    const errEv = events.find((e) => e.type === 'error');
    assert.ok(errEv, 'error event delivered in-stream');
    const { messages } = await (await fetch(`${base}/api/messages?thread=${errEv.threadId}`)).json();
    assert.equal(messages[1].role, 'error', 'provider failure persisted without losing the thread');
  });
});

test('page ships the chat sidebar', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('<aside>'), 'sidebar present');
    assert.ok(html.includes('id="threadBar"') && html.includes('id="chatForm"'), 'thread bar + input');
    assert.ok(html.includes('threadSel') && html.includes('delThread'), 'timestamped thread select + delete-after-selection');
    assert.ok(html.includes('function md('), 'markdown renderer for assistant messages');
    assert.ok(html.includes('openai (compatible via base URL)'), 'provider select is explicit (pi/anthropic/openai/none)');
    assert.ok(html.includes('@media (max-width: 900px)'), 'responsive: sidebar stacks underneath on narrow screens');
    assert.ok(html.includes('text/event-stream') === false, 'client parses stream via fetch reader');
  });
});

test('chat: unknown threadId is rejected, provider errors stay short (no prompt leak)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  await withServer(dir, async ({ base, settingsPath }) => {
    writeFileSync(settingsPath, JSON.stringify({ provider: 'pi', piBin: join(dir, 'missing-pi') }));
    let res = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ threadId: 999, message: 'hi' }) });
    assert.equal(res.status, 404);
    assert.equal((await fetch(`${base}/api/threads`, { method: 'DELETE' })).status, 400, 'DELETE without id rejected');
    assert.equal((await fetch(`${base}/api/messages`)).status, 400, 'messages without thread rejected');
    res = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ message: 'hi' }) });
    const errEv = sseEvents(await res.text()).find((e) => e.type === 'error');
    assert.ok(errEv.error.length < 250, 'sanitized error');
    assert.ok(!errEv.error.includes('context:'), 'prompt not leaked into the error');
  });
});

test('served page <script> parses as valid JS (template-literal escape guard)', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const html = await (await fetch(base + '/')).text();
    const src = html.match(/<script>([\s\S]*)<\/script>/)[1];
    const dir = mkdtempSync(join(tmpdir(), 'ss-page-'));
    writeFileSync(join(dir, 'page.js'), src);
    const res = spawnSync('node', ['--check', join(dir, 'page.js')], { encoding: 'utf8' });
    assert.equal(res.status, 0, `served page JS is broken:\n${res.stderr.slice(0, 400)}`);
  });
});

test('chat tools: registry executes with clamped args, rejects unknown tools and bad input', async () => {
  const { CHAT_TOOLS, execChatTool } = await import('../scripts/signal-server.mjs');
  assert.deepEqual(CHAT_TOOLS.map((t) => t.name), ['fxempire_articles', 'truthsocial_posts', 'live_rates', 'save_strategy', 'save_memory', 'save_gate_prompt']);
  for (const t of CHAT_TOOLS) assert.equal(t.input_schema.additionalProperties, false, t.name);
  assert.throws(() => execChatTool('nope', {}), /unknown tool/);
  assert.throws(() => execChatTool('live_rates', { market: 'commodities', slugs: 'x; rm -rf /' }), /invalid slugs/);
  assert.throws(() => execChatTool('live_rates', { market: 'evil', slugs: 'gold' }), /invalid market/);
  // Regression: the executors spawn via execFileSync/process.execPath — a tool
  // whose spawn path is broken must throw a real spawn error, not ReferenceError.
  try {
    execChatTool('fxempire_articles', { hours: 1, maxItems: 1 });
  } catch (err) {
    assert.ok(!/is not defined/.test(err.message), `executor wiring broken: ${err.message}`);
  }
});

test('mutating routes reject cross-origin requests (CSRF guard), same-origin and CLI pass', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    let res = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ model: 'x' }), headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    res = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ message: 'hi' }), headers: { origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
    res = await fetch(`${base}/api/threads?id=1`, { method: 'DELETE', headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    res = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ model: 'x' }), headers: { origin: 'http://127.0.0.1:8787' } });
    assert.equal(res.status, 200, 'same-origin passes');
    res = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ model: 'y' }) });
    assert.equal(res.status, 200, 'no-origin CLI passes');
  });
});

test('portfolio endpoint is GET-only: reads serve, every mutation verb is rejected', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const ok = await (await fetch(base + '/api/portfolio')).json();
    assert.equal(ok.ok, true);
    assert.equal(ok.portfolio.equity, 10000, 'fresh virtual portfolio at starting balance');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await fetch(base + '/api/portfolio', { method, body: '{}' });
      assert.equal(r.status, 405, method + ' rejected: bot-only trades');
    }
  });
});

test('chat threads are view-scoped: stamped on create, filtered per view, legacy NULL threads visible everywhere', async () => {
  const { listThreads, resolveView } = await import('../scripts/signal-server.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  await withServer(dir, async ({ base, dbPath }) => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS chat_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, created_at TEXT NOT NULL)`);
    db.prepare('INSERT INTO chat_threads (title, created_at) VALUES (?,?)').run('legacy', '2026-07-01T00:00:00Z');
    db.close();

    assert.deepEqual(
      listThreads(dbPath, { instrument: 'WTICO/USD', granularity: 'M5' }).map((t) => t.title),
      ['legacy'], 'pre-migration thread survives ALTER and stays visible in a scoped view');

    const { DatabaseSync: DS } = await import('node:sqlite');
    const db2 = new DS(dbPath);
    db2.prepare('INSERT INTO chat_threads (title, created_at, instrument, granularity) VALUES (?,?,?,?)')
      .run('wti-m5', '2026-07-22T10:00:00Z', 'WTICO/USD', 'M5');
    db2.prepare('INSERT INTO chat_threads (title, created_at, instrument, granularity) VALUES (?,?,?,?)')
      .run('spx-m1', '2026-07-22T11:00:00Z', 'SPX500/USD', 'M1');
    db2.close();

    const wti = await (await fetch(base + '/api/threads?instrument=WTICO/USD&granularity=M5')).json();
    assert.deepEqual(wti.threads.map((t) => t.title).sort(), ['legacy', 'wti-m5'], 'scoped list = own view + legacy');
    const spx = await (await fetch(base + '/api/threads?instrument=SPX500/USD&granularity=M1')).json();
    assert.deepEqual(spx.threads.map((t) => t.title).sort(), ['legacy', 'spx-m1']);
    assert.deepEqual(resolveView({}, 'bad instrument!', 'X9'), resolveView({}), 'invalid view input falls back to defaults');
    const dflt = await (await fetch(base + '/api/threads')).json();
    assert.deepEqual(dflt.threads.map((t) => t.title).sort(), ['legacy', 'wti-m5'], 'no params scopes to settings-default view');
  });
});

test('thread titles evolve from the model annotation (#38): stripped, applied on change, SSE event, no-op without it', async () => {
  const { extractThreadTitle } = await import('../scripts/signal-server.mjs');
  assert.deepEqual(extractThreadTitle('Answer text.\n<!--title: WTI short setup-->'), { text: 'Answer text.', title: 'WTI short setup' });
  assert.deepEqual(extractThreadTitle('No annotation here'), { text: 'No annotation here', title: null });
  assert.equal(extractThreadTitle('x\n<!--title: ' + 'y'.repeat(90) + '-->').title.length, 48, 'clamped');
  assert.equal(extractThreadTitle('mid <!--title: nope--> stream').title, null, 'only a trailing annotation counts');
  assert.equal(extractThreadTitle('x\r\n<!--title: crlf reply-->').title, 'crlf reply', 'CRLF before the annotation accepted');
  assert.equal(extractThreadTitle('x\n<!--title: A > B breakout-->').title, 'A > B breakout', 'titles may contain >');
  assert.equal(extractThreadTitle('x\n<!--title: never closed').title, null, 'missing --> is a silent no-op');
  assert.equal(extractThreadTitle('x\n<!--title: line one\nline two-->').title, null, 'multiline title is a silent no-op');
  assert.equal(extractThreadTitle('x\n<!--title: -->').title, null, 'empty title is a no-op');
  assert.equal(extractThreadTitle('hard break  \n<!--title: t-->').text, 'hard break  ', 'markdown hard-break spaces survive extraction');

  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  await withServer(dir, async ({ base, settingsPath }) => {
    const piBin = join(dir, 'pi');
    writeFileSync(piBin, '#!/bin/sh\ncat > /dev/null\nprintf "Floor holds.\\n<!--title: floor check-->\\n"\n');
    chmodSync(piBin, 0o755);
    writeFileSync(settingsPath, JSON.stringify({ provider: 'pi', piBin }));
    const res = await fetch(base + '/api/chat', { method: 'POST', body: JSON.stringify({ message: 'does the floor hold?', instrument: INSTRUMENT, granularity: 'M5' }) });
    const events = sseEvents(await res.text());
    const done = events.find((e) => e.type === 'done');
    assert.equal(done.reply, 'Floor holds.', 'annotation stripped from the reply');
    const titleEv = events.find((e) => e.type === 'title');
    assert.equal(titleEv.title, 'floor check', 'title event emitted');
    const { threads } = await (await fetch(base + '/api/threads?instrument=' + encodeURIComponent(INSTRUMENT) + '&granularity=M5')).json();
    assert.equal(threads[0].title, 'floor check', 'thread renamed');
    const { messages } = await (await fetch(base + '/api/messages?thread=' + done.threadId)).json();
    assert.ok(!messages[1].content.includes('<!--title'), 'persisted assistant message is clean');
  });
});

test('served client stripTitleTail behaves correctly as DELIVERED (escape-drift guard)', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const html = await (await fetch(base + '/')).text();
    const m = html.match(/const stripTitleTail = \(t\) => \{[\s\S]*?\n\};/);
    assert.ok(m, 'client stripTitleTail found in the served page');
    const stripTitleTail = new Function(`${m[0]}; return stripTitleTail;`)();
    assert.equal(stripTitleTail('Answer.\n<!--title: done-->'), 'Answer.');
    assert.equal(stripTitleTail('Answer.\n<!--title: partial stream'), 'Answer.');
    assert.equal(stripTitleTail('Answer.\n<!--tit'), 'Answer.');
    assert.equal(stripTitleTail('legit <!--note--> stays put'), 'legit <!--note--> stays put');
    assert.equal(stripTitleTail('explains <!--title: x--> then more'), 'explains <!--title: x--> then more');
    assert.equal(stripTitleTail('ends with <e'), 'ends with <e', 'non-prefix tails untouched');
  });
});

test('portfolio UI (#24): endpoints GET-only, page ships read-only views, P&L agrees with the engine to the cent', async () => {
  const { botConfig, instrumentSpread, openPosition, closePosition } = await import('../scripts/portfolio.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  await withServer(dir, async ({ base, dbPath }) => {
    const cfg = botConfig({ bot: { riskPct: 100 } });
    const id = openPosition(dbPath, cfg, { instrument: INSTRUMENT, side: 'long', notional: 1000, price: 87, stop: 85, target: 90, reason: 'flip long on **volume**' });
    closePosition(dbPath, cfg, id, 88, 'target');
    openPosition(dbPath, cfg, { instrument: INSTRUMENT, side: 'short', notional: 500, price: 88, reason: 'rejection at **resistance**' });

    const pf = (await (await fetch(base + '/api/portfolio')).json()).portfolio;
    const expectedRealized = (88 - (87 + instrumentSpread(cfg, INSTRUMENT))) * (1000 / 87);
    assert.ok(Math.abs(pf.trades[0].realized - expectedRealized) < 0.005, 'realized matches engine to the cent');
    assert.ok(Math.abs(pf.equity - (pf.cash + pf.marginLocked + pf.unrealized)) < 1e-9, 'equity identity holds in the API payload');

    assert.equal(pf.positions[0].reason, 'rejection at **resistance**', 'open position exposes its journaled opening reasoning');
    const tr = await (await fetch(base + '/api/bot-trades?limit=1')).json();
    assert.equal(tr.trades.length, 1);
    assert.equal(tr.trades[0].close_reason, 'target');
    const zero = await fetch(base + '/api/bot-trades?limit=0');
    assert.equal((await zero.json()).trades.length, 1, 'limit=0 falls back to default, not zero rows');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await fetch(base + '/api/bot-trades', { method, body: '{}' })).status, 405, method + ' rejected');
    }

    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('<details id="pf"'), 'collapsible portfolio section present');
    assert.ok(html.includes('<dialog id="pfdlg"'), 'portfolio modal present');
    assert.ok(html.includes('id="pfSpark"'), 'equity sparkline canvas present');
    const script = html.slice(html.indexOf('<script>'));
    assert.ok(!/fetch\((['"])\/api\/(?:portfolio|bot-trades)\1[^)]*method/.test(script), 'no mutating fetch wired to portfolio routes (either quote style)');
  });
});

test('strategy management (#25): chat drafts never activate, human activation via same-origin POST, bot uses the active strategy', async () => {
  const { activeStrategy, saveStrategy } = await import('../scripts/strategies.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  await withServer(dir, async ({ base, dbPath, settingsPath }) => {
    const piBin = join(dir, 'pi');
    writeFileSync(piBin, `#!/bin/sh\ncat > /dev/null\necho '{"tool":"save_strategy","input":{"name":"chat-draft","prompt":"Draft from chat with enough length to pass validation checks."}}'\necho done\n`);
    chmodSync(piBin, 0o755);
    writeFileSync(settingsPath, JSON.stringify({ provider: 'pi', piBin }));

    // list seeds exactly once and reports no active strategy
    const l1 = await (await fetch(base + '/api/strategies')).json();
    assert.equal(l1.strategies.length, 1, 'seed shipped');
    assert.equal(l1.activeId, null, 'seed inactive');

    // save_strategy tool executes draft-only (direct registry call, db ctx)
    const { execChatTool } = await import('../scripts/signal-server.mjs');
    const out = JSON.parse(execChatTool('save_strategy', { name: 'chat-draft', prompt: 'Draft from chat with enough length to pass validation checks.' }, { dbPath }));
    assert.equal(out.version, 1);
    assert.match(out.note, /NOT active/);
    assert.equal(activeStrategy(dbPath), null, 'drafting cannot activate');

    // activation endpoint: POST works same-origin, GET is not a route
    const act = await (await fetch(base + '/api/strategies/activate', { method: 'POST', body: JSON.stringify({ id: out.id }) })).json();
    assert.equal(act.ok, true);
    assert.equal(activeStrategy(dbPath).id, out.id);
    const cross = await fetch(base + '/api/strategies/activate', { method: 'POST', body: JSON.stringify({ id: out.id }), headers: { origin: 'https://evil.example' } });
    assert.equal(cross.status, 403, 'cross-origin activation rejected');
    const bad = await (await fetch(base + '/api/strategies/activate', { method: 'POST', body: JSON.stringify({ id: 99999 }) })).json();
    assert.equal(bad.ok, false);

    // the bot deliberates with the ACTIVE strategy and journals its id+version
    const { runBot } = await import('../scripts/bot.mjs');
    const { botConfig, portfolioView } = await import('../scripts/portfolio.mjs');
    const holdBin = join(dir, 'pi2');
    writeFileSync(holdBin, '#!/bin/sh\ncat > /dev/null\necho \'{"action":"hold","reasoning":"per strategy"}\'\n');
    chmodSync(holdBin, 0o755);
    const botSettings = { provider: 'pi', piBin: holdBin, bot: { enabled: true, riskPct: 100 } };
    await runBot(dbPath, botSettings, { instrument: INSTRUMENT, granularity: 'M5', candle: { open: 87, high: 87.1, low: 86.9, close: 87, time: '2026-07-23T08:00:00Z' }, quote: { last: 87 }, freshFlip: { signal: 'buy' } });
    const jd = JSON.parse(portfolioView(dbPath, botConfig(botSettings)).journal.find((j) => j.action === 'decision').context);
    assert.equal(jd.strategyId, out.id, 'journal pins the active strategy id');
    assert.equal(jd.strategyDbVersion, 1);
    assert.equal(jd.strategyName, 'chat-draft');

    // page ships the bot settings section
    const html = await (await fetch(base + '/')).text();
    assert.ok(!html.includes('id="botcfg"'), 'settings dialog no longer carries the bot row (#49)');
    assert.ok(html.includes('id="pfBtn"'), 'header portfolio button always present');
    assert.ok(html.includes('id="botBtn"'), 'contextual bot icon in the header');
    assert.ok(html.includes('id="botdlg"'), 'per-combo bot modal shipped');
    assert.ok(html.includes('data-tab="overview"') && html.includes('id="botList"') && html.includes('id="haltBanner"'), 'portfolio overview with activated-bots list + halt banner');
    assert.ok(!html.includes('id="botAdd"') && !html.includes('id="botTable"'), 'editable bots table removed from the read-only portfolio modal');

    // settings whitelist accepts the bot object, rejects junk bot keys
    const okSet = await (await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { enabled: false, riskPct: 2 } }) })).json();
    assert.equal(okSet.error, undefined, 'bot object accepted (settings write returns masked settings, no error)');
    const badSet = await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { evil: 1 } }) });
    assert.equal(badSet.status, 400, 'unknown bot keys rejected');
    // deep-merge: partial bot saves keep stored keys the form doesn't carry
    await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { leverage: { 'WTICO/USD': 12 }, maxPositions: 5 } }) });
    await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { riskPct: 3 } }) });
    const merged = JSON.parse(readFileSync(settingsPath, 'utf8')).bot;
    assert.equal(merged.riskPct, 3);
    assert.equal(merged.maxPositions, 5, 'partial save preserves maxPositions');
    assert.deepEqual(merged.leverage, { 'WTICO/USD': 12 }, 'partial save preserves the leverage map');
    await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { maxPositions: null } }) });
    assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).bot.maxPositions, undefined, 'null deletes a bot key');
  });
});

test('dedicated per-combo strategies (#75): /api/strategies id lookup + manual draft POST, cross-origin rejected, scope carried', async () => {
  const { saveStrategy } = await import('../scripts/strategies.mjs');
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base, dbPath }) => {
    const st = saveStrategy(dbPath, {
      name: 'xag-scalper', prompt: 'Scalp XAG on confirmed flips only, tight stop, no chop.',
      spec: { schema_version: 1, entry: { minAxesAligned: 2 }, exit: { stopAtr: 1 } },
      instrument: 'XAG/USD', granularity: 'M5', dedicated: true,
    });
    const full = await (await fetch(base + '/api/strategies?id=' + st.id)).json();
    assert.equal(full.strategy.prompt, 'Scalp XAG on confirmed flips only, tight stop, no chop.', 'full prompt (not the 120-char preview) is served');
    assert.deepEqual(full.strategy.spec, { schema_version: 1, entry: { minAxesAligned: 2 }, exit: { stopAtr: 1 } }, 'spec round-trips parsed, not a JSON string');
    assert.equal(full.strategy.dedicated, 1);
    assert.equal(full.strategy.instrument, 'XAG/USD');

    const missing = await fetch(base + '/api/strategies?id=999999');
    assert.equal(missing.status, 404);
    const badId = await fetch(base + '/api/strategies?id=nope');
    assert.equal(badId.status, 400);

    // manual draft save (bot-modal inline edit path): new INACTIVE version
    const saved = await (await fetch(base + '/api/strategies', { method: 'POST', body: JSON.stringify({ name: 'xag-scalper', prompt: 'Scalp XAG, revised chop filter, tighter stop discipline.', dedicated: true, instrument: 'XAG/USD', granularity: 'M5' }) })).json();
    assert.equal(saved.ok, true);
    assert.equal(saved.strategy.version, 2);
    const list = await (await fetch(base + '/api/strategies')).json();
    assert.equal(list.strategies.find((s) => s.id === saved.strategy.id).active, 0, 'manual draft never activates itself');

    const invalid = await (await fetch(base + '/api/strategies', { method: 'POST', body: JSON.stringify({ name: 'bad', prompt: 'too short' }) })).json();
    assert.equal(invalid.ok, false);

    const cross = await fetch(base + '/api/strategies', { method: 'POST', body: JSON.stringify({ name: 'evil', prompt: 'x'.repeat(30) }), headers: { origin: 'https://evil.example' } });
    assert.equal(cross.status, 403, 'cross-origin strategy save rejected (same-origin guard applies to every non-GET route)');
  });
});

test('/api/strategies?id= a malformed stored spec never throws/500s — structured null-spec + specError (review fix)', async () => {
  const { withDb } = await import('../scripts/supertrend.mjs');
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base, dbPath }) => {
    const { saveStrategy } = await import('../scripts/strategies.mjs');
    const st = saveStrategy(dbPath, { name: 'corrupt-spec', prompt: 'A strategy whose stored spec column got hand-edited into garbage.' });
    // bypass saveStrategy's validation to simulate an older/manually-edited row with non-JSON spec
    withDb(dbPath, (db) => db.prepare('UPDATE strategies SET spec=? WHERE id=?').run('{not valid json', st.id));

    const res = await fetch(base + '/api/strategies?id=' + st.id);
    assert.equal(res.status, 200, 'malformed spec must never 500 the handler');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.strategy.spec, null, 'unparseable spec surfaces as null, not a thrown error');
    assert.match(body.strategy.specError, /not valid JSON/, 'structured error flag explains why');
    assert.equal(body.strategy.prompt.startsWith('A strategy whose stored spec'), true, 'the rest of the row is still served');
  });
});

test('save_strategy scope defaulting from the current view (#75): dedicated drafts default instrument/granularity, chat copy points at the bot modal', async () => {
  const { execChatTool } = await import('../scripts/signal-server.mjs');
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ dbPath }) => {
    const out = JSON.parse(execChatTool('save_strategy', { name: 'view-scoped', prompt: 'Dedicated strategy for the currently viewed combo, holds otherwise.', dedicated: true }, { dbPath, view: { instrument: 'XAG/USD', granularity: 'M5' } }));
    assert.match(out.note, /bot modal/, 'chat confirmation copy points at the bot modal, not settings (#75 decision 6)');
    const { strategyById } = await import('../scripts/strategies.mjs');
    const row = strategyById(dbPath, out.id);
    assert.equal(row.instrument, 'XAG/USD', 'scope defaulted from ctx.view since dedicated was requested without an explicit combo');
    assert.equal(row.granularity, 'M5');
    assert.equal(row.dedicated, 1);

    // non-dedicated saves never pick up a scope from the view — shared/unscoped stays the default
    const shared = JSON.parse(execChatTool('save_strategy', { name: 'shared-copilot-strat', prompt: 'A shared strategy usable on any watched combo, holds when unclear.' }, { dbPath, view: { instrument: 'XAG/USD', granularity: 'M5' } }));
    assert.equal(strategyById(dbPath, shared.id).instrument, null);

    // an explicit instrument/granularity always wins over the view default
    const explicit = JSON.parse(execChatTool('save_strategy', { name: 'explicit-scope', prompt: 'Dedicated to a different combo than the current view, holds otherwise.', dedicated: true, instrument: 'WTICO/USD', granularity: 'H1' }, { dbPath, view: { instrument: 'XAG/USD', granularity: 'M5' } }));
    assert.equal(strategyById(dbPath, explicit.id).instrument, 'WTICO/USD');
  });
});

test('bot modal ships setup + strategy tabs (#75 structural)', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('id="botdlg"'), 'per-combo bot modal shipped');
    assert.match(html, /data-tab="setup"[\s\S]{0,200}data-tab="strategy"/, 'bot modal carries setup + strategy tabs, setup first');
    assert.ok(html.includes('id="bm-setup"') && html.includes('id="bm-strategy"'), 'both tab bodies present');
    assert.match(html, /bmStratSel/, 'scope-filtered strategy assignment select present');
    assert.match(html, /bmShowAll/, '"show all" scope-escape checkbox present');
    assert.match(html, /assigning to /, 'scope mismatch warning copy present');
    assert.match(html, /bmActivate/, 'per-version activate control present');
    assert.match(html, /bmSaveVersion/, 'inline edit → new version control present');
  });
});

test('bmWarn (UI review finding 1) is driven by the RESOLVED botState.strategyName, not the raw settings name, and options flag draft/no-active-version names', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const html = await (await fetch(base + '/')).text();
    // the setup-tab warning span must gate on botStateCache (the resolved
    // active-version name from /api/chart), never on entry.strategyName —
    // an assigned name with zero active versions must still warn.
    assert.match(html, /entry\.enabled && !botStateCache\?\.strategyName/, 'bmWarn gates on resolved botStateCache.strategyName');
    assert.doesNotMatch(html, /entry\.enabled && !entry\.strategyName/, 'bmWarn no longer trusts the raw settings name alone');
    // the assign <select> must label each option with its active-version
    // state so an operator sees "won't trade" risk before assigning.
    assert.match(html, /— draft, no active version/, 'select options flag names with no active version');
    assert.match(html, /\(active v' \+ av\.version \+ '\)/, 'select options surface the active version number');
  });
});

test('strategy select (UI review finding 2) only previews on change — no write — and assignment is a separate explicit action', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const html = await (await fetch(base + '/')).text();
    const onchangeBlock = html.match(/document\.getElementById\('bmStratSel'\)\.onchange = \(e\) => \{[\s\S]*?\};/);
    assert.ok(onchangeBlock, 'bmStratSel onchange handler found');
    assert.doesNotMatch(onchangeBlock[0], /save\(/, 'selecting a strategy name must never call save() directly — browsing must not rebind a live bot');
    assert.match(onchangeBlock[0], /el\.dataset\.editing = e\.target\.value/, 'selecting still previews (updates editing state + rerenders)');
    // the explicit, reachable single write path for select-driven assignment
    assert.match(html, /id="bmAssignBtn"/, 'explicit assign button present');
    assert.match(html, /getElementById\('bmAssignBtn'\)\.onclick = async \(\) => \{ await save\(\{ strategyName: editing \|\| null \}\); \};/, 'assign button is the single explicit write path');
    assert.match(html, /n === editing \? ' selected' : ''/, 'the select shows the PREVIEWED name, i.e. exactly what + assign would write');
    assert.match(html, /'editing' in el\.dataset \? el\.dataset\.editing : current/, "an explicit '— none —' preview stays representable so a strategy can be detached");
    assert.equal((html.match(/activation failed/g) || []).length, 2, 'both activation call sites surface a failed activation instead of assigning anyway');
    assert.match(html, /if \(!r\.ok\) \{ document\.getElementById\('bmEditErr'\)\.textContent = r\.error \|\| 'activation failed'; return; \}/, 'per-version activate checks the response before assigning');
  });
});

test('served client scopeOf/mismatched tolerate an assigned name with zero visible rows, e.g. all-archived (review fix, escape-drift guard)', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const html = await (await fetch(base + '/')).text();
    const m = html.match(/const scopeOf = \(name\) => [\s\S]*?\n\s*const mismatched = \(name\) => \{[\s\S]*?\};/);
    assert.ok(m, 'client scopeOf/mismatched found in the served page');
    const { scopeOf, mismatched } = new Function('byName', 'inst', 'gran', `${m[0]}; return { scopeOf, mismatched };`)(new Map(), 'WTICO/USD', 'M5');
    assert.equal(scopeOf('assigned-but-archived'), undefined, 'no throw for a name with zero visible (non-archived) rows');
    assert.equal(mismatched('assigned-but-archived'), false, 'unknown scope is treated as no-mismatch, never throws');
    assert.match(html, /has no active versions \(archived\?\)/, 'strategy tab renders an explicit note for an assigned name with no visible rows');
  });
});

test('silver flow (#75): bot follows a strategy NAME\'s active version across chat iterations, without ever touching bot config', async () => {
  const { saveStrategy, activateStrategy } = await import('../scripts/strategies.mjs');
  const { runBot } = await import('../scripts/bot.mjs');
  const { botConfig, portfolioView } = await import('../scripts/portfolio.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  await withServer(dir, async ({ base, dbPath, settingsPath }) => {
    // v1: drafted dedicated to XAG/M5, activated + assigned via the bot modal's flow
    const v1 = saveStrategy(dbPath, { name: 'silver-flow', prompt: 'Hold unless a confirmed flip breaks the recent range with volume.', instrument: 'XAG/USD', granularity: 'M5', dedicated: true, createdBy: 'chat' });
    activateStrategy(dbPath, v1.id);
    await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { bots: { 'XAG/USD|M5': { enabled: true, strategyName: 'silver-flow' } } } }) });

    const holdBin = join(dir, 'pi-silver');
    writeFileSync(holdBin, '#!/bin/sh\ncat > /dev/null\necho \'{"action":"hold","reasoning":"per strategy"}\'\n');
    chmodSync(holdBin, 0o755);
    const botSettings = { ...JSON.parse(readFileSync(settingsPath, 'utf8')), provider: 'pi', piBin: holdBin };

    await runBot(dbPath, botSettings, { instrument: 'XAG/USD', granularity: 'M5', candle: { open: 24, high: 24.1, low: 23.9, close: 24, time: '2026-07-23T08:00:00Z' }, quote: { last: 24 }, freshFlip: { signal: 'buy' } });
    const j1 = JSON.parse(portfolioView(dbPath, botConfig(botSettings)).journal.find((j) => j.action === 'decision').context);
    assert.equal(j1.strategyDbVersion, 1, 'first deliberation used v1');

    // chat iterates a v2 draft; activating it moves the pointer — bot config untouched
    const v2 = saveStrategy(dbPath, { name: 'silver-flow', prompt: 'Hold unless a confirmed flip breaks the recent range with volume; tighter chop filter now.', instrument: 'XAG/USD', granularity: 'M5', dedicated: true, createdBy: 'chat' });
    activateStrategy(dbPath, v2.id);
    const cfgAfter = await (await fetch(base + '/api/settings')).json();
    assert.deepEqual(cfgAfter.bot.bots['XAG/USD|M5'], { enabled: true, strategyName: 'silver-flow' }, 'bot config never changed across the v2 activation');

    await runBot(dbPath, botSettings, { instrument: 'XAG/USD', granularity: 'M5', candle: { open: 24, high: 24.1, low: 23.9, close: 24, time: '2026-07-23T08:05:00Z' }, quote: { last: 24 }, freshFlip: { signal: 'sell' } });
    const j2 = JSON.parse(portfolioView(dbPath, botConfig(botSettings)).journal.find((j) => j.action === 'decision').context);
    assert.equal(j2.strategyDbVersion, 2, 'the bot picked up v2 at the next deliberation, unassisted');
    assert.equal(j2.strategyName, 'silver-flow');

    const bots = await (await fetch(base + '/api/bots')).json();
    assert.equal(bots.bots.find((b) => b.combo === 'XAG/USD|M5').strategyName, 'silver-flow v2', '/api/bots reflects the active version too');
  });
});

test('trader memories (#44): save_memory chat tool is trader-initiated (chat-only, no bot side effect)', async () => {
  const { execChatTool } = await import('../scripts/signal-server.mjs');
  const { listMemories } = await import('../scripts/memories.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  await withServer(dir, async ({ dbPath }) => {
    // mirrors save_strategy's test: the tool executes directly against the
    // registry with a db ctx, not through the pi loop, so no pi fixture needed
    const out = execChatTool('save_memory', { content: 'Never chase a flip older than 2 bars.', weight: 4 }, { dbPath });
    assert.match(out, /weight 4/);
    assert.match(out, /Never chase a flip older than 2 bars\./);
    const rows = listMemories(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'chat', 'chat tool saves are source=chat');
    assert.equal(rows[0].weight, 4);

    // default weight when omitted
    execChatTool('save_memory', { content: 'Default weight rule.' }, { dbPath });
    assert.equal(listMemories(dbPath).find((r) => r.content === 'Default weight rule.').weight, 3);

    // numeric-string weight coerces; garbage throws instead of silently defaulting
    assert.match(execChatTool('save_memory', { content: 'Numeric string coerces.', weight: '5' }, { dbPath }), /weight 5/);
    assert.throws(() => execChatTool('save_memory', { content: 'Bad weight.', weight: 'high' }, { dbPath }), /weight/);

    // the bot deliberation loop's tool surface (botToolDefs, the same helper
    // supertrend.mjs wires up for the bot run) excludes both save_strategy AND
    // save_memory: memory saves are chat-only, never a side effect of a trade decision
    const { CHAT_TOOLS, botToolDefs } = await import('../scripts/signal-server.mjs');
    const chatToolNames = CHAT_TOOLS.map((t) => t.name);
    assert.ok(chatToolNames.includes('save_memory') && chatToolNames.includes('save_strategy'), 'full chat surface includes both');
    const botToolNames = botToolDefs().map((t) => t.name);
    assert.ok(!botToolNames.includes('save_memory') && !botToolNames.includes('save_strategy'), 'bot deliberation tool surface excludes both');
  });
});

test('trader memories (#44): /api/memories CRUD over HTTP, cross-origin POST rejected, injected as advisory context', async () => {
  const { memoriesContext } = await import('../scripts/memories.mjs');
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base, dbPath }) => {
    const empty = await (await fetch(base + '/api/memories')).json();
    assert.deepEqual(empty, { ok: true, memories: [], archivedCount: 0 });

    const saved = await (await fetch(base + '/api/memories', { method: 'POST', body: JSON.stringify({ action: 'save', content: 'Trail stops on WTI after a 1% move.', weight: 4 }) })).json();
    const strSaved = await (await fetch(base + '/api/memories', { method: 'POST', body: JSON.stringify({ action: 'save', content: 'Numeric-string weight via API.', weight: '2' }) })).json();
    assert.equal(strSaved.ok && strSaved.memory.weight, 2, 'API save coerces numeric-string weights like the chat tool');
    const xss = await (await fetch(base + '/api/memories', { method: 'POST', body: JSON.stringify({ action: 'save', content: '<img src=x onerror=alert(1)>', weight: 1 }) })).json();
    const served = await (await fetch(base + '/')).text();
    assert.match(served, /esc\(m\.content\)/, 'the memories list renders content through esc() — markup in a memory can never become live DOM');
    await fetch(base + '/api/memories', { method: 'POST', body: JSON.stringify({ action: 'archive', id: xss.memory.id }) });
    await fetch(base + '/api/memories', { method: 'POST', body: JSON.stringify({ action: 'archive', id: strSaved.memory.id }) });
    assert.equal(saved.ok, true);
    assert.equal(saved.memory.source, 'manual', 'HTTP-driven saves are source=manual, never chat');
    const id = saved.memory.id;

    const listed = await (await fetch(base + '/api/memories')).json();
    assert.equal(listed.memories.length, 1);
    assert.equal(listed.memories[0].content, 'Trail stops on WTI after a 1% move.');

    const reweighted = await (await fetch(base + '/api/memories', { method: 'POST', body: JSON.stringify({ action: 'reweight', id, weight: 2 }) })).json();
    assert.equal(reweighted.ok, true);
    assert.equal((await (await fetch(base + '/api/memories')).json()).memories[0].weight, 2);

    const edited = await (await fetch(base + '/api/memories', { method: 'POST', body: JSON.stringify({ action: 'edit', id, content: 'Trail stops after a 1.5% move.' }) })).json();
    assert.equal(edited.ok, true);
    assert.equal((await (await fetch(base + '/api/memories')).json()).memories[0].content, 'Trail stops after a 1.5% move.');

    const badAction = await (await fetch(base + '/api/memories', { method: 'POST', body: JSON.stringify({ action: 'nope', id }) })).json();
    assert.equal(badAction.ok, false);
    const badWeight = await (await fetch(base + '/api/memories', { method: 'POST', body: JSON.stringify({ action: 'reweight', id, weight: 99 }) })).json();
    assert.equal(badWeight.ok, false, 'weight validated server-side');

    const archived = await (await fetch(base + '/api/memories', { method: 'POST', body: JSON.stringify({ action: 'archive', id }) })).json();
    assert.equal(archived.ok, true);
    const afterArchive = await (await fetch(base + '/api/memories')).json();
    assert.equal(afterArchive.memories.length, 0, 'archived memory drops from the active list');
    assert.equal(afterArchive.archivedCount, 3, 'all fixture memories (coercion + XSS probe) are archived');

    // cross-origin POST rejected by the same CSRF guard as /api/settings
    const cross = await fetch(base + '/api/memories', { method: 'POST', body: JSON.stringify({ action: 'archive', id }), headers: { origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);

    // advisory context injection: non-empty once an active memory exists
    await fetch(base + '/api/memories', { method: 'POST', body: JSON.stringify({ action: 'save', content: 'Hold through FOMC unless stopped out.', weight: 5 }) });
    const ctx = memoriesContext(dbPath);
    assert.match(ctx, /Hold through FOMC unless stopped out\./);

    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('id="memList"') && html.includes('id="memArchivedWrap"'), 'settings modal ships the trader memories section');
  });
});

test('gate prompts (#58): save_gate_prompt chat tool stores INACTIVE drafts, excluded from botToolDefs, human-only activation via /api/gate-prompts', async () => {
  const { execChatTool, botToolDefs } = await import('../scripts/signal-server.mjs');
  const { activeGatePrompt, listGatePrompts } = await import('../scripts/gate-prompts.mjs');
  const { FILTER_RULES, FILTER_SCHEMA_SUFFIX } = await import('../scripts/supertrend.mjs');
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base, dbPath }) => {
    // the tool executes directly against the registry with a db ctx, no pi fixture needed
    const out = JSON.parse(execChatTool('save_gate_prompt', { gate: 'filter', prompt: 'Draft: require two confirming bars before any alert.' }, { dbPath }));
    assert.equal(out.gate, 'filter');
    assert.equal(out.version, 1);
    assert.match(out.note, /NOT active/);
    assert.equal(activeGatePrompt(dbPath, 'filter'), null, 'drafting cannot activate — chat tool has no activate param at all');
    assert.equal(botToolDefs().map((t) => t.name).includes('save_gate_prompt'), false, 'gate-prompt drafting is chat-only, never a bot deliberation side effect');

    // GET /api/gate-prompts: no active override yet — filter effective prompt is the builtin, byte-identical
    const g1 = await (await fetch(base + '/api/gate-prompts')).json();
    assert.equal(g1.ok, true);
    assert.equal(g1.gates.filter.prompt, FILTER_RULES + FILTER_SCHEMA_SUFFIX, 'unset: fallback is byte-identical to the shipped constant');
    assert.equal(g1.gates.filter.promptVersion, 'builtin');
    assert.equal(g1.gates.filter.drafts.length, 1);
    assert.equal(g1.gates.filter.drafts[0].active, 0);
    assert.deepEqual(g1.gates.bot.toolset, [...botToolDefs().map((t) => t.name), 'web_search']);
    assert.equal(g1.gates.bot.strategyName, null, 'no active strategy — the bot does not trade');
    assert.ok(g1.gates.chat.toolset.includes('save_memory') && g1.gates.chat.toolset.includes('save_gate_prompt'));

    // human activation: same-origin POST works, cross-origin rejected
    const draftId = g1.gates.filter.drafts[0].id;
    const cross = await fetch(base + '/api/gate-prompts', { method: 'POST', body: JSON.stringify({ action: 'activate', id: draftId }), headers: { origin: 'https://evil.example' } });
    assert.equal(cross.status, 403, 'cross-origin activation rejected');
    assert.equal(activeGatePrompt(dbPath, 'filter'), null, 'rejected cross-origin call never activated anything');
    const act = await (await fetch(base + '/api/gate-prompts', { method: 'POST', body: JSON.stringify({ action: 'activate', id: draftId }) })).json();
    assert.equal(act.ok, true);
    assert.equal(activeGatePrompt(dbPath, 'filter').id, draftId);

    // now-active override is what /api/gate-prompts and the chat context both carry
    const g2 = await (await fetch(base + '/api/gate-prompts')).json();
    assert.equal(g2.gates.filter.promptVersion, 1);
    assert.match(g2.gates.filter.prompt, /Draft: require two confirming bars/);
    assert.ok(g2.gates.filter.prompt.endsWith(FILTER_SCHEMA_SUFFIX), 'schema suffix always appended after the override text');

    const bad = await (await fetch(base + '/api/gate-prompts', { method: 'POST', body: JSON.stringify({ action: 'activate', id: 99999 }) })).json();
    assert.equal(bad.ok, false);

    // human-only deactivation restores the builtin fallback
    const deact = await (await fetch(base + '/api/gate-prompts', { method: 'POST', body: JSON.stringify({ action: 'deactivate', id: draftId }) })).json();
    assert.equal(deact.ok, true);
    assert.equal(activeGatePrompt(dbPath, 'filter'), null);

    // settings modal ships the gates section
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('id="gatesList"'), 'settings modal ships the gates transparency section');
  });
});

test('re-check (#70): POST /api/recheck runs the LATEST signal via fake pi, persists, returns, rides with /api/chart on reload; cross-origin + no-signal + no-provider handled; gate visible in settings + save_gate_prompt accepts it', async () => {
  const { execChatTool } = await import('../scripts/signal-server.mjs');
  const { RECHECK_RULES, RECHECK_SCHEMA_SUFFIX } = await import('../scripts/supertrend.mjs');
  const { latestRecheck } = await import('../scripts/signal-rechecks.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  await withServer(dir, async ({ base, sigTime, settingsPath, dbPath }) => {
    // cross-origin rejected before any provider/signal work happens
    const cross = await fetch(base + '/api/recheck', { method: 'POST', body: JSON.stringify({ instrument: INSTRUMENT, granularity: 'M5' }), headers: { origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);

    // no signal recorded for this combo yet: 404, no crash
    const none = await fetch(base + '/api/recheck', { method: 'POST', body: JSON.stringify({ instrument: 'XAU/USD', granularity: 'M5' }) });
    assert.equal(none.status, 404);

    // no LLM provider configured: fail-open UX — a visible error, not a 500/crash
    writeFileSync(settingsPath, JSON.stringify({ provider: 'none' }));
    const noProvider = await (await fetch(base + '/api/recheck', { method: 'POST', body: JSON.stringify({ instrument: INSTRUMENT, granularity: 'M5' }) })).json();
    assert.equal(noProvider.ok, false);
    assert.match(noProvider.error, /provider/);

    const piBin = join(dir, 'pi');
    writeFileSync(piBin, `#!/bin/sh\necho '{"verdict": "invalidated", "reason": "reversed hard through the flip level"}'\n`);
    chmodSync(piBin, 0o755);
    writeFileSync(settingsPath, JSON.stringify({ provider: 'pi', piBin }));

    const beforeSignals = withDb(dbPath, (d) => d.prepare('SELECT * FROM signals').all());
    const r = await (await fetch(base + '/api/recheck', { method: 'POST', body: JSON.stringify({ instrument: INSTRUMENT, granularity: 'M5' }) })).json();
    assert.equal(r.ok, true);
    assert.equal(r.verdict, 'invalidated');
    assert.equal(r.reason, 'reversed hard through the flip level');
    assert.equal(r.promptVersion, 'builtin');
    assert.match(r.at, /^\d{4}-\d{2}-\d{2}T/);

    // persisted to signal_rechecks, and the ORIGINAL signal row untouched
    const persisted = latestRecheck(dbPath, INSTRUMENT, 'M5', sigTime);
    assert.equal(persisted.verdict, 'invalidated');
    const afterSignals = withDb(dbPath, (d) => d.prepare('SELECT * FROM signals').all());
    assert.deepEqual(afterSignals, beforeSignals, 'the signals table is byte-identical after a re-check');

    // /api/chart reload carries the last re-check under the signal, no extra POST
    const chart = await (await fetch(base + '/api/chart?' + new URLSearchParams({ instrument: INSTRUMENT, granularity: 'M5' }))).json();
    assert.deepEqual(chart.recheck, { verdict: 'invalidated', reason: 'reversed hard through the flip level', at: r.at, promptVersion: 'builtin' });

    // the settings gates section lists 'recheck' with its effective prompt + no toolset
    const gates = await (await fetch(base + '/api/gate-prompts')).json();
    assert.equal(gates.gates.recheck.prompt, RECHECK_RULES + RECHECK_SCHEMA_SUFFIX);
    assert.equal(gates.gates.recheck.promptVersion, 'builtin');
    assert.deepEqual(gates.gates.recheck.toolset, []);
    assert.equal(gates.gates.recheck.drafts.length, 0);

    // save_gate_prompt now accepts 'recheck' too (chat-only, human activates in settings)
    const out = JSON.parse(execChatTool('save_gate_prompt', { gate: 'recheck', prompt: 'Weigh realized excursion heavily.' }, { dbPath }));
    assert.equal(out.gate, 'recheck');
    const gates2 = await (await fetch(base + '/api/gate-prompts')).json();
    assert.equal(gates2.gates.recheck.drafts.length, 1);

    // the verdict row ships the 🔁 button and its INFO overlay entry
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /id="recheckBtn"/);
    assert.match(html, /recheck: '[^']*re-check/i, 'INFO overlay entry documents the 🔁 button');
  });
});

test('gate prompts (#58): chat context carries the effective per-gate prompt for discussion', async () => {
  const { activateGatePrompt, saveGatePrompt } = await import('../scripts/gate-prompts.mjs');
  const { FILTER_RULES, FILTER_SCHEMA_SUFFIX } = await import('../scripts/supertrend.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  await withServer(dir, async ({ base, dbPath, settingsPath }) => {
    const piBin = join(dir, 'pi');
    writeFileSync(piBin, '#!/bin/sh\necho ok\n');
    chmodSync(piBin, 0o755);
    writeFileSync(settingsPath, JSON.stringify({ provider: 'pi', piBin }));

    const draft = saveGatePrompt(dbPath, { gate: 'filter', prompt: 'Chat-visible override rules text.' });
    const res1 = await fetch(base + '/api/chat', { method: 'POST', body: JSON.stringify({ message: 'what are your filter rules?', instrument: INSTRUMENT, granularity: 'M5' }) });
    const done1 = sseEvents(await res1.text()).find((e) => e.type === 'done');
    const msgs1 = await (await fetch(base + `/api/messages?thread=${done1.threadId}`)).json();
    const ctx1 = JSON.parse(msgs1.messages[0].context);
    assert.equal(ctx1.gatePrompts.filter, FILTER_RULES + FILTER_SCHEMA_SUFFIX, 'no active override: builtin carried');
    assert.match(ctx1.gatePrompts.note, /bot prompt is strategy-owned/);

    activateGatePrompt(dbPath, draft.id);
    const res2 = await fetch(base + '/api/chat', { method: 'POST', body: JSON.stringify({ message: 'and now?', instrument: INSTRUMENT, granularity: 'M5' }) });
    const done2 = sseEvents(await res2.text()).find((e) => e.type === 'done');
    const msgs2 = await (await fetch(base + `/api/messages?thread=${done2.threadId}`)).json();
    const ctx2 = JSON.parse(msgs2.messages[msgs2.messages.length - 2].context);
    assert.match(ctx2.gatePrompts.filter, /Chat-visible override rules text\./, 'active override reflected in the next chat context');
  });
});

test('evaluation endpoint (#26): read-only, serves scoreboard+baselines+audit; page ships the tabs', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const r = await (await fetch(base + '/api/evaluation')).json();
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.scoreboard) && Array.isArray(r.audit));
    assert.ok(r.baselines && r.baselines.flipFollowing, 'baselines computed from the fixture candles');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await fetch(base + '/api/evaluation', { method, body: '{}' })).status, 405, method + ' rejected');
    }
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('id="pfTabs"'), 'portfolio modal tab bar present');
    assert.ok(html.includes('data-tab="audit"') && html.includes('data-tab="performance"'), 'performance + audit tabs present');
  });
});

test('chart ind= param serves display series + state axis gate; chat context carries axisGate (#32)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-'));
  await withServer(dir, async ({ base, settingsPath }) => {
    const d = await (await fetch(base + '/api/chart?ind=ema,rsi,vwap,bogus')).json();
    assert.ok(Array.isArray(d.indicators.ema.ema20) && d.indicators.ema.ema20.length === d.candles.length, 'ema series aligned to candles');
    assert.ok(Array.isArray(d.indicators.rsi) && Array.isArray(d.indicators.vwap));
    assert.equal(d.indicators.macd, undefined, 'unrequested series omitted');
    assert.ok(d.axisGate === null || d.axisGate.axes.trendStrength !== undefined, 'axis gate attached (state-only) when indicators requested');
    const plain = await (await fetch(base + '/api/chart')).json();
    assert.equal(plain.indicators, undefined, 'no ind param → no indicator payload');
    assert.ok(plain.axisGate === null || plain.axisGate.axes, 'axis gate always attached, independent of display toggles');

    // and the chat context carries the same axis block
    const piBin = join(dir, 'pi');
    writeFileSync(piBin, '#!/bin/sh\ncat > /dev/null\necho ok\n');
    chmodSync(piBin, 0o755);
    writeFileSync(settingsPath, JSON.stringify({ provider: 'pi', piBin }));
    const res = await fetch(base + '/api/chat', { method: 'POST', body: JSON.stringify({ message: 'axis check', instrument: INSTRUMENT, granularity: 'M5' }) });
    const done = sseEvents(await res.text()).find((e) => e.type === 'done');
    const { messages } = await (await fetch(base + '/api/messages?thread=' + done.threadId)).json();
    const ctx = JSON.parse(messages[0].context);
    assert.ok(ctx.axisGate && ctx.axisGate.trendStrength !== undefined, 'chat context carries the axis gate block');
  });
});

test('page ships the indicator toggle row and oscillator panel (#32)', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('id="indbar"'), 'indicator toggle row present');
    assert.ok(html.includes('id="oscwrap"') && html.includes('id="osc"'), 'oscillator sub-panel canvas present');
    assert.ok(html.includes("data-ind"), 'toggles carry indicator keys');
  });
});

test('per-combo bots (#49): map validation, per-combo merge, null-delete, stored indicator default', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    // validation: bad combo key and unknown per-bot keys rejected
    assert.equal((await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { bots: { 'nope': { enabled: true } } } }) })).status, 400);
    assert.equal((await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { bots: { 'WTICO/USD|M5': { evil: 1 } } } }) })).status, 400);
    assert.equal((await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { bots: { 'WTICO/USD|M5': { strategyId: '3' } } } }) })).status, 400, 'string strategyId rejected — no silent never-running bots');
    assert.equal((await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { bots: { 'WTICO/USD|M5': { riskPct: '1.5' } } } }) })).status, 400, 'string riskPct rejected');
    assert.equal((await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { bots: { 'WTICO/USD|M5': { enabled: 'yes' } } } }) })).status, 400, 'non-boolean enabled rejected');
    // add two bots, then patch one field — the other bot and other fields survive
    await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { bots: { 'WTICO/USD|M5': { enabled: true, strategyId: 3, riskPct: 2 }, 'SPX500/USD|M1': { enabled: false } } } }) });
    await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { bots: { 'WTICO/USD|M5': { riskPct: 1.5 } } } }) });
    let got = await (await fetch(base + '/api/settings')).json();
    assert.deepEqual(got.bot.bots['WTICO/USD|M5'], { enabled: true, strategyId: 3, riskPct: 1.5 }, 'per-combo merge keeps sibling fields');
    assert.ok(got.bot.bots['SPX500/USD|M1'], 'sibling bot untouched');
    // key normalization: a spaced patch merges INTO the normalized entry, never duplicates
    await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { bots: { 'WTICO/USD | M5': { riskPct: 3 } } } }) });
    got = await (await fetch(base + '/api/settings')).json();
    assert.equal(Object.keys(got.bot.bots).filter((k) => k.startsWith('WTICO')).length, 1, 'no duplicate spaced/unspaced keys');
    assert.equal(got.bot.bots['WTICO/USD|M5'].riskPct, 3, 'spaced patch reached the normalized entry');
    // null deletes exactly one bot entry
    await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { bots: { 'SPX500/USD|M1': null } } }) });
    got = await (await fetch(base + '/api/settings')).json();
    assert.equal(got.bot.bots['SPX500/USD|M1'], undefined);
    assert.ok(got.bot.bots['WTICO/USD|M5']);
    // stored indicator selection becomes the chart default when the URL has none
    await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ ind: 'ema,rsi' }) });
    const d = await (await fetch(base + '/api/chart')).json();
    assert.deepEqual(d.activeInd, ['ema', 'rsi'], 'global selection applies without URL params');
    assert.ok(d.indicators.ema && d.indicators.rsi, 'series served from the stored default');
    const overridden = await (await fetch(base + '/api/chart?ind=vwap')).json();
    assert.deepEqual(overridden.activeInd, ['vwap'], 'URL still overrides');
  });
});

test('/api/bots serves the read-only activated-bots list; /api/chart carries botState (#49 design)', async () => {
  const { saveStrategy, activateStrategy } = await import('../scripts/strategies.mjs');
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base, dbPath }) => {
    const st = saveStrategy(dbPath, { name: 'ux-strat', prompt: 'A strategy prompt long enough to pass validation rules.' });
    activateStrategy(dbPath, st.id); // #75: bots follow the ACTIVE version of a name, not a frozen row
    await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { bots: { 'WTICO/USD|M5': { enabled: true, strategyId: st.id }, 'XAG/USD|M1': { enabled: false } } } }) });
    const r = await (await fetch(base + '/api/bots')).json();
    assert.equal(r.bots.length, 2);
    const wti = r.bots.find((b) => b.combo === 'WTICO/USD|M5');
    assert.equal(wti.enabled, true);
    assert.equal(wti.strategyName, 'ux-strat v1');
    assert.equal(typeof wti.trades, 'number');
    assert.equal(r.halted, false);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const resp = await fetch(base + '/api/bots', { method, body: '{}' });
      assert.ok([404, 405].includes(resp.status), method + ' has no mutation surface on /api/bots');
    }
    const d = await (await fetch(base + '/api/chart')).json();
    assert.equal(d.botState.configured, true);
    assert.equal(d.botState.enabled, true);
    assert.equal(d.botState.strategyName, 'ux-strat v1');
    assert.equal(d.botState.halted, false);
    const d2 = await (await fetch(base + '/api/chart?instrument=XAG/USD&granularity=M1')).json();
    assert.equal(d2.botState.enabled, false);
    assert.equal(d2.botState.configured, true);
  });
});

test('halt reset never half-applies: an invalid combined patch leaves the halt intact (#50 deep lens)', async () => {
  const { botConfig, openPosition, markToMarket, portfolioView } = await import('../scripts/portfolio.mjs');
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base, dbPath }) => {
    // force a halt: tiny portfolio, catastrophic mark
    const cfg = botConfig({ bot: { riskPct: 100 } });
    openPosition(dbPath, cfg, { instrument: INSTRUMENT, side: 'long', notional: 90000, price: 87 });
    markToMarket(dbPath, cfg, { [INSTRUMENT]: 1 });
    assert.equal(portfolioView(dbPath, cfg).halted, true, 'halted precondition');
    // invalid patch alongside resetHalt → 400 AND the halt must survive
    const bad = await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { resetHalt: true, bots: { 'nope': { enabled: true } } } }) });
    assert.equal(bad.status, 400);
    assert.equal(portfolioView(dbPath, cfg).halted, true, 'invalid patch did not clear the halt');
    // clean reset works and is one-shot (flag never persisted)
    const ok = await (await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { resetHalt: true } }) })).json();
    assert.equal(ok.error, undefined);
    assert.equal(portfolioView(dbPath, cfg).halted, false, 'clean reset clears the halt');
    const stored = await (await fetch(base + '/api/settings')).json();
    assert.equal(stored.bot?.resetHalt, undefined, 'flag never persisted');
  });
});

test('per-bot allocationPct + leverage map validation and merge (#51)', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    assert.equal((await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { bots: { 'WTICO/USD|M5': { allocationPct: 150 } } } }) })).status, 400, 'allocation > 100 rejected');
    assert.equal((await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { leverage: { 'WTICO/USD': '15' } } }) })).status, 400, 'string leverage rejected');
    assert.equal((await fetch(base + '/api/settings', { method: 'POST', body: '{"bot":{"leverage":{"__proto__":5}}}' })).status, 400, 'prototype-pollution keys rejected at validation (raw JSON — a JS literal would swallow the key)');
    assert.equal((await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { leverage: { 'WTICO/USD ': 5 } } }) })).status, 400, 'trailing-space key rejected — exact-lookup keys must match the instrument rule');
    await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { leverage: { 'WTICO/USD': 15, 'XAG/USD': 5 }, bots: { 'WTICO/USD|M5': { enabled: true, allocationPct: 10 } } } }) });
    await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { leverage: { 'XAG/USD': null } } }) });
    const got = await (await fetch(base + '/api/settings')).json();
    assert.deepEqual(got.bot.leverage, { 'WTICO/USD': 15 }, 'per-instrument leverage merge with null-delete');
    const bots = await (await fetch(base + '/api/bots')).json();
    const row = bots.bots.find((b) => b.combo === 'WTICO/USD|M5');
    assert.equal(row.allocationPct, 10);
    assert.equal(row.leverage, 15, 'effective leverage exposed per bot');
  });
});

test('settings: OPENAI_BASE_URL whitelisted + URL-validated; provider select is explicit-only (#42)', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    assert.equal((await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ OPENAI_BASE_URL: 'not a url' }) })).status, 400);
    assert.equal((await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ OPENAI_BASE_URL: 'ftp://x.example' }) })).status, 400, 'non-http(s) rejected');
    assert.equal((await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ provider: 'auto' }) })).status, 400, 'invalid provider strings rejected — no auto reintroduction');
    assert.equal((await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ OPENAI_BASE_URL: 'https://host.example?x=1' }) })).status, 400, 'query strings rejected');
    assert.equal((await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ OPENAI_BASE_URL: 'https://user:pass@host.example' }) })).status, 400, 'embedded credentials rejected — the field is unmasked');
    await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ OPENAI_BASE_URL: 'http://localhost:9999' }) });
    const got = await (await fetch(base + '/api/settings')).json();
    assert.equal(got.OPENAI_BASE_URL, 'http://localhost:9999', 'stored unmasked (not a secret)');
    const html = await (await fetch(base + '/')).text();
    assert.ok(!html.includes('auto (use API keys)'), 'auto option gone — providers are explicit');
    assert.ok(html.includes('openai (compatible via base URL)'), 'openai option present');
  });
});

test('info overlays (#57/#67): one explanation map covers the axis keys, toggle lives in the settings dialog', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    const html = await (await fetch(base + '/')).text();
    const src = html.match(/const INFO = \{[\s\S]*?\n\};/);
    assert.ok(src, 'a single INFO explanation map is present');
    for (const key of ['adx', 'regime', 'impulse', 'vwap', 'rsi']) {
      assert.match(src[0], new RegExp('\\b' + key + ':'), key + ' has an INFO map entry');
    }
    assert.ok(!html.includes('id="infoBtn"'), 'no dedicated header ⓘ button (#67 — toggle moved into settings)');
    assert.ok(html.includes('for="f-infoToggle"') && html.includes('id="f-infoToggle"'), 'settings dialog renders the info-overlays label + checkbox markup, not just JS references');
    assert.ok(html.includes('data-info="'), 'at least one rendered element carries data-info');
    assert.match(html, /body\.info-on \[data-info\]:hover::before/, 'CSS-only tooltip rule on ::before — ::after belongs to the bot status dot (#67)');
    assert.ok(!/info-on \[data-info\]:hover::after/.test(html), 'no tooltip rule on ::after (would merge with the bot dot)');
    assert.match(html, /width: max-content/, 'tooltips lay out at natural width, not the trigger width (#67)');
  });
});

test('info toggle (#57): settings key round-trips like ind, invalid values rejected, /api/chart carries it', async () => {
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base }) => {
    let d = await (await fetch(base + '/api/chart')).json();
    assert.equal(d.info, false, 'off by default');

    assert.equal((await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ info: 'yes' }) })).status, 400, 'non-boolean rejected');

    let res = await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ info: true }) });
    assert.equal(res.status, 200);
    assert.equal((await (await fetch(base + '/api/settings')).json()).info, true);
    d = await (await fetch(base + '/api/chart')).json();
    assert.equal(d.info, true, 'persisted globally, same pattern as ind');

    // null deletes the key, same convention as every other settings field
    await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ info: null }) });
    assert.equal((await (await fetch(base + '/api/settings')).json()).info, undefined);
    d = await (await fetch(base + '/api/chart')).json();
    assert.equal(d.info, false);
  });
});

test('bot decision annotation on /api/chart (#73): matched by combo + candle-window timing, absent when unconfigured', async () => {
  const { saveStrategy } = await import('../scripts/strategies.mjs');
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base, dbPath, sigTime }) => {
    const at = new Date(Date.parse(sigTime) + 6 * 60000).toISOString(); // within M5's 2x-candle grace window
    seedDecision(dbPath, { at, action: 'hold', reasoning: 'chop, staying flat until the next confirmed flip' });

    // no bot configured for this combo yet: silent even though a matching decision exists
    let d = await (await fetch(base + '/api/chart')).json();
    assert.equal(d.botDecision, undefined, 'unarmed combo: no botDecision');
    assert.equal(d.botDecisions, undefined, 'unarmed combo: no botDecisions map');

    const st = saveStrategy(dbPath, { name: 'bd-strat', prompt: 'A strategy prompt long enough to pass validation rules.' });
    await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { bots: { [`${INSTRUMENT}|M5`]: { enabled: true, strategyId: st.id } } } }) });

    d = await (await fetch(base + '/api/chart')).json();
    assert.equal(d.botDecision.action, 'hold');
    assert.ok(d.botDecision.reasoning.startsWith('chop'));
    assert.equal(d.botDecisions[sigTime].action, 'hold', 'history map keyed by signal time');

    // a decision outside the candle-window grace never matches, even if it's the newest row
    const stale = new Date(Date.parse(sigTime) + 20 * 60000).toISOString();
    seedDecision(dbPath, { at: stale, action: 'open', reasoning: 'too late to attribute to this signal' });
    const d2 = await (await fetch(base + '/api/chart')).json();
    assert.equal(d2.botDecision.action, 'hold', 'the in-window decision still wins over an out-of-window one');
  });
});

test('bot decision INFO overlay entry present, verdict/history render the inline annotation (#73)', async () => {
  const { saveStrategy } = await import('../scripts/strategies.mjs');
  await withServer(mkdtempSync(join(tmpdir(), 'ss-')), async ({ base, dbPath, sigTime }) => {
    const html = await (await fetch(base + '/')).text();
    const src = html.match(/const INFO = \{[\s\S]*?\n\};/);
    assert.ok(src, 'INFO map block extracted from the served page');
    assert.match(src[0], /botDecision:/, 'INFO map explains the inline bot decision annotation');
    assert.match(html, /botDecision\.reasoning/, 'verdict row renders the escaped bot annotation');
    assert.match(html, /class="botnote"/, 'bot note is its own dimmed line, not an inline fragment (#78)');
    assert.ok(!/reasoning\s*\.\s*slice\s*\(/.test(html), 'reasoning is no longer truncated at all (#78)');
    // pin the LOGIC that applies the class, not just the class name existing in CSS
    assert.match(html, /action\s*===\s*'hold'/, 'overruled state derives from a hold decision (#78)');
    assert.match(html, /overruled\s*\?\s*'overruled'\s*:/, 'the side label picks overruled over buy/sell (#78)');
    assert.equal((html.match(/overruled\s*\?\s*'overruled'\s*:/g) || []).length, 2, 'both the verdict row and history rows grey an overruled signal');
    assert.match(html, /\.overruled \{ color: #8b949e; \}/, 'overruled styling present');
    assert.match(html, /botDecisions\[s\.time\]/, 'history rows look up the per-signal decision map');

    const at = new Date(Date.parse(sigTime) + 6 * 60000).toISOString();
    seedDecision(dbPath, { at, action: 'hold', reasoning: 'held' });
    const st = saveStrategy(dbPath, { name: 'bd-strat2', prompt: 'A strategy prompt long enough to pass validation rules.' });
    await fetch(base + '/api/settings', { method: 'POST', body: JSON.stringify({ bot: { bots: { [`${INSTRUMENT}|M5`]: { enabled: true, strategyId: st.id } } } }) });
    const d = await (await fetch(base + '/api/chart')).json();
    assert.equal(d.botDecision.action, 'hold', 'armed combo with a recorded decision carries botDecision');
  });
});
