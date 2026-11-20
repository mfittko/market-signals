import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strategyConflict } from '../platform/web/lib/strategy-conflict.ts';

// A save based on a stale version must show the server text, the current version and a Reload action.
test('a stale base version maps to the conflict text with the current version and a reload flag', () => {
  const body = { error: 'another tab or client changed this strategy', hint: 'reload to see the current version', code: 'stale_base_version', currentVersion: 4 };
  const c = strategyConflict(409, body);
  assert.equal(c?.reload, true);
  assert.equal(c?.currentVersion, 4);
  assert.match(c.text, /another tab or client changed this strategy/);
  assert.match(c.text, /v4/);
});

test('other failures are not a conflict', () => {
  assert.equal(strategyConflict(409, { error: 'this strategy is archived; restore it before editing' }), null);
  assert.equal(strategyConflict(400, { code: 'base_version_required' }), null);
  assert.equal(strategyConflict(undefined, undefined), null);
});
