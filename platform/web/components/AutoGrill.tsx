'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { GrillPanel } from '@/components/GrillPanel';
import { replyIsCurrent } from '@/lib/reply-current';
import { scopeKey as keyOf } from '@/lib/scope-key';

export type Scope = { instrument: string; granularity: string };
type Stats = { trades: number; winRate: number; expectancy: number; profitFactor: number; maxDrawdownR: number };
type Params = { stopAtr: number; rr: number; maxBars: number; minAdx: number; minVolume: number };
type Cand = { params: Params; train: Stats; test: Stats; holds?: boolean };
type Result = {
  backtest: { instrument: string; granularity: string; from: string; to: string; candles: number; flips: number; tried: number; baseline: Cand; candidates: Cand[]; caveats: string[] };
  turn?: { findings?: { issue: string; fix?: string }[]; recommendation?: string; prompt?: string; summary?: string } | null;
  coachError?: string;
};

const r2 = (v: number) => (v >= 0 ? '' : '−') + Math.abs(v).toFixed(2);
const describe = (p: Params) => [`${p.stopAtr} ATR stop`, p.rr ? `${p.rr}R target` : 'no target', `exit on reversal or after ${p.maxBars} bars`, p.minAdx ? `ADX ≥ ${p.minAdx}` : null, p.minVolume ? `volume ≥ ${p.minVolume}×` : null].filter(Boolean).join(' · ');

function Row({ label, c }: { label: string; c: Cand }) {
  const good = c.holds;
  return (
    <tr>
      <td>{label}<div className="muted small">{describe(c.params)}</div></td>
      <td className="num">{c.train.trades}</td><td className="num">{r2(c.train.expectancy)}</td>
      <td className="num">{c.test.trades}</td><td className="num">{r2(c.test.expectancy)}</td>
      <td className="num">{c.test.profitFactor.toFixed(2)}</td>
      <td>{c.holds === undefined ? '' : good ? <span className="pill s-succeeded">Holds</span> : <span className="pill s-cancelled">Does not hold</span>}</td>
    </tr>
  );
}

// Auto grill: no questions. The console backtests Supertrend flips with a small grid of settings,
// ranks them on early trades, judges them on later trades, and the coach rewrites the prompt from that evidence.
export function AutoGrill({ name, draft, scopes, onApply, reset = 0 }: { name: string; draft: string; scopes: Scope[]; onApply: (p: string) => void; reset?: number }) {
  // the strategy's own scopes first, then the same instruments on other timeframes: a short H1 history often needs M5
  const options = useMemo(() => {
    const seen = new Set<string>(), out: Scope[] = [];
    for (const s of [...scopes, ...scopes.flatMap((s) => ["M5", "M15", "H1", "M1"].map((g) => ({ instrument: s.instrument, granularity: g })))]) {
      const k = `${s.instrument}|${s.granularity}`;
      if (!seen.has(k)) { seen.add(k); out.push(s); }
    }
    return out;
  }, [scopes]);
  const [scope, setScope] = useState<Scope | null>(scopes[0] ?? null);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  // Reset on a change of strategy or scope list. The key is a string, so a caller that builds a new array each render keeps the result.
  const alive = useRef(true); // a reply that lands after the strategy changed must not touch the editor
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const scopeKey = keyOf(scopes);
  const onScreen = useRef(""); onScreen.current = `${name}|${scopeKey}`;
  useEffect(() => { setScope(scopes[0] ?? null); setRes(null); setError(null); setApplied(false); }, [name, scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setApplied(false); }, [reset]); // the editor text was restored

  if (scopes.length === 0) return <p className="muted small">This strategy has no instrument yet. Assign it to an agent first, so there is history to test.</p>;

  async function run() {
    if (!scope || busy) return;
    setBusy(true); setError(null); setRes(null); setApplied(false);
    const requestedFor = onScreen.current;
    try {
      const r = await api<Result>('/strategies/autogrill', { method: 'POST', body: JSON.stringify({ name, draft, ...scope }) });
      if (!replyIsCurrent(requestedFor, onScreen.current, alive.current)) return;
      setRes(r);
      // a rewritten prompt goes straight into the editor; the wrapper offers Undo the proposal
      if (r.turn?.prompt) { onApply(r.turn.prompt); setApplied(true); }
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const key = (s: Scope) => `${s.instrument}|${s.granularity}`;
  const bt = res?.backtest;
  return (
    <div>
      <p className="muted small" style={{ marginTop: 0 }}>
        No questions. The console replays past Supertrend flips with 192 combinations of stop, target, ADX and volume filters.
        It ranks them on the earlier part of the history and judges them on the later part. Then the coach rewrites the prompt from that evidence.
        It tests the flip rule family, not the prompt itself.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={scope ? key(scope) : ''} onChange={(e) => setScope(options.find((s) => key(s) === e.target.value) ?? null)} aria-label="History to test on">
          {options.map((s) => <option key={key(s)} value={key(s)}>{s.instrument} · {s.granularity}</option>)}
        </select>
        <button onClick={() => void run()} disabled={busy || !scope}>{busy ? 'Backtesting…' : 'Run the auto grill'}</button>
      </div>
      {error && <p className="msg err" role="alert">{error}</p>}
      {bt && (
        <div style={{ marginTop: 12 }}>
          <div className="muted small">{bt.instrument} {bt.granularity} · {new Date(bt.from).toLocaleDateString()} to {new Date(bt.to).toLocaleDateString()} · {bt.candles.toLocaleString()} candles · {bt.flips} flips · {bt.tried} settings tried</div>
          <div className="scroll"><table>
            <thead><tr><th>Setting</th><th className="num">Train n</th><th className="num">Train R</th><th className="num">Test n</th><th className="num">Test R</th><th className="num">Test PF</th><th /></tr></thead>
            <tbody>
              <Row label="Plain flip (baseline)" c={bt.baseline} />
              {bt.candidates.map((c, i) => <Row key={i} label={`Candidate ${i + 1}`} c={c} />)}
            </tbody>
          </table></div>
          <p className="muted small" style={{ margin: '4px 0' }}>R is profit in multiples of the initial stop, averaged per trade. PF is profit factor. Trust the test columns.</p>
          <ul className="small muted" style={{ paddingLeft: 18 }}>{bt.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>
          {res?.coachError && <p className="msg err">{res.coachError}. The backtest above still stands.</p>}
          {res?.turn?.findings && res.turn.findings.length > 0 && (
            <div className="grill-find"><strong className="small">What the evidence says</strong>
              <ul>{res.turn.findings.map((f, i) => <li key={i}>{f.issue}{f.fix ? <span className="muted"> · {f.fix}</span> : null}</li>)}</ul>
            </div>
          )}
          {res?.turn?.recommendation && <div className="grill-rec"><strong className="small">Recommendation</strong> {res.turn.recommendation}</div>}
          {res?.turn?.prompt && (
            <div style={{ marginTop: 8 }}>
              <pre className="diff" style={{ maxHeight: 240, overflow: 'auto' }}>{res.turn.prompt}</pre>
              <button onClick={() => { onApply(res.turn!.prompt!); setApplied(true); }} disabled={applied}>{applied ? 'Applied to the editor' : 'Apply to the editor'}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// One place for both ways to sharpen a strategy. A proposed prompt goes straight into the editor.
// The text from before the first proposal is kept, so one click on Undo the proposal restores it.
export function Sharpen({ name, mode, draft, brief, scopes, onApply }: {
  name: string; mode: 'refine' | 'create'; draft: string; brief?: string; scopes: Scope[]; onApply: (p: string) => void;
}) {
  const [tab, setTab] = useState<'guided' | 'auto'>('guided');
  const [before, setBefore] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  useEffect(() => { setBefore(null); }, [name]);
  const apply = (p: string) => { setBefore((b) => b ?? draft); onApply(p); };
  const discard = () => { if (before === null) return; onApply(before); setBefore(null); setReset((n) => n + 1); };
  return (
    <div>
      <div role="group" aria-label="Grill mode" style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <button className={tab === 'guided' ? '' : 'ghost'} aria-pressed={tab === 'guided'} onClick={() => setTab('guided')}>Guided</button>
        <button className={tab === 'auto' ? '' : 'ghost'} aria-pressed={tab === 'auto'} onClick={() => setTab('auto')}>Auto (backtest)</button>
      </div>
      {before !== null && (
        <p className="msg" role="status" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>The editor now holds the coach's proposal. Nothing is saved until you save a version.</span>
          <button className="ghost" onClick={discard}>Undo the proposal</button>
        </p>
      )}
      {tab === 'guided'
        ? <GrillPanel key={name} name={name} mode={mode} draft={draft} brief={brief} onApply={apply} reset={reset} />
        : <AutoGrill key={name} name={name} draft={draft} scopes={scopes} onApply={apply} reset={reset} />}
    </div>
  );
}
