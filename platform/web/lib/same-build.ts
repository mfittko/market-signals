// The control plane and the console run the same build only when both report the same known commit.
// An unknown commit on either side proves neither a match nor a mismatch, so it is "unverified".
export type BuildMatch = 'same' | 'unverified' | 'differ';

export function buildMatch(apiCommit: string | undefined, consoleCommit: string): BuildMatch {
  if (!apiCommit || apiCommit === 'unknown' || consoleCommit === 'unknown') return 'unverified';
  return apiCommit === consoleCommit ? 'same' : 'differ';
}
