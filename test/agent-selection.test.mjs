import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAgentId } from '../platform/web/lib/agent-selection.ts';

const agents = [{ id: 'a' }, { id: 'b' }];

test('keeps a selection that is still visible', () => {
  assert.equal(pickAgentId('b', agents), 'b');
});
test('falls back to the first visible agent when the selection is filtered out', () => {
  assert.equal(pickAgentId('gone', agents), 'a');
  assert.equal(pickAgentId('', agents), 'a');
});
test('returns empty when nothing is visible, so Run stays disabled', () => {
  assert.equal(pickAgentId('a', []), '');
});
