'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fetchAlerts, type AlertEvent, type AlertKind } from '@/lib/alerts';
import { Card } from '@/components/ui';

const LABEL: Record<AlertKind, string> = { signal: 'Signals', proposal: 'Agent proposals', trade: 'Paper trades' };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function AlertsPage() {
  const [events, setEvents] = useState<AlertEvent[] | null>(null);
  const [kind, setKind] = useState<AlertKind | 'all'>('all');
  const [passedOnly, setPassedOnly] = useState(true);
  useEffect(() => {
    let alive = true;
    const load = () => fetchAlerts().then((e) => alive && setEvents(e));
    void load();
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  const shown = (events ?? []).filter((e) => (kind === 'all' || e.kind === kind) && !(passedOnly && e.kind === 'signal' && !e.tone)).slice(0, 60);
  return (
    <main className="wrap grid">
      <div className="top"><div className="left"><h1>Alerts</h1><span className="muted">What the engine and the agents flagged. <Link href="/settings">Choose markets and channels in Settings.</Link></span></div></div>
      <Card title="Recent" aside={
        <span className="small">
          <select value={kind} onChange={(e) => setKind(e.target.value as AlertKind | 'all')} aria-label="Kind">
            <option value="all">All</option>{(Object.keys(LABEL) as AlertKind[]).map((k) => <option key={k} value={k}>{LABEL[k]}</option>)}
          </select>{' '}
          <label><input type="checkbox" checked={passedOnly} onChange={(e) => setPassedOnly(e.target.checked)} /> hide filtered-out signals</label>
        </span>}>
        {!events ? <p className="muted">Loading…</p> : shown.length === 0 ? <p className="muted">Nothing to show.</p> : (
          <div className="scroll"><table>
            <thead><tr><th>When</th><th>Type</th><th>What</th><th>Delivered</th></tr></thead>
            <tbody>{shown.map((e) => (
              <tr key={e.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{when(e.at)}</td>
                <td>{e.kind === 'signal' ? 'Signal' : e.kind === 'proposal' ? 'Proposal' : 'Trade'}</td>
                <td><Link href={e.href ?? '#'} style={{ color: e.tone ? `var(--${e.tone})` : undefined }}>{e.title}</Link><div className="small muted">{e.detail}</div></td>
                <td>{e.kind === 'signal' ? (e.alerted ? 'sent by the engine' : e.tone ? 'not sent' : 'filtered out') : ''}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </main>
  );
}
