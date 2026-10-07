import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jevActive, jevState, jevDecide, jevPredict, jevQuestions } from '../scripts/jev.mjs';
import { indicatorSummary } from '../scripts/lib/indicator-summary.mjs';
import { storeCandles } from '../scripts/supertrend.mjs';
import { buildServer } from '../scripts/signal-server.mjs';
import { writeFileSync } from 'node:fs';

const T0 = Date.UTC(2026, 0, 5, 0, 0);
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
const KEYED = { TYPESAFE_API_KEY: 'k', jevEnabled: '1' };

test('jevActive needs a non-blank key and the toggle', () => {
  assert.equal(jevActive({}), false);
  assert.equal(jevActive({ jevEnabled: '1' }), false);
  assert.equal(jevActive({ TYPESAFE_API_KEY: '  ', jevEnabled: '1' }), false);
  assert.equal(jevActive({ TYPESAFE_API_KEY: 'k', jevEnabled: '0' }), false);
  assert.equal(jevActive(KEYED), true);
  assert.equal(jevActive({ TYPESAFE_API_KEY: 'k', jevEnabled: true }), true);
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
  await assert.rejects(jevDecide(KEYED, {}, 'M5', { fetchFn: hang, timeoutMs: 10 }), /timeout|aborted/i);
  const noProbs = answer(); delete noProbs.answers.action.probabilities;
  await assert.rejects(jevDecide(KEYED, {}, 'M5', { fetchFn: async () => ({ ok: true, status: 200, json: async () => noProbs }) }), /missing typed fields/);
});

test('jevPredict answers for the forming candle with bar progress and higher-timeframe trends', async () => {
  const calls = [];
  const now = Date.parse(bars.at(-1).time) + 100000; // a third of the way into the M5 bar
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
  const server = buildServer({ dbPath, settingsPath, fetcher: null, jevFetch: okFetch(calls) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn({ base, calls }); } finally { server.close(); }
}
const post = (base, body) => fetch(`${base}/api/jev`, { method: 'POST', body: JSON.stringify(body) });

test('POST /api/jev refuses with 409 and no TypeSafe call while off', async () => {
  for (const s of [{}, { jevEnabled: '1' }, { TYPESAFE_API_KEY: ' ', jevEnabled: '1' }, { TYPESAFE_API_KEY: 'k', jevEnabled: '0' }]) {
    await withServer(s, async ({ base, calls }) => {
      const r = await post(base, { instrument: 'WTICO/USD', granularity: 'M5' });
      assert.equal(r.status, 409);
      assert.match((await r.json()).error, /Jev is off/);
      assert.equal(calls.length, 0);
    });
  }
});

test('POST /api/jev returns one prediction, validates input, and masks the key in settings', async () => {
  await withServer(KEYED, async ({ base, calls }) => {
    const r = await post(base, { instrument: 'WTICO/USD', granularity: 'M5' });
    assert.equal(r.status, 200);
    const { prediction } = await r.json();
    assert.equal(prediction.action, 'long');
    assert.equal(prediction.candleTime, bars.at(-1).time);
    assert.equal(calls.length, 1);
    assert.equal((await post(base, { instrument: 'WTICO/USD', granularity: 'bogus' })).status, 400);
    assert.equal((await post(base, { instrument: 'NOPE/USD', granularity: 'M5' })).status, 404);
    const s = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(s.TYPESAFE_API_KEY, '•••');
    const bad = await (await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ jevEnabled: 'yes' }) })).json();
    assert.match(bad.error, /jevEnabled/);
  });
});

test('POST /api/jev rejects a malformed instrument before any fetch', async () => {
  await withServer(KEYED, async ({ base, calls }) => {
    for (const instrument of ['', 'x', 'WTI CO/USD', '../../etc', 'A'.repeat(30)]) {
      assert.equal((await post(base, { instrument, granularity: 'M5' })).status, 400, instrument);
    }
    assert.equal(calls.length, 0);
  });
});
