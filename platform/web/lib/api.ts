export type Decision = {
  action: 'open' | 'close' | 'hold';
  side?: 'long' | 'short';
  notional?: number;
  stop?: number;
  target?: number | null;
  positionId?: number;
  reasoning?: string;
};

export type Validation = {
  valid: boolean;
  reasons: string[];
  freshnessSeconds: number;
  priceUsed: number;
  committed: boolean;
};

export type Status =
  | 'queued' | 'running' | 'waiting_for_event' | 'awaiting_approval'
  | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export type Comparison = 'pending' | 'agree' | 'differ' | 'no_legacy';

export type Run = {
  id: number;
  agentId: string;
  snapshotId: number;
  trigger: string;
  status: Status;
  attemptsMade: number;
  maxAttempts: number;
  followupsUsed: number;
  cancelRequested: boolean;
  waitReason?: string;
  waitUntil?: string;
  stopReason?: string;
  proposal?: Decision;
  validation?: Validation;
  legacyDecision?: { decision?: Decision; executed?: unknown; error?: string | null } & Partial<Decision>;
  comparison: Comparison;
  usage: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
};

export type RunRow = Run & {
  agentName: string;
  runtime: string;
  instrument: string;
  granularity: string;
  event: string;
  source: string;
  snapshotTakenAt: string;
};

export type Agent = {
  id: string;
  name: string;
  instrument: string;
  granularity: string;
  runtime: 'mock' | 'llm';
  model?: string;
  allowedTools: string[];
  budgets: Record<string, number>;
  enabled: boolean;
};

export type Attempt = {
  id: number;
  runId: number;
  attemptNo: number;
  workerId: string;
  status: string;
  toolCalls: number;
  startedAt: string;
  endedAt?: string;
  error?: string;
  usage: Record<string, number>;
};

export type RunEvent = {
  id: number;
  runId: number;
  attemptId?: number;
  kind: string;
  payload: Record<string, any>;
  at: string;
};

export type RunDetail = {
  run: Run;
  agent: Agent;
  snapshot: { id: number; idemKey: string; source: string; event: string; digest: string; takenAt: string; payload: Record<string, any> };
  attempts: Attempt[];
  events: RunEvent[];
};

export type Health = {
  ok: boolean;
  mode: string;
  engine: { configured: boolean; reachable: boolean; error?: string };
  stats: {
    byStatus: Record<string, number>;
    shadow: Record<string, number>;
    invalidProposals: number;
    queueDepth: number;
    workers: { id: string; runtimes: string[]; online: boolean; lastSeen: string; capabilities: Record<string, any> }[];
  };
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }, cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ? `${body.error}${body.hint ? `: ${body.hint}` : ''}` : `request failed (${res.status})`);
  return body as T;
}

export function describe(d?: Decision | null): string {
  if (!d) return '';
  if (d.action === 'hold') return 'hold';
  if (d.action === 'close') return `close #${d.positionId}`;
  const parts = [`open ${d.side}`];
  if (d.notional) parts.push(d.notional.toFixed(2));
  return parts.join(' ');
}

// The engine's decision arrives wrapped ({decision, executed, error}) or bare.
export function engineDecision(r: Pick<Run, 'legacyDecision'>): Decision | undefined {
  const l = r.legacyDecision;
  if (!l) return undefined;
  return (l.decision ?? (l.action ? (l as Decision) : undefined)) as Decision | undefined;
}
