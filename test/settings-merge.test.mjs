import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedPatch } from '../platform/web/lib/settings-merge.ts';

test('sends only keys that differ from the loaded values', () => {
  const loaded = { freshBars: 3, ind: 'ema', keepFresh: '1' };
  const patch = { freshBars: 5, ind: 'ema', keepFresh: '1', impulseVolMult: null };
  assert.deepEqual(changedPatch(loaded, { freshBars: 3 }, patch), { freshBars: 5 });
});
test('a key edited elsewhere is not reverted by an untouched form field', () => {
  assert.deepEqual(changedPatch({ ind: 'ema' }, { ind: 'bb' }, { ind: 'ema', freshBars: 4 }), { freshBars: 4 });
});
test('absent flag equals a sent 0, and a changed flag is sent', () => {
  assert.deepEqual(changedPatch({}, {}, { keepFresh: '0' }), {});
  assert.deepEqual(changedPatch({ keepFresh: true }, {}, { keepFresh: '0' }), { keepFresh: '0' });
});
test('clearing a loaded value is a change', () => {
  assert.deepEqual(changedPatch({ freshBars: 3 }, {}, { freshBars: null }), { freshBars: null });
});
test('merges only the edited model entry into the fresh map', () => {
  const loaded = { models: { openai: 'a', anthropic: 'b' } };
  const fresh = { models: { openai: 'a', anthropic: 'NEW' } };
  assert.deepEqual(changedPatch(loaded, fresh, { provider: 'openai', models: { ...loaded.models, openai: 'c' } }).models, { openai: 'c', anthropic: 'NEW' });
  assert.equal(changedPatch(loaded, fresh, { models: loaded.models }).models, undefined);
});
test('the card baseline advances after each save, so a second save sends only its own change', () => {
  const base = { freshBars: 3, ind: 'ema' };
  const fresh = { freshBars: 3, ind: 'ema' };
  const first = changedPatch(base, fresh, { freshBars: 5, ind: 'ema' });
  assert.deepEqual(first, { freshBars: 5 });
  Object.assign(base, first);
  // the engine changed ind meanwhile; the form still shows the old ind and must not revert it
  assert.deepEqual(changedPatch(base, { freshBars: 5, ind: 'bb' }, { freshBars: 5, ind: 'ema' }), {});
  assert.deepEqual(changedPatch(base, { freshBars: 5, ind: 'bb' }, { freshBars: 6, ind: 'ema' }), { freshBars: 6 });
});
test('a form default equal to the initial form value is not sent for an absent key', () => {
  const base = { NEWSAPI_AI_MODE: 'auto', GNEWS_MODE: 'off' };
  assert.deepEqual(changedPatch(base, { NEWSAPI_AI_MODE: 'off' }, { NEWSAPI_AI_MODE: 'auto', GNEWS_MODE: 'off', freshBars: 4 }), { freshBars: 4 });
});
