'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, Stat } from '@/components/ui';
import { ShadowPositions } from '@/components/ShadowPositions';
import { EquityChart, type EquityPoint } from '@/components/EquityChart';

type Trade = {
  id: number; instrument: string; side: 'long' | 'short'; notional: number; entry_price: number; entry_time: string;
  close_price: number; close_time: string; leverage: number; realized: number; close_reason: string; granularity?: string;
};
type Position = Partial<Trade> & { id: number; unrealized?: number; stop?: number; target?: number; price?: number; mark?: number };
type Portfolio = {
  startingBalance: number; cash: number; marginLocked: number; unrealized: number; equity: number; halted: boolean;
  dayPnl?: number; realizedTotal?: number; positions: Position[]; trades: Trade[];
};

const money = (v: number | undefined, signed = false) =>
  v == null ? '–' : `${signed && v > 0 ? '+' : ''}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tone = (v: number | undefined) => (v == null || v === 0 ? undefined : v > 0 ? 'good' : 'bad') as 'good' | 'bad' | undefined;
const short = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const slug = (s: string) => s.toLowerCase().replace('/', '-');

export default function PortfolioPage() {
  const [p, setP] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const r = await api<{ portfolio: Portfolio }>('/engine/portfolio'); if (alive) { setP(r.portfolio); setError(null); } }
      catch (e) { if (alive) setError(e instanceof Error ? e.message : String(e)); }
    };
    load();
    const id = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (error && !p) return <p className="msg err">Engine unreachable: {error}</p>;
  if (!p) return <p className="muted">Loading…</p>;

  const wins = p.trades.filter((t) => t.realized > 0).length;
  const realized = p.realizedTotal ?? p.trades.reduce((s, t) => s + t.realized, 0);
  const ret = ((p.equity - p.startingBalance) / p.startingBalance) * 100;
  // Equity after each closed trade, oldest first, ending at the live equity.
  const byClose = [...p.trades].sort((a, b) => +new Date(a.close_time) - +new Date(b.close_time));
  let run = p.startingBalance;
  const points: EquityPoint[] = [{ t: byClose.length ? +new Date(byClose[0].entry_time) : Date.now(), v: run, label: "start" }];
  for (const t of byClose) { run += t.realized; points.push({ t: +new Date(t.close_time), v: run, label: `${t.instrument} ${t.realized >= 0 ? "+" : ""}${t.realized.toFixed(2)}` }); }
  points.push({ t: Date.now(), v: p.equity, label: "now" });
  const closed = showAll ? p.trades : p.trades.slice(0, 10);

  return (
    <main className="wrap grid">
      <h1>Portfolio</h1>
      {p.halted && <p className="msg err">Kill switch is on. The bot opens no new positions.</p>}
      <div className="grid stats">
        <Stat label="Equity" value={money(p.equity)} hint={`${money(ret, true)}% since start`} tone={tone(p.equity - p.startingBalance)} />
        <Stat label="Cash" value={money(p.cash)} hint={`${money(p.marginLocked)} margin locked`} />
        <Stat label="Unrealized" value={money(p.unrealized, true)} tone={tone(p.unrealized)} />
        <Stat label="Realized" value={money(realized, true)} tone={tone(realized)} hint={`${wins} of ${p.trades.length} trades won`} />
        <Stat label="Today" value={money(p.dayPnl, true)} tone={tone(p.dayPnl)} />
      </div>

      <Card title="Equity"><EquityChart points={points} baseline={p.startingBalance} /></Card>

      <Card title={`Open positions (${p.positions.length})`}>
        {p.positions.length === 0 ? <p className="muted">No open positions.</p> : (
          <div className="scroll"><table>
            <thead><tr><th>Instrument</th><th>Side</th><th className="num">Entry</th><th className="num">Stop</th><th className="num">Target</th><th className="num">Notional</th><th className="num">Unrealized</th></tr></thead>
            <tbody>{p.positions.map((o) => (
              <tr key={o.id}>
                <td><Link href={`/instruments/${slug(o.instrument ?? '')}`}>{o.instrument}</Link></td>
                <td>{o.side}</td>
                <td className="num">{o.entry_price}</td>
                <td className="num">{o.stop ?? '–'}</td>
                <td className="num">{o.target ?? '–'}</td>
                <td className="num">{money(o.notional)}</td>
                <td className={`num ${tone(o.unrealized) ?? ''}`}>{money(o.unrealized, true)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      <ShadowPositions />

      <Card title={`Closed trades (${p.trades.length})`} aside={p.trades.length > 10 && <button className="link" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show 10' : 'Show all'}</button>}>
        <div className="scroll"><table>
          <thead><tr><th>Closed</th><th>Instrument</th><th className="num">Result</th><th>Side</th><th>Reason</th><th className="num">Entry</th><th className="num">Exit</th></tr></thead>
          <tbody>{closed.map((t) => (
            <tr key={t.id}>
              <td style={{ whiteSpace: "nowrap" }}>{short(t.close_time)}</td>
              <td><Link href={`/instruments/${slug(t.instrument)}`}>{t.instrument}</Link></td>
              <td className="num" style={{ color: `var(--${t.realized >= 0 ? "good" : "bad"})` }}>{money(t.realized, true)}</td>
              <td style={{ whiteSpace: "nowrap" }}>{t.side}</td>
              <td style={{ whiteSpace: "nowrap" }}>{t.close_reason}</td>
              <td className="num">{t.entry_price}</td>
              <td className="num">{t.close_price}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </Card>
    </main>
  );
}
