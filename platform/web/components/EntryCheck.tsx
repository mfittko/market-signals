'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, describe, type DeskAgent, type Run } from '@/lib/api';
import { Card, StatusPill } from '@/components/ui';

type Item = { agent: DeskAgent; runId?: number; run?: Run; error?: string };
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

// Snapshots the live engine for each enabled agent and shows the answer in place.
export function EntryCheck({ agents }: { agents: DeskAgent[] }) {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  // A manual check runs every LLM agent for this instrument, on or off. Each check is one model call per agent.
  const on = agents.filter((a) => a.runtime === 'llm');

  async function start() {
    setBusy(true);
    const next: Item[] = await Promise.all(on.map(async (agent) => {
      try {
        const r = await api<{ runs: { runId: number }[] }>('/runs', { method: 'POST', body: JSON.stringify({ agentId: agent.id, source: 'engine' }) });
        return { agent, runId: r.runs[0]?.runId };
      } catch (e) { return { agent, error: e instanceof Error ? e.message : String(e) }; }
    }));
    setItems(next); setBusy(false);
  }

  const pending = items.some((i) => i.runId && !finished(i.run?.status));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(async () => {
      setItems((cur) => cur);
      const updated = await Promise.all(items.map(async (i) => {
        if (!i.runId || finished(i.run?.status)) return i;
        try { return { ...i, run: (await api<{ run: Run }>(`/runs/${i.runId}`)).run }; } catch { return i; }
      }));
      setItems(updated);
    }, 1200);
    return () => clearInterval(t);
  }, [pending, items]);

  return (
    <Card title="Entry check" aside={<span className="muted small">against live data</span>}>
      <p className="small muted" style={{ marginTop: 0 }}>
        Freezes the live state and asks each agent to judge its own strategy rules against it. It works even when the agent is off. Nothing is executed.
      </p>
      <button onClick={start} disabled={busy || on.length === 0} style={{ width: '100%' }}>
        {busy ? 'Starting…' : on.length === 0 ? 'No agent for this instrument' : `Check now (${on.length} agent${on.length === 1 ? '' : 's'})`}
      </button>
      {items.map((i) => {
        const v = verdict(i.run);
        return (
          <div key={i.agent.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}>
            <div className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
              <strong>{i.agent.granularity} · {i.agent.runtime}</strong>
              {i.run && <StatusPill status={i.run.status} />}
            </div>
            {i.error ? <div className="msg err" role="alert">{i.error}</div> : (
              <>
                <div className={v.tone === 'good' ? 'good-t' : v.tone === 'bad' ? 'bad-t' : 'muted'} style={{ fontWeight: 600 }}>{v.text}</div>
                {v.why && <div className="small">{v.why.length > 240 ? `${v.why.slice(0, 240)}…` : v.why}</div>}
                {i.runId && <div className="small"><Link href={`/runs/${i.runId}`}>Open run #{i.runId}</Link></div>}
              </>
            )}
          </div>
        );
      })}
    </Card>
  );
}
