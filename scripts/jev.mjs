// Prediction provider: TypeSafe Jev. Answers long, short or no trade for the
// current (forming) candle over the next few candles, with calibrated
// probabilities. Gating and storage live in predictions.mjs.
//
// Jev reasons poorly over raw numbers (TypeSafe jev-1.13 "jaggedness" notes),
// so every indicator value is bucketed into words in code before the call.
// Raw OHLC and news never reach the API.
import { computeSupertrend, detectFlips, granularityMs } from './supertrend.mjs';
import { htfSupertrend } from './indicators.mjs';
import { indicatorSummary } from './lib/indicator-summary.mjs';

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const JEV_TIMEOUT_MS = 5000;
// The questions judge an entry over this many candles of the selected timeframe.
export const JEV_HORIZON_BARS = 3;
const HTF_LEVELS = ['M15', 'H1'];
export const JEV_PROVIDER = 'typesafe-jev';

export const GRAN_WORDS = { M1: '1-minute', M5: '5-minute', M15: '15-minute', M30: '30-minute', H1: '1-hour', H4: '4-hour', D: 'daily' };

const band = (v, edges, labels) => {
  if (v == null || !Number.isFinite(v)) return 'unknown';
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[labels.length - 1];
};

// Pure: indicatorSummary output + candle context -> named buckets only.
// `progress` is the elapsed share of the current bar (1 when it has closed);
// `htf` maps a higher granularity to its supertrend trend, or null when the
// window is too short to resample it.
export function jevState(summary, { instrument, granularity, trend, barsSinceFlip, bar, progress, htf = {} }) {
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
  const nearHigh = ex.highAtr != null && ex.highAtr < 1;
  const nearLow = ex.lowAtr != null && ex.lowAtr < 1;
  const state = {
    instrument,
    timeframe: GRAN_WORDS[granularity] || granularity,
    current_candle: progress >= 1 ? 'closed' : band(progress, [1 / 3, 2 / 3], ['forming, just opened', 'forming, mid-bar', 'forming, nearly closed']),
    supertrend: (trend === 'up' ? 'bullish' : 'bearish') + ', ' + (barsSinceFlip == null ? 'no flip in view'
      : band(barsSinceFlip, [1, 4, 21], ['flipped on this bar', 'flipped recently', 'established trend', 'long-running trend'])),
    price_vs_ema: emaPos,
    price_vs_vwap: summary.vwap == null ? 'unknown' : close >= summary.vwap ? 'above VWAP' : 'below VWAP',
    rsi: band(summary.rsi14, [30, 45, 55, 70], ['oversold', 'weak', 'neutral', 'strong', 'overbought']),
    macd: summary.macdHist == null ? 'unknown' : summary.macdHist >= 0 ? 'histogram positive' : 'histogram negative',
    bollinger: summary.bollinger ? band(summary.bollinger.pctB, [0, 0.2, 0.8, 1], ['below the lower band', 'near the lower band', 'mid-band', 'near the upper band', 'above the upper band']) : 'unknown',
    candle_shape: (bar.close >= bar.open ? 'green' : 'red') + (summary.barRangeAtr == null ? '' : ' ' + band(summary.barRangeAtr, [0.5, 1.5], ['small', 'normal-size', 'large'])) + ', trading '
      + band(closeAt, [0.25, 0.75], ['near its low', 'mid-range', 'near its high']),
    volume: band(summary.volume.ratio20, [0.7, 1.3, 2], ['below average', 'average', 'above average', 'very high']),
    recent_range: nearHigh && nearLow ? 'inside a tight 20-bar range'
      : nearHigh ? 'near the 20-bar high' : nearLow ? 'near the 20-bar low' : 'inside the 20-bar range',
  };
  for (const [g, t] of Object.entries(htf)) {
    state[`trend_${(GRAN_WORDS[g] || g).replace('-', '_')}`] = t == null ? 'not enough history' : t === 'up' ? 'uptrend' : 'downtrend';
  }
  return state;
}

const horizon = (granularity) => `the next ${JEV_HORIZON_BARS} ${GRAN_WORDS[granularity] || granularity} candles`;
export function jevQuestions(granularity) {
  return {
    action: {
      type: 'choice',
      instructions: `Given only this chart state, should a trader enter now, judged over ${horizon(granularity)}?`,
      criteria: {
        long: `Enter long: price is more likely to rise than fall over ${horizon(granularity)}`,
        short: `Enter short: price is more likely to fall than rise over ${horizon(granularity)}`,
        no_trade: 'Stay out: no clear edge, or the signals conflict',
      },
    },
    setup_quality: {
      type: 'score',
      instructions: 'How clean is the setup for the direction the state favours?',
      criteria: ['No setup', 'Weak', 'Moderate', 'Strong', 'Textbook'],
    },
    trend_confirmed: {
      type: 'noul',
      instructions: 'Do the indicators agree with the supertrend direction?',
    },
  };
}

// One request, three questions. Retries once on 429/529 (TypeSafe's documented
// transient statuses); any other failure throws with a readable message.
export async function jevDecide(settings, state, granularity, { fetchFn = fetch, timeoutMs = JEV_TIMEOUT_MS, retryDelayMs = 500 } = {}) {
  const body = JSON.stringify({ model: JEV_MODEL, state, questions: jevQuestions(granularity) });
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(JEV_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${String(settings.TYPESAFE_API_KEY).trim()}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if ((res.status === 429 || res.status === 529) && attempt === 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      continue;
    }
    if (res.status === 401) throw new Error('TypeSafe rejected the API key (401)');
    if (!res.ok) throw new Error(`TypeSafe request failed (HTTP ${res.status})`);
    let json;
    try { json = await res.json(); } catch { throw new Error('TypeSafe answer is not valid JSON'); }
    const a = json?.answers || {};
    const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
    const unit = (v) => inRange(v, 0, 1);
    const probs = a.action?.probabilities;
    if (a.action?.type !== 'choice' || !['long', 'short', 'no_trade'].includes(a.action.choice)
      || !probs || typeof probs !== 'object' || !['long', 'short', 'no_trade'].every((k) => unit(probs[k]))
      || a.setup_quality?.type !== 'score' || !inRange(a.setup_quality.score, 0, 4)
      || a.trend_confirmed?.type !== 'noul' || !unit(a.trend_confirmed.noul)) {
      throw new Error('TypeSafe answer is missing typed fields');
    }
    return {
      action: a.action.choice,
      probabilities: a.action.probabilities,
      confidence: a.action.confidence ?? null,
      quality: a.setup_quality.score,
      qualityConfidence: a.setup_quality.confidence ?? null,
      trendConfirmed: a.trend_confirmed.noul,
      model: json.model ?? null,
      latencyMs: Date.now() - started,
    };
  }
}

// Live prediction for the newest candle of the window (the forming bar when
// present). `candles` carry the chart's `partial` flag on the forming bar.
export async function jevPredict(settings, { instrument, granularity, candles }, { now = Date.now(), ...opts } = {}) {
  const bars = candles.map(({ partial, complete, ...c }) => c);
  const summary = indicatorSummary(bars);
  if (!summary) throw new Error('not enough candle history for a prediction');
  const last = candles[candles.length - 1];
  const forming = last.partial === true;
  const st = computeSupertrend(bars, {});
  const flips = detectFlips(bars, st);
  const i = bars.length - 1;
  const lastFlip = flips.filter((f) => f.index <= i).at(-1);
  const gMs = granularityMs(granularity);
  const htf = {};
  for (const g of HTF_LEVELS) if (granularityMs(g) > gMs) htf[g] = htfSupertrend(candles, granularity, g)?.trend ?? null;
  const state = jevState(summary, {
    instrument, granularity, bar: bars[i], htf,
    trend: st[i].trend,
    barsSinceFlip: lastFlip ? i - lastFlip.index : null,
    progress: forming ? Math.min(Math.max((now - Date.parse(last.time)) / gMs, 0), 0.999) : 1,
  });
  const verdict = await jevDecide(settings, state, granularity, opts);
  return { instrument, granularity, candleTime: last.time, forming, price: last.close, horizonBars: JEV_HORIZON_BARS, askedAt: new Date(now).toISOString(), ...verdict, state };
}
