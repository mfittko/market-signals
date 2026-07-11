import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../skills/fxempire-live-data/scripts/fxempire_live_data.mjs', import.meta.url),
);

function run(args) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 20000,
  });
}

test('--count abc is rejected', () => {
  const res = run(['--count', 'abc']);
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('invalid --count'), res.stderr);
});

test('unknown flag rejected', () => {
  const res = run(['--nope', '1']);
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('unknown flag'), res.stderr);
});

test('--help no network exit 0', () => {
  const res = run(['--help']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('fxempire-live-data'), res.stdout);
  assert.ok(res.stdout.includes('Usage'), res.stdout);
});

test('rates without slugs hints --slugs and --instrument ignored', () => {
  const res = run(['--mode', 'rates', '--market', 'indices', '--instrument', 'spx']);
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('--slugs'), res.stderr);
  assert.ok(res.stderr.includes('instrument'), res.stderr);
});
