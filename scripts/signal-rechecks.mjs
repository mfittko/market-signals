#!/usr/bin/env node
// signal_rechecks (issue #70): every operator-initiated re-check of the
// latest signal, persisted append-only. Feeds later evaluation ("how often
// does a re-check flip the original verdict, and was it right?"). NEVER
// mutates the signals/signal_snapshots rows a re-check reads — this table is
// the only place a re-check result is ever written.
import { withDb } from './supertrend.mjs';

const DDL = `CREATE TABLE IF NOT EXISTS signal_rechecks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_time TEXT NOT NULL,
  instrument TEXT NOT NULL,
  granularity TEXT NOT NULL,
  at TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('valid','played-out','invalidated')),
  reason TEXT,
  prompt_version TEXT
)`;

function rdb(dbPath, fn) {
  return withDb(dbPath, (db) => {
    db.exec(DDL);
    return fn(db);
  });
}

const RECHECK_VERDICTS = ['valid', 'played-out', 'invalidated'];

export function recordRecheck(dbPath, { signalTime, instrument, granularity, at, verdict, reason = null, promptVersion = null } = {}) {
  // guard the row shape here too, not only at the LLM-parse site: a null/empty
  // reason or unknown verdict must never reach signal_rechecks from any caller
  if (!RECHECK_VERDICTS.includes(verdict)) throw new Error(`recordRecheck: invalid verdict ${JSON.stringify(verdict)}`);
  const cleanReason = typeof reason === 'string' ? reason.trim() : '';
  if (!cleanReason) throw new Error('recordRecheck: reason is required');
  if (!signalTime || !instrument || !granularity || !at) throw new Error('recordRecheck: signalTime/instrument/granularity/at are required');
  return rdb(dbPath, (db) => {
    const id = db.prepare(`INSERT INTO signal_rechecks (signal_time, instrument, granularity, at, verdict, reason, prompt_version)
      VALUES (?,?,?,?,?,?,?)`)
      .run(signalTime, instrument, granularity, at, verdict, cleanReason, promptVersion == null ? null : String(promptVersion)).lastInsertRowid;
    return { id: Number(id), signalTime, instrument, granularity, at, verdict, reason: cleanReason, promptVersion };
  });
}

// The most recent re-check for one signal — a chart reload shows the last
// result under the verdict row without re-running the LLM.
export function latestRecheck(dbPath, instrument, granularity, signalTime) {
  return rdb(dbPath, (db) => db.prepare(
    `SELECT id, signal_time, instrument, granularity, at, verdict, reason, prompt_version FROM signal_rechecks
     WHERE instrument=? AND granularity=? AND signal_time=? ORDER BY id DESC LIMIT 1`)
    .get(instrument, granularity, signalTime) ?? null);
}
