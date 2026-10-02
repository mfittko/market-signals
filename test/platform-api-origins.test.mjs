import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const origins = (env) => execFileSync('bash', ['-c', '. platform/scripts/api-origins.sh; api_origins'],
  { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }).trim().split(',');

test('the launchd API default trusts only the console port', () => {
  assert.deepEqual(origins({}), ['localhost:3737', '127.0.0.1:3737']);
  assert.deepEqual(origins({ MS_CONSOLE_PORT: '4000' }), ['localhost:4000', '127.0.0.1:4000']);
  assert.ok(!origins({}).some((o) => o.endsWith(':3000')));
});

test('an explicit MS_ALLOWED_ORIGINS wins', () => {
  assert.deepEqual(origins({ MS_ALLOWED_ORIGINS: 'a:1' }), ['a:1']);
});
