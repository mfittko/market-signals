import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer, livePriceSource } from '../scripts/signal-server.mjs';

const body = { prices: [{ time: '2026-10-08T18:46:27Z', bids: [{ price: '93.109' }, { price: '93.0' }], asks: [{ price: '93.139' }] }] };

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    const r = responses.shift() ?? { status: 200, body };
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  };
  return { fn, calls };
}

test('livePriceSource maps the first bid/ask level, shares in-flight calls and caches for the TTL', async () => {
  let t = 0;
  const { fn, calls } = fakeFetch([]);
  const get = livePriceSource(fn, { ttlMs: 1000, now: () => t });
  const [a, b] = await Promise.all([get('WTICO/USD'), get('WTICO/USD')]);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /oanda\/pricing\?instruments=WTICO%2FUSD$/);
  assert.equal(a, b);
  assert.equal(a.bid, 93.109);
  assert.equal(a.ask, 93.139);
  assert.ok(Math.abs(a.mid - 93.124) < 1e-9);
  assert.ok(Math.abs(a.spread - 0.03) < 1e-9);
  t = 999; await get('WTICO/USD');
  assert.equal(calls.length, 1, 'still inside the TTL');
  await get('EUR/USD');
  assert.equal(calls.length, 2, 'each instrument has its own entry');
  t = 1000; await get('WTICO/USD');
  assert.equal(calls.length, 3, 'TTL expired');
});

test('livePriceSource does not keep a failure', async () => {
  const { fn, calls } = fakeFetch([{ status: 503 }]);
  const get = livePriceSource(fn, { now: () => 0 });
  await assert.rejects(get('WTICO/USD'), /pricing HTTP 503/);
  assert.equal((await get('WTICO/USD')).bid, 93.109);
  assert.equal(calls.length, 2);
});

test('GET /api/price validates the instrument and returns 502 on upstream failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'price-'));
  const { fn } = fakeFetch([{ status: 200, body }, { status: 500 }]);
  const server = buildServer({ dbPath: join(dir, 'db.sqlite'), settingsPath: join(dir, 'settings.json'), fetcher: null, priceFetch: fn });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(`${base}/api/price?instrument=WTICO/USD`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ask, 93.139);
    res = await fetch(`${base}/api/price?instrument=bad;x`);
    assert.equal(res.status, 400);
    res = await fetch(`${base}/api/price?instrument=EUR/USD`);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /HTTP 500/);
  } finally {
    server.close();
  }
});
