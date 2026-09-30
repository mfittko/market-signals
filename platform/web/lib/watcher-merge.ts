// Toggle one instrument and timeframe entry in the freshly read watcher list. Other entries stay as the server has them.
export function toggleWatcher(freshCsv: string | undefined, key: string): string[] {
  const list = (freshCsv ?? '').split(',').map((c) => c.trim().replace(/\s*\|\s*/, '|')).filter(Boolean);
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
}
