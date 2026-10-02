import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toggleWatcher, watcherEntries } from '../platform/web/lib/watcher-merge.ts';

// The engine defaults the timeframe to M5 only when an entry has no separator.
test('a bare entry reads as M5, as the engine reads it', () => {
  assert.deepEqual(watcherEntries('WTICO/USD, XAU/USD|H1'), ['WTICO/USD|M5', 'XAU/USD|H1']);
  assert.deepEqual(watcherEntries(' WTICO/USD | M5 '), ['WTICO/USD|M5']);
});
test('an empty timeframe after the separator is not M5, and case is kept', () => {
  assert.deepEqual(watcherEntries('WTICO/USD|, wtico/usd|M5'), ['WTICO/USD|', 'wtico/usd|M5']);
});
test('unticking M5 removes a bare entry instead of leaving it behind', () => {
  assert.deepEqual(toggleWatcher('WTICO/USD, XAU/USD|H1', 'WTICO/USD|M5'), ['XAU/USD|H1']);
});
test('a bare entry counts as ticked, so toggling it unticks and never duplicates it', () => {
  assert.deepEqual(toggleWatcher('WTICO/USD', 'XAU/USD|M5'), ['WTICO/USD|M5', 'XAU/USD|M5']);
  assert.equal(toggleWatcher('WTICO/USD', 'WTICO/USD|M5').includes('WTICO/USD|M5'), false);
});

test('adds to the fresh list and keeps entries added elsewhere', () => {
  assert.deepEqual(toggleWatcher('WTI|M5, GOLD|H1', 'BTC|M5'), ['WTI|M5', 'GOLD|H1', 'BTC|M5']);
});
test('removes only the toggled entry', () => {
  assert.deepEqual(toggleWatcher('WTI|M5, GOLD | H1', 'WTI|M5'), ['GOLD|H1']);
});
test('handles an empty list', () => {
  assert.deepEqual(toggleWatcher(undefined, 'WTI|M5'), ['WTI|M5']);
});
test('refuses an empty or malformed pair', () => {
  assert.deepEqual(toggleWatcher('WTI|M5', 'XAU/USD|'), ['WTI|M5']);
  assert.deepEqual(toggleWatcher('WTI|M5', '|M5'), ['WTI|M5']);
  assert.deepEqual(toggleWatcher('WTI|M5', 'XAU/USD'), ['WTI|M5']);
});
