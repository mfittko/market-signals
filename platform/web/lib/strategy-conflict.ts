// Maps a failed strategy write to the conflict the page shows. A stale base version
// (platform/docs/write-preconditions.md) gets the server text, the current version and a Reload action.
// Any other failure returns null and the page shows the plain error.
export type StrategyConflict = { text: string; currentVersion: number; reload: true };

export function strategyConflict(status: number | undefined, body: Record<string, unknown> | undefined): StrategyConflict | null {
  if (status !== 409 || body?.code !== 'stale_base_version') return null;
  const currentVersion = Number(body.currentVersion);
  const head = [body.error, body.hint].filter(Boolean).join(': ');
  return { text: `${head}. The current version is v${currentVersion}. Your draft is kept until you reload.`, currentVersion, reload: true };
}
