import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = '../skills/fxempire-analysis/scripts/';
const script = (name) => fileURLToPath(new URL(dir + name, import.meta.url));

function help(name) {
  return spawnSync('node', [script(name), '--help'], {
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 20000,
  });
}

test('fxempire_articles --help exits 0 with usage', () => {
  const res = help('fxempire_articles.mjs');
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.length > 0);
  assert.ok(res.stdout.includes('articles'), res.stdout);
});

test('fxempire_rates --help exits 0', () => {
  const res = help('fxempire_rates.mjs');
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.length > 0);
});

test('fxempire_enrich --help exits 0', () => {
  const res = help('fxempire_enrich.mjs');
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.length > 0);
});
