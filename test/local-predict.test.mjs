import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { storeCandles } from '../scripts/supertrend.mjs';
import { listPredictions } from '../scripts/predictions.mjs';
import { buildServer, refreshLocalPredictions } from '../scripts/signal-server.mjs';
import {
  volFeatures, volScore, volModel, noTradeReasons, localPredict, newsInput, fetchBidAsk, DIRECTION_ESTIMATE, VOL_WINDOW_BARS,
} from '../scripts/local-predict.mjs';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/local-predict-parity.json', import.meta.url), 'utf8'));
const toBars = (rows) => rows.map(([t, high, low, close]) => ({ time: new Date(t * 60000).toISOString(), open: close, high, low, close }));

test('parity: bars -> features -> probability match the Python research export within 1e-9', () => {
  for (const inst of FIX.instruments) {
    const bars = toBars(inst.bars);
    const model = volModel(inst.instrument);
    assert.ok(model, `artifact for ${inst.instrument}`);
    assert.deepEqual(model.features, inst.features);
    assert.ok(inst.cases.length >= 8);
    for (const c of inst.cases) {
      const f = volFeatures(bars.slice(0, c.index + 1).slice(-VOL_WINDOW_BARS));
      assert.ok(f, `${inst.instrument} ${c.bar_open_utc} features`);
      assert.equal(bars[c.index].time.slice(0, 16), c.bar_open_utc);
      for (let j = 0; j < c.x.length; j++) assert.ok(Math.abs(f.x[j] - c.x[j]) <= 1e-9, `${inst.instrument} ${c.bar_open_utc} ${inst.features[j]}: ${f.x[j]} vs ${c.x[j]}`);
      assert.ok(Math.abs(f.atr - c.atr) <= 1e-9 * c.atr, 'ATR');
      const { z, p } = volScore(model, f.x);
      assert.ok(Math.abs(z - c.z) <= 1e-9 && Math.abs(p - c.p) <= 1e-9, `${inst.instrument} ${c.bar_open_utc} p ${p} vs ${c.p}`);
      // the spread rule reads the same spr the research computed
      assert.ok(Math.abs((c.ask_c - c.bid_c) / (1.5 * f.atr) - c.spr) <= 1e-9);
    }
  }
});

test('volFeatures refuses a window too short for the ATR median', () => {
  assert.equal(volFeatures(toBars(FIX.instruments[0].bars.slice(0, 500))), null);
});

test('no-trade reasons: spread over 0.2 R, thin UTC hour, fresh escalated news (untested)', () => {
  const at = (h) => Date.UTC(2026, 9, 7, h, 0);
  assert.deepEqual(noTradeReasons({ instrument: 'WTICO/USD', spreadR: 0.2, closeMs: at(12) }), []);
  assert.deepEqual(noTradeReasons({ instrument: 'WTICO/USD', spreadR: 0.21, closeMs: at(12) }).map((r) => r.code), ['spread']);
  assert.deepEqual(noTradeReasons({ instrument: 'WTICO/USD', spreadR: null, closeMs: at(22) }).map((r) => r.code), ['thin_hour']);
  assert.deepEqual(noTradeReasons({ instrument: 'SPX500/USD', spreadR: null, closeMs: at(22) }), []);
  assert.deepEqual(noTradeReasons({ instrument: 'BCO/USD', spreadR: null, closeMs: at(22) }), [], 'no thin-hour list');
  const r = noTradeReasons({ instrument: 'EUR/USD', spreadR: 0.5, closeMs: at(4), news: { freshEscalation: { id: 1 } } });
  assert.deepEqual(r.map((x) => x.code), ['spread', 'thin_hour', 'news_untested']);
  assert.match(r[2].text, /untested/);
  for (const x of r) assert.match(x.text, /^No trade now: /);
});

test('newsInput: latest headline within 6h, fresh escalation within 30 min of availability', () => {
  const db = new DatabaseSync(':memory:');
  const now = Date.UTC(2026, 9, 7, 12, 0);
  assert.equal(newsInput(db, 'WTICO/USD', now), null, 'no news table');
  db.exec('CREATE TABLE news (instrument TEXT, title TEXT, time TEXT, fetched_at TEXT, escalation INTEGER)');
  const add = (min, esc, fetchedMin = min) => db.prepare('INSERT INTO news VALUES (?,?,?,?,?)')
    .run('WTICO/USD', `h${min}`, new Date(now - min * 60000).toISOString(), new Date(now - fetchedMin * 60000).toISOString(), esc);
  add(400, 1);
  assert.equal(newsInput(db, 'WTICO/USD', now), null, 'older than 6h');
  add(90, 1, 20); // published 90 min ago, stored 20 min ago: available 20 min ago
  add(10, 0);
  const n = newsInput(db, 'WTICO/USD', now);
  assert.equal(n.latest.title, 'h10');
  assert.equal(n.latest.escalation, 'routine');
  assert.equal(n.freshEscalation.title, 'h90');
  assert.equal(n.freshEscalation.availableAt, new Date(now - 20 * 60000).toISOString());
  assert.equal(newsInput(db, 'WTICO/USD', now + 15 * 60000).freshEscalation, undefined, 'more than 30 min after it became available');
});

// a recent window of the fixture bars, re-timed to end at the bar that just closed
function liveBars(now, rows = FIX.instruments[0].bars) {
  const lastOpen = Math.floor(now / 300000) * 300000 - 300000;
  return rows.map(([, high, low, close], k) => ({ time: new Date(lastOpen - (rows.length - 1 - k) * 300000).toISOString(), open: close, high, low, close, volume: 1 }));
}

test('localPredict: four parts, no trade when no side clears the margin, news never moves direction', () => {
  const now = Date.UTC(2026, 9, 7, 14, 2);
  const m5 = liveBars(now);
  const candles = [...m5.slice(-400), { ...m5.at(-1), time: new Date(Date.parse(m5.at(-1).time) + 300000).toISOString(), partial: true }];
  const base = localPredict({ instrument: 'WTICO/USD', granularity: 'M5', candles, m5 }, { now });
  assert.equal(base.candleTime, m5.at(-1).time, 'the newest closed candle, not the forming one');
  assert.equal(base.forming, false);
  assert.equal(base.action, 'no_trade');
  assert.equal(base.probabilities.long, DIRECTION_ESTIMATE['WTICO/USD'].up);
  assert.ok(base.probabilities.no_trade > 0.9);
  assert.equal(base.detail.move.available, true);
  assert.ok(base.detail.move.p > 0 && base.detail.move.p < 1);
  assert.match(base.detail.trend.text, /^supertrend (up|down), H1 (agrees|disagrees)$/);
  assert.deepEqual(base.detail.reasons, []);
  assert.match(base.state.direction, /no measurable direction edge/);
  // a wide spread and fresh escalated news switch to no trade with reasons, but never touch direction or move size
  const news = { latest: { id: 7, title: 'Tanker hit', escalation: 'escalation' }, freshEscalation: { id: 7 } };
  const ba = new Map([[Date.parse(m5.at(-1).time), { bid: 100, ask: 100 + base.detail.features.atr }]]);
  const r = localPredict({ instrument: 'WTICO/USD', granularity: 'M5', candles, m5, news, bidAsk: ba }, { now });
  assert.deepEqual(r.detail.reasons.map((x) => x.code), ['spread', 'news_untested']);
  assert.equal(r.probabilities.no_trade, 1);
  assert.deepEqual([r.probabilities.long, r.probabilities.short, r.detail.move.p], [base.probabilities.long, base.probabilities.short, base.detail.move.p]);
  assert.match(r.state.news, /not used for direction/);
});

test('localPredict: no artifact or stale M5 makes move size unavailable, not an error', () => {
  const now = Date.UTC(2026, 9, 7, 14, 2);
  const m5 = liveBars(now);
  const other = localPredict({ instrument: 'BCO/USD', granularity: 'M5', candles: m5.slice(-200), m5 }, { now });
  assert.equal(other.detail.move.available, false);
  assert.equal(other.probabilities.long, 0.5);
  assert.equal(other.action, 'no_trade');
  const stale = localPredict({ instrument: 'WTICO/USD', granularity: 'M5', candles: m5.slice(-200), m5: m5.slice(0, -10) }, { now });
  assert.equal(stale.detail.move.text, 'no current M5 data');
});

test('fetchBidAsk reads complete bid/ask closes and fails soft', async () => {
  const body = { candles: [{ complete: true, time: '2026-10-08T06:35:00.000000000Z', bid: { c: '92.330' }, ask: { c: '92.370' } }, { complete: false, time: '2026-10-08T06:40:00.000000000Z', bid: { c: '1' }, ask: { c: '2' } }] };
  let asked;
  const m = await fetchBidAsk('WTICO/USD', 'M5', { fetchFn: async (u) => { asked = String(u); return { ok: true, json: async () => body }; } });
  assert.match(asked, /price=BA/);
  assert.deepEqual([...m.entries()], [[Date.parse('2026-10-08T06:35:00Z'), { bid: 92.33, ask: 92.37 }]]);
  assert.equal(await fetchBidAsk('X', 'M5', { fetchFn: async () => { throw new Error('down'); } }), null);
  assert.equal(await fetchBidAsk('X', 'M5', { fetchFn: async () => ({ ok: false }) }), null);
});

// ---- engine routes with the local provider
async function withLocalServer(settings, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'local-pred-'));
  const dbPath = join(dir, 'db.sqlite');
  const settingsPath = join(dir, 'settings.json');
  const m5 = liveBars(Date.now());
  storeCandles(dbPath, 'WTICO/USD', 'M5', m5);
  writeFileSync(settingsPath, JSON.stringify(settings));
  const calls = [];
  const providerFetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('price=BA')) return { ok: true, json: async () => ({ candles: [] }) };
    return { ok: true, json: async () => ({ model: 'jev', answers: { action: { type: 'choice', choice: 'long', probabilities: { long: 0.7, short: 0.1, no_trade: 0.2 } }, setup_quality: { type: 'score', score: 2 }, trend_confirmed: { type: 'noul', noul: 0.9 } } }) };
  };
  const server = buildServer({ dbPath, settingsPath, fetcher: null, providerFetch });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn({ base, calls, dbPath, settingsPath, m5 }); } finally { server.close(); }
}
const post = (base, body) => fetch(`${base}/api/predict`, { method: 'POST', body: JSON.stringify(body) });
const typesafeCalls = (calls) => calls.filter((u) => u.includes('typesafe')).length;

test('POST /api/predict: local is the default, needs no key, stores one run per closed candle', async () => {
  await withLocalServer({ predictionEnabled: '1' }, async ({ base, calls, m5 }) => {
    const r = await post(base, { instrument: 'WTICO/USD', granularity: 'M5', reuse: true });
    assert.equal(r.status, 200);
    const { prediction: p } = await r.json();
    assert.equal(p.provider, 'local');
    assert.equal(p.candleTime, m5.at(-1).time);
    assert.equal(p.detail.move.available, true);
    assert.equal(p.action, 'no_trade');
    assert.equal(p.valid, true);
    assert.equal(Date.parse(p.expiresAt), Date.parse(m5.at(-1).time) + 600000, 'valid until the next candle closes');
    const again = (await (await post(base, { instrument: 'WTICO/USD', granularity: 'M5', reuse: true })).json()).prediction;
    assert.deepEqual([again.id, again.reused], [p.id, true]);
    const forced = (await (await post(base, { instrument: 'WTICO/USD', granularity: 'M5' })).json()).prediction;
    assert.equal(forced.id, p.id, 'same candle: no duplicate row');
    assert.equal(typesafeCalls(calls), 0);
    const list = (await (await fetch(`${base}/api/predictions?instrument=WTICO/USD&granularity=M5`)).json()).predictions;
    assert.equal(list.length, 1);
    assert.equal(list[0].detail.features.x.length, 12);
  });
});

test('POST /api/predict: Jev when selected and keyed; a local run is never reused for Jev', async () => {
  await withLocalServer({ predictionEnabled: '1' }, async ({ base, calls, settingsPath }) => {
    const local = (await (await post(base, { instrument: 'WTICO/USD', granularity: 'M5', reuse: true })).json()).prediction;
    writeFileSync(settingsPath, JSON.stringify({ predictionEnabled: '1', predictionProvider: 'typesafe-jev' }));
    assert.equal((await post(base, { instrument: 'WTICO/USD', granularity: 'M5' })).status, 409, 'Jev without a key is off');
    writeFileSync(settingsPath, JSON.stringify({ predictionEnabled: '1', predictionProvider: 'typesafe-jev', TYPESAFE_API_KEY: 'k' }));
    const jev = (await (await post(base, { instrument: 'WTICO/USD', granularity: 'M5', reuse: true })).json()).prediction;
    assert.equal(jev.provider, 'typesafe-jev');
    assert.notEqual(jev.id, local.id);
    assert.equal(typesafeCalls(calls), 1);
    const bad = await (await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ predictionProvider: 'oracle' }) })).json();
    assert.match(bad.error, /predictionProvider/);
    const ok = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ predictionProvider: 'local' }) });
    assert.equal(ok.status, 200);
  });
});

test('refreshLocalPredictions: one free run per watched pair, nothing while off or on Jev', async () => {
  await withLocalServer({}, async ({ dbPath, calls }) => {
    const combos = [{ instrument: 'WTICO/USD', granularity: 'M5' }, { instrument: 'WTICO/USD', granularity: 'D' }];
    const opts = { fetcher: null, fetchFn: async () => ({ ok: false }), log: () => {} };
    assert.deepEqual(await refreshLocalPredictions(dbPath, combos, {}, opts), []);
    assert.deepEqual(await refreshLocalPredictions(dbPath, combos, { predictionEnabled: '1', predictionProvider: 'typesafe-jev', TYPESAFE_API_KEY: 'k' }, opts), []);
    const runs = await refreshLocalPredictions(dbPath, combos, { predictionEnabled: '1' }, opts);
    assert.deepEqual(runs.map((r) => [r.granularity, r.provider, r.reused]), [['M5', 'local', false]]);
    const again = await refreshLocalPredictions(dbPath, combos, { predictionEnabled: '1' }, opts);
    assert.equal(again[0].reused, true);
    assert.equal(listPredictions(dbPath, 'WTICO/USD', 'M5').length, 1);
    assert.equal(calls.length, 0);
  });
});

test('a predictions table from before the detail column is migrated in place', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'pred-mig-')), 'db.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE predictions (id INTEGER PRIMARY KEY AUTOINCREMENT, instrument TEXT NOT NULL, granularity TEXT NOT NULL, candle_time TEXT NOT NULL,
    forming INTEGER NOT NULL, price REAL, horizon_bars INTEGER NOT NULL, asked_at TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, action TEXT NOT NULL,
    probabilities TEXT NOT NULL, confidence REAL, quality REAL, trend_confirmed REAL, latency_ms INTEGER, state TEXT NOT NULL)`);
  db.prepare(`INSERT INTO predictions (instrument, granularity, candle_time, forming, horizon_bars, asked_at, provider, action, probabilities, state)
    VALUES ('WTICO/USD', 'M5', '2026-10-07T10:00:00Z', 1, 3, '2026-10-07T10:01:00Z', 'typesafe-jev', 'long', '{}', '{}')`).run();
  db.close();
  const [row] = listPredictions(dbPath, 'WTICO/USD', 'M5');
  assert.equal(row.detail, null);
  assert.equal(row.provider, 'typesafe-jev');
});
