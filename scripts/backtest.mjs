#!/usr/bin/env node
// Backtest runner (issue #7, component 4). LIVE — smoke-only, never a unit test.
//
// Pipeline: ingest (CNN archive) -> classify (F1 per-instrument routing) ->
// event-study each high-signal post on ITS mapped instruments, single-feed (F2)
// -> markdown/CSV report. Aggregates are PER-INSTRUMENT (F1): a broad proxy
// hides the geopolitical->oil signal, so we never collapse markets together.
import { readFileSync } from 'node:fs';
import { ingest, ARCHIVE_URL } from './fetch-trump-posts.mjs';
import { classify } from './classify-post.mjs';
import { runStudy, DEFAULT_HORIZONS } from './event-study.mjs';

const fmtPct = (v) => (v == null ? '   -   ' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}%`);

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// Per-event reactivity magnitude = the larger of the up/down excursion (issue #10:
// magnitude is the signal, endpoint sign is not).
const reactivity = (r) => Math.max(r.maxUp ?? 0, -(r.maxDn ?? 0));
// Signed close-move at the 15m horizon (secondary), falling back to full window.
const move15 = (r) => r.horizons?.['15']?.move ?? r.move;

// PRIMARY aggregate is the max-excursion distribution per instrument (F1). Signed
// mean move is kept as a secondary column only.
export function aggregate(rows) {
  const bySymbol = new Map();
  for (const r of rows) {
    if (r.status !== 'ok') continue;
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push(r);
  }
  const out = [];
  for (const [symbol, list] of bySymbol) {
    const exc = list.map(reactivity);
    const signed = list.map(move15);
    const up = signed.filter((m) => m > 0).length;
    out.push({
      symbol,
      label: list[0].label,
      n: list.length,
      up,
      down: list.length - up,
      meanExc: mean(exc),
      medianExc: median(exc),
      maxExc: Math.max(...exc),
      meanMove15: mean(signed),
    });
  }
  return out.sort((a, b) => b.meanExc - a.meanExc); // rank by reactivity, not sign
}

export function markdown(meta, rows, aggs) {
  const hs = meta.horizons || DEFAULT_HORIZONS;
  const L = [];
  L.push(`# Truth Social 2-week backtest`);
  L.push('');
  L.push(`Window: ${meta.since} .. ${meta.until}`);
  L.push(`Posts in window: ${meta.total} | high-signal: ${meta.high} | studies run: ${rows.length} | measured: ${rows.filter((r) => r.status === 'ok').length}`);
  L.push(`Method: single-feed (fxempire ${meta.granularity || 'M1'}), pre ${meta.preMin}m -> horizons ${hs.join('/')}m, split at first candle >= T (F2). Per-instrument routing (F1).`);
  L.push(`Primary metric: max-excursion (reactivity magnitude); signed close-move per horizon is secondary.`);
  L.push('');
  L.push(`## Per-instrument aggregate (excursion distribution)`);
  L.push('');
  L.push(`| instrument | n | mean exc | median exc | max exc | mean move (15m) | up | down |`);
  L.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const a of aggs) {
    L.push(`| ${a.label} (${a.symbol}) | ${a.n} | ${fmtPct(a.meanExc)} | ${fmtPct(a.medianExc)} | ${fmtPct(a.maxExc)} | ${fmtPct(a.meanMove15)} | ${a.up} | ${a.down} |`);
  }
  L.push('');
  L.push(`## Per-post events (maxUp/maxDn primary; signed close-move per horizon)`);
  L.push('');
  L.push(`| time (UTC) | instrument | mode | maxUp | maxDn | ${hs.map((h) => `+${h}m`).join(' | ')} | reasons | text |`);
  L.push(`| --- | --- | --- | --- | --- | ${hs.map(() => '---').join(' | ')} | --- | --- |`);
  for (const r of rows) {
    const moves = hs.map((h) => fmtPct(r.horizons?.[h]?.move));
    const cells = r.status === 'ok'
      ? [r.mode, fmtPct(r.maxUp), fmtPct(r.maxDn), ...moves]
      : [r.status, '-', '-', ...hs.map(() => '-')];
    L.push(`| ${r.at.slice(0, 16)} | ${r.label} (${r.symbol}) | ${cells.join(' | ')} | ${r.reasons} | ${r.text.slice(0, 60).replace(/\|/g, '/')} |`);
  }
  return L.join('\n');
}

function csv(rows, hs = DEFAULT_HORIZONS) {
  const head = ['time', 'symbol', 'label', 'mode', 'status', 'maxUp', 'maxDn',
    ...hs.map((h) => `move_${h}m`), 'reasons', 'text'].join(',');
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = rows.map((r) => [r.at, r.symbol, r.label, r.mode || '', r.status,
    r.maxUp ?? '', r.maxDn ?? '', ...hs.map((h) => r.horizons?.[h]?.move ?? ''),
    r.reasons, r.text.slice(0, 120)].map(esc).join(','));
  return [head, ...lines].join('\n');
}

async function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i]);
  }
  if (args.has('help')) {
    process.stdout.write('backtest — 2-week Truth Social -> multi-horizon market impact report (LIVE).\n  --since <ISO> --until <ISO>\n  --posts <file>   use a pre-fetched ingestion JSON (skip archive fetch)\n  --pre <min>      pre window (default 5)\n  --horizons <l>   comma-separated post horizons in min (default 1,5,15,60)\n  --granularity <g>  M1|M5|H1 (default M1)\n  --cap <n>        max high-signal posts to study (live budget, default 40)\n  --format markdown|csv   (default markdown)\n');
    return;
  }
  const now = Date.now();
  const sinceMs = args.has('since') ? Date.parse(String(args.get('since'))) : now - 14 * 864e5;
  const untilMs = args.has('until') ? Date.parse(String(args.get('until'))) : now;
  const preMin = Number(args.get('pre') ?? 5);
  const horizons = args.has('horizons')
    ? String(args.get('horizons')).split(',').map(Number).filter((n) => n > 0)
    : DEFAULT_HORIZONS;
  const granularity = String(args.get('granularity') || 'M1');
  const cap = Number(args.get('cap') ?? 40);

  let posts;
  if (args.has('posts')) {
    posts = ingest(JSON.parse(readFileSync(String(args.get('posts')), 'utf8')), { sinceMs, untilMs });
  } else {
    const res = await fetch(String(args.get('url') || ARCHIVE_URL), { headers: { accept: 'application/json' } });
    posts = ingest(await res.json(), { sinceMs, untilMs });
  }

  const high = posts.map((p) => ({ ...p, ...classify(p.text) })).filter((p) => p.signal === 'high');
  const studied = high.slice(0, cap);

  const rows = [];
  for (const p of studied) {
    for (const inst of p.instruments) {
      const reasons = p.reasons.map((r) => r.tag).join(';');
      try {
        const s = await runStudy({ at: p.createdAtISO, market: inst.market, symbol: inst.symbol, preMin, horizons, granularity });
        rows.push({ ...s, label: inst.label, reasons, text: p.text });
      } catch (e) {
        rows.push({ at: p.createdAtISO, symbol: inst.symbol, label: inst.label, status: `err:${e.message.slice(0, 30)}`, reasons, text: p.text });
      }
    }
  }

  const meta = { since: new Date(sinceMs).toISOString().slice(0, 10), until: new Date(untilMs).toISOString().slice(0, 10), total: posts.length, high: high.length, preMin, horizons, granularity };
  const format = String(args.get('format') || 'markdown');
  process.stdout.write(`${format === 'csv' ? csv(rows, horizons) : markdown(meta, rows, aggregate(rows))}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`backtest error: ${e.message}\n`);
    process.exit(1);
  });
}
