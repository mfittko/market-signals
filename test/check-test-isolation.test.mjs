import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareSnapshots, main, snapshot, withoutGitEnv } from '../scripts/check-test-isolation.mjs';

test('withoutGitEnv: drops every GIT_* key and keeps the rest', () => {
  const env = { GIT_DIR: '/decoy/.git', GIT_WORK_TREE: '/decoy', GIT_INDEX_FILE: '/decoy/index', PATH: '/bin', MS_NO_NOTIFY: '1' };
  assert.deepEqual(withoutGitEnv(env), { PATH: '/bin', MS_NO_NOTIFY: '1' });
});

test('main: refuses a tracked symlink that points outside the checkout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolation-symlink-'));
  try {
    const root = join(dir, 'repo');
    mkdirSync(root);
    writeFileSync(join(root, 'a.txt'), 'a\n');
    symlinkSync('../../outside', join(root, 'x'));
    const env = { ...withoutGitEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    for (const args of [['init', '-q'], ['add', '-A']]) assert.equal(spawnSync('git', args, { cwd: root, env }).status, 0);
    assert.throws(() => main(root), /tracked symlink x points outside the checkout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const base = {
  '.': { size: null, mtimeMs: 1000, atimeMs: null },
  'notes.md': { size: 9, mtimeMs: 1000, atimeMs: 500 },
};

test('compareSnapshots: identical snapshots produce no finding', () => {
  assert.deepEqual(compareSnapshots(base, structuredClone(base)), []);
});

test('compareSnapshots: an added file fails the check', () => {
  const after = { ...structuredClone(base), 'candles.db': { size: 0, mtimeMs: 2000, atimeMs: 2000 } };
  assert.deepEqual(compareSnapshots(base, after), ['added: candles.db']);
});

test('compareSnapshots: a changed file fails the check', () => {
  const after = structuredClone(base);
  after['notes.md'].mtimeMs = 2000;
  assert.deepEqual(compareSnapshots(base, after), ['changed: notes.md']);
  after['notes.md'] = { ...base['notes.md'], size: 10 };
  assert.deepEqual(compareSnapshots(base, after), ['changed: notes.md']);
});

test('compareSnapshots: a read sentinel fails the check', () => {
  const after = structuredClone(base);
  after['notes.md'].atimeMs = 3000;
  assert.deepEqual(compareSnapshots(base, after), ['read: notes.md']);
});

test('compareSnapshots: a removed file fails the check', () => {
  const after = structuredClone(base);
  delete after['notes.md'];
  assert.deepEqual(compareSnapshots(base, after), ['removed: notes.md']);
});

test('snapshot: records stat fields per path, and the comparison sees a real write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolation-snap-'));
  try {
    writeFileSync(join(dir, 'notes.md'), 'sentinel\n');
    const before = snapshot(dir);
    assert.deepEqual(Object.keys(before).sort(), ['.', 'notes.md']);
    assert.equal(before['notes.md'].size, 9);
    writeFileSync(join(dir, 'notes.md'), 'overwritten\n');
    assert.deepEqual(compareSnapshots(before, snapshot(dir)), ['changed: notes.md']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
