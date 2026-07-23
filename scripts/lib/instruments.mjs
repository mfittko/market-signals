// Loader for config/instruments.yaml (issue #86): the rate-slug catalog now
// also carries a hand-maintained `sentinel` query + `yahooSymbol` per slug.
// Never guess — an instrument without a committed entry gets no sentinel
// config; callers must handle that (skip it), not fabricate a query.
import { readFileSync } from 'node:fs';

const DEFAULT_PATH = 'config/instruments.yaml';

// Minimal line-parser (no yaml dep, mirrors signal-server.mjs's existing
// slug-only parser): groups scalar fields under each `- slug:` entry, itself
// grouped under a `  <market>:` header.
export function loadInstrumentsConfig(path = DEFAULT_PATH) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return { markets: {} }; }
  const markets = {};
  let market = null;
  let entry = null;
  for (const line of text.split('\n')) {
    const marketMatch = line.match(/^ {2}(\w[\w-]*):\s*$/);
    if (marketMatch) { market = marketMatch[1]; markets[market] = []; entry = null; continue; }
    const slugMatch = line.match(/^ {4}- slug:\s*(\S+)\s*$/);
    if (slugMatch && market) {
      entry = { slug: slugMatch[1] };
      markets[market].push(entry);
      continue;
    }
    if (!entry) continue;
    const fieldMatch = line.match(/^ {6}(\w+):\s*(.+?)\s*$/);
    if (fieldMatch) {
      const [, key, rawVal] = fieldMatch;
      entry[key] = /^".*"$/.test(rawVal) ? JSON.parse(rawVal) : rawVal;
    }
  }
  return { markets };
}

export function rateSlugsByMarket(cfg = loadInstrumentsConfig()) {
  const out = {};
  for (const [market, entries] of Object.entries(cfg.markets)) out[market] = entries.map((e) => e.slug);
  return out;
}

export function findInstrumentBySlug(slug, cfg = loadInstrumentsConfig()) {
  for (const entries of Object.values(cfg.markets)) {
    const hit = entries.find((e) => e.slug === slug);
    if (hit) return hit;
  }
  return null;
}

// Candle-symbol instruments (WTICO/USD, XAU/USD, ...; config/candle-symbols.json)
// are a DIFFERENT identifier space from the FXEmpire rate slugs above. This is
// the one static bridge between the two, covering the instruments with a
// committed sentinel query — extend here (never regex-guess) as more arrive.
export const SYMBOL_TO_SLUG = {
  'WTICO/USD': 'wti-crude-oil',
  'BCO/USD': 'brent-crude-oil',
  'XAU/USD': 'gold',
  'XAG/USD': 'silver',
  'XPT/USD': 'platinum',
  'NATGAS/USD': 'natural-gas',
  'SPX500/USD': 'spx',
};

export function sentinelConfigForInstrument(instrument, cfg = loadInstrumentsConfig()) {
  const slug = SYMBOL_TO_SLUG[instrument];
  if (!slug) return null;
  const entry = findInstrumentBySlug(slug, cfg);
  if (!entry?.sentinel) return null;
  return { instrument, slug, query: entry.sentinel, yahooSymbol: entry.yahooSymbol || null };
}
