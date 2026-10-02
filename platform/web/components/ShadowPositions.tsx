'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, slugOf, type ShadowPosition } from '@/lib/api';
import { Card } from '@/components/ui';

export const pnl = (p: ShadowPosition) => {
  if (p.realized != null) return p.realized;
  if (!p.lastClose) return 0;
  const move = (p.lastClose - p.entryPrice) / p.entryPrice;
  return (p.side === 'long' ? move : -move) * p.notional;
};
const fmt = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`;

// Positions the agents manage in shadow mode: the monitor's rules run on them
// without a model, and the model is woken only when a tripwire fires.
export function ShadowPositions() {
  const [rows, setRows] = useState<ShadowPosition[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api<{ positions: ShadowPosition[] }>('/positions?limit=50').then((r) => alive && setRows(r.positions)).catch(() => alive && setRows([]));
    load();
    const id = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  if (!rows) return null;
  const open = rows.filter((r) => r.status === 'open').length;
  return (
    <Card title={`Agent positions, advisory (${open} open)`}>
      {rows.length === 0 ? <p className="muted">No agent has opened a position yet. Advisory positions never touch the live paper portfolio.</p> : (
        <div className="scroll"><table>
          <thead><tr><th>Instrument</th><th className="num">P/L</th><th>Status</th><th>Side</th><th className="num">Entry</th><th className="num">Stop</th><th className="num">Min held</th></tr></thead>
          <tbody>{rows.map((p) => {
            const v = pnl(p);
            return (
              <tr key={p.id}>
                <td><Link href={`/positions/${p.id}`}>{p.instrument} {p.granularity}</Link></td>
                <td className="num" style={{ color: v === 0 ? undefined : `var(--${v > 0 ? 'good' : 'bad'})` }}>{fmt(v)}</td>
                <td>{p.needsAttention ? <span className="pill s-failed">needs attention</span> : p.status === 'open' ? <span className="pill s-running">open</span> : <span className="muted">{p.exitReason || 'closed'}</span>}</td>
                <td>{p.side}</td>
                <td className="num">{p.entryPrice}</td>
                <td className="num">{p.stop}</td>
                <td className="num">{p.barsHeld}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </Card>
  );
}
export { slugOf };
