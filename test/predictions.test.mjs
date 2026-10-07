import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jevState, jevDecide, jevPredict, jevQuestions } from '../scripts/jev.mjs';
import { predictionActive, listPredictions, currentPrediction } from '../scripts/predictions.mjs';
import { indicatorSummary } from '../scripts/lib/indicator-summary.mjs';
import { storeCandles } from '../scripts/supertrend.mjs';
import { buildServer, botToolDefs, chatToolDefs, execChatTool } from '../scripts/signal-server.mjs';
import { writeFileSync } from 'node:fs';

// recent bars, so the newest one is the current M5 candle and passes the freshness check
const T0 = Math.floor(Date.now() / 300000) * 300000 - 199 * 300000;
// 200 rising M5 bars (enough to resample M15 and H1), the last one forming.
const bars = Array.from({ length: 200 }, (_, i) => {
  const close = 100 + i * 0.05;
  return { time: new Date(T0 + i * 300000).toISOString(), open: close - 0.025, high: close + 0.05, low: close - 0.05, close, volume: 100 };
});
const formingBars = [...bars.slice(0, -1), { ...bars.at(-1), partial: true }];

const answer = (action = 'long') => ({
  model: 'jev-1.13.0',
  answers: {
    action: { type: 'choice', choice: action, probabilities: { long: 0.7, short: 0.1, no_trade: 0.2 }, confidence: 0.6 },
    setup_quality: { type: 'score', score: 2.5, confidence: 0.8, legend: {}, probabilities: {} },
    trend_confirmed: { type: 'noul', noul: 0.9 },
  },
});
const okFetch = (calls, body = answer()) => async (url, init) => {
  calls.push({ url, init });
  return { ok: true, status: 200, json: async () => body };
};
const KEYED = { TYPESAFE_API_KEY: 'k', predictionEnabled: '1' };

test('predictionActive needs a non-blank provider key and the toggle', () => {
  assert.equal(predictionActive({}), false);
  assert.equal(predictionActive({ predictionEnabled: '1' }), false);
  assert.equal(predictionActive({ TYPESAFE_API_KEY: '  ', predictionEnabled: '1' }), false);
  assert.equal(predictionActive({ TYPESAFE_API_KEY: 'k', predictionEnabled: '0' }), false);
  assert.equal(predictionActive(KEYED), true);
  assert.equal(predictionActive({ TYPESAFE_API_KEY: 'k', predictionEnabled: true }), true);
});

test('jevState buckets values into words and leaks no price numbers', () => {
  const summary = indicatorSummary(bars.slice(0, 60));
  const state = jevState(summary, { instrument: 'WTICO/USD', granularity: 'M5', trend: 'up', barsSinceFlip: 2, bar: bars[59], progress: 0.5, htf: { M15: 'up', H1: null } });
  assert.equal(state.timeframe, '5-minute');
  assert.equal(state.current_candle, 'forming, mid-bar');
  assert.equal(state.supertrend, 'bullish, flipped recently');
  assert.equal(state.price_vs_ema, 'above EMA20 and EMA50');
  assert.equal(state.trend_15_minute, 'uptrend');
  assert.equal(state.trend_1_hour, 'not enough history');
  for (const [k, v] of Object.entries(state)) assert.doesNotMatch(String(v), /\d\.\d/, `${k} carries a price-like number: ${v}`);
});

test('jevState: a closed bar and a tight range', () => {
  const flat = Array.from({ length: 40 }, (_, i) => ({ time: new Date(T0 + i * 300000).toISOString(), open: 100, high: 100.2, low: 99.8, close: 100, volume: 100 }));
  const state = jevState(indicatorSummary(flat), { instrument: 'X', granularity: 'M5', trend: 'up', barsSinceFlip: null, bar: flat.at(-1), progress: 1 });
  assert.equal(state.current_candle, 'closed');
  assert.equal(state.recent_range, 'inside a tight 20-bar range');
  assert.equal(state.supertrend, 'bullish, no flip in view');
});

test('jevQuestions frame the action over the next 3 candles with long, short and no_trade', () => {
  const q = jevQuestions('M5');
  assert.deepEqual(Object.keys(q.action.criteria), ['long', 'short', 'no_trade']);
  assert.match(q.action.instructions, /next 3 5-minute candles/);
  assert.equal(q.setup_quality.criteria.length, 5);
  assert.equal(q.trend_confirmed.type, 'noul');
});

test('jevDecide sends one typed request and maps the answers', async () => {
  const calls = [];
  const v = await jevDecide(KEYED, { a: 'b' }, 'M5', { fetchFn: okFetch(calls) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, 'Bearer k');
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body).questions), ['action', 'setup_quality', 'trend_confirmed']);
  assert.deepEqual([v.action, v.probabilities.no_trade, v.quality, v.trendConfirmed, v.confidence], ['long', 0.2, 2.5, 0.9, 0.6]);
});

test('jevDecide retries once on 429/529, and fails readably on 401, timeout and malformed answers', async () => {
  for (const status of [429, 529]) {
    let n = 0;
    const flaky = async () => (++n === 1 ? { ok: false, status } : { ok: true, status: 200, json: async () => answer('short') });
    assert.equal((await jevDecide(KEYED, {}, 'M5', { fetchFn: flaky, retryDelayMs: 0 })).action, 'short');
    assert.equal(n, 2);
  }
  await assert.rejects(jevDecide(KEYED, {}, 'M5', { fetchFn: async () => ({ ok: false, status: 401 }) }), /rejected the API key/);
  const hang = (_, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await assert.rejects(jevDecide(KEYED, {}, 'M5', { fetchFn: hang, timeoutMs: 10 }), (e) => /unreachable or timed out/.test(e.message) && !/typesafe/i.test(e.message) && e.cause != null);
  await assert.rejects(jevDecide(KEYED, {}, 'M5', { fetchFn: async () => { throw new TypeError('fetch failed'); } }), /unreachable or timed out/);
  const noProbs = answer(); delete noProbs.answers.action.probabilities;
  await assert.rejects(jevDecide(KEYED, {}, 'M5', { fetchFn: async () => ({ ok: true, status: 200, json: async () => noProbs }) }), /missing typed fields/);
  const broken = [
    (a) => { a.action.choice = 'hold'; },
    (a) => { delete a.action.choice; },
    (a) => { a.action.probabilities.long = 'high'; },
    (a) => { a.setup_quality.score = null; },
    (a) => { delete a.trend_confirmed.noul; },
    (a) => { a.action.probabilities = {}; },
    (a) => { delete a.action.probabilities.short; },
    (a) => { a.action.probabilities.long = 1.5; },
    (a) => { a.setup_quality.score = 5; },
    (a) => { a.trend_confirmed.noul = -0.1; },
  ];
  await assert.rejects(jevDecide(KEYED, {}, 'M5', { fetchFn: async () => ({ ok: true, status: 200, json: async () => JSON.parse('<html>') }) }), { message: 'The prediction service answer is not valid JSON' });
  for (const breakIt of broken) {
    const bad = answer(); breakIt(bad.answers);
    await assert.rejects(jevDecide(KEYED, {}, 'M5', { fetchFn: async () => ({ ok: true, status: 200, json: async () => bad }) }), /missing typed fields/, String(breakIt));
  }
});

test('jevPredict answers for the forming candle with bar progress and higher-timeframe trends', async () => {
  const calls = [];
  const now = Date.parse(bars.at(-1).time) + 150000; // half way into the M5 bar, clear of the 1/3 and 2/3 band edges
  const p = await jevPredict(KEYED, { instrument: 'WTICO/USD', granularity: 'M5', candles: formingBars }, { now, fetchFn: okFetch(calls) });
  assert.equal(p.candleTime, bars.at(-1).time);
  assert.equal(p.forming, true);
  assert.equal(p.price, bars.at(-1).close);
  assert.equal(p.horizonBars, 3);
  assert.equal(p.state.current_candle, 'forming, mid-bar');
  assert.equal(p.state.trend_15_minute, 'uptrend');
  assert.equal(p.state.trend_1_hour, 'uptrend');
  assert.deepEqual(JSON.parse(calls[0].init.body).state, p.state, 'the returned state is exactly what was sent');
});

test('jevPredict on H1 sends no higher-timeframe lines', async () => {
  const h1 = bars.map((b, i) => ({ ...b, time: new Date(T0 + i * 3600000).toISOString() }));
  const p = await jevPredict(KEYED, { instrument: 'X', granularity: 'H1', candles: h1 }, { fetchFn: okFetch([]) });
  assert.equal(p.forming, false);
  assert.equal(p.state.current_candle, 'closed');
  assert.ok(!Object.keys(p.state).some((k) => k.startsWith('trend_')));
});

async function withServer(settings, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-'));
  const dbPath = join(dir, 'db.sqlite');
  const settingsPath = join(dir, 'settings.json');
  storeCandles(dbPath, 'WTICO/USD', 'M5', bars);
  writeFileSync(settingsPath, JSON.stringify(settings));
  const calls = [];
  const server = buildServer({ dbPath, settingsPath, fetcher: null, providerFetch: okFetch(calls) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn({ base, calls, dbPath }); } finally { server.close(); }
}
const post = (base, body) => fetch(`${base}/api/predict`, { method: 'POST', body: JSON.stringify(body) });

test('POST /api/predict refuses with 409 and no TypeSafe call while off', async () => {
  for (const s of [{}, { predictionEnabled: '1' }, { TYPESAFE_API_KEY: ' ', predictionEnabled: '1' }, { TYPESAFE_API_KEY: 'k', predictionEnabled: '0' }]) {
    await withServer(s, async ({ base, calls }) => {
      const r = await post(base, { instrument: 'WTICO/USD', granularity: 'M5' });
      assert.equal(r.status, 409);
      assert.match((await r.json()).error, /Predictions are off/);
      assert.equal(calls.length, 0);
    });
  }
});

test('POST /api/predict returns one prediction, validates input, and masks the key in settings', async () => {
  await withServer(KEYED, async ({ base, calls }) => {
    const r = await post(base, { instrument: 'WTICO/USD', granularity: 'M5' });
    assert.equal(r.status, 200);
    const { prediction } = await r.json();
    assert.equal(prediction.action, 'long');
    assert.equal(prediction.candleTime, bars.at(-1).time);
    assert.equal(calls.length, 1);
    for (const granularity of ['bogus', 'M0', 'H0', 'M7']) assert.equal((await post(base, { instrument: 'WTICO/USD', granularity })).status, 400, granularity);
    assert.equal(calls.length, 1);
    assert.equal((await post(base, { instrument: 'NOPE/USD', granularity: 'M5' })).status, 404);
    const s = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(s.TYPESAFE_API_KEY, '•••');
    const bad = await (await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ predictionEnabled: 'yes' }) })).json();
    assert.match(bad.error, /predictionEnabled/);
  });
});

test('a whitespace-only TypeSafe key reads as unset, so the console hides the card', async () => {
  await withServer({ TYPESAFE_API_KEY: ' ', predictionEnabled: '1' }, async ({ base }) => {
    assert.equal((await (await fetch(`${base}/api/settings`)).json()).TYPESAFE_API_KEY, undefined, 'hand-edited blank key');
  });
  await withServer({ predictionEnabled: '1' }, async ({ base }) => {
    await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ TYPESAFE_API_KEY: '  ' }) });
    assert.equal((await (await fetch(`${base}/api/settings`)).json()).TYPESAFE_API_KEY, undefined, 'blank key written through the API');
  });
});

test('POST /api/predict rejects a malformed instrument before any fetch', async () => {
  await withServer(KEYED, async ({ base, calls }) => {
    for (const instrument of ['', 'x', 'WTI CO/USD', '../../etc', 'A'.repeat(30)]) {
      assert.equal((await post(base, { instrument, granularity: 'M5' })).status, 400, instrument);
    }
    assert.equal(calls.length, 0);
  });
});

test('every prediction run is stored and restorable, newest first, scoped to the pair', async () => {
  await withServer(KEYED, async ({ base, calls, dbPath }) => {
    const first = (await (await post(base, { instrument: 'WTICO/USD', granularity: 'M5' })).json()).prediction;
    const second = (await (await post(base, { instrument: 'WTICO/USD', granularity: 'M5' })).json()).prediction;
    assert.ok(second.id > first.id);
    assert.equal(calls.length, 2);
    const list = async (q) => (await (await fetch(`${base}/api/predictions?${q}`)).json());
    const r = await list('instrument=WTICO%2FUSD&granularity=M5');
    assert.deepEqual(r.predictions.map((p) => p.id), [second.id, first.id]);
    const { reused, ...stored } = second;
    assert.equal(reused, false);
    assert.deepEqual(r.predictions[0], stored, 'a restored run equals the run as returned');
    assert.equal(r.predictions[0].provider, 'typesafe-jev');
    assert.equal(typeof r.predictions[0].state.current_candle, 'string');
    assert.deepEqual((await list('instrument=WTICO%2FUSD&granularity=M5&limit=1')).predictions.map((p) => p.id), [second.id]);
    assert.deepEqual((await list('instrument=WTICO%2FUSD&granularity=M5&limit=1&directional=1')).predictions.map((p) => p.id), [second.id]);
    assert.deepEqual((await list('instrument=WTICO%2FUSD&granularity=H1')).predictions, []);
    assert.equal((await fetch(`${base}/api/predictions?instrument=x&granularity=M5`)).status, 400);
    assert.equal(calls.length, 2, 'reading stored runs never calls the provider');
    assert.equal(listPredictions(dbPath, 'WTICO/USD', 'M5', 1000).length, 2);
    // the route passes reuse through: a second reuse call inside the candle makes no provider call
    const a = (await (await post(base, { instrument: 'WTICO/USD', granularity: 'M5', reuse: true })).json()).prediction;
    const before = calls.length;
    const b = (await (await post(base, { instrument: 'WTICO/USD', granularity: 'M5', reuse: true })).json()).prediction;
    assert.deepEqual([b.reused, b.id, calls.length], [true, a.id, before]);
  });
});

test('a provider failure stores nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pred-'));
  const dbPath = join(dir, 'db.sqlite');
  const settingsPath = join(dir, 'settings.json');
  storeCandles(dbPath, 'WTICO/USD', 'M5', bars);
  writeFileSync(settingsPath, JSON.stringify(KEYED));
  const server = buildServer({ dbPath, settingsPath, fetcher: null, providerFetch: async () => ({ ok: false, status: 401 }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await post(`http://127.0.0.1:${server.address().port}`, { instrument: 'WTICO/USD', granularity: 'M5' });
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /rejected the API key/);
    assert.deepEqual(listPredictions(dbPath, 'WTICO/USD', 'M5'), []);
  } finally { server.close(); }
});

test('a run expires one candle duration after it was made, and reuse makes no call while valid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pred-'));
  const dbPath = join(dir, 'db.sqlite');
  const calls = [];
  const asked = Date.parse(bars.at(-1).time) + 30000;
  const input = { instrument: 'WTICO/USD', granularity: 'M1', loadCandles: async () => formingBars };
  const first = await currentPrediction(dbPath, KEYED, input, { reuse: true, now: asked, fetchFn: okFetch(calls) });
  assert.equal(first.reused, false);
  assert.equal(first.expiresAt, new Date(asked + 60000).toISOString(), 'M1 runs expire after one minute');
  assert.equal(first.valid, true);
  const again = await currentPrediction(dbPath, KEYED, input, { reuse: true, now: asked + 59000, fetchFn: okFetch(calls) });
  assert.deepEqual([again.reused, again.id, calls.length], [true, first.id, 1]);
  assert.equal(listPredictions(dbPath, 'WTICO/USD', 'M1', 1, asked + 60000)[0].valid, false);
  const fresh = await currentPrediction(dbPath, KEYED, input, { reuse: true, now: asked + 60000, fetchFn: okFetch(calls) });
  assert.deepEqual([fresh.reused, calls.length], [false, 2]);
  const forced = await currentPrediction(dbPath, KEYED, input, { now: asked + 61000, fetchFn: okFetch(calls) });
  assert.deepEqual([forced.reused, calls.length], [false, 3], 'without reuse every call runs');
  const m5 = await currentPrediction(dbPath, KEYED, { ...input, granularity: 'M5' }, { now: asked, fetchFn: okFetch(calls) });
  assert.equal(m5.expiresAt, new Date(asked + 300000).toISOString());
});

test('stale candles are refused before any provider call', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'pred-')), 'db.sqlite');
  const calls = [];
  const input = { instrument: 'WTICO/USD', granularity: 'M5', loadCandles: async () => bars };
  const now = Date.parse(bars.at(-1).time) + 600000; // two M5 candles after the newest bar started
  await assert.rejects(currentPrediction(dbPath, KEYED, input, { now, fetchFn: okFetch(calls) }), (e) => e.status === 503 && /no current data/.test(e.message));
  assert.equal(calls.length, 0);
  assert.deepEqual(listPredictions(dbPath, 'WTICO/USD', 'M5'), []);
});

test('concurrent reuse calls share one run; calls without reuse stay independent', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'pred-')), 'db.sqlite');
  const calls = [];
  const now = Date.parse(bars.at(-1).time) + 30000;
  const input = { instrument: 'WTICO/USD', granularity: 'M5', loadCandles: async () => formingBars };
  const [a, b] = await Promise.all([1, 2].map(() => currentPrediction(dbPath, KEYED, input, { reuse: true, now, fetchFn: okFetch(calls) })));
  assert.deepEqual([a.id, calls.length], [b.id, 1]);
  await Promise.all([1, 2].map(() => currentPrediction(dbPath, KEYED, input, { now, fetchFn: okFetch(calls) })));
  assert.equal(calls.length, 3);
  // different pairs run independently
  const pairs = ['EUR/USD', 'GBP/USD'].map((instrument) => ({ ...input, instrument }));
  await Promise.all(pairs.map((p) => currentPrediction(dbPath, KEYED, p, { reuse: true, now, fetchFn: okFetch(calls) })));
  assert.equal(calls.length, 5);
});

test('a failed shared reuse run reaches every waiting caller, stores nothing, and is not cached', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'pred-')), 'db.sqlite');
  const calls = [];
  const now = Date.parse(bars.at(-1).time) + 30000;
  const input = { instrument: 'WTICO/USD', granularity: 'M5', loadCandles: async () => formingBars };
  const failFetch = async (url, init) => { calls.push({ url, init }); return { ok: false, status: 401 }; };
  const results = await Promise.allSettled([1, 2].map(() => currentPrediction(dbPath, KEYED, input, { reuse: true, now, fetchFn: failFetch })));
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  assert.equal(calls.length, 1);
  assert.deepEqual(listPredictions(dbPath, 'WTICO/USD', 'M5'), []);
  const next = await currentPrediction(dbPath, KEYED, input, { reuse: true, now, fetchFn: okFetch(calls) });
  assert.deepEqual([next.reused, calls.length], [false, 2], 'the next reuse call makes a new provider call');
});

test('listPredictions with directional skips no_trade runs', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'pred-')), 'db.sqlite');
  const now = Date.parse(bars.at(-1).time) + 30000;
  const input = { instrument: 'WTICO/USD', granularity: 'M5', loadCandles: async () => formingBars };
  const long = await currentPrediction(dbPath, KEYED, input, { now, fetchFn: okFetch([]) });
  for (let i = 0; i < 3; i++) await currentPrediction(dbPath, KEYED, input, { now, fetchFn: okFetch([], answer('no_trade')) });
  assert.equal(listPredictions(dbPath, 'WTICO/USD', 'M5', 1, now)[0].action, 'no_trade');
  assert.deepEqual(listPredictions(dbPath, 'WTICO/USD', 'M5', 1, now, { directional: true }).map((p) => p.id), [long.id]);
});

test('market_prediction: copilot only, offered only while on, never to the paper bot', async () => {
  assert.ok(!botToolDefs().some((t) => t.name === 'market_prediction'));
  assert.ok(!chatToolDefs({}).some((t) => t.name === 'market_prediction'));
  assert.ok(chatToolDefs(KEYED).some((t) => t.name === 'market_prediction'));
  const dir = mkdtempSync(join(tmpdir(), 'pred-'));
  const dbPath = join(dir, 'db.sqlite');
  storeCandles(dbPath, 'WTICO/USD', 'M5', bars);
  const calls = [];
  const ctx = { dbPath, settings: KEYED, view: { instrument: 'WTICO/USD', granularity: 'M5' }, providerFetch: okFetch(calls), fetcher: null };
  await assert.rejects(execChatTool('market_prediction', {}, { ...ctx, caller: undefined }), /copilot only/);
  await assert.rejects(execChatTool('market_prediction', {}, { ...ctx, caller: 'chat', settings: {} }), /predictions are off/);
  // an explicit but invalid argument is refused, never replaced by the current view
  for (const granularity of ['1h', 'h1', 'D']) await assert.rejects(execChatTool('market_prediction', { granularity }, { ...ctx, caller: 'chat' }), /unsupported granularity/);
  await assert.rejects(execChatTool('market_prediction', { instrument: 'oil price' }, { ...ctx, caller: 'chat' }), /invalid instrument/);
  assert.equal(calls.length, 0);
  const out = JSON.parse(await execChatTool('market_prediction', {}, { ...ctx, caller: 'chat' }));
  assert.match(out.advisory, /never places/);
  assert.deepEqual([out.instrument, out.granularity, out.action, out.valid, out.reused], ['WTICO/USD', 'M5', 'long', true, false]);
  const second = JSON.parse(await execChatTool('market_prediction', { granularity: 'M5' }, { ...ctx, caller: 'chat' }));
  assert.equal(second.reused, true);
  assert.equal(calls.length, 1);
});
