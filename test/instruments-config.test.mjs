import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadInstrumentsConfig, rateSlugsByMarket, findInstrumentBySlug, sentinelConfigForInstrument, SYMBOL_TO_SLUG,
} from '../scripts/lib/instruments.mjs';

test('loadInstrumentsConfig: parses the committed config/instruments.yaml, including the hand-added sentinel/yahooSymbol fields', () => {
  const cfg = loadInstrumentsConfig();
  const wti = findInstrumentBySlug('wti-crude-oil', cfg);
  assert.ok(wti, 'wti-crude-oil entry present');
  assert.equal(wti.yahooSymbol, 'CL=F');
  assert.match(wti.sentinel, /Hormuz/);
  assert.ok(rateSlugsByMarket(cfg).commodities.includes('wti-crude-oil'));
});

test('sentinelConfigForInstrument: resolves a candle-symbol instrument to its slug + committed query + Yahoo symbol', () => {
  const cfg = loadInstrumentsConfig();
  const wti = sentinelConfigForInstrument('WTICO/USD', cfg);
  assert.equal(wti.slug, 'wti-crude-oil');
  assert.equal(wti.yahooSymbol, 'CL=F');
  assert.match(wti.query, /oil/i);

  const gold = sentinelConfigForInstrument('XAU/USD', cfg);
  assert.equal(gold.slug, 'gold');
  assert.equal(gold.yahooSymbol, 'GC=F');
});

test('sentinelConfigForInstrument: never guesses — an instrument outside the static bridge or without a committed sentinel entry resolves to null', () => {
  const cfg = loadInstrumentsConfig();
  assert.equal(sentinelConfigForInstrument('BTC/USD', cfg), null, 'BTC/USD has no SYMBOL_TO_SLUG entry');
  assert.equal(sentinelConfigForInstrument('NOPE/USD', cfg), null);
});

test('SYMBOL_TO_SLUG: every mapped slug actually resolves in the committed config with a sentinel query', () => {
  const cfg = loadInstrumentsConfig();
  for (const [instrument, slug] of Object.entries(SYMBOL_TO_SLUG)) {
    const entry = findInstrumentBySlug(slug, cfg);
    assert.ok(entry, `${instrument} -> ${slug} not found in config/instruments.yaml`);
    assert.ok(entry.sentinel, `${slug} has no committed sentinel query`);
  }
});

test('loadInstrumentsConfig: a missing file returns an empty (never-guessed) config instead of throwing', () => {
  const cfg = loadInstrumentsConfig('/nonexistent/instruments.yaml');
  assert.deepEqual(cfg, { markets: {} });
  assert.equal(sentinelConfigForInstrument('WTICO/USD', cfg), null);
});
