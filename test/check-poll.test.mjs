import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPoll } from '../platform/web/lib/check-poll.ts';

test('applies a poll for the current run', () => {
  assert.deepEqual(applyPoll({ runId: 2 }, 2, { run: 'x' }), { runId: 2, run: 'x' });
});
test('drops a late poll for an older run', () => {
  const cur = { runId: 3 };
  assert.equal(applyPoll(cur, 2, { run: 'old' }), cur);
});
test('leaves a missing check missing', () => {
  assert.equal(applyPoll(undefined, 2, {}), undefined);
});
