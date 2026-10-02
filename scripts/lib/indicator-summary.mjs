// Numbers a strategy prompt asks about, computed once from completed candles:
// ATR, EMAs, Bollinger position, MACD histogram, volume versus its average and
// where price sits against the recent extremes (in ATR). Pure: candles in, plain
// numbers out. The forming bar is ignored, so a value never moves mid-bar.
import { atr, bollinger, ema, macd, rsi, vwap, volumeRatio } from '../indicators.mjs';

const lastOf = (a) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null && Number.isFinite(a[i])) return a[i]; return null; };
const r = (v, d = 3) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

export function indicatorSummary(candles, { swing = 20 } = {}) {
  const done = candles.filter((c) => c.complete !== false && !c.partial);
  if (done.length < 15) return null;
  const closes = done.map((c) => c.close);
  const bar = done[done.length - 1];
  const atrNow = lastOf(atr(done, 14));
  const per = (v) => (atrNow > 0 && v != null ? (v - bar.close) / atrNow : null); // signed distance from close, in ATR

  // recent extremes over the last `swing` completed bars, including the current one
  const win = done.slice(-swing);
  const hi = Math.max(...win.map((c) => c.high));
  const lo = Math.min(...win.map((c) => c.low));
  const bb = bollinger(closes, 20, 2);
  const up = lastOf(bb.upper), dn = lastOf(bb.lower);
  const day = bar.time.slice(0, 10);
  const today = done.filter((c) => c.time.slice(0, 10) === day);
  const vw = lastOf(vwap(done));
  const m = macd(closes);

  return {
    asOf: bar.time,
    close: bar.close,
    atr14: r(atrNow, 4),
    atrPct: r(atrNow > 0 ? (atrNow / bar.close) * 100 : null, 3),
    barRangeAtr: r(atrNow > 0 ? (bar.high - bar.low) / atrNow : null, 2),
    rsi14: r(lastOf(rsi(closes, 14)), 1),
    ema: { ema20: r(lastOf(ema(closes, 20)), 4), ema50: closes.length >= 50 ? r(lastOf(ema(closes, 50)), 4) : null, ema200: closes.length >= 200 ? r(lastOf(ema(closes, 200)), 4) : null },
    bollinger: up != null && dn != null ? { upper: r(up, 4), lower: r(dn, 4), pctB: r((bar.close - dn) / (up - dn), 2) } : null,
    macdHist: r(lastOf(m.hist), 5),
    vwap: r(vw, 4),
    volume: { last: bar.volume ?? null, ratio20: r(volumeRatio(done, 20), 2) },
    extremes: {
      window: win.length,
      high: hi, low: lo,
      barsSinceHigh: win.length - 1 - win.map((c) => c.high).lastIndexOf(hi),
      barsSinceLow: win.length - 1 - win.map((c) => c.low).lastIndexOf(lo),
      highAtr: r(per(hi), 2), // how far below the high the close sits, in ATR
      lowAtr: r(-per(lo), 2), // how far above the low the close sits, in ATR
      dayHigh: today.length ? Math.max(...today.map((c) => c.high)) : null,
      dayLow: today.length ? Math.min(...today.map((c) => c.low)) : null,
    },
  };
}
