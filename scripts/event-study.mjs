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
import { parseArgs, isMain } from './lib/cli.mjs';

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

// F2 fetch plan: ONE fxempire request that spans pre+post. No oanda leg.
export function buildFetchPlan(T, { preMin, postMin, margin = 5 } = {}) {
  const tSec = Math.floor(T / 1000);
  return {
    provider: 'fxempire', // single feed — never oanda for the pre leg
    from: tSec - preMin * 60,
    count: preMin + postMin + margin,
  };
}

// splitAtAnchor(candles, T) -> { preIdx, postStartIdx } where postStartIdx is
// the first candle with ms >= T and preIdx is the candle immediately before it.
export function splitAtAnchor(candles, T) {
  const s = normalize(candles);
  const postStartIdx = s.findIndex((c) => c.ms >= T);
  return { series: s, postStartIdx, preIdx: postStartIdx - 1 };
}

// Default horizons (minutes) for the multi-horizon impact read (#10). The 1-min
// candles we already pull give the resolution; a single endpoint (15m close) is
// too noisy on small reactions — the sign flips run-to-run while the magnitude
// (excursion) is stable, so excursion is the headline and per-horizon signed
// closes are secondary.
export const DEFAULT_HORIZONS = [1, 5, 15, 60];

// computeStudy(candles, T, opts) -> impact of the event at T using ONE feed.
// gapMs: if the first post candle is more than this after T, the market was
// closed at T and we label the study `next-open`. `horizons` (minutes) drives
// the per-horizon signed close-moves; the window spans the widest of them.
export function computeStudy(candles, T, { postMin = 15, horizons = DEFAULT_HORIZONS, gapMs = 60 * 60 * 1000 } = {}) {
  const { series, postStartIdx, preIdx } = splitAtAnchor(candles, T);
  if (postStartIdx === -1) return { status: 'closed/no-data', n: series.length };
  if (preIdx < 0) return { status: 'no-pre', n: series.length };

  const pre = series[preIdx];
  const anchor = series[postStartIdx];
  const gap = anchor.ms - T;
  const mode = gap > gapMs ? 'next-open' : 'in-session';

  const maxH = Math.max(postMin, ...horizons);
  const windowEnd = anchor.ms + maxH * 60 * 1000;
  const post = series.slice(postStartIdx).filter((c) => c.ms <= windowEnd);
  if (post.length < 2) return { status: 'closed/no-data', mode, n: series.length };

  const pct = (price) => ((price - pre.close) / pre.close) * 100;
  // signed close-move at horizon H: the close of the last candle within H minutes
  // of the anchor. If the window ends before H (short/closed session) this
  // degrades to the last available close — the same rule next-open uses, never a
  // fabricated extrapolation. null only when fewer than 2 candles fall in range.
  const moveAt = (h) => {
    const win = post.filter((c) => c.ms <= anchor.ms + h * 60 * 1000);
    return win.length >= 2 ? pct(win[win.length - 1].close) : null;
  };
  const moves = {};
  for (const h of horizons) moves[`${h}m`] = moveAt(h);

  // excursion over the FULL (widest-horizon) window — the primary reactivity read
  const hi = Math.max(...post.map((c) => c.high));
  const lo = Math.min(...post.map((c) => c.low));
  const maxUp = pct(hi);
  const maxDn = pct(lo);
  return {
    status: 'ok',
    mode,
    preClose: pre.close,
    postClose: post[post.length - 1].close,
    move: moveAt(postMin), // backward-compatible single-endpoint move (default 15m)
    moves,
    maxUp,
    maxDn,
    maxExcursion: Math.max(Math.abs(maxUp), Math.abs(maxDn)), // headline magnitude
    volume: post.reduce((a, c) => a + c.volume, 0),
    n: post.length,
    horizonMin: maxH,
    anchorTime: new Date(anchor.ms).toISOString(),
  };
}

// Live fetch of a single-feed series. Not exercised by unit tests (network).
export async function fetchSeries(market, symbol, plan, { execFile } = {}) {
  const run = execFile || (await import('node:child_process')).execFileSync;
  const out = run('node', [LIVE_DATA, '--mode', 'candles', '--provider', plan.provider,
    '--market', market, '--instrument', symbol, '--granularity', 'M1',
    '--count', String(plan.count), '--from', String(plan.from), '--pretty', 'false'],
    { encoding: 'utf8', timeout: 30000 });
  return JSON.parse(out).candles || [];
}

export async function runStudy({ at, market, symbol, preMin = 5, postMin = 15, horizons = DEFAULT_HORIZONS }) {
  const T = typeof at === 'number' ? at : Date.parse(at);
  // one fetch spans the WIDEST horizon (F2 single-feed preserved) — every horizon
  // is sliced from these same candles.
  const fetchMin = Math.max(postMin, ...horizons);
  const plan = buildFetchPlan(T, { preMin, postMin: fetchMin });
  const candles = await fetchSeries(market, symbol, plan);
  return { at: new Date(T).toISOString(), market, symbol, preMin, postMin, horizons, ...computeStudy(candles, T, { postMin, horizons }) };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.has('help') || !args.has('at') || !args.has('instrument')) {
    process.stdout.write('event-study — single-feed (F2) market impact of an event.\n  --at <ISO>          event timestamp (required)\n  --instrument <SYM>  candle symbol, e.g. BCO/USD (required)\n  --market <m>        indices|commodities (default: from catalog)\n  --pre <min>         pre window (default 5)\n  --post <min>        primary signed-move horizon (default 15)\n  --horizons <csv>    signed-move horizons in minutes (default 1,5,15,60)\n');
    return;
  }
  const horizons = args.has('horizons')
    ? String(args.get('horizons')).split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0)
    : DEFAULT_HORIZONS;
  const symbol = String(args.get('instrument'));
  const idx = symbolIndex();
  const known = idx.get(symbol);
  const market = String(args.get('market') || known?.market || 'indices');
  if (!known) process.stderr.write(`warning: ${symbol} not in candle catalog (F3); proceeding\n`);
  const res = await runStudy({
    at: String(args.get('at')), market, symbol,
    preMin: Number(args.get('pre') ?? 5), postMin: Number(args.get('post') ?? 15),
    horizons: horizons.length ? horizons : DEFAULT_HORIZONS,
  });
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`event-study error: ${e.message}\n`);
    process.exit(1);
  });
}
