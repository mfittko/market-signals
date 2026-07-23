import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveGatePrompt, listGatePrompts, activateGatePrompt, deactivateGatePrompt, activeGatePrompt,
} from '../scripts/gate-prompts.mjs';
import { withDb } from '../scripts/supertrend.mjs';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'gate-')), 'g.sqlite');
const RULES = 'Suppress chop harder: require two confirming bars, not one, before any alert fires.';

test('saveGatePrompt validates gate/prompt/createdBy; version auto-increments per gate; stored INACTIVE', () => {
  const db = fresh();
  const v1 = saveGatePrompt(db, { gate: 'filter', prompt: RULES });
  assert.deepEqual([v1.gate, v1.version], ['filter', 1]);
  const v2 = saveGatePrompt(db, { gate: 'filter', prompt: `${RULES} Tighter still.`, createdBy: 'chat' });
  assert.equal(v2.version, 2);
  const rows = listGatePrompts(db, { gate: 'filter' });
  assert.equal(rows.length, 2, 'both versions listed');
  assert.equal(rows[0].version, 2, 'newest first');
  assert.equal(rows.every((r) => r.active === 0), true, 'drafts never ship active');
  assert.throws(() => saveGatePrompt(db, { gate: 'bot', prompt: RULES }), /gate must be one of/, 'the bot prompt is strategy-owned, never a gate_prompts override');
  assert.throws(() => saveGatePrompt(db, { gate: 'filter', prompt: '' }), /1-4000/);
  assert.throws(() => saveGatePrompt(db, { gate: 'filter', prompt: '   ' }), /1-4000/, 'whitespace-only rejected');
  assert.throws(() => saveGatePrompt(db, { gate: 'filter', prompt: 'x'.repeat(4001) }), /1-4000/);
  assert.throws(() => saveGatePrompt(db, { gate: 'filter', prompt: RULES, createdBy: 'robot' }), /chat\|manual/);
});

test('activateGatePrompt: exactly-one-active PER GATE enforced atomically; unknown id throws', () => {
  const db = fresh();
  const a = saveGatePrompt(db, { gate: 'filter', prompt: RULES });
  const b = saveGatePrompt(db, { gate: 'filter', prompt: `${RULES} v2.` });
  activateGatePrompt(db, a.id);
  activateGatePrompt(db, b.id);
  const active = listGatePrompts(db, { gate: 'filter' }).filter((r) => r.active);
  assert.equal(active.length, 1, 'exactly one active for the gate');
  assert.equal(active[0].id, b.id);
  assert.equal(activeGatePrompt(db, 'filter').id, b.id);
  assert.throws(() => activateGatePrompt(db, 999), /unknown gate prompt/);
});

test('deactivateGatePrompt clears the flag without activating another row; activeGatePrompt falls back to null (builtin)', () => {
  const db = fresh();
  assert.equal(activeGatePrompt(db, 'filter'), null, 'no rows yet: fallback to the shipped constant');
  const a = saveGatePrompt(db, { gate: 'filter', prompt: RULES });
  activateGatePrompt(db, a.id);
  assert.equal(activeGatePrompt(db, 'filter').id, a.id);
  deactivateGatePrompt(db, a.id);
  assert.equal(activeGatePrompt(db, 'filter'), null, 'deactivated: fallback to the shipped constant again');
  assert.throws(() => deactivateGatePrompt(db, 999), /unknown gate prompt/);
});

test('listGatePrompts without a gate filter lists everything, newest version first per gate', () => {
  const db = fresh();
  saveGatePrompt(db, { gate: 'filter', prompt: RULES });
  saveGatePrompt(db, { gate: 'filter', prompt: `${RULES} v2.` });
  const all = listGatePrompts(db);
  assert.equal(all.length, 2);
  assert.equal(all[0].version, 2);
});

test('listGatePrompts and activeGatePrompt reject unknown gates, same as saveGatePrompt', () => {
  const db = fresh();
  assert.throws(() => listGatePrompts(db, { gate: 'bot' }), /gate must be one of/);
  assert.throws(() => activeGatePrompt(db, 'bot'), /gate must be one of/);
  assert.equal(listGatePrompts(db).length, 0, 'no gate filter still lists everything (none yet)');
});

test('recheck (#70) is a full second gate: draft/activate/deactivate, independent versioning from filter', () => {
  const db = fresh();
  const RECHECK_RULES = 'Weigh the realized excursion heavily: a move that already ran 2x its typical range is played-out, not valid.';
  const rv1 = saveGatePrompt(db, { gate: 'recheck', prompt: RECHECK_RULES });
  assert.deepEqual([rv1.gate, rv1.version], ['recheck', 1]);
  activateGatePrompt(db, rv1.id);
  assert.equal(activeGatePrompt(db, 'recheck').id, rv1.id);
  assert.equal(activeGatePrompt(db, 'filter'), null, 'activating a recheck draft never touches the filter gate');
  // independent per-gate versioning: a fresh filter draft starts at v1 too
  const fv1 = saveGatePrompt(db, { gate: 'filter', prompt: RULES });
  assert.equal(fv1.version, 1, 'filter and recheck version sequences are independent');
  const all = listGatePrompts(db);
  assert.deepEqual(all.map((r) => r.gate).sort(), ['filter', 'recheck']);
});

test('gate_prompts CHECK-constraint migration (#70): a pre-#70 db (CHECK gate IN (\'filter\')) upgrades transparently, existing rows preserved', () => {
  const dbPath = fresh();
  // Simulate a db created before #70 shipped: the old, narrower CHECK constraint.
  withDb(dbPath, (db) => {
    db.exec(`CREATE TABLE gate_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gate TEXT NOT NULL CHECK (gate IN ('filter')),
      version INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      UNIQUE (gate, version)
    )`);
    db.prepare(`INSERT INTO gate_prompts (gate, version, prompt, created_by, created_at, active)
      VALUES ('filter', 1, ?, 'manual', '2020-01-01T00:00:00Z', 1)`).run(RULES);
  });
  // Inserting a 'recheck' draft would violate the old CHECK — the guarded
  // rebuild in saveGatePrompt must have already widened it by the time this runs.
  const draft = saveGatePrompt(dbPath, { gate: 'recheck', prompt: 'post-migration recheck rules' });
  assert.equal(draft.gate, 'recheck');
  const rows = listGatePrompts(dbPath);
  assert.equal(rows.length, 2, 'the pre-existing filter row survived the rebuild');
  const preexisting = rows.find((r) => r.gate === 'filter');
  assert.equal(preexisting.prompt, RULES, 'pre-existing row content untouched');
  assert.equal(preexisting.active, 1, 'pre-existing active flag preserved across the rebuild');
});
