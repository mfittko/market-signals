import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refetchOnOpen } from '../platform/web/lib/live-reopen.ts';

test('the first open refetches nothing', () => {
  assert.deepEqual(refetchOnOpen(false), { tick: false, news: false });
});
test('a reopen refetches the run state and the news card', () => {
  assert.deepEqual(refetchOnOpen(true), { tick: true, news: true });
});
