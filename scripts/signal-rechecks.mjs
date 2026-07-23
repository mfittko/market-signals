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

export function recordRecheck(dbPath, { signalTime, instrument, granularity, at, verdict, reason = null, promptVersion = null } = {}) {
  return rdb(dbPath, (db) => {
    const id = db.prepare(`INSERT INTO signal_rechecks (signal_time, instrument, granularity, at, verdict, reason, prompt_version)
      VALUES (?,?,?,?,?,?,?)`)
      .run(signalTime, instrument, granularity, at, verdict, reason, promptVersion == null ? null : String(promptVersion)).lastInsertRowid;
    return { id: Number(id), signalTime, instrument, granularity, at, verdict, reason, promptVersion };
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
