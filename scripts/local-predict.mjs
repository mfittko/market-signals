// Prediction provider: local statistics. Free, no key, no network beyond the
// candle feed. Recomputed for each closed candle; storage lives in predictions.mjs.
//
// Four parts, each kept honest about what it is:
// 1. Big-day chance (side-free): P(today's session moves T1 % or more from its
//    22:00 UTC open), from the research logistic model in config/prediction-models
//    (abs11 A1 "is today becoming a big day", variant without the cross-instrument
//    stress feature). Features are a port of the research pipeline (abs11 build()
//    on 30-min mid bars); test/fixtures holds a bars -> features -> probability
//    parity export. abs11 A1 failed its preregistered operating rule, so this is
//    a display-only research preview.
// 2. Direction: a constant with an interval. Research found no direction edge
//    (direction AUC <= 0.53 on every instrument), so the estimate is the
//    measured 2023+ up share of the eventual 6h direction. There is no model.
// 3. No-trade reasons: only rules a no-trade study measured as helpful
//    (wide spread, thin trading hour).
// 4. Trend: supertrend side and H1 agreement, a description, not a prediction.
// News is shown and stored for later study, but never sets the side, a
// reason or the big-day number.
import { readFileSync } from 'node:fs';
import { computeSupertrend, granularityMs } from './supertrend.mjs';
import { htfSupertrend } from './indicators.mjs';

export const LOCAL_PROVIDER = 'local';
export const LOCAL_MODEL = 'local-stats-v1 (big day abs11 A1_nostress; direction constant)';
// The direction estimate looks 72 M5 bars (6 hours) ahead.
export const LOCAL_HORIZON_BARS = 72;
// 30-min bars the big-day features need: 60 valid sessions for the slot norm plus margin.
export const A1_WINDOW_BARS = 3600;
const A1_STEP_MIN = 30;
const NORM_N = 60;
const NORM_MIN = 20;
const MIN_SESSION_BARS = 8;
const EPS = 1e-4;
// A side clears the margin only when its share is at least 0.5 + MARGIN and its
// interval lies wholly above one half. Declared before any live run.
export const DIRECTION_MARGIN = 0.05;
export const SPREAD_MAX_R = 0.2; // spread / (1.5 ATR) at the bar
const STOP_ATR = 1.5;
export const NEWS_WINDOW_MS = 6 * 3600000;

// 2023-01-01 to 2026-10 up share of the eventual 6h direction (rule: the larger
// of the up and down excursions over the next 72 M5 bars), 30-minute cadence.
// The interval is a 95% Wilson interval on n/12, because rows 30 minutes apart
// share most of their 6h window. Source: data/research/localpred/up_share.py.
export const DIRECTION_ESTIMATE = {
  'WTICO/USD': { up: 0.4994, lo: 0.483, hi: 0.516, n: 44447 },
  'XAU/USD': { up: 0.5151, lo: 0.499, hi: 0.531, n: 44524 },
  'XAG/USD': { up: 0.4979, lo: 0.482, hi: 0.514, n: 44497 },
  'NATGAS/USD': { up: 0.4993, lo: 0.482, hi: 0.516, n: 40406 },
  'SPX500/USD': { up: 0.5113, lo: 0.495, hi: 0.527, n: 44392 },
  'EUR/USD': { up: 0.5031, lo: 0.487, hi: 0.519, n: 46880 },
};

// UTC hours whose median M5 spread/ATR was highest in 2018-2022 (no-trade study, 4 hours each).
export const THIN_HOURS_UTC = {
  'WTICO/USD': [4, 5, 22, 23], 'XAU/USD': [4, 21, 22, 23], 'XAG/USD': [0, 21, 22, 23],
  'NATGAS/USD': [3, 4, 22, 23], 'SPX500/USD': [3, 4, 5, 6], 'EUR/USD': [4, 21, 22, 23],
};

const models = new Map();
// The research artifact for an instrument, or null when none was exported.
export function bigDayModel(instrument) {
  if (!models.has(instrument)) {
    let m = null;
    try {
      m = JSON.parse(readFileSync(new URL(`../config/prediction-models/artifact_${instrument.replace('/', '_')}_A1_nostress.json`, import.meta.url), 'utf8'));
    } catch { /* no artifact for this instrument */ }
    models.set(instrument, m);
  }
  return models.get(instrument);
}

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;

// The 16 A1_nostress features for the newest bar of `bars` (closed 30-min mid
// bars, oldest first, with time, open, high, low, close), in artifact order.
// Sessions roll at 22:00 UTC. The newest session counts as valid while it is
// still forming; older sessions need 8 bars, as in the research. Null while
// the window is too short. Also returns the session excursion so far (%).
export function bigDayFeatures(bars, T1) {
  const n = bars.length;
  if (n < 2) return null;
  const t = bars.map((b) => Math.round(Date.parse(b.time) / 60000));
  const day = t.map((v) => Math.floor((v + 120) / 1440));
  const r2 = bars.map((b, k) => (k === 0 || day[k] !== day[k - 1] ? Math.log(b.close / b.open) : Math.log(b.close / bars[k - 1].close)) ** 2);
  // sessions in order: first index, bar count, open, close, RV, and the range so far per slot
  const S = [];
  for (let k = 0; k < n; k++) {
    if (!k || day[k] !== day[k - 1]) S.push({ day: day[k], first: k, n: 0, O: bars[k].open, H: -Infinity, L: Infinity, r2: 0, slots: new Map() });
    const s = S.at(-1);
    s.n++; s.H = Math.max(s.H, bars[k].high); s.L = Math.min(s.L, bars[k].low); s.r2 += r2[k]; s.C = bars[k].close;
    s.slots.set(Math.floor(((t[k] + 120) % 1440) / A1_STEP_MIN), (100 * (s.H - s.L)) / s.O);
  }
  const cur = S.at(-1);
  const valid = S.filter((s, k) => s.n >= MIN_SESSION_BARS || k === S.length - 1);
  const prev = valid.slice(0, -1); // valid sessions before the current one
  if (prev.length < 22) return null;
  const RV = (s) => 100 * Math.sqrt(s.r2);
  const i = n - 1;
  const slot = Math.floor(((t[i] + 120) % 1440) / A1_STEP_MIN);
  const past = prev.slice(-NORM_N).map((s) => s.slots.get(slot)).filter((v) => v !== undefined);
  if (past.length < NORM_MIN) return null;
  let r6 = 0;
  for (let k = i; k >= 0 && t[k] > t[i] - 360; k--) r6 += r2[k];
  const O = cur.O;
  const exc = (100 * Math.max(cur.H - O, O - cur.L)) / O;
  const fr = (slot + 1) / (1440 / A1_STEP_MIN);
  const dw = ((cur.day + 3) % 7) / 7;
  const pc = prev.at(-1).C;
  const x = [
    Math.log(RV(prev.at(-1)) + EPS), Math.log(mean(prev.slice(-5).map(RV)) + EPS), Math.log(mean(prev.slice(-22).map(RV)) + EPS),
    Math.log(RV(cur) + EPS), Math.log(100 * Math.sqrt(r6) + EPS), exc, exc / T1, (100 * Math.abs(bars[i].close - O)) / O,
    Math.log((cur.slots.get(slot) + EPS) / (median(past) + EPS)),
    Math.sin(2 * Math.PI * fr), Math.cos(2 * Math.PI * fr), Math.sin(4 * Math.PI * fr), Math.cos(4 * Math.PI * fr),
    Math.sin(2 * Math.PI * dw), Math.cos(2 * Math.PI * dw), (100 * Math.abs(O - pc)) / pc,
  ];
  return x.every(Number.isFinite) ? { x, exc, sessionOpen: new Date((cur.day * 1440 - 120) * 60000).toISOString() } : null;
}

// z and p of the artifact's formula: z = b + sum coef (x - mean) / scale.
export function score(model, x) {
  let z = model.intercept;
  for (let j = 0; j < x.length; j++) z += (model.coefficients[j] * (x[j] - model.scaler.mean[j])) / model.scaler.scale[j];
  return { z, p: 1 / (1 + Math.exp(-z)) };
}

// Bid/ask close of the newest complete bars, from the same public feed as the
// chart. Returns a Map time -> { bid, ask }, or null on any failure.
export async function fetchBidAsk(instrument, granularity, { fetchFn = fetch } = {}) {
  try {
    const url = new URL('https://p.fxempire.com/oanda/candles/latest');
    for (const [k, v] of Object.entries({ instrument, granularity, count: '3', price: 'BA', alignmentTimezone: 'UTC' })) url.searchParams.set(k, v);
    const res = await fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const rows = (await res.json())?.candles ?? [];
    const out = new Map();
    for (const r of rows) {
      const bid = Number(r?.bid?.c); const ask = Number(r?.ask?.c);
      if (r?.complete && Number.isFinite(bid) && Number.isFinite(ask)) out.set(Date.parse(r.time), { bid, ask });
    }
    return out;
  } catch { return null; }
}

// Headline keywords per instrument. The news store has no relevance tagging and its
// per-instrument feeds carry off-topic items, so a headline counts only when it names one of these.
// ponytail: fixed keyword lists; replace with store-side tagging if the feeds get one.
const OIL = ['oil', 'crude', 'OPEC', 'OPEC+', 'Brent', 'WTI', 'refinery', 'refineries', 'pipeline', 'Hormuz', 'Iran sanctions', 'EIA', 'inventories'];
const METALS = ['gold', 'silver', 'bullion', 'precious metals', 'Fed', 'rates', 'inflation'];
const STOCKS = ['S&P', 'Nasdaq', 'stocks', 'equities', 'Fed', 'earnings'];
export const NEWS_KEYWORDS = {
  'WTICO/USD': OIL, 'BCO/USD': OIL, 'XAU/USD': METALS, 'XAG/USD': METALS,
  'NATGAS/USD': ['natural gas', 'LNG', 'Henry Hub', 'storage'],
  'SPX500/USD': STOCKS, 'NAS100/USD': STOCKS, 'EUR/USD': ['euro', 'ECB', 'dollar', 'Fed'],
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const newsRelevant = (instrument, title) => {
  const words = NEWS_KEYWORDS[instrument];
  return Boolean(words && new RegExp(`(^|[^A-Za-z])(${words.map(esc).join('|')})(?![A-Za-z])`, 'i').test(title ?? ''));
};

// Headlines for the instrument from the engine news cache within 6 hours: the newest one
// (stored unchanged for a later study) and the newest relevant one (what the card shows).
// Available-at is the later of the publish time and the time the engine stored it.
// News never feeds a reason or a number.
export function newsInput(db, instrument, now) {
  let rows;
  try {
    rows = db.prepare(`SELECT rowid AS id, title, time, fetched_at, escalation FROM news
      WHERE instrument = ? AND time IS NOT NULL AND time >= ? AND time <= ? ORDER BY time DESC LIMIT 100`)
      .all(instrument, new Date(now - NEWS_WINDOW_MS).toISOString(), new Date(now).toISOString());
  } catch { return null; } // no news table yet
  if (!rows.length) return null;
  const item = (r) => r && {
    id: r.id, title: r.title, escalation: r.escalation === 1 ? 'escalation' : 'routine', relevant: newsRelevant(instrument, r.title),
    publishedAt: r.time, availableAt: new Date(Math.max(Date.parse(r.time), Date.parse(r.fetched_at) || 0)).toISOString(),
  };
  return { latest: item(rows[0]), relevant: item(rows.find((r) => newsRelevant(instrument, r.title))) ?? null };
}

// The evidenced no-trade reasons at the bar that just closed. `closeMs` is that bar's close time.
export function noTradeReasons({ instrument, spreadR, closeMs }) {
  const out = [];
  if (spreadR != null && spreadR > SPREAD_MAX_R) {
    out.push({ code: 'spread', text: `Spread wide (${spreadR.toFixed(2)} of the stop distance, limit ${SPREAD_MAX_R})` });
  }
  const hour = new Date(closeMs).getUTCHours();
  if (THIN_HOURS_UTC[instrument]?.includes(hour)) {
    out.push({ code: 'thin_hour', text: `Thin trading hour (${String(hour).padStart(2, '0')}:00 UTC)` });
  }
  return out;
}

const pct = (v) => `${Math.round(v * 100)}%`;
const word = (v, edges, labels) => { for (let k = 0; k < edges.length; k++) if (v < edges[k]) return labels[k]; return labels.at(-1); };

// The big-day part from the newest closed 30-min bars. Once today has already
// moved T1 % the answer is a fact, not a probability.
function bigDay(instrument, m30, now) {
  const model = bigDayModel(instrument);
  if (!model) return { available: false, text: 'not available for this instrument' };
  const bars = m30.filter((c) => c.partial !== true && c.complete !== false);
  const last = bars.at(-1);
  if (!last || !(Date.parse(last.time) > now - 3 * 1800000)) return { available: false, text: 'no current 30-minute data' };
  const f = bigDayFeatures(bars.slice(-A1_WINDOW_BARS), model.T1_pct);
  if (!f) return { available: false, text: 'not enough 30-minute history' };
  const T1 = model.T1_pct;
  const base = { thresholdPct: T1, usual: model.training_base_rate, movedPct: f.exc, sessionOpen: f.sessionOpen, barTime: last.time, model: `${model.variant}, cutoff ${model.training_cutoff}` };
  if (f.exc >= T1) return { ...base, available: true, reached: true, p: 1, text: `today is already a big day: ${f.exc.toFixed(1)}% from the session open (threshold ${T1.toFixed(1)}%)` };
  const { z, p } = score(model, f.x);
  return { ...base, available: true, reached: false, p, z, x: f.x, text: `${pct(p)} for a move of ${T1.toFixed(1)}% or more today (usual ${pct(model.training_base_rate)}; ${f.exc.toFixed(1)}% so far)` };
}

// One local run for the newest CLOSED candle of the viewed timeframe.
// `candles` are the viewed timeframe (a forming bar is dropped), `m30` the 30-min
// window for the big-day model, `bidAsk` the fetchBidAsk map, `news` newsInput.
export function localPredict({ instrument, granularity, candles, m30 = [], bidAsk = null, news = null }, { now = Date.now() } = {}) {
  const bars = candles.filter((c) => c.partial !== true && c.complete !== false).map(({ partial, complete, ...c }) => c);
  if (bars.length < 12) throw new Error('not enough candle history for a prediction');
  const gMs = granularityMs(granularity);
  const last = bars.at(-1);
  const lastMs = Date.parse(last.time);
  const closeMs = lastMs + gMs;

  // 4. trend context (viewed timeframe, H1 agreement)
  const st = computeSupertrend(bars, {});
  const side = st.at(-1).trend;
  const h1 = gMs < 3600000 ? htfSupertrend(candles, granularity, 'H1')?.trend ?? null : null;
  const trend = { side, h1, text: `supertrend ${side === 'up' ? 'up' : 'down'}, ${h1 == null ? (gMs >= 3600000 ? 'H1 not compared' : 'H1 not enough history') : h1 === side ? 'H1 agrees' : 'H1 disagrees'}` };

  // 1. big-day chance (30-min, side-free)
  const big = bigDay(instrument, m30, now);

  // 2. direction (constant with interval)
  const d = DIRECTION_ESTIMATE[instrument];
  const up = d?.up ?? 0.5;
  const interval = d ? [d.lo, d.hi] : null;
  const clears = (s, lo) => s >= 0.5 + DIRECTION_MARGIN && lo > 0.5;
  const lean = d && clears(d.up, d.lo) ? 'long' : d && clears(1 - d.up, 1 - d.hi) ? 'short' : null;

  // 3. reasons
  const ba = bidAsk?.get(lastMs);
  const atr = st.at(-1).atr;
  const spreadR = ba && atr > 0 ? (ba.ask - ba.bid) / (STOP_ATR * atr) : null;
  const reasons = noTradeReasons({ instrument, spreadR, closeMs });

  const action = reasons.length || !lean ? 'no_trade' : lean;
  // no_trade share: 1 when a reason fires, else the part of the margin the stronger side has not cleared
  const noTrade = reasons.length ? 1 : Math.max(0, 1 - Math.abs(up - 0.5) / DIRECTION_MARGIN);
  const state = {
    big_day_today: big.text,
    direction: d ? `long ${pct(up)} (${pct(d.lo)}-${pct(d.hi)}), no measurable direction edge` : 'not measured for this instrument, shown as 50/50',
    trend: trend.text,
    spread: spreadR == null ? 'unknown (no bid/ask for this bar)' : `${spreadR.toFixed(2)} of the stop distance (1.5 ATR)`,
    trading_hour: `${String(new Date(closeMs).getUTCHours()).padStart(2, '0')}:00 UTC${THIN_HOURS_UTC[instrument]?.includes(new Date(closeMs).getUTCHours()) ? ', a thin hour' : ''}`,
  };
  if (big.x) {
    const [rv1, , rv22, , , , , , rngNorm] = big.x;
    state.yesterday_volatility = `${word(rv1 - rv22, [-0.3, 0.3], ['calmer than', 'about the same as', 'busier than'])} the last month`;
    state.range_so_far = `${word(rngNorm, [-0.3, 0.3], ['narrower than', 'about the same as', 'wider than'])} usual for this time of day`;
  }
  if (news?.relevant) state.news = `${news.relevant.escalation}: ${news.relevant.title} (not used for direction or reasons)`;

  return {
    instrument, granularity, candleTime: last.time, forming: false, price: last.close, horizonBars: LOCAL_HORIZON_BARS,
    askedAt: new Date(now).toISOString(), model: LOCAL_MODEL, action,
    probabilities: { long: up, short: Number((1 - up).toFixed(4)), no_trade: Number(noTrade.toFixed(4)) },
    confidence: null, quality: null, trendConfirmed: null, latencyMs: 0, state,
    detail: {
      bigDay: big, direction: { up, interval, margin: DIRECTION_MARGIN, lean, note: 'no measurable direction edge', source: d ? '2023+ up share, Wilson 95% on n/12' : 'not measured' },
      reasons, trend, spreadR,
      news: news && { latest: news.latest, relevant: news.relevant ?? null, rule: 'shown and stored only; never sets direction, a reason or a number' },
    },
  };
}
