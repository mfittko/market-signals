'use client';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '@/lib/api';

type Msg = { role: 'user' | 'assistant'; content: string };
const START = 'Start the grill. Ask me your first question.';
const SHOW = 'Show me the revised prompt now.';

// The last fenced prompt block in a reply is the coach's proposed rewrite.
export function proposedPrompt(text: string): string | null {
  const all = [...text.matchAll(/```prompt[ \t]*\n([\s\S]*?)```/g)];
  return all.length ? all[all.length - 1][1].trim() : null;
}

// Grill mode: a coach questions the strategy one point at a time and proposes a rewrite.
// Applying a proposal only fills the editor. Nothing is saved until the trader saves a version.
export function GrillPanel({ name, mode, draft, brief, onApply }: {
  name: string; mode: 'refine' | 'create'; draft: string; brief?: string; onApply: (prompt: string) => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [msgs, busy]);
  // a different strategy is a different interview
  useEffect(() => { setMsgs([]); setError(null); setApplied(null); }, [name]);

  async function send(text: string) {
    if (busy || !text.trim()) return;
    const next: Msg[] = [...msgs, { role: 'user', content: text.trim() }];
    setMsgs(next); setInput(''); setBusy(true); setError(null);
    try {
      const r = await api<{ reply: string }>('/strategies/grill', { method: 'POST', body: JSON.stringify({ name, mode, draft, brief, messages: next.slice(-30) }) });
      setMsgs([...next, { role: 'assistant', content: r.reply }]);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (msgs.length === 0) {
    return (
      <div>
        <p className="muted small" style={{ marginTop: 0 }}>
          The coach asks one question at a time about the weak spots in this strategy and its paper-trade record.
          It proposes a rewrite when you ask or after about five answers. It never saves anything.
        </p>
        <button onClick={() => void send(START)} disabled={busy}>{busy ? 'Starting…' : 'Start the grill'}</button>
        {error && <p className="msg err" role="alert">{error}</p>}
      </div>
    );
  }
  return (
    <div className="grill">
      <div className="grill-log" aria-live="polite">
        {msgs.filter((m) => m.content !== START).map((m, i) => {
          const p = m.role === 'assistant' ? proposedPrompt(m.content) : null;
          return (
            <div key={i} className={`grill-msg ${m.role}`}>
              <div className="muted small">{m.role === 'user' ? 'You' : 'Coach'}</div>
              {m.role === 'assistant'
                ? <div className="md"><Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown></div>
                : <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>}
              {p && (
                <button style={{ marginTop: 6 }} onClick={() => { onApply(p); setApplied(i); }} disabled={applied === i}>
                  {applied === i ? 'Applied to the editor' : 'Apply to the editor'}
                </button>
              )}
            </div>
          );
        })}
        {busy && <div className="muted small">Coach is thinking…</div>}
        <div ref={end} />
      </div>
      {error && <p className="msg err" role="alert">{error}</p>}
      <form className="chat-form" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={2} placeholder="Your answer" aria-label="Your answer"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }} />
        <button disabled={busy || !input.trim()}>Send</button>
      </form>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button className="ghost" onClick={() => void send(SHOW)} disabled={busy}>Show the revised prompt</button>
        <button className="ghost" onClick={() => { setMsgs([]); setApplied(null); }} disabled={busy}>Start over</button>
      </div>
    </div>
  );
}
