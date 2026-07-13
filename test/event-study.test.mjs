import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStudy, splitAtAnchor, buildFetchPlan, candleMs } from '../scripts/event-study.mjs';

// Build an M1 fixture series around an anchor, 100.0 pre, stepping after.
function series(startISO, closes) {
  const start = Date.parse(startISO);
  return closes.map((close, i) => ({
    time: new Date(start + i * 60000).toISOString(),
    open: close, high: close + 0.5, low: close - 0.5, close, volume: 10,
  }));
}

const T = Date.parse('2026-07-10T14:35:00Z');

test('F2: pre = candle before T, post starts at first candle >= T, one feed', () => {
  // Candles at 14:30..14:39. T = 14:35. Pre must be the 14:34 candle.
  const s = series('2026-07-10T14:30:00Z', [100, 100.1, 100.2, 100.3, 100.4, 101, 101, 101, 101, 101]);
  const { series: norm, preIdx, postStartIdx } = splitAtAnchor(s, T);
  assert.equal(norm[preIdx].ms, Date.parse('2026-07-10T14:34:00Z'), 'pre is candle before T');
  assert.equal(norm[postStartIdx].ms, T, 'post starts at first candle >= T');

  // The fetch plan proves single-feed: one fxempire request, no oanda leg.
  const plan = buildFetchPlan(T, { preMin: 5, postMin: 15 });
  assert.equal(plan.provider, 'fxempire');
  assert.equal(plan.from, Math.floor(T / 1000) - 5 * 60, 'from = T - preMin');
  assert.ok(plan.count >= 5 + 15, 'count covers pre + post');
});

test('in-session move is measured off the pre-close', () => {
  const s = series('2026-07-10T14:30:00Z', [100, 100, 100, 100, 100, 101, 101, 101, 101, 101]);
  const r = computeStudy(s, T, { postMin: 4 });
  assert.equal(r.status, 'ok');
  assert.equal(r.mode, 'in-session');
  assert.equal(r.preClose, 100);
  assert.ok(Math.abs(r.move - 1.0) < 1e-9, `expected +1% got ${r.move}`);
});

test('next-open: a large gap before the first post candle is labelled next-open', () => {
  // Pre candle at 14:34 (Friday close), then market shut; next candle 2 days later.
  const pre = series('2026-07-10T14:31:00Z', [100, 100, 100, 100]); // ..14:34
  const open = series('2026-07-13T13:30:00Z', [102, 102, 102, 102]); // Sunday/Mon reopen
  const r = computeStudy([...pre, ...open], T, { postMin: 15 });
  assert.equal(r.status, 'ok');
  assert.equal(r.mode, 'next-open');
  assert.equal(r.preClose, 100);
  assert.ok(Math.abs(r.move - 2.0) < 1e-9, `weekend gap move ${r.move}`);
});

test('market closed with no post candle at all -> closed/no-data', () => {
  const s = series('2026-07-10T14:30:00Z', [100, 100, 100, 100, 100]); // all before T=14:35? last is 14:34
  const r = computeStudy(s, T, { postMin: 15 });
  assert.equal(r.status, 'closed/no-data');
});

test('no pre candle -> no-pre (do not fabricate a basis)', () => {
  const s = series('2026-07-10T14:35:00Z', [100, 101, 101]); // first candle is exactly T
  const r = computeStudy(s, T, { postMin: 15 });
  assert.equal(r.status, 'no-pre');
});

test('candleMs tolerates fxempire "YYYY/MM/DD HH:MM" and ISO', () => {
  assert.equal(candleMs('2026/07/10 14:35'), Date.parse('2026-07-10T14:35:00Z'));
  assert.equal(candleMs('2026-07-10T14:35:00Z'), Date.parse('2026-07-10T14:35:00Z'));
});
