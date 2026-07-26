import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { recordProviderCall, providerRequestsUsed } from '../scripts/news.mjs';
import {
  qualifiesAsMove, correlationConfig, CORRELATION_DEFAULTS,
  openOrExtendWindow, getActiveWindow, cancelWindow, pollWindow,
} from '../scripts/correlation.mjs';

// Hermetic: injected HTTP fetcher + fixed clock, temp DB. Zero provider tokens.
const NOW = Date.parse('2026-07-24T20:00:00Z');
const db = (n) => fileURLToPath(new URL(`./tmp-corr-${n}.db`, import.meta.url));
const cfg = { ...CORRELATION_DEFAULTS, enabled: true };
const INST = 'WTICO/USD';
const QUERY = 'oil OR crude OR OPEC';

// raw NewsAPI.ai article → the { articles: { results } } envelope the adapter parses
const rawArticle = (over = {}) => ({
  uri: 'a1', title: 'Analysts discuss oil outlook', body: 'routine commentary on prices',
  dateTimePub: new Date(NOW - 5 * 60000).toISOString(), source: { title: 'Reuters', uri: 'reuters.com' },
  url: 'https://x/1', sentiment: 0, concepts: [], isDuplicate: false, ...over,
});
const fetcherFor = (articles) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ articles: { results: articles } }) });

test('qualifiesAsMove: ATR+volume, price-only fallback, disabled/no-atr', () => {
  assert.equal(qualifiesAsMove({ rangeAtr: 1.6, volumeRatio: 2.1 }, cfg).trigger, true, 'move+volume passes');
  assert.equal(qualifiesAsMove({ rangeAtr: 1.6, volumeRatio: 1.5 }, cfg).trigger, false, 'weak volume fails');
  assert.equal(qualifiesAsMove({ rangeAtr: 2.6, volumeRatio: null }, cfg).trigger, true, 'price-only extreme passes when volume unavailable');
  assert.equal(qualifiesAsMove({ rangeAtr: 1.6, volumeRatio: null }, cfg).trigger, false, 'price-only requires the stricter extreme threshold');
  assert.equal(qualifiesAsMove({ rangeAtr: 3, volumeRatio: 3 }, { ...cfg, enabled: false }).trigger, false, 'disabled never triggers');
  assert.equal(qualifiesAsMove({ rangeAtr: NaN, volumeRatio: 3 }, cfg).trigger, false, 'no ATR never triggers');
});

test('openOrExtendWindow: opens one, strengthens (no overlap), enforces per-day cap', () => {
  const p = db('open'); rmSync(p, { force: true });
  const r1 = openOrExtendWindow(p, { instrument: INST, direction: 'up', trigger: { rangeAtr: 1.6, volumeRatio: 2.1, price: 90 }, cfg, now: NOW });
  assert.equal(r1.action, 'opened');
  // a fresh qualifying move strengthens the SAME window, never a second one
  const r2 = openOrExtendWindow(p, { instrument: INST, direction: 'up', trigger: { rangeAtr: 2.9, volumeRatio: 3.0, price: 91 }, cfg, now: NOW + 60000 });
  assert.equal(r2.action, 'strengthened');
  assert.equal(r2.id, r1.id, 'same window id');
  assert.equal(getActiveWindow(p, INST).trigger_range_atr, 2.9, 'stronger displacement recorded');
  rmSync(p, { force: true });
});

test('openOrExtendWindow: per-day cap blocks a new window once maxWindowsPerDay reached', () => {
  const p = db('daycap'); rmSync(p, { force: true });
  const capCfg = { ...cfg, maxWindowsPerDay: 2 };
  // open+cancel twice (each counts toward the rolling-24h cap), then a 3rd is blocked
  for (let i = 0; i < 2; i++) { openOrExtendWindow(p, { instrument: INST, direction: 'up', cfg: capCfg, now: NOW + i }); cancelWindow(p, INST, { now: NOW + i }); }
  const r = openOrExtendWindow(p, { instrument: INST, direction: 'up', cfg: capCfg, now: NOW + 3 });
  assert.equal(r.action, 'day_cap_reached');
  rmSync(p, { force: true });
});

test('pollWindow: a novel credible incident confirms and attaches evidence; provider is charged', async () => {
  const p = db('confirm'); rmSync(p, { force: true });
  openOrExtendWindow(p, { instrument: INST, direction: 'up', trigger: { rangeAtr: 2.6 }, cfg, now: NOW });
  const fetcher = fetcherFor([rawArticle({ uri: 'inc1', title: 'Missile attack disrupts oil tanker near Hormuz', body: 'supply disruption' })]);
  const r = await pollWindow(p, { instrument: INST, query: QUERY, apiKey: 'k', cfg, now: NOW + 1000, fetcher });
  assert.equal(r.action, 'confirmed');
  assert.equal(r.evidence.length, 1);
  assert.equal(r.evidence[0].providerItemId, 'inc1');
  assert.equal(getActiveWindow(p, INST), null, 'window closed');
  assert.equal(providerRequestsUsed(p), 1, 'one chargeable getArticles recorded');
  rmSync(p, { force: true });
});

test('pollWindow: with windowMinutes>20, an article older than 20m but inside the lookback still confirms', async () => {
  const p = db('longwin'); rmSync(p, { force: true });
  const wideCfg = { ...cfg, windowMinutes: 30 };
  openOrExtendWindow(p, { instrument: INST, direction: 'up', cfg: wideCfg, now: NOW });
  // incident published 25m before the window opened — within the 30m lookback,
  // but outside the old hard-coded 20m classifier bound (the regression)
  const incident = rawArticle({ uri: 'inc30', title: 'Sanctions escalate on major oil exporter', body: 'embargo', dateTimePub: new Date(NOW - 25 * 60000).toISOString() });
  const r = await pollWindow(p, { instrument: INST, query: QUERY, apiKey: 'k', cfg: wideCfg, now: NOW + 1000, fetcher: fetcherFor([incident]) });
  assert.equal(r.action, 'confirmed', 'classifier lower-bound tracks the configured lookback');
  rmSync(p, { force: true });
});

test('pollWindow: routine commentary does not confirm — polls and bumps poll_count', async () => {
  const p = db('routine'); rmSync(p, { force: true });
  openOrExtendWindow(p, { instrument: INST, direction: 'up', cfg, now: NOW });
  const r = await pollWindow(p, { instrument: INST, query: QUERY, apiKey: 'k', cfg, now: NOW + 1000, fetcher: fetcherFor([rawArticle()]) });
  assert.equal(r.action, 'polled');
  assert.equal(r.pollCount, 1);
  assert.ok(getActiveWindow(p, INST), 'window stays open');
  rmSync(p, { force: true });
});

test('pollWindow: an already-seen article is not re-counted as fresh evidence (dedup)', async () => {
  const p = db('dedup'); rmSync(p, { force: true });
  openOrExtendWindow(p, { instrument: INST, direction: 'up', cfg, now: NOW });
  const incident = rawArticle({ uri: 'inc2', title: 'Drone strike hits oil facility', body: 'attack' });
  // first poll would confirm — but pre-seed the observation so it is NOT novel
  const seedRes = await pollWindow(p, { instrument: INST, query: QUERY, apiKey: 'k', cfg, now: NOW + 1000, fetcher: fetcherFor([incident]) });
  assert.equal(seedRes.action, 'confirmed'); // first sight confirms
  // reopen + same article → already seen → not fresh → no re-confirm
  openOrExtendWindow(p, { instrument: INST, direction: 'up', cfg, now: NOW + 2000 });
  const r = await pollWindow(p, { instrument: INST, query: QUERY, apiKey: 'k', cfg, now: NOW + 3000, fetcher: fetcherFor([incident]) });
  assert.equal(r.action, 'polled', 'deduped — no duplicate confirmation from a known item');
  rmSync(p, { force: true });
});

test('pollWindow: expired/unexplained past the deadline; no call made', async () => {
  const p = db('expire'); rmSync(p, { force: true });
  openOrExtendWindow(p, { instrument: INST, direction: 'up', cfg, now: NOW });
  let called = false;
  const r = await pollWindow(p, { instrument: INST, query: QUERY, apiKey: 'k', cfg, now: NOW + 16 * 60000, fetcher: async () => { called = true; return { ok: true, status: 200, text: async () => '{}' }; } });
  assert.equal(r.state, 'expired');
  assert.equal(r.stopReason, 'expired/unexplained');
  assert.equal(called, false, 'no provider call after the deadline');
  assert.equal(providerRequestsUsed(p), 0, 'no budget spent on an expired window');
  rmSync(p, { force: true });
});

test('pollWindow: exhausted budget and open circuit both stop as budget_blocked without a call', async () => {
  // budget
  const p1 = db('budget'); rmSync(p1, { force: true });
  openOrExtendWindow(p1, { instrument: INST, direction: 'up', cfg, now: NOW });
  const rB = await pollWindow(p1, { instrument: INST, query: QUERY, apiKey: 'k', cfg, now: NOW + 1000, budgetTotal: 0, fetcher: fetcherFor([]) });
  assert.equal(rB.state, 'budget_blocked');
  assert.equal(rB.stopReason, 'global_budget_exhausted');
  rmSync(p1, { force: true });
  // circuit
  const p2 = db('circuit'); rmSync(p2, { force: true });
  openOrExtendWindow(p2, { instrument: INST, direction: 'up', cfg, now: NOW });
  recordProviderCall(p2, 'newsapi-ai', INST, { ok: false, status: 401, now: NOW }); // opens the 6h circuit
  const rC = await pollWindow(p2, { instrument: INST, query: QUERY, apiKey: 'k', cfg, now: NOW + 1000, fetcher: fetcherFor([]) });
  assert.equal(rC.state, 'budget_blocked');
  assert.equal(rC.stopReason, 'circuit_open');
  rmSync(p2, { force: true });
});

test('pollWindow: mean reversion below the re-arm threshold closes as mean_reverted', async () => {
  const p = db('revert'); rmSync(p, { force: true });
  openOrExtendWindow(p, { instrument: INST, direction: 'up', cfg, now: NOW });
  const r = await pollWindow(p, { instrument: INST, query: QUERY, apiKey: 'k', cfg, now: NOW + 1000, currentRangeAtr: 0.3, fetcher: fetcherFor([]) });
  assert.equal(r.state, 'mean_reverted');
  rmSync(p, { force: true });
});

test('pollWindow: a provider error is charged, bumps poll_count, and never throws', async () => {
  const p = db('err'); rmSync(p, { force: true });
  openOrExtendWindow(p, { instrument: INST, direction: 'up', cfg, now: NOW });
  // fetcher THROWS directly (network error), distinct from an ok:false HTTP response
  const boom = async () => { const e = new Error('network down'); e.status = 429; throw e; };
  const r = await pollWindow(p, { instrument: INST, query: QUERY, apiKey: 'k', cfg, now: NOW + 1000, fetcher: boom });
  assert.equal(r.action, 'poll-error');
  assert.equal(getActiveWindow(p, INST).poll_count, 1, 'poll counted even on error');
  assert.equal(providerRequestsUsed(p), 1, 'the failed attempt is still charged (transient, circuit stays closed)');
  rmSync(p, { force: true });
});

test('correlationConfig: per-instrument overrides layer over defaults', () => {
  const settings = { correlation: { defaults: { moveAtr: 1.2 }, instruments: { 'WTICO/USD': { enabled: true, relativeVolume: 3 } } } };
  const c = correlationConfig('WTICO/USD', settings);
  assert.equal(c.enabled, true);
  assert.equal(c.moveAtr, 1.2, 'global default override');
  assert.equal(c.relativeVolume, 3, 'per-instrument override');
  assert.equal(c.windowMinutes, 15, 'untouched default preserved');
  assert.equal(correlationConfig('XAU/USD', settings).enabled, false, 'non-configured instrument stays opt-out');
});
