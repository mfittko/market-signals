import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isModelAgent } from './api.ts';

test('isModelAgent is true for the model-backed runtimes', () => {
  assert.equal(isModelAgent({ runtime: 'llm' }), true);
  assert.equal(isModelAgent({ runtime: 'claude-code' }), true);
});

test('isModelAgent is false for the mock runtime', () => {
  assert.equal(isModelAgent({ runtime: 'mock' }), false);
});
