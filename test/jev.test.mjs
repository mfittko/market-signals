import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jevActive, jevState, jevDecide, scoreClosedBars, jevDecisions } from '../scripts/jev.mjs';
import { indicatorSummary } from '../scripts/lib/indicator-summary.mjs';
import { computeSupertrend, detectFlips } from '../scripts/supertrend.mjs';

const bars = Array.from({ length: 60 }, (_, i) => {
  const close = 100 + i * 0.5;
  return { time: new Date(Date.UTC(2026, 0, 5, 0, 0) + i * 300000).toISOString(), open: close - 0.25, high: close + 0.5, low: close - 0.5, close, volume: 100 };
});

const answer = (action = 'long') => ({
  model: 'jev-1.13.0',
  answers: {
    action: { type: 'choice', choice: action, probabilities: { long: 0.7, short: 0.1, flat: 0.2 }, confidence: 0.6 },
    setup_quality: { type: 'score', score: 2.5, confidence: 0.8, legend: {}, probabilities: {} },
    trend_confirmed: { type: 'noul', noul: 0.9 },
  },
});
const okFetch = (calls, body = answer()) => async (url, init) => {
  calls.push({ url, init });
  return { ok: true, status: 200, json: async () => body };
};
const KEYED = { TYPESAFE_API_KEY: 'k', jevEnabled: '1' };

test('jevActive needs both a key and the toggle', () => {
  assert.equal(jevActive({}), false);
  assert.equal(jevActive({ jevEnabled: '1' }), false);
  assert.equal(jevActive({ TYPESAFE_API_KEY: 'k' }), false);
  assert.equal(jevActive({ TYPESAFE_API_KEY: 'k', jevEnabled: '0' }), false);
  assert.equal(jevActive(KEYED), true);
  assert.equal(jevActive({ TYPESAFE_API_KEY: 'k', jevEnabled: true }), true);
});

test('jevState buckets every value into words and leaks no price numbers', () => {
  const summary = indicatorSummary(bars);
  const state = jevState(summary, { instrument: 'WTICO/USD', granularity: 'M5', trend: 'up', barsSinceFlip: 2, bar: bars.at(-1) });
  assert.equal(state.timeframe, '5-minute');
  assert.equal(state.supertrend, 'bullish, flipped recently');
  assert.equal(state.price_vs_ema, 'above EMA20 and EMA50');
  assert.equal(state.rsi, 'overbought');
  assert.equal(state.volume, 'average');
  assert.equal(state.recent_range, 'near the 20-bar high');
  assert.equal(state.last_bar, 'green normal-size candle, closing mid-range');
  for (const [k, v] of Object.entries(state)) assert.doesNotMatch(String(v), /\d\.\d/, `${k} carries a price-like number: ${v}`);
});

test('jevDecide sends one typed request and maps the answers', async () => {
  const calls = [];
  const v = await jevDecide(KEYED, { a: 'b' }, { fetchFn: okFetch(calls) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, 'Bearer k');
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(sent.questions), ['action', 'setup_quality', 'trend_confirmed']);
  assert.equal(v.action, 'long');
  assert.equal(v.probabilities.long, 0.7);
  assert.equal(v.quality, 2.5);
  assert.equal(v.trendConfirmed, 0.9);
});

test('jevDecide retries once on 429 and fails on other errors', async () => {
  let n = 0;
  const flaky = async () => (++n === 1 ? { ok: false, status: 429 } : { ok: true, status: 200, json: async () => answer('short') });
  assert.equal((await jevDecide(KEYED, {}, { fetchFn: flaky, retryDelayMs: 0 })).action, 'short');
  assert.equal(n, 2);
  await assert.rejects(jevDecide(KEYED, {}, { fetchFn: async () => ({ ok: false, status: 401 }) }), /HTTP 401/);
  await assert.rejects(jevDecide(KEYED, {}, { fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ answers: {} }) }) }), /typed answers/);
});

test('jevDecide retries once on 529, aborts on timeout, and rejects answers without probabilities', async () => {
  let n = 0;
  const overloaded = async () => (++n === 1 ? { ok: false, status: 529 } : { ok: true, status: 200, json: async () => answer() });
  assert.equal((await jevDecide(KEYED, {}, { fetchFn: overloaded, retryDelayMs: 0 })).action, 'long');
  assert.equal(n, 2);
  const hang = (_, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await assert.rejects(jevDecide(KEYED, {}, { fetchFn: hang, timeoutMs: 10 }), /timeout|aborted/i);
  const noProbs = answer(); delete noProbs.answers.action.probabilities;
  await assert.rejects(jevDecide(KEYED, {}, { fetchFn: async () => ({ ok: true, status: 200, json: async () => noProbs }) }), /typed answers/);
});

test('jevActive treats a whitespace-only key as missing', () => {
  assert.equal(jevActive({ TYPESAFE_API_KEY: '  ', jevEnabled: '1' }), false);
});

test('jevState: a tight range is neither near-high nor near-low only', () => {
  const flat = Array.from({ length: 40 }, (_, i) => ({ time: new Date(Date.UTC(2026, 0, 5) + i * 300000).toISOString(), open: 100, high: 100.2, low: 99.8, close: 100, volume: 100 }));
  const state = jevState(indicatorSummary(flat), { instrument: 'X', granularity: 'M5', trend: 'up', barsSinceFlip: null, bar: flat.at(-1) });
  assert.equal(state.recent_range, 'inside a tight 20-bar range');
  assert.equal(state.supertrend, 'bullish, no flip in view');
});

test('scoreClosedBars scores the newest bars once and is idempotent', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'jev-')), 'c.db');
  const st = computeSupertrend(bars);
  const ctx = { instrument: 'WTICO/USD', granularity: 'M5', candles: bars, st, flips: detectFlips(bars, st) };
  const calls = [];
  assert.equal((await scoreClosedBars(db, KEYED, ctx, { fetchFn: okFetch(calls) })).scored, 3);
  assert.equal((await scoreClosedBars(db, KEYED, ctx, { fetchFn: okFetch(calls) })).scored, 0);
  assert.equal(calls.length, 3);
  const rows = jevDecisions(db, 'WTICO/USD', 'M5', bars[0].time, bars.at(-1).time);
  assert.deepEqual(rows.map((r) => r.time), bars.slice(-3).map((b) => b.time));
  assert.equal(rows[0].action, 'long');
  assert.equal(rows[0].pLong, 0.7);
});

test('scoreClosedBars makes no request when inactive', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'jev-')), 'c.db');
  const st = computeSupertrend(bars);
  const calls = [];
  for (const s of [{}, { jevEnabled: '1' }, { TYPESAFE_API_KEY: 'k' }]) {
    await scoreClosedBars(db, s, { instrument: 'X', granularity: 'M5', candles: bars, st, flips: [] }, { fetchFn: okFetch(calls) });
  }
  assert.equal(calls.length, 0);
});
