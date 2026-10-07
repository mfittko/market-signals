'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card } from '@/components/ui';

type Action = 'long' | 'short' | 'no_trade';
export type JevPrediction = {
  instrument: string; granularity: string; candleTime: string; forming: boolean; price: number; horizonBars: number; askedAt: string;
  action: Action; probabilities: Record<Action, number>; confidence: number | null;
  quality: number; trendConfirmed: number; model: string | null; latencyMs: number; state: Record<string, string>;
};

const MASK = '•••';
const LABEL: Record<Action, string> = { long: 'Long', short: 'Short', no_trade: 'No trade' };
const TONE: Record<Action, string> = { long: 'var(--good)', short: 'var(--bad)', no_trade: 'var(--muted)' };
const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const age = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`;
};

// Shown only while a TypeSafe key is stored and Jev is on (the engine refuses otherwise).
// One paid call per click; the answer never reaches the bot, the filter or the alerts.
export function JevPanel({ symbol, granularity }: { symbol: string; granularity: string }) {
  const [enabled, setEnabled] = useState(false);
  const [p, setP] = useState<JevPrediction | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    api<{ TYPESAFE_API_KEY?: string; jevEnabled?: string | boolean }>('/engine/settings')
      .then((s) => setEnabled(s.TYPESAFE_API_KEY === MASK && (s.jevEnabled === '1' || s.jevEnabled === true)))
      .catch(() => setEnabled(false));
  }, []);
  // an answer belongs to one timeframe; switching drops it
  useEffect(() => { setP(null); setErr(null); }, [granularity]);
  useEffect(() => {
    if (!p) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [p]);

  if (!enabled || !granularity) return null;

  const check = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ prediction: JevPrediction }>('/engine/jev', { method: 'POST', body: JSON.stringify({ instrument: symbol, granularity }) });
      setP(r.prediction); setNow(Date.now());
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Jev prediction" aside={<button type="button" onClick={() => void check()} disabled={busy}>{busy ? 'Asking…' : 'Check now'}</button>}>
      {err && <p className="msg err" role="alert">{err}</p>}
      {!p && !err && <p className="small muted">Asks TypeSafe Jev whether to enter long, short or not at all on the current {granularity} candle, judged over the next 3 candles. Advisory only.</p>}
      {p && (
        <div aria-live="polite">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 22, color: TONE[p.action] }}>{LABEL[p.action]}</strong>
            <span className="muted small">{pct(p.probabilities[p.action])} · confidence {pct(p.confidence)}</span>
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
          <p className="small" style={{ margin: '4px 0' }}>Setup quality {p.quality.toFixed(1)} of 4 · trend confirmed {pct(p.trendConfirmed)}</p>
          <p className="small muted" style={{ margin: '4px 0' }}>
            {p.granularity} candle {hm(p.candleTime)}{p.forming ? ' (forming)' : ''} at {p.price} · over the next {p.horizonBars} candles · asked {age(p.askedAt, now)}
          </p>
          <details className="small">
            <summary className="muted">What Jev saw</summary>
            <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
              {Object.entries(p.state).filter(([k]) => k !== 'instrument').map(([k, v]) => <li key={k}><span className="muted">{k.replace(/_/g, ' ')}:</span> {v}</li>)}
            </ul>
            <span className="muted">{p.model} · {p.latencyMs} ms</span>
          </details>
        </div>
      )}
    </Card>
  );
}
