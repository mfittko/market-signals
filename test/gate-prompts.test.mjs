import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveGatePrompt, listGatePrompts, activateGatePrompt, deactivateGatePrompt, activeGatePrompt,
} from '../scripts/gate-prompts.mjs';

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
  assert.throws(() => saveGatePrompt(db, { gate: 'bot', prompt: RULES }), /gate must be one of/, 'only filter is a valid gate in v1');
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
