'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, describe, engineDecision, type Agent, type Health, type RunRow } from '@/lib/api';
import { useLive } from '@/lib/live';
import { Ago, Card, ComparisonPill, StatusPill } from '@/components/ui';
import { AgentList } from '@/components/AgentList';

export default function Home() {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { tick, connected } = useLive();
  const [inst, setInst] = useState('all');
  const instruments = Array.from(new Set(agents.map((a) => a.instrument))).sort();
  const shownAgents = agents.filter((a) => inst === 'all' || a.instrument === inst);
  const shownRuns = (runs ?? []).filter((r) => inst === 'all' || r.instrument === inst);

  const load = useCallback(async () => {
    try {
      const [r, a, h] = await Promise.all([
        api<{ runs: RunRow[] }>('/runs?limit=50'),
        api<{ agents: Agent[] }>('/agents'),
        api<Health>('/health'),
      ]);
      setRuns(r.runs); setAgents(a.agents.filter((x) => x.runtime !== 'mock' && x.strategyName)); setHealth(h); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load, tick]);
  useEffect(() => { const t = setInterval(() => void load(), 10000); return () => clearInterval(t); }, [load]);

  const sh = health?.stats.shadow ?? {};
  const compared = (sh.agree ?? 0) + (sh.differ ?? 0);
  const online = health?.stats.workers.filter((w) => w.online).length ?? 0;
  const total = Object.values(health?.stats.byStatus ?? {}).reduce((a, b) => a + b, 0);
  const rejected = health?.stats.invalidProposals ?? 0;
  const queued = health?.stats.queueDepth ?? 0;
  // one line instead of five tiles; zero counts are left out
  const summary = [
    `${total} recorded`,
    compared ? `${sh.agree ?? 0} of ${compared} agree with the engine` : null,
    rejected ? `${rejected} rejected by checks` : null,
    queued ? `${queued} queued` : null,
  ].filter(Boolean).join(' · ');

  return (
    <main className="wrap">
      <div className="top">
        <div className="left">
          <h1>Runs</h1>
          <span className="chip mode" title="Shadow mode: agents record what they would do, next to the old bot. They never place orders on your paper portfolio.">Paper only · agents advise, nothing is traded</span>
        </div>
        <div className="chips">
          <span className={`chip ${health ? 'ok' : 'bad'}`}>Control plane</span>
          <span className={`chip ${health?.engine.reachable ? 'ok' : health?.engine.configured ? 'bad' : 'warn'}`} title={health?.engine.error}>
            Engine {health?.engine.reachable ? 'reachable' : health?.engine.configured ? 'unreachable' : 'not configured'}
          </span>
          <span className={`chip ${online > 0 ? 'ok' : 'bad'}`}>{online} worker{online === 1 ? '' : 's'} online</span>
          <span className={`chip ${connected ? 'ok' : 'warn'}`}>{connected ? 'Live' : 'Reconnecting'}</span>
        </div>
      </div>

      {error && <div className="msg err" role="alert" style={{ marginBottom: 16 }}>Cannot reach the control plane: {error}</div>}

      <div className="filters">
        <label className="small muted">Instrument{' '}
          <select value={inst} onChange={(e) => setInst(e.target.value)} aria-label="Filter by instrument">
            <option value="all">All instruments</option>
            {instruments.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </label>
      </div>

      <div className="grid two">
        <Card title="Runs" aside={<span className="muted small">{summary}</span>}>
          {!runs ? <div className="empty">Loading…</div> : shownRuns.length === 0 ? (
            <div className="empty">No runs yet. Start one from “Ask an agent now”, or enable the engine hook to record real events.</div>
          ) : (
            <div className="scroll">
              <table>
                <thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Agent proposal</th><th>Engine decision</th><th>Result</th><th>Started</th></tr></thead>
                <tbody>
                  {shownRuns.map((r) => (
                    <tr key={r.id} className="link" onClick={() => (window.location.href = `/runs/${r.id}`)}>
                      <td className="num"><Link href={`/runs/${r.id}`} onClick={(e) => e.stopPropagation()}>#{r.id}</Link><div className="muted small">{r.event}</div></td>
                      <td>{r.agentName}<div className="muted small">{r.instrument} {r.granularity} · {r.runtime}</div></td>
                      <td><StatusPill status={r.status} cancelRequested={r.cancelRequested} />{r.status === 'waiting_for_event' && <div className="muted small">{r.waitReason}</div>}</td>
                      <td>{r.proposal ? <>{describe(r.proposal)}{r.validation && !r.validation.valid && <div className="small" style={{ color: 'var(--bad)' }}>rejected by checks</div>}</> : <span className="muted">–</span>}</td>
                      <td>{describe(engineDecision(r)) || <span className="muted">–</span>}</td>
                      <td><ComparisonPill value={r.comparison} status={r.status} /></td>
                      <td className="muted small"><Ago iso={r.createdAt} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="grid">
          <NewRun agents={shownAgents} onStarted={load} />
          <Card title="Agents" aside={<span className="muted small">{shownAgents.filter((a) => a.enabled).length} on of {shownAgents.length}</span>}>
            {shownAgents.length === 0 ? <div className="empty">No agents{inst !== 'all' ? ` for ${inst}` : ''}.</div> : (
              <AgentList agents={shownAgents.map((a) => ({ ...a, strategy: a.strategyName }))} onChange={load} showInstrument={inst === 'all'} />
            )}
          </Card>
        </div>
      </div>
    </main>
  );
}

function NewRun({ agents, onStarted }: { agents: Agent[]; onStarted: () => void }) {
  const [agentId, setAgentId] = useState('');
    const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (!agentId && agents[0]) setAgentId(agents[0].id); }, [agents, agentId]);
  return (
    <Card title="New research run">
      <form className="form" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setMsg(null);
        try {
          const r = await api<{ runs: { runId: number }[] }>('/runs', { method: 'POST', body: JSON.stringify({ agentId, source: 'engine' }) });
          setMsg({ ok: true, text: `Queued run #${r.runs[0]?.runId}.` }); onStarted();
        } catch (err) { setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }); } finally { setBusy(false); }
      }}>
        <label>Agent
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </label>
        <button disabled={busy || !agentId}>{busy ? 'Queuing…' : 'Run'}</button>
        {msg && <div className={`msg ${msg.ok ? 'ok' : 'err'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}
      </form>
    </Card>
  );
}
