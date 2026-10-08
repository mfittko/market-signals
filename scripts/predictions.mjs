// Live predictions for the current candle: the on/off rule, one run through
// the provider, and storage of every run so the console can restore it.
// Advisory only: nothing here is read by the bot, the filter or the notifier.
import { granularityMs, isGranularity, withDb } from './supertrend.mjs';
import { GRAN_WORDS, jevPredict, JEV_PROVIDER } from './jev.mjs';
import { cutoffMs, LOCAL_MODEL, localPredict, localSeries, LOCAL_PROVIDER, newsInput } from './local-predict.mjs';
import { baWindow, ppAvailable, ppModel, PP_WINDOW_BARS } from './pprofit.mjs';

const DDL = `CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument TEXT NOT NULL,
  granularity TEXT NOT NULL,
  candle_time TEXT NOT NULL,
  forming INTEGER NOT NULL,
  price REAL,
  horizon_bars INTEGER NOT NULL,
  asked_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  action TEXT NOT NULL,
  probabilities TEXT NOT NULL,
  confidence REAL,
  quality REAL,
  trend_confirmed REAL,
  latency_ms INTEGER,
  state TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS predictions_pair ON predictions (instrument, granularity, id);
CREATE TABLE IF NOT EXISTS prediction_series (
  instrument TEXT NOT NULL,
  granularity TEXT NOT NULL,
  candle_ms INTEGER NOT NULL,
  model TEXT NOT NULL,
  entry TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (instrument, granularity, candle_ms, model)
)`;

// Creates the table, and adds the provider-specific `detail` column to a table made before it existed.
function ensureTable(db) {
  db.exec(DDL);
  if (!db.prepare('PRAGMA table_info(predictions)').all().some((c) => c.name === 'detail')) db.exec('ALTER TABLE predictions ADD COLUMN detail TEXT');
}

export const PREDICTIONS_MAX_LIMIT = 100;
export const PREDICTION_PROVIDERS = [LOCAL_PROVIDER, JEV_PROVIDER];

// The provider for new runs: local unless TypeSafe Jev is chosen explicitly.
export const predictionProvider = (settings = {}) => (settings.predictionProvider === JEV_PROVIDER ? JEV_PROVIDER : LOCAL_PROVIDER);

// The single on/off rule: the explicit opt-in toggle, plus a non-blank key when the provider is Jev.
export function predictionActive(settings = {}) {
  if (!['1', true].includes(settings.predictionEnabled)) return false;
  return predictionProvider(settings) === LOCAL_PROVIDER || Boolean(String(settings.TYPESAFE_API_KEY ?? '').trim());
}

// Only the timeframes the provider prompt names; M0 or M7 would give a zero or odd candle duration.
export const isPredictionGranularity = (g) => isGranularity(g) && Object.hasOwn(GRAN_WORDS, g);

// A Jev run is valid for one candle duration of its timeframe from the moment it was made.
// A local run describes a closed candle, so it is valid until the next candle closes.
const toRow = (r, now = Date.now()) => {
  const g = granularityMs(r.granularity);
  const expires = r.provider === LOCAL_PROVIDER ? Date.parse(r.candle_time) + 2 * g : Date.parse(r.asked_at) + g;
  return {
    id: r.id, instrument: r.instrument, granularity: r.granularity, candleTime: r.candle_time, forming: r.forming === 1,
    price: r.price, horizonBars: r.horizon_bars, askedAt: r.asked_at, expiresAt: new Date(expires).toISOString(), valid: now < expires,
    provider: r.provider, model: r.model, action: r.action, probabilities: JSON.parse(r.probabilities), confidence: r.confidence,
    quality: r.quality, trendConfirmed: r.trend_confirmed, latencyMs: r.latency_ms, state: JSON.parse(r.state),
    detail: r.detail ? JSON.parse(r.detail) : null,
  };
};

// The prediction for the pair right now. With `reuse`, the latest stored run of
// the selected provider is returned while it is still valid (no provider call);
// otherwise `loadCandles` supplies the current window and a new run is made and
// stored. The local provider also reads `loadM30` (the 30-min window for the big-day model).
// Concurrent reuse callers for one pair share a single in-flight run, so they make one paid call.
const inflight = new Map();

export async function currentPrediction(dbPath, settings, input, { reuse = false, now = Date.now(), ...opts } = {}) {
  const { instrument, granularity } = input;
  if (!reuse) return freshPrediction(dbPath, settings, input, now, opts);
  const latest = listPredictions(dbPath, instrument, granularity, 1, now)[0];
  if (latest?.valid && latest.provider === predictionProvider(settings)) return { ...latest, reused: true };
  const key = `${dbPath}|${instrument}|${granularity}`;
  let run = inflight.get(key);
  if (!run) {
    run = freshPrediction(dbPath, settings, input, now, opts).finally(() => inflight.delete(key));
    inflight.set(key, run);
  }
  return run;
}

async function freshPrediction(dbPath, settings, { instrument, granularity, loadCandles, loadM30 }, now, opts) {
  const candles = await loadCandles();
  if (!candles.length) throw Object.assign(new Error(`no candles for ${instrument} ${granularity}`), { status: 404 });
  // The chart serves stored candles when the live fetch fails. A window whose newest bar started more
  // than two candle durations ago is not the current candle, so it is refused rather than predicted on.
  const newest = candles[candles.length - 1].time;
  if (!(Date.parse(newest) > now - 2 * granularityMs(granularity))) {
    throw Object.assign(new Error(`no current data for ${instrument} ${granularity}: the newest candle is from ${newest}, so no prediction was made`), { status: 503 });
  }
  const input = { instrument, granularity, candles };
  if (predictionProvider(settings) === LOCAL_PROVIDER) {
    input.m30 = loadM30 ? await loadM30() : (granularity === 'M30' ? candles : []);
    // bid/ask bars of the viewed timeframe: a long window where a P(profit) artifact exists, else the spread only
    input.ba = await baWindow(instrument, granularity, ppAvailable(instrument, granularity) ? PP_WINDOW_BARS : 3, { fetchFn: opts.fetchFn }).catch(() => []);
  }
  return { reused: false, ...(await runPrediction(dbPath, settings, input, { now, ...opts })) };
}

// Runs one prediction with the selected provider and stores it. A provider failure throws and stores nothing.
// A local run for a candle that already has a stored local run returns that run instead of a duplicate.
export async function runPrediction(dbPath, settings, input, opts = {}) {
  const provider = predictionProvider(settings);
  const now = opts.now ?? Date.now();
  const p = provider === LOCAL_PROVIDER
    ? localPredict({ ...input, news: withDb(dbPath, (db) => newsInput(db, input.instrument, now)) }, { now })
    : await jevPredict(settings, input, opts);
  return withDb(dbPath, (db) => {
    ensureTable(db);
    if (provider === LOCAL_PROVIDER) {
      const same = db.prepare('SELECT * FROM predictions WHERE instrument = ? AND granularity = ? AND provider = ? AND candle_time = ? ORDER BY id DESC LIMIT 1')
        .get(p.instrument, p.granularity, provider, p.candleTime);
      if (same) return { ...toRow(same, now), reused: true };
    }
    const { lastInsertRowid } = db.prepare(`INSERT INTO predictions (instrument, granularity, candle_time, forming, price, horizon_bars,
      asked_at, provider, model, action, probabilities, confidence, quality, trend_confirmed, latency_ms, state, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      p.instrument, p.granularity, p.candleTime, p.forming ? 1 : 0, p.price, p.horizonBars, p.askedAt, provider, p.model,
      p.action, JSON.stringify(p.probabilities), p.confidence, p.quality, p.trendConfirmed, p.latencyMs, JSON.stringify(p.state),
      p.detail ? JSON.stringify(p.detail) : null);
    return toRow(db.prepare('SELECT * FROM predictions WHERE id = ?').get(lastInsertRowid), now);
  });
}

// Stored runs for one instrument and timeframe, newest first. `directional` keeps only long and short runs.
export function listPredictions(dbPath, instrument, granularity, limit = 20, now = Date.now(), { directional = false } = {}) {
  return withDb(dbPath, (db) => {
    ensureTable(db);
    return db.prepare(`SELECT * FROM predictions WHERE instrument = ? AND granularity = ?${directional ? " AND action != 'no_trade'" : ''} ORDER BY id DESC LIMIT ?`)
      .all(instrument, granularity, Math.min(Math.max(1, limit), PREDICTIONS_MAX_LIMIT)).map((r) => toRow(r, now));
  });
}

// Compact, model-facing view of a run for the advisory tools.
export function predictionForTool(p) {
  if (p.provider === LOCAL_PROVIDER) {
    const d = p.detail ?? {};
    return {
      advisory: 'Advisory statistics only. probabilities.long/short are calibrated P(profit) after costs of the first cell in pProfit.cells (horizon in candles; target up = price better than the entry at the end, plan = stop 1.5 ATR, breakeven at +1R, target 3R, out at the horizon); they mostly reflect spread and hour and are not an edge. It never places or changes a trade; confirm with price action before any entry.',
      provider: p.provider, instrument: p.instrument, granularity: p.granularity, action: p.action, probabilities: p.probabilities,
      headline: d.headline ?? null, headlineReason: d.headlineReason ?? null, pProfit: d.pprofit ?? null, bigDayToday: d.bigDay ?? null, noTradeReasons: d.reasons ?? [],
      trendContext: d.trend?.text ?? null, news: d.news ?? null, horizon: `next ${p.horizonBars} candles (see pProfit.cells for each horizon and target)`,
      candleTime: p.candleTime, price: p.price, askedAt: p.askedAt, expiresAt: p.expiresAt, valid: p.valid, reused: p.reused ?? false, inputs: p.state,
    };
  }
  return {
    advisory: 'Advisory prediction only. It never places or changes a trade; confirm with price action before any entry.',
    instrument: p.instrument, granularity: p.granularity, action: p.action, probabilities: p.probabilities, confidence: p.confidence,
    setupQuality: p.quality, setupQualityScale: '0-4', trendConfirmed: p.trendConfirmed, horizon: `next ${p.horizonBars} candles`,
    candleTime: p.candleTime, candleForming: p.forming, price: p.price, askedAt: p.askedAt, expiresAt: p.expiresAt, valid: p.valid,
    reused: p.reused ?? false, inputs: p.state,
  };
}

// ---- per-candle series for the chart tooltip
// At most this many closed candles per request; an older `from` is cut to the newest SERIES_MAX.
export const SERIES_MAX = 500;

// The compact chart entry for one candle from a local run's detail or a computed series row.
// `inSample` marks a candle before the cell artifact's training cutoff.
function seriesEntry(instrument, granularity, core, source, computedAt) {
  const ms = Date.parse(core.candleTime);
  const pp = core.pprofit ?? { available: false, text: 'no calibrated estimate' };
  const cells = pp.available ? pp.cells.map((c) => {
    const model = ppModel(instrument, granularity, c.horizon, c.target);
    return {
      key: c.key, horizon: c.horizon, target: c.target, pLong: c.long.p, pShort: c.short.p, expectedRLong: c.long.expectedR, expectedRShort: c.short.expectedR,
      headline: c.headline, reason: c.headlineReason ?? null, inSample: model ? ms < cutoffMs(model) : null,
    };
  }) : [];
  return {
    candleTime: core.candleTime, source, computedAt, spreadR: core.spreadR ?? null,
    reasons: (core.reasons ?? []).map(({ code, text }) => ({ code, text })), available: pp.available, text: pp.available ? null : pp.text, cells,
  };
}
// What a series row stores: the local scorer output without the per-side details the chart never reads.
const seriesCore = ({ candleTime, spreadR, reasons, pprofit: pp }) => ({
  candleTime, spreadR, reasons,
  pprofit: pp.available ? { available: true, cells: pp.cells.map(({ key, horizon, target, long, short, headline, headlineReason }) => ({ key, horizon, target, long: { p: long.p, expectedR: long.expectedR }, short: { p: short.p, expectedR: short.expectedR }, headline, headlineReason })) } : pp,
});

// One entry per closed candle of the window [from, to] (ms, both optional), newest SERIES_MAX only.
// A stored local run for the candle is used as is ("live"). Otherwise the free local scorer runs
// on the chart window ("computed", never a provider call) and the result is cached in
// prediction_series, so later reads are cached. The forming candle is never scored.
// `loadCandles` gives the chart window (mid), `loadBa` the bid/ask bars, read only when a candle is missing.
export async function predictionSeries(dbPath, { instrument, granularity, from = null, to = null, loadCandles, loadBa }, now = Date.now()) {
  const gMs = granularityMs(granularity);
  const candles = (await loadCandles()).filter((c) => c.partial !== true && c.complete !== false && Date.parse(c.time) + gMs <= now);
  const all = candles.filter((c) => (from == null || Date.parse(c.time) >= from) && (to == null || Date.parse(c.time) <= to));
  const win = all.slice(-SERIES_MAX);
  const [live, cached] = withDb(dbPath, (db) => {
    ensureTable(db);
    const runs = new Map();
    // newest run per candle; runs stored before per-cell scores existed are recomputed instead
    for (const r of db.prepare("SELECT candle_time, asked_at, detail FROM predictions WHERE instrument = ? AND granularity = ? AND provider = ? AND detail IS NOT NULL ORDER BY id DESC LIMIT 5000").all(instrument, granularity, LOCAL_PROVIDER)) {
      const ms = Date.parse(r.candle_time);
      const d = JSON.parse(r.detail);
      if (runs.has(ms) || !d.pprofit || (d.pprofit.available && !d.pprofit.cells)) continue;
      runs.set(ms, { core: { candleTime: r.candle_time, spreadR: d.spreadR, reasons: d.reasons, pprofit: d.pprofit }, at: r.asked_at });
    }
    const rows = db.prepare('SELECT candle_ms, entry, computed_at FROM prediction_series WHERE instrument = ? AND granularity = ? AND model = ?').all(instrument, granularity, LOCAL_MODEL);
    return [runs, new Map(rows.map((r) => [r.candle_ms, { core: JSON.parse(r.entry), at: r.computed_at }]))];
  });
  const missing = win.filter((c) => !live.has(Date.parse(c.time)) && !cached.has(Date.parse(c.time)));
  if (missing.length) {
    const ba = await loadBa().catch(() => []);
    const computedAt = new Date(now).toISOString();
    const fresh = localSeries({ instrument, granularity, candles, ba }, missing.map((c) => c.time));
    withDb(dbPath, (db) => {
      ensureTable(db);
      const put = db.prepare('INSERT OR REPLACE INTO prediction_series (instrument, granularity, candle_ms, model, entry, computed_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const e of fresh) {
        const core = seriesCore(e);
        cached.set(Date.parse(e.candleTime), { core, at: computedAt });
        // a candle without its bid/ask bar is not cached: a later read with the bar scores it
        if (e.hasBidAsk) put.run(instrument, granularity, Date.parse(e.candleTime), LOCAL_MODEL, JSON.stringify(core), computedAt);
      }
    });
  }
  const entries = win.map((c) => {
    const ms = Date.parse(c.time);
    const l = live.get(ms);
    if (l) return seriesEntry(instrument, granularity, l.core, 'live', l.at);
    const s = cached.get(ms);
    return seriesEntry(instrument, granularity, { ...s.core, candleTime: c.time }, 'computed', s.at);
  });
  return { entries, capped: all.length > win.length, max: SERIES_MAX };
}
