// Prediction provider: local statistics. Free, no key, no network beyond the
// candle feed. Recomputed for each closed candle; storage lives in predictions.mjs.
//
// Parts, each kept honest about what it is:
// 1. No-trade reasons: only rules a no-trade study measured as helpful
//    (wide spread, thin trading hour). They set the cost shield: red "Don't trade now"
//    with the reason, else grey "No warning".
// 2. Now: a description of the closed bars (run, size in ATR, volume), not a forecast.
// 3. Trend: supertrend side and H1 agreement, a description, not a prediction.
// News is shown and stored for later study, but never sets the side, a
// reason or a number.
import { computeSupertrend, granularityMs } from './supertrend.mjs';
import { htfSupertrend } from './indicators.mjs';

export const LOCAL_PROVIDER = 'local';
// Also the cache key of prediction_series rows (scripts/predictions.mjs): any change to the stored series
// shape (seriesCore, localSeries output) must bump this version, or old cached rows are served in the old
// shape. A test pins the shape hash to this string.
export const LOCAL_MODEL = 'local-stats-v8 (cost shield from no-trade reasons; Now line; trend)';
export const SPREAD_MAX_R = 0.2; // spread / (1.5 ATR) at the bar
const STOP_ATR = 1.5;
export const NEWS_WINDOW_MS = 6 * 3600000;

// UTC hours whose median M5 spread/ATR was highest in 2018-2022 (no-trade study, 4 hours each).
export const THIN_HOURS_UTC = {
  'WTICO/USD': [4, 5, 22, 23], 'XAU/USD': [4, 21, 22, 23], 'XAG/USD': [0, 21, 22, 23],
  'NATGAS/USD': [3, 4, 22, 23], 'SPX500/USD': [3, 4, 5, 6], 'EUR/USD': [4, 21, 22, 23],
};

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
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

// Spread at a bar as a share of the stop distance (1.5 x the supertrend ATR), as in the no-trade study.
const spreadOf = (bar, atr) => (bar && atr > 0 ? (bar.ask_c - bar.bid_c) / (STOP_ATR * atr) : null);

// The local scorer for many closed candles at once, for the chart: per candle the measured reasons,
// the spread and the Now line, exactly as localPredict computes them for that candle. Supertrend is
// causal, so one pass over the window gives each candle the values it had when it closed (a test
// checks this). `times` are candle start times of closed bars in `candles`. No trend or news here.
export function localSeries({ instrument, granularity, candles, ba = [] }, times) {
  const bars = candles.filter((c) => c.partial !== true && c.complete !== false);
  const st = bars.length ? computeSupertrend(bars, {}) : [];
  const gMs = granularityMs(granularity);
  const baAt = new Map(ba.map((b, i) => [Date.parse(b.time), i]));
  const barAt = new Map(bars.map((b, k) => [Date.parse(b.time), k]));
  return times.map((t) => {
    const ms = Date.parse(t);
    const i = baAt.get(ms);
    const k = barAt.get(ms);
    const spreadR = spreadOf(i == null ? null : ba[i], k == null ? null : st[k]?.atr);
    const reasons = noTradeReasons({ instrument, spreadR, closeMs: ms + gMs });
    return { candleTime: t, spreadR, reasons, now: k == null ? null : nowMotion(bars, k, st[k]?.atr), hasBidAsk: i != null };
  });
}

// The card's state: a shield against clearly wrong moments, not trading advice. Red "Don't trade now"
// with the first measured no-trade reason (spread above SPREAD_MAX_R of the stop distance, thin hour),
// otherwise grey "No warning". One state for both sides.
export const SHIELD_LABEL = { red: "Don't trade now", grey: 'No warning' };
export function shieldState({ reasons = [] }) {
  const r = reasons[0];
  if (!r) return { state: 'grey', label: SHIELD_LABEL.grey, why: null, reason: null };
  const why = r.short ?? r.text.replace(/^./, (c) => c.toLowerCase());
  return { state: 'red', label: SHIELD_LABEL.red, why, reason: { code: r.code, why } };
}
export const shieldText = (st) => [st.label, st.why].filter(Boolean).join(' · ');

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

// One local run for the newest CLOSED candle of the viewed timeframe.
// `candles` are the viewed timeframe (a forming bar is dropped), `ba` closed bid/ask
// bars of the viewed timeframe (the spread reason), `news` newsInput.
export function localPredict({ instrument, granularity, candles, ba = [], news = null }, { now = Date.now() } = {}) {
  const bars = candles.filter((c) => c.partial !== true && c.complete !== false).map(({ partial, complete, ...c }) => c);
  if (bars.length < 12) throw new Error('not enough candle history for a prediction');
  const gMs = granularityMs(granularity);
  const last = bars.at(-1);
  const lastMs = Date.parse(last.time);
  const closeMs = lastMs + gMs;

  // 3. trend context (viewed timeframe, H1 agreement)
  const st = computeSupertrend(bars, {});
  const side = st.at(-1).trend;
  const h1 = gMs < 3600000 ? htfSupertrend(candles, granularity, 'H1')?.trend ?? null : null;
  const trend = { side, h1, text: `supertrend ${side === 'up' ? 'up' : 'down'}, ${h1 == null ? (gMs >= 3600000 ? 'H1 not compared' : 'H1 not enough history') : h1 === side ? 'H1 agrees' : 'H1 disagrees'}` };

  // 1. reasons (spread at the closed bar against the supertrend ATR, as in the no-trade study)
  const spreadR = spreadOf(ba.find((b) => Date.parse(b.time) === lastMs), st.at(-1).atr);
  const now_ = nowMotion(bars, bars.length - 1, st.at(-1).atr);
  const reasons = noTradeReasons({ instrument, spreadR, closeMs });

  const shield = shieldState({ reasons });
  const state = {
    shield: shieldText(shield),
    ...(now_ ? { now: now_.text.replace(/^Now: /, '') } : {}),
    trend: trend.text,
    spread: spreadR == null ? 'unknown (no bid/ask for this bar)' : `${spreadR.toFixed(2)} of the stop distance (1.5 ATR)`,
    trading_hour: `${String(new Date(closeMs).getUTCHours()).padStart(2, '0')}:00 UTC${THIN_HOURS_UTC[instrument]?.includes(new Date(closeMs).getUTCHours()) ? ', a thin hour' : ''}`,
  };
  if (news?.relevant) state.news = `${news.relevant.escalation}: ${news.relevant.title} (not used for direction or reasons)`;

  return {
    instrument, granularity, candleTime: last.time, forming: false, price: last.close, horizonBars: 1,
    // the local provider names no side: the run describes costs and the closed bars only
    askedAt: new Date(now).toISOString(), model: LOCAL_MODEL, action: 'no_trade',
    probabilities: { long: null, short: null, no_trade: null },
    confidence: null, quality: null, trendConfirmed: null, latencyMs: 0, state,
    detail: {
      shield,
      reasons, trend, spreadR, now: now_,
      news: news && { latest: news.latest, relevant: news.relevant ?? null, rule: 'shown and stored only; never sets direction, a reason or a number' },
    },
  };
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
