'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, money, type InstrumentDetail } from '@/lib/api';
import { useLive } from '@/lib/live';
import { CandleChart } from '@/components/CandleChart';
import { EntryCheck } from '@/components/EntryCheck';
import { AgentList } from '@/components/AgentList';
import { Card, Stat } from '@/components/ui';

const LIMIT = 10;
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export default function InstrumentPage() {
  const { slug } = useParams<{ slug: string }>();
  const [gran, setGran] = useState<string>('');
  const [d, setD] = useState<InstrumentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { tick } = useLive();
  const [allSig, setAllSig] = useState(false);
  const [allTr, setAllTr] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<InstrumentDetail>(`/instruments/${slug}${gran ? `?granularity=${gran}` : ''}`);
      setD(r); setError(null);
      if (!gran) setGran(r.granularity);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [slug, gran]);
  useEffect(() => { void load(); }, [load, tick]);

  if (error) return <main className="wrap"><Link href="/">← Desk</Link><div className="msg err" role="alert" style={{ marginTop: 12 }}>{error}</div></main>;
  if (!d) return <main className="wrap"><div className="empty">Loading…</div></main>;

  const won = d.trades.filter((t) => t.realized > 0).length;
  const pnl = d.trades.reduce((s, t) => s + t.realized, 0);
  const lastFlip = [...d.signals].find((s) => s.granularity === d.granularity && d.candles.some((c) => c.time === s.time));

  return (
    <main className="wrap">
      <div className="top">
        <div className="left"><Link href="/">← Desk</Link><h1>{d.name}</h1><span className="muted">{d.symbol} · {d.market}</span></div>
        <div className="seg" role="group" aria-label="Granularity">
          {d.granularities.map((g) => <button key={g.granularity} aria-pressed={g.granularity === d.granularity} onClick={() => setGran(g.granularity)}>{g.granularity}</button>)}
        </div>
      </div>

      <div className="grid stats">
        <Stat label="Candles in view" value={d.candles.length} hint={d.candles.length ? `through ${when(d.candles[d.candles.length - 1].time)}` : undefined} />
        <Stat label="Recent signals" value={d.signals.length} />
        <Stat label="Recent paper trades" value={d.trades.length} hint={d.trades.length ? `${won} won` : undefined} />
        <Stat label="Realized (shown)" value={money(pnl)} tone={pnl >= 0 ? 'good' : 'bad'} />
      </div>

      <Card title={`Chart · ${d.granularity}`} className="chart-card" aside={<span className="muted small">imported history{lastFlip ? ` · ${lastFlip.signal} flip marked` : ''}</span>}>
        {d.candles.length ? <CandleChart candles={d.candles} flip={lastFlip ? { signal: lastFlip.signal, time: lastFlip.time, price: lastFlip.price } : undefined} /> : <div className="empty">No candles for this granularity.</div>}
      </Card>

      <div className="grid two">
        <div className="grid">
          <Card title="Signals">
            {d.signals.length === 0 ? <div className="empty">No signals.</div> : (
              <div className="scroll"><table>
                <thead><tr><th>Time</th><th>Signal</th><th>Verdict</th><th>Reason</th></tr></thead>
                <tbody>{(allSig ? d.signals : d.signals.slice(0, LIMIT)).map((s) => (
                  <tr key={s.granularity + s.time + s.kind}>
                    <td className="num">{when(s.time)}<div className="muted small">{s.granularity} · {s.kind.replace('supertrend-', '')}</div></td>
                    <td className={s.signal === 'buy' ? 'good-t' : 'bad-t'}>{s.signal}{s.price ? <div className="muted small num">{s.price}</div> : null}</td>
                    <td>{s.verdict ?? <span className="muted">–</span>}</td>
                    <td className="small">{s.reason ?? ''}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            {d.signals.length > LIMIT && <button className="linkish" onClick={() => setAllSig(!allSig)}>{allSig ? "Show fewer" : `Show all ${d.signals.length}`}</button>}
          </Card>
          <Card title="Paper trades (previous bot versions)">
            {d.trades.length === 0 ? <div className="empty">No trades for this instrument.</div> : (
              <div className="scroll"><table>
                <thead><tr><th>Closed</th><th>Side</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>Why</th></tr></thead>
                <tbody>{(allTr ? d.trades : d.trades.slice(0, LIMIT)).map((t) => (
                  <tr key={t.positionId}>
                    <td className="num">{when(t.closeTime)}<div className="muted small">{t.granularity ?? ''} · #{t.positionId}</div></td>
                    <td>{t.side}</td>
                    <td className="num">{t.entryPrice}</td><td className="num">{t.closePrice}</td>
                    <td className={`num ${t.realized >= 0 ? 'good-t' : 'bad-t'}`}>{money(t.realized)}</td>
                    <td className="small">{t.closeReason}{t.strategyHash && <div className="muted">strategy {t.strategyHash}</div>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            {d.trades.length > LIMIT && <button className="linkish" onClick={() => setAllTr(!allTr)}>{allTr ? "Show fewer" : `Show all ${d.trades.length}`}</button>}
          </Card>
        </div>

        <div className="grid">
          <EntryCheck agents={d.agents} />
          <Card title="Agents" aside={<span className="muted small">{d.agents.filter((a) => a.enabled).length} on</span>}>
            {d.agents.length === 0 ? <div className="empty">No agent for this instrument yet.</div> : <AgentList agents={d.agents} onChange={load} />}
          </Card>
        </div>
      </div>
    </main>
  );
}
