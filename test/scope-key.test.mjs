import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeKey } from '../platform/web/lib/scope-key.ts';

const wti = { instrument: 'WTICO/USD', granularity: 'M5' };
const gold = { instrument: 'XAU/USD', granularity: 'H1' };

test('two arrays with the same scopes in the same order give the same key', () => {
  const a = [wti, gold], b = [{ ...wti }, { ...gold }];
  assert.notEqual(a, b);
  assert.equal(scopeKey(a), scopeKey(b));
});
test('a different scope list gives a different key', () => {
  assert.notEqual(scopeKey([wti]), scopeKey([gold]));
  assert.notEqual(scopeKey([wti, gold]), scopeKey([gold, wti]));
  assert.notEqual(scopeKey([wti]), scopeKey([{ ...wti, granularity: 'H1' }]));
});
test('the key is stable for repeated calls', () => {
  const a = [wti, gold];
  assert.equal(scopeKey(a), scopeKey(a));
  assert.equal(typeof scopeKey(a), 'string');
});
