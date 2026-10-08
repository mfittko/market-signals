'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, money, type InstrumentDetail } from '@/lib/api';
import { useLive } from '@/lib/live';
import { BotBadge, useActiveBots } from '@/lib/bots';
import { CandleChart, type Candle, type STPoint } from '@/components/CandleChart';
import { AgentsPanel } from '@/components/AgentsPanel';
import { ChatPanel } from '@/components/ChatPanel';
import { PredictionPanel } from '@/components/PredictionPanel';
import { Card, Loading } from '@/components/ui';
import Markdown from 'react-markdown';
import { useWatchers } from '@/lib/alerts';
import { loadHorizon, onHorizonChange, type SeriesEntry } from '@/lib/prediction';

const LIMIT = 10;
const POLL_MS = 15000;
type Live = { candles: Candle[]; supertrend: STPoint[]; signals: InstrumentDetail['signals']; quote?: { last?: number }; fetchedAt: string; granularity?: string };
type NewsItem = { title: string; titleOriginal?: string; relevant?: boolean; pending?: boolean; summary?: string; source: string; time: string; url: string | null; tone: string | null; escalation: boolean };
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

// Keyed by slug: switching instruments unmounts the old view completely (data, timeframe,
// tab, chat, pollers), so nothing from the previous instrument shows under the new URL.
export default function InstrumentPage() {
  const { slug } = useParams<{ slug: string }>();
  return <InstrumentView key={slug} />;
}

function InstrumentView() {
  const { slug } = useParams<{ slug: string }>();
  const [gran, setGran] = useState<string>(useSearchParams().get('granularity') ?? '');
  const [d, setD] = useState<InstrumentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { tick, newsTick } = useLive(undefined, slug);
  const [tab, setTab] = useState<'signals' | 'trades'>('signals');
  const bots = useActiveBots();
  const w = useWatchers();
  const [allSig, setAllSig] = useState(false);
  const [allTr, setAllTr] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  const [liveErr, setLiveErr] = useState<string | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [showNews, setShowNews] = useState(false);
  const [escalationPref, setOnlyEscalation] = useState(true);
  const pendingNews = news.filter((n) => n.pending).length;
  const relevantNews = news.filter((n) => n.relevant !== false && !n.pending);
  const escalations = relevantNews.filter((n) => n.escalation).length;
  const onlyEscalation = escalationPref && escalations > 0; // no escalations: fall back to every relevant headline
  const shownNews = onlyEscalation ? relevantNews.filter((n) => n.escalation) : relevantNews;

  const latestLoad = useRef('');
  const load = useCallback(async () => {
    const key = `${slug}|${gran}`; latestLoad.current = key;
    try {
      const r = await api<InstrumentDetail>(`/instruments/${slug}${gran ? `?granularity=${gran}` : ''}`);
      if (latestLoad.current !== key) return; // a later selection already owns the page
      setD(r); setError(null);
      // The server falls back to an imported granularity when the requested one has none; follow it so title, button, filter and live candles agree.
      if (r.granularity && r.granularity !== gran) setGran(r.granularity);
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
        if (!dead) { setLive({ ...r, granularity: gran }); setLiveErr(null); }
      } catch (e) { if (!dead) setLiveErr(e instanceof Error ? e.message : String(e)); }
    };
    setLive(null);
    void pull();
    const t = setInterval(pull, POLL_MS);
    document.addEventListener('visibilitychange', pull);
    return () => { dead = true; clearInterval(t); document.removeEventListener('visibilitychange', pull); };
  }, [slug, gran]);

  // Local prediction per closed candle for the chart tooltip; fetched again when a new candle closes.
  // Free on the engine side; while predictions are off the request fails and the tooltip shows none.
  const [series, setSeries] = useState<{ key: string; entries: SeriesEntry[] } | null>(null);
  const [horizon, setHorizon] = useState(6);
  useEffect(() => { setHorizon(loadHorizon()); return onHorizonChange(() => setHorizon(loadHorizon())); }, []);
  const liveCandles = live?.granularity === gran ? live.candles : null;
  const closedTimes = liveCandles?.filter((c) => c.complete !== false).map((c) => c.time) ?? [];
  const firstClosed = closedTimes[0];
  const lastClosed = closedTimes.at(-1);
  useEffect(() => {
    if (!d?.symbol || !gran || !firstClosed || !lastClosed) return;
    const key = `${d.symbol}|${gran}|${lastClosed}`;
    let dead = false;
    api<{ entries: SeriesEntry[] }>(`/engine/predictions/series?instrument=${encodeURIComponent(d.symbol)}&granularity=${gran}&from=${encodeURIComponent(firstClosed)}&to=${encodeURIComponent(lastClosed)}`)
      .then((r) => { if (!dead) setSeries({ key: `${d.symbol}|${gran}`, entries: r.entries ?? [] }); })
      .catch(() => { /* predictions off or engine offline: no tooltip line */ });
    return () => { dead = true; };
  }, [d?.symbol, gran, firstClosed, lastClosed]);

  useEffect(() => {
    let dead = false;
    api<{ items: NewsItem[] }>(`/instruments/${slug}/news?hours=72`).then((r) => { if (!dead) setNews(r.items ?? []); }).catch(() => { if (!dead) setNews([]); });
    return () => { dead = true; };
  }, [slug, newsTick]);

  if (error) return <main className="wrap"><Link href="/">← Desk</Link><div className="msg err" role="alert" style={{ marginTop: 12 }}>{error}</div></main>;
  if (!d) return <main className="wrap"><Loading full /></main>;

  const won = d.trades.filter((t) => t.realized > 0).length;
  const pnl = d.trades.reduce((s, t) => s + t.realized, 0);
  const candles = live?.candles.length ? live.candles : d.candles;
  const signals = live?.signals.length ? live.signals : d.signals;
  const lastFlip = [...signals].find((s) => s.granularity === d.granularity && candles.some((c) => c.time === s.time));

  return (
    <main className="wrap">
      <div className="top">
        <div className="left"><Link href="/">← Desk</Link><h1>{d.name}</h1><span className="muted">{d.symbol} · {d.market}</span><BotBadge grans={bots?.get(d.symbol)} />
          {/* always rendered (disabled until the list arrives), so the header does not change height when it loads */}
          <label className="chip" title="The engine looks for flips on this market and alerts you when the filter passes one. It stays on while the paper bot is on or holds a position here."><input type="checkbox" checked={w.watched?.has(`${d.symbol}|${d.granularity}`) ?? false} disabled={w.busy || !w.watched || !d.granularity} onChange={() => void w.toggle(d.symbol, d.granularity)} /> Signal alerts {d.granularity}</label>
          {w.err && <span className="msg err" role="alert">{w.err}</span>}</div>
        <div className="seg" role="group" aria-label="Granularity">
          {d.granularities.map((g) => <button key={g.granularity} aria-pressed={g.granularity === d.granularity} onClick={() => setGran(g.granularity)}>{g.granularity}{w.watched?.has(`${d.symbol}|${g.granularity}`) && <span title="Signal alerts on" aria-label="alerts on"> ●</span>}</button>)}
        </div>
      </div>

      <div className="grid desk">
        <div className="grid">
      <Card title={`Chart · ${d.granularity}`} className="chart-card" aside={
        <span className="muted small chart-aside">
          {!live && !liveErr ? 'connecting to live data…' : live ? `live · updated ${new Date(live.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}` : `imported history through ${d.candles.length ? when(d.candles[d.candles.length - 1].time) : "n/a"}${liveErr ? " · engine offline" : ""}`}
          {(live || liveErr) && lastFlip ? ` · ${lastFlip.signal} flip marked` : ''}
        </span>}>
        {!live && !liveErr ? (
          // Draw once, from the source that will stay: imported history first would jump when the live candles arrive.
          <div className="chart-wait" aria-busy="true"><Loading /></div>
        ) : candles.length ? (
          <CandleChart candles={candles} supertrend={live?.supertrend} lastPrice={live?.quote?.last}
            signals={signals.filter((s) => s.granularity === d.granularity)}
            trades={d.trades.filter((t) => !t.granularity || t.granularity === d.granularity)}
            news={relevantNews.map((n) => ({ time: n.time, title: n.title, source: n.source, escalation: n.escalation, impact: n.tone }))}
            predictions={series?.key === `${d.symbol}|${d.granularity}` ? { entries: series.entries, horizon } : undefined} />
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
          <PredictionPanel symbol={d.symbol} granularity={d.granularity} liveCandleTime={live?.granularity === d.granularity ? live.candles.at(-1)?.time : undefined} />
          <AgentsPanel agents={d.agents} onChange={load} />
          <ChatPanel symbol={d.symbol} granularity={d.granularity} />
          <Card title="News" aside={<span className="muted small">last 72h · {relevantNews.length}{escalations > 0 && ` · ${escalations} escalation${escalations === 1 ? "" : "s"}`}</span>}>
            {shownNews.length === 0 ? <div className="empty">{pendingNews > 0 ? `Translating and sorting ${pendingNews} headlines…` : news.length > 0 ? 'No headlines on this market.' : 'No cached headlines.'}</div> : (
              <ul className="news">
                {(showNews ? shownNews : shownNews.slice(0, 6)).map((n, i) => (
                  <li key={i} className={n.summary ? 'news-item has-pop' : 'news-item'} tabIndex={n.summary ? 0 : undefined}>
                    <div className="small muted num">{when(n.time)} · {n.source}{n.titleOriginal && ' · translated'}{n.summary && ' · summary'}{n.escalation && <strong className="bad-t"> · escalation</strong>}</div>
                    {n.url ? <a href={n.url} target="_blank" rel="noreferrer noopener">{n.title}</a> : <span>{n.title}</span>}
                    {(n.summary || n.titleOriginal) && (
                      <div className="news-pop md" role="tooltip">
                        {n.summary && <Markdown disallowedElements={['img', 'a']} unwrapDisallowed>{n.summary}</Markdown>}
                        {n.titleOriginal && <div className="small muted">Original: {n.titleOriginal}</div>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {pendingNews > 0 && shownNews.length > 0 && <div className="small muted">Translating and sorting {pendingNews} more headlines…</div>}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {shownNews.length > 6 && <button className="linkish" onClick={() => setShowNews(!showNews)}>{showNews ? 'Show fewer' : `Show all ${shownNews.length}`}</button>}
              {escalations > 0 && <button className="linkish" onClick={() => setOnlyEscalation(!escalationPref)}>{onlyEscalation ? 'Show all headlines' : `Only escalations (${escalations})`}</button>}
            </div>
          </Card>
        </div>
      </div>
    </main>
  );
}
