// P(profit) for a long and a short entered now, per instrument and timeframe,
// from the pprofit20 research artifacts in config/prediction-models (logistic
// model with side interactions, Platt calibration, expected R by P decile).
// The trade is a fixed plan: stop 1.5 x Wilder ATR14 = 1R, breakeven at +1R,
// target 3R, out at an opposite supertrend flip or after 72 bars, net of
// bid/ask. Calibrated in development evidence only; never an edge claim.
// This module ports the research features (pp20.py bar_features) to Node and
// keeps a bid/ask candle window per pair. test/fixtures holds a parity export.
import { readFileSync } from 'node:fs';
import { computeSupertrend, granularityMs } from './supertrend.mjs';

// Bars the features need: 1440 for the ATR mean plus warm-up; the feed returns at most 5000.
export const PP_WINDOW_BARS = 5000;
const STOP_ATR = 1.5;
const CLIP = { spr: [0, 2], lrv12: [-3, 3], lrv72: [-3, 3], latr: [-3, 3], lrng: [-5, 5], mv: [-20, 20], dst: [-10, 10] };
const clip = (k, v) => Math.min(Math.max(v, CLIP[k][0]), CLIP[k][1]);

const models = new Map();
// The research artifact for a pair, or null (only calibrated pairs were exported).
export function ppModel(instrument, granularity) {
  const key = `${instrument}|${granularity}`;
  if (!models.has(key)) {
    let m = null;
    if (granularity === 'M5' || granularity === 'M15') {
      try {
        m = JSON.parse(readFileSync(new URL(`../config/prediction-models/artifact_${instrument.replace('/', '_')}${granularity === 'M5' ? '' : '_M15'}_pprofit20.json`, import.meta.url), 'utf8'));
      } catch { /* no artifact for this pair */ }
    }
    models.set(key, m);
  }
  return models.get(key);
}

// Wilder ATR14 on mid: TR_0 = h - l; seed = mean(TR_0..TR_13) at index 13.
function atr14(h, l, c, n = 14) {
  const out = new Array(c.length).fill(NaN);
  if (c.length < n) return out;
  const tr = c.map((_, j) => (j ? Math.max(h[j] - l[j], Math.abs(h[j] - c[j - 1]), Math.abs(l[j] - c[j - 1])) : h[j] - l[j]));
  let a = 0;
  for (let j = 0; j < n; j++) a += tr[j];
  a /= n; out[n - 1] = a;
  for (let j = n; j < c.length; j++) { a = (a * (n - 1) + tr[j]) / n; out[j] = a; }
  return out;
}

const trendOf = (st) => st.map((s) => (s ? (s.trend === 'up' ? 1 : -1) : 0));

// Per-bar series for a bid/ask window (oldest first; time, bid_o..bid_c, ask_o..ask_c).
export function ppSeries(bars, granularity) {
  const gm = granularityMs(granularity) / 60000;
  const t = bars.map((b) => Math.round(Date.parse(b.time) / 60000));
  const mid = (k) => bars.map((b) => (b[`bid_${k}`] + b[`ask_${k}`]) / 2);
  const o = mid('o'); const h = mid('h'); const l = mid('l'); const c = mid('c');
  const st = computeSupertrend(h.map((_, j) => ({ high: h[j], low: l[j], close: c[j] })), { period: 10, multiplier: 3 });
  // H1 bars on the hour from the bid/ask fields, mid per field
  const H = [];
  for (let j = 0; j < bars.length; j++) {
    const ht = Math.floor(t[j] / 60) * 60;
    const b = bars[j];
    if (!H.length || H.at(-1).t !== ht) H.push({ t: ht, bo: b.bid_o, ao: b.ask_o, bh: b.bid_h, ah: b.ask_h, bl: b.bid_l, al: b.ask_l, bc: b.bid_c, ac: b.ask_c });
    else {
      const x = H.at(-1);
      x.bh = Math.max(x.bh, b.bid_h); x.ah = Math.max(x.ah, b.ask_h); x.bl = Math.min(x.bl, b.bid_l); x.al = Math.min(x.al, b.ask_l); x.bc = b.bid_c; x.ac = b.ask_c;
    }
  }
  const trH = H.length >= 12 ? trendOf(computeSupertrend(H.map((x) => ({ high: (x.bh + x.ah) / 2, low: (x.bl + x.al) / 2, close: (x.bc + x.ac) / 2 })), { period: 10, multiplier: 3 })) : H.map(() => 0);
  // last completed H1 bar per bar: H.t + 60 <= t + gm
  const trH1 = []; let k = -1;
  for (let j = 0; j < bars.length; j++) {
    while (k + 1 < H.length && H[k + 1].t + 60 <= t[j] + gm) k++;
    trH1.push(k >= 0 ? trH[k] : 0);
  }
  const day = t.map((v) => Math.floor((v + 120) / 1440));
  const dopen = []; const rng = [];
  let hi = -Infinity; let lo = Infinity; let op = NaN;
  for (let j = 0; j < bars.length; j++) {
    if (!j || day[j] !== day[j - 1]) { hi = -Infinity; lo = Infinity; op = o[j]; }
    hi = Math.max(hi, h[j]); lo = Math.min(lo, l[j]);
    dopen.push(op); rng.push(hi - lo);
  }
  return { gm, t, c, bars, atr: atr14(h, l, c), trend: trendOf(st), line: st.map((s) => (s ? s.supertrend : NaN)), trH1, day, dopen, rng };
}

const meanOf = (a, from, to) => { let s = 0; for (let j = from; j <= to; j++) s += a[j]; return s / (to - from + 1); };

// The 18 base features at bar i in artifact order, with the direction-dependent
// ones unsigned (multiply by side). lrng is raw here; the tod norm is subtracted when scoring.
// Null when the bar is not valid (warm-up, zero trend, non-finite).
export function ppFeatures(S, i) {
  const { t, c, atr, gm } = S;
  const a = atr[i];
  if (!(a > 0) || S.trend[i] === 0 || S.trH1[i] === 0 || i < 1452 || i < 72 || i < 3) return null;
  const b = S.bars[i];
  const m = (2 * Math.PI * ((t[i] + gm) % 1440)) / 1440;
  const dw = (S.day[i] + 3) % 7;
  const lrv = (n) => {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (c[j] - c[j - 1]) ** 2;
    return clip(`lrv${n}`, Math.log(Math.max(Math.sqrt(s / n), 1e-12 * a) / a));
  };
  const d3 = c[i] - c[i - 3];
  const f = {
    spr: clip('spr', (b.ask_c - b.bid_c) / (STOP_ATR * a)),
    h_s1: Math.sin(m), h_c1: Math.cos(m), h_s2: Math.sin(2 * m), h_c2: Math.cos(2 * m), h_s3: Math.sin(3 * m), h_c3: Math.cos(3 * m),
    mon: dw === 0 ? 1 : 0, fri: dw === 4 ? 1 : 0,
    lrv12: lrv(12), lrv72: lrv(72),
    latr: clip('latr', Math.log(a / meanOf(atr, i - 1439, i))),
    lrng: clip('lrng', Math.log(Math.max(S.rng[i], 1e-12 * a) / a)),
    mv: clip('mv', (c[i] - S.dopen[i]) / a), st_al: S.trend[i], h1_al: S.trH1[i], dst: clip('dst', (c[i] - S.line[i]) / a),
    burst: Math.abs(d3) / a > 2.5 ? Math.sign(d3) : 0,
  };
  return Object.values(f).every(Number.isFinite) ? { f, slot: Math.floor(((t[i] + 120) % 1440) / gm), atr: a } : null;
}

const SIGNED = ['mv', 'st_al', 'h1_al', 'dst', 'burst'];
// The model's feature row for one side: direction features times side, lrng minus its time-of-day norm.
export function ppRow(model, feat, side) {
  return model.features.order.map((k) => (k === 'lrng' ? feat.f.lrng - model.tod_norm[feat.slot] : SIGNED.includes(k) ? side * feat.f[k] : feat.f[k]));
}

// Raw score and calibrated P for one side, and the expected R of the P decile.
export function ppScore(model, feat, side) {
  const x = ppRow(model, feat, side);
  const z = x.map((v, j) => (v - model.scaler.mean[j]) / model.scaler.std[j]);
  const design = [...z, side, ...z.map((v) => side * v)];
  let raw = model.intercept;
  for (let j = 0; j < design.length; j++) raw += model.coef[j] * design[j];
  const p = 1 / (1 + Math.exp(-(model.calibrator.a * raw + model.calibrator.b)));
  const lut = model.expected_R[side > 0 ? 'long' : 'short'];
  const decile = lut.p_edges.filter((e) => e <= p).length;
  return { raw, p, decile: decile + 1, expectedR: lut.meanR[decile], ci: lut.meanR_ci?.[decile] ?? null, n: lut.n[decile] };
}

// Bid/ask candles from the public feed, oldest first, complete bars only.
export async function fetchBaCandles(instrument, granularity, count, { fetchFn = fetch } = {}) {
  const url = new URL('https://p.fxempire.com/oanda/candles/latest');
  for (const [k, v] of Object.entries({ instrument, granularity, count: String(count), price: 'BA', alignmentTimezone: 'UTC' })) url.searchParams.set(k, v);
  const res = await fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for bid/ask candles`);
  const out = [];
  for (const r of (await res.json())?.candles ?? []) {
    const b = { time: r?.time };
    for (const s of ['bid', 'ask']) for (const x of 'ohlc') b[`${s}_${x}`] = Number(r?.[s]?.[x]);
    if (r?.complete && b.time && Object.values(b).slice(1).every(Number.isFinite)) out.push(b);
  }
  return out.sort((x, y) => Date.parse(x.time) - Date.parse(y.time));
}

// Bid/ask window per pair, kept in memory: one full fetch, then the newest few bars per call.
// ponytail: in-process cache, lost on restart (one full fetch again); persist if restarts get frequent.
const windows = new Map();
export async function baWindow(instrument, granularity, count, opts = {}) {
  const key = `${instrument}|${granularity}|${count}`;
  const have = windows.get(key);
  const gMs = granularityMs(granularity);
  let bars;
  if (have?.length && count > 10) {
    const tail = await fetchBaCandles(instrument, granularity, 10, opts);
    if (tail.length && Date.parse(tail[0].time) - Date.parse(have.at(-1).time) > 1.5 * gMs) bars = await fetchBaCandles(instrument, granularity, count, opts);
    else {
      const byTime = new Map(have.map((b) => [b.time, b]));
      for (const b of tail) byTime.set(b.time, b);
      bars = [...byTime.values()].sort((x, y) => Date.parse(x.time) - Date.parse(y.time)).slice(-count);
    }
  } else bars = await fetchBaCandles(instrument, granularity, count, opts);
  windows.set(key, bars);
  return bars;
}
// Tests only: forget the cached windows.
export const clearBaWindows = () => windows.clear();
