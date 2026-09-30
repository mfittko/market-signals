// An entry is an instrument and a timeframe, such as XAU/USD|M5. Anything else would corrupt the engine's list.
export const validPair = (key: string) => /^[^|,\s][^|,]*\|[A-Za-z0-9]+$/.test(key);

// Toggle one instrument and timeframe entry in the freshly read watcher list. Other entries stay as the server has them.
// A malformed entry leaves the list unchanged.
export function toggleWatcher(freshCsv: string | undefined, key: string): string[] {
  const list = (freshCsv ?? '').split(',').map((c) => c.trim().replace(/\s*\|\s*/, '|')).filter(Boolean);
  if (!validPair(key)) return list;
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
}
