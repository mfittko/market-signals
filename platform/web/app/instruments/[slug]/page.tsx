'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, money, type InstrumentDetail } from '@/lib/api';
import { useLive } from '@/lib/live';
import { BotBadge, useActiveBots } from '@/lib/bots';
import { CandleChart, type Candle, type STPoint } from '@/components/CandleChart';
import { AgentsPanel } from '@/components/AgentsPanel';
import { ChatPanel } from '@/components/ChatPanel';
import { Card } from '@/components/ui';

const LIMIT = 10;
const POLL_MS = 15000;
type Live = { candles: Candle[]; supertrend: STPoint[]; signals: InstrumentDetail['signals']; quote?: { last?: number }; fetchedAt: string };
type NewsItem = { title: string; source: string; time: string; url: string | null; tone: string | null; escalation: boolean };
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export default function InstrumentPage() {
  const { slug } = useParams<{ slug: string }>();
  const [gran, setGran] = useState<string>('');
  const [d, setD] = useState<InstrumentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { tick } = useLive();
  const [tab, setTab] = useState<'signals' | 'trades'>('signals');
  const bots = useActiveBots();
  const [allSig, setAllSig] = useState(false);
  const [allTr, setAllTr] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  const [liveErr, setLiveErr] = useState<string | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [showNews, setShowNews] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<InstrumentDetail>(`/instruments/${slug}${gran ? `?granularity=${gran}` : ''}`);
      setD(r); setError(null);
      if (!gran) setGran(r.granularity);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [slug, gran]);
  useEffect(() => { void load(); }, [load, tick]);

  // Live candles from the engine every 15s while the tab is visible. On failure the chart keeps the imported history.
  useEffect(() => {
    if (!gran) return;
    let dead = false;
    const pull = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await api<Live>(`/instruments/${slug}/live?granularity=${gran}`);
        if (!dead) { setLive(r); setLiveErr(null); }
      } catch (e) { if (!dead) setLiveErr(e instanceof Error ? e.message : String(e)); }
    };
    setLive(null);
    void pull();
    const t = setInterval(pull, POLL_MS);
    document.addEventListener('visibilitychange', pull);
    return () => { dead = true; clearInterval(t); document.removeEventListener('visibilitychange', pull); };
  }, [slug, gran]);

  useEffect(() => {
    let dead = false;
    api<{ items: NewsItem[] }>(`/instruments/${slug}/news?hours=72`).then((r) => { if (!dead) setNews(r.items ?? []); }).catch(() => { if (!dead) setNews([]); });
    return () => { dead = true; };
  }, [slug]);

  if (error) return <main className="wrap"><Link href="/">← Desk</Link><div className="msg err" role="alert" style={{ marginTop: 12 }}>{error}</div></main>;
  if (!d) return <main className="wrap"><div className="empty">Loading…</div></main>;

  const won = d.trades.filter((t) => t.realized > 0).length;
  const pnl = d.trades.reduce((s, t) => s + t.realized, 0);
  const candles = live?.candles.length ? live.candles : d.candles;
  const signals = live?.signals.length ? live.signals : d.signals;
  const lastFlip = [...signals].find((s) => s.granularity === d.granularity && candles.some((c) => c.time === s.time));

  return (
    <main className="wrap">
      <div className="top">
        <div className="left"><Link href="/">← Desk</Link><h1>{d.name}</h1><span className="muted">{d.symbol} · {d.market}</span><BotBadge grans={bots?.get(d.symbol)} /></div>
        <div className="seg" role="group" aria-label="Granularity">
          {d.granularities.map((g) => <button key={g.granularity} aria-pressed={g.granularity === d.granularity} onClick={() => setGran(g.granularity)}>{g.granularity}</button>)}
        </div>
      </div>

      <div className="grid desk">
        <div className="grid">
      <Card title={`Chart · ${d.granularity}`} className="chart-card" aside={
        <span className="muted small">
          {live ? `live · updated ${new Date(live.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}` : `imported history through ${d.candles.length ? when(d.candles[d.candles.length - 1].time) : "n/a"}${liveErr ? " · engine offline" : ""}`}
          {lastFlip ? ` · ${lastFlip.signal} flip marked` : ''}
        </span>}>
        {candles.length ? (
          <CandleChart candles={candles} supertrend={live?.supertrend} lastPrice={live?.quote?.last}
            signals={signals.filter((s) => s.granularity === d.granularity)}
            trades={d.trades.filter((t) => !t.granularity || t.granularity === d.granularity)}
            news={news.map((n) => ({ time: n.time, title: n.title, source: n.source, escalation: n.escalation, impact: n.tone }))} />
        ) : <div className="empty">No candles for this granularity.</div>}
        {liveErr && <p className="small muted" role="status">Live data unavailable: {liveErr}. Showing imported history.</p>}
      </Card>

          <Card>
            <div className="tabs" role="tablist" aria-label="History">
              <button role="tab" id="tab-signals" aria-selected={tab === 'signals'} aria-controls="pane-history" onClick={() => setTab('signals')}>Signals <span className="muted small">{d.signals.length}</span></button>
              <button role="tab" id="tab-trades" aria-selected={tab === 'trades'} aria-controls="pane-history" onClick={() => setTab('trades')}>Paper trades <span className="muted small">{d.trades.length}</span></button>
            </div>
            <div id="pane-history" role="tabpanel" aria-labelledby={`tab-${tab}`}>
            {tab === 'signals' && (<>
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
            </>)}
            {tab === 'trades' && (<>
            <p className="small muted" style={{ marginTop: 0 }}>{d.trades.length} closed paper trades, {won} won, realized <span style={{ color: `var(--${pnl >= 0 ? "good" : "bad"})` }}>{money(pnl)}</span>. Older bot versions included.</p>
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
            </>)}
            </div>
          </Card>
        </div>

        <div className="grid">
          <AgentsPanel agents={d.agents} onChange={load} />
          <ChatPanel symbol={d.symbol} granularity={d.granularity} />
          <Card title="News" aside={<span className="muted small">last 72h · {news.length}</span>}>
            {news.length === 0 ? <div className="empty">No cached headlines.</div> : (
              <ul className="news">
                {(showNews ? news : news.slice(0, 6)).map((n, i) => (
                  <li key={i}>
                    <div className="small muted num">{when(n.time)} · {n.source}{n.escalation && <strong className="bad-t"> · escalation</strong>}</div>
                    {n.url ? <a href={n.url} target="_blank" rel="noreferrer noopener">{n.title}</a> : n.title}
                  </li>
                ))}
              </ul>
            )}
            {news.length > 6 && <button className="linkish" onClick={() => setShowNews(!showNews)}>{showNews ? 'Show fewer' : `Show all ${news.length}`}</button>}
          </Card>
        </div>
      </div>
    </main>
  );
}
