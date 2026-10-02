import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indicatorSummary } from '../scripts/lib/indicator-summary.mjs';

// 60 rising M5 bars with a constant 1.0 range, then a forming bar that must be ignored.
const bars = Array.from({ length: 60 }, (_, i) => {
  const close = 100 + i * 0.5;
  return { time: new Date(Date.UTC(2026, 0, 5, 0, 0) + i * 300000).toISOString(), open: close - 0.25, high: close + 0.5, low: close - 0.5, close, volume: 100 };
});
const forming = { time: new Date(Date.UTC(2026, 0, 5, 5, 0)).toISOString(), open: 130, high: 999, low: 1, close: 500, volume: 1, partial: true };

test('indicatorSummary reads completed bars only and places price against the recent extremes', () => {
  const s = indicatorSummary([...bars, forming]);
  assert.equal(s.close, 129.5);
  assert.equal(s.extremes.high, 130); // the forming bar's 999 is ignored
  assert.equal(s.extremes.barsSinceHigh, 0);
  assert.ok(s.extremes.highAtr >= 0 && s.extremes.highAtr < 1, `close is within one ATR of the high: ${s.extremes.highAtr}`);
  assert.ok(s.extremes.lowAtr > 5, `close is far above the 20-bar low: ${s.extremes.lowAtr}`);
  assert.equal(s.volume.ratio20, 1);
  assert.ok(s.rsi14 > 90 && s.ema.ema20 < s.close && s.ema.ema200 === null);
  assert.equal(s.bollinger.pctB > 0.5, true);
});

test('indicatorSummary declines when there is too little history', () => {
  assert.equal(indicatorSummary(bars.slice(0, 5)), null);
});
