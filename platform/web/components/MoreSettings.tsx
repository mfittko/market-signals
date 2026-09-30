'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card } from '@/components/ui';
import { DEFAULT_PREFS, loadPrefs, savePrefs, type NotifyPrefs } from '@/lib/alerts';

export type MoreSettingsData = {
  watchers?: string; ind?: string; keepFresh?: string | boolean; freshBars?: number; filterMaxCompletionTokens?: number;
  llmFallbackProvider?: string; impulseVolMult?: number; impulseVolWindow?: number; impulseCooldownBars?: number;
  NEWSAPI_AI_MODE?: string; GNEWS_MODE?: string; sentinelSourceFootnotes?: string | boolean;
  PUSHOVER_ENABLED?: string | boolean; PUSHOVER_USER?: string; PUSHOVER_TOKEN?: string; notifierBin?: string;
};
type Run = (patch: object, text?: string) => Promise<void>;
const MASK = '•••';
const GRANS = ['M1', 'M5', 'M15', 'H1'];
const on = (v: unknown) => v === true || v === '1' || v === 'true' || v === 'on';
const num = (v: string) => (v.trim() === '' ? null : Number(v));
const parse = (csv?: string) => new Set((csv ?? '').split(',').map((c) => c.trim().replace(/\s*\|\s*/, '|')).filter(Boolean));

// The engine alerts on exactly the instrument and timeframe pairs in its watcher list.
export function WatchersCard({ s, run, busy }: { s: MoreSettingsData; run: Run; busy: boolean }) {
  const [symbols, setSymbols] = useState<string[]>([]);
  useEffect(() => { api<{ instruments: { symbol: string }[] }>('/desk').then((d) => setSymbols(d.instruments.map((i) => i.symbol))).catch(() => {}); }, []);
  const watched = parse(s.watchers);
  const all = Array.from(new Set([...symbols, ...[...watched].map((c) => c.split('|')[0])])).sort();
  const toggle = (sym: string, g: string) => {
    const next = new Set(watched); const k = `${sym}|${g}`;
    if (next.has(k)) next.delete(k); else next.add(k);
    void run({ watchers: [...next].join(', ') }, `Saved. The engine watches ${next.size} pair${next.size === 1 ? '' : 's'} from its next cycle.`);
  };
  return (
    <Card title={`Signal alerts per market (${watched.size} watched)`}>
      <p className="small muted">A ticked box means the engine looks for flips on that instrument and timeframe and alerts you when the filter passes one.</p>
      <div className="scroll"><table>
        <thead><tr><th>Instrument</th>{GRANS.map((g) => <th key={g}>{g}</th>)}</tr></thead>
        <tbody>{all.map((sym) => (
          <tr key={sym}><td>{sym}</td>{GRANS.map((g) => (
            <td key={g}><input type="checkbox" checked={watched.has(`${sym}|${g}`)} disabled={busy} onChange={() => toggle(sym, g)} aria-label={`${sym} ${g} alerts`} /></td>
          ))}</tr>
        ))}</tbody>
      </table></div>
    </Card>
  );
}

// Channels: desktop notification from this console, Pushover, and the engine's own macOS alert.
export function AlertsCard({ s, run, busy }: { s: MoreSettingsData; run: Run; busy: boolean }) {
  const [perm, setPerm] = useState<string>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const [prefs, setPrefs] = useState<NotifyPrefs>(DEFAULT_PREFS);
  useEffect(() => setPrefs(loadPrefs()), []);
  const [user, setUser] = useState(''); const [token, setToken] = useState('');
  const set = (k: keyof NotifyPrefs, v: boolean) => { const p = { ...prefs, [k]: v }; setPrefs(p); savePrefs(p); };
  return (
    <Card title="Alerts and notifications">
      <div className="form">
        <div>
          <strong>Desktop notifications from this console</strong>
          {perm === 'unsupported' && <p className="small muted">This browser has no notification support.</p>}
          {perm === 'denied' && <p className="small muted">Blocked. Allow notifications for this site in the browser settings.</p>}
          {perm === 'default' && <p><button type="button" onClick={async () => setPerm(await Notification.requestPermission())}>Allow notifications</button></p>}
          {perm === 'granted' && <>
            <label><span><input type="checkbox" checked={prefs.proposal} onChange={(e) => set('proposal', e.target.checked)} /> Agent proposals to open or close</span></label>
            <label><span><input type="checkbox" checked={prefs.trade} onChange={(e) => set('trade', e.target.checked)} /> Paper trades opened or closed</span></label>
            <label><span><input type="checkbox" checked={prefs.signal} onChange={(e) => set('signal', e.target.checked)} /> Signals the filter passes (the engine already sends its own macOS alert)</span></label>
            <p className="small muted">They fire while a console tab is open. Each preference applies to this browser only.</p>
          </>}
        </div>
        <label><span><input type="checkbox" checked={on(s.PUSHOVER_ENABLED)} disabled={busy} onChange={(e) => void run({ PUSHOVER_ENABLED: e.target.checked ? '1' : '0' })} /> Pushover on the phone for signals</span></label>
        <label>Pushover user key {s.PUSHOVER_USER === MASK && <span className="muted small">(stored, leave blank to keep)</span>}
          <input type="password" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" placeholder={s.PUSHOVER_USER === MASK ? MASK : ''} /></label>
        <label>Pushover app token {s.PUSHOVER_TOKEN === MASK && <span className="muted small">(stored, leave blank to keep)</span>}
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" placeholder={s.PUSHOVER_TOKEN === MASK ? MASK : ''} /></label>
        <div><button type="button" disabled={busy || (!user.trim() && !token.trim())} onClick={() => {
          const patch: Record<string, string> = {}; if (user.trim()) patch.PUSHOVER_USER = user.trim(); if (token.trim()) patch.PUSHOVER_TOKEN = token.trim();
          void run(patch).then(() => { setUser(''); setToken(''); });
        }}>Save Pushover keys</button></div>
      </div>
    </Card>
  );
}

// Filter and data-freshness knobs. A blank field returns to the engine default.
export function FilterCard({ s, run, busy }: { s: MoreSettingsData; run: Run; busy: boolean }) {
  const [f, setF] = useState({
    ind: s.ind ?? '', freshBars: String(s.freshBars ?? ''), impulseVolMult: String(s.impulseVolMult ?? ''), impulseVolWindow: String(s.impulseVolWindow ?? ''),
    impulseCooldownBars: String(s.impulseCooldownBars ?? ''), filterMaxCompletionTokens: String(s.filterMaxCompletionTokens ?? ''),
  });
  const [keep, setKeep] = useState(on(s.keepFresh));
  const [foot, setFoot] = useState(on(s.sentinelSourceFootnotes));
  const [news, setNews] = useState(s.NEWSAPI_AI_MODE ?? 'auto'); const [gnews, setGnews] = useState(s.GNEWS_MODE ?? 'off');
  // numeric fields refuse non-numbers natively: Number("abc") would send NaN, which JSON turns into a silent reset
  const field = (k: keyof typeof f, label: string, hint?: string, numeric = true) => (
    <label>{label}{hint && <span className="muted small"> ({hint})</span>}<input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...(numeric ? { inputMode: 'decimal' as const, pattern: '\\s*\\d*(\\.\\d+)?\\s*', title: 'a number, or blank for the default' } : {})} /></label>
  );
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run({
      ...(f.ind.trim() ? { ind: f.ind.trim() } : {}), freshBars: num(f.freshBars), impulseVolMult: num(f.impulseVolMult), impulseVolWindow: num(f.impulseVolWindow),
      impulseCooldownBars: num(f.impulseCooldownBars), filterMaxCompletionTokens: num(f.filterMaxCompletionTokens),
      keepFresh: keep ? '1' : '0', sentinelSourceFootnotes: foot ? '1' : '0', NEWSAPI_AI_MODE: news, GNEWS_MODE: gnews,
    }, 'Saved. The engine reads these on its next cycle.');
  };
  return (
    <Card title="Signal filter, indicators and news">
      <form className="form" onSubmit={submit}>
        {field('ind', 'Chart indicators', 'comma list, for example ema,bb,vwap,rsi', false)}
        {field('freshBars', 'Fresh flip window', 'bars')}
        {field('impulseVolMult', 'Impulse volume multiple', 'at least 1')}
        {field('impulseVolWindow', 'Impulse volume window', 'bars')}
        {field('impulseCooldownBars', 'Impulse cooldown', 'bars')}
        {field('filterMaxCompletionTokens', 'Filter completion token limit')}
        <label><span><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep candle data fresh in the background</span></label>
        <label><span><input type="checkbox" checked={foot} onChange={(e) => setFoot(e.target.checked)} /> Show source footnotes on breaking news</span></label>
        <label>NewsAPI.ai mode<select value={news} onChange={(e) => setNews(e.target.value)}>{['auto', 'shadow', 'off'].map((m) => <option key={m}>{m}</option>)}</select></label>
        <label>GNews mode<select value={gnews} onChange={(e) => setGnews(e.target.value)}>{['off', 'shadow', 'auto'].map((m) => <option key={m}>{m}</option>)}</select></label>
        <div><button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
      </form>
    </Card>
  );
}
