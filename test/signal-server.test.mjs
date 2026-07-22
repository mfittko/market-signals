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
    assert.ok(html.includes('auto (use API keys)'), 'provider select explains auto mode');
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
  assert.deepEqual(CHAT_TOOLS.map((t) => t.name), ['fxempire_articles', 'truthsocial_posts', 'live_rates', 'save_strategy']);
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
    assert.ok(html.includes('id="botcfg"'), 'bot config section in the settings dialog');

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
