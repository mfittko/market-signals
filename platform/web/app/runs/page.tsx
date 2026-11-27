'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, describe, engineDecision, type Agent, type Health, type RunRow } from '@/lib/api';
import { useLive } from '@/lib/live';
import { Ago, Card, ComparisonPill, Stat, StatusPill, Loading } from '@/components/ui';
import { AgentList } from '@/components/AgentList';
import { pickAgentId } from '@/lib/agent-selection';
import { buildMatch } from '@/lib/same-build';

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
  const consoleCommit = process.env.NEXT_PUBLIC_BUILD_COMMIT ?? 'unknown';
  const build = buildMatch(health?.build?.commit, consoleCommit);
  const buildTitle = {
    same: 'The control plane and the console run the same commit.',
    unverified: 'The commit of the control plane or the console is unknown, so the page cannot tell whether they match.',
    differ: 'The control plane and the console were built from different commits.',
  }[build];
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
          {health?.build && (
            <span className={`chip ${build === 'same' ? 'ok' : 'warn'}`} title={buildTitle}>
              Build {health.build.commit.slice(0, 7)} · console {consoleCommit.slice(0, 7)}{build === 'same' ? '' : ` · ${build}`}
            </span>
          )}
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

      {health?.monitor && health.spend && health.stats.leases && <PipelineHealth h={health} />}

      <div className="grid two">
        <Card title="Runs" aside={<span className="muted small">{summary}</span>}>
          {!runs ? <Loading /> : shownRuns.length === 0 ? (
            <div className="empty">No runs yet. Start one from “New research run”, or enable the engine hook to record real events.</div>
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

const secs = (s: number) => (s < 120 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

// Read-only numbers from the health route: queue, leases, monitor and model spend.
function PipelineHealth({ h }: { h: Health }) {
  const { leases } = h.stats;
  const pass = h.monitor.lastPassAgeSeconds;
  return (
    <Card title="Pipeline health" aside={
      <span className="chips">
        {h.degraded.length === 0 ? <span className="chip ok">No degraded conditions</span>
          : h.degraded.map((d) => <span key={d.name} className="chip bad" title={d.detail}>{d.name.replaceAll('_', ' ')}</span>)}
      </span>
    }>
      <div className="grid stats">
        <Stat label="Oldest queued" value={h.stats.oldestQueuedSeconds ? secs(h.stats.oldestQueuedSeconds) : 'none'} hint="claimable runs only" />
        <Stat label="Leases" value={leases.running} hint={`${leases.expiringSoon} expiring soon · ${leases.expired} expired`} tone={leases.expired ? 'warn' : undefined} />
        <Stat label="Cancel requests" value={h.stats.cancelRequested} hint="waiting for the worker" />
        {/* a slow tick stretches one gap past the interval; red only after a whole missed pass */}
        <Stat label="Monitor pass" value={!h.engine.configured ? 'not running' : pass == null ? 'none yet' : `${secs(pass)} ago`} hint={h.engine.configured ? `runs every ${h.monitor.intervalSeconds} s` : 'no engine configured'}
          tone={pass != null && pass > 2 * h.monitor.intervalSeconds ? 'bad' : undefined} />
        <Stat label="Model spend today" value={`$${h.spend.todayUsd.toFixed(2)}`} hint={`of the $${h.spend.capUsd.toFixed(2)} daily cap`}
          tone={h.spend.todayUsd >= h.spend.capUsd ? 'bad' : undefined} />
      </div>
    </Card>
  );
}

function NewRun({ agents, onStarted }: { agents: Agent[]; onStarted: () => void }) {
  const [agentId, setAgentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { setAgentId((cur) => pickAgentId(cur, agents)); }, [agents]);
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
