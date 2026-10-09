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
// 2. P(profit) for a long and a short entered now, per horizon (12 or 48 candles)
//    and target ("up": price better after costs at the end; "plan": the fixed
//    trade plan ends net positive), with the expected R of its P decile
//    (pprofit20, scripts/pprofit.mjs), for the cells whose calibration passed.
//    It mostly reflects spread and hour.
// 3. No-trade reasons: only rules a no-trade study measured as helpful
//    (wide spread, thin trading hour).
// 4. Trend: supertrend side and H1 agreement, a description, not a prediction.
// News is shown and stored for later study, but never sets the side, a
// reason or a number.
import { readFileSync } from 'node:fs';
import { computeSupertrend, granularityMs } from './supertrend.mjs';
import { htfSupertrend } from './indicators.mjs';
import { PP_HORIZONS, PP_TARGETS, ppFeatures, ppModel, ppScore, ppSeries } from './pprofit.mjs';

export const LOCAL_PROVIDER = 'local';
// Also the cache key of prediction_series rows (scripts/predictions.mjs): any change to the stored series
// shape (seriesCore, localSeries output) must bump this version, or old cached rows are served in the old
// shape. A test pins the shape hash to this string.
export const LOCAL_MODEL = 'local-stats-v6 (big day abs11 A1_nostress; P(profit) pprofit20 shield; no direction lean)';
// Default P(profit) cell order: the first shipped cell sets the stored action and probabilities.
export const PP_CELL_ORDER = PP_HORIZONS.flatMap((h) => PP_TARGETS.map((t) => [h, t]));
// Operator-approved headline rule: a side is named only when its expected R is at
// least +0.05 R and its interval lies above 0; otherwise the headline is Neutral.
export const MIN_EXPECTED_R = 0.05;
// 30-min bars the big-day features need: 60 valid sessions for the slot norm plus margin.
export const A1_WINDOW_BARS = 3600;
const A1_STEP_MIN = 30;
const NORM_N = 60;
const NORM_MIN = 20;
const MIN_SESSION_BARS = 8;
const EPS = 1e-4;
export const SPREAD_MAX_R = 0.2; // spread / (1.5 ATR) at the bar
const STOP_ATR = 1.5;
export const NEWS_WINDOW_MS = 6 * 3600000;

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
    out.push({ code: 'spread', text: `Spread wide (${spreadR.toFixed(2)} of the stop distance, limit ${SPREAD_MAX_R})`, short: `spread wide (${spreadR.toFixed(2)} of stop)` });
  }
  const hour = new Date(closeMs).getUTCHours();
  if (THIN_HOURS_UTC[instrument]?.includes(hour)) {
    out.push({ code: 'thin_hour', text: `Thin trading hour (${String(hour).padStart(2, '0')}:00 UTC)`, short: `thin trading hour (${String(hour).padStart(2, '0')}:00 UTC)` });
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

// The shipped cells (horizon x target) of a pair, in PP_CELL_ORDER, each with its artifact.
const shippedCells = (instrument, granularity) => PP_CELL_ORDER.map(([h, t]) => [h, t, ppModel(instrument, granularity, h, t)]).filter(([, , m]) => m);

// One cell's P(profit) per side for the feature row `f`, with its own headline under `reasons`.
function scoreCell([horizon, target, model], f, reasons, instrument, granularity) {
  const side = (s) => { const r = ppScore(model, f, s); return { p: r.p, raw: r.raw, expectedR: r.expectedR, ci: r.ci, decile: r.decile, n: r.n }; };
  const c = { key: `H${horizon}_${target}`, horizon, target, long: side(1), short: side(-1), model: `${model.name}, cutoff ${model.training_cutoff}`, validity: model.validity.statement };
  const h = headline({ available: true, ...c }, reasons);
  return { ...c, headline: h.label, headlineAction: h.action, headlineReason: h.reason, shield: shieldState({ instrument, granularity, cell: c, reasons }) };
}

// P(profit) for both sides at the bid/ask bar of the closed candle `lastMs`, for every
// shipped cell. The features are the same for all cells. The top-level long/short are
// the first cell in PP_CELL_ORDER; `cells` holds all of them.
function pprofit(instrument, granularity, ba, lastMs, reasons) {
  const shipped = shippedCells(instrument, granularity);
  if (!shipped.length) return { available: false, text: 'no calibrated estimate' };
  const i = ba.findIndex((b) => Date.parse(b.time) === lastMs);
  if (i < 0) return { available: false, text: 'no current bid/ask data' };
  const f = ppFeatures(ppSeries(ba.slice(0, i + 1), granularity), i);
  if (!f) return { available: false, text: 'not enough bid/ask history' };
  const cells = shipped.map((c) => scoreCell(c, f, reasons, instrument, granularity));
  return { available: true, ...cells[0], cells };
}

// Spread at a bar as a share of the stop distance (1.5 x the supertrend ATR), as in the no-trade study.
const spreadOf = (bar, atr) => (bar && atr > 0 ? (bar.ask_c - bar.bid_c) / (STOP_ATR * atr) : null);

// Training cutoff of an artifact in ms; the artifacts write it without a zone, in UTC.
export const cutoffMs = (model) => Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(model.training_cutoff) ? model.training_cutoff : `${model.training_cutoff}Z`);

// The local scorer for many closed candles at once, for the chart: per candle the P(profit)
// cells with their headlines, the measured reasons and the spread, exactly as localPredict
// computes them for that candle. Supertrend and the bid/ask features are causal, so one pass
// over the window gives each candle the values it had when it closed (a test checks this).
// `times` are candle start times of closed bars in `candles`. No big day, trend or news here.
export function localSeries({ instrument, granularity, candles, ba = [] }, times) {
  const bars = candles.filter((c) => c.partial !== true && c.complete !== false);
  const st = bars.length ? computeSupertrend(bars, {}) : [];
  const gMs = granularityMs(granularity);
  const shipped = shippedCells(instrument, granularity);
  const S = shipped.length && ba.length ? ppSeries(ba, granularity) : null;
  const baAt = new Map(ba.map((b, i) => [Date.parse(b.time), i]));
  const barAt = new Map(bars.map((b, k) => [Date.parse(b.time), k]));
  return times.map((t) => {
    const ms = Date.parse(t);
    const i = baAt.get(ms);
    const k = barAt.get(ms);
    const spreadR = spreadOf(i == null ? null : ba[i], k == null ? null : st[k]?.atr);
    const reasons = noTradeReasons({ instrument, spreadR, closeMs: ms + gMs });
    let pp;
    if (!shipped.length) pp = { available: false, text: 'no calibrated estimate' };
    else if (i == null) pp = { available: false, text: 'no bid/ask data for this candle' };
    else {
      const f = ppFeatures(S, i);
      pp = f ? { available: true, cells: shipped.map((c) => scoreCell(c, f, reasons, instrument, granularity)) } : { available: false, text: 'not enough bid/ask history' };
    }
    return { candleTime: t, spreadR, reasons, pprofit: pp, now: k == null ? null : nowMotion(bars, k, st[k]?.atr), hasBidAsk: i != null };
  });
}

// Instruments whose long-minus-short P difference is meaningful. pprofit20 (M5, 2023+) regressed
// the observed long-minus-short outcome on the predicted P(long) - P(short); the 95% interval of the
// slope contains 1 only for EUR/USD (0.91) and SPX500 (0.63). WTI is 0.04, NATGAS -0.08, XAU 0.40 and
// XAG 0.36. Elsewhere each side's P is calibrated on its own, but their difference carries no
// reliable information, so the shield shows one shared state there.
export const SIDE_DIFF_CALIBRATED = new Set(['EUR/USD', 'SPX500/USD']);

// The card's state: a shield against clearly wrong moments, not trading advice. Operator rule,
// per closed candle and cell, from a P decile:
//   red "Don't trade now": a measured no-trade reason fires (both sides), or the decile is 1
//   orange "Costly now": decile 2-3
//   grey "No warning": otherwise (deciles 4-10)
// There is no green state: pprofit20 has no decile with avg R above 0, so a "good" state cannot be earned.
// EUR/USD and SPX500 (SIDE_DIFF_CALIBRATED): one state per side from that side's decile.
// Every other instrument: one shared state (`both`) from floor(mean of the two side deciles), with
// avgR the mean of the two decile avg R; `long`/`short` are still stored for the record.
// Without a calibrated estimate: red when a reason fires, else grey "No warning · no calibrated estimate".
// avgR is the decile's mean net R (null for an empty decile). `cell` needs long/short {decile, expectedR}.
// Returns { reason: {code, why} | null, shared, long, short, both? }; a state is
// { state, label, why, conditions, code, decile, avgR }: `why` goes in the headline (red and orange only),
// `conditions` (the decile band) and avgR go in Details.
export const SHIELD_LABEL = { red: "Don't trade now", orange: 'Costly now', grey: 'No warning' };
const SHORT_NAME = { 'WTICO/USD': 'WTI', 'BCO/USD': 'Brent' };
export function shieldState({ instrument, granularity, cell = null, reasons = [] }) {
  const reason = reasons[0] ? { code: reasons[0].code, why: reasons[0].short ?? reasons[0].text.replace(/^./, (c) => c.toLowerCase()) } : null;
  const where = `${SHORT_NAME[instrument] ?? instrument} ${granularity}`;
  const band = (d) => (d <= 3 ? `bottom ${d * 10}% of conditions for ${where}` : d <= 8 ? `usual conditions for ${where}` : `top ${(11 - d) * 10}% of conditions for ${where}`);
  const sideState = (s) => {
    const decile = s?.decile ?? null;
    const base = { decile, avgR: s?.expectedR ?? null, conditions: s ? band(decile) : null };
    if (reason) return { ...base, state: 'red', label: SHIELD_LABEL.red, why: reason.why, code: reason.code };
    if (!s) return { ...base, state: 'grey', label: `${SHIELD_LABEL.grey} · no calibrated estimate`, why: null, code: 'no_estimate' };
    if (decile <= 1) return { ...base, state: 'red', label: SHIELD_LABEL.red, why: band(decile), code: 'decile_1' };
    if (decile <= 3) return { ...base, state: 'orange', label: SHIELD_LABEL.orange, why: band(decile), code: `decile_${decile}` };
    return { ...base, state: 'grey', label: SHIELD_LABEL.grey, why: null, code: `decile_${decile}` };
  };
  const out = { reason, shared: !SIDE_DIFF_CALIBRATED.has(instrument), long: sideState(cell?.long), short: sideState(cell?.short) };
  if (out.shared) {
    const rs = [cell?.long?.expectedR, cell?.short?.expectedR];
    const mean = cell && { decile: Math.floor((cell.long.decile + cell.short.decile) / 2), expectedR: rs.includes(null) || rs.includes(undefined) ? null : (rs[0] + rs[1]) / 2 };
    out.both = sideState(mean);
  }
  return out;
}
export const shieldText = (st) => [st.label, st.why].filter(Boolean).join(' · ');
const avgRText = (r) => (r == null ? 'avg R n/a' : `avg ${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)} R`);
// Details: "decile 9 of 10, top 20% of conditions for WTI M5 · avg −0.14 R"
export const conditionsText = (st) => `${st.decile == null ? 'no calibrated estimate' : `decile ${st.decile} of 10, ${st.conditions}`} · ${avgRText(st.avgR)}`;

// "Now": a description of the closed bars, not a forecast. N = the current run of closed bars
// moving the same way as the last one (close vs open), capped at NOW_MAX_BARS (at least 1).
// move = (last close - first open of the run) / ATR (the supertrend ATR of the last bar);
// fast at |move| >= 1.5 ATR, steady at >= 0.5, else flat (no direction word then).
// volume = tick volume of the last bar / the median at the same UTC time-of-day slot over the prior
// 20 days in the window (at least 10 such bars), else the median of the prior 288 bars (at least 20);
// omitted when neither is available. continuationRate is a hook for a later historical rate.
export const NOW_MAX_BARS = 6;
export function volumeRatio(bars, k) {
  const v = bars[k]?.volume;
  if (!(v > 0)) return null;
  const slot = Date.parse(bars[k].time) % 86400000;
  const same = bars.slice(0, k).filter((b) => b.volume > 0 && Date.parse(b.time) % 86400000 === slot).slice(-20);
  if (same.length >= 10) return { ratio: v / median(same.map((b) => b.volume)), base: 'time-of-day slot, 20 days' };
  const recent = bars.slice(Math.max(0, k - 288), k).filter((b) => b.volume > 0);
  return recent.length >= 20 ? { ratio: v / median(recent.map((b) => b.volume)), base: `prior ${recent.length} bars` } : null;
}
export function nowMotion(bars, k, atr) {
  const b = bars[k];
  if (!b || !(atr > 0)) return null;
  const dir = Math.sign(b.close - b.open);
  let n = 1;
  if (dir !== 0) while (n < NOW_MAX_BARS && k - n >= 0 && Math.sign(bars[k - n].close - bars[k - n].open) === dir) n++;
  const moveAtr = (b.close - bars[k - n + 1].open) / atr;
  const size = Math.abs(moveAtr);
  const pace = size >= 1.5 ? 'fast' : size >= 0.5 ? 'steady' : 'flat';
  const direction = pace === 'flat' ? null : moveAtr > 0 ? 'rising' : 'falling';
  const vol = volumeRatio(bars, k);
  const parts = [direction ? `${direction} ${pace}` : 'flat', `${moveAtr >= 0 ? '+' : '−'}${size.toFixed(1)} ATR in ${n} bar${n > 1 ? 's' : ''}`, vol && `volume ${vol.ratio.toFixed(1)}× normal`];
  return { bars: n, moveAtr, pace, direction, volumeRatio: vol?.ratio ?? null, volumeBase: vol?.base ?? null, continuationRate: null, text: `Now: ${parts.filter(Boolean).join(' · ')}` };
}

// The operator-approved headline rule (strict): a side only when its expected R is at least
// +0.05 R and its interval lies above 0, and no measured reason fires. The artifacts carry
// no interval for the lookup, so no side can clear until one is added.
export function headline(pp, reasons) {
  const clears = (s) => s && s.expectedR != null && s.expectedR >= MIN_EXPECTED_R && Array.isArray(s.ci) && s.ci[0] > 0;
  const sides = pp.available ? [['long', pp.long], ['short', pp.short]].filter(([, s]) => clears(s)).sort((a, b) => b[1].expectedR - a[1].expectedR) : [];
  if (reasons.length) return { label: 'Neutral', action: 'no_trade', reason: reasons[0].text };
  if (!sides.length) return { label: 'Neutral', action: 'no_trade', reason: pp.available ? 'no side clears costs' : pp.text };
  return { label: sides[0][0] === 'long' ? 'Long' : 'Short', action: sides[0][0], reason: null };
}

const pctP = (p) => (p < 0.005 ? '<1%' : pct(p)); // a calibrated P can be exactly 0
const avgR = (s) => `${pctP(s.p)} chance of profit (${s.expectedR == null ? 'avg R: n/a' : `avg ${s.expectedR >= 0 ? '+' : ''}${s.expectedR.toFixed(2)} R`})`;

// One local run for the newest CLOSED candle of the viewed timeframe.
// `candles` are the viewed timeframe (a forming bar is dropped), `m30` the 30-min
// window for the big-day model, `ba` closed bid/ask bars of the viewed timeframe
// (P(profit) and the spread reason), `news` newsInput.
export function localPredict({ instrument, granularity, candles, m30 = [], ba = [], news = null }, { now = Date.now() } = {}) {
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

  // 3. reasons (spread at the closed bar against the supertrend ATR, as in the no-trade study)
  const spreadR = spreadOf(ba.find((b) => Date.parse(b.time) === lastMs), st.at(-1).atr);
  const now_ = nowMotion(bars, bars.length - 1, st.at(-1).atr);
  const reasons = noTradeReasons({ instrument, spreadR, closeMs });

  // 2. P(profit) per side and cell (bid/ask bars of the viewed timeframe); each cell has its own headline
  const pp = pprofit(instrument, granularity, ba, lastMs, reasons);

  const head = headline(pp, reasons);
  const shield = pp.available ? pp.cells[0].shield : shieldState({ instrument, granularity, reasons });
  const action = head.action;
  const state = {
    big_day_today: big.text,
    long_now: pp.available ? avgR(pp.long) : pp.text,
    short_now: pp.available ? avgR(pp.short) : pp.text,
    ...(shield.shared
      ? { state_both_sides: shieldText(shield.both), conditions_both_sides: conditionsText(shield.both) }
      : { long_state: shieldText(shield.long), short_state: shieldText(shield.short), long_conditions: conditionsText(shield.long), short_conditions: conditionsText(shield.short) }),
    ...(now_ ? { now: now_.text.replace(/^Now: /, '') } : {}),
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
    instrument, granularity, candleTime: last.time, forming: false, price: last.close, horizonBars: pp.available ? pp.horizon : PP_HORIZONS[0],
    askedAt: new Date(now).toISOString(), model: LOCAL_MODEL, action,
    // long/short: P(profit) of each side (null without an artifact); no_trade: 1 for a Neutral headline
    probabilities: { long: pp.available ? pp.long.p : null, short: pp.available ? pp.short.p : null, no_trade: action === 'no_trade' ? 1 : 0 },
    confidence: null, quality: null, trendConfirmed: null, latencyMs: 0, state,
    detail: {
      // shield: per-side state of the default cell (each cell carries its own in pprofit.cells); headline: the strict trade rule
      shield, bigDay: big, pprofit: pp, headline: head.label, headlineReason: head.reason, minExpectedR: MIN_EXPECTED_R,
      reasons, trend, spreadR, now: now_,
      news: news && { latest: news.latest, relevant: news.relevant ?? null, rule: 'shown and stored only; never sets direction, a reason or a number' },
    },
  };
}
