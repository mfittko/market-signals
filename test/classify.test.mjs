import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../scripts/classify-post.mjs';

// F1: geopolitical/military/oil posts MUST route to oil (Brent + WTI), and the
// strongest signal must not be collapsed into a single index proxy.
test('Iran/geopolitical post routes to oil (BCO + WTICO), high-signal', () => {
  const r = classify('Iran asked us to continue. We hit their nuclear sites with missiles.');
  assert.equal(r.signal, 'high');
  const syms = r.instruments.map((i) => i.symbol).sort();
  assert.deepEqual(syms, ['BCO/USD', 'WTICO/USD']);
  assert.ok(r.instruments.every((i) => i.market === 'commodities'));
});

test('Fed post routes to indices + gold', () => {
  const r = classify('The Fed and Powell must cut the interest rate now, inflation is dead.');
  assert.equal(r.signal, 'high');
  const syms = new Set(r.instruments.map((i) => i.symbol));
  assert.ok(syms.has('NAS100/USD') && syms.has('US30/USD') && syms.has('XAU/USD'), [...syms].join(','));
});

test('tariff/trade post routes to indices only (no oil, no gold)', () => {
  const r = classify('Toyota is moving production from Mexico to the USA. New tariffs on China!');
  assert.equal(r.signal, 'high');
  const syms = new Set(r.instruments.map((i) => i.symbol));
  assert.deepEqual([...syms].sort(), ['NAS100/USD', 'US30/USD']);
});

test('control post with no market keywords is low-signal (skipped)', () => {
  const r = classify('Thank you to everyone at the rally tonight. A total endorsement. MAGA!');
  assert.equal(r.signal, 'low');
  assert.deepEqual(r.instruments, []);
});

test('word-boundary matching: "toil" does not trigger the oil rule', () => {
  const r = classify('Hard work and toil built this country. Traders love us.');
  assert.equal(r.signal, 'low');
});

test('threshold gates weak matches', () => {
  const oneHit = 'A comment about oil.';
  assert.equal(classify(oneHit, { threshold: 1 }).signal, 'high');
  assert.equal(classify(oneHit, { threshold: 2 }).signal, 'low');
});

test('multi-topic post unions instruments (Fed + oil), deduped', () => {
  const r = classify('The Fed is wrong on rates while Iran threatens oil supplies.');
  const syms = r.instruments.map((i) => i.symbol);
  assert.equal(new Set(syms).size, syms.length, 'no duplicate symbols');
  assert.ok(syms.includes('BCO/USD') && syms.includes('NAS100/USD') && syms.includes('XAU/USD'));
});
