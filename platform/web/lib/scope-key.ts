// A string that names a scope list by its contents, so an effect can depend on the list
// without re-running every time a caller builds a new array with the same scopes.
export function scopeKey(scopes: { instrument: string; granularity: string }[]): string {
  return scopes.map((s) => `${s.instrument}|${s.granularity}`).join(',');
}
