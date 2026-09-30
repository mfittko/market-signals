import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedPatch } from '../platform/web/lib/settings-merge.ts';

// The console settings form keeps only what the operator changed. Clearing a field must count as a change,
// otherwise the card says "Saved." and the old value stays.
test('clearing the completion token limit sends null', () => {
  const out = changedPatch({ maxCompletionTokens: 4096 }, { maxCompletionTokens: 4096 }, { maxCompletionTokens: null });
  assert.deepEqual(out, { maxCompletionTokens: null });
});

test('clearing a model removes only that provider entry and keeps the fresh map', () => {
  const out = changedPatch({ models: { openai: 'a', anthropic: 'b' } }, { models: { openai: 'a', anthropic: 'b2' } }, { models: { openai: null, anthropic: 'b' } });
  assert.deepEqual(out, { models: { openai: null, anthropic: 'b2' } });
});

test('an untouched field sends nothing', () => {
  assert.deepEqual(changedPatch({ maxCompletionTokens: 4096, provider: 'openai' }, { provider: 'anthropic' }, { maxCompletionTokens: 4096, provider: 'openai' }), {});
});

test('a value that was never set and stays empty sends nothing', () => {
  assert.deepEqual(changedPatch({}, {}, { maxCompletionTokens: null, models: { openai: null } }), {});
});
