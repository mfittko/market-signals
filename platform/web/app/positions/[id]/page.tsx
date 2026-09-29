'use client';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { api, slugOf, type PositionEvent, type ShadowPosition } from '@/lib/api';
import { Card, Json, Stat, Loading } from '@/components/ui';
import { pnl } from '@/components/ShadowPositions';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export default function PositionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [d, setD] = useState<{ position: ShadowPosition; events: PositionEvent[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api<{ position: ShadowPosition; events: PositionEvent[] }>(`/positions/${id}`).then((r) => alive && setD(r)).catch((e) => alive && setErr(String(e.message ?? e)));
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 10000);
    return () => { alive = false; clearInterval(t); };
  }, [id]);
  if (err && !d) return <main className="wrap"><p className="msg err">{err}</p></main>;
  if (!d) return <main className="wrap"><Loading full /></main>;
  const p = d.position, v = pnl(p);
  return (
    <main className="wrap grid">
      <h1><Link href={`/instruments/${slugOf(p.instrument)}`}>{p.instrument}</Link> {p.granularity} {p.side} <span className="muted">advisory #{p.id}</span></h1>
      {p.needsAttention && <p className="msg err">A tripwire woke the agent and the wake failed. The stop stays in force. Check the failed wake below.</p>}
      <div className="grid stats">
        <Stat label={p.status === 'open' ? 'Unrealized' : 'Realized'} value={`${v > 0 ? '+' : ''}${v.toFixed(2)}`} tone={v === 0 ? undefined : v > 0 ? 'good' : 'bad'} hint={p.status === 'closed' ? `${p.exitReason}, after ${p.barsHeld} min` : `${p.barsHeld} min held`} />
        <Stat label="Entry" value={p.entryPrice} hint={when(p.entryTime)} />
        <Stat label="Stop" value={p.stop} hint={p.stop !== p.initialStop ? `started at ${p.initialStop}` : 'unmoved'} />
        <Stat label="Target" value={p.target ?? '–'} />
        <Stat label="Model wakes" value={p.wakes} hint={p.failedWakes ? `${p.failedWakes} failed` : undefined} tone={p.failedWakes ? 'warn' : undefined} />
      </div>
      <Card title="Exit plan"><Json value={p.plan} max={30} /><p className="muted">Opened by <Link href={`/runs/${p.runId}`}>run {p.runId}</Link>. The rules apply on every completed bar without a model.</p></Card>
      <Card title={`Audit trail (${d.events.length})`}>
        <div className="scroll"><table>
          <thead><tr><th>Bar time</th><th>Event</th><th>Detail</th></tr></thead>
          <tbody>{[...d.events].reverse().map((e) => (
            <tr key={e.id}><td style={{ whiteSpace: "nowrap" }}>{when(e.payload?.bar ?? e.at)}</td><td>{e.kind}</td><td><Json value={e.payload} max={12} /></td></tr>
          ))}</tbody>
        </table></div>
      </Card>
    </main>
  );
}
