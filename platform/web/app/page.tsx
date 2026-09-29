'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, describe, engineDecision, type Agent, type Health, type RunRow } from '@/lib/api';
import { useLive } from '@/lib/live';
import { Ago, Card, ComparisonPill, Stat, StatusPill } from '@/components/ui';

export default function Home() {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { tick, connected } = useLive();

  const load = useCallback(async () => {
    try {
      const [r, a, h] = await Promise.all([
        api<{ runs: RunRow[] }>('/runs?limit=50'),
        api<{ agents: Agent[] }>('/agents'),
        api<Health>('/health'),
      ]);
      setRuns(r.runs); setAgents(a.agents); setHealth(h); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load, tick]);
  useEffect(() => { const t = setInterval(() => void load(), 10000); return () => clearInterval(t); }, [load]);

  const sh = health?.stats.shadow ?? {};
  const compared = (sh.agree ?? 0) + (sh.differ ?? 0);
  const online = health?.stats.workers.filter((w) => w.online).length ?? 0;

  return (
    <main className="wrap">
      <div className="top">
        <div className="left">
          <h1>Agent console</h1>
          <span className="chip mode" title="Agents propose. The deterministic engine still decides and executes.">Shadow mode · nothing is executed</span>
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

      <div className="grid stats">
        <Stat label="Runs recorded" value={runs ? Object.values(health?.stats.byStatus ?? {}).reduce((a, b) => a + b, 0) : '–'} />
        <Stat label="Agree with engine" value={sh.agree ?? 0} tone="good" hint={compared ? `${Math.round(((sh.agree ?? 0) / compared) * 100)}% of ${compared} compared` : 'needs engine events'} />
        <Stat label="Differ from engine" value={sh.differ ?? 0} tone={(sh.differ ?? 0) > 0 ? 'warn' : undefined} />
        <Stat label="Rejected proposals" value={health?.stats.invalidProposals ?? 0} tone={(health?.stats.invalidProposals ?? 0) > 0 ? 'bad' : undefined} hint="failed deterministic checks" />
        <Stat label="In queue" value={health?.stats.queueDepth ?? 0} />
      </div>

      <div className="grid two">
        <Card title="Runs">
          {!runs ? <div className="empty">Loading…</div> : runs.length === 0 ? (
            <div className="empty">No runs yet. Start one from “New research run”, or enable the engine hook to record real events.</div>
          ) : (
            <div className="scroll">
              <table>
                <thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Agent proposal</th><th>Engine decision</th><th>Result</th><th>Started</th></tr></thead>
                <tbody>
                  {runs.map((r) => (
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
          <NewRun agents={agents} onStarted={load} />
          <Card title="Agents">
            {agents.length === 0 && <div className="empty">No agents.</div>}
            {agents.map((a) => (
              <div className="agent" key={a.id}>
                <div><strong>{a.name}</strong><div className="muted small">{a.instrument} {a.granularity} · {a.runtime}{a.model ? ` · ${a.model}` : ''}</div></div>
                <label className="switch">
                  <input type="checkbox" checked={a.enabled} onChange={async (e) => { await api(`/agents/${a.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: e.target.checked }) }); void load(); }} />
                  {a.enabled ? 'On' : 'Off'}
                </label>
                <div className="tools">{a.allowedTools.map((t) => <span className="tool" key={t}>{t}</span>)}</div>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </main>
  );
}

function NewRun({ agents, onStarted }: { agents: Agent[]; onStarted: () => void }) {
  const [agentId, setAgentId] = useState('');
  const [source, setSource] = useState('demo');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (!agentId && agents[0]) setAgentId(agents[0].id); }, [agents, agentId]);
  return (
    <Card title="New research run">
      <form className="form" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setMsg(null);
        try {
          const r = await api<{ runs: { runId: number }[] }>('/runs', { method: 'POST', body: JSON.stringify({ agentId, source }) });
          setMsg({ ok: true, text: `Queued run #${r.runs[0]?.runId}.` }); onStarted();
        } catch (err) { setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }); } finally { setBusy(false); }
      }}>
        <label>Agent
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </label>
        <label>Snapshot from
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="demo">Bundled demo event (offline)</option>
            <option value="engine">Current engine state (live)</option>
          </select>
        </label>
        <button disabled={busy || !agentId}>{busy ? 'Queuing…' : 'Run'}</button>
        {msg && <div className={`msg ${msg.ok ? 'ok' : 'err'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}
      </form>
    </Card>
  );
}
