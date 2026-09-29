'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Card, Loading } from '@/components/ui';
import { Sharpen, type Scope } from '@/components/AutoGrill';
import { StrategyWizard } from '@/components/StrategyWizard';

type Summary = { name: string; activeVersion: number | null; versions: number; agents: number; updatedAt: string; archived: boolean };
type Filter = "inuse" | "unused" | "archived" | "all";
const FILTERS: [Filter, string][] = [["inuse", "In use"], ["unused", "Unused"], ["archived", "Archived"], ["all", "All"]];
const matches = (s: Summary, f: Filter) => f === "all" || (f === "archived" ? s.archived : f === "inuse" ? !s.archived && s.agents > 0 : !s.archived && s.agents === 0);
type Version = { version: number; prompt: string; active: boolean; createdBy: string; createdAt: string };

// Line diff by longest common subsequence. Prompts are short, so O(n*m) is fine.
function diffLines(a: string, b: string): { t: ' ' | '+' | '-'; s: string }[] {
  const x = a.split('\n'), y = b.split('\n');
  const L = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { t: ' ' | '+' | '-'; s: string }[] = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push({ t: ' ', s: x[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: '-', s: x[i++] });
    else out.push({ t: '+', s: y[j++] });
  }
  while (i < x.length) out.push({ t: '-', s: x[i++] });
  while (j < y.length) out.push({ t: '+', s: y[j++] });
  return out;
}

export default function StrategiesPage() {
  const [list, setList] = useState<Summary[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [draft, setDraft] = useState('');
  const [compare, setCompare] = useState<number | null>(null);
  const [wizard, setWizard] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("inuse");
  const [q, setQ] = useState("");

  const loadList = useCallback(async () => {
    const r = await api<{ strategies: Summary[] }>('/strategies');
    setList(r.strategies);
    return r.strategies;
  }, []);
  const open = useCallback(async (name: string) => {
    setSel(name); setMsg(null); setCompare(null);
    const r = await api<{ versions: Version[]; scopes: Scope[] }>(`/strategies/${encodeURIComponent(name)}`);
    setVersions(r.versions);
    setScopes(r.scopes ?? []);
    setDraft((r.versions.find((v) => v.active) ?? r.versions[0]).prompt);
  }, []);
  useEffect(() => {
    loadList().then((l) => {
      const want = new URLSearchParams(window.location.search).get('name');
      const target = l.find((s) => s.name === want);
      if (target && !matches(target, "inuse")) setFilter(target.archived ? "archived" : "unused");
      const first = target?.name ?? l.find((s) => matches(s, "inuse"))?.name ?? l[0]?.name;
      if (first) void open(first);
    }).catch((e) => setMsg({ ok: false, text: String(e.message ?? e) }));
  }, [loadList, open]);

  const shown = (list ?? []).filter((s) => matches(s, filter) && s.name.toLowerCase().includes(q.trim().toLowerCase()));
  const cur = list?.find((s) => s.name === sel);
  const archived = !!cur?.archived;
  const active = versions.find((v) => v.active) ?? (archived ? versions[0] : undefined);
  const base = versions.find((v) => v.version === compare) ?? active;
  const dirty = active != null && draft.trim() !== active.prompt.trim();
  const diff = useMemo(() => (base ? diffLines(base.prompt, draft) : []), [base, draft]);

  async function run(fn: () => Promise<unknown>, ok: string, then?: string) {
    if (busy) return;
    setBusy(true); setMsg(null);
    try { await fn(); await loadList(); await open(then ?? sel!); setMsg({ ok: true, text: ok }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  }
  const save = (name: string, prompt: string) =>
    api<{ version: number }>(`/strategies/${encodeURIComponent(name)}/versions`, { method: 'POST', body: JSON.stringify({ prompt }) });

  return (
    <main className="wrap grid">
      <h1>Strategies</h1>
      <p className="muted small" style={{ margin: 0 }}>
        An agent judges entries with the active version of its strategy. Saving adds a new version and makes it active. Older versions stay, so any change can be rolled back.
        These edits stay in this console. The live engine keeps its own strategies.
      </p>
      {msg && <p className={`msg ${msg.ok ? 'ok' : 'err'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
      <div className="grid strat">
        <Card title="All strategies">
          <div role="group" aria-label="Filter strategies" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {FILTERS.map(([k, label]) => (
              <button key={k} className={filter === k ? "" : "ghost"} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                {label} ({(list ?? []).filter((s) => matches(s, k)).length})
              </button>
            ))}
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name" aria-label="Search strategies" style={{ width: "100%", boxSizing: "border-box", marginBottom: 8 }} />
          {!list ? <Loading /> : shown.length === 0 ? <p className="muted">No {filter === "all" ? "" : FILTERS.find((f) => f[0] === filter)![1].toLowerCase() + " "}strategies{q ? " match" : ""}.</p> : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
              {shown.map((s) => (
                <li key={s.name}>
                  <button className={s.name === sel ? '' : 'ghost'} style={{ width: '100%', textAlign: 'left' }} onClick={() => void open(s.name)} aria-current={s.name === sel}>
                    <strong>{s.name}</strong>
                    <div className="small" style={{ opacity: 0.8 }}>{s.archived ? "archived" : (s.activeVersion == null ? "no active version" : `v${s.activeVersion} active`)} · {s.versions} version{s.versions === 1 ? '' : 's'} · {s.agents} agent{s.agents === 1 ? '' : 's'}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button style={{ width: "100%", marginTop: 12 }} onClick={() => setWizard(true)}>New strategy</button>
        </Card>

        {wizard ? (
          <div ref={(el) => { el?.scrollIntoView({ block: "start", behavior: "smooth" }); }}><Card title="New strategy">
            <StrategyWizard existing={(list ?? []).map((s) => s.name)} onCancel={() => setWizard(false)}
              onDone={(n) => { setWizard(false); void loadList().then(() => { setFilter("all"); return open(n); }).then(() => setMsg({ ok: true, text: `Created ${n}.` })); }} />
          </Card></div>
        ) : sel && active && (
          <div className="grid">
            <Card title={`${sel} · ${archived ? "archived" : `v${active.version} active`}`} aside={archived
              ? <button className="ghost" disabled={busy} onClick={() => void run(() => api(`/strategies/${encodeURIComponent(sel)}/archive`, { method: "POST", body: JSON.stringify({ archived: false }) }), "Restored.")}>Restore</button>
              : <button className="ghost" disabled={busy || (cur?.agents ?? 0) > 0} title={(cur?.agents ?? 0) > 0 ? "Assign its agents another strategy first" : "Archive this strategy"}
                  onClick={() => { if (confirm(`Archive ${sel}? It leaves the default list and no agent can use it. You can restore it later.`)) void run(() => api(`/strategies/${encodeURIComponent(sel)}/archive`, { method: "POST", body: JSON.stringify({ archived: true }) }), "Archived. Find it under the Archived filter."); }}>Archive</button>}>
              {archived && <p className="msg" style={{ marginTop: 0 }}>This strategy is archived. It is read-only and no agent can use it.</p>}
              {!archived && (cur?.agents ?? 0) > 0 && <p className="muted small" style={{ marginTop: 0 }}>Used by {cur!.agents} agent{cur!.agents === 1 ? "" : "s"}. Archive unlocks when none use it.</p>}
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={16} aria-label="Strategy prompt" readOnly={archived}
                style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 13, lineHeight: 1.5, boxSizing: 'border-box' }} />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                <button disabled={busy || !dirty || !draft.trim()} onClick={() => void run(() => save(sel, draft), 'Saved as a new version. It is active now.')}>
                  Save as v{(versions[0]?.version ?? 0) + 1}
                </button>
                <button className="ghost" disabled={!dirty} onClick={() => setDraft(active.prompt)}>Discard changes</button>
                <span className="muted small">{draft.length.toLocaleString()} / 32,768 characters</span>
              </div>
              {dirty && (
                <details open style={{ marginTop: 12 }}>
                  <summary>Changes against v{base?.version}</summary>
                  <pre className="diff">{diff.map((d, i) => (
                    <div key={i} className={d.t === '+' ? 'd-add' : d.t === '-' ? 'd-del' : undefined}>{d.t} {d.s}</div>
                  ))}</pre>
                </details>
              )}
            </Card>
            {!archived && (
              <Card title="Sharpen with the grill">
                <Sharpen name={sel} mode="refine" draft={draft} scopes={scopes} onApply={(p) => setDraft(p)} />
              </Card>
            )}
            <Card title="Versions">
              <div className="scroll"><table>
                <thead><tr><th>Version</th><th>Saved</th><th>By</th><th /></tr></thead>
                <tbody>{versions.map((v) => (
                  <tr key={v.version}>
                    <td>v{v.version}{v.active && <span className="pill s-succeeded" style={{ marginLeft: 8 }}>Active</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{new Date(v.createdAt).toLocaleDateString()}</td>
                    <td>{v.createdBy}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="ghost" onClick={() => { setCompare(v.version); setDraft(v.prompt); }}>Load</button>{' '}
                      {!v.active && !archived && <button className="ghost" disabled={busy} onClick={() => void run(() => api(`/strategies/${encodeURIComponent(sel)}/versions/${v.version}/activate`, { method: 'POST' }), `v${v.version} is active again.`)}>Activate</button>}
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
              <p className="muted small" style={{ marginBottom: 0 }}>Load copies a version into the editor, so you can review it or save it as a new version.</p>
            </Card>
          </div>
        )}
      </div>
    </main>
  );
}
