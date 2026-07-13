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

const fmtPct = (v) => (v == null ? '   -   ' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}%`);

function aggregate(rows) {
  const bySymbol = new Map();
  for (const r of rows) {
    if (r.status !== 'ok') continue;
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push(r);
  }
  const out = [];
  for (const [symbol, list] of bySymbol) {
    const moves = list.map((r) => r.move);
    const abs = moves.map(Math.abs);
    const up = moves.filter((m) => m > 0).length;
    out.push({
      symbol,
      label: list[0].label,
      n: list.length,
      up,
      down: list.length - up,
      meanMove: moves.reduce((a, b) => a + b, 0) / list.length,
      meanAbsMove: abs.reduce((a, b) => a + b, 0) / list.length,
      maxAbsMove: Math.max(...abs),
    });
  }
  return out.sort((a, b) => b.meanAbsMove - a.meanAbsMove);
}

function markdown(meta, rows, aggs) {
  const L = [];
  L.push(`# Truth Social 2-week backtest`);
  L.push('');
  L.push(`Window: ${meta.since} .. ${meta.until}`);
  L.push(`Posts in window: ${meta.total} | high-signal: ${meta.high} | studies run: ${rows.length} | measured: ${rows.filter((r) => r.status === 'ok').length}`);
  L.push(`Method: single-feed (fxempire), pre ${meta.preMin}m -> post ${meta.postMin}m, split at first candle >= T (F2). Per-instrument routing (F1).`);
  L.push('');
  L.push(`## Per-instrument aggregate`);
  L.push('');
  L.push(`| instrument | n | up | down | mean move | mean |move| | max |move| |`);
  L.push(`| --- | --- | --- | --- | --- | --- | --- |`);
  for (const a of aggs) {
    L.push(`| ${a.label} (${a.symbol}) | ${a.n} | ${a.up} | ${a.down} | ${fmtPct(a.meanMove)} | ${fmtPct(a.meanAbsMove)} | ${fmtPct(a.maxAbsMove)} |`);
  }
  L.push('');
  L.push(`## Per-post events`);
  L.push('');
  L.push(`| time (UTC) | instrument | mode | move | maxUp | maxDn | reasons | text |`);
  L.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const r of rows) {
    const cells = r.status === 'ok'
      ? [r.mode, fmtPct(r.move), fmtPct(r.maxUp), fmtPct(r.maxDn)]
      : [r.status, '-', '-', '-'];
    L.push(`| ${r.at.slice(0, 16)} | ${r.label} (${r.symbol}) | ${cells.join(' | ')} | ${r.reasons} | ${r.text.slice(0, 60).replace(/\|/g, '/')} |`);
  }
  return L.join('\n');
}

function csv(rows) {
  const head = 'time,symbol,label,mode,status,move,maxUp,maxDn,reasons,text';
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = rows.map((r) => [r.at, r.symbol, r.label, r.mode || '', r.status,
    r.move ?? '', r.maxUp ?? '', r.maxDn ?? '', r.reasons, r.text.slice(0, 120)].map(esc).join(','));
  return [head, ...lines].join('\n');
}

async function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i]);
  }
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
        const s = await runStudy({ at: p.createdAtISO, market: inst.market, symbol: inst.symbol, preMin, postMin });
        rows.push({ ...s, label: inst.label, reasons, text: p.text });
      } catch (e) {
        rows.push({ at: p.createdAtISO, symbol: inst.symbol, label: inst.label, status: `err:${e.message.slice(0, 30)}`, reasons, text: p.text });
      }
    }
  }

  const meta = { since: new Date(sinceMs).toISOString().slice(0, 10), until: new Date(untilMs).toISOString().slice(0, 10), total: posts.length, high: high.length, preMin, postMin };
  const format = String(args.get('format') || 'markdown');
  process.stdout.write(`${format === 'csv' ? csv(rows) : markdown(meta, rows, aggregate(rows))}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`backtest error: ${e.message}\n`);
    process.exit(1);
  });
}
