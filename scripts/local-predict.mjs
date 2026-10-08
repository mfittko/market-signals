// Prediction provider: local statistics. Free, no key, no network beyond the
// candle feed. Recomputed for each closed candle; storage lives in predictions.mjs.
//
// Four parts, each kept honest about what it is:
// 1. Move size (side-free): P(price reaches +/- kx ATR within the next 72 M5
//    bars), from the research logistic model in config/prediction-models
//    (lr_todvol, alert7 "_ns" artifacts). Features are a port of the research
//    pipeline (bench1 eng_bars on de_v2 M5 bars); test/fixtures holds a
//    bars -> features -> probability parity export.
// 2. Direction: a constant with an interval. Research found no direction edge
//    (direction AUC <= 0.53 on every instrument), so the estimate is the
//    measured 2023+ up share of the eventual 6h direction. There is no model.
// 3. No-trade reasons: only rules a no-trade study measured as helpful
//    (wide spread, thin trading hour), plus one untested news caution.
// 4. Trend: supertrend side and H1 agreement, a description, not a prediction.
// News never sets or changes the direction or the move-size number.
import { readFileSync } from 'node:fs';
import { computeSupertrend, granularityMs } from './supertrend.mjs';
import { htfSupertrend } from './indicators.mjs';

export const LOCAL_PROVIDER = 'local';
export const LOCAL_MODEL = 'local-stats-v0 (vol lr_todvol alert7_ns; direction constant)';
// The move-size label and the direction estimate both look 72 M5 bars ahead.
export const LOCAL_HORIZON_BARS = 72;
// Bars the move-size features need: 2880 for the ATR median plus a warm ATR.
export const VOL_WINDOW_BARS = 3300;
const ATR_MEDIAN_BARS = 2880;
const ATR_MEDIAN_MIN = 576;
// A side clears the margin only when its share is at least 0.5 + MARGIN and its
// interval lies wholly above one half. Declared before any live run.
export const DIRECTION_MARGIN = 0.05;
export const SPREAD_MAX_R = 0.2; // spread / (1.5 ATR) at the bar
const STOP_ATR = 1.5;
export const NEWS_WINDOW_MS = 6 * 3600000;
export const NEWS_FRESH_MS = 30 * 60000;

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
export function volModel(instrument) {
  if (!models.has(instrument)) {
    let m = null;
    try {
      m = JSON.parse(readFileSync(new URL(`../config/prediction-models/artifact_${instrument.replace('/', '_')}_ns.json`, import.meta.url), 'utf8'));
    } catch { /* no artifact for this instrument */ }
    models.set(instrument, m);
  }
  return models.get(instrument);
}

const std = (a, from, to) => { // sample std (ddof 1) of a[from..to]
  const n = to - from + 1;
  let s = 0;
  for (let k = from; k <= to; k++) s += a[k];
  const mean = s / n;
  let q = 0;
  for (let k = from; k <= to; k++) q += (a[k] - mean) ** 2;
  return Math.sqrt(q / (n - 1));
};
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// The 12 lr_todvol features for the newest bar of `bars` (closed mid M5 bars,
// oldest first, with time, high, low, close). Null while the window is too short.
// Times: minutes since the epoch of the bar open; the session day rolls at 22:00 UTC.
export function volFeatures(bars) {
  const n = bars.length;
  if (n < 290) return null;
  const st = computeSupertrend(bars, { period: 10, multiplier: 3 });
  const atr = st.map((s) => (s ? s.atr : NaN));
  const i = n - 1;
  const a = atr[i];
  const c = bars.map((b) => b.close);
  const tmin = Math.round(Date.parse(bars[i].time) / 60000);
  const tod = (((tmin + 120) % 1440) + 1440) % 1440;
  const day = Math.floor((tmin + 120) / 1440);
  let nday = 0;
  for (let k = i - 1; k >= 0 && Math.floor((Math.round(Date.parse(bars[k].time) / 60000) + 120) / 1440) === day; k--) nday++;
  const lr = c.map((v, k) => (k ? v - c[k - 1] : NaN));
  const rv = (w) => std(lr, i - w + 1, i);
  const e = 0.01 * a;
  const rv288 = rv(288);
  const win = atr.slice(Math.max(0, i - ATR_MEDIAN_BARS + 1), i + 1).filter(Number.isFinite);
  if (win.length < ATR_MEDIAN_MIN || !Number.isFinite(a)) return null;
  const rng = (k) => (bars[k].high - bars[k].low) / atr[k];
  const ang = (2 * Math.PI * (tod + 5)) / 1440;
  const wd = (2 * Math.PI * (((day + 3) % 7 + 7) % 7)) / 7;
  const x = [
    Math.sin(ang), Math.cos(ang), Math.sin(wd), Math.cos(wd), Math.log1p(nday),
    Math.log((rv(12) + e) / (rv288 + e)), Math.log((rv(48) + e) / (rv288 + e)), Math.log((rv288 + e) / a),
    Math.log(a) - Math.log(Math.max(Math.abs(c[i]), 1)), a / median(win),
    rng(i), (rng(i) + rng(i - 1) + rng(i - 2)) / 3,
  ];
  return x.every(Number.isFinite) ? { x, atr: a, nday } : null;
}

// z and p of the artifact's formula: z = b + sum coef (x - mean) / scale.
export function volScore(model, x) {
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

// Newest headline for the instrument from the engine news cache within 6 hours,
// and whether an escalated one became available in the last 30 minutes.
// Available-at is the later of the publish time and the time the engine stored it.
export function newsInput(db, instrument, now) {
  let rows;
  try {
    rows = db.prepare(`SELECT rowid AS id, title, time, fetched_at, escalation FROM news
      WHERE instrument = ? AND time IS NOT NULL AND time >= ? AND time <= ? ORDER BY time DESC LIMIT 50`)
      .all(instrument, new Date(now - NEWS_WINDOW_MS).toISOString(), new Date(now).toISOString());
  } catch { return null; } // no news table yet
  if (!rows.length) return null;
  const avail = (r) => Math.max(Date.parse(r.time), Date.parse(r.fetched_at) || 0);
  const pick = (r) => r && { id: r.id, title: r.title, escalation: r.escalation === 1 ? 'escalation' : 'routine', publishedAt: r.time, availableAt: new Date(avail(r)).toISOString() };
  const fresh = rows.find((r) => r.escalation === 1 && avail(r) <= now && now - avail(r) <= NEWS_FRESH_MS);
  return { latest: pick(rows[0]), freshEscalation: pick(fresh) };
}

// The evidenced no-trade reasons at the bar that just closed. `closeMs` is that bar's close time.
export function noTradeReasons({ instrument, spreadR, closeMs, news }) {
  const out = [];
  if (spreadR != null && spreadR > SPREAD_MAX_R) {
    out.push({ code: 'spread', text: `No trade now: the spread is wide (${spreadR.toFixed(2)} of the stop distance, limit ${SPREAD_MAX_R}).` });
  }
  const hour = new Date(closeMs).getUTCHours();
  if (THIN_HOURS_UTC[instrument]?.includes(hour)) {
    out.push({ code: 'thin_hour', text: `No trade now: thin trading hour (${String(hour).padStart(2, '0')}:00 UTC), spreads are usually wide relative to movement.` });
  }
  if (news?.freshEscalation) {
    out.push({ code: 'news_untested', untested: true, text: 'No trade now: fresh high-escalation news (untested rule).' });
  }
  return out;
}

const pct = (v) => `${Math.round(v * 100)}%`;
const word = (v, edges, labels) => { for (let k = 0; k < edges.length; k++) if (v < edges[k]) return labels[k]; return labels.at(-1); };

// One local run for the newest CLOSED candle of the viewed timeframe.
// `candles` are the viewed timeframe (a forming bar is dropped), `m5` the M5
// window for the move-size model, `bidAsk` the fetchBidAsk map, `news` newsInput.
export function localPredict({ instrument, granularity, candles, m5 = [], bidAsk = null, news = null }, { now = Date.now() } = {}) {
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

  // 1. move size (M5, side-free)
  const model = volModel(instrument);
  let move = { available: false, text: 'not available for this instrument' };
  const m5bars = m5.filter((c) => c.partial !== true && c.complete !== false);
  const m5last = m5bars.at(-1);
  let feat = null;
  if (model && m5last && Date.parse(m5last.time) > now - 4 * 300000) {
    feat = volFeatures(m5bars.slice(-VOL_WINDOW_BARS));
    if (feat) {
      const { z, p } = volScore(model, feat.x);
      move = {
        available: true, p, z, base: model.training_base_rate, kxAtr: model.target.kx_atr, horizonBars: model.target.horizon_bars,
        barTime: m5last.time, model: `${model.model}, cutoff ${model.training_cutoff}`,
        text: `${pct(p)} chance of a ${model.target.kx_atr} ATR move within 6h (usual ${pct(model.training_base_rate)})`,
      };
    } else move.text = 'not enough M5 history';
  } else if (model) move.text = 'no current M5 data';

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
  const reasons = noTradeReasons({ instrument, spreadR, closeMs, news });

  const action = reasons.length || !lean ? 'no_trade' : lean;
  // no_trade share: 1 when a reason fires, else the part of the margin the stronger side has not cleared
  const noTrade = reasons.length ? 1 : Math.max(0, 1 - Math.abs(up - 0.5) / DIRECTION_MARGIN);
  const state = {
    move_size_next_6h: move.text,
    direction: d ? `long ${pct(up)} (${pct(d.lo)}-${pct(d.hi)}), no measurable direction edge` : 'not measured for this instrument, shown as 50/50',
    trend: trend.text,
    spread: spreadR == null ? 'unknown (no bid/ask for this bar)' : `${spreadR.toFixed(2)} of the stop distance (1.5 ATR)`,
    trading_hour: `${String(new Date(closeMs).getUTCHours()).padStart(2, '0')}:00 UTC${THIN_HOURS_UTC[instrument]?.includes(new Date(closeMs).getUTCHours()) ? ', a thin hour' : ''}`,
  };
  if (feat) {
    const [, , , , , rv12, , rv288, , atrRatio, range] = feat.x;
    state.recent_volatility = `${word(rv12, [-0.3, 0.3], ['calmer', 'about the same', 'busier'])} in the last hour than over the day`;
    state.day_volatility = `${word(rv288, [-1.6, -1.2], ['quiet', 'normal', 'active'])} relative to ATR`;
    state.atr_vs_10_days = `${atrRatio.toFixed(2)}x the 10-day median`;
    state.last_m5_bar = `${range.toFixed(1)} ATR high-to-low`;
    state.session_bar = `bar ${feat.nday + 1} of the session (22:00 UTC roll)`;
  }
  if (news?.latest) state.news = `${news.latest.escalation}: ${news.latest.title} (not used for direction)`;

  return {
    instrument, granularity, candleTime: last.time, forming: false, price: last.close, horizonBars: LOCAL_HORIZON_BARS,
    askedAt: new Date(now).toISOString(), model: LOCAL_MODEL, action,
    probabilities: { long: up, short: Number((1 - up).toFixed(4)), no_trade: Number(noTrade.toFixed(4)) },
    confidence: null, quality: null, trendConfirmed: null, latencyMs: 0, state,
    detail: {
      move, direction: { up, interval, margin: DIRECTION_MARGIN, lean, note: 'no measurable direction edge', source: d ? '2023+ up share, Wilson 95% on n/12' : 'not measured' },
      reasons, trend, spreadR,
      news: news && { latest: news.latest, freshEscalation: news.freshEscalation, rule: 'untested; news never sets direction' },
      features: feat && { x: feat.x, atr: feat.atr },
    },
  };
}
