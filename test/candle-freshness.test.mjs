import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleFreshness, foldChange, summarize, initState } from '../scripts/candle-freshness.mjs';

// #145: hermetic — injected fetcher + a fake monotonic clock, no network, no timers.
const T0 = Date.parse('2026-07-22T08:00:00Z');
const bar = (i, over = {}) => ({ time: new Date(T0 + i * 60000).toISOString(), open: 1, high: 1, low: 1, close: 100 + i, volume: 10 + i, complete: true, ...over });
// clock that returns a queued sequence of timestamps (two reads per sample: t0,t1)
const clock = (seq) => { let i = 0; return () => seq[Math.min(i++, seq.length - 1)]; };

test('sampleFreshness: times the request and extracts forming + last-complete + lag', async () => {
  // forming bar #5 opened at T0+5min; measured 20s after its close boundary (T0+6min)
  const measuredAt = T0 + 6 * 60000 + 20000;
  const now = clock([measuredAt - 40, measuredAt]); // t0, t1 → 40ms request
  const fetcher = async () => [bar(3), bar(4), bar(5, { complete: false, close: 105 })];
  const s = await sampleFreshness({ instrument: 'BCO/USD', granularity: 'M1', fetcher, now });
  assert.equal(s.requestMs, 40, 'request duration measured');
  assert.equal(s.forming.time, bar(5).time, 'forming (incomplete) bar surfaced');
  assert.equal(s.lastComplete.time, bar(4).time, 'newest completed bar surfaced');
  assert.equal(s.formingLagMs, 20000, 'lag = now − (formingOpen + granularity)');
  assert.equal(s.error, null);
});

test('sampleFreshness: a fetch error is captured, not thrown', async () => {
  const now = clock([1000, 1005]);
  const s = await sampleFreshness({ instrument: 'X', granularity: 'M1', fetcher: async () => { throw new Error('boom'); }, now });
  assert.equal(s.error, 'boom');
  assert.equal(s.forming, null);
  assert.equal(s.requestMs, 5);
});

test('foldChange: counts a moved forming bar and a new bar as changes, records intervals', () => {
  let st = initState();
  // sample A: forming bar 5, close 105, at t=1000
  st = foldChange(st, { at: 1000, requestMs: 10, forming: { time: bar(5).time, close: 105, volume: 10 } });
  // sample B: same bar, unchanged, at t=1005 → NOT a change
  st = foldChange(st, { at: 1005, requestMs: 12, forming: { time: bar(5).time, close: 105, volume: 10 } });
  // sample C: same bar, close moved, at t=1030 → change (interval 30 since A)
  st = foldChange(st, { at: 1030, requestMs: 11, forming: { time: bar(5).time, close: 106, volume: 11 } });
  // sample D: a NEW forming bar 6, at t=1090 → change (interval 60 since C)
  st = foldChange(st, { at: 1090, requestMs: 9, forming: { time: bar(6).time, close: 107, volume: 3 } });
  assert.equal(st.samples, 4);
  assert.equal(st.changes, 3, 'A(new bar), C(moved), D(new bar) — B unchanged');
  assert.deepEqual(st.changeIntervals, [30, 60], 'intervals between consecutive changes');
  const sum = summarize(st);
  assert.equal(sum.observedUpdateCadenceMs, 45, 'median change interval = observed cadence');
  assert.equal(sum.requestMsMedian, 10.5);
  assert.equal(sum.requestMsMax, 12);
});
