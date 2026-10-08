'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Card } from '@/components/ui';
import { loadPrefs, timeMs } from '@/lib/alerts';

type Action = 'long' | 'short' | 'no_trade';
type Prediction = {
  id: number; instrument: string; granularity: string; candleTime: string; forming: boolean; price: number; horizonBars: number; askedAt: string; expiresAt: string;
  action: Action; probabilities: Record<Action, number>; confidence: number | null;
  quality: number | null; trendConfirmed: number | null; latencyMs: number; state: Record<string, string>;
  provider?: string; detail?: LocalDetail | null;
};
// What the local provider stores beside the three bars (scripts/local-predict.mjs)
type BigDayPart = { available: boolean; reached?: boolean; p?: number; usual?: number; thresholdPct?: number; movedPct?: number; text: string };
type LocalDetail = {
  bigDay?: BigDayPart;
  direction: { up: number; interval: [number, number] | null };
  reasons: { code: string; text: string; untested?: boolean }[];
  trend: { text: string };
  news: { latest: { title: string; escalation: string; publishedAt: string } | null } | null;
};
const LOCAL = 'local';
// "41% for a move of 5.4% or more (usual 7%)"; a session past the threshold is a fact, not a chance
function BigDay({ b }: { b?: BigDayPart }) {
  if (!b?.available || b.thresholdPct == null) return <>n/a ({b?.text ?? 'not computed'})</>;
  if (b.reached) return <><strong>reached</strong>, {b.movedPct?.toFixed(1)}% from the session open (big day is {b.thresholdPct.toFixed(1)}% or more)</>;
  return <><strong>{pct(b.p)}</strong> for a move of {b.thresholdPct.toFixed(1)}% or more (usual {pct(b.usual)})</>;
}
const NEWS_SHOWN_MS = 6 * 3600000;

const MASK = '•••';
const AUTO_KEY = 'predictionAutoUpdate:';
const HISTORY = 10;
const LABEL: Record<Action, string> = { long: 'Long', short: 'Short', no_trade: 'No trade' };
const TONE: Record<Action, string> = { long: 'var(--good)', short: 'var(--bad)', no_trade: 'var(--muted)' };
const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const hm = (iso: string) => new Date(timeMs(iso)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const day = (iso: string) => new Date(timeMs(iso)).toLocaleDateString([], { month: 'short', day: 'numeric' });
const age = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - timeMs(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
};
const left = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((timeMs(iso) - now) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
// auto-update is chosen per instrument and timeframe and remembered in this browser
const loadAuto = (symbol: string, gran: string) => { try { return localStorage.getItem(`${AUTO_KEY}${symbol}|${gran}`) === '1'; } catch { return false; } };
const saveAuto = (symbol: string, gran: string, on: boolean) => { try { localStorage.setItem(`${AUTO_KEY}${symbol}|${gran}`, on ? '1' : '0'); } catch { /* private window */ } };
// the timeframes the engine predicts on; mirrors isPredictionGranularity in scripts/predictions.mjs
const SUPPORTED = new Set(['M1', 'M5', 'M15', 'M30', 'H1', 'H4']);
const granMs = (g: string) => Number(g.slice(1)) * (g[0] === 'H' ? 3600000 : 60000);
const opposite = (a: Action, b: Action) => (a === 'long' && b === 'short') || (a === 'short' && b === 'long');

// Desktop notification for a long/short flip; it fires only while this console tab is open.
function notifyFlip(p: Prediction, was: Action) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !loadPrefs().prediction) return;
  const n = new Notification(`Prediction flipped to ${LABEL[p.action]} on ${p.instrument} ${p.granularity}`, {
    body: `${LABEL[p.action]} ${pct(p.probabilities[p.action])}, was ${LABEL[was]}. At ${p.price}. Advisory only.`, tag: `prediction:${p.id}`,
  });
  n.onclick = () => { window.focus(); n.close(); };
}

// Shown only while predictions are on (and, for TypeSafe Jev, its key is stored; the engine refuses otherwise).
// Every run is stored, so the latest run comes back on reload. The answer never reaches the bot, the
// filter or the engine alerts; only this tab notifies on a long/short flip. `liveCandleTime` is the newest
// candle of the page's live feed. The local provider is free, so each new candle there fetches the run for
// the candle that just closed, without a click. A Jev run is one paid call: "Predict now", or one run per
// new candle with auto-update ticked.
export function PredictionPanel({ symbol, granularity, liveCandleTime }: { symbol: string; granularity: string; liveCandleTime?: string }) {
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState(LOCAL);
  const local = provider === LOCAL;
  const [runs, setRuns] = useState<Prediction[]>([]);
  const [shownId, setShownId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // both carry the timeframe they belong to, so a render during a timeframe switch never acts on the old one's state
  const [autoState, setAutoState] = useState({ gran: '', on: false });
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const auto = local || (autoState.gran === granularity && autoState.on);
  const loaded = loadedFor === granularity;
  const [now, setNow] = useState(() => Date.now());
  const current = useRef(granularity);
  const autoCandle = useRef<string | null>(null);
  const lastTry = useRef(0);
  // the newest long or short run, kept apart from the ten-row history so no_trade runs never erase the flip baseline
  const lastDir = useRef<{ id: number; action: Action } | null>(null);
  const autoRef = useRef(false);
  autoRef.current = auto;
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    on();
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  useEffect(() => { setAutoState({ gran: granularity, on: loadAuto(symbol, granularity) }); }, [symbol, granularity]);
  useEffect(() => {
    api<{ TYPESAFE_API_KEY?: string; predictionEnabled?: string | boolean; predictionProvider?: string }>('/engine/settings')
      .then((s) => {
        const prov = s.predictionProvider === 'typesafe-jev' ? 'typesafe-jev' : LOCAL;
        setProvider(prov);
        setEnabled((prov === LOCAL || s.TYPESAFE_API_KEY === MASK) && (s.predictionEnabled === '1' || s.predictionEnabled === true));
      })
      .catch(() => setEnabled(false));
  }, [symbol]);

  // restore: the stored runs of this instrument and timeframe, newest first
  useEffect(() => {
    current.current = granularity;
    setRuns([]); setShownId(null); setErr(null); setLoadedFor(null); autoCandle.current = null; lastDir.current = null;
    if (!enabled || !SUPPORTED.has(granularity)) return;
    let live = true; // a restore that answers after this effect is cleaned up is ignored
    const q = `/engine/predictions?instrument=${encodeURIComponent(symbol)}&granularity=${granularity}`;
    Promise.all([api<{ predictions: Prediction[] }>(`${q}&limit=${HISTORY}`), api<{ predictions: Prediction[] }>(`${q}&limit=1&directional=1`)])
      .then(([r, d]) => {
        if (!live) return;
        // keep runs a "Predict now" completed while this restore was pending
        setRuns((rs) => [...rs, ...r.predictions.filter((x) => !rs.some((y) => y.id === x.id))].sort((a, b) => b.id - a.id).slice(0, HISTORY));
        const dir = d.predictions[0];
        if (dir && (!lastDir.current || dir.id > lastDir.current.id)) lastDir.current = { id: dir.id, action: dir.action };
        setLoadedFor(granularity);
      })
      .catch((e) => { if (live) { setErr(e instanceof Error ? e.message : String(e)); setLoadedFor(granularity); } });
    return () => { live = false; };
  }, [enabled, symbol, granularity]);

  const predict = useCallback(async () => {
    const asked = granularity;
    setBusy(true); setErr(null);
    try {
      const r = await api<{ prediction: Prediction }>('/engine/predict', { method: 'POST', body: JSON.stringify({ instrument: symbol, granularity: asked, ...(local ? { reuse: true } : {}) }) });
      if (current.current !== asked) return;
      // a flip between long and short, judged against the last directional run, alerts while auto-update is on
      const prev = lastDir.current;
      if (autoRef.current && prev && opposite(prev.action, r.prediction.action)) notifyFlip(r.prediction, prev.action);
      if (r.prediction.action !== 'no_trade' && (!prev || r.prediction.id > prev.id)) lastDir.current = { id: r.prediction.id, action: r.prediction.action };
      setRuns((rs) => [r.prediction, ...rs.filter((x) => x.id !== r.prediction.id)].slice(0, HISTORY)); setShownId(null); setNow(Date.now());
    } catch (e) { if (current.current === asked) setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [symbol, granularity, local]);

  // auto-update: one run per new candle while ticked and the tab is visible; a candle that arrived while
  // hidden is picked up when the tab becomes visible again
  useEffect(() => {
    if (!enabled || !loaded || !auto || busy || !liveCandleTime || !visible || document.visibilityState !== 'visible') return;
    if (local) {
      // a local run covers the closed candle before the forming one; right after a close the engine may
      // not have the closed bar yet, so ask again every 15 s until the run catches up with the live feed
      const covered = (timeMs(runs[0]?.candleTime ?? '') || 0) + granMs(granularity);
      if (!(timeMs(liveCandleTime) > covered) || now - lastTry.current < 15000) return;
      lastTry.current = now;
      void predict();
      return;
    }
    // strictly newer only: the live feed can step back to the last closed bar when an upstream fetch fails
    const seen = Math.max(timeMs(runs[0]?.candleTime ?? '') || 0, timeMs(autoCandle.current ?? '') || 0);
    if (!(timeMs(liveCandleTime) > seen)) return;
    autoCandle.current = liveCandleTime;
    void predict();
  }, [enabled, loaded, auto, busy, liveCandleTime, runs, predict, visible, local, granularity, now]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!enabled || !granularity) return null;
  if (!SUPPORTED.has(granularity)) return <Card title="Prediction"><p className="small muted">Predictions are not available on {granularity}. They run on M1, M5, M15, M30, H1 and H4.</p></Card>;
  const p = runs.find((r) => r.id === shownId) ?? runs[0];
  const isLatest = p && p.id === runs[0]?.id;
  const expired = (r: Prediction) => timeMs(r.expiresAt) <= now;
  const d = p?.provider === LOCAL ? p.detail ?? null : null;
  const iv = d?.direction.interval;
  const news = d?.news?.latest && now - timeMs(d.news.latest.publishedAt) <= NEWS_SHOWN_MS ? d.news.latest : null;

  return (
    <Card title="Prediction" aside={local ? undefined : <button type="button" onClick={() => void predict()} disabled={busy}>{busy ? 'Predicting…' : 'Predict now'}</button>}>
      {local
        ? <p className="small muted" style={{ margin: 0 }}>Updates on each closed {granularity} candle for {symbol}. Free, computed on this machine.</p>
        : <label className="small"><span><input type="checkbox" checked={auto} onChange={(e) => { setAutoState({ gran: granularity, on: e.target.checked }); saveAuto(symbol, granularity, e.target.checked); }} /> Auto-update on each new {granularity} candle for {symbol}</span></label>}
      {err && <p className="msg err" role="alert">{err}</p>}
      {!p && !err && <p className="small muted">{local ? `Waiting for the next closed ${granularity} candle.` : `Predicts whether to enter long, short or not at all on the current ${granularity} candle, judged over the next 3 candles.`} Advisory only.</p>}
      {p && (
        <div aria-live="polite" style={expired(p) ? { opacity: 0.6 } : undefined}>
          {!isLatest && <p className="small muted" style={{ margin: '6px 0' }}>Showing an earlier run. <button className="linkish" onClick={() => setShownId(null)}>Back to latest</button></p>}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
            <strong style={{ fontSize: 22, color: TONE[p.action] }}>{LABEL[p.action]}</strong>
            <span className="muted small">{pct(p.probabilities[p.action])} · {d ? <>long {pct(d.direction.up)}{iv ? ` (${pct(iv[0])}–${pct(iv[1])})` : ''}</> : <>confidence {pct(p.confidence)}</>}</span>
            {expired(p) ? <span className="chip bad">expired</span> : <span className="chip ok">valid for {left(p.expiresAt, now)}</span>}
          </div>
          {/* local: research found no direction edge; Jev: a historic backtest found it no better than chance. Keep until a calibrated version shows one. */}
          <p className="small" style={{ margin: '4px 0', color: 'var(--warn)' }}>{d
            ? 'Direction: no measurable edge (research). Signals in this system average about −0.1 R after costs; reasons below are measured filters, not buy signals.'
            : 'No demonstrated edge yet: in a historic backtest these predictions were not more accurate than chance. Treat this as one input, not a signal.'}</p>
          {d && d.reasons.length > 0 && (
            <ul className="small" style={{ margin: '6px 0', paddingLeft: 18 }}>
              {d.reasons.map((r) => <li key={r.code}>{r.text}</li>)}
            </ul>
          )}
          <div style={{ display: 'grid', gap: 4, margin: '10px 0' }}>
            {(['long', 'short', 'no_trade'] as Action[]).map((a) => (
              <div key={a} style={{ display: 'grid', gridTemplateColumns: '72px 1fr 40px', alignItems: 'center', gap: 8 }} className="small">
                <span>{LABEL[a]}</span>
                <span style={{ height: 8, borderRadius: 4, background: 'var(--neutral-bg)', overflow: 'hidden' }} role="meter" aria-label={`${LABEL[a]} probability`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((p.probabilities[a] ?? 0) * 100)}>
                  <span style={{ display: 'block', height: '100%', width: pct(p.probabilities[a] ?? 0), background: TONE[a] }} />
                </span>
                <span className="num">{pct(p.probabilities[a])}</span>
              </div>
            ))}
          </div>
          {d
            ? <p className="small" style={{ margin: '4px 0' }}>Big-day chance today: <BigDay b={d.bigDay} /> · trend: {d.trend.text}</p>
            : <p className="small" style={{ margin: '4px 0' }}>Setup quality {p.quality == null ? '–' : p.quality.toFixed(1)} of 4 · trend confirmed {pct(p.trendConfirmed)}</p>}
          {news && <p className="small" style={{ margin: '4px 0' }}>News: {news.escalation} · {age(news.publishedAt, now)}: {news.title.length > 90 ? `${news.title.slice(0, 89)}…` : news.title}</p>}
          <p className="small muted" style={{ margin: '4px 0' }}>
            {p.granularity} candle {day(p.candleTime)} {hm(p.candleTime)}{p.forming ? ' (forming)' : d ? ' (closed)' : ''} at {p.price} · {d ? 'direction over the next 6 hours, big day over the session' : `over the next ${p.horizonBars} candles`} · {age(p.askedAt, now)}
          </p>
          <details className="small">
            <summary className="muted">Inputs</summary>
            <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
              {Object.entries(p.state).filter(([k]) => k !== 'instrument').map(([k, v]) => <li key={k}><span className="muted">{k.replace(/_/g, ' ')}:</span> {v}</li>)}
            </ul>
            {!d && <span className="muted">{p.latencyMs} ms</span>}
          </details>
        </div>
      )}
      {runs.length > 1 && (
        <details className="small" style={{ marginTop: 8 }}>
          <summary className="muted">History ({runs.length})</summary>
          <div className="scroll"><table>
            <thead><tr><th>Asked</th><th>Candle</th><th>Prediction</th><th>Price</th></tr></thead>
            <tbody>{runs.map((r) => (
              <tr key={r.id} aria-selected={r.id === p?.id} style={r.id === p?.id ? { background: 'var(--neutral-bg)' } : undefined}>
                <td className="num"><button className="linkish" onClick={() => setShownId(r.id)} aria-label={`Show the run from ${day(r.askedAt)} ${hm(r.askedAt)}`}>{day(r.askedAt)} {hm(r.askedAt)}</button></td>
                <td className="num">{hm(r.candleTime)}</td>
                <td style={{ color: TONE[r.action] }}>{LABEL[r.action]} {pct(r.probabilities[r.action])}{expired(r) && <span className="muted"> · expired</span>}</td>
                <td className="num">{r.price}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </details>
      )}
    </Card>
  );
}
