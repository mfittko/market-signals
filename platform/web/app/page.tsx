'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api, money, type DeskRow } from '@/lib/api';
import { useLive } from '@/lib/live';
import { BotBadge, useActiveBots } from '@/lib/bots';
import { Ago, Card, Stat } from '@/components/ui';

export default function Desk() {
  const [rows, setRows] = useState<DeskRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [market, setMarket] = useState('all');
  const [active, setActive] = useState(true);
  const { tick } = useLive();

  useEffect(() => {
    api<{ instruments: DeskRow[] }>('/desk').then((d) => { setRows(d.instruments); setError(null); }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [tick]);

  const markets = useMemo(() => ['all', ...Array.from(new Set((rows ?? []).map((r) => r.market)))], [rows]);
  const bots = useActiveBots();
  const isActive = (r: DeskRow) => bots?.has(r.symbol) || r.agents.some((a) => a.enabled);
  const shown = (rows ?? []).filter((r) => (market === 'all' || r.market === market) && (!active || isActive(r)));
  const total = (rows ?? []).reduce((s, r) => s + r.realized, 0);
  const trades = (rows ?? []).reduce((s, r) => s + r.trades, 0);
  const wins = (rows ?? []).reduce((s, r) => s + r.wins, 0);

  return (
    <main className="wrap">
      <div className="top"><div className="left"><h1>Desk</h1><span className="chip mode">Paper only · agents advise, nothing is traded</span></div></div>
      {error && <div className="msg err" role="alert" style={{ marginBottom: 16 }}>Cannot reach the control plane: {error}</div>}
      <div className="grid stats">
        <Stat label="Instruments" value={rows?.length ?? '–'} hint={`${(rows ?? []).filter(isActive).length} with a bot or agent on`} />
        <Stat label="Imported paper trades" value={trades} hint={trades ? `${Math.round((wins / trades) * 100)}% won` : undefined} />
        <Stat label="Imported realized P&L" value={money(total)} tone={total >= 0 ? 'good' : 'bad'} hint="from the previous bot versions" />
      </div>
      <div className="filters">
        <div className="seg" role="group" aria-label="Market">
          {markets.map((m) => <button key={m} aria-pressed={market === m} onClick={() => setMarket(m)}>{m}</button>)}
        </div>
        <label className="switch"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Only instruments with a bot or agent on</label>
      </div>
      {!rows ? <div className="empty">Loading…</div> : shown.length === 0 ? (
        <Card><div className="empty">No instruments match. Run the importer to bring in the previous engine&apos;s instruments and bots.</div></Card>
      ) : (
        <div className="inst-grid">
          {shown.map((r) => (
            <Link key={r.symbol} href={`/instruments/${r.slug}`} className="card inst">
              <div className="row"><h3>{r.name}</h3><BotBadge grans={bots?.get(r.symbol)} /></div>
              <div className="muted small">{r.symbol}</div>
              <div className="row small">
                <span className="muted">{r.market} · {r.granularities.join(' ')}</span>
                <span className={`num ${r.realized >= 0 ? 'good-t' : 'bad-t'}`}>{r.trades ? `${money(r.realized)} · ${r.wins}/${r.trades} won` : 'no trades yet'}</span>
              </div>
              <div className="small muted">
                {r.lastSignal ? <>Last signal <strong>{r.lastSignal}</strong> <Ago iso={r.lastSignalAt} /></> : 'No signals'}
                {r.dataThrough && <> · data through <Ago iso={r.dataThrough} /></>}
              </div>
              <div className="tools">
                {r.agents.length === 0 && <span className="muted small">No agents</span>}
                {r.agents.map((a) => (
                  <span className="tool" key={a.id} title={`${a.name}${a.strategy ? ` · ${a.strategy}` : ''}`} style={{ opacity: a.enabled ? 1 : 0.5 }}>
                    {a.granularity} {a.runtime}{a.enabled ? '' : ' off'}
                  </span>
                ))}
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
