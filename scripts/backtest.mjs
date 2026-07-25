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
import { runStudy } from './event-study.mjs';
import { parseArgs, isMain } from './lib/cli.mjs';

const fmtPct = (v) => (v == null ? '   -   ' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}%`);

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const nums = (a) => a.filter((v) => v != null && Number.isFinite(v));

export function aggregate(rows) {
  const bySymbol = new Map();
  for (const r of rows) {
    if (r.status !== 'ok') continue;
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push(r);
  }
  const out = [];
  for (const [symbol, list] of bySymbol) {
    // #10: excursion (magnitude) is the primary, stable reactivity read; the
    // signed close-move is retained but secondary (its sign is noisy run-to-run).
    const exc = nums(list.map((r) => r.maxExcursion));
    const ups = nums(list.map((r) => r.maxUp));
    const dns = nums(list.map((r) => r.maxDn));
    const moves = nums(list.map((r) => r.move));
    out.push({
      symbol,
      label: list[0].label,
      n: list.length,
      up: moves.filter((m) => m > 0).length,
      down: moves.filter((m) => m < 0).length,
      meanExcursion: mean(exc),
      maxExcursion: exc.length ? Math.max(...exc) : null,
      meanMaxUp: mean(ups),
      meanMaxDn: mean(dns),
      meanMove: mean(moves),
    });
  }
  return out.sort((a, b) => (b.meanExcursion ?? -1) - (a.meanExcursion ?? -1));
}

function markdown(meta, rows, aggs) {
  const L = [];
  L.push(`# Truth Social 2-week backtest`);
  L.push('');
  L.push(`Window: ${meta.since} .. ${meta.until}`);
  L.push(`Posts in window: ${meta.total} | high-signal: ${meta.high} | studies run: ${rows.length} | measured: ${rows.filter((r) => r.status === 'ok').length}`);
  L.push(`Method: single-feed (fxempire), pre ${meta.preMin}m -> post ${meta.postMin}m, split at first candle >= T (F2). Per-instrument routing (F1).`);
  L.push('');
  const horizons = meta.horizons || [1, 5, 15, 60];
  const hCols = horizons.map((h) => `+${h}m`);
  L.push(`## Per-instrument aggregate <small>(excursion = primary reactivity; signed move is secondary/noisy)</small>`);
  L.push('');
  L.push(`| instrument | n | up | down | mean excursion | max excursion | mean maxUp | mean maxDn | mean move |`);
  L.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const a of aggs) {
    L.push(`| ${a.label} (${a.symbol}) | ${a.n} | ${a.up} | ${a.down} | ${fmtPct(a.meanExcursion)} | ${fmtPct(a.maxExcursion)} | ${fmtPct(a.meanMaxUp)} | ${fmtPct(a.meanMaxDn)} | ${fmtPct(a.meanMove)} |`);
  }
  L.push('');
  L.push(`## Per-post events`);
  L.push('');
  L.push(`| time (UTC) | instrument | mode | maxUp | maxDn | ${hCols.join(' | ')} | reasons | text |`);
  L.push(`| --- | --- | --- | --- | --- | ${horizons.map(() => '---').join(' | ')} | --- | --- |`);
  for (const r of rows) {
    const cells = r.status === 'ok'
      ? [r.mode, fmtPct(r.maxUp), fmtPct(r.maxDn), ...horizons.map((h) => fmtPct(r.moves?.[`${h}m`]))]
      : [r.status, '-', '-', ...horizons.map(() => '-')];
    L.push(`| ${r.at.slice(0, 16)} | ${r.label} (${r.symbol}) | ${cells.join(' | ')} | ${r.reasons} | ${r.text.slice(0, 60).replace(/\|/g, '/')} |`);
  }
  return L.join('\n');
}

function csv(rows, horizons = [1, 5, 15, 60]) {
  const hCols = horizons.map((h) => `move_${h}m`);
  const head = ['time', 'symbol', 'label', 'mode', 'status', 'maxExcursion', 'maxUp', 'maxDn', 'move', ...hCols, 'reasons', 'text'].join(',');
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = rows.map((r) => [r.at, r.symbol, r.label, r.mode || '', r.status,
    r.maxExcursion ?? '', r.maxUp ?? '', r.maxDn ?? '', r.move ?? '',
    ...horizons.map((h) => r.moves?.[`${h}m`] ?? ''), r.reasons, r.text.slice(0, 120)].map(esc).join(','));
  return [head, ...lines].join('\n');
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.has('help')) {
    process.stdout.write('backtest — 2-week Truth Social -> market impact report (LIVE).\n  --since <ISO> --until <ISO>\n  --posts <file>   use a pre-fetched ingestion JSON (skip archive fetch)\n  --pre <min> --post <min>   study windows (default 5/15)\n  --cap <n>        max high-signal posts to study (live budget, default 40)\n  --format markdown|csv   (default markdown)\n');
    return;
  }
  const now = Date.now();
  const sinceMs = args.has('since') ? Date.parse(String(args.get('since'))) : now - 14 * 864e5;
  const untilMs = args.has('until') ? Date.parse(String(args.get('until'))) : now;
  const preMin = Number(args.get('pre') ?? 5);
  const postMin = Number(args.get('post') ?? 15);
  const cap = Number(args.get('cap') ?? 40);
  const horizons = args.has('horizons')
    ? String(args.get('horizons')).split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0)
    : [1, 5, 15, 60];

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
        const s = await runStudy({ at: p.createdAtISO, market: inst.market, symbol: inst.symbol, preMin, postMin, horizons });
        rows.push({ ...s, label: inst.label, reasons, text: p.text });
      } catch (e) {
        rows.push({ at: p.createdAtISO, symbol: inst.symbol, label: inst.label, status: `err:${e.message.slice(0, 30)}`, reasons, text: p.text });
      }
    }
  }

  const meta = { since: new Date(sinceMs).toISOString().slice(0, 10), until: new Date(untilMs).toISOString().slice(0, 10), total: posts.length, high: high.length, preMin, postMin, horizons };
  const format = String(args.get('format') || 'markdown');
  process.stdout.write(`${format === 'csv' ? csv(rows, horizons) : markdown(meta, rows, aggregate(rows))}\n`);
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`backtest error: ${e.message}\n`);
    process.exit(1);
  });
}
