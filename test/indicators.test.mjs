import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ema, rsi, macd, bollinger, vwap, atr, adx, volumeRatio, resampleCandles, htfSupertrend } from '../scripts/indicators.mjs';

const candle = (o, h, l, c, v, time) => ({ open: o, high: h, low: l, close: c, volume: v, time, complete: true });
const t = (i, stepMin = 5) => new Date(Date.parse('2026-07-23T00:00:00Z') + i * stepMin * 60000).toISOString();

test('ema: seeds at first value, converges toward a constant, exact 3-period hand-computation', () => {
  assert.deepEqual(ema([], 5), []);
  const flat = ema(Array(50).fill(7), 10);
  assert.ok(Math.abs(flat[49] - 7) < 1e-9, 'converges to the constant (float tolerance)');
  // period 3 → k=0.5: [2, (4*.5+2*.5)=3, (6*.5+3*.5)=4.5]
  assert.deepEqual(ema([2, 4, 6], 3), [2, 3, 4.5]);
});

test('rsi: monotone up → 100, monotone down → 0, warm-up nulls, mixed hand-value', () => {
  const up = rsi(Array.from({ length: 20 }, (_, i) => 100 + i), 14);
  assert.equal(up[13], null, 'null before period+1 samples');
  assert.equal(up[14], 100);
  assert.equal(up[19], 100);
  const down = rsi(Array.from({ length: 20 }, (_, i) => 100 - i), 14);
  assert.equal(down[19], 0);
  // equal gains and losses alternating → RSI 50 (gain avg == loss avg)
  const alt = rsi(Array.from({ length: 29 }, (_, i) => 100 + (i % 2)), 14);
  assert.ok(Math.abs(alt[28] - 50) < 5, 'alternating ±1 oscillates near 50 (Wilder smoothing swings ~±3.6)');
});

test('macd: constant series → zero line/signal/hist; crossover sign flips with trend', () => {
  const m = macd(Array(60).fill(5));
  assert.equal(m.line[59], 0);
  assert.equal(m.hist[59], 0);
  const trendUp = macd([...Array(30).fill(100), ...Array.from({ length: 30 }, (_, i) => 100 + i)]);
  assert.ok(trendUp.line[59] > 0, 'rising series → positive macd line');
});

test('bollinger: constant series → zero width, bands equal mid; symmetric bands', () => {
  const b = bollinger(Array(30).fill(50), 20, 2);
  assert.equal(b.mid[10], null, 'null before the window fills');
  assert.equal(b.mid[29], 50);
  assert.equal(b.upper[29], 50);
  assert.equal(b.width[29], 0);
  const noisy = bollinger([...Array(10).fill(50), ...Array(10).fill(60)], 20, 2);
  assert.ok(Math.abs((noisy.upper[19] - noisy.mid[19]) - (noisy.mid[19] - noisy.lower[19])) < 1e-9, 'bands symmetric around mid');
});

test('vwap: volume-weighted, resets at UTC day boundary', () => {
  const cs = [
    candle(10, 12, 8, 10, 100, '2026-07-22T23:50:00Z'), // typical 10
    candle(20, 22, 18, 20, 100, '2026-07-22T23:55:00Z'), // typical 20 → vwap 15
    candle(30, 32, 28, 30, 100, '2026-07-23T00:00:00Z'), // new day → vwap 30
  ];
  const v = vwap(cs);
  assert.equal(v[1], 15);
  assert.equal(v[2], 30, 'session resets at the day boundary');
});

test('atr: constant-range candles converge to the range; warm-up nulls', () => {
  const cs = Array.from({ length: 40 }, (_, i) => candle(100, 101, 99, 100, 10, t(i)));
  const a = atr(cs, 14);
  assert.equal(a[13], null);
  assert.ok(Math.abs(a[39] - 2) < 1e-9, 'ATR of constant 2-point range is 2');
});

test('adx: strong trend reads high, alternating chop reads low', () => {
  const trend = Array.from({ length: 60 }, (_, i) => candle(100 + i, 101 + i, 99.5 + i, 100.8 + i, 10, t(i)));
  const chop = Array.from({ length: 60 }, (_, i) => candle(100, 101, 99, 100 + (i % 2 === 0 ? 0.3 : -0.3), 10, t(i)));
  const at2 = adx(trend, 14)[59];
  const ac = adx(chop, 14)[59];
  assert.ok(at2 > 60, `strong monotone trend ADX high (${at2})`);
  assert.ok(ac < 25, `alternating chop ADX low (${ac})`);
  assert.equal(adx(trend.slice(0, 20), 14)[19], null, 'null inside 2×period warm-up');
});

test('volumeRatio: last bar vs 20-bar average, excluding itself', () => {
  const cs = [...Array.from({ length: 21 }, (_, i) => candle(1, 1, 1, 1, 100, t(i))), candle(1, 1, 1, 1, 300, t(21))];
  assert.equal(volumeRatio(cs, 20), 3);
  assert.equal(volumeRatio([candle(1, 1, 1, 1, 5, t(0))], 20), null);
  assert.equal(volumeRatio(Array.from({ length: 15 }, (_, i) => candle(1, 1, 1, 1, 100, t(i))), 20), null, 'partial window never yields a ratio');
});

test('resample: M5→M15 buckets OHLCV correctly', () => {
  const cs = [
    candle(10, 12, 9, 11, 5, t(0)), candle(11, 15, 10, 14, 5, t(1)), candle(14, 14.5, 13, 13.5, 5, t(2)),
    candle(13, 13, 11, 12, 7, t(3)),
  ];
  const out = resampleCandles(cs, 'M5', 'M15');
  assert.equal(out.length, 2);
  assert.deepEqual(
    { o: out[0].open, h: out[0].high, l: out[0].low, c: out[0].close, v: out[0].volume },
    { o: 10, h: 15, l: 9, c: 13.5, v: 15 });
  assert.equal(out[1].volume, 7);
  assert.equal(out[1].complete, false, 'trailing bucket with partial coverage marked incomplete');
  const withForming = resampleCandles([...cs, { ...candle(12, 13, 11, 12.5, 9, t(4)), partial: true }], 'M5', 'M15');
  assert.equal(withForming.reduce((a, b) => a + b.volume, 0), 22, 'forming candles never enter buckets');
});

test('htfSupertrend: trending series agrees with its own direction; too-short series → null', () => {
  const cs = Array.from({ length: 180 }, (_, i) => candle(100 + i * 0.2, 100.3 + i * 0.2, 99.9 + i * 0.2, 100.2 + i * 0.2, 10, t(i)));
  const h = htfSupertrend(cs, 'M5', 'M15');
  assert.equal(h.trend, 'up');
  assert.ok(h.candles >= 50);
  assert.equal(htfSupertrend(cs.slice(0, 20), 'M5', 'H1'), null);
});
