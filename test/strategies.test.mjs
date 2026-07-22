import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveStrategy, activateStrategy, archiveStrategy, deleteStrategy,
  listStrategies, activeStrategy, ensureSeedStrategy, SEED_STRATEGY,
} from '../scripts/strategies.mjs';
import { withDb } from '../scripts/supertrend.mjs';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'strat-')), 's.sqlite');
const PROMPT = 'Open long on confirmed flips with volume, stop beyond the line, hold when unclear.';

test('versioning: saves append versions, never rewrite; validation guards inputs', () => {
  const db = fresh();
  const v1 = saveStrategy(db, { name: 'test-strat', prompt: PROMPT });
  assert.deepEqual([v1.version, v1.name], [1, 'test-strat']);
  const v2 = saveStrategy(db, { name: 'test-strat', prompt: PROMPT + ' Tighter chop rules.', createdBy: 'chat' });
  assert.equal(v2.version, 2);
  const rows = listStrategies(db);
  assert.equal(rows.length, 2, 'both versions listed');
  assert.equal(rows[0].version, 2, 'newest first per name');
  assert.throws(() => saveStrategy(db, { name: 'Bad Name!', prompt: PROMPT }), /kebab-case/);
  assert.throws(() => saveStrategy(db, { name: 'ok-name', prompt: 'too short' }), /20-4000/);
  assert.throws(() => saveStrategy(db, { name: 'ok-name', prompt: PROMPT, instruments: ';;drop' }), /combo CSV/);
  assert.throws(() => saveStrategy(db, { name: 'ok-name', prompt: PROMPT, createdBy: 'robot' }), /seed\|chat\|manual/);
  assert.throws(() => saveStrategy(db, { name: 'ok-name', prompt: PROMPT, spec: [1, 2] }), /plain object/);
  const num = saveStrategy(db, { name: 'num-instruments', prompt: PROMPT, instruments: 123456 });
  assert.equal(typeof listStrategies(db).find((x) => x.id === num.id).instruments, 'string', 'instruments normalized to string before insert');
});

test('exactly-one-active enforced at write; archived cannot activate; archiving clears active', () => {
  const db = fresh();
  const a = saveStrategy(db, { name: 'strat-a', prompt: PROMPT });
  const b = saveStrategy(db, { name: 'strat-b', prompt: PROMPT });
  activateStrategy(db, a.id);
  activateStrategy(db, b.id);
  const active = listStrategies(db).filter((s) => s.active);
  assert.equal(active.length, 1, 'exactly one active');
  assert.equal(active[0].id, b.id);
  assert.equal(activeStrategy(db).id, b.id);
  archiveStrategy(db, a.id);
  assert.throws(() => activateStrategy(db, a.id), /archived/);
  assert.equal(activeStrategy(db).id, b.id, 'failed activation of an archived target leaves the current active untouched');
  assert.throws(() => activateStrategy(db, 999), /unknown/);
  activateStrategy(db, b.id);
  archiveStrategy(db, b.id);
  assert.equal(activeStrategy(db), null, 'archiving the active strategy clears the active flag');
});

test('delete blocked with journal references (archive instead); free versions delete', () => {
  const db = fresh();
  const a = saveStrategy(db, { name: 'strat-ref', prompt: PROMPT });
  withDb(db, (dbh) => {
    dbh.exec('CREATE TABLE IF NOT EXISTS bot_journal (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, position_id INTEGER, reason TEXT, context TEXT)');
    dbh.prepare('INSERT INTO bot_journal (at, action, context) VALUES (?,?,?)')
      .run(new Date().toISOString(), 'decision', JSON.stringify({ strategyId: a.id, decision: { action: 'hold' } }));
  });
  assert.throws(() => deleteStrategy(db, a.id), /archive instead/);
  // token-exact matching: a journal ref to strategy 12 must not block deleting id 1
  withDb(db, (dbh) => dbh.prepare('INSERT INTO bot_journal (at, action, context) VALUES (?,?,?)')
    .run(new Date().toISOString(), 'decision', JSON.stringify({ strategyId: Number(String(a.id) + '2'), decision: { action: 'hold' } })));
  const unref = saveStrategy(db, { name: 'strat-unref', prompt: PROMPT });
  assert.equal(deleteStrategy(db, unref.id).deleted, true, 'longer-id references never false-positive-block');
  const free = saveStrategy(db, { name: 'strat-free', prompt: PROMPT });
  assert.equal(deleteStrategy(db, free.id).deleted, true);
  assert.throws(() => deleteStrategy(db, free.id), /unknown strategy/, 'double delete reports unknown');
  assert.equal(archiveStrategy(db, a.id).archived, true);
  assert.equal(listStrategies(db).some((s) => s.id === a.id), false, 'archived hidden by default');
  assert.equal(listStrategies(db, { includeArchived: true }).some((s) => s.id === a.id), true);
});

test('seed strategy ships once on an empty table and never again', () => {
  const db = fresh();
  const id = ensureSeedStrategy(db);
  assert.ok(id > 0);
  assert.equal(ensureSeedStrategy(db), null, 'second call is a no-op');
  const rows = listStrategies(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, SEED_STRATEGY.name);
  assert.equal(rows[0].created_by, 'seed');
  assert.equal(activeStrategy(db), null, 'seed ships INACTIVE — activation is a human act');
});
