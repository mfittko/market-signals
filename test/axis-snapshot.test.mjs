import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  axisSnapshot, anonymized, recordSnapshot, axisExpectancy, promptHash, SNAPSHOT_SCHEMA_VERSION,
} from '../scripts/axis-snapshot.mjs';
import { storeCandles, recordSignal, withDb } from '../scripts/supertrend.mjs';

const WTI = 'WTICO/USD';
const fresh = () => join(mkdtempSync(join(tmpdir(), 'snap-')), 's.sqlite');
const t = (i) => new Date(Date.parse('2026-07-23T00:00:00Z') + i * 300000).toISOString();
const candle = (o, h, l, c, v, i) => ({ open: o, high: h, low: l, close: c, volume: v, time: t(i), complete: true });

// strong uptrend with a high-volume wide final bar
function trendingCandles(n = 220) {
  const cs = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + i * 0.3;
    cs.push(candle(base, base + 0.35, base - 0.15, base + 0.3, 100, i));
  }
  const lastBase = 100 + (n - 1) * 0.3;
  cs[n - 1] = candle(lastBase, lastBase + 1.6, lastBase - 0.2, lastBase + 1.4, 400, n - 1);
  return cs;
}

test('axisSnapshot: buy flip in a strong uptrend — every axis votes coherently', () => {
  const snap = axisSnapshot(trendingCandles(), { instrument: WTI, granularity: 'M5', flip: { signal: 'buy' } });
  assert.equal(snap.schema_version, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snap.flip, 'buy');
  assert.equal(snap.axes.trendStrength.verdict, 'trending', `adx ${snap.axes.trendStrength.adx}`);
  assert.equal(snap.axes.direction.verdict, 'aligned', 'ema regime + both HTF supertrends agree with the buy');
  assert.equal(snap.axes.impulse.verdict, 'impulsive', 'wide high-volume flip bar');
  assert.equal(snap.axes.location.verdict, 'aligned', 'buying above session vwap in an uptrend');
  assert.ok(['veto', 'clear'].includes(snap.axes.exhaustion.verdict));
  // sell against the same tape: direction flips to counter
  const sell = axisSnapshot(trendingCandles(), { instrument: WTI, granularity: 'M5', flip: { signal: 'sell' } });
  assert.equal(sell.axes.direction.verdict, 'counter');
  // no flip: alignment verdicts are null, state values still present
  const stateOnly = axisSnapshot(trendingCandles(), { instrument: WTI, granularity: 'M5' });
  assert.equal(stateOnly.axes.direction.verdict, null);
  assert.ok(stateOnly.axes.trendStrength.adx > 0);
  assert.equal(axisSnapshot(trendingCandles(20), { instrument: WTI, granularity: 'M5' }), null, 'too little data → null');
});

test('anonymized(): no timestamps, no symbols, no absolute prices leak to judge payloads', () => {
  const snap = axisSnapshot(trendingCandles(), { instrument: WTI, granularity: 'M5', flip: { signal: 'buy' } });
  const anon = anonymized(snap);
  const flat = JSON.stringify(anon);
  assert.ok(!flat.includes(WTI), 'no instrument symbol');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(flat), 'no ISO timestamps');
  assert.ok(!flat.includes('"vwapDistPct"'), 'absolute-ish pct dropped in favor of ATR multiples');
  assert.ok(anon.axes.impulse.rangeAtr != null, 'normalized values retained');
  assert.equal(anonymized(null), null);
});

test('recordSnapshot + axisExpectancy: outcomes bucket per axis verdict; dedup on re-record', () => {
  const db = fresh();
  // stored candles so signalOutcomes can compute a +30min outcome
  const cs = trendingCandles(240);
  storeCandles(db, WTI, 'M5', cs);
  const sigIndex = 200;
  const snapCandles = cs.slice(0, sigIndex + 1);
  const snap = axisSnapshot(snapCandles, { instrument: WTI, granularity: 'M5', flip: { signal: 'buy' } });
  assert.equal(snap.at, cs[sigIndex].time);
  recordSignal(db, WTI, 'M5', { time: cs[sigIndex].time, signal: 'buy', price: cs[sigIndex].close }, 60);
  assert.equal(recordSnapshot(db, snap, { filterVerdict: 'alert', filterModel: 'pi', filterPromptHash: promptHash('x') }), true);
  assert.equal(recordSnapshot(db, snap), false, 'INSERT OR IGNORE dedups');

  const exp = axisExpectancy(db, { instrument: WTI, granularity: 'M5' });
  assert.ok(exp.trendStrength.trending.signals >= 1);
  assert.equal(typeof exp.trendStrength.trending.expectancyPct, 'number');
  assert.ok(exp.direction.aligned, 'aligned bucket present for the buy in an uptrend');
  assert.equal(axisExpectancy(fresh()), null, 'no snapshots → null');
  const row = withDb(db, (d) => d.prepare('SELECT filter_prompt_hash, schema_version FROM signal_snapshots').get());
  assert.equal(row.schema_version, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(row.filter_prompt_hash, promptHash('x'), 'filter provenance recorded');
});
