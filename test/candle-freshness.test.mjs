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

test('sampleFreshness: picks the newest completed bar even from an unsorted tail', async () => {
  const now = clock([1, 2]);
  // rows newest-first + shuffled; bar(4) is the newest completed, bar(5) forming
  const fetcher = async () => [bar(5, { complete: false }), bar(2), bar(4), bar(3)];
  const s = await sampleFreshness({ instrument: 'X', granularity: 'M1', fetcher, now });
  assert.equal(s.lastComplete.time, bar(4).time, 'newest completed by timestamp, not by position');
  assert.equal(s.forming.time, bar(5).time);
});

test('sampleFreshness: a fetch error is captured, not thrown', async () => {
  const now = clock([1000, 1005]);
  const s = await sampleFreshness({ instrument: 'X', granularity: 'M1', fetcher: async () => { throw new Error('boom'); }, now });
  assert.equal(s.error, 'boom');
  assert.equal(s.forming, null);
  assert.equal(s.requestMs, 5);
});

test('sampleFreshness: a non-Error throw is coerced to a string (no undefined)', async () => {
  const now = clock([1, 2]);
  const s = await sampleFreshness({ instrument: 'X', granularity: 'M1', fetcher: async () => { throw 'raw failure'; }, now }); // eslint-disable-line no-throw-literal
  assert.equal(s.error, 'raw failure', 'coerced, not undefined');
});

test('foldChange: a high/low-only move (close unchanged) still counts as a change', () => {
  let st = initState();
  st = foldChange(st, { at: 1000, requestMs: 5, forming: { time: bar(5).time, open: 100, high: 101, low: 99, close: 100, volume: 5 } });
  // close/volume identical, but high extended — providers do this intrabar
  st = foldChange(st, { at: 1020, requestMs: 5, forming: { time: bar(5).time, open: 100, high: 102, low: 99, close: 100, volume: 5 } });
  assert.equal(st.changes, 2, 'both the new bar and the high extension are changes');
  assert.deepEqual(st.changeIntervals, [20]);
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

// #145 phase 2: the boundary confirmer's retry ladder has to cover the delay
// between a bar's close boundary and the provider first serving it complete.
test('foldChange: records completion delay when a newly completed bar appears', () => {
  const step = 60000;
  let st = initState();
  // first sighting only baselines lastCompleteTime — no delay recorded, since we
  // did not observe the transition (the bar may have completed long before).
  st = foldChange(st, { at: T0 + 5 * step + 1000, requestMs: 5, stepMs: step, lastComplete: { time: bar(4).time }, forming: { time: bar(5).time, close: 1 } });
  assert.equal(st.completionDelays.length, 0, 'first sighting is a baseline, not a measurement');
  // bar 5 closes at T0+6min; served complete 2.4s after that boundary
  st = foldChange(st, { at: T0 + 6 * step + 2400, requestMs: 5, stepMs: step, lastComplete: { time: bar(5).time }, forming: { time: bar(6).time, close: 2 } });
  assert.deepEqual(st.completionDelays, [2400], 'delay = observedAt − (barOpen + granularity)');
  // an unchanged lastComplete records nothing
  st = foldChange(st, { at: T0 + 6 * step + 9000, requestMs: 5, stepMs: step, lastComplete: { time: bar(5).time }, forming: { time: bar(6).time, close: 3 } });
  assert.equal(st.completionDelays.length, 1, 'same completed bar is not re-counted');
  const sum = summarize(st);
  assert.equal(sum.completionDelayMsMedian, 2400);
  assert.equal(sum.completionDelayMsMax, 2400);
  assert.equal(sum.completionSamples, 1);
});

test('foldChange: a non-finite or negative completion delay is dropped, not folded into the stats', () => {
  const step = 60000;
  let st = initState();
  st = foldChange(st, { at: T0 + 5 * step, requestMs: 5, stepMs: step, lastComplete: { time: bar(4).time }, forming: null });
  // caller omitted stepMs -> NaN delay
  st = foldChange(st, { at: T0 + 6 * step + 500, requestMs: 5, lastComplete: { time: bar(5).time }, forming: null });
  // unparseable upstream timestamp
  st = foldChange(st, { at: T0 + 7 * step + 500, requestMs: 5, stepMs: step, lastComplete: { time: 'not-a-date' }, forming: null });
  // clock skew: served BEFORE the bar closed
  st = foldChange(st, { at: T0 + 7 * step - 4000, requestMs: 5, stepMs: step, lastComplete: { time: bar(7).time }, forming: null });
  assert.deepEqual(st.completionDelays, [], 'no junk samples recorded');
  assert.equal(summarize(st).completionDelayMsMedian, null, 'median stays null rather than NaN');
});
