import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOT_DEFAULTS, botConfig, instrumentLeverage, instrumentSpread,
  openPosition, closePosition, markToMarket, portfolioView, unrealized, tradeTimeline,
} from '../scripts/portfolio.mjs';
import { saveStrategy, activateStrategy } from '../scripts/strategies.mjs';
import { runBot } from '../scripts/bot.mjs';
import { withDb } from '../scripts/supertrend.mjs';

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

test('guards: max positions, insufficient margin (post-sizing), bad input', () => {
  const db = fresh();
  const cfg = botConfig({ bot: { riskPct: 100, maxPositions: 2 } });
  openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 100, price: 87 });
  openPosition(db, cfg, { instrument: WTI, side: 'short', notional: 100, price: 87 });
  assert.throws(() => openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 100, price: 87 }), /max 2/);
  const db2 = fresh();
  // riskPct/allocationPct caps SIZE DOWN (#83), so an oversized notional no
  // longer rejects on its own — insufficient cash still must, checked against
  // the post-sizing (effective) margin: unleveraged 1:1, first open locks
  // 9000 of the 10000 cash, leaving 1000 free; a second request the 100%
  // risk cap would happily size to 5000 margin still can't fit that cash.
  const tightCash = botConfig({ bot: { riskPct: 100, defaultLeverage: 1 } });
  openPosition(db2, tightCash, { instrument: WTI, side: 'long', notional: 9000, price: 87 });
  assert.throws(() => openPosition(db2, tightCash, { instrument: WTI, side: 'long', notional: 5000, price: 87 }), /insufficient cash/);
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

test('quoted but unusable price: mark kept, position flagged stale, no close triggered', () => {
  const db = fresh();
  openPosition(db, CFG, { instrument: WTI, side: 'long', notional: 1000, price: 87, stop: 1 });
  const r = markToMarket(db, CFG, { [WTI]: null });
  assert.equal(r.closed.length, 0);
  assert.equal(r.positions[0].stale, true);
  assert.equal(r.positions[0].last_mark, 87, 'last known mark retained');
  const r2 = markToMarket(db, CFG, { [WTI]: 87.5 });
  assert.equal(r2.positions[0].stale, false, 'fresh quote clears the flag');
});

// Bot runs are per-combo: runBot passes a single-instrument quote map. An
// instrument that was never asked about must keep its flag, or every other
// instrument's position flaps stale/fresh on each unrelated run (#151).
test('a per-combo run leaves positions of instruments it did not quote untouched', () => {
  const db = fresh();
  openPosition(db, CFG, { instrument: WTI, side: 'long', notional: 1000, price: 87, stop: 1 });
  openPosition(db, CFG, { instrument: 'XAG/USD', side: 'long', notional: 1000, price: 59, stop: 1 });
  const byName = (v, n) => v.positions.find((p) => p.instrument === n);
  // WTI goes stale on its own run (quoted, no usable price)…
  markToMarket(db, CFG, { [WTI]: null });
  assert.equal(byName(portfolioView(db, CFG), WTI).stale, true);
  // …and an unrelated XAG run must neither clear nor set anything on WTI.
  const r = markToMarket(db, CFG, { 'XAG/USD': 59.4 });
  assert.equal(byName(r, WTI).stale, true, 'WTI keeps its own stale flag');
  assert.equal(byName(r, WTI).last_mark, 87, 'WTI mark untouched by the XAG run');
  assert.equal(byName(r, 'XAG/USD').stale, false, 'the quoted instrument is fresh');
  // The reverse direction is the reported bug: a fresh WTI must not be staled
  // by the next XAG run.
  markToMarket(db, CFG, { [WTI]: 87.5 });
  const r2 = markToMarket(db, CFG, { 'XAG/USD': 59.5 });
  assert.equal(byName(r2, WTI).stale, false, 'unrelated run must not flag WTI stale');
  assert.equal(byName(r2, WTI).last_mark, 87.5);
  // a prototype key is not a quote: an instrument named "constructor" must be
  // treated as absent, not as quoted-with-a-junk-price (Copilot #152)
  openPosition(db, CFG, { instrument: 'constructor', side: 'long', notional: 1000, price: 5, stop: 1 });
  const r3 = markToMarket(db, CFG, { 'XAG/USD': 59.6 });
  assert.equal(byName(r3, 'constructor').stale, false, 'prototype key must not count as a quote');
});

test('#163: an absent instrument goes stale once its own last mark ages past the threshold', () => {
  const db = fresh();
  const cfg = botConfig({ bot: { riskPct: 10, leverage: { [WTI]: 10 }, staleAfterMs: 50 } });
  const id = openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 1000, price: 87 });
  // never quoted on this run (absent from the map): a fresh mark is not yet stale…
  let r = markToMarket(db, cfg, {});
  assert.equal(r.positions[0].stale, false, 'fresh mark, absent instrument: untouched');
  // …but once the last mark ages past the (test-tiny) threshold, an absent
  // instrument's position IS flagged stale — it can no longer hide behind
  // "never asked about on this run" forever.
  withDb(db, (dbc) => dbc.prepare('UPDATE positions SET last_mark_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), id));
  r = markToMarket(db, cfg, {});
  assert.equal(r.positions[0].stale, true, 'aged-out absent instrument is flagged stale');
  // a subsequent USABLE quote clears it and stamps a fresh last_mark_at
  const r2 = markToMarket(db, cfg, { [WTI]: 88 });
  assert.equal(r2.positions[0].stale, false, 'a real quote clears the age-based flag too');
});

test('#163 review: legacy NULL last_mark_at reads as fresh (age 0), not instant-stale Infinity age', () => {
  const db = fresh();
  const cfg = botConfig({ bot: { riskPct: 10, leverage: { [WTI]: 10 }, staleAfterMs: 50 } });
  const id = openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 1000, price: 87 });
  // Simulate a pre-#163 row: last_mark_at was never set.
  withDb(db, (dbc) => dbc.prepare('UPDATE positions SET last_mark_at=NULL WHERE id=?').run(id));
  // The absent-instrument path in markToMarket() treats a NULL last_mark_at
  // as age 0 (not Infinity) — it gets stamped on the next successful mark.
  const r = markToMarket(db, cfg, {}); // absent-instrument path
  assert.equal(r.positions[0].stale, false, 'legacy NULL row reads as fresh, not instantly stale');
  const row = withDb(db, (dbc) => dbc.prepare('SELECT last_mark_at FROM positions WHERE id=?').get(id));
  assert.equal(row.last_mark_at, null, 'last_mark_at stays NULL until a real quote marks it');
});

test('#163: realizedTotal sums ALL bot_trades (beyond the 50-row trades slice); dayPnl = today-closed realized + current unrealized', () => {
  const db = fresh();
  // 60 closed trades — more than the 50-row TRADES_QUERY slice.
  for (let i = 0; i < 60; i++) {
    const id = openPosition(db, CFG, { instrument: WTI, side: 'long', notional: 100, price: 87 });
    closePosition(db, CFG, id, 88, 'bot-close');
  }
  const view = portfolioView(db, CFG);
  const sumAll = withDb(db, (dbc) => dbc.prepare('SELECT SUM(realized) r FROM bot_trades').get().r);
  assert.equal(view.trades.length, 50, 'display slice still capped at 50');
  assert.ok(Math.abs(view.realizedTotal - sumAll) < 1e-9, 'realizedTotal reflects ALL trades, not just the 50-row slice');
  assert.ok(view.realizedTotal > sumAll * 0.9, 'sanity: not accidentally scoped to the 50-row slice');
  // dayPnl: all 60 trades just closed "now" (today, local) — plus a fresh
  // open position's unrealized.
  const openId = openPosition(db, CFG, { instrument: WTI, side: 'long', notional: 1000, price: 87 });
  const v2 = portfolioView(db, CFG);
  const posUnreal = unrealized(v2.positions.find((p) => p.id === openId), v2.positions.find((p) => p.id === openId).last_mark);
  assert.ok(Math.abs(v2.dayPnl - (v2.realizedTotal + posUnreal)) < 1e-6, 'dayPnl = today-closed realized + current unrealized (all trades closed today here)');
});

test('#163 review: dayPnl compares close_time and now on the SAME (local) basis, not UTC-vs-local', () => {
  const db = fresh();
  const id = openPosition(db, CFG, { instrument: WTI, side: 'long', notional: 100, price: 87 });
  closePosition(db, CFG, id, 88, 'bot-close');
  // Force close_time into a UTC calendar day that differs from today's LOCAL
  // calendar day, using a fixed-offset (no-DST) zone so the test is
  // deterministic regardless of the machine's real TZ: 1am local in
  // UTC+14 is always ~11am UTC on the PREVIOUS calendar day. The old query
  // (date(close_time) — UTC — vs date('now','localtime')) would drop this
  // trade from dayRealized under that TZ; the fixed query keeps both sides
  // on localtime and includes it.
  const savedTz = process.env.TZ;
  process.env.TZ = 'Pacific/Kiritimati'; // fixed UTC+14, no DST
  try {
    const offsetMs = 14 * 3600 * 1000;
    const localNowMs = Date.now() + offsetMs;
    const localMidnightMs = Math.floor(localNowMs / 86400000) * 86400000;
    const closeUtcMs = (localMidnightMs + 3600 * 1000) - offsetMs; // 1am local
    withDb(db, (dbc) => dbc.prepare('UPDATE bot_trades SET close_time=? WHERE id=1')
      .run(new Date(closeUtcMs).toISOString()));
    const view = portfolioView(db, CFG);
    assert.ok(Math.abs(view.dayPnl - (view.realizedTotal + view.unrealized)) < 1e-6,
      'trade closed at 1am local (UTC+14) counts as today even though its UTC date is yesterday');
  } finally {
    if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
  }
});

test('#163: portfolioView exposes one server tz (the client formats every timestamp with it, not a per-row *_local field)', () => {
  const db = fresh();
  const id = openPosition(db, CFG, { instrument: WTI, side: 'long', notional: 1000, price: 87 });
  closePosition(db, CFG, id, 88, 'bot-close');
  openPosition(db, CFG, { instrument: WTI, side: 'long', notional: 1000, price: 87 });
  const v = portfolioView(db, CFG);
  assert.equal(typeof v.tz, 'string');
  assert.ok(v.tz.length > 0);
  assert.equal(v.positions.find((p) => p.entry_time_local), undefined, 'no per-row *_local field on positions');
  assert.equal(v.trades.find((t) => t.entry_time_local || t.close_time_local), undefined, 'no per-row *_local field on trades');
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

test('allocation cap (#51): oversize sizes down (#83) to the remaining budget; exhausted cap is a no-budget skip, not a reject', () => {
  const db = fresh();
  const cfg = botConfig({ bot: { riskPct: 100, maxPositions: 5 } });
  cfg.allocationPct = 3; // 3% of 10000 = 300 margin budget
  const INSTR = 'NO/SPREAD'; // zero spread keeps equity exactly 10000 for clean math
  openPosition(db, cfg, { instrument: INSTR, side: 'long', notional: 2000, price: 87 }); // margin 200
  // requesting 1500 (margin 150) would push total to 350 > 300: SIZE DOWN
  // (#83) to whatever allocation has left (100 margin), never reject.
  const id2 = openPosition(db, cfg, { instrument: INSTR, side: 'long', notional: 1500, price: 87 });
  assert.ok(id2 > 0, 'size-down opens rather than rejecting');
  let v = portfolioView(db, cfg);
  assert.equal(v.positions.length, 2);
  assert.equal(v.positions[1].margin, 100, 'sized to the remaining allocation budget');
  assert.equal(v.positions[1].notional, 1000);
  const jd = JSON.parse(v.journal.find((j) => j.action === 'open' && j.position_id === id2).context);
  assert.equal(jd.bindingCap, 'allocation');
  assert.equal(jd.requestedNotional, 1500);
  assert.equal(jd.effectiveNotional, 1000);
  // allocation now fully consumed (300 of 300 margin locked): the next open
  // on this instrument is a legitimate no-budget skip, not a rejection.
  const skipped = openPosition(db, cfg, { instrument: INSTR, side: 'short', notional: 500, price: 87 });
  assert.equal(skipped, null, 'exhausted allocation returns null instead of throwing');
  v = portfolioView(db, cfg);
  assert.equal(v.positions.length, 2, 'no third position opened');
  const skipRow = v.journal.find((j) => j.action === 'skip');
  assert.equal(skipRow.reason, 'no budget (allocation cap exhausted)');
  openPosition(db, cfg, { instrument: 'SPX500/USD', side: 'long', notional: 2000, price: 5000 });
  assert.equal(portfolioView(db, cfg).positions.length, 3, 'cap is instrument-scoped, other instruments unaffected');
});

test('server-side sizing (#83): the exact operator repro sizes down to $100 margin / $1000 notional, no throw', () => {
  const db = fresh();
  // allocationPct is not a BOT_DEFAULTS key (botConfig would silently drop
  // it); production wires it in per-combo (bot.mjs resolveBotFor), set it
  // directly here, same convention as the allocation-cap test above.
  const cfg = botConfig({ bot: { riskPct: 1, defaultLeverage: 10 } });
  cfg.allocationPct = 10;
  const id = openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 30000, price: 87 });
  assert.ok(id > 0, 'sizes down and opens instead of rejecting');
  const v = portfolioView(db, cfg);
  assert.equal(v.positions.length, 1);
  assert.equal(v.positions[0].margin, 100, '1% of 10000 equity binds');
  assert.equal(v.positions[0].notional, 1000);
  const jd = JSON.parse(v.journal.find((j) => j.action === 'open').context);
  assert.equal(jd.requestedNotional, 30000);
  assert.equal(jd.effectiveNotional, 1000);
  assert.equal(jd.bindingCap, 'risk');
});

test('server-side sizing (#83): each cap drops out cleanly when unconfigured; requested-under-budget never sizes up', () => {
  const db = fresh();
  // riskPct configured null (explicitly unset) → only allocation binds
  const allocOnly = botConfig({ bot: { defaultLeverage: 10 } });
  allocOnly.riskPct = null;
  allocOnly.allocationPct = 5;
  const id1 = openPosition(db, allocOnly, { instrument: WTI, side: 'long', notional: 100000, price: 87 });
  const v1 = portfolioView(db, allocOnly);
  assert.equal(v1.positions[0].margin, 500, '5% of 10000, risk cap dropped out');
  const jd1 = JSON.parse(v1.journal.find((j) => j.action === 'open').context);
  assert.equal(jd1.bindingCap, 'allocation');

  // allocationPct unset (default) → only risk binds
  const db2 = fresh();
  const riskOnly = botConfig({ bot: { riskPct: 2, defaultLeverage: 10 } });
  const id2 = openPosition(db2, riskOnly, { instrument: WTI, side: 'long', notional: 100000, price: 87 });
  const v2 = portfolioView(db2, riskOnly);
  assert.equal(v2.positions[0].margin, 200, '2% of 10000, allocation cap absent');
  const jd2 = JSON.parse(v2.journal.find((j) => j.action === 'open').context);
  assert.equal(jd2.bindingCap, 'risk');

  // both unset → sizes to the requested notional (or cash), never a false block
  const db3 = fresh();
  const noCaps = botConfig({ bot: { defaultLeverage: 10 } });
  noCaps.riskPct = null;
  const id3 = openPosition(db3, noCaps, { instrument: WTI, side: 'long', notional: 1000, price: 87 });
  const v3 = portfolioView(db3, noCaps);
  assert.equal(v3.positions[0].notional, 1000, 'sizes to the requested amount with no caps configured');
  const jd3 = JSON.parse(v3.journal.find((j) => j.action === 'open').context);
  assert.equal(jd3.bindingCap, 'none');

  // requested notional already under budget → opens unchanged (size-down
  // never sizes UP)
  const db4 = fresh();
  const generous = botConfig({ bot: { riskPct: 100, defaultLeverage: 10 } });
  const id4 = openPosition(db4, generous, { instrument: WTI, side: 'long', notional: 500, price: 87 });
  const v4 = portfolioView(db4, generous);
  assert.equal(v4.positions[0].notional, 500, 'unchanged: requested was already within budget');
  const jd4 = JSON.parse(v4.journal.find((j) => j.action === 'open').context);
  assert.equal(jd4.bindingCap, 'none');
  assert.equal(jd4.requestedNotional, 500);
  assert.equal(jd4.effectiveNotional, 500);
  void id1; void id2; void id3; void id4;
});

test('sequential trades fit within allocation (#83): $100-margin opens until the $1000 budget is exhausted, then no-budget skip', () => {
  const db = fresh();
  const cfg = botConfig({ bot: { riskPct: 1, defaultLeverage: 10, maxPositions: 20 } });
  cfg.allocationPct = 10;
  const INSTR = 'NO/SPREAD';
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const id = openPosition(db, cfg, { instrument: INSTR, side: 'long', notional: 30000, price: 87 });
    assert.ok(id > 0, `open ${i} should land inside the budget`);
    ids.push(id);
  }
  assert.equal(portfolioView(db, cfg).positions.length, 10, '10 * $100 margin == the $1000 allocation budget');
  const skipped = openPosition(db, cfg, { instrument: INSTR, side: 'long', notional: 30000, price: 87 });
  assert.equal(skipped, null, 'allocation fully consumed: the 11th is a no-budget skip, not a reject');
  assert.equal(portfolioView(db, cfg).positions.length, 10, 'skip never opens a position');
});


async function attributedOpen(db, { instrument = WTI, granularity = 'M5', notional = 500, stop = 85, name = 'tt-strat' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tt-'));
  const bin = join(dir, 'pi');
  writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\necho '{"action":"open","side":"long","notional":${notional},"stop":${stop},"reasoning":"tt fixture"}'\n`);
  chmodSync(bin, 0o755);
  // explicit per-combo binding by NAME (#75): two different strategy names can
  // both be active=1 simultaneously (activation scopes by name), so the
  // legacy single-active-strategy fallback is ambiguous with >1 name in play —
  // bind this combo's bot to its name explicitly, like a real bot-modal assignment.
  const settings = { provider: 'pi', piBin: bin, bot: { bots: { [`${instrument}|${granularity}`]: { enabled: true, strategyName: name, riskPct: 100 } } } };
  const st = saveStrategy(db, { name, prompt: 'Open long on confirmed flips with a protective stop; hold otherwise.' });
  activateStrategy(db, st.id);
  const candle = { open: 87, high: 87.1, low: 86.9, close: 87, time: '2026-07-23T08:00:00.000000000Z', complete: true };
  const r = await runBot(db, settings, { instrument, granularity, candle, quote: { last: 87 }, freshFlip: { signal: 'buy' } });
  return { positionId: r.executed.opened, strategyName: name };
}

test('tradeTimeline (#162): canonical shape, open-first-then-closed-newest-first, attribution + unattributed', async () => {
  const db = fresh();
  const cfg = botConfig({ bot: { riskPct: 100 } });
  const { positionId: openPosId, strategyName } = await attributedOpen(db, { notional: 300 });
  // an unattributed manual position, still open — combo/strategyName null
  const unattrId = openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 100, price: 87 });
  // an attributed, closed trade (second bot deliberation + manual close)
  const { positionId: closedPosId } = await attributedOpen(db, { notional: 200, name: 'tt-strat-2' });
  const { realized: closedRealized } = closePosition(db, cfg, closedPosId, 88, 'target');
  // an unattributed closed trade
  const unattrClosedId = openPosition(db, cfg, { instrument: WTI, side: 'short', notional: 100, price: 87 });
  closePosition(db, cfg, unattrClosedId, 86, 'bot-close');

  const rows = tradeTimeline(db, cfg);
  const opens = rows.filter((r) => r.state === 'open');
  const closeds = rows.filter((r) => r.state === 'closed');
  assert.equal(opens.length, 2, 'both open positions present');
  assert.equal(closeds.length, 2, 'both closed trades present');
  assert.deepEqual(rows.map((r) => r.state), ['open', 'open', 'closed', 'closed'], 'open rows precede closed rows');

  const openAttr = opens.find((r) => r.id === openPosId);
  assert.equal(openAttr.instrument, WTI);
  assert.equal(openAttr.granularity, 'M5');
  assert.equal(openAttr.combo, `${WTI}|M5`);
  assert.equal(openAttr.strategyName, strategyName);
  assert.equal(openAttr.mark, 87, 'open row marks at last_mark');
  assert.ok(Math.abs(openAttr.pnl - unrealized({ side: 'long', entry_price: openAttr.entryPrice, units: openAttr.units }, 87)) < 1e-9);
  assert.ok(Math.abs(openAttr.pnlPct - (openAttr.pnl / openAttr.margin) * 100) < 0.01, 'pnlPct = pnl/margin*100 (rounded)');
  assert.equal(openAttr.exitTime, null);
  assert.equal(openAttr.closeReason, null);
  assert.equal(openAttr.stop, 85, 'stop carried through');
  assert.ok(Number.isFinite(openAttr.ageMin) && openAttr.ageMin >= 0, `ageMin finite and non-negative, got ${openAttr.ageMin}`);
  assert.equal(openAttr.openReason, 'tt fixture', 'open row surfaces the journal open reason');

  const openUnattr = opens.find((r) => r.id === unattrId);
  assert.equal(openUnattr.combo, null);
  assert.equal(openUnattr.granularity, null);
  assert.equal(openUnattr.strategyName, null);

  const closedAttr = closeds.find((r) => r.id === closedPosId);
  assert.equal(closedAttr.combo, `${WTI}|M5`);
  assert.equal(closedAttr.strategyName, 'tt-strat-2');
  assert.equal(closedAttr.mark, 88, 'closed row marks at close_price');
  assert.equal(closedAttr.pnl, closedRealized, 'realized P&L matches the value closePosition() actually recorded');
  assert.ok(closedRealized > 0, 'sanity: a long entered at 87 and closed at 88 books a real, non-zero profit');
  assert.equal(closedAttr.stop, null, 'closed rows carry no stop/target');
  assert.equal(closedAttr.target, null);
  assert.equal(closedAttr.closeReason, 'target');
  assert.equal(closedAttr.openReason, null, 'closed rows do not carry an open reason');
  assert.equal(closedAttr.exitTime !== null, true);

  const closedUnattr = closeds.find((r) => r.id === unattrClosedId);
  assert.equal(closedUnattr.combo, null);
  assert.equal(closedUnattr.closeReason, 'bot-close');

  // newest-first among closed: the trade closed LAST should sort first
  assert.equal(closeds[0].id, unattrClosedId, 'closed rows are newest-first');
});

test('tradeTimeline (#162): closed-row ageMin is the HOLD duration, not elapsed-since-close', () => {
  const db = fresh();
  const cfg = botConfig({ bot: { riskPct: 100 } });
  const id = openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 100, price: 87 });
  closePosition(db, cfg, id, 88, 'target');
  // backdate entry/close so the trade "was held" for a known duration, long
  // in the past — if ageMin were still elapsed-since-entry (the bug) this
  // would report ~days old instead of the 45-minute hold.
  withDb(db, (conn) => {
    conn.prepare("UPDATE bot_trades SET entry_time=?, close_time=? WHERE position_id=?")
      .run('2020-01-01T00:00:00.000Z', '2020-01-01T00:45:00.000Z', id);
  });
  const row = tradeTimeline(db, cfg, { state: 'closed' }).find((r) => r.id === id);
  assert.equal(row.ageMin, 45, 'closed ageMin is the hold duration (close - entry), not now - entry');
});

test('tradeTimeline (#162): instrument/granularity/state filters and limit clamp', async () => {
  const db = fresh();
  const cfg = botConfig({ bot: { riskPct: 100 } });
  await attributedOpen(db, { instrument: WTI, granularity: 'M5', notional: 100 });
  const otherId = openPosition(db, cfg, { instrument: 'SPX500/USD', side: 'long', notional: 100, price: 5000 });
  closePosition(db, cfg, otherId, 5001, 'target');

  const wtiOnly = tradeTimeline(db, cfg, { instrument: WTI });
  assert.ok(wtiOnly.every((r) => r.instrument === WTI), 'instrument filter scopes both open and closed rows');

  const m5Only = tradeTimeline(db, cfg, { granularity: 'M5' });
  assert.ok(m5Only.every((r) => r.granularity === 'M5'), 'granularity filter excludes unattributed/foreign-granularity rows');
  assert.equal(m5Only.length, 1, 'only the attributed M5 open position matches');

  const openOnly = tradeTimeline(db, cfg, { state: 'open' });
  assert.ok(openOnly.every((r) => r.state === 'open'));
  const closedOnly = tradeTimeline(db, cfg, { state: 'closed' });
  assert.ok(closedOnly.every((r) => r.state === 'closed'));
  assert.equal(openOnly.length + closedOnly.length, tradeTimeline(db, cfg).length);

  assert.equal(tradeTimeline(db, cfg, { limit: 1 }).length, 1, 'limit clamps the row count');
});

test('server-side sizing (#83): a tiny requested notional with budget available opens, is not mislabeled no-budget', () => {
  const db = fresh();
  const cfg = { ...CFG, riskPct: 1, allocationPct: 10 };
  // budget is ample (1% of 10k = 100 margin); a tiny in-budget request must OPEN,
  // not be treated as no-budget (the skip keys on maxMargin, not effectiveNotional)
  const id = openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 5, price: 87, stop: 86 });
  assert.ok(id != null, 'a tiny in-budget request opens rather than skipping as no-budget');
  assert.equal(portfolioView(db, cfg).positions.length, 1);
});
