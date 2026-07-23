#!/usr/bin/env node
// Gate-prompt overrides (issue #58): a minimal sibling to strategies.mjs for
// LLM gates OTHER than the bot (which stays strategy-owned). v1 covers only
// the 'filter' gate — chat drafts revisions (createdBy 'chat'), stored
// INACTIVE; ACTIVATION is a human act in the settings gates section, same
// lifecycle strategies already established. The shipped FILTER_SYSTEM
// constant is the fallback whenever no row is active.
import { withDb } from './supertrend.mjs';

const GATES = ['filter'];

const DDL = `CREATE TABLE IF NOT EXISTS gate_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gate TEXT NOT NULL CHECK (gate IN ('filter')),
  version INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  UNIQUE (gate, version)
)`;

function gdb(dbPath, fn) {
  return withDb(dbPath, (db) => {
    db.exec(DDL);
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
