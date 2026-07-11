import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../skills/hormuz-ais-watch/scripts/hormuz_watch.mjs', import.meta.url),
);

function run(args, overrides = {}, { deleteKey } = {}) {
  const env = { ...process.env, ...overrides };
  if (deleteKey) delete env[deleteKey];
  return spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env, timeout: 20000 });
}

test('missing API key → clean one-line error', () => {
  const res = run([], {}, { deleteKey: 'AISSTREAM_API_KEY' });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('hormuz-ais-watch error:'), res.stderr);
  assert.equal(res.stderr.split('\n').filter(Boolean).length, 1, res.stderr);
});

test('non-numeric MIN_SOG rejected', () => {
  const res = run([], { AISSTREAM_API_KEY: 'dummy', MIN_SOG: 'abc' });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('hormuz-ais-watch error:'), res.stderr);
  assert.ok(res.stderr.includes('MIN_SOG'), res.stderr);
});

test('--help exits 0', () => {
  const res = run(['--help']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('hormuz-ais-watch'), res.stdout);
});
