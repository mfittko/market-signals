// The control plane and the console run the same build only when both report the same known commit.
// Two builds without a commit both report "unknown", which proves nothing.
export function sameBuild(apiCommit: string | undefined, consoleCommit: string): boolean {
  return consoleCommit !== 'unknown' && apiCommit === consoleCommit;
}
