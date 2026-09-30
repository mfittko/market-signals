import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const helper = resolve('platform/scripts/main-root.sh');

function mainRoot(repo, cwd) {
  return execFileSync('bash', ['-c', '. "$0"; main_root "$1"', helper, repo], { cwd, encoding: 'utf8' }).trim();
}

test('main_root resolves the main checkout from any cwd, for the main checkout and for a worktree', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'main-root-')));
  const repo = join(base, 'repo');
  const elsewhere = join(base, 'elsewhere', 'platform');
  mkdirSync(elsewhere, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  execFileSync('git', ['init', '-q', repo]);
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('worktree', 'add', '-q', join(repo, 'wt'));
  assert.equal(mainRoot(repo, elsewhere), repo);
  assert.equal(mainRoot(join(repo, 'wt'), elsewhere), repo);
});
