#!/usr/bin/env node
// High-signal classifier + per-instrument routing (issue #7, component 2).
//
// F1: routing is load-bearing. Geopolitical/military/oil posts route to OIL
// (Brent+WTI), Fed/rates to INDICES+GOLD, trade/tariff to INDICES, named
// mega-cap/chip to INDICES. Measuring one broad proxy (NAS100 only) hides the
// strongest signal (Trump Iran posts -> Brent/WTI while equities dip), so the
// map targets validated candle symbols (F3) and aggregates are per-instrument.
import { readFileSync } from 'node:fs';
import { symbolIndex } from './lib/catalog.mjs';

// market-group -> [ [fxempireMarket, candleSymbol, label], ... ]
const GROUPS = {
  oil: [['commodities', 'BCO/USD', 'Brent'], ['commodities', 'WTICO/USD', 'WTI']],
  indices: [['indices', 'NAS100/USD', 'Nasdaq'], ['indices', 'US30/USD', 'Dow']],
  gold: [['commodities', 'XAU/USD', 'Gold']],
};

// Rule = keyword set -> instrument groups. First match(es) win; a post can hit
// several rules (e.g. "Fed + tariffs") and route to the union.
export const RULES = [
  {
    tag: 'geopolitical/oil',
    groups: ['oil'],
    // Deliberately geopolitical/oil-SPECIFIC. Generic domestic words (military,
    // war, strike, attack, troops) are excluded: Trump's endorsement boilerplate
    // ("Strengthen our Military/Veterans") fired them on ~20 near-zero events and
    // buried the real oil signal (F1 is about signal clarity, not recall).
    keywords: ['iran', 'iranian', 'israel', 'israeli', 'houthi', 'hormuz', 'opec',
      'oil', 'crude', 'brent', 'petroleum', 'barrel', 'missile', 'missiles',
      'nuclear', 'sanction', 'sanctions', 'tanker', 'bombing', 'ceasefire', 'warhead'],
  },
  {
    tag: 'fed/rates',
    groups: ['indices', 'gold'],
    keywords: ['fed', 'federal reserve', 'powell', 'fomc', 'interest rate', 'interest rates',
      'rate cut', 'rate hike', 'rate cuts', 'inflation', 'monetary', 'basis points'],
  },
  {
    tag: 'trade/tariff',
    groups: ['indices'],
    keywords: ['tariff', 'tariffs', 'trade deal', 'trade war', 'trade', 'import', 'imports',
      'export', 'exports', 'china', 'mexico', 'canada', 'eu'],
  },
  {
    tag: 'tech/mega-cap',
    groups: ['indices'],
    keywords: ['apple', 'nvidia', 'tesla', 'microsoft', 'amazon', 'google', 'chip', 'chips',
      'semiconductor', 'semiconductors'],
  },
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Word-ish boundary so "oil" doesn't match "toil" and "trade" doesn't match "trader".
const matches = (text, kw) => new RegExp(`(?:^|[^a-z])${esc(kw)}(?:$|[^a-z])`, 'i').test(text);

// classify(text, opts) -> { signal, instruments:[{market,symbol,label}], reasons:[{tag,keywords}] }
// threshold = min number of matched keywords to count as high-signal (default 1).
export function classify(text, { threshold = 1, index = symbolIndex() } = {}) {
  const t = String(text || '');
  const reasons = [];
  const groups = new Set();
  let hitCount = 0;

  for (const rule of RULES) {
    const hits = rule.keywords.filter((kw) => matches(t, kw));
    if (hits.length) {
      hitCount += hits.length;
      reasons.push({ tag: rule.tag, keywords: hits });
      for (const g of rule.groups) groups.add(g);
    }
  }

  const instruments = [];
  const seen = new Set();
  for (const g of groups) {
    for (const [market, symbol, label] of GROUPS[g] || []) {
      if (seen.has(symbol)) continue;
      // Guard: only route to symbols the F3 catalog validated.
      if (!index.has(symbol)) throw new Error(`route target ${symbol} not in candle catalog`);
      seen.add(symbol);
      instruments.push({ market, symbol, label });
    }
  }

  const signal = hitCount >= threshold && instruments.length > 0 ? 'high' : 'low';
  return { signal, instruments: signal === 'high' ? instruments : [], reasons };
}

function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i]);
  }
  if (args.has('help')) {
    process.stdout.write('classify-post — route a Truth Social post to instruments.\n  --text "..."   classify one post\n  --threshold N  min keyword hits for high-signal (default 1)\n  (no --text: reads JSONL {text} on stdin, emits JSONL)\n');
    return;
  }
  const threshold = Number(args.get('threshold') ?? 1);
  if (args.has('text')) {
    process.stdout.write(`${JSON.stringify(classify(String(args.get('text')), { threshold }), null, 2)}\n`);
    return;
  }
  const input = readFileSync(0, 'utf8');
  for (const line of input.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const post = JSON.parse(s);
    process.stdout.write(`${JSON.stringify({ ...post, ...classify(post.text || '', { threshold }) })}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`classify-post error: ${e.message}\n`);
    process.exit(1);
  }
}
