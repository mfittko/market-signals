#!/usr/bin/env node
// Long-term trader memory (issue #44): durable, trader-scoped standing rules
// that ride along as advisory context in chat, the alert filter, and bot
// deliberation prompts. Chat-tool saves are the only model-initiated write
// path (source 'chat'); the settings UI writes 'manual'. Archiving hides a
// memory from context/listing but never deletes it — memory saves persist.
import { withDb } from './supertrend.mjs';

const DDL = `CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 3,
  source TEXT NOT NULL DEFAULT 'chat',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
)`;

function mdb(dbPath, fn) {
  return withDb(dbPath, (db) => {
    db.exec(DDL);
    return fn(db);
  });
}

// Trim + collapse all internal whitespace runs (including newlines) to a
// single space, so stored content is always one line — memoriesContext()'s
// one-bullet-per-line format and budget math depend on this.
function normalizeContent(content) {
  return typeof content === 'string' ? content.trim().replace(/\s+/g, ' ') : content;
}

function checkContent(normalized) {
  if (typeof normalized !== 'string' || normalized.length < 1 || normalized.length > 500) {
    throw new Error('content must be 1-500 chars');
  }
}

function checkWeight(weight) {
  if (!Number.isInteger(weight) || weight < 1 || weight > 5) throw new Error('weight must be an integer 1-5');
}

export function saveMemory(dbPath, { content, weight = 3, source = 'chat' } = {}) {
  const normalized = normalizeContent(content);
  checkContent(normalized);
  checkWeight(weight);
  if (!['chat', 'manual'].includes(source)) throw new Error('source must be chat|manual');
  return mdb(dbPath, (db) => {
    const now = new Date().toISOString();
    const id = db.prepare(`INSERT INTO memories (content, weight, source, created_at, updated_at)
      VALUES (?,?,?,?,?)`).run(normalized, weight, source, now, now).lastInsertRowid;
    return { id: Number(id), content: normalized, weight, source };
  });
}

export function listMemories(dbPath, { includeArchived = false } = {}) {
  return mdb(dbPath, (db) => db.prepare(
    `SELECT id, content, weight, source, created_at, updated_at, archived FROM memories
     ${includeArchived ? '' : 'WHERE archived=0'} ORDER BY weight DESC, updated_at DESC`).all());
}

export function reweightMemory(dbPath, id, weight) {
  checkWeight(weight);
  return mdb(dbPath, (db) => {
    const row = db.prepare('SELECT id FROM memories WHERE id=?').get(id);
    if (!row) throw new Error('unknown memory');
    db.prepare('UPDATE memories SET weight=?, updated_at=? WHERE id=?').run(weight, new Date().toISOString(), id);
    return { id: Number(id), weight };
  });
}

export function editMemory(dbPath, id, content) {
  const normalized = normalizeContent(content);
  checkContent(normalized);
  return mdb(dbPath, (db) => {
    const row = db.prepare('SELECT id FROM memories WHERE id=?').get(id);
    if (!row) throw new Error('unknown memory');
    db.prepare('UPDATE memories SET content=?, updated_at=? WHERE id=?').run(normalized, new Date().toISOString(), id);
    return { id: Number(id), content: normalized };
  });
}

// No hard delete: archiving hides a memory from listing/context but keeps
// the row (audit trail, same convention as archiveStrategy).
export function archiveMemory(dbPath, id) {
  return mdb(dbPath, (db) => {
    const row = db.prepare('SELECT id FROM memories WHERE id=?').get(id);
    if (!row) throw new Error('unknown memory');
    db.prepare('UPDATE memories SET archived=1, updated_at=? WHERE id=?').run(new Date().toISOString(), id);
    return { id: Number(id), archived: true };
  });
}

// Advisory context block for prompts: top-weighted active memories, one per
// line, cut BEFORE the entry that would exceed the char budget — the
// highest-weight memories win spots in order until the budget runs out (an
// entry that would overflow the budget is dropped, even the first — unreachable
// at the default 1200 budget since content caps at 500). Empty table → null (callers
// emit no block at all).
export function memoriesContext(dbPath, budget = 1200) {
  return mdb(dbPath, (db) => {
    const rows = db.prepare('SELECT content, weight FROM memories WHERE archived=0 ORDER BY weight DESC, updated_at DESC').all();
    const lines = [];
    let total = 0;
    for (const r of rows) {
      const line = `- [w${r.weight}] ${r.content}`;
      const next = total + (lines.length ? 1 : 0) + line.length; // +1 accounts for the joining newline
      if (next > budget) break;
      lines.push(line);
      total = next;
    }
    return lines.length ? lines.join('\n') : null;
  });
}
