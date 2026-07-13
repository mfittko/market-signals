#!/usr/bin/env node
// Event-study harness (issue #7, component 3). Reusable for live signal testing.
//
// F2: SINGLE-FEED windows are mandatory. Pre and post BOTH come from ONE
// provider (fxempire): fetch `--from (T - preMin)` with enough candles to cover
// pre+post, then split at the first candle >= T. The old cross-feed method
// (oanda pre + fxempire post) produced a SIGN-FLIPPED artifact, so we never mix
// providers for a single study.
//
// Market-hours aware: if the market is closed at T (no candle at/near T), the
// first candle >= T is the NEXT OPEN. We detect the gap and label the study
// `next-open` instead of emitting an empty window. Sessions differ per
// instrument (oil, equities, metals), and the gap detection is per-series.
import { fileURLToPath } from 'node:url';
import { symbolIndex } from './lib/catalog.mjs';

const LIVE_DATA = fileURLToPath(new URL('../skills/fxempire-live-data/scripts/fxempire_live_data.mjs', import.meta.url));

// Parse an fxempire candle time string to epoch ms. fxempire returns e.g.
// "2026/07/10 14:30" (UTC); tolerate ISO too.
export function candleMs(time) {
  if (typeof time === 'number') return time;
  const s = String(time).trim().replace(/\//g, '-');
  const iso = /T/.test(s) ? s : `${s.replace(' ', 'T')}`;
  const ms = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms : NaN;
}

function normalize(candles) {
  return (candles || [])
    .map((c) => ({ ms: candleMs(c.time), open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +(c.volume || 0) }))
    .filter((c) => Number.isFinite(c.ms) && Number.isFinite(c.close))
    .sort((a, b) => a.ms - b.ms);
}

// Default event-study horizons (minutes): headline reactivity is measured at
// each, all sliced from the SAME single feed (F2).
export const DEFAULT_HORIZONS = [1, 5, 15, 60];

// F2 fetch plan: ONE fxempire request that spans pre+post. No oanda leg.
// stepMin is the candle granularity in minutes (M1=1, M5=5, H1=60) so `count`
// covers the widened post window regardless of granularity.
export function buildFetchPlan(T, { preMin, postMin, stepMin = 1, margin = 5 } = {}) {
  const tSec = Math.floor(T / 1000);
  return {
    provider: 'fxempire', // single feed — never oanda for the pre leg
    from: tSec - preMin * 60,
    count: Math.ceil((preMin + postMin) / stepMin) + margin,
  };
}

// splitAtAnchor(candles, T) -> { preIdx, postStartIdx } where postStartIdx is
// the first candle with ms >= T and preIdx is the candle immediately before it.
export function splitAtAnchor(candles, T) {
  const s = normalize(candles);
  const postStartIdx = s.findIndex((c) => c.ms >= T);
  return { series: s, postStartIdx, preIdx: postStartIdx - 1 };
}

// Signed close-move + max-excursion of a candle slice, relative to preClose.
function measure(slice, preClose) {
  const last = slice[slice.length - 1].close;
  const hi = Math.max(...slice.map((c) => c.high));
  const lo = Math.min(...slice.map((c) => c.low));
  return {
    move: ((last - preClose) / preClose) * 100,       // secondary: signed close
    maxUp: ((hi - preClose) / preClose) * 100,        // primary: up excursion
    maxDn: ((lo - preClose) / preClose) * 100,        // primary: down excursion
  };
}

// computeStudy(candles, T, opts) -> impact of the event at T using ONE feed.
// Emits max-excursion (maxUp/maxDn) as the PRIMARY reactivity measure plus the
// signed close-move at each horizon in `horizons` (minutes). Every horizon is
// sliced from the SAME single-feed series (F2) — we just widen the post window
// to cover the longest horizon and cut at anchor + h.
// gapMs: if the first post candle is more than this after T, the market was
// closed at T and we label the study `next-open`.
export function computeStudy(candles, T, { horizons = DEFAULT_HORIZONS, postMin, gapMs = 60 * 60 * 1000 } = {}) {
  const hs = [...horizons].sort((a, b) => a - b);
  const fullMin = postMin ?? hs[hs.length - 1]; // widen to cover the longest horizon
  const { series, postStartIdx, preIdx } = splitAtAnchor(candles, T);
  if (postStartIdx === -1) return { status: 'closed/no-data', n: series.length };
  if (preIdx < 0) return { status: 'no-pre', n: series.length };

  const pre = series[preIdx];
  const anchor = series[postStartIdx];
  const gap = anchor.ms - T;
  const mode = gap > gapMs ? 'next-open' : 'in-session';

  const windowEnd = anchor.ms + fullMin * 60 * 1000;
  const post = series.slice(postStartIdx).filter((c) => c.ms <= windowEnd);
  if (post.length < 2) return { status: 'closed/no-data', mode, n: series.length };

  // Per-horizon slices from the one feed: cut the same post series at anchor + h.
  const perHorizon = {};
  for (const h of hs) {
    const slice = post.filter((c) => c.ms <= anchor.ms + h * 60 * 1000);
    if (slice.length < 2) continue; // horizon reaches past available data
    perHorizon[h] = { minutes: h, ...measure(slice, pre.close) };
  }

  const full = measure(post, pre.close);
  return {
    status: 'ok',
    mode,
    preClose: pre.close,
    postClose: post[post.length - 1].close,
    // Primary reactivity: max-excursion over the full window.
    maxUp: full.maxUp,
    maxDn: full.maxDn,
    // Secondary: full-window signed close (back-compat) + per-horizon breakdown.
    move: full.move,
    horizons: perHorizon,
    volume: post.reduce((a, c) => a + c.volume, 0),
    n: post.length,
    anchorTime: new Date(anchor.ms).toISOString(),
  };
}

// Live fetch of a single-feed series. Not exercised by unit tests (network).
export async function fetchSeries(market, symbol, plan, { execFile } = {}, granularity = 'M1') {
  const run = execFile || (await import('node:child_process')).execFileSync;
  const out = run('node', [LIVE_DATA, '--mode', 'candles', '--provider', plan.provider,
    '--market', market, '--instrument', symbol, '--granularity', granularity,
    '--count', String(plan.count), '--from', String(plan.from), '--pretty', 'false'],
    { encoding: 'utf8', timeout: 30000 });
  return JSON.parse(out).candles || [];
}

const STEP_MIN = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240 };

export async function runStudy({ at, market, symbol, preMin = 5, horizons = DEFAULT_HORIZONS, granularity = 'M1', postMin }) {
  const T = typeof at === 'number' ? at : Date.parse(at);
  const fullMin = postMin ?? Math.max(...horizons); // widen the ONE fetch to cover 60m
  const stepMin = STEP_MIN[granularity] ?? 1;
  const plan = buildFetchPlan(T, { preMin, postMin: fullMin, stepMin });
  const candles = await fetchSeries(market, symbol, plan, {}, granularity);
  return {
    at: new Date(T).toISOString(), market, symbol, preMin, postMin: fullMin, granularity, horizons,
    ...computeStudy(candles, T, { horizons, postMin: fullMin }),
  };
}

async function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i]);
  }
  if (args.has('help') || !args.has('at') || !args.has('instrument')) {
    process.stdout.write('event-study — single-feed (F2) multi-horizon market impact of an event.\n  --at <ISO>          event timestamp (required)\n  --instrument <SYM>  candle symbol, e.g. BCO/USD (required)\n  --market <m>        indices|commodities (default: from catalog)\n  --pre <min>         pre window (default 5)\n  --horizons <list>   comma-separated post horizons in minutes (default 1,5,15,60)\n  --granularity <g>   M1|M5|H1 (default M1)\n');
    return;
  }
  const symbol = String(args.get('instrument'));
  const idx = symbolIndex();
  const known = idx.get(symbol);
  const market = String(args.get('market') || known?.market || 'indices');
  if (!known) process.stderr.write(`warning: ${symbol} not in candle catalog (F3); proceeding\n`);
  const horizons = args.has('horizons')
    ? String(args.get('horizons')).split(',').map(Number).filter((n) => n > 0)
    : DEFAULT_HORIZONS;
  const res = await runStudy({
    at: String(args.get('at')), market, symbol,
    preMin: Number(args.get('pre') ?? 5), horizons,
    granularity: String(args.get('granularity') || 'M1'),
  });
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`event-study error: ${e.message}\n`);
    process.exit(1);
  });
}
