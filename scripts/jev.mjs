// TypeSafe Jev per-candle verdicts: one typed decision (long/short/flat,
// setup quality, trend confirmation) per closed bar, stored for the chart.
// Advisory only — nothing here feeds the bot, the filter or the notifier.
//
// Jev reasons poorly over raw numbers (TypeSafe jev-1.13 "jaggedness" notes),
// so every indicator value is bucketed into words in code before the call.
// Raw OHLC and news never reach the API.
import { withDb } from './supertrend.mjs';
import { indicatorSummary } from './lib/indicator-summary.mjs';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const JEV_TIMEOUT_MS = 5000;
// Bars scored per cycle: the newest closed bar plus a small catch-up window for
// cycles that were skipped (server restart, sleep). Older gaps stay unscored.
const JEV_BACKFILL_BARS = 3;

const JEV_DDL = `CREATE TABLE IF NOT EXISTS jev_decisions (
  instrument TEXT NOT NULL,
  granularity TEXT NOT NULL,
  time TEXT NOT NULL,
  action TEXT NOT NULL,
  p_long REAL, p_short REAL, p_flat REAL,
  action_confidence REAL,
  quality REAL,
  quality_confidence REAL,
  trend_confirmed REAL,
  model TEXT,
  latency_ms INTEGER,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (instrument, granularity, time)
)`;

// The single on/off rule shared by the cycle and the chart: a stored key AND
// the explicit opt-in toggle. A toggle left on after the key is removed is off.
export function jevActive(settings = {}) {
  return Boolean(settings.TYPESAFE_API_KEY) && ['1', true].includes(settings.jevEnabled);
}

const GRAN_WORDS = { M1: '1-minute', M5: '5-minute', M15: '15-minute', M30: '30-minute', H1: '1-hour', H4: '4-hour', D: 'daily' };

const band = (v, edges, labels) => {
  if (v == null || !Number.isFinite(v)) return 'unknown';
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[labels.length - 1];
};

// Pure: indicatorSummary output + supertrend context -> named buckets only.
export function jevState(summary, { instrument, granularity, trend, barsSinceFlip, bar }) {
  const close = summary.close;
  const { ema20, ema50 } = summary.ema;
  const emaPos = ema20 == null ? 'unknown'
    : ema50 == null ? (close >= ema20 ? 'above EMA20' : 'below EMA20')
      : close >= ema20 && close >= ema50 ? 'above EMA20 and EMA50'
        : close < ema20 && close < ema50 ? 'below EMA20 and EMA50'
          : 'between EMA20 and EMA50';
  const range = bar.high - bar.low;
  const closeAt = range > 0 ? (bar.close - bar.low) / range : 0.5;
  const ex = summary.extremes;
  return {
    instrument,
    timeframe: GRAN_WORDS[granularity] || granularity,
    supertrend: (trend === 'up' ? 'bullish' : 'bearish') + ', ' + (barsSinceFlip == null ? 'no flip in view'
      : band(barsSinceFlip, [1, 4, 21], ['flipped on this bar', 'flipped recently', 'established trend', 'long-running trend'])),
    price_vs_ema: emaPos,
    price_vs_vwap: summary.vwap == null ? 'unknown' : close >= summary.vwap ? 'above VWAP' : 'below VWAP',
    rsi: band(summary.rsi14, [30, 45, 55, 70], ['oversold', 'weak', 'neutral', 'strong', 'overbought']),
    macd: summary.macdHist == null ? 'unknown' : summary.macdHist >= 0 ? 'histogram positive' : 'histogram negative',
    bollinger: summary.bollinger ? band(summary.bollinger.pctB, [0, 0.2, 0.8, 1], ['below the lower band', 'near the lower band', 'mid-band', 'near the upper band', 'above the upper band']) : 'unknown',
    last_bar: (bar.close >= bar.open ? 'green' : 'red') + ' ' + band(summary.barRangeAtr, [0.5, 1.5], ['small', 'normal-size', 'large']) + ' candle, closing '
      + band(closeAt, [0.25, 0.75], ['near its low', 'mid-range', 'near its high']),
    volume: band(summary.volume.ratio20, [0.7, 1.3, 2], ['below average', 'average', 'above average', 'very high']),
    recent_range: ex.highAtr != null && ex.highAtr < 1 ? 'near the 20-bar high'
      : ex.lowAtr != null && ex.lowAtr < 1 ? 'near the 20-bar low' : 'inside the 20-bar range',
  };
}

const QUESTIONS = {
  action: {
    type: 'choice',
    instructions: 'Given only this chart state, what is the best action on this closed candle?',
    criteria: {
      long: 'Conditions favour entering or holding a long',
      short: 'Conditions favour entering or holding a short',
      flat: 'No clear edge; stay out',
    },
  },
  setup_quality: {
    type: 'score',
    instructions: 'How clean is the setup for the chosen direction?',
    criteria: ['No setup', 'Weak', 'Moderate', 'Strong', 'Textbook'],
  },
  trend_confirmed: {
    type: 'noul',
    instructions: 'Do the indicators agree with the supertrend direction?',
  },
};

// One request, three questions. Retries once on 429/529 (TypeSafe's documented
// transient statuses); any other failure throws to the best-effort caller.
export async function jevDecide(settings, state, { fetchFn = fetch, timeoutMs = JEV_TIMEOUT_MS, retryDelayMs = 500 } = {}) {
  const body = JSON.stringify({ model: JEV_MODEL, state, questions: QUESTIONS });
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(JEV_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.TYPESAFE_API_KEY}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if ((res.status === 429 || res.status === 529) && attempt === 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      continue;
    }
    if (!res.ok) throw new Error(`jev HTTP ${res.status}`);
    const json = await res.json();
    const a = json.answers || {};
    if (a.action?.type !== 'choice' || a.setup_quality?.type !== 'score' || a.trend_confirmed?.type !== 'noul') {
      throw new Error('jev response missing typed answers');
    }
    return {
      action: a.action.choice,
      probabilities: a.action.probabilities,
      actionConfidence: a.action.confidence,
      quality: a.setup_quality.score,
      qualityConfidence: a.setup_quality.confidence,
      trendConfirmed: a.trend_confirmed.noul,
      model: json.model,
      latencyMs: Date.now() - started,
    };
  }
}

// Score the newest closed bars that have no verdict yet. `candles` are the
// cycle's complete bars; `st`/`flips` come from the same supertrend pass.
export async function scoreClosedBars(dbPath, settings, { instrument, granularity, candles, st, flips }, opts = {}) {
  if (!jevActive(settings) || candles.length < 2) return { scored: 0 };
  const from = Math.max(0, candles.length - JEV_BACKFILL_BARS);
  const want = candles.slice(from).map((c) => c.time);
  const have = withDb(dbPath, (db) => {
    db.exec(JEV_DDL);
    const q = db.prepare('SELECT 1 FROM jev_decisions WHERE instrument=? AND granularity=? AND time=?');
    return new Set(want.filter((t) => q.get(instrument, granularity, t)));
  });
  let scored = 0;
  for (let i = from; i < candles.length; i++) {
    const bar = candles[i];
    if (have.has(bar.time)) continue;
    const summary = indicatorSummary(candles.slice(0, i + 1));
    if (!summary || !st[i]) continue;
    const lastFlip = flips.filter((f) => f.index <= i).at(-1);
    const state = jevState(summary, { instrument, granularity, trend: st[i].trend, barsSinceFlip: lastFlip ? i - lastFlip.index : null, bar });
    const v = await jevDecide(settings, state, opts);
    withDb(dbPath, (db) => {
      db.exec(JEV_DDL);
      db.prepare(`INSERT OR IGNORE INTO jev_decisions (instrument, granularity, time, action, p_long, p_short, p_flat,
        action_confidence, quality, quality_confidence, trend_confirmed, model, latency_ms, decided_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        instrument, granularity, bar.time, v.action, v.probabilities.long ?? null, v.probabilities.short ?? null, v.probabilities.flat ?? null,
        v.actionConfidence ?? null, v.quality ?? null, v.qualityConfidence ?? null, v.trendConfirmed ?? null, v.model ?? null, v.latencyMs, new Date().toISOString());
    });
    scored++;
  }
  return { scored };
}

// Stored verdicts for a chart window [fromTime, toTime] (inclusive).
export function jevDecisions(dbPath, instrument, granularity, fromTime, toTime) {
  return withDb(dbPath, (db) => {
    db.exec(JEV_DDL);
    return db.prepare(`SELECT time, action, p_long AS pLong, p_short AS pShort, p_flat AS pFlat, quality, trend_confirmed AS trendConfirmed
      FROM jev_decisions WHERE instrument=? AND granularity=? AND time>=? AND time<=? ORDER BY time`).all(instrument, granularity, fromTime, toTime)
      .map((r) => ({ ...r }));
  });
}
