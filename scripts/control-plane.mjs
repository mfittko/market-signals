// Shadow bridge to the agent control plane (platform/). Off unless
// MS_CONTROL_PLANE_URL is set. The engine stays the only authority: this only
// hands the control plane a frozen copy of a decision point, then the engine's
// own decision for comparison. Every failure is swallowed — a slow or absent
// control plane must never delay or change a bot decision.
import { createHash } from 'node:crypto';

const TIMEOUT_MS = 2000;

export const controlPlaneEnabled = (env = process.env) => Boolean((env.MS_CONTROL_PLANE_URL || '').trim());

// Same decision point => same key, so a re-run of a cycle enqueues nothing new.
export function snapshotKey({ instrument, granularity, event, candleTime, strategyVersion }) {
  return createHash('sha256')
    .update([instrument, granularity, event, candleTime ?? '', strategyVersion ?? ''].join('|'))
    .digest('hex')
    .slice(0, 32);
}

const round = (v, d = 4) => (Number.isFinite(v) ? Number(v.toFixed(d)) : v);

// The frozen snapshot: what the engine knew at the moment it decided.
export function buildSnapshot({ instrument, granularity, event, candleTime, ctx, view, strategyRow, strategyPrompt, strategyVersion }) {
  const { close, quote, flip, volumeImpulse, supertrend, trend, backtest, axisGate, traderMemories, sentinel } = ctx || {};
  return {
    instrument, granularity, event,
    asOf: candleTime ?? null,
    close: close ?? null,
    quote: { last: quote?.last ?? close ?? null, provisional: false },
    flip: flip ? { signal: flip.signal, price: flip.price, time: flip.time, reason: flip.reason ?? null, barsAgo: flip.barsAgo ?? null } : null,
    volumeImpulse: volumeImpulse ?? null,
    trend: trend ?? null,
    supertrend: supertrend ?? null,
    backtest: backtest ?? null,
    strategy: {
      name: strategyRow?.name ?? null, version: strategyVersion, dbVersion: strategyRow?.version ?? null,
      prompt: strategyPrompt ?? null,
    },
    portfolio: {
      equity: round(view.equity, 2), cash: round(view.cash, 2), halted: view.halted === true,
      positions: (view.positions || []).map((p) => ({
        id: p.id, instrument: p.instrument, side: p.side, notional: p.notional,
        entry_price: p.entry_price, stop: p.stop, target: p.target, granularity: p.granularity ?? null,
      })),
    },
    context: { traderMemories: traderMemories ?? null, sentinel: sentinel ?? null, axisGate: axisGate ?? null },
  };
}

async function post(path, body, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const base = env.MS_CONTROL_PLANE_URL.trim().replace(/\/+$/, '');
  const res = await fetchImpl(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.MS_INGEST_TOKEN || ''}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`control plane ${res.status}`);
  return res.json();
}

// Enqueue the snapshot. Resolves to the idempotency key, or null when disabled
// or unreachable. Never rejects.
export async function emitSnapshot(params, opts = {}) {
  const env = opts.env ?? process.env;
  if (!controlPlaneEnabled(env)) return null;
  try {
    const key = snapshotKey(params);
    await post('/api/v1/events', {
      idempotencyKey: key, instrument: params.instrument, granularity: params.granularity, event: params.event,
      payload: buildSnapshot(params),
    }, { ...opts, env });
    return key;
  } catch (err) {
    process.stderr.write(`[control-plane] snapshot not delivered (engine unaffected): ${err.message}\n`);
    return null;
  }
}

// Report what the engine itself decided, so the shadow proposal can be compared.
export async function emitLegacyDecision(key, { decision, executed, error }, opts = {}) {
  const env = opts.env ?? process.env;
  if (!key || !controlPlaneEnabled(env)) return false;
  try {
    await post(`/api/v1/events/${key}/legacy`, { decision, executed: executed ?? null, error: error ?? null }, { ...opts, env });
    return true;
  } catch (err) {
    process.stderr.write(`[control-plane] legacy decision not delivered (engine unaffected): ${err.message}\n`);
    return false;
  }
}
