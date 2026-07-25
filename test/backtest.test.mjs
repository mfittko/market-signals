import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from '../scripts/backtest.mjs';

// Hermetic: aggregate is pure over computeStudy rows (no network). #10 makes the
// excursion the primary per-instrument reactivity read, signed move secondary.
const row = (symbol, over) => ({ status: 'ok', symbol, label: symbol, ...over });

test('aggregate (#10): excursion is the primary read and the sort key; signed move retained but secondary', () => {
  const rows = [
    // BCO: small, sign-flipping close-move but a large, consistent excursion
    row('BCO/USD', { move: 0.1, maxUp: 0.7, maxDn: -0.1, maxExcursion: 0.7 }),
    row('BCO/USD', { move: -0.2, maxUp: 0.6, maxDn: -0.2, maxExcursion: 0.6 }),
    // XAU: bigger signed moves but smaller excursion
    row('XAU/USD', { move: 0.3, maxUp: 0.3, maxDn: -0.05, maxExcursion: 0.3 }),
  ];
  const aggs = aggregate(rows);
  // sorted by mean excursion → BCO (0.65) ranks above XAU (0.3)
  assert.deepEqual(aggs.map((a) => a.symbol), ['BCO/USD', 'XAU/USD'], 'ranked by mean excursion, not signed move');
  const bco = aggs.find((a) => a.symbol === 'BCO/USD');
  assert.equal(bco.n, 2);
  assert.ok(Math.abs(bco.meanExcursion - 0.65) < 1e-9, 'mean excursion is the headline');
  assert.ok(Math.abs(bco.maxExcursion - 0.7) < 1e-9, 'max excursion reported');
  assert.ok(Math.abs(bco.meanMaxUp - 0.65) < 1e-9 && Math.abs(bco.meanMaxDn - (-0.15)) < 1e-9, 'excursion distribution (up/dn) reported');
  assert.ok(Math.abs(bco.meanMove - (-0.05)) < 1e-9, 'signed move retained but secondary (near-zero here despite big excursion)');
  assert.equal(bco.up, 1, 'up/down counts from the signed move');
  assert.equal(bco.down, 1);
});

test('aggregate: skips non-ok rows and tolerates an ok row missing excursion', () => {
  const rows = [
    row('BCO/USD', { move: 0.5, maxUp: 0.6, maxDn: -0.1, maxExcursion: 0.6 }),
    row('BCO/USD', { move: 0.2, maxUp: 0.3, maxDn: -0.05 }), // ok but maxExcursion absent
    { status: 'closed/no-data', symbol: 'BCO/USD', label: 'BCO/USD' },
    { status: 'err:x', symbol: 'XAU/USD', label: 'XAU/USD' },
  ];
  const aggs = aggregate(rows);
  assert.equal(aggs.length, 1, 'only ok rows aggregate; err/closed skipped');
  const a = aggs[0];
  assert.equal(a.n, 2, 'both ok rows counted');
  // the excursion-less row is simply omitted from the excursion stats, not NaN
  assert.ok(Math.abs(a.meanExcursion - 0.6) < 1e-9, 'mean excursion from the row that has it');
  assert.ok(Math.abs(a.maxExcursion - 0.6) < 1e-9, 'max excursion finite');
  assert.ok(Number.isFinite(a.meanMove), 'signed-move stats stay finite');
});
