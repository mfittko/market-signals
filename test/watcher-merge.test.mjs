import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toggleWatcher } from '../platform/web/lib/watcher-merge.ts';

test('adds to the fresh list and keeps entries added elsewhere', () => {
  assert.deepEqual(toggleWatcher('WTI|M5, GOLD|H1', 'BTC|M5'), ['WTI|M5', 'GOLD|H1', 'BTC|M5']);
});
test('removes only the toggled entry', () => {
  assert.deepEqual(toggleWatcher('WTI|M5, GOLD | H1', 'WTI|M5'), ['GOLD|H1']);
});
test('handles an empty list', () => {
  assert.deepEqual(toggleWatcher(undefined, 'WTI|M5'), ['WTI|M5']);
});
