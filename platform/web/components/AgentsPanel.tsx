'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, describe, type DeskAgent, type Run } from '@/lib/api';
import { Ago, Card, StatusPill } from '@/components/ui';

type Check = { runId?: number; run?: Run; error?: string };
const finished = (s?: string) => s === 'succeeded' || s === 'failed' || s === 'cancelled' || s === 'expired';

function verdict(run?: Run): { text: string; tone: 'good' | 'muted' | 'bad'; why?: string } {
  const waiting = run?.status === 'waiting_for_event';
  if (!run || (!finished(run.status) && !(waiting && run.proposal))) return { text: waiting ? `Waiting: ${run.waitReason ?? 'follow-up'}` : 'Checking live data…', tone: 'muted' };
  if (run.status !== 'succeeded' && !waiting) return { text: `Run ${run.status}`, tone: 'bad', why: run.stopReason };
  const p = run.proposal;
  if (!p) return { text: 'No proposal', tone: 'muted', why: run.stopReason };
  if (run.validation && !run.validation.valid) return { text: `Rejected by checks (${describe(p)})`, tone: 'bad', why: run.validation.reasons.join('; ') };
  if (p.action === 'open') return { text: `Entry conditions met: ${describe(p)}${p.stop ? `, stop ${p.stop}` : ''}${p.target ? `, target ${p.target}` : ''}`, tone: 'good', why: p.reasoning };
  const base = p.action === 'close' ? `Would close #${p.positionId}` : 'No entry now';
  return { text: waiting ? `${base} (agent will re-check: ${run.waitReason ?? 'follow-up'})` : base, tone: 'muted', why: p.reasoning };
}

// Agents for one instrument and, in the same place, a check of each against live data.
// A check freezes the live state and asks the agent to judge its strategy rules. Nothing is executed.
// It works even when the agent is off, and costs one model call per agent.
export function AgentsPanel({ agents, onChange }: { agents: DeskAgent[]; onChange: () => void }) {
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [busy, setBusy] = useState(false);
  const live = useRef(checks);
  live.current = checks;
  const llm = agents.filter((a) => a.runtime === 'llm');

  async function start(list: DeskAgent[]) {
    setBusy(true);
    const started = await Promise.all(list.map(async (a): Promise<[string, Check]> => {
      try {
        const r = await api<{ runs: { runId: number }[] }>('/runs', { method: 'POST', body: JSON.stringify({ agentId: a.id, source: 'engine' }) });
        return [a.id, { runId: r.runs[0]?.runId }];
      } catch (e) { return [a.id, { error: e instanceof Error ? e.message : String(e) }]; }
    }));
    setChecks((c) => ({ ...c, ...Object.fromEntries(started) }));
    setBusy(false);
  }

  const pending = Object.values(checks).some((c) => c.runId && !finished(c.run?.status));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(async () => {
      const cur = live.current;
      const next: Record<string, Check> = {};
      await Promise.all(Object.entries(cur).map(async ([id, c]) => {
        if (!c.runId || finished(c.run?.status)) return;
        try { next[id] = { ...c, run: (await api<{ run: Run }>(`/runs/${c.runId}`)).run }; } catch { /* keep the last state */ }
      }));
      setChecks((c) => ({ ...c, ...next }));
    }, 1200);
    return () => clearInterval(t);
  }, [pending]);

  return (
    <Card title="Agents" aside={<span className="muted small">{agents.filter((a) => a.enabled).length} on</span>}>
      <p className="small muted" style={{ marginTop: 0 }}>
        A check freezes the live state and asks the agent to judge its strategy rules. It works even when the agent is off. Nothing is executed.
      </p>
      {agents.length === 0 ? <div className="empty">No agent for this instrument yet.</div> : (
        <>
          <button onClick={() => void start(llm)} disabled={busy || llm.length === 0} style={{ width: '100%' }}>
            {busy ? 'Starting…' : `Check all now (${llm.length} agent${llm.length === 1 ? '' : 's'})`}
          </button>
          {agents.map((a) => {
            const c = checks[a.id];
            const v = c ? verdict(c.run) : null;
            return (
              <details className="agent-row" key={a.id} open={!!c || undefined}>
                <summary>
                  <span className="agent-title">
                    <strong>{a.granularity} · {a.runtime}</strong>
                    <span className="muted small">{a.strategy || 'no strategy'}</span>
                  </span>
                  <label className="switch" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={a.enabled} aria-label={`${a.granularity} ${a.runtime} agent on`}
                      onChange={async (e) => { await api(`/agents/${a.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: e.target.checked }) }); onChange(); }} />
                    {a.enabled ? 'On' : 'Off'}
                  </label>
                </summary>
                <div className="agent-more small">
                  <div>
                    <button className="ghost" onClick={() => void start([a])} disabled={busy || (!!c?.runId && !finished(c.run?.status))}>Check this one now</button>
                  </div>
                  {c?.error && <div className="msg err" role="alert">{c.error}</div>}
                  {v && !c?.error && (
                    <div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                        <span className={v.tone === 'good' ? 'good-t' : v.tone === 'bad' ? 'bad-t' : 'muted'} style={{ fontWeight: 600 }}>{v.text}</span>
                        {c?.run && <StatusPill status={c.run.status} />}
                      </div>
                      {v.why && <div className="muted">{v.why}</div>}
                      {c?.runId && <Link href={`/runs/${c.runId}`}>Open run #{c.runId}</Link>}
                    </div>
                  )}
                  <div className="muted">{a.name}{a.legacy ? ' · from the previous bot map' : ''}</div>
                  {a.lastRunId && (
                    <div>
                      <Link href={`/runs/${a.lastRunId}`}>Last run #{a.lastRunId}</Link> {a.lastStatus && <StatusPill status={a.lastStatus} />} <span className="muted"><Ago iso={a.lastAt} /></span>
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </>
      )}
    </Card>
  );
}
