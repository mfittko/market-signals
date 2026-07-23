#!/usr/bin/env node
// Deterministic spec-replay backtest (issue #40, epic #27). The inner loop is
// PURE: recorded snapshots + stored candles + a validated spec → the same
// report every run (hash-checked in CI). No LLM calls in here — judge layers
// live in judge.mjs, strictly outer-loop and opt-in.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { withDb } from './supertrend.mjs';
import { atr } from './indicators.mjs';
import { validateSpec, entryDecision, EXAMPLE_SPECS, SPEC_SCHEMA_VERSION } from './strategy-spec.mjs';

const round = (v, p = 4) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** p) / 10 ** p);

export function loadReplayData(dbPath, instrument, granularity) {
  return withDb(dbPath, (db) => {
    const read = (sql, args) => { try { return db.prepare(sql).all(...args); } catch (err) { if (/no such table/i.test(String(err.message))) return []; throw err; } };
    const snapshots = read('SELECT time, snapshot, context FROM signal_snapshots WHERE instrument=? AND granularity=? ORDER BY time', [instrument, granularity])
      .map((r) => { try { return { time: r.time, snapshot: JSON.parse(r.snapshot), context: r.context ? JSON.parse(r.context) : null }; } catch { return null; } })
      .filter(Boolean);
    const candles = read('SELECT time, open, high, low, close, volume, 1 AS complete FROM candles WHERE instrument=? AND granularity=? ORDER BY time', [instrument, granularity]);
    return { snapshots, candles };
  });
}

// Simulate one trade from entry at the flip-bar close, walking forward bars:
// gap-aware stop/target fills (same ordering semantics as the live bot) plus
// an optional time-stop at the close of bar N.
function simulateTrade(candles, entryIdx, dir, spec, atrSeries) {
  const entryPrice = candles[entryIdx].close;
  const atrNow = atrSeries[entryIdx];
  if (!(atrNow > 0)) return null;
  const stop = entryPrice - dir * spec.exit.stopAtr * atrNow;
  const target = spec.exit.targetAtr != null ? entryPrice + dir * spec.exit.targetAtr * atrNow : null;
  const maxBars = spec.exit.timeStopBars ?? 72;
  for (let i = entryIdx + 1; i < Math.min(candles.length, entryIdx + 1 + maxBars); i++) {
    const c = candles[i];
    const gapStop = dir === 1 ? c.open <= stop : c.open >= stop;
    const gapTarget = target != null && (dir === 1 ? c.open >= target : c.open <= target);
    if (gapStop) return { exitIdx: i, exitPrice: c.open, reason: 'stop' };
    if (gapTarget) return { exitIdx: i, exitPrice: c.open, reason: 'target' };
    const hitStop = dir === 1 ? c.low <= stop : c.high >= stop;
    const hitTarget = target != null && (dir === 1 ? c.high >= target : c.low <= target);
    if (hitStop) return { exitIdx: i, exitPrice: stop, reason: 'stop' }; // pessimistic on both-touched
    if (hitTarget) return { exitIdx: i, exitPrice: target, reason: 'target' };
  }
  const lastIdx = Math.min(candles.length - 1, entryIdx + maxBars);
  if (lastIdx <= entryIdx) return null;
  return { exitIdx: lastIdx, exitPrice: candles[lastIdx].close, reason: 'time-stop' };
}

// Pure replay of one spec over one window. Returns the mechanical report.
export function replaySpec(spec, snapshots, candles) {
  const validation = validateSpec(spec);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const idxByTime = new Map(candles.map((c, i) => [c.time, i]));
  const atrSeries = atr(candles, 14);
  const trades = [];
  const vetoes = {};
  let openUntil = -1;
  for (const s of snapshots) {
    const entryIdx = idxByTime.get(s.time);
    if (entryIdx == null || entryIdx <= openUntil) continue; // one position at a time
    const decision = entryDecision(spec, s.snapshot);
    if (!decision.enter) {
      if (decision.vetoedBy) vetoes[decision.vetoedBy] = (vetoes[decision.vetoedBy] || 0) + 1;
      continue;
    }
    const dir = s.snapshot.flip === 'buy' ? 1 : -1;
    const fill = simulateTrade(candles, entryIdx, dir, spec, atrSeries);
    if (!fill) continue;
    const retPct = (dir * (fill.exitPrice - candles[entryIdx].close) / candles[entryIdx].close) * 100;
    trades.push({ entryTime: s.time, exitTime: candles[fill.exitIdx].time, dir, retPct: round(retPct), reason: fill.reason, bars: fill.exitIdx - entryIdx });
    openUntil = fill.exitIdx;
  }
  const rets = trades.map((t) => t.retPct);
  const wins = rets.filter((r) => r > 0);
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  for (const r of rets) { equity += r; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak - equity); }
  const exposureBars = trades.reduce((a, t) => a + t.bars, 0);
  return {
    ok: true,
    schema_version: SPEC_SCHEMA_VERSION,
    trades,
    metrics: {
      signals: snapshots.length,
      entered: trades.length,
      winRatePct: rets.length ? round((wins.length / rets.length) * 100, 1) : null,
      expectancyPct: rets.length ? round(rets.reduce((a, b) => a + b, 0) / rets.length) : null,
      totalReturnPct: round(rets.reduce((a, b) => a + b, 0)),
      maxDrawdownPct: round(maxDD),
      exposurePct: candles.length ? round((exposureBars / candles.length) * 100, 1) : null,
    },
    vetoAttribution: vetoes,
  };
}

// Canonical stable stringify (sorted keys) so the report hash is reproducible.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const reportHash = (report) => createHash('sha256').update(canonical(report)).digest('hex').slice(0, 16);

// Walk-forward: evaluate candidates on the train window, promote mechanically
// on validation-window thresholds (never a judge). candidatesTried is always
// reported (overfitting guard, decision 6).
export function walkForward(specs, snapshots, candles, { trainPct = 0.6, minValidationTrades = 3, minValidationExpectancy = 0 } = {}) {
  const splitIdx = Math.floor(candles.length * trainPct);
  const splitTime = candles[Math.max(0, splitIdx - 1)]?.time ?? null;
  const trainCandles = candles.slice(0, splitIdx);
  const validationCandles = candles.slice(Math.max(0, splitIdx - 20)); // warm-up overlap for ATR only
  const trainSnaps = snapshots.filter((s) => s.time <= splitTime);
  const validationSnaps = snapshots.filter((s) => s.time > splitTime);
  const results = [];
  for (const [name, spec] of Object.entries(specs)) {
    const train = replaySpec(spec, trainSnaps, trainCandles);
    const validation = replaySpec(spec, validationSnaps, validationCandles);
    if (!train.ok || !validation.ok) { results.push({ name, ok: false, errors: train.errors ?? validation.errors }); continue; }
    const promoted = validation.metrics.entered >= minValidationTrades && (validation.metrics.expectancyPct ?? -1) > minValidationExpectancy;
    results.push({ name, ok: true, train: train.metrics, validation: validation.metrics, vetoAttribution: validation.vetoAttribution, promoted });
  }
  return {
    schema_version: SPEC_SCHEMA_VERSION,
    split: { trainPct, splitTime, trainCandles: trainCandles.length, validationCandles: validationCandles.length },
    candidatesTried: Object.keys(specs).length,
    results,
    promotionGate: { minValidationTrades, minValidationExpectancy, mechanical: true },
  };
}

const USAGE = `spec-backtest — deterministic replay of strategy specs over recorded axis snapshots.
  --db <path>            (default: data/candles.db)
  --instrument <sym>     (default: WTICO/USD)
  --granularity <g>      (default: M5)
  --spec <path|example>  spec JSON file, or an example name (${Object.keys(EXAMPLE_SPECS).join(', ')}); repeatable via CSV
  --train-pct <0..1>     walk-forward split (default 0.6)
  --judge <mode>         off|meta|per-signal (default off; judge layers are outer-loop only)
  --out <path>           report artifact (default: reports/backtests/<instrument>-<granularity>.json)
  --json                 emit the report to stdout
  -h, --help
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) return process.stdout.write(USAGE);
  const get = (flag, dflt) => { const i = argv.indexOf(`--${flag}`); return i >= 0 ? argv[i + 1] : dflt; };
  const dbPath = get('db', 'data/candles.db');
  const instrument = get('instrument', 'WTICO/USD');
  const granularity = get('granularity', 'M5');
  const judge = get('judge', 'off');
  const trainPct = Number(get('train-pct', '0.6'));
  const specArg = get('spec', Object.keys(EXAMPLE_SPECS).join(','));
  const specs = {};
  for (const nameOrPath of specArg.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (EXAMPLE_SPECS[nameOrPath]) specs[nameOrPath] = EXAMPLE_SPECS[nameOrPath];
    else specs[nameOrPath.replace(/[^a-z0-9-]/gi, '_')] = JSON.parse(readFileSync(nameOrPath, 'utf8'));
  }
  const { snapshots, candles } = loadReplayData(dbPath, instrument, granularity);
  const report = walkForward(specs, snapshots, candles, { trainPct });
  report.hash = reportHash(report);
  report.window = { instrument, granularity, snapshots: snapshots.length, candles: candles.length };

  if (judge !== 'off') {
    const { runJudge } = await import('./judge.mjs');
    report.judge = await runJudge(judge, report, { dbPath, instrument, granularity, snapshots });
  }

  const out = get('out', `reports/backtests/${instrument.replace(/\W+/g, '-')}-${granularity}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(report)}\n`);
  else process.stdout.write(`report written to ${out} (hash ${report.hash})\n`);
}

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`spec-backtest error: ${err.message}\n`);
    process.exitCode = 1;
  });
}

