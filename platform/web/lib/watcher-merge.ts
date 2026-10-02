// An entry is an instrument and a timeframe, such as XAU/USD|M5. Anything else would corrupt the engine's list.
export const validPair = (key: string) => /^[^|,\s][^|,]*\|[A-Za-z0-9]+$/.test(key);

// The engine reads a watcher entry by trimming its parts, keeping their case, and defaulting the
// timeframe to M5 only when the entry has no separator. Every console reader of the list uses this
// one rule, so a bare entry such as WTICO/USD shows as WTICO/USD|M5 everywhere.
export function watcherEntries(csv: string | undefined): string[] {
  return (csv ?? '').split(',').map((c) => c.trim()).filter(Boolean).map((c) => {
    const [instrument, ...rest] = c.split('|');
    return `${instrument.trim()}|${rest.length ? rest[0].trim() : 'M5'}`;
  });
}

// Toggle one instrument and timeframe entry in the freshly read watcher list. Other entries stay as the server has them.
// A malformed entry leaves the list unchanged.
export function toggleWatcher(freshCsv: string | undefined, key: string): string[] {
  const list = watcherEntries(freshCsv);
  if (!validPair(key)) return list;
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
}
