// Live predictions for the current candle: the on/off rule, one run through
// the provider, and storage of every run so the console can restore it.
// Advisory only: nothing here is read by the bot, the filter or the notifier.
import { granularityMs, withDb } from './supertrend.mjs';
import { jevPredict, JEV_PROVIDER } from './jev.mjs';

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
  state TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS predictions_pair ON predictions (instrument, granularity, id)`;

export const PREDICTIONS_MAX_LIMIT = 100;

// The single on/off rule: a non-blank provider key AND the explicit opt-in toggle.
export function predictionActive(settings = {}) {
  return Boolean(String(settings.TYPESAFE_API_KEY ?? '').trim()) && ['1', true].includes(settings.predictionEnabled);
}

// A run is valid for one candle duration of its timeframe from the moment it was made.
const toRow = (r, now = Date.now()) => {
  const expires = Date.parse(r.asked_at) + granularityMs(r.granularity);
  return {
    id: r.id, instrument: r.instrument, granularity: r.granularity, candleTime: r.candle_time, forming: r.forming === 1,
    price: r.price, horizonBars: r.horizon_bars, askedAt: r.asked_at, expiresAt: new Date(expires).toISOString(), valid: now < expires,
    provider: r.provider, model: r.model, action: r.action, probabilities: JSON.parse(r.probabilities), confidence: r.confidence,
    quality: r.quality, trendConfirmed: r.trend_confirmed, latencyMs: r.latency_ms, state: JSON.parse(r.state),
  };
};

// The prediction for the pair right now. With `reuse`, the latest stored run is
// returned while it is still valid (no provider call); otherwise `loadCandles`
// supplies the current window and a new run is made and stored.
export async function currentPrediction(dbPath, settings, { instrument, granularity, loadCandles }, { reuse = false, now = Date.now(), ...opts } = {}) {
  if (reuse) {
    const latest = listPredictions(dbPath, instrument, granularity, 1, now)[0];
    if (latest?.valid) return { ...latest, reused: true };
  }
  const candles = await loadCandles();
  if (!candles.length) throw Object.assign(new Error(`no candles for ${instrument} ${granularity}`), { status: 404 });
  return { ...(await runPrediction(dbPath, settings, { instrument, granularity, candles }, { now, ...opts })), reused: false };
}

// Runs one prediction and stores it. A provider failure throws and stores nothing.
export async function runPrediction(dbPath, settings, input, opts = {}) {
  const p = await jevPredict(settings, input, opts);
  return withDb(dbPath, (db) => {
    db.exec(DDL);
    const { lastInsertRowid } = db.prepare(`INSERT INTO predictions (instrument, granularity, candle_time, forming, price, horizon_bars,
      asked_at, provider, model, action, probabilities, confidence, quality, trend_confirmed, latency_ms, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      p.instrument, p.granularity, p.candleTime, p.forming ? 1 : 0, p.price, p.horizonBars, p.askedAt, JEV_PROVIDER, p.model,
      p.action, JSON.stringify(p.probabilities), p.confidence, p.quality, p.trendConfirmed, p.latencyMs, JSON.stringify(p.state));
    return toRow(db.prepare('SELECT * FROM predictions WHERE id = ?').get(lastInsertRowid), opts.now);
  });
}

// Stored runs for one instrument and timeframe, newest first.
export function listPredictions(dbPath, instrument, granularity, limit = 20, now = Date.now()) {
  return withDb(dbPath, (db) => {
    db.exec(DDL);
    return db.prepare('SELECT * FROM predictions WHERE instrument = ? AND granularity = ? ORDER BY id DESC LIMIT ?')
      .all(instrument, granularity, Math.min(Math.max(1, limit), PREDICTIONS_MAX_LIMIT)).map((r) => toRow(r, now));
  });
}

// Compact, model-facing view of a run for the advisory tools.
export function predictionForTool(p) {
  return {
    advisory: 'Advisory prediction only. It never places or changes a trade; confirm with price action before any entry.',
    instrument: p.instrument, granularity: p.granularity, action: p.action, probabilities: p.probabilities, confidence: p.confidence,
    setupQuality: p.quality, setupQualityScale: '0-4', trendConfirmed: p.trendConfirmed, horizon: `next ${p.horizonBars} candles`,
    candleTime: p.candleTime, candleForming: p.forming, price: p.price, askedAt: p.askedAt, expiresAt: p.expiresAt, valid: p.valid,
    reused: p.reused ?? false, inputs: p.state,
  };
}
