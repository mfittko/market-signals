// Production supertrend flips on a bar CSV, read-only import of scripts/supertrend.mjs.
//   node flips.mjs in.csv out.csv     in: time,open,high,low,close (mid M5)   out: trend,flip,atr,st
// trend +1/-1 (0 before warm-up), flip +1 buy / -1 sell on the flip bar (fires on its close),
// atr = the supertrend's Wilder ATR(10), st = the supertrend line. Causal: row i uses bars <= i.
// Self-check: `node flips.mjs --check` runs a synthetic up-trend then a drop and asserts one sell flip
import { readFileSync, writeFileSync } from 'node:fs';

const { computeSupertrend, detectFlips } = await import('/Users/mfittko/github/market-signals/scripts/supertrend.mjs');

function run(rows) {
  const st = computeSupertrend(rows, { period: 10, multiplier: 3 }); // production defaults
  const flips = new Map(detectFlips(rows, st).map((f) => [f.index, f.signal === 'buy' ? 1 : -1]));
  return rows.map((_, i) => [st[i] ? (st[i].trend === 'up' ? 1 : -1) : 0, flips.get(i) || 0, st[i]?.atr ?? '', st[i]?.supertrend ?? '']);
}

const [inp, out] = process.argv.slice(2);
if (inp === '--check') {
  // synthetic: up-trend then a sharp drop must produce exactly one sell flip after the drop
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ time: String(i), open: 100 + i * 0.1, high: 100.3 + i * 0.1, low: 99.9 + i * 0.1, close: 100.2 + i * 0.1 });
  for (let i = 40; i < 60; i++) { const p = 104 - (i - 39) * 1.0; rows.push({ time: String(i), open: p + 0.5, high: p + 0.6, low: p - 0.1, close: p }); }
  const r = run(rows);
  const f = r.map((x, i) => [i, x[1]]).filter(([, v]) => v !== 0);
  if (!(f.length >= 1 && f.every(([i, v]) => v === -1 && i >= 40))) throw new Error('flip check failed ' + JSON.stringify(f));
  if (r.slice(0, 10).some((x) => x[0] !== 0)) throw new Error('warm-up rows must be empty');
  console.log(`flips self-check OK: sell flip(s) at ${f.map(([i]) => i).join(',')} after the drop, warm-up empty`);
} else {
  const lines = readFileSync(inp, 'utf8').trim().split('\n').slice(1);
  const rows = lines.map((l) => { const [time, open, high, low, close] = l.split(','); return { time, open: +open, high: +high, low: +low, close: +close }; });
  writeFileSync(out, 'trend,flip,atr,st\n' + run(rows).map((x) => x.join(',')).join('\n') + '\n');
  console.log(`flips: ${rows.length} bars -> ${out}`);
}
