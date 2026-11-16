import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barMs, withPrice } from '../platform/web/lib/forming-bar.ts';

const done = { time: '2026-11-16T10:00:00Z', open: 10, high: 11, low: 9, close: 10, complete: true };
const forming = { time: '2026-11-16T10:05:00Z', open: 10, high: 10.5, low: 9.8, close: 10.2, complete: false };
const at = (min, sec = 0) => `2026-11-16T10:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.123456789Z`;

test('bar length from granularity', () => {
  assert.equal(barMs('M5'), 300e3);
  assert.equal(barMs('H4'), 4 * 3600e3);
  assert.equal(barMs('M'), null);
});

test('a tick inside the forming bar moves its close, high and low', () => {
  const range = { current: null };
  const out = withPrice([done, forming], { mid: 10.9, time: at(6) }, 'M5', range);
  assert.deepEqual(out[1], { ...forming, close: 10.9, high: 10.9 });
  assert.equal(out[0], done);
});

test('a finished last bar, a missing price or an untimestamped tick change nothing', () => {
  const cs = [done, forming];
  assert.equal(withPrice([forming, done], { mid: 99, time: at(6) }, 'M5', { current: null })[1], done);
  assert.equal(withPrice(cs, null, 'M5', { current: null }), cs);
  assert.equal(withPrice(cs, { mid: 99, time: null }, 'M5', { current: null }), cs);
});

test('a tick from before the bar start is left out', () => {
  const cs = [done, forming];
  assert.equal(withPrice(cs, { mid: 99, time: at(4, 59) }, 'M5', { current: null }), cs);
});

test('poll extremes stay on the bar and a tick past its end keeps the last in-bar close', () => {
  const range = { current: null };
  withPrice([done, forming], { mid: 11.5, time: at(6) }, 'M5', range);
  const back = withPrice([done, forming], { mid: 10.1, time: at(7) }, 'M5', range);
  assert.equal(back[1].high, 11.5);
  assert.equal(back[1].close, 10.1);
  const after = withPrice([done, forming], { mid: 50, time: at(10) }, 'M5', range);
  assert.equal(after[1].close, 10.1);
  assert.equal(after[1].high, 11.5);
});
