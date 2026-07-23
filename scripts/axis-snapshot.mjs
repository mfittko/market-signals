#!/usr/bin/env node
// Axis-grouped gate snapshot (issue #32, grilled design; shared contract with
// #26/#40 — schema_version'd, no parallel formats). Five INDEPENDENT axes so
// correlated indicators can never double-count; the display set (EMA20, MACD,
// Bollinger bands) deliberately never votes here.
import { createHash } from 'node:crypto';
import { withDb, signalOutcomes } from './supertrend.mjs';
import { adx, atr, ema, rsi, vwap, volumeRatio, htfSupertrend } from './indicators.mjs';

export const SNAPSHOT_SCHEMA_VERSION = 1;

const last = (arr) => (arr.length ? arr[arr.length - 1] : null);
const round = (v, p = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** p) / 10 ** p);

// flip: {signal: 'buy'|'sell'} when a flip triggered this snapshot (axes that
// judge alignment need a direction; without one they report state only).
export function axisSnapshot(candles, { instrument, granularity, flip = null } = {}) {
  candles = candles.filter((c) => c.complete !== false && c.partial !== true); // gate axes judge completed bars only (db uses complete, chart tail uses partial)
  if (candles.length < 30) return null;
  const closes = candles.map((c) => c.close);
  const lastCandle = candles[candles.length - 1];
  const dir = flip?.signal === 'buy' ? 1 : flip?.signal === 'sell' ? -1 : 0;

  // 1) trend-strength: ADX — the ranging-vs-trending chop filter
  const adxNow = last(adx(candles, 14).filter((x) => x != null));
  const trendStrength = {
    adx: round(adxNow, 1),
    verdict: adxNow == null ? null : adxNow >= 25 ? 'trending' : adxNow < 20 ? 'ranging' : 'neutral',
  };

  // 2) direction/regime: EMA 50/200 relationship + HTF supertrend agreement
  const e50 = closes.length >= 50 ? last(ema(closes, 50)) : null;
  // a regime vote needs real 200-bar warm-up — ema() seeding would happily
  // fabricate one from a handful of closes
  const e200 = closes.length >= 200 ? last(ema(closes, 200)) : null;
  const regime = e50 != null && e200 != null ? (e50 >= e200 ? 'bull' : 'bear') : null;
  const htfM15 = htfSupertrend(candles, granularity, 'M15');
  const htfH1 = htfSupertrend(candles, granularity, 'H1');
  let directionVerdict = null;
  if (dir !== 0) {
    const votes = [regime === 'bull' ? 1 : regime === 'bear' ? -1 : 0,
      htfM15 ? (htfM15.trend === 'up' ? 1 : -1) : 0,
      htfH1 ? (htfH1.trend === 'up' ? 1 : -1) : 0].filter((v) => v !== 0);
    const agree = votes.filter((v) => v === dir).length;
    directionVerdict = !votes.length ? null : agree === votes.length ? 'aligned' : agree === 0 ? 'counter' : 'mixed';
  }
  const direction = { emaRegime: regime, htfM15: htfM15?.trend ?? null, htfH1: htfH1?.trend ?? null, verdict: directionVerdict };

  // 3) impulse: flip-bar range vs ATR + volume vs 20-bar average
  const atrNow = last(atr(candles, 14).filter((x) => x != null));
  const barRange = lastCandle.high - lastCandle.low;
  const rangeAtr = atrNow > 0 ? barRange / atrNow : null;
  const volRatio = volumeRatio(candles, 20);
  const impulse = {
    rangeAtr: round(rangeAtr),
    volumeRatio: round(volRatio),
    verdict: rangeAtr == null || volRatio == null ? null
      : rangeAtr >= 1 && volRatio >= 1.5 ? 'impulsive'
        : volRatio < 0.8 ? 'thin' : 'neutral',
  };

  // 4) location: position vs session VWAP (participation-weighted fair value)
  const vwapNow = last(vwap(candles));
  const vwapDistPct = vwapNow ? ((lastCandle.close - vwapNow) / vwapNow) * 100 : null;
  const vwapDistAtr = vwapNow != null && atrNow > 0 ? (lastCandle.close - vwapNow) / atrNow : null;
  const location = {
    vwapDistPct: round(vwapDistPct, 3),
    vwapDistAtr: round(vwapDistAtr),
    verdict: dir === 0 || vwapDistPct == null ? null
      : (dir === 1 && vwapDistPct >= 0) || (dir === -1 && vwapDistPct <= 0) ? 'aligned' : 'counter',
  };

  // 5) exhaustion veto: RSI extremes against the entry direction
  const rsiNow = last(rsi(closes, 14).filter((x) => x != null));
  const exhaustion = {
    rsi: round(rsiNow, 1),
    verdict: dir === 0 || rsiNow == null ? null
      : (dir === 1 && rsiNow > 70) || (dir === -1 && rsiNow < 30) ? 'veto' : 'clear',
  };

  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    at: lastCandle.time,
    instrument,
    granularity,
    flip: flip?.signal ?? null,
    axes: { trendStrength, direction, impulse, location, exhaustion },
  };
}

// The ONLY shape any LLM judge (#40) may see: no timestamps, no symbols, no
// absolute prices — verdicts plus relative/normalized values.
export function anonymized(snapshot) {
  if (!snapshot) return null;
  const a = snapshot.axes;
  return {
    schema_version: snapshot.schema_version,
    flip: snapshot.flip,
    axes: {
      trendStrength: { adx: a.trendStrength.adx, verdict: a.trendStrength.verdict },
      direction: { emaRegime: a.direction.emaRegime, htfAgreement: [a.direction.htfM15, a.direction.htfH1], verdict: a.direction.verdict },
      impulse: { rangeAtr: a.impulse.rangeAtr, volumeRatio: a.impulse.volumeRatio, verdict: a.impulse.verdict },
      location: { vwapDistAtr: a.location.vwapDistAtr, verdict: a.location.verdict },
      exhaustion: { rsi: a.exhaustion.rsi, verdict: a.exhaustion.verdict },
    },
  };
}

const SNAP_DDL = `CREATE TABLE IF NOT EXISTS signal_snapshots (
  instrument TEXT NOT NULL,
  granularity TEXT NOT NULL,
  time TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  filter_verdict TEXT,
  filter_model TEXT,
  filter_prompt_hash TEXT,
  context TEXT,
  PRIMARY KEY (instrument, granularity, time)
)`;

export const promptHash = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 8);

// Recorded once per signal (INSERT OR IGNORE like the signals table). The
// optional context block (headline digest, #40 decision 4) is replay-only:
// sentiment is NOT scored here — the per-signal judge scores it from this
// recorded digest at backtest time, never from a live fetch.
export function recordSnapshot(dbPath, snapshot, { filterVerdict = null, filterModel = null, filterPromptHash = null, filterPromptVersion = null, context = null } = {}) {
  if (!snapshot) return false;
  return withDb(dbPath, (db) => {
    db.exec(SNAP_DDL);
    // Pre-#58 dbs lack this column; another process can win the same ALTER
    // between our PRAGMA check and exec — only that loss is benign.
    if (!db.prepare('PRAGMA table_info(signal_snapshots)').all().some((c) => c.name === 'filter_prompt_version')) {
      try { db.exec('ALTER TABLE signal_snapshots ADD COLUMN filter_prompt_version TEXT'); } catch (err) {
        if (!/duplicate column/i.test(String(err?.message))) throw err;
      }
    }
    let ctx = null;
    if (context) { try { ctx = JSON.stringify(context); } catch { ctx = null; } }
    return db.prepare(`INSERT OR IGNORE INTO signal_snapshots
      (instrument, granularity, time, schema_version, snapshot, filter_verdict, filter_model, filter_prompt_hash, filter_prompt_version, context)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(snapshot.instrument, snapshot.granularity, snapshot.at, snapshot.schema_version,
        JSON.stringify(snapshot), filterVerdict, filterModel, filterPromptHash, filterPromptVersion == null ? null : String(filterPromptVersion), ctx).changes > 0;
  });
}

// Flip-outcome expectancy conditioned per axis verdict: joins recorded
// snapshots with realized signal outcomes — proves or rejects each voter on
// expectancy of surviving alerts, not signal count (#32 locked design).
export function axisExpectancy(dbPath, { instrument = null, granularity = null } = {}) {
  const snaps = withDb(dbPath, (db) => {
    let sql = 'SELECT instrument, granularity, time, snapshot FROM signal_snapshots';
    const where = [];
    const args = [];
    if (instrument) { where.push('instrument = ?'); args.push(instrument); }
    if (granularity) { where.push('granularity = ?'); args.push(granularity); }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    // reporting never mutates: a db without the table simply has no snapshots
    try { return db.prepare(sql).all(...args); } catch (err) {
      if (/no such table/i.test(String(err.message))) return [];
      throw err;
    }
  });
  if (!snaps.length) return null;
  // outcomes are computed (30-min realized move), not stored: resolve per combo
  const outcomesByCombo = new Map();
  const buckets = new Map();
  for (const row of snaps) {
    const comboKey = `${row.instrument}|${row.granularity}`;
    if (!outcomesByCombo.has(comboKey)) {
      const map = new Map();
      for (const o of signalOutcomes(dbPath, row.instrument, row.granularity, { limit: 100000 })) {
        if (o.outcomePct != null) map.set(o.time, o.outcomePct);
      }
      outcomesByCombo.set(comboKey, map);
    }
    const outcomePct = outcomesByCombo.get(comboKey).get(row.time);
    if (outcomePct == null) continue;
    let snap;
    try { snap = JSON.parse(row.snapshot); } catch { continue; }
    for (const [axis, data] of Object.entries(snap.axes ?? {})) {
      if (!data?.verdict) continue;
      const key = `${axis}:${data.verdict}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(outcomePct);
    }
  }
  if (!buckets.size) return null;
  const out = {};
  for (const [key, outcomes] of buckets) {
    const [axis, verdict] = key.split(':');
    out[axis] = out[axis] || {};
    out[axis][verdict] = {
      signals: outcomes.length,
      expectancyPct: round(outcomes.reduce((a, b) => a + b, 0) / outcomes.length, 4),
    };
  }
  return out;
}
