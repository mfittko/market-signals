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

// --- issue #10: multi-horizon, excursion-based metric -----------------------

import { computeStudy as study, buildFetchPlan as plan, DEFAULT_HORIZONS } from '../scripts/event-study.mjs';

// One M1 fixture feed spanning 14:34 (pre) .. 15:35 (+60m). Distinct closes at
// each horizon plus an up-spike and a down-dip inside the window, so we can
// assert the slicing math AND that every horizon comes from the SAME series.
function multiHorizonFeed() {
  const preT = Date.parse('2026-07-10T14:34:00Z'); // pre candle
  const anchor = Date.parse('2026-07-10T14:35:00Z'); // idx 0 of post
  const closeAt = { 1: 100.5, 5: 101.0, 15: 100.8, 60: 100.3 };
  const candles = [{ time: new Date(preT).toISOString(), open: 100, high: 100, low: 100, close: 100, volume: 5 }];
  for (let i = 0; i <= 60; i++) {
    const close = closeAt[i] ?? 100.0;
    let high = close + 0.1;
    let low = close - 0.1;
    if (i === 10) high = 102.0; // up-spike -> maxUp +2%
    if (i === 20) low = 99.0;   // down-dip -> maxDn -1%
    candles.push({ time: new Date(anchor + i * 60000).toISOString(), open: close, high, low, close, volume: 10 });
  }
  return candles;
}

const M_T = Date.parse('2026-07-10T14:35:00Z');

test('multi-horizon slices come from ONE feed and cut at anchor + h', () => {
  const feed = multiHorizonFeed();
  const r = study(feed, M_T); // default horizons 1/5/15/60
  assert.equal(r.status, 'ok');
  assert.equal(r.preClose, 100);

  // Signed close-move at each horizon = close of the candle at anchor + h.
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(r.horizons[1].move, 0.5), `+1m ${r.horizons[1].move}`);
  assert.ok(near(r.horizons[5].move, 1.0), `+5m ${r.horizons[5].move}`);
  assert.ok(near(r.horizons[15].move, 0.8), `+15m ${r.horizons[15].move}`);
  assert.ok(near(r.horizons[60].move, 0.3), `+60m ${r.horizons[60].move}`);

  // Excursion is monotonic in the window it covers (F2: same series widened):
  // the +2% up-spike at +10m is invisible to +5m but present from +15m on.
  assert.ok(r.horizons[5].maxUp < 1.5, `+5m maxUp ${r.horizons[5].maxUp} must not see the +10m spike`);
  assert.ok(near(r.horizons[15].maxUp, 2.0), `+15m maxUp ${r.horizons[15].maxUp}`);

  // PRIMARY: full-window max-excursion sees both the up-spike and the down-dip.
  assert.ok(near(r.maxUp, 2.0), `maxUp ${r.maxUp}`);
  assert.ok(near(r.maxDn, -1.0), `maxDn ${r.maxDn}`);

  // The fetch plan is a SINGLE fxempire request wide enough for the 60m horizon.
  const fp = plan(M_T, { preMin: 5, postMin: Math.max(...DEFAULT_HORIZONS) });
  assert.equal(fp.provider, 'fxempire');
  assert.ok(fp.count >= 5 + 60, `count ${fp.count} covers pre + 60m from one feed`);
});

test('H1 fetch plan counts hourly candles, not minutes (single feed)', () => {
  const fp = plan(M_T, { preMin: 60, postMin: 60, stepMin: 60 });
  assert.equal(fp.provider, 'fxempire');
  assert.equal(fp.count, Math.ceil((60 + 60) / 60) + 5, 'H1: count in hours, one request');
});
