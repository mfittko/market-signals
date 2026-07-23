import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveStrategy, activateStrategy, archiveStrategy, deleteStrategy,
  listStrategies, activeStrategy, activeStrategyByName, ensureSeedStrategy, SEED_STRATEGY,
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

test('exactly-one-active-PER-NAME enforced at write (#75): different names stay independently active; archived cannot activate', () => {
  const db = fresh();
  const a = saveStrategy(db, { name: 'strat-a', prompt: PROMPT });
  const b = saveStrategy(db, { name: 'strat-b', prompt: PROMPT });
  activateStrategy(db, a.id);
  activateStrategy(db, b.id);
  const active = listStrategies(db).filter((s) => s.active);
  assert.equal(active.length, 2, 'both names independently active — dedicated + shared can coexist');
  assert.equal(activeStrategyByName(db, 'strat-a').id, a.id);
  assert.equal(activeStrategyByName(db, 'strat-b').id, b.id);

  // a new version under the SAME name moves the pointer — and ONLY for that name
  const a2 = saveStrategy(db, { name: 'strat-a', prompt: PROMPT + ' Tighter chop rules.', createdBy: 'chat' });
  activateStrategy(db, a2.id);
  assert.equal(activeStrategyByName(db, 'strat-a').id, a2.id, 'activation moved the pointer to v2');
  assert.equal(listStrategies(db).find((s) => s.id === a.id).active, 0, 'the prior version of the SAME name is deactivated');
  assert.equal(activeStrategyByName(db, 'strat-b').id, b.id, 'unrelated name is untouched');

  archiveStrategy(db, a2.id);
  assert.throws(() => activateStrategy(db, a2.id), /archived/);
  assert.equal(activeStrategyByName(db, 'strat-a'), null, 'archiving the active version clears that name\'s active pointer');
  assert.throws(() => activateStrategy(db, 999), /unknown/);
  activateStrategy(db, b.id);
  archiveStrategy(db, b.id);
  assert.equal(activeStrategyByName(db, 'strat-b'), null, 'archiving the active strategy clears the active flag');
  assert.equal(activeStrategy(db), null, 'global lookup returns null once nothing is active');
});

test('dedicated per-combo scope (#75): validation, optional metadata, advisory only', () => {
  const db = fresh();
  const shared = saveStrategy(db, { name: 'shared-strat', prompt: PROMPT });
  assert.equal(listStrategies(db).find((s) => s.id === shared.id).instrument, null, 'unscoped: no instrument column set');

  const dedicated = saveStrategy(db, { name: 'dedicated-strat', prompt: PROMPT, instrument: 'XAG/USD', granularity: 'M5', dedicated: true });
  const row = listStrategies(db).find((s) => s.id === dedicated.id);
  assert.equal(row.instrument, 'XAG/USD');
  assert.equal(row.granularity, 'M5');
  assert.equal(row.dedicated, 1);

  // dedicated flag without both instrument+granularity never sticks (still advisory metadata, but must be internally consistent)
  const notDedicated = saveStrategy(db, { name: 'half-scoped', prompt: PROMPT, instrument: 'XAG/USD', granularity: 'M5', dedicated: false });
  assert.equal(listStrategies(db).find((s) => s.id === notDedicated.id).dedicated, 0, 'scope hint without the dedicated flag stays non-dedicated');

  assert.throws(() => saveStrategy(db, { name: 'bad-scope', prompt: PROMPT, instrument: 'XAG/USD' }), /requires both/, 'instrument without granularity rejected');
  assert.throws(() => saveStrategy(db, { name: 'bad-scope2', prompt: PROMPT, instrument: ';drop', granularity: 'M5' }), /instrument symbol/);
  assert.throws(() => saveStrategy(db, { name: 'bad-scope3', prompt: PROMPT, instrument: 'XAG/USD', granularity: 'weekly' }), /M5, H1/);
});

test('spec validation is wired into the save path (#75): invalid specs never persist', () => {
  const db = fresh();
  assert.throws(() => saveStrategy(db, { name: 'bad-spec', prompt: PROMPT, spec: { schema_version: 1, entry: { minAxesAligned: 9 }, exit: { stopAtr: 1 } } }), /spec invalid/);
  const ok = saveStrategy(db, { name: 'good-spec', prompt: PROMPT, spec: { schema_version: 1, entry: { minAxesAligned: 2 }, exit: { stopAtr: 1.5 } } });
  assert.equal(listStrategies(db).find((s) => s.id === ok.id).hasSpec, 1);
});

test('migration: pre-#75 dbs without scope columns keep working (guarded ALTER)', () => {
  const db = fresh();
  withDb(db, (dbh) => {
    dbh.exec(`CREATE TABLE strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, version INTEGER NOT NULL,
      prompt TEXT NOT NULL, spec TEXT, instruments TEXT, created_by TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
      UNIQUE (name, version))`);
    dbh.prepare('INSERT INTO strategies (name, version, prompt, created_by, created_at) VALUES (?,?,?,?,?)')
      .run('pre-migration', 1, PROMPT, 'manual', new Date().toISOString());
  });
  const rows = listStrategies(db);
  assert.equal(rows.length, 1, 'pre-existing row survives the migration');
  assert.equal(rows[0].instrument, null, 'new column defaults to null on old rows');
  const added = saveStrategy(db, { name: 'post-migration', prompt: PROMPT, instrument: 'WTICO/USD', granularity: 'M5', dedicated: true });
  assert.equal(listStrategies(db).find((s) => s.id === added.id).dedicated, 1, 'scope columns fully functional after the guarded ALTER');
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

test('ensureSeedStrategy with a non-empty table is a silent no-op, never a throw (the atomic WHERE NOT EXISTS form makes a concurrent loser take this same path)', () => {
  const db = fresh();
  saveStrategy(db, { name: 'pre-existing', prompt: PROMPT });
  assert.equal(ensureSeedStrategy(db), null, 'non-empty table: no-op without error');
  assert.equal(listStrategies(db).length, 1, 'nothing inserted');
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
