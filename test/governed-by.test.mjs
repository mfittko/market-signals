import { test } from 'node:test';
import assert from 'node:assert/strict';
import { governedBy } from '../platform/web/lib/governed-by.ts';

test('a run with a frozen console strategy names it, its version and the engine strategy', () => {
  assert.equal(governedBy({ name: 'Trend', version: 3 }, { engineStrategy: { name: 'st-follow' } }),
    'Governed by console strategy Trend, version 3. Engine strategy: st-follow.');
});

test('a run without a console strategy is governed by the engine strategy', () => {
  assert.equal(governedBy(undefined, { engineStrategy: { name: 'st-follow' } }), "Governed by the engine's strategy st-follow.");
});

test('a run stored before strategies were frozen still renders', () => {
  assert.equal(governedBy(null, { strategy: { name: 'old' } }), 'Governed by the strategy in its snapshot: old.');
  assert.equal(governedBy(null, {}), 'Governed by the strategy in its snapshot: none recorded.');
});
