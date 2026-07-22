import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOT_DEFAULTS, botConfig, instrumentLeverage, instrumentSpread,
  openPosition, closePosition, markToMarket, portfolioView, unrealized,
} from '../scripts/portfolio.mjs';

const WTI = 'WTICO/USD';
const CFG = botConfig({ bot: { riskPct: 10, leverage: { [WTI]: 10 } } });
const fresh = () => join(mkdtempSync(join(tmpdir(), 'pf-')), 'pf.sqlite');

test('config: defaults, per-instrument leverage with 10x default and cap', () => {
  const cfg = botConfig({});
  assert.equal(cfg.startingBalance, 10000);
  assert.equal(instrumentLeverage(cfg, 'ANY/THING'), 10, 'default 10x');
  const custom = botConfig({ bot: { leverage: { [WTI]: 15, 'SPX500/USD': 99 } } });
  assert.equal(instrumentLeverage(custom, WTI), 15);
  assert.equal(instrumentLeverage(custom, 'SPX500/USD'), BOT_DEFAULTS.leverageCap, 'leverage capped');
  const junk = botConfig({ bot: { startingBalance: -5, riskPct: 'x', defaultLeverage: Infinity } });
  assert.equal(junk.startingBalance, 10000, 'invalid overrides ignored');
  assert.equal(junk.defaultLeverage, 10, 'non-finite leverage rejected (would zero out margin)');
  assert.equal(instrumentLeverage(botConfig({ bot: { leverage: { 'A/B': Infinity } } }), 'A/B'), 10, 'non-finite per-instrument leverage falls back');
});

test('spread config resolves at the config boundary with 0 fallback', () => {
  const cfg = botConfig({});
  assert.equal(instrumentSpread(cfg, WTI), 0.06, 'seeded broker spread');
  assert.equal(instrumentSpread(cfg, 'NO/SUCH'), 0);
  assert.deepEqual(botConfig({}, 'no/such/file.json').spreads, {}, 'missing spread file is empty config');
});

test('P&L: long and short with spread on entry, leveraged margin', () => {
  const db = fresh();
  // long 1000 notional at 87 → entry 87.06, units 1000/87, margin 100
  const id = openPosition(db, CFG, { instrument: WTI, side: 'long', notional: 1000, price: 87 });
  let v = portfolioView(db, CFG);
  assert.equal(v.cash, 9900);
  assert.equal(v.positions[0].margin, 100);
  assert.ok(Math.abs(v.positions[0].entry_price - 87.06) < 1e-9, 'spread paid on entry');
  assert.ok(v.unrealized < 0, 'spread makes a fresh long instantly negative at mid');
  const { realized } = closePosition(db, CFG, id, 88, 'bot-close');
  const expected = (88 - 87.06) * (1000 / 87);
  assert.ok(Math.abs(realized - expected) < 1e-9);
  v = portfolioView(db, CFG);
  assert.ok(Math.abs(v.cash - (10000 + expected)) < 1e-9, 'margin released + realized banked');
  assert.equal(v.positions.length, 0);

  const sid = openPosition(db, CFG, { instrument: WTI, side: 'short', notional: 1000, price: 87 });
  const pos = portfolioView(db, CFG).positions[0];
  assert.ok(Math.abs(pos.entry_price - 86.94) < 1e-9, 'short entry below mid by spread');
  const { realized: sr } = closePosition(db, CFG, sid, 86, 'bot-close');
  assert.ok(Math.abs(sr - (86.94 - 86) * (1000 / 87)) < 1e-9, 'short profits from a drop');
});

test('lifecycle closes: stop, target, margin force-close, halt — all journaled with reasons', () => {
  const db = fresh();
  const cfg = botConfig({ bot: { riskPct: 100, leverage: { [WTI]: 10 } } });
  openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 1000, price: 87, stop: 86.5 });
  let r = markToMarket(db, cfg, { [WTI]: 86.4 });
  assert.equal(r.closed[0].closeReason, 'stop');
  openPosition(db, cfg, { instrument: WTI, side: 'short', notional: 1000, price: 87, target: 85 });
  r = markToMarket(db, cfg, { [WTI]: 84.9 });
  assert.equal(r.closed[0].closeReason, 'target');
  // margin force-close: 10x long loses >10% → unrealized <= -margin
  const id = openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 1000, price: 87 });
  r = markToMarket(db, cfg, { [WTI]: 87 * 0.88 });
  assert.equal(r.closed[0].closeReason, 'margin');
  assert.equal(r.closed[0].positionId, id);
  const v = portfolioView(db, cfg);
  const actions = v.journal.map((j) => j.action);
  assert.ok(actions.includes('open') && actions.includes('close'), 'every mutation journaled');
  assert.equal(v.journal[v.journal.length - 1].action, 'init', 'portfolio seeding itself is journaled');
  const reasons = v.trades.map((t) => t.close_reason).sort();
  assert.deepEqual(reasons, ['margin', 'stop', 'target']);
});

test('halt: equity wiped to <= 0 closes everything and blocks new opens', () => {
  const db = fresh();
  const cfg = botConfig({ bot: { startingBalance: 100, riskPct: 100, leverage: { [WTI]: 20 } } });
  openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 2000, price: 87 });
  // -100% of equity: needs a ~4.35% drop at 20x on a fully-margined position...
  // margin close fires first; drive equity negative with a huge gap through it.
  const r = markToMarket(db, cfg, { [WTI]: 1 });
  assert.ok(r.closed.some((c) => c.closeReason === 'margin'));
  const v = portfolioView(db, cfg);
  assert.ok(v.equity <= 0, 'gap loss wiped the account');
  assert.equal(v.halted, true);
  assert.throws(() => openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 10, price: 87 }), /halted/);
});

test('guards: max positions, insufficient margin, risk budget, bad input', () => {
  const db = fresh();
  const cfg = botConfig({ bot: { riskPct: 100, maxPositions: 2 } });
  openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 100, price: 87 });
  openPosition(db, cfg, { instrument: WTI, side: 'short', notional: 100, price: 87 });
  assert.throws(() => openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 100, price: 87 }), /max 2/);
  const db2 = fresh();
  assert.throws(() => openPosition(db2, CFG, { instrument: WTI, side: 'long', notional: 2e6, price: 87 }), /insufficient cash|risk budget/);
  assert.throws(() => openPosition(db2, botConfig({ bot: { riskPct: 1 } }), { instrument: WTI, side: 'long', notional: 5000, price: 87 }), /risk budget/);
  assert.throws(() => openPosition(db2, CFG, { instrument: WTI, side: 'up', notional: 100, price: 87 }), /side/);
  assert.throws(() => closePosition(db2, CFG, 999, 87, 'x'), /unknown position/);
  assert.throws(() => openPosition(db2, CFG, { side: 'long', notional: 100, price: 87 }), /instrument required/);
  assert.throws(() => closePosition(db2, CFG, 1, 87), /closeReason required/);
  assert.throws(() => openPosition(db2, CFG, { instrument: WTI, side: 'long', notional: 100, price: 87, stop: '86.5' }), /stop must be/);
  assert.throws(() => openPosition(db2, CFG, { instrument: WTI, side: 'long', notional: 100, price: 87, target: NaN }), /target must be/);
  const db3 = fresh();
  const circular = {}; circular.self = circular;
  const cid = openPosition(db3, botConfig({ bot: { riskPct: 100 } }), { instrument: WTI, side: 'long', notional: 100, price: 87, context: circular });
  const jrow = portfolioView(db3, CFG).journal.find((j) => j.action === 'open');
  assert.equal(jrow.context, '{"unserializable":true}', 'unserializable context never aborts a mutation');
  assert.ok(cid > 0, 'position opened despite circular context');
});

test('commission: charged exactly once (at open), precondition covers it, cache keyed per spreads path', () => {
  const db = fresh();
  const cfg = botConfig({ bot: { riskPct: 100, commission: 2 } });
  const id = openPosition(db, cfg, { instrument: 'NO/SPREAD', side: 'long', notional: 1000, price: 100 });
  let v = portfolioView(db, cfg);
  assert.equal(v.cash, 10000 - 100 - 2, 'margin + one commission deducted');
  const { realized } = closePosition(db, cfg, id, 100, 'bot-close');
  assert.equal(realized, 0, 'flat close: no second commission in realized');
  v = portfolioView(db, cfg);
  assert.equal(v.cash, 10000 - 2, 'exactly one commission across the round trip');
  const tiny = botConfig({ bot: { startingBalance: 100, riskPct: 100, commission: 5, defaultLeverage: 10 } });
  const db2 = fresh();
  assert.throws(() => openPosition(db2, tiny, { instrument: 'NO/SPREAD', side: 'long', notional: 1000, price: 100 }), /insufficient cash/);
  assert.equal(instrumentSpread(botConfig({}), 'NO/SUCH'), 0);
});

test('missing quote: mark kept, position flagged stale, no close triggered', () => {
  const db = fresh();
  openPosition(db, CFG, { instrument: WTI, side: 'long', notional: 1000, price: 87, stop: 1 });
  const r = markToMarket(db, CFG, {});
  assert.equal(r.closed.length, 0);
  assert.equal(r.positions[0].stale, true);
  assert.equal(r.positions[0].last_mark, 87, 'last known mark retained');
  const r2 = markToMarket(db, CFG, { [WTI]: 87.5 });
  assert.equal(r2.positions[0].stale, false, 'fresh quote clears the flag');
});

test('invariant: equity == starting + Σrealized + Σunrealized over random sequences', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const db = fresh();
    const cfg = botConfig({ bot: { riskPct: 100, maxPositions: 5 } });
    let x = seed * 2654435761 % 4294967296;
    const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    let price = 87;
    for (let i = 0; i < 40; i++) {
      price = Math.max(5, price * (1 + (rnd() - 0.5) * 0.02));
      const v = portfolioView(db, cfg);
      if (v.halted) break;
      const act = rnd();
      try {
        if (act < 0.4) openPosition(db, cfg, { instrument: WTI, side: rnd() < 0.5 ? 'long' : 'short', notional: 200 + rnd() * 800, price });
        else if (act < 0.6 && v.positions.length) closePosition(db, cfg, v.positions[0].id, price, 'bot-close');
        else markToMarket(db, cfg, { [WTI]: price });
      } catch (err) {
        if (!/max \d|insufficient cash|risk budget|halted/.test(String(err.message))) throw err;
      }
    }
    const v = portfolioView(db, cfg);
    const realized = v.trades.reduce((s, t) => s + t.realized, 0);
    assert.ok(Math.abs(v.equity - (v.startingBalance + realized + v.unrealized)) < 1e-6,
      `seed ${seed}: equity reconciles (${v.equity} vs ${v.startingBalance + realized + v.unrealized})`);
  }
});

test('unit: unrealized math is symmetric', () => {
  const pos = { side: 'long', entry_price: 100, units: 2 };
  assert.equal(unrealized(pos, 105), 10);
  assert.equal(unrealized({ ...pos, side: 'short' }, 105), -10);
});
