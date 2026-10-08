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
  bigDayFeatures, bigDayModel, score, noTradeReasons, localPredict, headline, newsInput, newsRelevant, A1_WINDOW_BARS,
} from '../scripts/local-predict.mjs';
import { baWindow, clearBaWindows, fetchBaCandles, ppFeatures, ppModel, ppRow, ppScore, ppSeries } from '../scripts/pprofit.mjs';

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

// ---- P(profit)
const PP = ['WTICO_USD-M5', 'EUR_USD-M5', 'WTICO_USD-M15'].map((n) => ({ gran: n.split('-')[1], ...JSON.parse(readFileSync(new URL(`./fixtures/pprofit-parity-${n}.json`, import.meta.url), 'utf8')) }));
const baBars = (rows, shiftMin = 0) => rows.map(([t, bo, bh, bl, bc, ao, ah, al, ac]) => ({ time: new Date((t + shiftMin) * 60000).toISOString(), bid_o: bo, bid_h: bh, bid_l: bl, bid_c: bc, ask_o: ao, ask_h: ah, ask_l: al, ask_c: ac }));
const midBars = (ba) => ba.map((b) => ({ time: b.time, open: (b.bid_o + b.ask_o) / 2, high: (b.bid_h + b.ask_h) / 2, low: (b.bid_l + b.ask_l) / 2, close: (b.bid_c + b.ask_c) / 2, volume: 1 }));

test('parity: bid/ask bars -> P(profit) features -> calibrated P match the Python research export within 1e-9', () => {
  for (const fx of PP) {
    const model = ppModel(fx.instrument, fx.gran);
    assert.ok(model, `artifact for ${fx.instrument} ${fx.gran}`);
    assert.equal(model.coef.length, 37);
    const S = ppSeries(baBars(fx.bars), fx.gran);
    assert.ok(fx.rows.length >= 80);
    for (const r of fx.rows) {
      const f = ppFeatures(S, r.index);
      assert.ok(f, `${fx.instrument} ${fx.gran} ${r.t} features`);
      ppRow(model, f, r.side).forEach((v, j) => assert.ok(Math.abs(v - r.features[model.features.order[j]]) <= 1e-9, `${fx.instrument} ${r.t} ${model.features.order[j]}`));
      const s = ppScore(model, f, r.side);
      assert.ok(Math.abs(s.raw - r.raw) <= 1e-9 && Math.abs(s.p - r.p) <= 1e-9, `${fx.instrument} ${fx.gran} ${r.t} side ${r.side}: p ${s.p} vs ${r.p}`);
      const lut = model.expected_R[r.side > 0 ? 'long' : 'short'];
      assert.equal(s.expectedR, lut.meanR[lut.p_edges.filter((e) => e <= s.p).length]);
    }
  }
  assert.equal(ppModel('XAG/USD', 'M5'), null, 'calibration failed: not exported');
  assert.equal(ppModel('WTICO/USD', 'H1'), null);
});

test('headline: strict rule, Neutral unless a side clears +0.05 R with its interval above 0, reasons first', () => {
  const side = (expectedR, ci = null) => ({ p: 0.3, expectedR, ci });
  const pp = (l, s) => ({ available: true, long: l, short: s });
  assert.deepEqual(headline(pp(side(-0.09), side(-0.1)), []), { label: 'Neutral', action: 'no_trade', reason: 'no side clears costs' });
  assert.equal(headline(pp(side(0.2), side(-0.1)), []).label, 'Neutral', 'no interval in the artifact: cannot clear');
  assert.equal(headline(pp(side(0.2, [-0.01, 0.4]), side(-0.1)), []).label, 'Neutral', 'interval touches 0');
  assert.equal(headline(pp(side(0.04, [0.01, 0.07]), side(-0.1)), []).label, 'Neutral', 'below +0.05 R');
  assert.deepEqual(headline(pp(side(0.06, [0.01, 0.1]), side(-0.1)), []), { label: 'Long', action: 'long', reason: null });
  assert.equal(headline(pp(side(0.06, [0.01, 0.1]), side(0.09, [0.02, 0.15])), []).label, 'Short', 'the higher expected R wins');
  const thin = [{ code: 'thin_hour', text: 'Thin trading hour (04:00 UTC)' }];
  assert.deepEqual(headline(pp(side(0.06, [0.01, 0.1]), side(-0.1)), thin), { label: 'Neutral', action: 'no_trade', reason: 'Thin trading hour (04:00 UTC)' }, 'a measured reason comes first');
  assert.equal(headline({ available: false, text: 'no calibrated estimate' }, []).reason, 'no calibrated estimate');
});

test('localPredict: P(profit) per side from the closed bid/ask bar, Neutral headline, news never moves anything', () => {
  const fx = PP[0];
  const ba = baBars(fx.bars);
  const lastMs = Date.parse(ba.at(-1).time);
  const now = lastMs + 300000 + 1000;
  const m30 = liveBars(now);
  const candles = midBars(ba).slice(-400);
  const base = localPredict({ instrument: 'WTICO/USD', granularity: 'M5', candles, m30, ba }, { now });
  assert.equal(base.candleTime, ba.at(-1).time);
  const pp = base.detail.pprofit;
  assert.equal(pp.available, true);
  const want = ppScore(ppModel('WTICO/USD', 'M5'), ppFeatures(ppSeries(ba, 'M5'), ba.length - 1), 1);
  assert.equal(pp.long.p, want.p);
  assert.deepEqual([base.probabilities.long, base.probabilities.short], [pp.long.p, pp.short.p]);
  assert.ok(pp.long.expectedR < 0.05 && pp.short.expectedR < 0.05);
  assert.deepEqual([base.action, base.detail.headline], ['no_trade', 'Neutral']);
  assert.match(base.state.long_now, /^\d+% chance of profit \(avg [-+]\d\.\d\d R\)$/);
  assert.equal(base.detail.bigDay.available, true);
  assert.match(base.detail.trend.text, /^supertrend (up|down), H1 (agrees|disagrees|not enough history)$/);
  // escalated relevant news is shown and stored but changes nothing
  const hit = { id: 7, title: 'Tanker hit near Hormuz', escalation: 'escalation', relevant: true, publishedAt: new Date(now - 60000).toISOString() };
  const n = localPredict({ instrument: 'WTICO/USD', granularity: 'M5', candles, m30, ba, news: { latest: hit, relevant: hit } }, { now });
  assert.deepEqual([n.action, n.detail.reasons, n.probabilities, n.detail.headlineReason], [base.action, base.detail.reasons, base.probabilities, base.detail.headlineReason]);
  assert.equal(n.detail.news.latest.id, 7);
  assert.match(n.state.news, /not used for direction or reasons/);
  // a wide spread on the closed bar names the reason
  const wide = [...ba.slice(0, -1), { ...ba.at(-1), ask_c: ba.at(-1).bid_c + 5 }];
  const w = localPredict({ instrument: 'WTICO/USD', granularity: 'M5', candles, m30, ba: wide }, { now });
  assert.equal(w.detail.headlineReason, w.detail.reasons[0].text);
  assert.match(w.detail.headlineReason, /^Spread wide/);
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

test('localPredict: no artifact means no calibrated estimate and no big day, not an error', () => {
  const now = Date.UTC(2026, 9, 7, 14, 2);
  const m30 = liveBars(now);
  const other = localPredict({ instrument: 'BCO/USD', granularity: 'M30', candles: m30.slice(-200), m30 }, { now });
  assert.equal(other.detail.bigDay.available, false);
  assert.deepEqual([other.detail.pprofit.available, other.detail.pprofit.text], [false, 'no calibrated estimate']);
  assert.deepEqual([other.probabilities.long, other.probabilities.short], [null, null]);
  assert.deepEqual([other.action, other.detail.headline, other.detail.headlineReason], ['no_trade', 'Neutral', 'no calibrated estimate']);
  const noBa = localPredict({ instrument: 'WTICO/USD', granularity: 'M5', candles: m30.slice(-200), m30 }, { now });
  assert.equal(noBa.detail.pprofit.text, 'no current bid/ask data');
  const stale = localPredict({ instrument: 'WTICO/USD', granularity: 'M30', candles: m30.slice(-200), m30: m30.slice(0, -10) }, { now });
  assert.equal(stale.detail.bigDay.text, 'no current 30-minute data');
});

test('baWindow: one full bid/ask fetch, then only the newest bars', async () => {
  clearBaWindows();
  const ba = baBars(PP[0].bars).slice(-100);
  const feed = (rows) => ({ candles: rows.map((b) => ({ complete: true, time: b.time, bid: { o: b.bid_o, h: b.bid_h, l: b.bid_l, c: b.bid_c }, ask: { o: b.ask_o, h: b.ask_h, l: b.ask_l, c: b.ask_c } })) });
  const asked = [];
  let upto = 98;
  const fetchFn = async (u) => { const n = Number(new URL(String(u)).searchParams.get('count')); asked.push(n); return { ok: true, json: async () => feed(ba.slice(0, upto).slice(-n)) }; };
  assert.equal((await baWindow('WTICO/USD', 'M5', 50, { fetchFn })).length, 50);
  upto = 100;
  const w = await baWindow('WTICO/USD', 'M5', 50, { fetchFn });
  assert.deepEqual([w.length, w.at(-1).time, asked], [50, ba.at(-1).time, [50, 10]]);
  await assert.rejects(fetchBaCandles('X', 'M5', 3, { fetchFn: async () => ({ ok: false, status: 500 }) }), /HTTP 500/);
  clearBaWindows();
});

// ---- engine routes with the local provider
async function withLocalServer(settings, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'local-pred-'));
  const dbPath = join(dir, 'db.sqlite');
  const settingsPath = join(dir, 'settings.json');
  const now = Date.now();
  // the WTI M5 bid/ask fixture, shifted so its newest bar is the one that just closed
  const rows = PP[0].bars;
  const ba = baBars(rows, (Math.floor(now / 300000) - 1) * 5 - rows.at(-1)[0]);
  const m5 = midBars(ba).slice(-400);
  storeCandles(dbPath, 'WTICO/USD', 'M5', m5);
  storeCandles(dbPath, 'WTICO/USD', 'M30', liveBars(now));
  writeFileSync(settingsPath, JSON.stringify(settings));
  clearBaWindows();
  const calls = [];
  const providerFetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('price=BA')) {
      const n = Number(new URL(String(url)).searchParams.get('count'));
      return { ok: true, json: async () => ({ candles: ba.slice(-n).map((b) => ({ complete: true, time: b.time, bid: { o: b.bid_o, h: b.bid_h, l: b.bid_l, c: b.bid_c }, ask: { o: b.ask_o, h: b.ask_h, l: b.ask_l, c: b.ask_c } })) }) };
    }
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
    assert.deepEqual([p.detail.pprofit.available, p.detail.headline, p.detail.headlineReason === null], [true, 'Neutral', false]);
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
