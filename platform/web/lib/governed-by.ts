// The sentence the run page shows about the strategy that governs a run. A run carries
// the console strategy frozen at enqueue; without one the engine's strategy governs.
// A run stored before runs froze a strategy names the strategy in its snapshot.
type Ref = { name?: unknown; version?: unknown } | null | undefined;

export function governedBy(frozen: Ref, payload: { engineStrategy?: Ref; strategy?: Ref }): string {
  const engine = payload.engineStrategy?.name;
  if (frozen?.name) return `Governed by console strategy ${frozen.name}, version ${frozen.version}. Engine strategy: ${engine ?? 'none recorded'}.`;
  if (engine) return `Governed by the engine's strategy ${engine}.`;
  return `Governed by the strategy in its snapshot: ${payload.strategy?.name ?? 'none recorded'}.`;
}
