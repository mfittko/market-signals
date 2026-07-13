import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, markdown } from '../scripts/backtest.mjs';

// Synthetic study rows (as runStudy would emit) — no network. Issue #10: the
// aggregate must rank by max-excursion (reactivity magnitude), not signed mean.
function row(symbol, maxUp, maxDn, move15) {
  return {
    at: '2026-07-10T14:35:00Z', symbol, label: symbol, status: 'ok', mode: 'in-session',
    maxUp, maxDn, move: move15, reasons: 'test', text: 'x',
    horizons: { 1: { move: 0 }, 5: { move: 0 }, 15: { move: move15 }, 60: { move: move15 } },
  };
}

test('aggregate promotes max-excursion to the primary distribution', () => {
  const rows = [
    // Brent: sign flips (+0.5 / -0.6) but excursion is consistently large.
    row('BCO/USD', 0.7, -0.1, 0.5),
    row('BCO/USD', 0.6, -0.9, -0.6),
    // Gold: small excursion.
    row('XAU/USD', 0.2, -0.1, 0.15),
  ];
  const aggs = aggregate(rows);
  // Ranked by mean excursion: Brent first despite its near-zero signed mean.
  assert.equal(aggs[0].symbol, 'BCO/USD');
  assert.ok(aggs[0].meanExc > aggs[1].meanExc, 'ranked by reactivity, not sign');
  // reactivity = max(maxUp, -maxDn): 0.7 and 0.9 -> mean 0.8, median 0.8, max 0.9
  assert.ok(Math.abs(aggs[0].meanExc - 0.8) < 1e-9, `meanExc ${aggs[0].meanExc}`);
  assert.ok(Math.abs(aggs[0].maxExc - 0.9) < 1e-9, `maxExc ${aggs[0].maxExc}`);
  // Secondary signed 15m mean stays near zero — proves it is NOT the ranking key.
  assert.ok(Math.abs(aggs[0].meanMove15) < 0.1, `meanMove15 ${aggs[0].meanMove15}`);
});

test('markdown report renders per-horizon columns and excursion aggregate', () => {
  const rows = [row('BCO/USD', 0.7, -0.1, 0.5)];
  const meta = { since: '2026-06-26', until: '2026-07-10', total: 1, high: 1, preMin: 5, horizons: [1, 5, 15, 60], granularity: 'M1' };
  const md = markdown(meta, rows, aggregate(rows));
  assert.match(md, /mean exc/);
  assert.match(md, /\+1m \| \+5m \| \+15m \| \+60m/);
  assert.match(md, /Primary metric: max-excursion/);
});
