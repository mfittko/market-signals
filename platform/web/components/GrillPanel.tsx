'use client';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '@/lib/api';

type Option = { label: string; detail?: string; recommended?: boolean };
type Turn = {
  findings?: { issue: string; fix?: string }[]; question?: string; why?: string; options?: Option[];
  recommendation?: string; change?: string; prompt?: string; summary?: string;
};
type Msg = { role: 'user' | 'assistant'; content: string; turn?: Turn | null };

const START = 'Start the grill. Review the strategy, tell me what you notice, and ask your first question.';
const SHOW = 'Show me the revised prompt now.';
const SKIP = 'Skip this one. Move on to the next weakness.';

// Fallback for a reply that is not structured: the last fenced prompt block is the proposed rewrite.
export function proposedPrompt(text: string): string | null {
  const all = [...text.matchAll(/```prompt[ \t]*\n([\s\S]*?)```/g)];
  return all.length ? all[all.length - 1][1].trim() : null;
}

const pick = (o: Option) => `I choose: ${o.label}${o.detail ? ` (${o.detail})` : ''}`;

// Grill mode: the coach asks one question at a time with predefined answers and a recommendation.
// The trader clicks an answer, accepts the recommendation, skips, or types their own.
// Applying a proposed prompt only fills the editor. Nothing is saved until the trader saves a version.
export function GrillPanel({ name, mode, draft, brief, onApply }: {
  name: string; mode: 'refine' | 'create'; draft: string; brief?: string; onApply: (prompt: string) => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [own, setOwn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [msgs, busy]);
  // a different strategy is a different interview
  useEffect(() => { setMsgs([]); setError(null); setApplied(null); setOwn(false); }, [name]);

  async function send(text: string) {
    if (busy || !text.trim()) return;
    const next: Msg[] = [...msgs, { role: 'user', content: text.trim() }];
    setMsgs(next); setInput(''); setOwn(false); setBusy(true); setError(null);
    // the server takes 30 messages and the history must open on a user turn
    const hist = next.slice(-30);
    while (hist[0]?.role === 'assistant') hist.shift();
    try {
      const r = await api<{ reply: string; turn?: Turn | null }>('/strategies/grill', {
        method: 'POST',
        body: JSON.stringify({ name, mode, draft, brief, messages: hist.map(({ role, content }) => ({ role, content })) }),
      });
      setMsgs([...next, { role: 'assistant', content: r.reply, turn: r.turn }]);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (msgs.length === 0) {
    return (
      <div>
        <p className="muted small" style={{ marginTop: 0 }}>
          The coach reviews the strategy against its paper-trade record, then asks one question at a time. Every question has predefined answers
          and a recommended one, so you can shape the strategy with clicks. It never saves anything.
        </p>
        <button onClick={() => void send(START)} disabled={busy}>{busy ? 'Reviewing…' : 'Start the grill'}</button>
        {error && <p className="msg err" role="alert">{error}</p>}
      </div>
    );
  }

  const lastIdx = msgs.length - 1;
  const last = msgs[lastIdx];
  const live = last.role === 'assistant' ? last : null;
  const opts = live?.turn?.options ?? [];
  const rec = opts.find((o) => o.recommended);

  return (
    <div className="grill">
      <div className="grill-log" aria-live="polite">
        {msgs.map((m, i) => {
          if (m.role === 'user') {
            if (m.content === START) return null;
            return <div key={i} className="grill-msg user"><div className="muted small">You</div>{m.content}</div>;
          }
          const t = m.turn;
          const p = t?.prompt ?? proposedPrompt(m.content);
          const isLive = i === lastIdx;
          return (
            <div key={i} className="grill-msg">
              <div className="muted small">Coach</div>
              {!t ? <div className="md"><Markdown remarkPlugins={[remarkGfm]} disallowedElements={['img']} components={{ a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer noopener" /> }}>{m.content}</Markdown></div> : (
                <>
                  {t.findings && t.findings.length > 0 && (
                    <div className="grill-find">
                      <strong className="small">What I noticed</strong>
                      <ul>{t.findings.map((f, k) => <li key={k}>{f.issue}{f.fix ? <span className="muted"> · {f.fix}</span> : null}</li>)}</ul>
                    </div>
                  )}
                  {t.question && <div style={{ fontWeight: 600 }}>{t.question}</div>}
                  {t.why && isLive && <div className="muted small">{t.why}</div>}
                  {t.recommendation && isLive && <div className="grill-rec"><strong className="small">Recommendation</strong> {t.recommendation}</div>}
                  {t.change && isLive && <div className="muted small">Next change: {t.change}</div>}
                  {t.summary && t.prompt && <div className="muted small">{t.summary}</div>}
                </>
              )}
              {p && (
                <div style={{ marginTop: 6 }}>
                  {t?.prompt && <pre className="diff" style={{ maxHeight: 220, overflow: 'auto' }}>{p}</pre>}
                  <button onClick={() => { onApply(p); setApplied(i); }} disabled={applied === i}>{applied === i ? 'Applied to the editor' : 'Apply to the editor'}</button>
                </div>
              )}
            </div>
          );
        })}
        {busy && <div className="muted small">Coach is thinking…</div>}
        <div ref={end} />
      </div>

      {error && <p className="msg err" role="alert">{error}</p>}

      {live && opts.length > 0 && !busy && (
        <div className="choices" role="group" aria-label="Answers">
          {opts.map((o) => (
            <button key={o.label} type="button" className="choice" onClick={() => void send(pick(o))}>
              <strong>{o.label}{o.recommended && <span className="pill s-succeeded" style={{ marginLeft: 8 }}>Recommended</span>}</strong>
              {o.detail && <span className="muted small">{o.detail}</span>}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {rec && !busy && <button onClick={() => void send(pick(rec))}>Accept the recommendation</button>}
        <button className="ghost" onClick={() => void send(SKIP)} disabled={busy}>Skip</button>
        <button className="ghost" onClick={() => setOwn(!own)} disabled={busy} aria-expanded={own}>Answer in my own words</button>
        <button className="ghost" onClick={() => void send(SHOW)} disabled={busy}>Show the revised prompt</button>
        <button className="ghost" onClick={() => { setMsgs([]); setApplied(null); }} disabled={busy}>Start over</button>
      </div>
      {own && (
        <form className="chat-form" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); void send(input); }}>
          <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={2} placeholder="Your answer" aria-label="Your answer" autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }} />
          <button disabled={busy || !input.trim()}>Send</button>
        </form>
      )}
    </div>
  );
}
