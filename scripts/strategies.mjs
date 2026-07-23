#!/usr/bin/env node
// Strategy management (issue #25, epic #27): strategies are versioned
// prompt + declarative-spec records (#40 hybrid). Edits append versions —
// nothing is ever rewritten, so journal rows stay attributed to the exact
// text that produced them. Drafting is open (chat tool); ACTIVATION is a
// human act through the settings UI only.
import { withDb } from './supertrend.mjs';

const DDL = `CREATE TABLE IF NOT EXISTS strategies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  spec TEXT,
  instruments TEXT,
  created_by TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  UNIQUE (name, version)
)`;

export const SEED_STRATEGY = {
  name: 'conservative-supertrend',
  prompt: 'Follow supertrend flips on the watched combos, conservatively. Open only in the flip direction with a stop just beyond the supertrend line and notional within the risk budget. Skip mid-range entries: require the flip bar to break the recent range with volume above the 20-bar average. Respect the lock-in cooldown — never chase a flip older than 2 bars. Close on the opposite flip or at target. When any condition is unclear, hold.',
};

function sdb(dbPath, fn) {
  return withDb(dbPath, (db) => {
    db.exec(DDL);
    return fn(db);
  });
}

// Idempotent: ships the operator's seed rules once on an empty table.
export function ensureSeedStrategy(dbPath) {
  return sdb(dbPath, (db) => {
    // read-only fast path: the common case (table already seeded) must never
    // attempt a write lock — GET routes and the bot loop call this per run
    if (db.prepare('SELECT 1 FROM strategies LIMIT 1').get()) return null;
    // atomic ships-once: concurrent first-opens race the INSERT, and the
    // UNIQUE(name,version) + WHERE NOT EXISTS guard makes the loser a no-op
    // instead of a thrown constraint error (#45)
    const res = db.prepare(`INSERT INTO strategies (name, version, prompt, created_by, created_at)
      SELECT ?, 1, ?, 'seed', ?
      WHERE NOT EXISTS (SELECT 1 FROM strategies)`)
      .run(SEED_STRATEGY.name, SEED_STRATEGY.prompt, new Date().toISOString());
    return res.changes > 0 ? Number(res.lastInsertRowid) : null;
  });
}

// Draft-only writer (chat tool + manual): creates version 1 or appends the
// next version. NEVER touches the active flag.
export function saveStrategy(dbPath, { name, prompt, spec = null, instruments = null, createdBy = 'manual' } = {}) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(name)) {
    throw new Error('name must be kebab-case, 2-48 chars');
  }
  if (typeof prompt !== 'string' || prompt.trim().length < 20 || prompt.length > 4000) {
    throw new Error('prompt must be 20-4000 chars');
  }
  if (!['seed', 'chat', 'manual'].includes(createdBy)) throw new Error('createdBy must be seed|chat|manual');
  if (spec != null) {
    if (typeof spec !== 'object' || Array.isArray(spec)) throw new Error('spec must be a plain object when set');
    spec = JSON.stringify(spec);
  }
  if (instruments != null) {
    instruments = String(instruments).trim();
    if (!/^[A-Za-z0-9/|, ]{3,200}$/.test(instruments)) throw new Error('instruments must be a combo CSV');
  }
  return sdb(dbPath, (db) => {
    const last = db.prepare('SELECT version FROM strategies WHERE name=? ORDER BY version DESC LIMIT 1').get(name);
    const version = (last?.version ?? 0) + 1;
    const id = db.prepare(`INSERT INTO strategies (name, version, prompt, spec, instruments, created_by, created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(name, version, prompt.trim(), spec, instruments, createdBy, new Date().toISOString()).lastInsertRowid;
    return { id: Number(id), name, version };
  });
}

// Human-only activation (settings UI). Activates one exact version row and
// deactivates everything else in the same statement pair — exactly-one-active
// is enforced at write time.
export function activateStrategy(dbPath, id) {
  return sdb(dbPath, (db) => {
    const row = db.prepare('SELECT id, archived FROM strategies WHERE id=?').get(id);
    if (!row) throw new Error('unknown strategy');
    if (row.archived) throw new Error('cannot activate an archived strategy');
    // single statement re-checking archived under the write lock: a concurrent
    // archive between the read and this UPDATE can never activate the row
    db.prepare(`UPDATE strategies SET active = CASE WHEN id=? THEN 1 ELSE 0 END
      WHERE (active=1 OR id=?)
        AND EXISTS (SELECT 1 FROM strategies t WHERE t.id=? AND t.archived=0)`).run(id, id, id);
    // accurate post-write diagnosis (#45): unknown vs archived vs generic
    const after = db.prepare('SELECT active, archived FROM strategies WHERE id=?').get(id);
    if (!after) throw new Error('unknown strategy (removed concurrently)');
    if (!after.active) throw new Error(after.archived ? 'cannot activate an archived strategy' : 'activation failed (concurrent write)');
    return { id: Number(id) };
  });
}

// Deleting versions that decisions reference would orphan the audit trail —
// those are archived instead (hidden from selectors, kept for the journal).
export function archiveStrategy(dbPath, id) {
  return sdb(dbPath, (db) => {
    const row = db.prepare('SELECT id FROM strategies WHERE id=?').get(id);
    if (!row) throw new Error('unknown strategy');
    db.prepare('UPDATE strategies SET archived=1, active=0 WHERE id=?').run(id);
    return { id: Number(id), archived: true };
  });
}

export function deleteStrategy(dbPath, id) {
  return sdb(dbPath, (db) => {
    const referenced = db.prepare(
      "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='bot_journal'").get().c
      // exact JSON number token: id must be terminated by , or } so id=12 never
      // matches "strategyId":123
      ? db.prepare('SELECT COUNT(*) c FROM bot_journal WHERE context LIKE ? OR context LIKE ?')
        .get(`%"strategyId":${id},%`, `%"strategyId":${id}}%`).c
      : 0;
    if (referenced > 0) throw new Error('strategy has journal references — archive instead');
    const gone = db.prepare('DELETE FROM strategies WHERE id=?').run(id).changes;
    if (!gone) throw new Error('unknown strategy');
    return { id: Number(id), deleted: true };
  });
}

export function listStrategies(dbPath, { includeArchived = false } = {}) {
  return sdb(dbPath, (db) => db.prepare(
    `SELECT id, name, version, active, archived, created_by, created_at,
            substr(prompt, 1, 120) AS promptPreview, spec IS NOT NULL AS hasSpec, instruments
     FROM strategies ${includeArchived ? '' : 'WHERE archived=0'} ORDER BY name, version DESC`).all());
}

// Per-bot strategy binding (#49): bots reference strategies by id.
export function strategyById(dbPath, id) {
  return sdb(dbPath, (db) => db.prepare('SELECT * FROM strategies WHERE id=? AND archived=0').get(id) ?? null);
}

export function activeStrategy(dbPath) {
  return sdb(dbPath, (db) => db.prepare('SELECT * FROM strategies WHERE active=1 LIMIT 1').get() ?? null);
}

