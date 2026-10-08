import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { storeCandles } from '../scripts/supertrend.mjs';
import { listPredictions, predictionSeries, SERIES_MAX } from '../scripts/predictions.mjs';
import { buildServer, refreshLocalPredictions } from '../scripts/signal-server.mjs';
import {
  bigDayFeatures, bigDayModel, score, noTradeReasons, localPredict, localSeries, cutoffMs, shieldState, shieldText, conditionsText, nowMotion, volumeRatio, SHIELD_LABEL, SHARED_NOTE, SIDE_DIFF_CALIBRATED, leanFor, leanText, headline, newsInput, newsRelevant, A1_WINDOW_BARS,
} from '../scripts/local-predict.mjs';
import { baWindow, calibrate, clearBaWindows, fetchBaCandles, PP_HORIZONS, PP_TARGETS, ppAvailable, ppFeatures, ppModel, ppRow, ppScore, ppSeries } from '../scripts/pprofit.mjs';

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
// one parity export per timeframe and target; the cell is named in the fixture's artifact field
const PP = ['WTICO_USD-M5-H12-up', 'EUR_USD-M5-H48-plan', 'WTICO_USD-M15-H48-plan', 'WTICO_USD-M1-H12-up'].map((n) => {
  const fx = JSON.parse(readFileSync(new URL(`./fixtures/pprofit-parity-${n}.json`, import.meta.url), 'utf8'));
  const [, gran, h, target] = fx.artifact.match(/_(M\d+)_H(\d+)_(up|plan)_pprofit20/);
  return { ...fx, gran, horizon: Number(h), target };
});
const baBars = (rows, shiftMin = 0) => rows.map(([t, bo, bh, bl, bc, ao, ah, al, ac]) => ({ time: new Date((t + shiftMin) * 60000).toISOString(), bid_o: bo, bid_h: bh, bid_l: bl, bid_c: bc, ask_o: ao, ask_h: ah, ask_l: al, ask_c: ac }));
const midBars = (ba) => ba.map((b) => ({ time: b.time, open: (b.bid_o + b.ask_o) / 2, high: (b.bid_h + b.ask_h) / 2, low: (b.bid_l + b.ask_l) / 2, close: (b.bid_c + b.ask_c) / 2, volume: 1 }));

test('parity: bid/ask bars -> P(profit) features -> calibrated P match the Python research export within 1e-9', () => {
  for (const fx of PP) {
    const cell = `${fx.instrument} ${fx.gran} H${fx.horizon} ${fx.target}`;
    const model = ppModel(fx.instrument, fx.gran, fx.horizon, fx.target);
    assert.ok(model, `artifact for ${cell}`);
    assert.deepEqual([model.coef.length, model.horizon_bars, model.target], [37, fx.horizon, fx.target]);
    assert.equal(model.calibrator.type ?? model.calibrator.kind, fx.gran === 'M1' ? 'isotonic' : 'platt');
    const S = ppSeries(baBars(fx.bars), fx.gran);
    assert.ok(fx.rows.length >= 40);
    for (const r of fx.rows) {
      const f = ppFeatures(S, r.index);
      assert.ok(f, `${cell} ${r.t} features`);
      ppRow(model, f, r.side).forEach((v, j) => assert.ok(Math.abs(v - r.features[model.features.order[j]]) <= 1e-9, `${cell} ${r.t} ${model.features.order[j]}`));
      const sc = ppScore(model, f, r.side);
      assert.ok(Math.abs(sc.raw - r.raw) <= 1e-9 && Math.abs(sc.p - r.p) <= 1e-9, `${cell} ${r.t} side ${r.side}: p ${sc.p} vs ${r.p}`);
      const lut = model.expected_R[r.side > 0 ? 'long' : 'short'];
      assert.equal(sc.expectedR, lut.meanR[lut.p_edges.filter((e) => e <= sc.p).length] ?? null);
    }
  }
});

test('cells: only shipped horizon x target cells resolve; ppAvailable per pair', () => {
  assert.ok(ppModel('WTICO/USD', 'M5', 12, 'up'));
  assert.equal(ppModel('XAG/USD', 'M5', 48, 'plan'), null, 'calibration failed: not shipped');
  assert.equal(ppModel('NATGAS/USD', 'M1', 48, 'plan'), null);
  assert.equal(ppModel('WTICO/USD', 'M5', 72, 'plan'), null, 'only 12 and 48 bars');
  assert.equal(ppModel('WTICO/USD', 'M5', 12, 'down'), null);
  assert.equal(ppModel('WTICO/USD', 'H1', 12, 'up'), null);
  assert.deepEqual([ppAvailable('WTICO/USD', 'M15'), ppAvailable('NATGAS/USD', 'M15'), ppAvailable('BCO/USD', 'M5')], [true, false, false]);
});

test('isotonic calibration: linear between knots, clipped outside (numpy.interp)', () => {
  const cal = { type: 'isotonic', x: [-1, 0, 2], y: [0, 0.2, 0.6], out_of_bounds: 'clip' };
  assert.deepEqual([-5, -1, -0.5, 0, 1, 2, 9].map((v) => calibrate(cal, v)), [0, 0, 0.1, 0.2, 0.4, 0.6, 0.6]);
  assert.equal(calibrate({ a: 1, b: 0 }, 0), 0.5, 'Platt stays the default');
});

test('expected R: bisect-right decile, an empty decile has no R and never clears', () => {
  const model = ppModel('XAG/USD', 'M1', 12, 'plan');
  const lut = model.expected_R.long;
  // P = 0 counts every edge equal to 0 (bisect right)
  const zeros = lut.p_edges.filter((e) => e <= 0).length;
  const s = ppScore({ ...model, calibrator: { type: 'isotonic', x: [0, 1], y: [0, 0] } }, { f: Object.fromEntries(model.features.order.map((k) => [k, 0])), slot: 0 }, 1);
  assert.deepEqual([s.p, s.decile, s.expectedR], [0, zeros + 1, lut.meanR[zeros] ?? null]);
  const nullSide = { p: 0, expectedR: null, ci: null };
  assert.equal(headline({ available: true, long: nullSide, short: nullSide }, []).reason, 'no side clears costs');
});

test('headline with the shipped artifacts: every decile of every cell, both sides, reads Neutral (no side clears costs)', () => {
  let n = 0;
  for (const inst of ['WTICO/USD', 'XAU/USD', 'XAG/USD', 'NATGAS/USD', 'SPX500/USD', 'EUR/USD']) for (const gran of ['M1', 'M5', 'M15']) for (const h of PP_HORIZONS) for (const t of PP_TARGETS) {
    const m = ppModel(inst, gran, h, t);
    if (!m) continue;
    n++;
    const lut = m.expected_R;
    for (const s of ['long', 'short']) assert.equal(lut[s].meanR_ci.length, 10, `${inst} ${gran} H${h} ${t} ${s} has a CI slot per decile`);
    for (let d = 0; d < 10; d++) {
      const side = (s) => ({ p: 0.2, expectedR: lut[s].meanR[d] ?? null, ci: lut[s].meanR_ci[d] ?? null });
      assert.deepEqual(headline({ available: true, long: side('long'), short: side('short') }, []), { label: 'Neutral', action: 'no_trade', reason: 'no side clears costs' }, `${inst} ${gran} H${h} ${t} decile ${d + 1}`);
    }
  }
  assert.equal(n, 32, 'shipped cells');
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
  const feat = ppFeatures(ppSeries(ba, 'M5'), ba.length - 1);
  // WTI M5 ships H12 up, H12 plan and H48 plan; the first is the default
  assert.deepEqual(pp.cells.map((c) => c.key), ['H12_up', 'H12_plan', 'H48_plan']);
  for (const c of pp.cells) {
    assert.equal(c.long.p, ppScore(ppModel('WTICO/USD', 'M5', c.horizon, c.target), feat, 1).p, c.key);
    assert.deepEqual([c.headline, c.headlineAction], ['Neutral', 'no_trade'], c.key);
  }
  assert.deepEqual([pp.key, pp.long, pp.short, base.horizonBars], ['H12_up', pp.cells[0].long, pp.cells[0].short, 12]);
  assert.deepEqual(base.detail.shield, pp.cells[0].shield, 'the run stores the per-side state of the default cell');
  assert.deepEqual([base.detail.shield.long.decile, base.detail.shield.short.decile], [pp.long.decile, pp.short.decile]);
  assert.equal(base.state.state_both_sides, `${shieldText(base.detail.shield.both)} (${SHARED_NOTE})`, 'WTI: one shared state');
  assert.equal(base.state.long_state, undefined);
  assert.deepEqual(base.detail.lean, pp.cells[0].lean, 'the run stores the lean of the default cell');
  assert.ok(pp.cells.every((c) => c.lean === null || (typeof c.lean.gapPp === 'number' && typeof c.lean.greyed === 'boolean' && ['long', 'short'].includes(c.lean.side))));
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

// ---- shield states
test('shieldState, EUR/USD (side difference calibrated): per side red/orange/grey, no green, a reason makes both red', () => {
  const cell = (dl, ds, rl = -0.1, rs = -0.2) => ({ long: { p: 0.3, decile: dl, expectedR: rl }, short: { p: 0.2, decile: ds, expectedR: rs } });
  const st = (c, reasons = []) => shieldState({ instrument: 'EUR/USD', granularity: 'M5', cell: c, reasons });
  // decile boundaries, same for both sides; no green at any decile
  const want = [null, 'red', 'orange', 'orange', 'grey', 'grey', 'grey', 'grey', 'grey', 'grey', 'grey'];
  for (let d = 1; d <= 10; d++) {
    const x = st(cell(d, d));
    assert.deepEqual([x.shared, x.long.state, x.short.state, x.long.decile, x.both], [false, want[d], want[d], d, undefined], `decile ${d}`);
  }
  assert.deepEqual(Object.keys(SHIELD_LABEL).sort(), ['grey', 'orange', 'red']);
  assert.equal(SHIELD_LABEL.grey, 'No warning');
  // sides differ; the headline carries no avg R and no "top X%" text, Details does
  const mixed = st(cell(10, 1, -0.02, -0.91));
  assert.equal(shieldText(mixed.long), 'No warning');
  assert.equal(conditionsText(mixed.long), 'decile 10 of 10, top 10% of conditions for EUR/USD M5 · avg −0.02 R');
  assert.equal(shieldText(mixed.short), "Don't trade now · bottom 10% of conditions for EUR/USD M5");
  assert.equal(conditionsText(mixed.short), 'decile 1 of 10, bottom 10% of conditions for EUR/USD M5 · avg −0.91 R');
  assert.equal(shieldText(st(cell(3, 3)).long), 'Costly now · bottom 30% of conditions for EUR/USD M5');
  assert.equal(conditionsText(st(cell(5, 5, null)).long), 'decile 5 of 10, usual conditions for EUR/USD M5 · avg R n/a');
  // a measured reason comes first and applies to both sides, even at decile 10
  const spread = noTradeReasons({ instrument: 'EUR/USD', spreadR: 0.27, closeMs: Date.UTC(2026, 9, 7, 12) });
  const r = st(cell(10, 10), spread);
  assert.deepEqual([r.long.state, r.short.state, r.reason], ['red', 'red', { code: 'spread', why: 'spread wide (0.27 of stop)' }]);
  assert.equal(shieldText(r.short), "Don't trade now · spread wide (0.27 of stop)");
  // no calibrated estimate: reasons only
  const none = st(null);
  assert.deepEqual([none.long.state, none.short.state, shieldText(none.long), conditionsText(none.long)], ['grey', 'grey', 'No warning · no calibrated estimate', 'no calibrated estimate · avg R n/a']);
  const thin = noTradeReasons({ instrument: 'EUR/USD', spreadR: null, closeMs: Date.UTC(2026, 9, 7, 4) });
  assert.deepEqual([st(null, thin).long.state, st(null, thin).short.state, st(null, thin).long.why], ['red', 'red', 'thin trading hour (04:00 UTC)']);
});

test('shieldState, WTI (side difference not meaningful): one shared state from floor(mean decile) and the mean avg R, no green', () => {
  const cell = (dl, ds, rl = -0.1, rs = -0.2) => ({ long: { p: 0.47, decile: dl, expectedR: rl }, short: { p: 0.45, decile: ds, expectedR: rs } });
  const st = (c, reasons = []) => shieldState({ instrument: 'WTICO/USD', granularity: 'M5', cell: c, reasons });
  const x = st(cell(8, 9, -0.13, -0.15));
  assert.equal(x.shared, true);
  assert.deepEqual([x.both.state, x.both.decile, shieldText(x.both)], ['grey', 8, 'No warning']);
  assert.ok(Math.abs(x.both.avgR - -0.14) < 1e-12);
  assert.equal(conditionsText(x.both), 'decile 8 of 10, usual conditions for WTI M5 · avg −0.14 R');
  // the operator's 15:15 case: top deciles on both sides read No warning, never green
  assert.deepEqual([st(cell(10, 9)).both.state, shieldText(st(cell(10, 9)).both)], ['grey', 'No warning']);
  for (let dl = 1; dl <= 10; dl++) for (let ds = 1; ds <= 10; ds++) assert.notEqual(st(cell(dl, ds)).both.state, 'green');
  assert.deepEqual([st(cell(1, 4)).both.state, st(cell(1, 4)).both.decile], ['orange', 2]);
  assert.deepEqual([st(cell(3, 4)).both.state, st(cell(4, 4)).both.state], ['orange', 'grey']);
  assert.deepEqual([st(cell(1, 2)).both.state, st(cell(1, 2)).both.decile], ['red', 1]);
  assert.equal(st(cell(5, 6, null)).both.avgR, null);
  const spread = noTradeReasons({ instrument: 'WTICO/USD', spreadR: 0.27, closeMs: Date.UTC(2026, 9, 7, 12) });
  assert.deepEqual([st(cell(10, 10), spread).both.state, st(cell(10, 10), spread).both.why], ['red', 'spread wide (0.27 of stop)']);
  assert.deepEqual([st(null).shared, st(null).both.state, st(null).both.label], [true, 'grey', 'No warning · no calibrated estimate']);
  assert.ok(SIDE_DIFF_CALIBRATED.has('SPX500/USD') && !SIDE_DIFF_CALIBRATED.has('XAU/USD'));
  assert.equal(SHARED_NOTE, 'applies to both sides; direction not measurable for this instrument');
});

test('nowMotion: run length, pace in ATR, direction, volume against the slot or the recent median', () => {
  const t0 = Date.UTC(2026, 9, 8, 0, 0);
  // flat filler with alternating bars, then a falling run; volume 100 everywhere except the last bar
  const mk = (n, f) => Array.from({ length: n }, (_, i) => ({ time: new Date(t0 + i * 300000).toISOString(), ...f(i) }));
  const base = mk(300, (i) => (i % 2 ? { open: 100, close: 100.01, volume: 100 } : { open: 100.01, close: 100, volume: 100 }));
  const fall = (step, n, vol) => {
    const bars = base.map((b) => ({ ...b }));
    bars[bars.length - n - 1] = { ...bars[bars.length - n - 1], open: 99.99, close: 100 }; // a rising bar ends the run
    let p = 100;
    for (let j = 0; j < n; j++) { const k = bars.length - n + j; bars[k] = { ...bars[k], open: p, close: p - step, volume: j === n - 1 ? vol : 100 }; p -= step; }
    return bars;
  };
  const atr = 1;
  // fast: 8 falling bars of 0.5 -> the run is capped at 6 bars, move -3.0 ATR
  let b = fall(0.5, 8, 250);
  let m = nowMotion(b, b.length - 1, atr);
  assert.deepEqual([m.bars, m.pace, m.direction, m.continuationRate], [6, 'fast', 'falling', null]);
  assert.ok(Math.abs(m.moveAtr - -3) < 1e-9);
  assert.equal(m.text, 'Now: falling fast · −3.0 ATR in 6 bars · volume 2.5× normal');
  assert.equal(m.volumeBase, 'prior 288 bars', 'one day of M5 bars: no slot history, recent median');
  // steady: 3 bars of 0.3 -> -0.9 ATR
  b = fall(0.3, 3, 100);
  m = nowMotion(b, b.length - 1, atr);
  assert.equal(m.text, 'Now: falling steady · −0.9 ATR in 3 bars · volume 1.0× normal');
  // flat: 2 bars of 0.1 -> no direction word
  b = fall(0.1, 2, 100);
  m = nowMotion(b, b.length - 1, atr);
  assert.deepEqual([m.pace, m.direction, m.text], ['flat', null, 'Now: flat · −0.2 ATR in 2 bars · volume 1.0× normal']);
  // volume omitted: no volume on the last bar, or too little history
  b = fall(0.5, 4, 0);
  assert.equal(nowMotion(b, b.length - 1, atr).text, 'Now: falling fast · −2.0 ATR in 4 bars');
  const short = fall(0.5, 4, 300).slice(-10);
  assert.equal(nowMotion(short, short.length - 1, atr).volumeRatio, null);
  // the same time-of-day slot over 20 days wins when there are at least 10 such bars
  const days = Array.from({ length: 12 }, (_, d) => ({ time: new Date(t0 + d * 86400000).toISOString(), open: 1, close: 1.1, volume: d < 11 ? 50 : 150 }));
  assert.deepEqual(volumeRatio(days, 11), { ratio: 3, base: 'time-of-day slot, 20 days' });
  // no ATR: no Now line
  assert.equal(nowMotion(b, b.length - 1, null), null);
});

test('leanFor: gap 0 hides, a small gap or a cell without a grey rule greys, the label is the A1 one', () => {
  const rec = JSON.parse(readFileSync(new URL('../config/prediction-models/lean_track_record.json', import.meta.url), 'utf8')).cells;
  const cell = (horizon, target, pl, ps) => ({ horizon, target, long: { p: pl }, short: { p: ps } });
  const lean = (inst, gran, c) => leanFor({ instrument: inst, granularity: gran, cell: c });
  // WTI M5 H12 up: the cell greys below 5 pp
  assert.equal(lean('WTICO/USD', 'M5', cell(12, 'up', 0.45, 0.45)), null, 'gap 0: no lean');
  const small = lean('WTICO/USD', 'M5', cell(12, 'up', 0.47, 0.45));
  assert.deepEqual([small.side, small.greyed, Math.round(small.gapPp)], ['long', true, 2]);
  assert.equal(small.label, rec.WTICO_USD_M5_H12_up.amendment_A1.label);
  assert.notEqual(small.label, rec.WTICO_USD_M5_H12_up.label, 'not the registered label');
  assert.equal(leanText(small), `Lean: LONG (47% vs 45%) · ${rec.WTICO_USD_M5_H12_up.amendment_A1.label}`);
  assert.equal(lean('WTICO/USD', 'M5', cell(12, 'up', 0.42, 0.46)).greyed, true, '4 pp is still below this cell\'s 5 pp');
  assert.deepEqual([lean('WTICO/USD', 'M5', cell(12, 'up', 0.40, 0.46)).side, lean('WTICO/USD', 'M5', cell(12, 'up', 0.40, 0.46)).greyed], ['short', false]);
  // EUR/USD M5 H12 up greys below 1 pp in research; the card still greys below 3 pp
  assert.equal(lean('EUR/USD', 'M5', cell(12, 'up', 0.48, 0.46)).greyed, true);
  assert.equal(lean('EUR/USD', 'M5', cell(12, 'up', 0.50, 0.46)).greyed, false);
  // no grey rule for the cell: always greyed
  assert.equal(rec.WTICO_USD_M5_H48_plan.amendment_A1.grey_below_gap_pp, null);
  assert.equal(lean('WTICO/USD', 'M5', cell(48, 'plan', 0.30, 0.10)).greyed, true);
  // a cell missing from the track record: no lean
  assert.equal(lean('BCO/USD', 'M5', cell(12, 'up', 0.5, 0.4)), null);
});

// ---- per-candle series for the chart tooltip
test('localSeries: one pass over the window gives each candle what localPredict gave when it closed', () => {
  const ba = baBars(PP[0].bars);
  const candles = midBars(ba).slice(-400);
  for (const k of [150, 399]) {
    const t = candles[k].time;
    const i = ba.findIndex((b) => b.time === t);
    const [e] = localSeries({ instrument: 'WTICO/USD', granularity: 'M5', candles, ba }, [t]);
    const p = localPredict({ instrument: 'WTICO/USD', granularity: 'M5', candles: candles.slice(0, k + 1), ba: ba.slice(0, i + 1) }, { now: Date.parse(t) + 301000 });
    assert.equal(e.spreadR, p.detail.spreadR, `spread at ${t}`);
    assert.deepEqual(e.now, p.detail.now, `Now line at ${t}`);
    assert.deepEqual(e.reasons, p.detail.reasons);
    assert.deepEqual(e.pprofit.cells.map((c) => [c.key, c.long.p, c.short.p, c.long.expectedR, c.headline, c.headlineReason]),
      p.detail.pprofit.cells.map((c) => [c.key, c.long.p, c.short.p, c.long.expectedR, c.headline, c.headlineReason]), `cells at ${t}`);
  }
  const [none] = localSeries({ instrument: 'WTICO/USD', granularity: 'M5', candles, ba: [] }, [candles[10].time]);
  assert.deepEqual([none.pprofit.text, none.spreadR, none.hasBidAsk], ['no bid/ask data for this candle', null, false]);
});

test('predictionSeries: forming and unclosed candles are never scored, results are cached, in-sample is flagged', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'pred-series-')), 'db.sqlite');
  const ba = baBars(PP[0].bars);
  const closed = midBars(ba).slice(-60);
  const lastMs = Date.parse(closed.at(-1).time);
  const now = lastMs + 300000 + 1000;
  // a forming bar after the last closed one, and a bar marked complete that has not closed yet
  const candles = [...closed, { ...closed.at(-1), time: new Date(lastMs + 300000).toISOString(), complete: false }];
  let baReads = 0;
  const input = { instrument: 'WTICO/USD', granularity: 'M5', loadCandles: async () => candles, loadBa: async () => { baReads++; return ba; } };
  const first = await predictionSeries(dbPath, input, now);
  assert.equal(first.entries.length, 60);
  assert.equal(first.entries.at(-1).candleTime, closed.at(-1).time, 'the forming candle is excluded');
  assert.ok(first.entries.every((e) => e.source === 'computed' && e.computedAt === new Date(now).toISOString()));
  assert.equal(baReads, 1);
  const e = first.entries.at(-1);
  assert.deepEqual(e.cells.map((c) => c.key), ['H12_up', 'H12_plan', 'H48_plan']);
  assert.ok(e.cells.every((c) => c.headline === 'Neutral' && c.pLong > 0 && c.pShort > 0 && typeof c.spreadR === 'undefined'));
  assert.ok(typeof e.spreadR === 'number');
  // the fixture bars are from before the artifact's training cutoff
  const cutoff = cutoffMs(ppModel('WTICO/USD', 'M5', 12, 'up'));
  assert.ok(lastMs < cutoff);
  assert.ok(e.cells.every((c) => c.inSample === true));
  const STATES = ['red', 'orange', 'grey', 'green'];
  assert.ok(e.cells.every((c) => STATES.includes(c.shield.long.state) && STATES.includes(c.shield.short.state) && c.shield.long.decile === c.decileLong));
  assert.ok(STATES.includes(e.shield.long.state), 'a reasons-only state for every entry');
  // a second read is served from the cache: no bid/ask read, same computed_at
  const again = await predictionSeries(dbPath, input, now + 60000);
  assert.equal(baReads, 1);
  assert.deepEqual(again.entries, first.entries);
  // a window: from/to in ms, and the cap
  const part = await predictionSeries(dbPath, { ...input, from: Date.parse(closed[50].time), to: Date.parse(closed[54].time) }, now);
  assert.deepEqual(part.entries.map((x) => x.candleTime), closed.slice(50, 55).map((c) => c.time));
  // the newest closed candle is not scored before it closes
  const early = await predictionSeries(dbPath, input, lastMs + 299000);
  assert.equal(early.entries.at(-1).candleTime, closed.at(-2).time);
  assert.equal(SERIES_MAX, 500);
});

test('GET /api/predictions/series: stored live run for its candle, computed and cached for the rest, off when predictions are off', async () => {
  await withLocalServer({ predictionEnabled: '1' }, async ({ base, calls, m5 }) => {
    const series = (q = '') => fetch(`${base}/api/predictions/series?instrument=WTICO/USD&granularity=M5${q}`);
    const live = (await (await post(base, { instrument: 'WTICO/USD', granularity: 'M5', reuse: true })).json()).prediction;
    const r = await series();
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual([body.max, body.capped, body.entries.length], [500, false, m5.length]);
    const last = body.entries.at(-1);
    assert.deepEqual([last.candleTime, last.source, last.computedAt], [live.candleTime, 'live', live.askedAt]);
    assert.equal(last.cells[0].pLong, live.detail.pprofit.cells[0].long.p);
    assert.ok(last.cells.every((c) => c.inSample === false), 'the shifted fixture is after the training cutoff');
    assert.deepEqual(last.cells[0].shield, live.detail.pprofit.cells[0].shield, 'the series returns the stored per-side state');
    assert.ok(body.entries.slice(0, -1).every((e) => e.source === 'computed'));
    const baCalls = calls.filter((u) => u.includes('price=BA')).length;
    const again = await (await series()).json();
    assert.deepEqual(again.entries, body.entries, 'cached');
    assert.equal(calls.filter((u) => u.includes('price=BA')).length, baCalls, 'no bid/ask fetch for a cached window');
    assert.equal(typesafeCalls(calls), 0);
    const win = await (await series(`&from=${encodeURIComponent(m5[10].time)}&to=${encodeURIComponent(m5[12].time)}`)).json();
    assert.deepEqual(win.entries.map((e) => e.candleTime), m5.slice(10, 13).map((c) => c.time));
    assert.equal((await series('&from=yesterday')).status, 400);
    assert.equal((await fetch(`${base}/api/predictions/series?instrument=WTICO/USD&granularity=M7`)).status, 400);
  });
  await withLocalServer({ predictionEnabled: '0' }, async ({ base }) => {
    assert.equal((await fetch(`${base}/api/predictions/series?instrument=WTICO/USD&granularity=M5`)).status, 409);
  });
});
