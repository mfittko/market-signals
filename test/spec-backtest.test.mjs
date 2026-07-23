import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec, entryDecision, EXAMPLE_SPECS, SPEC_SCHEMA_VERSION } from '../scripts/strategy-spec.mjs';
import { replaySpec, walkForward, reportHash, canonical } from '../scripts/spec-backtest.mjs';
import { anonymizedReport, JUDGE_PROMPTS } from '../scripts/judge.mjs';

const t = (i) => new Date(Date.parse('2026-07-23T00:00:00Z') + i * 300000).toISOString();
const candle = (o, h, l, c, i) => ({ time: t(i), open: o, high: h, low: l, close: c, volume: 100, complete: 1 });

const goodAxes = {
  trendStrength: { adx: 30, verdict: 'trending' },
  direction: { emaRegime: 'bull', htfM15: 'up', htfH1: 'up', verdict: 'aligned' },
  impulse: { rangeAtr: 1.4, volumeRatio: 2, verdict: 'impulsive' },
  location: { vwapDistAtr: 0.4, verdict: 'aligned' },
  exhaustion: { rsi: 55, verdict: 'clear' },
};
const snap = (i, flip = 'buy', axes = goodAxes) => ({ time: t(i), snapshot: { schema_version: 1, at: t(i), flip, axes }, context: null });

test('validateSpec: examples pass; anonymization rejects dates and symbols at schema level', () => {
  for (const [name, spec] of Object.entries(EXAMPLE_SPECS)) {
    const v = validateSpec(spec);
    assert.deepEqual(v.errors, [], `${name} validates`);
  }
  assert.match(validateSpec({ schema_version: 1, entry: { minAxesAligned: 2, note: 'buy WTICO/USD' }, exit: { stopAtr: 1 } }).errors.join(' '), /symbols are forbidden/);
  assert.match(validateSpec({ schema_version: 1, entry: { minAxesAligned: 2, note: 'since 2026-07-01' }, exit: { stopAtr: 1 } }).errors.join(' '), /dates are forbidden/);
  assert.match(validateSpec({ schema_version: 2, entry: { minAxesAligned: 2 }, exit: { stopAtr: 1 } }).errors.join(' '), /schema_version/);
  assert.match(validateSpec({ schema_version: 1, entry: { minAxesAligned: 9 }, exit: { stopAtr: 1 } }).errors.join(' '), /1-5/);
  assert.match(validateSpec({ schema_version: 1, entry: { minAxesAligned: 2, require: { impulse: ['huge'] } }, exit: { stopAtr: 1 } }).errors.join(' '), /not a impulse verdict/);
});

test('entryDecision: N-of-axes voting, exhaustion veto, required-verdict attribution', () => {
  const spec = EXAMPLE_SPECS['conservative-trend'];
  assert.deepEqual(entryDecision(spec, snap(0).snapshot), { enter: true, vetoedBy: null });
  const vetoed = snap(0, 'buy', { ...goodAxes, exhaustion: { rsi: 75, verdict: 'veto' } }).snapshot;
  assert.deepEqual(entryDecision(spec, vetoed), { enter: false, vetoedBy: 'exhaustion' });
  const ranging = snap(0, 'buy', { ...goodAxes, trendStrength: { adx: 15, verdict: 'ranging' } }).snapshot;
  assert.equal(entryDecision(spec, ranging).vetoedBy, 'trendStrength', 'required-verdict miss attributes the axis');
  // N-of-axes: a 4-of-5 spec with only impulse required — 3 positives fall short
  const fourOfFive = { schema_version: 1, entry: { minAxesAligned: 4, require: { impulse: ['impulsive'] } }, exit: { stopAtr: 1 } };
  const threePositives = snap(0, 'buy', { ...goodAxes, trendStrength: { adx: 15, verdict: 'ranging' }, location: { verdict: 'counter' } }).snapshot;
  assert.equal(entryDecision(fourOfFive, threePositives).enter, false, 'insufficient aligned axes');
  assert.equal(entryDecision(fourOfFive, snap(0).snapshot).enter, true, 'all five axes clear the 4-of-5 bar');
});

// 60 candles: uptrend, one buy signal at bar 30, price rallies to target.
function fixtureMarket() {
  const candles = [];
  for (let i = 0; i < 60; i++) {
    const base = 100 + i * 0.1;
    candles.push(candle(base, base + 0.3, base - 0.3, base + 0.1, i));
  }
  return candles;
}

test('replaySpec: deterministic (identical hash on re-run), trades fill via ATR exits, vetoes attributed', () => {
  const candles = fixtureMarket();
  const snaps = [snap(25, 'buy', { ...goodAxes, exhaustion: { rsi: 80, verdict: 'veto' } }), snap(30, 'buy')];
  const spec = EXAMPLE_SPECS['conservative-trend'];
  const r1 = replaySpec(spec, snaps, candles);
  const r2 = replaySpec(spec, snaps, candles);
  assert.equal(r1.ok, true);
  assert.equal(reportHash(r1), reportHash(r2), 'same input, same hash — CI determinism contract');
  assert.equal(r1.metrics.entered, 1, 'veto blocked the second signal');
  assert.equal(r1.vetoAttribution.exhaustion, 1);
  assert.ok(['target', 'stop', 'time-stop'].includes(r1.trades[0].reason));
  assert.equal(typeof r1.metrics.expectancyPct, 'number');
  const bad = replaySpec({ schema_version: 1, entry: { minAxesAligned: 1 }, exit: {} }, snaps, candles);
  assert.equal(bad.ok, false, 'invalid spec rejected, not silently replayed');
});

test('replaySpec: one position at a time — overlapping signals are skipped', () => {
  const candles = fixtureMarket();
  const spec = { ...EXAMPLE_SPECS['conservative-trend'], exit: { stopAtr: 5, targetAtr: 50, timeStopBars: 20 } };
  const snaps = [snap(30, 'buy'), snap(32, 'buy'), snap(34, 'buy')];
  const r = replaySpec(spec, snaps, candles);
  assert.equal(r.metrics.entered, 1, 'signals inside an open trade are not entered');
});

test('walkForward: split boundaries, candidatesTried, mechanical promotion gate', () => {
  const candles = fixtureMarket();
  const snaps = [snap(10, 'buy'), snap(45, 'buy'), snap(50, 'buy')];
  const wf = walkForward(EXAMPLE_SPECS, snaps, candles, { trainPct: 0.5, minValidationTrades: 1, minValidationExpectancy: -100 });
  assert.equal(wf.candidatesTried, 2);
  assert.equal(wf.promotionGate.mechanical, true);
  for (const r of wf.results.filter((x) => x.ok)) {
    assert.ok(r.train.signals <= snaps.length);
    assert.equal(typeof r.promoted, 'boolean');
  }
  const trainSignals = wf.results[0].train.signals;
  const valSignals = wf.results[0].validation.signals;
  assert.equal(trainSignals + valSignals, snaps.length, 'no signal is in both windows (no leakage)');
});

test('canonical(): key order never changes the hash', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), canonical({ a: [2, { c: 4, d: 3 }], b: 1 }));
});

test('anonymizedReport: no window/instrument/timestamps reach the meta judge; prompts are versioned', () => {
  const wf = walkForward(EXAMPLE_SPECS, [snap(10, 'buy')], fixtureMarket(), { trainPct: 0.5 });
  wf.window = { instrument: 'WTICO/USD', granularity: 'M5' };
  const anon = anonymizedReport(wf);
  const flat = JSON.stringify(anon);
  assert.ok(!flat.includes('WTICO'), 'no instrument');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(flat), 'no timestamps');
  assert.ok(JUDGE_PROMPTS.meta.version && JUDGE_PROMPTS.perSignal.version, 'judge prompts carry versions');
});
