// Keeps the chosen agent among the agents the operator can see.
export function pickAgentId(current: string, agents: { id: string }[]): string {
  return agents.some((a) => a.id === current) ? current : (agents[0]?.id ?? '');
}
