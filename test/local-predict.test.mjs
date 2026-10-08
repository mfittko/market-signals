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
  bigDayFeatures, bigDayModel, score, noTradeReasons, localPredict, newsInput, newsRelevant, fetchBidAsk, DIRECTION_ESTIMATE, A1_WINDOW_BARS,
} from '../scripts/local-predict.mjs';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/local-predict-a1-parity.json', import.meta.url), 'utf8'));
const toBars = (rows) => rows.map(([t, open, high, low, close]) => ({ time: new Date(t * 60000).toISOString(), open, high, low, close }));

test('parity: 30-min bars -> big-day features -> probability match the Python research export within 1e-9', () => {
  for (const inst of FIX.instruments) {
    const bars = toBars(inst.bars);
    const model = bigDayModel(inst.instrument);
    assert.ok(model, `artifact for ${inst.instrument}`);
    assert.deepEqual(model.features, inst.features);
    assert.equal(model.T1_pct, inst.T1_pct);
    assert.ok(inst.cases.length >= 8);
    for (const c of inst.cases) {
      const f = bigDayFeatures(bars.slice(0, c.index + 1).slice(-A1_WINDOW_BARS), model.T1_pct);
      assert.ok(f, `${inst.instrument} ${c.bar_open_utc} features`);
      assert.equal(bars[c.index].time.slice(0, 16), c.bar_open_utc);
      for (let j = 0; j < c.x.length; j++) assert.ok(Math.abs(f.x[j] - c.x[j]) <= 1e-9, `${inst.instrument} ${c.bar_open_utc} ${inst.features[j]}: ${f.x[j]} vs ${c.x[j]}`);
      assert.ok(Math.abs(f.exc - c.exc_so) <= 1e-9);
      const { z, p } = score(model, f.x);
      assert.ok(Math.abs(z - c.z) <= 1e-9 && Math.abs(p - c.p) <= 1e-9, `${inst.instrument} ${c.bar_open_utc} p ${p} vs ${c.p}`);
    }
  }
});

test('bigDayFeatures refuses a window too short for the 22-session and slot norms', () => {
  assert.equal(bigDayFeatures(toBars(FIX.instruments[0].bars.slice(-500)), 5), null);
});

test('no-trade reasons: spread over 0.2 R and thin UTC hour only', () => {
  const at = (h) => Date.UTC(2026, 9, 7, h, 0);
  assert.deepEqual(noTradeReasons({ instrument: 'WTICO/USD', spreadR: 0.2, closeMs: at(12) }), []);
  assert.deepEqual(noTradeReasons({ instrument: 'WTICO/USD', spreadR: 0.21, closeMs: at(12) }).map((r) => r.code), ['spread']);
  assert.deepEqual(noTradeReasons({ instrument: 'WTICO/USD', spreadR: null, closeMs: at(22) }).map((r) => r.code), ['thin_hour']);
  assert.deepEqual(noTradeReasons({ instrument: 'SPX500/USD', spreadR: null, closeMs: at(22) }), []);
  assert.deepEqual(noTradeReasons({ instrument: 'BCO/USD', spreadR: null, closeMs: at(22) }), [], 'no thin-hour list');
  const r = noTradeReasons({ instrument: 'EUR/USD', spreadR: 0.5, closeMs: at(4) });
  assert.deepEqual(r.map((x) => x.text), ['Spread wide (0.50 of the stop distance, limit 0.2)', 'Thin trading hour (04:00 UTC)']);
});

test('newsRelevant: per-instrument keywords on whole words, nothing for unlisted instruments', () => {
  assert.equal(newsRelevant('WTICO/USD', 'Oil prices climb as OPEC+ holds output'), true);
  assert.equal(newsRelevant('WTICO/USD', 'Cristiano Ronaldo pays tribute to Lionel Messi'), false);
  assert.equal(newsRelevant('WTICO/USD', 'Turmoil in the boardroom'), false, 'no match inside a word');
  assert.equal(newsRelevant('SPX500/USD', 'S&P 500 hits a record as earnings beat'), true);
  assert.equal(newsRelevant('EUR/USD', 'ECB holds rates'), true);
  assert.equal(newsRelevant('JP225/USD', 'Oil and gold rally'), false);
});

test('newsInput: newest headline stored unchanged, newest relevant one picked for display', () => {
  const db = new DatabaseSync(':memory:');
  const now = Date.UTC(2026, 9, 7, 12, 0);
  assert.equal(newsInput(db, 'WTICO/USD', now), null, 'no news table');
  db.exec('CREATE TABLE news (instrument TEXT, title TEXT, time TEXT, fetched_at TEXT, escalation INTEGER)');
  const add = (min, title, esc, fetchedMin = min) => db.prepare('INSERT INTO news VALUES (?,?,?,?,?)')
    .run('WTICO/USD', title, new Date(now - min * 60000).toISOString(), new Date(now - fetchedMin * 60000).toISOString(), esc);
  add(400, 'Crude falls', 1);
  assert.equal(newsInput(db, 'WTICO/USD', now), null, 'older than 6h');
  add(30, 'Crude jumps on Hormuz threat', 1, 2); // published 30 min ago, stored 2 min ago
  add(10, 'Cristiano Ronaldo pays tribute to Lionel Messi', 0);
  const n = newsInput(db, 'WTICO/USD', now);
  assert.deepEqual([n.latest.title, n.latest.relevant, n.latest.escalation], ['Cristiano Ronaldo pays tribute to Lionel Messi', false, 'routine']);
  assert.deepEqual([n.relevant.title, n.relevant.escalation, n.relevant.availableAt], ['Crude jumps on Hormuz threat', 'escalation', new Date(now - 2 * 60000).toISOString()]);
});

// the fixture's 30-min bars re-timed back to back so the newest one has just closed
function liveBars(now, stepMs = 1800000, rows = FIX.instruments[0].bars) {
  const lastOpen = Math.floor(now / stepMs) * stepMs - stepMs;
  return rows.map(([, open, high, low, close], k) => ({ time: new Date(lastOpen - (rows.length - 1 - k) * stepMs).toISOString(), open, high, low, close, volume: 1 }));
}

test('localPredict: four parts, no trade when no side clears the margin, news never moves anything', () => {
  const now = Date.UTC(2026, 9, 7, 14, 2);
  const m30 = liveBars(now);
  const candles = [...m30.slice(-400), { ...m30.at(-1), time: new Date(Date.parse(m30.at(-1).time) + 1800000).toISOString(), partial: true }];
  const base = localPredict({ instrument: 'WTICO/USD', granularity: 'M30', candles, m30 }, { now });
  assert.equal(base.candleTime, m30.at(-1).time, 'the newest closed candle, not the forming one');
  assert.equal(base.forming, false);
  assert.equal(base.action, 'no_trade');
  assert.equal(base.probabilities.long, DIRECTION_ESTIMATE['WTICO/USD'].up);
  assert.ok(base.probabilities.no_trade > 0.9);
  const b = base.detail.bigDay;
  assert.equal(b.available, true);
  assert.ok(b.reached || (b.p > 0 && b.p < 1));
  assert.match(b.text, /5\.4%/);
  assert.match(base.detail.trend.text, /^supertrend (up|down), H1 (agrees|disagrees)$/);
  assert.deepEqual(base.detail.reasons, []);
  assert.match(base.state.direction, /no measurable direction edge/);
  // a wide spread switches to no trade with a reason; escalated news is shown and stored but changes nothing
  const hit = { id: 7, title: 'Tanker hit near Hormuz', escalation: 'escalation', relevant: true, publishedAt: new Date(now - 60000).toISOString() };
  const news = { latest: hit, relevant: hit };
  const ba = new Map([[Date.parse(m30.at(-1).time), { bid: 100, ask: 101 }]]);
  const r = localPredict({ instrument: 'WTICO/USD', granularity: 'M30', candles, m30, news, bidAsk: ba }, { now });
  assert.deepEqual(r.detail.reasons.map((x) => x.code), ['spread']);
  assert.equal(r.probabilities.no_trade, 1);
  assert.deepEqual([r.probabilities.long, r.probabilities.short, r.detail.bigDay.p], [base.probabilities.long, base.probabilities.short, b.p]);
  assert.equal(r.detail.news.latest.id, 7);
  const n = localPredict({ instrument: 'WTICO/USD', granularity: 'M30', candles, m30, news }, { now });
  assert.deepEqual([n.action, n.detail.reasons, n.probabilities], [base.action, [], base.probabilities]);
  assert.match(n.state.news, /not used for direction or reasons/);
});

test('localPredict: a session past T1 reads as reached, not as a probability', () => {
  const now = Date.UTC(2026, 9, 7, 14, 2);
  const m30 = liveBars(now);
  const last = m30.at(-1);
  m30[m30.length - 1] = { ...last, high: last.open * 1.2 };
  const r = localPredict({ instrument: 'WTICO/USD', granularity: 'M30', candles: m30.slice(-400), m30 }, { now });
  assert.deepEqual([r.detail.bigDay.reached, r.detail.bigDay.p], [true, 1]);
  assert.match(r.detail.bigDay.text, /already a big day/);
});

test('localPredict: no artifact or stale 30-min data makes big day unavailable, not an error', () => {
  const now = Date.UTC(2026, 9, 7, 14, 2);
  const m30 = liveBars(now);
  const other = localPredict({ instrument: 'BCO/USD', granularity: 'M30', candles: m30.slice(-200), m30 }, { now });
  assert.equal(other.detail.bigDay.available, false);
  assert.equal(other.probabilities.long, 0.5);
  assert.equal(other.action, 'no_trade');
  const stale = localPredict({ instrument: 'WTICO/USD', granularity: 'M30', candles: m30.slice(-200), m30: m30.slice(0, -10) }, { now });
  assert.equal(stale.detail.bigDay.text, 'no current 30-minute data');
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
  const now = Date.now();
  const m5 = liveBars(now, 300000).slice(-400);
  storeCandles(dbPath, 'WTICO/USD', 'M5', m5);
  storeCandles(dbPath, 'WTICO/USD', 'M30', liveBars(now));
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
    assert.equal(p.detail.bigDay.available, true);
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
    assert.equal(list[0].detail.bigDay.thresholdPct, bigDayModel('WTICO/USD').T1_pct);
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
