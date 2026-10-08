// Live predictions for the current candle: the on/off rule, one run through
// the provider, and storage of every run so the console can restore it.
// Advisory only: nothing here is read by the bot, the filter or the notifier.
import { granularityMs, isGranularity, withDb } from './supertrend.mjs';
import { GRAN_WORDS, jevPredict, JEV_PROVIDER } from './jev.mjs';
import { fetchBidAsk, localPredict, LOCAL_PROVIDER, newsInput } from './local-predict.mjs';

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
CREATE INDEX IF NOT EXISTS predictions_pair ON predictions (instrument, granularity, id)`;

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
// stored. The local provider also reads `loadM5` (the M5 window for move size).
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

async function freshPrediction(dbPath, settings, { instrument, granularity, loadCandles, loadM5 }, now, opts) {
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
    input.m5 = loadM5 ? await loadM5() : (granularity === 'M5' ? candles : []);
    input.bidAsk = await fetchBidAsk(instrument, granularity, { fetchFn: opts.fetchFn });
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
      advisory: 'Advisory statistics only. There is no measurable direction edge; the long/short split is a constant near 50/50. It never places or changes a trade; confirm with price action before any entry.',
      provider: p.provider, instrument: p.instrument, granularity: p.granularity, action: p.action, probabilities: p.probabilities,
      directionInterval: d.direction?.interval ?? null, moveSizeNext6h: d.move ?? null, noTradeReasons: d.reasons ?? [],
      trendContext: d.trend?.text ?? null, news: d.news ?? null, horizon: 'next 6 hours (72 M5 bars)',
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
