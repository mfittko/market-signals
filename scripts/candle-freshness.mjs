#!/usr/bin/env node
// #145 measure-first: sample the FXEmpire/OANDA candle tail repeatedly and report
// the observed upstream update cadence + request latency, so the tail-poll cadence
// is chosen from real behavior rather than assumed ("more requests" ≠ "fresher
// data"). Read-only — no persistence, no signals, no trades. Uses the existing
// candle source only (no new provider/key/dependency).
import { fetchCandles, granularityMs } from './supertrend.mjs';
import { parseArgs, isMain } from './lib/cli.mjs';

// One measurement: fetch a tiny tail, time the request, extract the newest
// completed bar and the forming (partial) bar, and compute freshness lag.
export async function sampleFreshness({ instrument, granularity, count = 3, fetcher = fetchCandles, now = Date.now } = {}) {
  const t0 = now();
  let rows = [];
  let error = null;
  try { rows = await fetcher({ instrument, granularity, count }); }
  catch (e) { error = String(e?.message ?? e); }
  const t1 = now();
  const forming = rows.find((c) => !c.complete) ?? null;
  // newest completed bar by timestamp — don't assume the fetcher returns sorted rows
  const lastComplete = rows.filter((c) => c.complete)
    .reduce((a, c) => (a && Date.parse(a.time) >= Date.parse(c.time) ? a : c), null);
  const stepMs = granularityMs(granularity);
  // lag: ms since the forming bar's close boundary (negative ⇒ bar still open)
  const formingLagMs = forming ? (t1 - (Date.parse(forming.time) + stepMs)) : null;
  return {
    at: t1,
    requestMs: t1 - t0,
    error,
    forming: forming && { time: forming.time, open: forming.open, high: forming.high, low: forming.low, close: forming.close, volume: forming.volume },
    lastComplete: lastComplete && { time: lastComplete.time, close: lastComplete.close },
    formingLagMs,
    stepMs,
  };
}

// Fold a sample into running change-observation state: a "change" is the forming
// bar's close/volume first moving, or a new bar appearing. The interval between
// changes is the real upstream cadence (the minimum useful poll interval).
export function initState() {
  return {
    lastForming: null, lastChangeAt: null, changeIntervals: [], requestMs: [], samples: 0, changes: 0,
    lastCompleteTime: null, completionDelays: [],
  };
}
export function foldChange(state, sample) {
  const prev = state.lastForming;
  const cur = sample.forming;
  let changed = false;
  if (cur && (!prev || cur.time !== prev.time)) changed = true; // a new forming bar
  // same bar, any OHLCV field moved (providers often revise high/low, not just close)
  else if (cur && prev && ['open', 'high', 'low', 'close', 'volume'].some((k) => cur[k] !== prev[k])) changed = true;
  const changeIntervals = state.changeIntervals.slice();
  if (changed && state.lastChangeAt != null) changeIntervals.push(sample.at - state.lastChangeAt);
  // Completion delay (#145 phase 2): how long AFTER a bar's close boundary the
  // provider first serves it as complete. This is what the boundary-confirmer's
  // retry ladder has to cover — sampling resolution bounds it from above, so
  // treat it as an upper bound, not an exact figure.
  const completionDelays = state.completionDelays.slice();
  const seen = sample.lastComplete?.time ?? null;
  if (seen && seen !== state.lastCompleteTime) {
    if (state.lastCompleteTime != null) completionDelays.push(sample.at - (Date.parse(seen) + sample.stepMs));
  }
  return {
    lastForming: cur ?? prev,
    lastChangeAt: changed ? sample.at : state.lastChangeAt,
    changeIntervals,
    requestMs: state.requestMs.concat(sample.requestMs),
    samples: state.samples + 1,
    changes: state.changes + (changed ? 1 : 0),
    lastCompleteTime: seen ?? state.lastCompleteTime,
    completionDelays,
  };
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export function summarize(state) {
  return {
    samples: state.samples,
    changes: state.changes,
    requestMsMedian: median(state.requestMs),
    requestMsMax: state.requestMs.length ? Math.max(...state.requestMs) : null,
    changeIntervalMsMedian: median(state.changeIntervals),
    // the observed cadence is the floor for a useful poll interval
    observedUpdateCadenceMs: median(state.changeIntervals),
    // boundary → first served complete; drives the confirmer's retry ladder
    completionDelayMsMedian: median(state.completionDelays),
    completionDelayMsMax: state.completionDelays.length ? Math.max(...state.completionDelays) : null,
    completionSamples: state.completionDelays.length,
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.has('help')) {
    process.stdout.write('candle-freshness — sample upstream candle freshness & latency (#145, read-only).\n  --instrument <SYM>  (default BCO/USD)\n  --granularity <g>   (default M1 — use a minute grain to see the forming bar move)\n  --interval <sec>    seconds between samples (default 5)\n  --samples <n>       number of samples (default 24)\n  --count <n>         tail size to fetch (default 3)\n  --json              emit one JSON line per sample\nRun during an ACTIVE market period; the summary reports the observed update cadence.\n');
    return;
  }
  const instrument = String(args.get('instrument') || 'BCO/USD');
  const granularity = String(args.get('granularity') || 'M1');
  const intervalMs = Number(args.get('interval') ?? 5) * 1000;
  const samples = Number(args.get('samples') ?? 24);
  const count = Number(args.get('count') ?? 3);
  const asJson = args.has('json');
  let state = initState();
  for (let i = 0; i < samples; i++) {
    const s = await sampleFreshness({ instrument, granularity, count });
    state = foldChange(state, s);
    process.stdout.write((asJson ? JSON.stringify(s)
      : `${new Date(s.at).toISOString()} req=${s.requestMs}ms forming=${s.forming?.time ?? '-'} close=${s.forming?.close ?? '-'} lag=${s.formingLagMs ?? '-'}ms${s.error ? ' ERROR:' + s.error : ''}`) + '\n');
    if (i < samples - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  process.stdout.write('--- summary ---\n' + JSON.stringify(summarize(state), null, 2) + '\n');
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`candle-freshness error: ${String(e?.message ?? e)}\n`); process.exit(1); });
}
