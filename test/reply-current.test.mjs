import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyIsCurrent } from '../platform/web/lib/reply-current.ts';

test('a reply for the strategy still on screen applies', () => {
  assert.equal(replyIsCurrent('alpha|WTI|M5', 'alpha|WTI|M5', true), true);
});
test('a late reply for a different strategy or scope list is dropped', () => {
  assert.equal(replyIsCurrent('alpha|WTI|M5', 'beta|WTI|M5', true), false);
  assert.equal(replyIsCurrent('alpha|WTI|M5', 'alpha|WTI|H1', true), false);
});
test('a reply after unmount is dropped', () => {
  assert.equal(replyIsCurrent('alpha', 'alpha', false), false);
});
