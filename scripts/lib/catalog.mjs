// Loads the validated candle-symbol catalog (issue #7 F3).
// Separate from config/instruments.yaml (rates slugs) — candle fetches need
// these symbols. JSON, not YAML, so it parses with stdlib and imports directly.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CATALOG_PATH = fileURLToPath(new URL('../../config/candle-symbols.json', import.meta.url));

export function loadCatalog(path = CATALOG_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Flat map: "SYMBOL" -> { market, symbol, name }. Lets us validate that a
// routed instrument is actually a known-good candle symbol.
export function symbolIndex(catalog = loadCatalog()) {
  const idx = new Map();
  for (const [market, list] of Object.entries(catalog.markets || {})) {
    for (const entry of list) idx.set(entry.symbol, { market, symbol: entry.symbol, name: entry.name });
  }
  return idx;
}
