// A poll result may land after a newer check replaced the run. Keep it only when it is still for the current run.
export function applyPoll<T extends { runId?: number }>(current: T | undefined, polledRunId: number, patch: Partial<T>): T | undefined {
  if (!current || current.runId !== polledRunId) return current;
  return { ...current, ...patch };
}
