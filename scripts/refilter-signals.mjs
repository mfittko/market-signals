#!/usr/bin/env node
/**
 * refilter-signals (issue #102) — re-runs the filter LLM verdict, in place,
 * for signals whose recorded verdict was a fail-open filter error (from an
 * LLM outage — e.g. #98's null-content bug, now fixed). The live watcher
 * never re-filters a flip it already recorded (dedup on flip time), so a
 * backfill needs an explicit maintenance pass.
 *
 * Reconstruction is candles-table-only (never a live fetch): the candles up
 * to and including the signal's own time are read back, then
 * computeSupertrend + detectFlips + backtestFlips (the same exported
 * functions the live watcher uses) rebuild the flip/backtest context as of
 * that moment. If the tail of that window doesn't reproduce the stored flip
 * (signal direction + price), the row is SKIPPED and logged — never
 * fabricated.
 *
 * The filter is an advisory attention gate over live state, not a
 * point-in-time replay: traderMemories/sentinel/notes/pastSignals30mOutcomes
 * reflect CURRENT state (same as a live filter call), not what they were at
 * the original signal's time. Only the flip/backtest/candle context is
 * reconstructed historically.
 *
 * Usage:
 *   node scripts/refilter-signals.mjs [--db data/candles.db]
 *     [--predicate errored] [--since <ISO>] [--instrument <sym>]
 *     [--granularity <g>] [--limit <n>] [--dry-run] [--json]
 *     [--settings data/settings.json]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  withDb, computeSupertrend, detectFlips, backtestFlips, signalOutcomes,
  buildFilterPayload, llmVerdict, resolveFilterSystem, readSettings, applyProviderDefault,
} from './supertrend.mjs';

const dbg = (msg) => process.stderr.write(`[refilter-signals] ${msg}\n`);

// Matches fetchCandles' own default --count: enough history for the ATR
// warmup plus a meaningful backtest window, without scanning the whole table.
const RECONSTRUCT_CANDLE_COUNT = 500;

// Only 'errored' is defined today — the exact predicate the issue backfill
// needs. A named registry (not a raw --where flag) keeps arbitrary SQL out of
// operator hands.
const PREDICATES = { errored: "reason LIKE '%filter error%'" };

// Rebuilds { sig, result, candles } from the candles table alone, as of the
// signal's own time — never a live fetch. Returns null (reconstruction
// failed) rather than ever fabricating a flip.
function reconstructSignal(db, row) {
  const rows = db.prepare('SELECT * FROM candles WHERE instrument=? AND granularity=? AND time <= ? ORDER BY time DESC LIMIT ?')
    .all(row.instrument, row.granularity, row.time, RECONSTRUCT_CANDLE_COUNT).reverse();
  if (!rows.length || rows[rows.length - 1].time !== row.time) return null; // no candle at the signal's own time
  let st;
  try { st = computeSupertrend(rows); } catch { return null; } // not enough history for the ATR warmup
  const flips = detectFlips(rows, st);
  const lastFlip = flips[flips.length - 1];
  // the reconstructed window must flip on its OWN tail candle, matching the
  // stored signal's direction and price — anything else is not reconstructable
  if (!lastFlip || lastFlip.index !== rows.length - 1) return null;
  if (lastFlip.signal !== row.signal) return null;
  if (row.price != null && Math.abs(lastFlip.price - row.price) > 1e-6) return null;
  const backtest = backtestFlips(rows, flips);
  const lastSt = st[st.length - 1];
  const sig = { ...lastFlip, barsAgo: 0, fresh: true };
  const result = {
    close: rows[rows.length - 1].close,
    trend: lastSt.trend,
    supertrend: Number(lastSt.supertrend.toFixed(4)),
    backtest,
  };
  return { sig, result, candles: rows };
}

// Same axis-snapshot call processSignal makes, judged on the flip bar itself
// (mirrors #32's signal-time-truth rule) — best-effort, never blocks a re-filter.
async function gateSnapshotFor(sig, candles, instrument, granularity) {
  try {
    const { axisSnapshot } = await import('./axis-snapshot.mjs');
    const flipCandles = Number.isInteger(sig.index) ? candles.slice(0, sig.index + 1) : candles;
    return axisSnapshot(flipCandles, { instrument, granularity, flip: { signal: sig.signal } });
  } catch (err) {
    dbg(`axis snapshot failed: ${err.message}`);
    return null;
  }
}

// Core, testable entry point: selects matching signals and re-filters each,
// one provider call per signal, per-signal try/catch so one failure never
// aborts the batch. Returns a summary; never throws for a single bad row.
export async function runRefilter(dbPath, settings, {
  predicate = 'errored', since = null, instrument = null, granularity = null,
  limit = null, dryRun = false, log = dbg,
} = {}) {
  const where = PREDICATES[predicate];
  if (!where) throw new Error(`unknown --predicate "${predicate}" (supported: ${Object.keys(PREDICATES).join(', ')})`);

  const rows = withDb(dbPath, (db) => {
    let sql = `SELECT * FROM signals WHERE ${where}`;
    const params = [];
    if (since) { sql += ' AND time >= ?'; params.push(since); }
    if (instrument) { sql += ' AND instrument = ?'; params.push(instrument); }
    if (granularity) { sql += ' AND granularity = ?'; params.push(granularity); }
    sql += ' ORDER BY time ASC';
    if (limit) { sql += ' LIMIT ?'; params.push(limit); }
    return db.prepare(sql).all(...params);
  });

  const filterSystem = await resolveFilterSystem(dbPath);
  let notes = '';
  try { notes = readFileSync(settings.notesFile || 'data/notes.md', 'utf8').slice(-1500); } catch { /* optional */ }

  const updated = [];
  const skipped = [];
  const errored = [];

  for (const row of rows) {
    try {
      const recon = withDb(dbPath, (db) => reconstructSignal(db, row));
      if (!recon) {
        skipped.push({ instrument: row.instrument, granularity: row.granularity, time: row.time, reason: 'not reconstructable from stored candles' });
        log(`skip ${row.instrument} ${row.granularity} ${row.time}: not reconstructable from stored candles`);
        continue;
      }
      const { sig, result, candles } = recon;
      const gateSnapshot = await gateSnapshotFor(sig, candles, row.instrument, row.granularity);
      const history = signalOutcomes(dbPath, row.instrument, row.granularity).filter((s) => s.time !== row.time);
      const payload = await buildFilterPayload({
        dbPath, instrument: row.instrument, granularity: row.granularity,
        sig, result, candles, history, gateSnapshot, notes,
      });
      const verdict = await llmVerdict(settings, payload, filterSystem.system, null);
      const verdictLabel = verdict.alert === false ? 'suppress' : 'alert';
      if (!dryRun) {
        withDb(dbPath, (db) => db.prepare('UPDATE signals SET verdict=?, reason=? WHERE instrument=? AND granularity=? AND time=?')
          .run(verdictLabel, verdict.reason ?? null, row.instrument, row.granularity, row.time));
      }
      updated.push({ instrument: row.instrument, granularity: row.granularity, time: row.time, from: { verdict: row.verdict, reason: row.reason }, to: { verdict: verdictLabel, reason: verdict.reason ?? null } });
      log(`${dryRun ? '[dry-run] would update' : 'updated'} ${row.instrument} ${row.granularity} ${row.time}: ${row.verdict}/${row.reason} -> ${verdictLabel}/${verdict.reason}`);
    } catch (err) {
      // a re-filter that itself errors must never overwrite the row (fail-open
      // for the row's persisted state, not the batch) — left as-is, logged.
      errored.push({ instrument: row.instrument, granularity: row.granularity, time: row.time, error: err.message });
      log(`re-filter error for ${row.instrument} ${row.granularity} ${row.time}: ${err.message} (row left unchanged)`);
    }
  }

  return { scanned: rows.length, updated, skipped, errored, dryRun };
}

// --- CLI -----------------------------------------------------------------
const USAGE = `refilter-signals — re-run the filter LLM verdict, in place, for signals matching a predicate (default: recorded filter errors).

Options:
  --db <path>           sqlite file (default: data/candles.db)
  --settings <path>     LLM provider settings (default: data/settings.json)
  --predicate <name>    which signals to select (default: errored -> reason LIKE '%filter error%')
  --since <ISO>         only signals at/after this time
  --instrument <sym>    only this instrument
  --granularity <g>     only this granularity
  --limit <n>           cap the number of signals processed
  --dry-run             compute verdicts but write nothing
  --json                print the summary as JSON instead of human-readable lines
  -h, --help            show this help (no db access)
`;

const BOOLEAN_FLAGS = new Set(['help', 'dry-run', 'json']);

export function parseArgs(argv) {
  const out = {
    db: 'data/candles.db', settings: 'data/settings.json', predicate: 'errored',
    since: null, instrument: null, granularity: null, limit: null, dryRun: false, json: false,
  };
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('-')) continue;
    if (token === '-h') continue; // alias for --help, handled at the CLI entrypoint
    if (!token.startsWith('--')) { unknown.push(token); continue; }
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      if (key === 'dry-run') out.dryRun = true;
      else if (key === 'json') out.json = true;
      continue;
    }
    const next = argv[i + 1];
    const nextIsFlag = next !== undefined && next.startsWith('-') && !/^-\d/.test(next);
    const hasValue = next !== undefined && !nextIsFlag;
    const val = hasValue ? next : null;
    if (hasValue) i++;

    if (key === 'db' && val) out.db = val;
    else if (key === 'settings' && val) out.settings = val;
    else if (key === 'predicate' && val) out.predicate = val;
    else if (key === 'since' && val) out.since = val;
    else if (key === 'instrument' && val) out.instrument = val;
    else if (key === 'granularity' && val) out.granularity = val;
    else if (key === 'limit' && val) out.limit = Number(val);
    else unknown.push(`--${key}`);
  }
  if (unknown.length) throw new Error(`unknown flag(s): ${unknown.join(', ')} (run --help)`);
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const args = parseArgs(argv);
  const settings = applyProviderDefault(readSettings(args.settings));
  const summary = await runRefilter(args.db, settings, {
    predicate: args.predicate, since: args.since, instrument: args.instrument,
    granularity: args.granularity, limit: args.limit, dryRun: args.dryRun,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`scanned ${summary.scanned}, updated ${summary.updated.length}, skipped ${summary.skipped.length}, errored ${summary.errored.length}${summary.dryRun ? ' (dry-run: nothing written)' : ''}\n`);
    for (const u of summary.updated) process.stdout.write(`  ${u.instrument} ${u.granularity} ${u.time}: ${u.from.verdict}/${u.from.reason} -> ${u.to.verdict}/${u.to.reason}\n`);
    for (const s of summary.skipped) process.stdout.write(`  SKIP ${s.instrument} ${s.granularity} ${s.time}: ${s.reason}\n`);
    for (const e of summary.errored) process.stdout.write(`  ERROR ${e.instrument} ${e.granularity} ${e.time}: ${e.error}\n`);
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`refilter-signals error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
