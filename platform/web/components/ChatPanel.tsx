'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Card } from '@/components/ui';

type Thread = { id: number; title: string; created_at: string; messages: number };
type Msg = { id: number | string; role: 'user' | 'assistant'; content: string };

const short = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

// Chat with the engine's trading copilot, scoped to one instrument and granularity.
// The engine owns threads, tools and context; the console only streams the reply.
export function ChatPanel({ symbol, granularity }: { symbol: string; granularity: string }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<number | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const q = `instrument=${encodeURIComponent(symbol)}&granularity=${granularity}`;

  const loadThreads = useCallback(async () => {
    try { setThreads((await api<{ threads: Thread[] }>(`/engine/threads?${q}`)).threads); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [q]);
  useEffect(() => { setThreadId(null); setMsgs([]); void loadThreads(); return () => abort.current?.abort(); }, [loadThreads]);

  const open = async (id: number | null) => {
    abort.current?.abort();
    setThreadId(id); setBusy(false); setError(null);
    if (id == null) { setMsgs([]); return; }
    try {
      const r = await api<{ messages: Msg[] }>(`/engine/messages?thread=${id}`);
      setMsgs(r.messages.filter((m) => m.role === 'user' || m.role === 'assistant'));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [msgs]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    setText(''); setError(null); setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    const draftId = `a${Date.now()}`;
    setMsgs((m) => [...m, { id: `u${Date.now()}`, role: 'user', content: message }, { id: draftId, role: 'assistant', content: '' }]);
    let tid = threadId;
    try {
      const res = await fetch('/api/v1/engine/chat', {
        method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, instrument: symbol, granularity, threadId: tid, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      if (!res.ok || !res.body) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `chat failed (${res.status})`);
      }
      const rd = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).replace(/^data: /, ''); buf = buf.slice(i + 2);
          let ev: { type: string; text?: string; id?: number; threadId?: number; reply?: string; error?: string; title?: string };
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'thread' && ev.id) { tid = ev.id; setThreadId(ev.id); }
          else if (ev.type === 'delta') setMsgs((m) => m.map((x) => (x.id === draftId ? { ...x, content: x.content + (ev.text ?? '') } : x)));
          else if (ev.type === 'done') setMsgs((m) => m.map((x) => (x.id === draftId ? { ...x, content: ev.reply ?? x.content } : x)));
          else if (ev.type === 'error') throw new Error(ev.error || 'chat failed');
        }
      }
      void loadThreads();
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setMsgs((m) => m.map((x) => (x.id === draftId ? { ...x, content: x.content || '(stopped)' } : x)));
      } else {
        setError(err instanceof Error ? err.message : String(err));
        setMsgs((m) => m.filter((x) => x.id !== draftId || x.content));
      }
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (threadId == null || !confirm('Delete this conversation? This removes it from the engine too.')) return;
    try { await api(`/engine/threads?id=${threadId}`, { method: 'DELETE' }); await open(null); await loadThreads(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <Card title="Ask the copilot" aside={<span className="muted small">{symbol} · {granularity}</span>}>
      <div className="chat-bar">
        <select aria-label="Conversation" value={threadId ?? ''} onChange={(e) => void open(e.target.value ? Number(e.target.value) : null)} disabled={busy}>
          <option value="">New conversation</option>
          {threads.map((t) => <option key={t.id} value={t.id}>{short(t.created_at)} · {t.title}</option>)}
        </select>
        {threadId != null && <button className="ghost" onClick={remove} disabled={busy}>Delete</button>}
      </div>
      <div className="chat-log" ref={log} role="log" aria-live="polite" aria-label="Conversation">
        {msgs.length === 0 && <p className="muted small">Ask about this chart. The copilot sees the live candles, signals, news and your standing rules. It cannot place trades.</p>}
        {msgs.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            <div className="small muted">{m.role === 'user' ? 'You' : 'Copilot'}</div>
            <div className="bubble-t">{m.content || (busy ? 'Thinking…' : '')}</div>
          </div>
        ))}
      </div>
      {error && <div className="msg err" role="alert">{error}</div>}
      <form onSubmit={send} className="chat-form">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={4000} aria-label="Message" placeholder="What is the setup here?"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(e); }} />
        {busy ? <button type="button" className="ghost" onClick={() => abort.current?.abort()}>Stop</button> : <button type="submit" disabled={!text.trim()}>Send</button>}
      </form>
    </Card>
  );
}
