#!/usr/bin/env node
// Indicator primitives (issue #32): pure OHLCV→series functions, computed at
// read time like supertrend — no persistence, no I/O, no new dependencies.
// Display set is wide; the GATE uses the axis-grouped snapshot (see
// axisSnapshot) so correlated indicators can never double-count.
import { computeSupertrend, granularityMs } from './supertrend.mjs';

export function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

// Wilder RSI; null until enough data.
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const line = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const signal = ema(line, signalPeriod);
  return { line, signal, hist: line.map((v, i) => v - signal[i]) };
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = new Array(closes.length).fill(null);
  const upper = [...mid]; const lower = [...mid]; const width = [...mid];
  for (let i = period - 1; i < closes.length; i++) {
    const win = closes.slice(i - period + 1, i + 1);
    const m = win.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / period);
    mid[i] = m; upper[i] = m + mult * sd; lower[i] = m - mult * sd;
    width[i] = m !== 0 ? (2 * mult * sd) / m : null;
  }
  return { mid, upper, lower, width };
}

// Session VWAP: resets at each UTC day boundary of the candle timestamps.
export function vwap(candles) {
  const out = [];
  let pv = 0;
  let vol = 0;
  let day = null;
  for (const c of candles) {
    const d = c.time.slice(0, 10);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const typical = (c.high + c.low + c.close) / 3;
    const v = c.volume || 0;
    pv += typical * v; vol += v;
    out.push(vol > 0 ? pv / vol : typical);
  }
  return out;
}

// Wilder ATR; null until enough data.
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = (i) => Math.max(
    candles[i].high - candles[i].low,
    Math.abs(candles[i].high - candles[i - 1].close),
    Math.abs(candles[i].low - candles[i - 1].close));
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr(i);
  out[period] = sum / period;
  for (let i = period + 1; i < candles.length; i++) out[i] = (out[i - 1] * (period - 1) + tr(i)) / period;
  return out;
}

// Wilder ADX; null until 2*period warm-up.
export function adx(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period * 2) return out;
  let trS = 0; let plusS = 0; let minusS = 0;
  const dx = new Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    const plusDM = up > down && up > 0 ? up : 0;
    const minusDM = down > up && down > 0 ? down : 0;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close));
    if (i <= period) { trS += tr; plusS += plusDM; minusS += minusDM; }
    else {
      trS = trS - trS / period + tr;
      plusS = plusS - plusS / period + plusDM;
      minusS = minusS - minusS / period + minusDM;
    }
    if (i >= period && trS > 0) {
      const pdi = (plusS / trS) * 100;
      const mdi = (minusS / trS) * 100;
      dx[i] = pdi + mdi > 0 ? (Math.abs(pdi - mdi) / (pdi + mdi)) * 100 : 0;
    }
  }
  let adxV = null;
  for (let i = period * 2; i < candles.length; i++) {
    if (adxV === null) {
      const win = dx.slice(period, period * 2 + 1).filter((x) => x !== null);
      adxV = win.reduce((a, b) => a + b, 0) / win.length;
    } else adxV = (adxV * (period - 1) + dx[i]) / period;
    out[i] = adxV;
  }
  return out;
}

export function volumeRatio(candles, period = 20) {
  // a full window is required: partial-history ratios are incomparable
  if (candles.length < period + 1) return null;
  const win = candles.slice(-(period + 1), -1).map((c) => c.volume || 0);
  const avg = win.reduce((a, b) => a + b, 0) / win.length;
  const last = candles[candles.length - 1].volume || 0;
  return avg > 0 ? last / avg : null;
}

// Resample completed candles to a coarser granularity (bucketed by target
// duration) for higher-timeframe supertrend agreement.
export function resampleCandles(candles, fromGranularity, toGranularity) {
  const toMs = granularityMs(toGranularity);
  const fromMs = granularityMs(fromGranularity);
  const buckets = new Map();
  for (const c of candles) {
    if (c.complete === false || c.partial === true) continue; // forming candles never enter coarse buckets
    const bucket = Math.floor(Date.parse(c.time) / toMs) * toMs;
    if (!buckets.has(bucket)) {
      buckets.set(bucket, { time: new Date(bucket).toISOString(), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0, complete: true });
    } else {
      const b = buckets.get(bucket);
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume || 0;
    }
  }
  const out = [...buckets.values()].sort((a, b) => a.time.localeCompare(b.time));
  // the trailing bucket is complete only when its full span is covered
  if (out.length) {
    const lastComplete = candles.filter((c) => c.complete !== false && c.partial !== true);
    const lastSrc = lastComplete.length ? Date.parse(lastComplete[lastComplete.length - 1].time) + fromMs : 0;
    const lastBucket = out[out.length - 1];
    if (Date.parse(lastBucket.time) + toMs > lastSrc) lastBucket.complete = false;
  }
  return out;
}

// Higher-timeframe supertrend trend for the latest bar (agreement check).
export function htfSupertrend(candles, fromGranularity, toGranularity, opts = { period: 10, multiplier: 3 }) {
  // agreement checks judge COMPLETED higher-timeframe bars only
  const coarse = resampleCandles(candles, fromGranularity, toGranularity).filter((c) => c.complete !== false);
  if (coarse.length < opts.period + 2) return null;
  const st = computeSupertrend(coarse, opts);
  const last = st[st.length - 1];
  return last ? { trend: last.trend, value: Number(last.supertrend.toFixed(4)), candles: coarse.length } : null;
}
