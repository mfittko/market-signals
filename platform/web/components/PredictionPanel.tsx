'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Card } from '@/components/ui';
import { loadPrefs } from '@/lib/alerts';

type Action = 'long' | 'short' | 'no_trade';
type Prediction = {
  id: number; instrument: string; granularity: string; candleTime: string; forming: boolean; price: number; horizonBars: number; askedAt: string; expiresAt: string;
  action: Action; probabilities: Record<Action, number>; confidence: number | null;
  quality: number; trendConfirmed: number; latencyMs: number; state: Record<string, string>;
};

const MASK = '•••';
const AUTO_KEY = 'predictionAutoUpdate:';
const HISTORY = 10;
const LABEL: Record<Action, string> = { long: 'Long', short: 'Short', no_trade: 'No trade' };
const TONE: Record<Action, string> = { long: 'var(--good)', short: 'var(--bad)', no_trade: 'var(--muted)' };
const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
const age = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
};
const left = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
// auto-update is chosen per instrument and timeframe and remembered in this browser
const loadAuto = (symbol: string, gran: string) => { try { return localStorage.getItem(`${AUTO_KEY}${symbol}|${gran}`) === '1'; } catch { return false; } };
const saveAuto = (symbol: string, gran: string, on: boolean) => { try { localStorage.setItem(`${AUTO_KEY}${symbol}|${gran}`, on ? '1' : '0'); } catch { /* private window */ } };
const opposite = (a: Action, b: Action) => (a === 'long' && b === 'short') || (a === 'short' && b === 'long');

// Desktop notification for a long/short flip; it fires only while this console tab is open.
function notifyFlip(p: Prediction, was: Action) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !loadPrefs().prediction) return;
  const n = new Notification(`Prediction flipped to ${LABEL[p.action]} on ${p.instrument} ${p.granularity}`, {
    body: `${LABEL[p.action]} ${pct(p.probabilities[p.action])}, was ${LABEL[was]}. At ${p.price}. Advisory only.`, tag: `prediction:${p.id}`,
  });
  n.onclick = () => { window.focus(); n.close(); };
}

// Shown only while a provider key is stored and predictions are on (the engine refuses otherwise).
// Each run is one paid call and is stored, so the latest run comes back on reload. The answer never
// reaches the bot, the filter or the engine alerts; only this tab notifies on a long/short flip. `liveCandleTime` is the newest candle of the page's live
// feed; with auto-update ticked, a new candle there triggers one run.
export function PredictionPanel({ symbol, granularity, liveCandleTime }: { symbol: string; granularity: string; liveCandleTime?: string }) {
  const [enabled, setEnabled] = useState(false);
  const [runs, setRuns] = useState<Prediction[]>([]);
  const [shownId, setShownId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const current = useRef(granularity);
  const autoCandle = useRef<string | null>(null);
  const runsRef = useRef<Prediction[]>([]);
  const autoRef = useRef(false);
  runsRef.current = runs; autoRef.current = auto;

  useEffect(() => { setAuto(loadAuto(symbol, granularity)); }, [symbol, granularity]);
  useEffect(() => {
    api<{ TYPESAFE_API_KEY?: string; predictionEnabled?: string | boolean }>('/engine/settings')
      .then((s) => setEnabled(s.TYPESAFE_API_KEY === MASK && (s.predictionEnabled === '1' || s.predictionEnabled === true)))
      .catch(() => setEnabled(false));
  }, [symbol]);

  // restore: the stored runs of this instrument and timeframe, newest first
  useEffect(() => {
    current.current = granularity;
    setRuns([]); setShownId(null); setErr(null); setLoaded(false); autoCandle.current = null;
    if (!enabled || !granularity) return;
    api<{ predictions: Prediction[] }>(`/engine/predictions?instrument=${encodeURIComponent(symbol)}&granularity=${granularity}&limit=${HISTORY}`)
      .then((r) => { if (current.current === granularity) { setRuns(r.predictions); setLoaded(true); } })
      .catch((e) => { if (current.current === granularity) { setErr(e instanceof Error ? e.message : String(e)); setLoaded(true); } });
  }, [enabled, symbol, granularity]);

  const predict = useCallback(async () => {
    const asked = granularity;
    setBusy(true); setErr(null);
    try {
      const r = await api<{ prediction: Prediction }>('/engine/predict', { method: 'POST', body: JSON.stringify({ instrument: symbol, granularity: asked }) });
      if (current.current !== asked) return;
      // a flip between long and short, judged against the last directional run, alerts while auto-update is on
      const prev = runsRef.current.find((x) => x.action !== 'no_trade');
      if (autoRef.current && prev && opposite(prev.action, r.prediction.action)) notifyFlip(r.prediction, prev.action);
      setRuns((rs) => [r.prediction, ...rs].slice(0, HISTORY)); setShownId(null); setNow(Date.now());
    } catch (e) { if (current.current === asked) setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [symbol, granularity]);

  // auto-update: one run per new candle while ticked; the live feed only polls while the tab is visible
  useEffect(() => {
    if (!enabled || !loaded || !auto || busy || !liveCandleTime) return;
    // strictly newer only: the live feed can step back to the last closed bar when an upstream fetch fails
    const seen = Math.max(Date.parse(runs[0]?.candleTime ?? '') || 0, Date.parse(autoCandle.current ?? '') || 0);
    if (!(Date.parse(liveCandleTime) > seen)) return;
    autoCandle.current = liveCandleTime;
    void predict();
  }, [enabled, loaded, auto, busy, liveCandleTime, runs, predict]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!enabled || !granularity) return null;
  const p = runs.find((r) => r.id === shownId) ?? runs[0];
  const isLatest = p && p.id === runs[0]?.id;
  const expired = (r: Prediction) => Date.parse(r.expiresAt) <= now;

  return (
    <Card title="Prediction" aside={<button type="button" onClick={() => void predict()} disabled={busy}>{busy ? 'Predicting…' : 'Predict now'}</button>}>
      <label className="small"><span><input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); saveAuto(symbol, granularity, e.target.checked); }} /> Auto-update on each new {granularity} candle for {symbol}</span></label>
      {err && <p className="msg err" role="alert">{err}</p>}
      {!p && !err && <p className="small muted">Predicts whether to enter long, short or not at all on the current {granularity} candle, judged over the next 3 candles. Advisory only.</p>}
      {p && (
        <div aria-live="polite" style={expired(p) ? { opacity: 0.6 } : undefined}>
          {!isLatest && <p className="small muted" style={{ margin: '6px 0' }}>Showing an earlier run. <button className="linkish" onClick={() => setShownId(null)}>Back to latest</button></p>}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
            <strong style={{ fontSize: 22, color: TONE[p.action] }}>{LABEL[p.action]}</strong>
            <span className="muted small">{pct(p.probabilities[p.action])} · confidence {pct(p.confidence)}</span>
            {expired(p) ? <span className="chip bad">expired</span> : <span className="chip ok">valid for {left(p.expiresAt, now)}</span>}
          </div>
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
          <p className="small" style={{ margin: '4px 0' }}>Setup quality {p.quality == null ? '–' : p.quality.toFixed(1)} of 4 · trend confirmed {pct(p.trendConfirmed)}</p>
          <p className="small muted" style={{ margin: '4px 0' }}>
            {p.granularity} candle {day(p.candleTime)} {hm(p.candleTime)}{p.forming ? ' (forming)' : ''} at {p.price} · over the next {p.horizonBars} candles · {age(p.askedAt, now)}
          </p>
          <details className="small">
            <summary className="muted">Inputs</summary>
            <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
              {Object.entries(p.state).filter(([k]) => k !== 'instrument').map(([k, v]) => <li key={k}><span className="muted">{k.replace(/_/g, ' ')}:</span> {v}</li>)}
            </ul>
            <span className="muted">{p.latencyMs} ms</span>
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
