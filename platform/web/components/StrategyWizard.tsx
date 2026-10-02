'use client';
import { useEffect, useMemo, useState } from 'react';
import { api, type DeskRow } from '@/lib/api';
import { Sharpen, type Scope } from '@/components/AutoGrill';

const STEPS = ['Basics', 'Style', 'Entry', 'Risk', 'Review'] as const;
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,63}$/;
const TIMEFRAMES = ['M1', 'M5', 'M15', 'H1'];

type Style = { id: string; title: string; blurb: string; entry: string; adx: number; vol: number; htf: boolean; stop: number; rr: number };
const STYLES: Style[] = [
  { id: 'trend', title: 'Trend following', blurb: 'Enter when the Supertrend flips with the trend already strong.',
    entry: 'Enter in the direction of a fresh Supertrend flip. The flip must be recent and the close must be on the flip side of the Supertrend line.', adx: 25, vol: 1, htf: true, stop: 1.5, rr: 2 },
  { id: 'breakout', title: 'Breakout', blurb: 'Enter when price breaks the 20-bar high or low on real volume.',
    entry: 'Enter when the close breaks the 20-bar high (long) or low (short) with the impulse axis confirming. Skip breaks that come after an extended run.', adx: 20, vol: 1.3, htf: true, stop: 1.2, rr: 2 },
  { id: 'reversion', title: 'Mean reversion', blurb: 'Fade a stretched move back toward VWAP or the mean.',
    entry: 'Enter against a stretched move when price is far from VWAP and the exhaustion axis shows the move is tiring. Target a return toward VWAP.', adx: 0, vol: 0, htf: false, stop: 1, rr: 1.5 },
  { id: 'blank', title: 'Start blank', blurb: 'Write the entry rule yourself.', entry: '', adx: 0, vol: 0, htf: false, stop: 1.5, rr: 2 },
];

type F = { name: string; instrument: string; granularity: string; direction: 'both' | 'long' | 'short'; style: string;
  entry: string; adx: number; vol: number; exhaustion: boolean; htf: boolean; stop: number; rr: number; maxBars: number };

function build(f: F): string {
  const dir = f.direction === 'both' ? 'Trade long and short.' : `Trade ${f.direction} only.`;
  const rules = [f.entry.trim()].filter(Boolean);
  if (f.adx > 0) rules.push(`Require ADX of at least ${f.adx}.`);
  if (f.vol > 0) rules.push(`Require a volume ratio of at least ${f.vol}.`);
  if (f.exhaustion) rules.push('Do not enter when the exhaustion axis vetoes the move.');
  if (f.htf) rules.push('Trade only with the higher-timeframe trend.');
  const lines = [
    `Strategy ${f.name} for ${f.instrument} on ${f.granularity}. ${dir}`,
    '',
    'Entry:', ...rules.map((r) => `- ${r}`),
    '',
    'Risk:',
    `- Place the stop ${f.stop} ATR from the entry, and beyond the nearest 20-bar extreme when that is further.`,
    ...(f.rr > 0 ? [`- Set the target at ${f.rr} times the stop distance.`] : []),
    ...(f.maxBars > 0 ? [`- Close the trade after ${f.maxBars} one-minute bars (${f.maxBars} minutes) without progress.`] : []),
    '',
    'Hold when any condition is unclear, when the flip is stale, or when the higher-timeframe trend disagrees.',
  ];
  return lines.join('\n');
}

export function StrategyWizard({ existing, onDone, onCancel }: { existing: string[]; onDone: (name: string) => void; onCancel: () => void }) {
  const [step, setStep] = useState(0);
  const [desk, setDesk] = useState<DeskRow[]>([]);
  const [f, setF] = useState<F>({ name: '', instrument: '', granularity: 'M5', direction: 'both', style: 'trend',
    entry: STYLES[0].entry, adx: STYLES[0].adx, vol: STYLES[0].vol, exhaustion: true, htf: STYLES[0].htf, stop: STYLES[0].stop, rr: STYLES[0].rr, maxBars: 0 });
  const [prompt, setPrompt] = useState('');
  const [edited, setEdited] = useState(false);
  const [assign, setAssign] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof F>(k: K, v: F[K]) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    api<{ instruments: DeskRow[] }>('/desk').then((r) => { setDesk(r.instruments); setF((x) => (x.instrument ? x : { ...x, instrument: r.instruments[0]?.symbol ?? '' })); }).catch(() => {});
  }, []);
  // the generated prompt follows the answers until the trader edits it by hand
  const generated = useMemo(() => build(f), [f]);
  useEffect(() => { if (!edited) setPrompt(generated); }, [generated, edited]);

  const pick = (s: Style) => setF((x) => ({ ...x, style: s.id, entry: s.entry, adx: s.adx, vol: s.vol, htf: s.htf, stop: s.stop, rr: s.rr }));
  const nameError = !f.name.trim() ? 'Give the strategy a name.' : !NAME_OK.test(f.name.trim()) ? 'Use letters, digits, spaces, dots, dashes or underscores (up to 64).'
    : existing.some((n) => n.toLowerCase() === f.name.trim().toLowerCase()) ? 'A strategy with this name exists.' : null;
  const problem = step === 0 ? nameError ?? (!f.instrument ? 'Pick an instrument.' : null)
    : step === 2 ? (!f.entry.trim() ? 'Describe when to enter.' : null)
    : step === 3 ? (f.stop <= 0 ? 'The stop distance must be above zero.' : null) : null;

  const candidates = (desk.find((d) => d.symbol === f.instrument)?.agents ?? []).filter((a) => a.runtime === 'llm' && a.granularity === f.granularity);
  const brief = `Instrument ${f.instrument}, ${f.granularity}, direction ${f.direction}, style ${f.style}.`;

  async function create() {
    setBusy(true); setError(null);
    const name = f.name.trim();
    try {
      await api(`/strategies/${encodeURIComponent(name)}/versions`, { method: 'POST', body: JSON.stringify({ prompt, instrument: f.instrument, granularity: f.granularity }) });
      for (const a of candidates.filter((c) => assign[c.id])) {
        await api(`/agents/${a.id}`, { method: 'PATCH', body: JSON.stringify({ strategy: name }) });
      }
      onDone(name);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  return (
    <div>
      <ol className="wizard-steps" aria-label="Steps">
        {STEPS.map((s, i) => <li key={s} className={i === step ? 'on' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>{i + 1}. {s}</li>)}
      </ol>

      {step === 0 && (
        <div>
          <label className="field"><span>Name</span>
            <input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="For example: Oil breakout M5" autoFocus />
          </label>
          <label className="field"><span>Instrument</span>
            <select value={f.instrument} onChange={(e) => set('instrument', e.target.value)}>
              {desk.map((d) => <option key={d.symbol} value={d.symbol}>{d.symbol} · {d.name}</option>)}
            </select>
          </label>
          <div className="field"><span>Timeframe</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {TIMEFRAMES.map((t) => <button key={t} type="button" className={f.granularity === t ? '' : 'ghost'} aria-pressed={f.granularity === t} onClick={() => set('granularity', t)}>{t}</button>)}
            </div>
          </div>
          <div className="field"><span>Direction</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(['both', 'long', 'short'] as const).map((d) => <button key={d} type="button" className={f.direction === d ? '' : 'ghost'} aria-pressed={f.direction === d} onClick={() => set('direction', d)}>{d === 'both' ? 'Long and short' : d === 'long' ? 'Long only' : 'Short only'}</button>)}
            </div>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="choices" role="group" aria-label="Style">
          {STYLES.map((s) => (
            <button key={s.id} type="button" className="choice" aria-pressed={f.style === s.id} onClick={() => pick(s)}>
              <strong>{s.title}</strong><span className="muted small">{s.blurb}</span>
            </button>
          ))}
        </div>
      )}

      {step === 2 && (
        <div>
          <label className="field"><span>When should the agent enter?</span>
            <textarea rows={4} value={f.entry} onChange={(e) => set('entry', e.target.value)} placeholder="Describe the setup in plain sentences." />
          </label>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label className="field"><span>Minimum ADX (0 = off)</span><input type="number" min={0} step={1} value={f.adx} onChange={(e) => set('adx', Math.max(0, +e.target.value))} style={{ width: 110 }} /></label>
            <label className="field"><span>Minimum volume ratio (0 = off)</span><input type="number" min={0} step={0.1} value={f.vol} onChange={(e) => set('vol', Math.max(0, +e.target.value))} style={{ width: 110 }} /></label>
          </div>
          <label className="small" style={{ display: 'block', marginBottom: 6 }}><input type="checkbox" checked={f.exhaustion} onChange={(e) => set('exhaustion', e.target.checked)} /> Skip entries when the exhaustion axis vetoes</label>
          <label className="small" style={{ display: 'block' }}><input type="checkbox" checked={f.htf} onChange={(e) => set('htf', e.target.checked)} /> Trade only with the higher-timeframe trend</label>
        </div>
      )}

      {step === 3 && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <label className="field"><span>Stop distance (ATR)</span><input type="number" min={0.1} step={0.1} value={f.stop} onChange={(e) => set('stop', +e.target.value)} style={{ width: 110 }} /></label>
          <label className="field"><span>Target (times the stop, 0 = none)</span><input type="number" min={0} step={0.5} value={f.rr} onChange={(e) => set('rr', Math.max(0, +e.target.value))} style={{ width: 110 }} /></label>
          <label className="field"><span>Time stop (minutes held, 0 = none)</span><input type="number" min={0} step={1} value={f.maxBars} onChange={(e) => set('maxBars', Math.max(0, Math.round(+e.target.value)))} style={{ width: 110 }} /><span className="muted small">Counted in one-minute bars, whatever the chart timeframe.</span></label>
        </div>
      )}

      {step === 4 && (
        <div className="grid">
          <label className="field"><span>Strategy prompt. You can edit it. {edited && <button type="button" className="ghost" onClick={() => setEdited(false)}>Regenerate from my answers</button>}</span>
            <textarea rows={14} value={prompt} onChange={(e) => { setPrompt(e.target.value); setEdited(true); }} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, lineHeight: 1.5 }} />
          </label>
          <details>
            <summary>Sharpen it with the grill (optional)</summary>
            <div style={{ marginTop: 8 }}>
              <Sharpen name={f.name.trim()} mode="create" draft={prompt} brief={brief} scopes={f.instrument ? [{ instrument: f.instrument, granularity: f.granularity }] : []} onApply={(p) => { setPrompt(p); setEdited(true); }} />
            </div>
          </details>
          <div className="field"><span>Use it now</span>
            {candidates.length === 0 ? <span className="muted small">No LLM agent exists for {f.instrument} {f.granularity}. You can assign it later from the instrument page.</span>
              : candidates.map((a) => (
                <label key={a.id} className="small" style={{ display: 'block' }}>
                  <input type="checkbox" checked={!!assign[a.id]} onChange={(e) => setAssign((x) => ({ ...x, [a.id]: e.target.checked }))} /> Assign to {a.name}
                  {a.strategy ? <span className="muted"> (replaces {a.strategy})</span> : null}
                </label>
              ))}
          </div>
        </div>
      )}

      {(problem || error) && <p className={`msg ${error ? 'err' : ''}`} role={error ? 'alert' : undefined}>{error ?? problem}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button className="ghost" type="button" onClick={step === 0 ? onCancel : () => setStep(step - 1)} disabled={busy}>{step === 0 ? 'Cancel' : 'Back'}</button>
        {step < STEPS.length - 1
          ? <button type="button" disabled={!!problem} onClick={() => setStep(step + 1)}>Next</button>
          : <button type="button" disabled={busy || !prompt.trim()} onClick={() => void create()}>{busy ? 'Creating…' : 'Create strategy'}</button>}
      </div>
    </div>
  );
}
