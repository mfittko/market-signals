import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAlerted, notAlertedLabel, signalId, signalTitle } from '../platform/web/lib/signal-class.ts';

// Only verdict 'alert' means the engine notified. Every other value the engine writes must not pass.
test('only an alert verdict counts as alerted', () => {
  assert.equal(isAlerted({ verdict: 'alert' }), true);
  for (const verdict of ['suppress', 'duplicate', 'backfill', null, undefined]) assert.equal(isAlerted({ verdict }), false, String(verdict));
});

test('an impulse row is titled as an impulse and a flip as a flip', () => {
  const base = { signal: 'buy', instrument: 'WTI', granularity: 'M5', price: 70 };
  assert.equal(signalTitle({ ...base, kind: 'volume-impulse' }), 'Volume impulse WTI M5 at 70');
  assert.equal(signalTitle({ ...base, kind: 'supertrend-flip' }), 'Buy flip WTI M5 at 70');
  assert.equal(signalTitle({ ...base, signal: 'sell' }), 'Sell flip WTI M5 at 70');
});

test('every non-alert verdict has its own label', () => {
  assert.equal(notAlertedLabel({ verdict: 'suppress' }), 'Suppressed');
  assert.equal(notAlertedLabel({ verdict: 'duplicate' }), 'Duplicate');
  assert.equal(notAlertedLabel({ verdict: 'backfill' }), 'Backfilled');
  assert.equal(notAlertedLabel({ verdict: null }), 'Not alerted');
  assert.equal(notAlertedLabel({}), 'Not alerted');
});

test('a flip and an impulse on the same bar get different ids, and an absent kind is a flip', () => {
  const bar = { instrument: 'WTI', granularity: 'M5', time: '2026-01-01T00:00:00Z' };
  assert.notEqual(signalId({ ...bar, kind: 'volume-impulse' }), signalId({ ...bar, kind: 'supertrend-flip' }));
  assert.equal(signalId(bar), signalId({ ...bar, kind: 'supertrend-flip' }));
});
