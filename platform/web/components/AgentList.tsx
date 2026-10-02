'use client';
import Link from 'next/link';
import { api, type Agent, type DeskAgent } from '@/lib/api';
import { Ago, StatusPill } from '@/components/ui';

type Row = Pick<DeskAgent, 'id' | 'granularity' | 'runtime' | 'enabled'> & Partial<DeskAgent> & Partial<Pick<Agent, 'name' | 'model' | 'allowedTools' | 'instrument'>>;

// One line per agent. Everything else sits behind the row until asked for.
export function AgentList({ agents, onChange, showInstrument }: { agents: Row[]; onChange: () => void; showInstrument?: boolean }) {
  return (
    <>
      {agents.map((a) => (
        <details className="agent-row" key={a.id}>
          <summary>
            <span className="agent-title">
              <strong>{showInstrument && a.instrument ? `${a.instrument} ` : ''}{a.granularity} · {a.runtime}</strong>
              <span className="muted small">{a.strategy || 'no strategy'}</span>
            </span>
            <label className="switch" onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={a.enabled} onChange={async (e) => { await api(`/agents/${a.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: e.target.checked }) }); onChange(); }} />
              {a.enabled ? 'On' : 'Off'}
            </label>
          </summary>
          <div className="agent-more small">
            <div>{a.name}{a.legacy ? ' · from the previous bot map' : ''}{a.model ? ` · ${a.model}` : ''}</div>
            <div>
              {a.lastRunId ? <><Link href={`/runs/${a.lastRunId}`}>Last run #{a.lastRunId}</Link> {a.lastStatus && <StatusPill status={a.lastStatus} />} <span className="muted"><Ago iso={a.lastAt} /></span></> : <span className="muted">No runs yet</span>}
            </div>
            {a.allowedTools && <div className="tools">{a.allowedTools.map((t) => <span className="tool" key={t}>{t}</span>)}</div>}
          </div>
        </details>
      ))}
    </>
  );
}
