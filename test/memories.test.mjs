import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveMemory, listMemories, reweightMemory, editMemory, archiveMemory, memoriesContext,
} from '../scripts/memories.mjs';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'mem-')), 'm.sqlite');

test('saveMemory validates content/weight/source; defaults weight 3, source chat', () => {
  const db = fresh();
  const m = saveMemory(db, { content: 'Never add to a losing position.' });
  assert.deepEqual([m.weight, m.source], [3, 'chat']);
  const m2 = saveMemory(db, { content: 'Size down on FOMC days.', weight: 5, source: 'manual' });
  assert.equal(m2.weight, 5);
  assert.throws(() => saveMemory(db, { content: '' }), /1-500/, 'empty content rejected');
  assert.throws(() => saveMemory(db, { content: '   ' }), /1-500/, 'whitespace-only content rejected');
  assert.throws(() => saveMemory(db, { content: 'x'.repeat(501) }), /1-500/, 'over-long content rejected');
  assert.throws(() => saveMemory(db, { content: 'ok', weight: 0 }), /1-5/);
  assert.throws(() => saveMemory(db, { content: 'ok', weight: 6 }), /1-5/);
  assert.throws(() => saveMemory(db, { content: 'ok', weight: 2.5 }), /1-5/, 'weight must be an integer');
  assert.throws(() => saveMemory(db, { content: 'ok', source: 'robot' }), /chat\|manual/);
  const rows = listMemories(db);
  assert.equal(rows.length, 2);
});

test('saveMemory normalizes content: trims first (500-char trimmed boundary accepted) and collapses newlines/whitespace to single spaces', () => {
  const db = fresh();
  // 500 real chars plus trailing padding that would push the untrimmed
  // length over 500 — must validate against the trimmed length, not raw
  const padded = saveMemory(db, { content: `${'x'.repeat(500)}${' '.repeat(20)}` });
  assert.equal(padded.content.length, 500, 'trimmed to exactly 500 chars, accepted');

  const multiline = saveMemory(db, { content: '  Line one.\n\nLine two.\t\tLine three.  ' });
  assert.equal(multiline.content, 'Line one. Line two. Line three.', 'newlines/tabs/runs collapsed to single spaces, single line');
  assert.ok(!multiline.content.includes('\n'));
});

test('listMemories orders weight DESC then updated_at DESC; includeArchived toggles visibility', () => {
  const db = fresh();
  const low = saveMemory(db, { content: 'low weight rule', weight: 1 });
  const high = saveMemory(db, { content: 'high weight rule', weight: 5 });
  const mid = saveMemory(db, { content: 'mid weight rule', weight: 3 });
  assert.deepEqual(listMemories(db).map((r) => r.id), [high.id, mid.id, low.id]);
  archiveMemory(db, mid.id);
  assert.deepEqual(listMemories(db).map((r) => r.id), [high.id, low.id], 'archived hidden by default');
  assert.deepEqual(listMemories(db, { includeArchived: true }).map((r) => r.id).sort(), [high.id, low.id, mid.id].sort());
});

test('reweightMemory and editMemory validate input and update the row; unknown id throws', () => {
  const db = fresh();
  const m = saveMemory(db, { content: 'original text' });
  reweightMemory(db, m.id, 5);
  assert.equal(listMemories(db).find((r) => r.id === m.id).weight, 5);
  assert.throws(() => reweightMemory(db, m.id, 9), /1-5/);
  assert.throws(() => reweightMemory(db, 99999, 3), /unknown memory/);
  editMemory(db, m.id, 'revised text');
  assert.equal(listMemories(db).find((r) => r.id === m.id).content, 'revised text');
  assert.throws(() => editMemory(db, m.id, ''), /1-500/);
  assert.throws(() => editMemory(db, 99999, 'x'), /unknown memory/);
});

test('archiveMemory hides without deleting (no hard delete); unknown id throws', () => {
  const db = fresh();
  const m = saveMemory(db, { content: 'archive me' });
  const out = archiveMemory(db, m.id);
  assert.deepEqual(out, { id: m.id, archived: true });
  assert.equal(listMemories(db).length, 0);
  assert.equal(listMemories(db, { includeArchived: true }).length, 1, 'row still exists');
  assert.throws(() => archiveMemory(db, 99999), /unknown memory/);
});

test('memoriesContext: empty table returns null (no block emitted)', () => {
  const db = fresh();
  assert.equal(memoriesContext(db), null);
});

test('memoriesContext: top-weighted-first lines, "- [wN] content" format', () => {
  const db = fresh();
  saveMemory(db, { content: 'low priority note', weight: 1 });
  saveMemory(db, { content: 'top priority rule', weight: 5 });
  const ctx = memoriesContext(db);
  const lines = ctx.split('\n');
  assert.equal(lines[0], '- [w5] top priority rule');
  assert.equal(lines[1], '- [w1] low priority note');
});

test('memoriesContext: budget cut BEFORE the entry that would exceed it, highest weight always wins a spot', () => {
  const db = fresh();
  const a = 'A'.repeat(40); // weight 5, always fits first
  const b = 'B'.repeat(40); // weight 4
  const c = 'C'.repeat(40); // weight 3 — pushed out by a tight budget
  saveMemory(db, { content: c, weight: 3 });
  saveMemory(db, { content: a, weight: 5 });
  saveMemory(db, { content: b, weight: 4 });
  const lineLen = `- [w5] ${a}`.length; // all three lines are the same length
  // budget fits exactly the first two lines (line + newline + line), not the third
  const budget = lineLen * 2 + 1;
  const ctx = memoriesContext(db, budget);
  const lines = ctx.split('\n');
  assert.deepEqual(lines, [`- [w5] ${a}`, `- [w4] ${b}`], 'cuts before the lowest-weight entry once the budget is exhausted');
});

test('memoriesContext: archiving drops a memory from context immediately', () => {
  const db = fresh();
  const m = saveMemory(db, { content: 'temporary rule', weight: 5 });
  assert.match(memoriesContext(db), /temporary rule/);
  archiveMemory(db, m.id);
  assert.equal(memoriesContext(db), null);
});
