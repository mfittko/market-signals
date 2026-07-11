import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../skills/truthsocial-trump-watch/scripts/truthsocial_watch.mjs', import.meta.url),
);

function run(args, overrides = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...overrides },
    timeout: 20000,
  });
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ms-ts-'));
}

test('fails loud on dead CDP endpoint', () => {
  const res = run([], {
    TRUTHSOCIAL_SOURCE_MODE: 'cdp',
    CDP_BASE_URL: 'http://127.0.0.1:1',
    WORKSPACE_DIR: tmp(),
  });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('TRUTHSOCIAL_WATCH_ERROR'), res.stderr);
});

test('fails loud when zero posts scraped (node mode)', () => {
  const res = run([], {
    TRUTHSOCIAL_SOURCE_MODE: 'node',
    TRUTHSOCIAL_PROFILE_URL: 'data:text/html,<html><body>no posts</body></html>',
    WORKSPACE_DIR: tmp(),
  });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('TRUTHSOCIAL_WATCH_ERROR'), res.stderr);
  assert.ok(res.stderr.includes('no posts scraped'), res.stderr);
});

test('--help prints usage without network and exits 0', () => {
  const res = run(['--help']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('truthsocial-trump-watch'), res.stdout);
  // The help text mentions HEARTBEAT_OK in prose; assert the watcher did NOT
  // actually run and emit its bare `HEARTBEAT_OK` heartbeat line.
  assert.ok(!res.stdout.split('\n').includes('HEARTBEAT_OK'), res.stdout);
});

test('rejects unknown flag', () => {
  const res = run(['--bogus']);
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('unknown flag'), res.stderr);
});
