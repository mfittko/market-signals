'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card } from '@/components/ui';

type BotEntry = { enabled?: boolean; allocationPct?: number | null; strategyName?: string; riskPct?: number | null };
type Settings = {
  provider?: string; activeProvider?: string; models?: Record<string, string>; providerDefaultModels?: Record<string, string>;
  OPENAI_BASE_URL?: string; OPENAI_API_KEY?: string; ANTHROPIC_API_KEY?: string; maxCompletionTokens?: number;
  NEWSAPI_AI_MODE?: string; GNEWS_MODE?: string; sentinelSourceFootnotes?: string;
  bot?: { bots?: Record<string, BotEntry> };
};
const PROVIDERS = ['openai-compatible', 'openai', 'anthropic', 'claude-code', 'pi', 'none'];
const MASK = '•••';

// Every save sends only the fields that changed. Keys are write-only: blank keeps the stored key.
async function save(patch: object) {
  return api<{ ok: boolean; error?: string }>('/engine/settings', { method: 'POST', body: JSON.stringify(patch) });
}

function useSave(reload: () => Promise<void>) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (patch: object, text = 'Saved.') => {
    if (busy) return;
    setBusy(true); setMsg(null);
    try { await save(patch); setMsg({ ok: true, text }); await reload(); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  return { run, busy, msg };
}

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try { setS(await api<Settings>('/engine/settings')); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const { run, busy, msg } = useSave(reload);

  if (error) return <main className="wrap"><h1>Settings</h1><div className="msg err" role="alert">{error}</div></main>;
  if (!s) return <main className="wrap"><div className="empty">Loading…</div></main>;

  return (
    <main className="wrap">
      <div className="top"><div className="left"><h1>Settings</h1><span className="muted">These edit the trading engine&apos;s own settings file.</span></div></div>
      <div aria-live="polite">{msg && <div className={`msg ${msg.ok ? 'ok' : 'err'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}</div>
      <div className="grid two">
        <div className="grid">
          <LlmCard s={s} run={run} busy={busy} />
          <Card title="News"><p className="small">Provider mode is set by the engine: NewsAPI.ai <strong>{s.NEWSAPI_AI_MODE ?? 'free'}</strong>, GNews <strong>{s.GNEWS_MODE ?? 'off'}</strong>. Source footnotes {s.sentinelSourceFootnotes === '1' ? 'on' : 'off'}.</p><p className="small muted">Read-only here: the paid-provider budget lives in the engine.</p></Card>
        </div>
        <BotsCard s={s} run={run} busy={busy} />
      </div>
    </main>
  );
}

type Run = (patch: object, text?: string) => Promise<void>;

function LlmCard({ s, run, busy }: { s: Settings; run: Run; busy: boolean }) {
  const active = s.activeProvider ?? s.provider ?? 'none';
  const [provider, setProvider] = useState(active);
  const [model, setModel] = useState(s.models?.[active] ?? '');
  const [base, setBase] = useState(s.OPENAI_BASE_URL ?? '');
  const [key, setKey] = useState('');
  const [akey, setAkey] = useState('');
  const [tokens, setTokens] = useState(String(s.maxCompletionTokens ?? ''));
  const needsBase = provider === 'openai-compatible';
  const onProvider = (p: string) => { setProvider(p); setModel(s.models?.[p] ?? ''); };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const patch: Record<string, unknown> = { provider };
    if (model.trim()) patch.models = { ...(s.models ?? {}), [provider]: model.trim() };
    if (needsBase && base.trim() !== (s.OPENAI_BASE_URL ?? '')) patch.OPENAI_BASE_URL = base.trim();
    if (key.trim()) patch.OPENAI_API_KEY = key.trim();
    if (akey.trim()) patch.ANTHROPIC_API_KEY = akey.trim();
    if (tokens.trim() && Number(tokens) !== s.maxCompletionTokens) patch.maxCompletionTokens = Number(tokens);
    void run(patch, 'Saved. The engine uses the new provider for the next chat message.').then(() => { setKey(''); setAkey(''); });
  };

  return (
    <Card title="Chat and model" aside={<span className="muted small">active: {active}</span>}>
      <form onSubmit={submit} className="form">
        <label>Provider
          <select value={provider} onChange={(e) => onProvider(e.target.value)}>{PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}</select>
        </label>
        {provider !== 'none' && provider !== 'pi' && provider !== 'claude-code' && (
          <label>Model
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={s.providerDefaultModels?.[provider] ?? ''} autoCapitalize="off" spellCheck={false} />
          </label>
        )}
        {needsBase && <label>Base URL<input value={base} onChange={(e) => setBase(e.target.value)} inputMode="url" autoCapitalize="off" spellCheck={false} /></label>}
        {(provider === 'openai' || provider === 'openai-compatible') && (
          <label>API key {s.OPENAI_API_KEY === MASK && <span className="muted small">(stored, leave blank to keep)</span>}
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" placeholder={s.OPENAI_API_KEY === MASK ? MASK : ''} />
          </label>
        )}
        {provider === 'anthropic' && (
          <label>API key {s.ANTHROPIC_API_KEY === MASK && <span className="muted small">(stored, leave blank to keep)</span>}
            <input type="password" value={akey} onChange={(e) => setAkey(e.target.value)} autoComplete="off" placeholder={s.ANTHROPIC_API_KEY === MASK ? MASK : ''} />
          </label>
        )}
        {provider === 'claude-code' && <p className="small muted">Uses your local Claude Code login. No key is stored.</p>}
        <label>Max completion tokens<input value={tokens} onChange={(e) => setTokens(e.target.value.replace(/\D/g, ''))} inputMode="numeric" /></label>
        <div><button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
      </form>
    </Card>
  );
}

function BotsCard({ s, run, busy }: { s: Settings; run: Run; busy: boolean }) {
  const bots = Object.entries(s.bot?.bots ?? {});
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  return (
    <Card title="Engine bots (paper)" aside={<span className="muted small">{bots.filter(([, b]) => b.enabled).length} of {bots.length} on</span>}>
      {bots.length === 0 ? <div className="empty">No bots configured.</div> : (
        <div className="scroll"><table>
          <thead><tr><th>Bot</th><th>On</th><th>Allocation %</th></tr></thead>
          <tbody>{bots.map(([combo, b]) => {
            const [inst, gran] = combo.split('|');
            const v = alloc[combo] ?? (b.allocationPct == null ? '' : String(b.allocationPct));
            const dirty = v !== (b.allocationPct == null ? '' : String(b.allocationPct));
            return (
              <tr key={combo}>
                <td><Link href={`/instruments/${inst.toLowerCase().replace('/', '-')}`}>{inst} {gran}</Link><div className="small muted">{b.strategyName}</div></td>
                <td><input type="checkbox" checked={!!b.enabled} disabled={busy} aria-label={`${combo} enabled`}
                  onChange={(e) => void run({ bot: { bots: { [combo]: { enabled: e.target.checked } } } }, `${combo} ${e.target.checked ? 'enabled' : 'disabled'}.`)} /></td>
                <td>
                  <input className="num" style={{ width: 64 }} value={v} inputMode="decimal" aria-label={`${combo} allocation percent`}
                    onChange={(e) => setAlloc({ ...alloc, [combo]: e.target.value })} />
                  {dirty && <button className="linkish" disabled={busy} onClick={() => void run({ bot: { bots: { [combo]: { allocationPct: v.trim() === '' ? null : Number(v) } } } }, `${combo} allocation saved.`).then(() => setAlloc((a) => { const n = { ...a }; delete n[combo]; return n; }))}>Save</button>}
                </td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      <p className="small muted">Paper trading only. Turning a bot off stops new entries from that engine bot. Agents on this console only advise. They never place orders on the paper portfolio.</p>
    </Card>
  );
}
