import { useEffect, useState } from 'react';
import { api, type RunRow } from '@/lib/api';
import { isAlerted, notAlertedLabel, signalId, signalTitle } from '@/lib/signal-class';
import { toggleWatcher, validPair, watcherEntries } from '@/lib/watcher-merge';

export type AlertKind = 'signal' | 'proposal' | 'trade';
export type AlertEvent = {
  id: string; kind: AlertKind; at: string; title: string; detail: string;
  href?: string; tone?: 'good' | 'bad' | 'warn'; alerted?: boolean; why?: string;
};

type Signal = { kind?: string; instrument: string; granularity: string; time: string; signal: string; price: number; verdict: string; reason: string; notified: number };
type Trade = { id: number; instrument: string; side: string; realized: number; close_time: string; close_reason: string; granularity?: string };
type Open = { id: number; instrument: string; side: string; entry_price: number; entry_time: string };

const slug = (s: string) => s.toLowerCase().replace('/', '-');

// The engine writes nanosecond timestamps. WebKit cannot parse more than three
// fractional digits, so trim them before parsing.
export const timeMs = (t: string) => Date.parse(t.replace(/(\.\d{3})\d+/, '$1'));
const money = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
const combos = (csv: string | undefined) => [...new Set(watcherEntries(csv))].map((c) => c.split('|')).filter((c) => c.length === 2 && c[0] && c[1]);

// One feed for the alerts page and the desktop notifier: signals the filter let
// through, agent proposals that ask for a trade, and paper-portfolio activity.
export async function fetchAlerts(): Promise<AlertEvent[]> {
  const out: AlertEvent[] = [];
  const [settings, runs, pf] = await Promise.all([
    api<{ watchers?: string }>('/engine/settings').catch(() => ({} as { watchers?: string })),
    api<{ runs: RunRow[] }>('/runs?limit=40').catch(() => ({ runs: [] as RunRow[] })),
    api<{ portfolio: { trades: Trade[]; positions: Open[] } }>('/engine/portfolio').catch(() => null),
  ]);
  const lists = await Promise.all(combos(settings.watchers).map(([i, g]) =>
    api<{ signals: Signal[] }>(`/engine/signals?instrument=${encodeURIComponent(i)}&granularity=${g}&limit=6`).then((r) => r.signals).catch(() => [] as Signal[])));
  for (const s of lists.flat()) {
    const passed = isAlerted(s);
    out.push({
      id: signalId(s), kind: 'signal', at: s.time, alerted: !!s.notified, why: passed ? undefined : notAlertedLabel(s),
      title: signalTitle(s),
      detail: `${passed ? 'Passed the filter' : notAlertedLabel(s)}${s.reason ? `: ${s.reason}` : ''}`, href: `/instruments/${slug(s.instrument)}`, tone: passed ? (s.signal === 'buy' ? 'good' : 'bad') : undefined,
    });
  }
  for (const r of runs.runs) {
    const p = r.proposal;
    if (r.status !== 'succeeded' || !p || p.action === 'hold') continue;
    out.push({
      id: `r:${r.id}`, kind: 'proposal', at: r.finishedAt ?? r.updatedAt, title: `${r.agentName} proposes to ${p.action}${p.side ? ` ${p.side}` : ''}`,
      detail: p.reasoning ?? '', href: `/runs/${r.id}`, tone: 'warn',
    });
  }
  for (const t of pf?.portfolio.trades.slice(0, 15) ?? []) {
    out.push({ id: `t:${t.id}`, kind: 'trade', at: t.close_time, title: `Paper ${t.side} on ${t.instrument} closed ${money(t.realized)}`, detail: t.close_reason, href: `/instruments/${slug(t.instrument)}`, tone: t.realized >= 0 ? 'good' : 'bad' });
  }
  for (const o of pf?.portfolio.positions ?? []) {
    out.push({ id: `o:${o.id}`, kind: 'trade', at: o.entry_time, title: `Paper ${o.side} opened on ${o.instrument} at ${o.entry_price}`, detail: 'Open position', href: `/instruments/${slug(o.instrument)}`, tone: 'warn' });
  }
  // ids must be unique: React keys and the notifier's "already seen" set both rely on it
  const unique = [...new Map(out.map((e) => [e.id, e])).values()];
  return unique.sort((a, b) => timeMs(b.at) - timeMs(a.at));
}

// Desktop notification preferences live in this browser only.
export type NotifyPrefs = { signal: boolean; proposal: boolean; trade: boolean; prediction: boolean };
export const DEFAULT_PREFS: NotifyPrefs = { signal: false, proposal: true, trade: true, prediction: true };
const KEY = 'ms.notify.prefs', SEEN = 'ms.notify.seen';
export function loadPrefs(): NotifyPrefs {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return DEFAULT_PREFS; }
}
export function savePrefs(p: NotifyPrefs) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private window */ } window.dispatchEvent(new Event('ms-notify-prefs')); }
export function loadSeen(): Set<string> | null {
  try { const v = localStorage.getItem(SEEN); return v ? new Set(JSON.parse(v) as string[]) : null; } catch { return null; }
}
export function saveSeen(s: Set<string>) { try { localStorage.setItem(SEEN, JSON.stringify([...s].slice(-400))); } catch { /* ignore */ } }

// The engine alerts on the instrument and timeframe pairs in its watcher list.
const canon = watcherEntries;
export function useWatchers() {
  const [watched, setWatched] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ watchers?: string }>('/engine/settings').then((s) => alive && setWatched(new Set(canon(s.watchers)))).catch(() => {});
    return () => { alive = false; };
  }, []);
  const toggle = async (symbol: string, gran: string) => {
    if (!watched || busy || !validPair(`${symbol}|${gran}`)) return;
    setBusy(true); setErr(null);
    try {
      // re-read just before the write so a change made in another tab is kept
      const fresh = await api<{ watchers?: string }>('/engine/settings');
      const next = toggleWatcher(fresh.watchers, `${symbol}|${gran}`);
      await api('/engine/settings', { method: 'POST', body: JSON.stringify({ watchers: next.join(', ') }) });
      setWatched(new Set(next));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return { watched, toggle, busy, err };
}
