#!/usr/bin/env node
// Gate-prompt overrides (issue #58): a minimal sibling to strategies.mjs for
// LLM gates OTHER than the bot (which stays strategy-owned). Covers the
// 'filter' and 'recheck' (#70) gates — chat drafts revisions (createdBy
// 'chat'), stored INACTIVE; ACTIVATION is a human act in the settings gates
// section, same lifecycle strategies already established. The shipped
// FILTER_SYSTEM/RECHECK_SYSTEM constants are the fallback whenever no row is active.
import { withDb } from './supertrend.mjs';

export const GATES = ['filter', 'recheck'];

const DDL = `CREATE TABLE IF NOT EXISTS gate_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gate TEXT NOT NULL CHECK (gate IN ('filter','recheck')),
  version INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  UNIQUE (gate, version)
)`;

// SQLite CHECK constraints can't be ALTERed in place: a db created before
// #70 has gate_prompts locked to CHECK (gate IN ('filter')), which would
// reject every 'recheck' draft. Guarded one-time rebuild (rename, recreate
// with the current DDL, copy rows, drop) — a no-op once migrated, since the
// stored CREATE TABLE sql then already contains 'recheck'.
// exported for the transactional-rollback test only (forces a mid-rebuild
// failure via a monkeypatched db.exec)
export function migrateCheckConstraint(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='gate_prompts'").get();
  if (row?.sql && !row.sql.includes("'recheck'")) {
    // Transactional (SQLite DDL is transactional): a crash mid-rebuild must
    // never leave gate_prompts_pre70 lingering (the guard above would then
    // see the ALREADY-RENAMED table as "no gate_prompts", not a migrated one).
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('ALTER TABLE gate_prompts RENAME TO gate_prompts_pre70');
      db.exec(DDL);
      db.exec('INSERT INTO gate_prompts SELECT * FROM gate_prompts_pre70');
      db.exec('DROP TABLE gate_prompts_pre70');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function gdb(dbPath, fn) {
  return withDb(dbPath, (db) => {
    db.exec(DDL);
    migrateCheckConstraint(db);
    return fn(db);
  });
}

// Draft-only writer (chat tool + settings UI): appends the next version for
// the gate. NEVER touches the active flag — activation is a separate, human-only act.
export function saveGatePrompt(dbPath, { gate, prompt, createdBy = 'manual' } = {}) {
  if (!GATES.includes(gate)) throw new Error(`gate must be one of: ${GATES.join(', ')}`);
  const trimmed = typeof prompt === 'string' ? prompt.trim() : '';
  if (!trimmed || trimmed.length > 4000) throw new Error('prompt must be 1-4000 chars');
  if (!['chat', 'manual'].includes(createdBy)) throw new Error('createdBy must be chat|manual');
  return gdb(dbPath, (db) => {
    const last = db.prepare('SELECT version FROM gate_prompts WHERE gate=? ORDER BY version DESC LIMIT 1').get(gate);
    const version = (last?.version ?? 0) + 1;
    const id = db.prepare(`INSERT INTO gate_prompts (gate, version, prompt, created_by, created_at)
      VALUES (?,?,?,?,?)`)
      .run(gate, version, trimmed, createdBy, new Date().toISOString()).lastInsertRowid;
    return { id: Number(id), gate, version };
  });
}

export function listGatePrompts(dbPath, { gate = null } = {}) {
  if (gate !== null && !GATES.includes(gate)) throw new Error(`gate must be one of: ${GATES.join(', ')}`);
  return gdb(dbPath, (db) => db.prepare(
    `SELECT id, gate, version, prompt, created_by, created_at, active FROM gate_prompts
     ${gate ? 'WHERE gate=?' : ''} ORDER BY gate, version DESC`).all(...(gate ? [gate] : [])));
}

// Human-only activation (settings UI). Activates one exact version row and
// deactivates every other row for the SAME gate in the same statement —
// exactly-one-active-per-gate is enforced at write time.
export function activateGatePrompt(dbPath, id) {
  return gdb(dbPath, (db) => {
    const row = db.prepare('SELECT id, gate FROM gate_prompts WHERE id=?').get(id);
    if (!row) throw new Error('unknown gate prompt');
    db.prepare(`UPDATE gate_prompts SET active = CASE WHEN id=? THEN 1 ELSE 0 END
      WHERE gate = (SELECT gate FROM gate_prompts WHERE id=?)`).run(id, id);
    return { id: Number(id), gate: row.gate };
  });
}

export function deactivateGatePrompt(dbPath, id) {
  return gdb(dbPath, (db) => {
    const row = db.prepare('SELECT id FROM gate_prompts WHERE id=?').get(id);
    if (!row) throw new Error('unknown gate prompt');
    db.prepare('UPDATE gate_prompts SET active=0 WHERE id=?').run(id);
    return { id: Number(id), active: false };
  });
}

export function activeGatePrompt(dbPath, gate) {
  if (!GATES.includes(gate)) throw new Error(`gate must be one of: ${GATES.join(', ')}`);
  return gdb(dbPath, (db) => db.prepare('SELECT * FROM gate_prompts WHERE gate=? AND active=1 LIMIT 1').get(gate) ?? null);
}
