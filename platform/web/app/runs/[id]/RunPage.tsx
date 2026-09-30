'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, describe, engineDecision, type Decision, type RunDetail, type RunEvent, type Tripwire } from '@/lib/api';
import { useLive } from '@/lib/live';
import { Ago, Card, ComparisonPill, Json, StatusPill, Loading } from '@/components/ui';
import { CandleChart, type Candle } from '@/components/CandleChart';

const TERMINAL = ['succeeded', 'failed', 'cancelled', 'expired'];

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chart, setChart] = useState<{ candles: Candle[]; source: string; reason?: string } | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  const { tick } = useLive((e) => String(e.runId) === id);

  const load = useCallback(async () => {
    try { setD(await api<RunDetail>(`/runs/${id}`)); setError(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [id]);
  useEffect(() => { void load(); }, [load, tick]);
  useEffect(() => {
    api<{ candles: Candle[]; source: string; reason?: string }>(`/runs/${id}/chart`).then((c) => { setChart(c); setChartError(null); }).catch((e) => setChartError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  if (error && !d) return <main className="wrap"><p className="crumb"><Link href="/runs">Back to runs</Link></p><div className="msg err" role="alert">{error}</div></main>;
  if (!d) return <main className="wrap"><Loading full /></main>;

  const { run, agent, snapshot, attempts, events } = d;
  const engine = engineDecision(run);
  const attemptNo = new Map(attempts.map((a) => [a.id, a.attemptNo]));
  const terminal = TERMINAL.includes(run.status);

  return (
    <main className="wrap">
      <p className="crumb"><Link href="/runs">Back to runs</Link></p>
      <div className="top">
        <div className="left">
          <h1>Run #{run.id}</h1>
          <StatusPill status={run.status} cancelRequested={run.cancelRequested} />
          <ComparisonPill value={run.comparison} status={run.status} />
          <span className="muted">{agent.name} · {snapshot.event} · <Ago iso={run.createdAt} /></span>
        </div>
        <div>
          {run.cancelRequested && !terminal && <span className="cancel-note">Cancel requested, waiting for the worker to stop. </span>}
          <button className="danger" disabled={busy || terminal || run.cancelRequested} onClick={async () => {
            setBusy(true);
            try { await api(`/runs/${run.id}/cancel`, { method: 'POST' }); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
          }}>Cancel run</button>
        </div>
      </div>
      {error && <div className="msg err" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
      {run.stopReason && <p className="muted" style={{ marginTop: -6 }}>Stop reason: {run.stopReason}</p>}

      <Card title="Chart" aside={chart && chart.source !== 'none' && <span className="muted small">{chart.source === 'snapshot' ? 'candles frozen in the snapshot' : 'live engine window, not frozen'}</span>} className="chart-card">
        {chart?.reason ? <p className="muted">No chart: {chart.reason}.</p> : chart ? (
          <CandleChart candles={chart.candles} asOf={snapshot.payload.asOf} price={snapshot.payload.quote?.last ?? snapshot.payload.close}
            flip={snapshot.payload.flip} agent={run.proposal} engine={engine} />
        ) : chartError ? <p className="muted">{chartError}</p> : <p className="muted">Loading chart…</p>}
      </Card>

      <div className="grid run-grid">
        <Card title="What happened">
          <ol className="timeline">
            {events.map((e, i) => {
              const prev = events[i - 1];
              const newAttempt = e.attemptId && e.attemptId !== prev?.attemptId;
              return (
                <Fragment key={e.id}>
                  {newAttempt && <li><span className="sep" style={{ gridColumn: '1 / -1' }}>Attempt {attemptNo.get(e.attemptId!)}</span></li>}
                  <li><span className="t">{new Date(e.at).toLocaleTimeString([], { hour12: false })}</span><Event e={e} /></li>
                </Fragment>
              );
            })}
          </ol>
        </Card>

        <div className="grid">
          <Card title="Agent proposal">
            {run.proposal ? <ProposalView p={run.proposal} /> : <p className="muted">{terminal ? 'No proposal was recorded.' : 'Waiting for the agent.'}</p>}
            {run.validation && (
              <div style={{ marginTop: 10 }}>
                <span className={`pill ${run.validation.valid ? 'c-agree' : 's-failed'}`}>{run.validation.valid ? 'Passed deterministic checks' : 'Rejected by deterministic checks'}</span>
                <span className="muted small"> · not executed · snapshot {run.validation.freshnessSeconds}s old at completion</span>
                {run.validation.reasons?.length > 0 && <ul className="reasons">{run.validation.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
              </div>
            )}
          </Card>

          <Card title="Engine decision" aside={<ComparisonPill value={run.comparison} status={run.status} />}>
            {engine ? <ProposalView p={engine} /> : <p className="muted">{run.comparison === 'no_legacy' ? 'This run did not come from an engine event, so there is nothing to compare.' : 'The engine has not reported a decision for this snapshot yet.'}</p>}
            {run.legacyDecision && (run.legacyDecision as any).error && <p className="small" style={{ color: 'var(--bad)' }}>Engine error: {(run.legacyDecision as any).error}</p>}
          </Card>

          <Card title="Attempts">
            <div className="scroll"><table>
              <thead><tr><th>#</th><th>Worker</th><th>Status</th><th>Tools</th><th>Tokens</th></tr></thead>
              <tbody>{attempts.map((a) => (
                <tr key={a.id}><td>{a.attemptNo}</td><td className="mono">{a.workerId}</td>
                  <td>{a.status}{a.error && <div className="small" style={{ color: 'var(--bad)' }}>{a.error}</div>}</td>
                  <td className="num">{a.toolCalls}</td>
                  <td className="num">{a.usage?.promptTokens != null ? `${a.usage.promptTokens} in / ${a.usage.completionTokens} out` : '–'}</td></tr>
              ))}</tbody>
            </table></div>
            <p className="muted small" style={{ margin: '8px 0 0' }}>Allowed tools: {agent.allowedTools.join(', ')}. Budget: {agent.budgets.maxToolCalls} tool calls per attempt, {run.maxAttempts} attempts.</p>
          </Card>

          <Card title="Frozen snapshot">
            <dl className="kv">
              <dt>Taken</dt><dd><Ago iso={snapshot.takenAt} /> · {snapshot.source}</dd>
              <dt>Digest</dt><dd className="mono">{snapshot.digest.slice(0, 16)}</dd>
              <dt>Close</dt><dd className="num">{snapshot.payload.close}</dd>
              <dt>Flip</dt><dd>{snapshot.payload.flip ? `${snapshot.payload.flip.signal} @ ${snapshot.payload.flip.price}` : 'none'}</dd>
              <dt>Strategy</dt><dd>{snapshot.payload.strategy?.name ?? 'n/a'}</dd>
            </dl>
            <Json value={snapshot.payload} />
          </Card>
        </div>
      </div>
    </main>
  );
}

function ProposalView({ p }: { p: Decision }) {
  return (
    <div>
      <div className="decision">{describe(p)}</div>
      {p.action === 'open' && <div className="num muted">stop {p.stop}{p.target != null ? ` · target ${p.target}` : ''}</div>}
      {p.action === 'set_tripwires' && (p.tripwires?.length
        ? <ul className="small muted" style={{ margin: '4px 0 0' }}>{p.tripwires.map((t, i) => <li key={i}>{tripwireText(t)}</li>)}</ul>
        : <div className="small muted">replaces the tripwires with an empty list</div>)}
      {p.reasoning && <p style={{ margin: '6px 0 0' }}>{p.reasoning}</p>}
    </div>
  );
}

function Event({ e }: { e: RunEvent }) {
  const p = e.payload ?? {};
  switch (e.kind) {
    case 'queued': return <div>Queued by {p.source} ({p.trigger})</div>;
    case 'claimed': return <div>Claimed by <span className="mono">{p.worker}</span>, attempt {p.attempt}</div>;
    case 'worker': return <div>Runtime <strong>{p.runtime}</strong> · restricted tools {p.capabilities?.restrictedTools ? 'yes' : 'no'} · cancellation {p.capabilities?.cancellation ? 'yes' : 'no'} · checkpoint {p.capabilities?.checkpoint ? 'yes' : 'no'}</div>;
    case 'step': return <div>{p.text}</div>;
    case 'tool_call':
      return (
        <div className="ev-tool"><span className="k">{p.tool}</span> <span className="mono">{JSON.stringify(p.args)}</span>
          <span className="muted"> → {p.ok ? 'ok' : 'error'}, {p.bytes} B, {p.ms} ms</span>
          {p.preview && <details className="json"><summary>result</summary><pre>{p.preview}</pre></details>}
        </div>
      );
    case 'tool_denied': return <div className="ev-denied"><span className="k">Denied {p.tool}</span> <span className="muted">{p.reason}</span></div>;
    case 'llm_reply':
      return (
        <div className="ev-llm"><span className="k">Model round {p.round}</span>
          <span className="muted"> · {p.promptTokens} in / {p.completionTokens} out{p.toolCalls?.length ? ` · asked for ${p.toolCalls.join(', ')}` : ''}</span>
          {p.text?.trim() && <details className="json"><summary>reply</summary><pre>{p.text}</pre></details>}
        </div>
      );
    case 'interim_proposal': return <div className="ev-prop"><span className="k">Interim proposal</span> {describe(p.proposal)} <span className="muted">(the follow-up run checks it against the original snapshot)</span></div>;
    case 'proposal': return <div className="ev-prop"><span className="k">Final proposal</span> {describe(p.proposal)}</div>;
    case 'proposal_rejected': return <div className="ev-reject"><span className="k">Proposal rejected</span> {describe(p.proposal)} <span className="muted">{p.validation?.reasons?.join('; ')}</span></div>;
    case 'waiting': return <div className="ev-wait"><span className="k">Waiting {p.seconds}s</span> {p.reason}</div>;
    case 'woken': return <div className="ev-wait"><span className="k">Woken</span> {p.reason}</div>;
    case 'retry': return <div className="ev-retry"><span className="k">Retry in {p.backoffSeconds}s</span> {p.error}</div>;
    case 'cancel_requested': return <div className="ev-wait"><span className="k">Cancel requested</span></div>;
    case 'legacy_decision': return <div>Engine decision received: {describe(p.decision ?? p)}</div>;
    case 'status': return <div className="muted">Status: {p.status}{p.reason ? ` (${p.reason})` : ''}</div>;
    default: return <div className="muted">{e.kind}</div>;
  }
}

// kind plus the parameters the tripwire carries, e.g. "price_cross level 72.4 dir above"
function tripwireText(t: Tripwire): string {
  const params = Object.entries(t).filter(([k, v]) => k !== 'kind' && v != null && v !== 0 && v !== '');
  return [t.kind, ...params.map(([k, v]) => `${k} ${v}`)].join(' ');
}
