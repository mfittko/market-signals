import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotKey, buildSnapshot, emitSnapshot, emitLegacyDecision, controlPlaneEnabled } from '../scripts/control-plane.mjs';
import { deliberate } from '../scripts/bot.mjs';
import { botConfig, portfolioView } from '../scripts/portfolio.mjs';

const WTI = 'WTICO/USD';
const ENV = { MS_CONTROL_PLANE_URL: 'http://cp.test', MS_INGEST_TOKEN: 'tok' };
const view = { equity: 10000.123, cash: 9000, halted: false, positions: [{ id: 3, instrument: WTI, side: 'long', notional: 500, entry_price: 87, stop: 86, target: null, secret: 'x' }] };
const params = {
  instrument: WTI, granularity: 'M5', event: 'flip', candleTime: '2026-07-22T10:00:00Z', strategyVersion: 'abcd1234',
  strategyRow: { name: 's1', version: 2 }, strategyPrompt: 'follow flips', view,
  ctx: { close: 87, quote: { last: 87.1 }, flip: { signal: 'sell', price: 87, time: 't' }, supertrend: 87.5, trend: 'down', backtest: { winRatePct: 55 }, traderMemories: 'm' },
};

test('control plane is off unless MS_CONTROL_PLANE_URL is set, and off costs nothing', async () => {
  assert.equal(controlPlaneEnabled({}), false);
  assert.equal(controlPlaneEnabled({ MS_CONTROL_PLANE_URL: '  ' }), false);
  let called = false;
  const key = await emitSnapshot(params, { env: {}, fetchImpl: () => { called = true; } });
  assert.equal(key, null);
  assert.equal(called, false);
  assert.equal(await emitLegacyDecision('k', { decision: { action: 'hold' } }, { env: {}, fetchImpl: () => { called = true; } }), false);
  assert.equal(called, false);
});

test('snapshot key is stable per decision point and differs across them', () => {
  const a = snapshotKey(params);
  assert.equal(a, snapshotKey({ ...params }));
  assert.notEqual(a, snapshotKey({ ...params, candleTime: '2026-07-22T10:05:00Z' }));
  assert.notEqual(a, snapshotKey({ ...params, event: 'review' }));
  assert.notEqual(a, snapshotKey({ ...params, strategyVersion: 'ffff0000' }));
  assert.notEqual(a, snapshotKey({ ...params, deliberationId: 'd2' }));
});

test('two deliberations on the same candle get two snapshot keys, one deliberation keeps its key', async () => {
  const keys = [];
  const fetchImpl = async (url, init) => { keys.push(JSON.parse(init.body).idempotencyKey); return { ok: true, json: async () => ({}) }; };
  const first = await emitSnapshot(params, { env: ENV, fetchImpl });
  const second = await emitSnapshot(params, { env: ENV, fetchImpl });
  assert.notEqual(first, second);
  assert.deepEqual(keys, [first, second]);
  const resent = { ...params, deliberationId: 'd1' };
  assert.equal(await emitSnapshot(resent, { env: ENV, fetchImpl }), await emitSnapshot(resent, { env: ENV, fetchImpl }));
});

test('snapshot freezes the decision point and copies only known position fields', () => {
  const s = buildSnapshot(params);
  assert.equal(s.close, 87);
  assert.equal(s.quote.last, 87.1);
  assert.equal(s.flip.signal, 'sell');
  assert.equal(s.strategy.prompt, 'follow flips');
  assert.equal(s.portfolio.equity, 10000.12);
  assert.deepEqual(Object.keys(s.portfolio.positions[0]).sort(), ['entry_price', 'granularity', 'id', 'instrument', 'notional', 'side', 'stop', 'target']);
  assert.equal(JSON.stringify(s).includes('"secret"'), false);
});

test('emitSnapshot posts to the ingest endpoint with the bearer token', async () => {
  let seen;
  const key = await emitSnapshot(params, { env: ENV, fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({}) }; } });
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(seen.url, 'http://cp.test/api/v1/events');
  assert.equal(seen.init.headers.authorization, 'Bearer tok');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.idempotencyKey, key);
  assert.equal(body.payload.instrument, WTI);
});

test('delivery failures are swallowed: never throws, never blocks', async () => {
  for (const fetchImpl of [async () => { throw new Error('ECONNREFUSED'); }, async () => ({ ok: false, status: 500 })]) {
    assert.equal(await emitSnapshot(params, { env: ENV, fetchImpl }), null);
    assert.equal(await emitLegacyDecision('k', { decision: { action: 'hold' } }, { env: ENV, fetchImpl }), false);
  }
  assert.equal(await emitLegacyDecision(null, { decision: { action: 'hold' } }, { env: ENV, fetchImpl: () => { throw new Error('unreachable'); } }), false);
});

test('deliberate sends the snapshot before the decision and the engine decision after, and the decision is unchanged', async () => {
  const requests = [];
  // the legacy POST is fire-and-forget, so wait for it to arrive instead of for a fixed time
  let bothArrived;
  const both = new Promise((r) => { bothArrived = r; });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) }); if (requests.length === 2) bothArrived(); res.setHeader('content-type', 'application/json'); res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'cp-'));
  const bin = join(dir, 'pi');
  writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\necho '{"action":"hold","reasoning":"checked"}'\n`);
  chmodSync(bin, 0o755);
  const settings = { provider: 'pi', piBin: bin, bot: { enabled: true, riskPct: 100 } };
  const prev = { ...process.env };
  process.env.MS_CONTROL_PLANE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.MS_INGEST_TOKEN = 'tok';
  try {
    const r = await deliberate(join(dir, 'bot.sqlite'), settings, { instrument: WTI, granularity: 'M5', event: 'flip', candleTime: '2026-07-22T10:00:00Z', ctx: { close: 87, quote: { last: 87 } } });
    assert.equal(r.decision.action, 'hold');
    await Promise.race([both, new Promise((r2) => setTimeout(r2, 10_000).unref())]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, '/api/v1/events');
    assert.match(requests[1].url, /^\/api\/v1\/events\/[0-9a-f]{32}\/legacy$/);
    assert.equal(requests[1].body.decision.action, 'hold');
    assert.ok(requests[1].url.includes(requests[0].body.idempotencyKey));
    assert.equal(requests[0].auth, 'Bearer tok');
  } finally {
    process.env.MS_CONTROL_PLANE_URL = prev.MS_CONTROL_PLANE_URL ?? '';
    if (prev.MS_CONTROL_PLANE_URL === undefined) delete process.env.MS_CONTROL_PLANE_URL;
    if (prev.MS_INGEST_TOKEN === undefined) delete process.env.MS_INGEST_TOKEN;
    await new Promise((r) => server.close(r));
  }
});

test('an unreachable control plane cannot change or delay a bot decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-'));
  const bin = join(dir, 'pi');
  writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\necho '{"action":"hold","reasoning":"checked"}'\n`);
  chmodSync(bin, 0o755);
  const settings = { provider: 'pi', piBin: bin, bot: { enabled: true, riskPct: 100 } };
  process.env.MS_CONTROL_PLANE_URL = 'http://127.0.0.1:9'; // nothing listens on the discard port
  try {
    const t0 = Date.now();
    const db = join(dir, 'bot.sqlite');
    const r = await deliberate(db, settings, { instrument: WTI, granularity: 'M5', event: 'flip', ctx: { close: 87, quote: { last: 87 } } });
    assert.equal(r.decision.action, 'hold');
    assert.ok(Date.now() - t0 < 5000, 'decision must not wait for the control plane');
    assert.ok(portfolioView(db, botConfig(settings)).journal.some((j) => j.action === 'decision'));
  } finally {
    delete process.env.MS_CONTROL_PLANE_URL;
  }
});
