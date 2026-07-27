import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tradeMetrics, strategyScoreboard, decisionAudit, gateDisagreement, baselines, botPerformanceSummary, positionAttribution, lastDecisionByCombo } from '../scripts/evaluation.mjs';
import { botConfig, openPosition, closePosition } from '../scripts/portfolio.mjs';
import { saveStrategy, activateStrategy } from '../scripts/strategies.mjs';
import { runBot } from '../scripts/bot.mjs';
import { storeCandles } from '../scripts/supertrend.mjs';

const WTI = 'WTICO/USD';
const fresh = () => join(mkdtempSync(join(tmpdir(), 'eval-')), 'e.sqlite');

test('tradeMetrics: hand-computed fixture incl. drawdown across reopened peaks', () => {
  // start 100; +10 (peak 110), -22 (equity 88, DD 20%), +30 (118 new peak), -5.9 (112.1, DD 5%)
  const m = tradeMetrics([10, -22, 30, -5.9], 100);
  assert.equal(m.trades, 4);
  assert.equal(m.wins, 2, '#164: exact win/loss counts alongside the rounded rate, for small-n honest display');
  assert.equal(m.losses, 2);
  assert.equal(m.winRatePct, 50);
  assert.equal(m.avgWin, 20);
  assert.ok(Math.abs(m.avgLoss - (-13.95)) < 1e-9);
  assert.ok(Math.abs(m.profitFactor - 40 / 27.9) < 1e-9);
  assert.equal(m.maxDrawdownPct, 20, 'max drawdown is the largest peak-to-trough drop vs the running peak (here the 110→88 leg)');
  assert.deepEqual(m.equityCurve, [100, 110, 88, 118, 112.1]);
  const empty = tradeMetrics([], 100);
  assert.equal(empty.winRatePct, null);
  assert.equal(empty.profitFactor, null);
  const onlyWins = tradeMetrics([5, 5], 100);
  assert.equal(onlyWins.profitFactor, Infinity);

});

async function seededBotTrade(db) {
  const dir = mkdtempSync(join(tmpdir(), 'eval-'));
  const bin = join(dir, 'pi');
  writeFileSync(bin, '#!/bin/sh\ncat > /dev/null\necho \'{"action":"open","side":"long","notional":500,"stop":85,"reasoning":"per strategy"}\'\n');
  chmodSync(bin, 0o755);
  const settings = { provider: 'pi', piBin: bin, bot: { enabled: true, riskPct: 100 } };
  const st = saveStrategy(db, { name: 'eval-strat', prompt: 'Open long on confirmed flips with a protective stop; hold otherwise.' });
  activateStrategy(db, st.id);
  const candle = { open: 87, high: 87.1, low: 86.9, close: 87, time: '2026-07-23T08:00:00.000000000Z', complete: true };
  const r = await runBot(db, settings, { instrument: WTI, granularity: 'M5', candle, quote: { last: 87 }, freshFlip: { signal: 'buy' } });
  closePosition(db, botConfig(settings), r.executed.opened, 88, 'target');
  return st;
}

test('scoreboard attributes trades to the exact strategy version via the journal; audit pins name+version', async () => {
  const db = fresh();
  const st = await seededBotTrade(db);
  const board = strategyScoreboard(db, 10000);
  assert.equal(board.length, 1);
  assert.equal(board[0].strategyId, st.id);
  assert.equal(board[0].strategyName, 'eval-strat');
  assert.equal(board[0].strategyDbVersion, 1);
  assert.equal(board[0].trades, 1);
  assert.equal(board[0].winRatePct, 100);

  const audit = decisionAudit(db);
  const d = audit.find((a) => a.action === 'decision');
  assert.equal(d.strategyName, 'eval-strat');
  assert.equal(d.strategyDbVersion, 1, 'audit entries pin the exact strategy version');
  assert.ok(Array.isArray(d.toolTrace));
  assert.equal(decisionAudit(db, { strategyId: st.id }).length >= 1, true, 'strategy filter matches');
  assert.equal(decisionAudit(db, { strategyId: 99999 }).length, 0, 'foreign filter excludes');

  const summary = botPerformanceSummary(db, 10000);
  assert.equal(summary.trades, 1);
  assert.equal(summary.perStrategy[0].name, 'eval-strat');
});

test('botPerformanceSummary is null before any trades (no chat noise)', () => {
  assert.equal(botPerformanceSummary(fresh(), 10000), null);
});

test('earliestAttributedEntry scopes by instrument and skips unattributed trades', async () => {
  const db = fresh();
  const cfg = botConfig({ bot: { riskPct: 100 } });
  // unattributed early trade on ANOTHER instrument must not define the window
  const other = openPosition(db, cfg, { instrument: 'SPX500/USD', side: 'long', notional: 100, price: 5000 });
  closePosition(db, cfg, other, 5001, 'target');
  const { earliestAttributedEntry } = await import('../scripts/evaluation.mjs');
  assert.equal(earliestAttributedEntry(db, { instrument: WTI }), null, 'no attributed WTI trades yet');
  const st = await seededBotTrade(db);
  const t = earliestAttributedEntry(db, { instrument: WTI });
  assert.ok(t, 'attributed WTI entry found');
  assert.equal(earliestAttributedEntry(db, { instrument: WTI, strategyId: 99999 }), null, 'foreign strategy filter yields null');
  assert.equal(earliestAttributedEntry(db, { instrument: WTI, strategyId: st.id }), t);
});

test('transport scoreboard carries Infinity as the inf sentinel (JSON-safe)', async () => {
  const { transportScoreboard } = await import('../scripts/evaluation.mjs');
  const out = transportScoreboard([{ profitFactor: Infinity }, { profitFactor: 1.5 }, { profitFactor: null }]);
  assert.equal(JSON.parse(JSON.stringify(out))[0].profitFactor, 'inf', 'flawless strategy survives serialization');
  assert.equal(out[1].profitFactor, 1.5);
  assert.equal(out[2].profitFactor, null);
});

test('halt/reset audit rows survive a strategy filter', async () => {
  const db = fresh();
  const st = await seededBotTrade(db);
  const { withDb } = await import('../scripts/supertrend.mjs');
  withDb(db, (dbh) => dbh.prepare('INSERT INTO bot_journal (at, action, reason, context) VALUES (?,?,?,?)')
    .run(new Date().toISOString(), 'halt', 'kill-switch: drawdown', JSON.stringify({ peak: 10000, equity: 7000 })));
  const filtered = decisionAudit(db, { strategyId: st.id });
  assert.ok(filtered.some((a) => a.action === 'halt'), 'kill-switch rows visible under a strategy filter');
});

test('decision audit surfaces the EFFECTIVE sized-down notional, not the LLM\'s raw ask (#85)', async () => {
  const db = fresh();
  const dir = mkdtempSync(join(tmpdir(), 'eval-'));
  const bin = join(dir, 'pi');
  writeFileSync(bin, '#!/bin/sh\ncat > /dev/null\necho \'{"action":"open","side":"long","notional":30000,"stop":85,"reasoning":"oversized ask"}\'\n');
  chmodSync(bin, 0o755);
  const settings = { provider: 'pi', piBin: bin, bot: { enabled: true, riskPct: 1 } };
  const st = saveStrategy(db, { name: 'sizing-strat', prompt: 'Open long on confirmed flips with a protective stop; hold otherwise.' });
  activateStrategy(db, st.id);
  const candle = { open: 87, high: 87.1, low: 86.9, close: 87, time: '2026-07-23T08:00:00.000000000Z', complete: true };
  const r = await runBot(db, settings, { instrument: WTI, granularity: 'M5', candle, quote: { last: 87 }, freshFlip: { signal: 'buy' } });
  assert.equal(r.decision.action, 'open', 'sized down and opened, not rejected');
  const d = decisionAudit(db).find((a) => a.action === 'decision');
  assert.equal(d.decision.notional, 30000, 'raw decision still carries the LLM\'s original ask');
  assert.ok(d.execSizing, 'execSizing threaded onto the decision journal context');
  assert.equal(d.execSizing.requestedNotional, 30000);
  assert.equal(d.execSizing.effectiveNotional, 1000, '1% risk cap (100 margin) at 10x default leverage');
  assert.equal(d.execSizing.bindingCap, 'risk', 'the audit shows what actually happened, not the requested notional');
});

test('positionAttribution (#162) carries instrument/granularity/combo alongside strategy fields', async () => {
  const db = fresh();
  const st = await seededBotTrade(db);
  const attribution = positionAttribution(db);
  const [[posId, a]] = [...attribution.entries()];
  assert.equal(a.strategyId, st.id);
  assert.equal(a.instrument, WTI);
  assert.equal(a.granularity, 'M5');
  assert.equal(a.combo, `${WTI}|M5`);
  assert.ok(posId > 0);
});

// #169 review follow-up: positionAttribution() used to also merge the
// positions/bot_trades granularity COLUMN into this map on every call — an
// O(all stamped rows) scan per call that defeated the memoization once most
// rows were backfilled/stamped. That merge now happens at each consumer
// (row.granularity ?? attribution.get(id)?.granularity), not here — see
// test/portfolio.test.mjs's "column value wins over the journal-derived one"
// (tradeTimeline) and signal-server's /api/bots and /api/chart consumers.
// This map stays journal-only and must NOT change when the column changes.
test('#169: positionAttribution stays journal-derived — the row column is a consumer-side preference, not merged in here', async () => {
  const db = fresh();
  const st = await seededBotTrade(db);
  const [[posId]] = [...positionAttribution(db).entries()];
  const { withDb } = await import('../scripts/supertrend.mjs');
  // seededBotTrade() closes the position immediately, so it now lives in
  // bot_trades (not positions) — update the row that's actually there.
  withDb(db, (conn) => conn.prepare('UPDATE bot_trades SET granularity=? WHERE position_id=?').run('H1', posId));
  const attribution = positionAttribution(db);
  const a = attribution.get(posId);
  assert.equal(a.granularity, 'M5', 'journal-derived value unchanged by the column write — merge moved to consumers');
  assert.equal(a.combo, `${WTI}|M5`);
  assert.equal(a.strategyId, st.id);
});

test('#169: a position with no derivable journal AND no column value stays unattributed (null)', () => {
  const db = fresh();
  const id = openPosition(db, botConfig({}), { instrument: WTI, side: 'long', notional: 100, price: 87 });
  const a = positionAttribution(db).get(id);
  assert.equal(a, undefined, 'no journal decision row and no column → not present in the attribution map at all');
});

test('decisionAudit (#162): instrument/granularity filters scope decision rows but never drop halt/reset', async () => {
  const db = fresh();
  await seededBotTrade(db); // decisions on WTI/M5
  const { withDb } = await import('../scripts/supertrend.mjs');
  withDb(db, (dbh) => dbh.prepare('INSERT INTO bot_journal (at, action, reason, context) VALUES (?,?,?,?)')
    .run(new Date().toISOString(), 'halt', 'kill-switch', JSON.stringify({ peak: 10000, equity: 7000 })));

  const wtiM5 = decisionAudit(db, { instrument: WTI, granularity: 'M5' });
  assert.ok(wtiM5.some((a) => a.action === 'decision'), 'matching combo decision rows pass');
  assert.ok(wtiM5.some((a) => a.action === 'halt'), 'halt rows are combo-independent, always pass');

  const wrongInstrument = decisionAudit(db, { instrument: 'SPX500/USD' });
  assert.equal(wrongInstrument.filter((a) => a.action === 'decision').length, 0, 'foreign instrument excludes decision rows');
  assert.ok(wrongInstrument.some((a) => a.action === 'halt'), 'halt rows survive an instrument filter too');

  const wrongGranularity = decisionAudit(db, { instrument: WTI, granularity: 'H1' });
  assert.equal(wrongGranularity.filter((a) => a.action === 'decision').length, 0, 'foreign granularity excludes decision rows');
});

test('decisionAudit (#162): a combo\'s decision buried under 600 newer other-combo rows still surfaces under a filter + small limit', async () => {
  const db = fresh();
  // seeds the bot_journal schema (openPosition journals an 'open' row, not a 'decision')
  const cfg = botConfig({ bot: { riskPct: 100 } });
  openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 100, price: 87 });
  const { withDb } = await import('../scripts/supertrend.mjs');
  withDb(db, (dbh) => {
    const ins = dbh.prepare('INSERT INTO bot_journal (at, action, reason, context) VALUES (?,?,?,?)');
    // the target combo's ONE decision, written first (oldest / lowest id)
    ins.run(new Date().toISOString(), 'decision', 'target combo', JSON.stringify({ instrument: WTI, granularity: 'M5' }));
    // 600 newer rows for an unrelated combo — old LIMIT-based window (max(500,
    // limit*10)) would have entirely dropped the target row above
    for (let i = 0; i < 600; i++) {
      ins.run(new Date().toISOString(), 'decision', 'noise', JSON.stringify({ instrument: 'SPX500/USD', granularity: 'M1' }));
    }
  });
  const out = decisionAudit(db, { instrument: WTI, granularity: 'M5', limit: 5 });
  assert.equal(out.length, 1, 'the buried target-combo decision is still found');
  assert.equal(out[0].reason, 'target combo');
});

test('decisionAudit (#162): legacy rows with no ctx.granularity pass a granularity filter instead of being erased', async () => {
  const db = fresh();
  const cfg = botConfig({ bot: { riskPct: 100 } });
  openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 100, price: 87 }); // seeds the schema
  const { withDb } = await import('../scripts/supertrend.mjs');
  withDb(db, (dbh) => dbh.prepare('INSERT INTO bot_journal (at, action, reason, context) VALUES (?,?,?,?)')
    .run(new Date().toISOString(), 'decision', 'legacy', JSON.stringify({ instrument: WTI })));
  const out = decisionAudit(db, { instrument: WTI, granularity: 'M5' });
  assert.equal(out.length, 1, 'legacy row (no granularity) passes an instrument+granularity filter');
  assert.equal(out[0].granularity, null);
  const wrongInstrument = decisionAudit(db, { instrument: 'SPX500/USD', granularity: 'M5' });
  assert.equal(wrongInstrument.filter((a) => a.action === 'decision').length, 0, 'instrument filter still excludes it');
});

test('lastDecisionByCombo (#162): most recent decision per configured combo, extracted from /api/bots', async () => {
  const db = fresh();
  await seededBotTrade(db); // one decision for WTI|M5
  const { withDb } = await import('../scripts/supertrend.mjs');
  withDb(db, (dbh) => dbh.prepare('INSERT INTO bot_journal (at, action, reason, context) VALUES (?,?,?,?)')
    .run('2099-01-01T00:00:00.000Z', 'decision', 'newest wins', JSON.stringify({ instrument: WTI, granularity: 'M5' })));
  const found = lastDecisionByCombo(db, [`${WTI}|M5`, 'SPX500/USD|M1']);
  assert.equal(found.get(`${WTI}|M5`).reason, 'newest wins', 'newest-first: the later decision wins');
  assert.equal(found.has('SPX500/USD|M1'), false, 'a combo with no decisions is absent, not a false entry');
});

test('unattributed trades label as "unattributed", never "hash null"', () => {
  const db = fresh();
  const cfg = botConfig({ bot: { riskPct: 100 } });
  const id = openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 100, price: 87 });
  closePosition(db, cfg, id, 88, 'target');
  const summary = botPerformanceSummary(db, 10000);
  assert.equal(summary.perStrategy[0].name, 'unattributed');
});

test('baselines run over the stored-candle window with warm-up context', () => {
  const db = fresh();
  const closes = [...Array(30).fill(100), ...Array.from({ length: 30 }, (_, i) => 100 - i)];
  const candles = closes.map((close, i) => ({
    time: new Date(Date.parse('2026-07-23T00:00:00Z') + i * 300000).toISOString(),
    open: close, high: close + 0.2, low: close - 0.2, close, volume: 10, complete: true,
  }));
  storeCandles(db, WTI, 'M5', candles);
  const b = baselines(db, WTI, 'M5');
  assert.ok(b.window.candles === 60);
  assert.ok(typeof b.buyAndHold.totalReturnPct === 'number');
  assert.ok(Math.abs(b.buyAndHold.totalReturnPct - Math.round(((71 - 100) / 100) * 10000) / 100) < 1e-9, 'buy-and-hold spans first→last close of the same window');
  const scoped = baselines(db, WTI, 'M5', { fromTime: candles[40].time });
  assert.equal(scoped.window.candles, 40, 'scoped window keeps 20 warm-up candles before fromTime');
  assert.equal(baselines(db, 'NO/PE', 'M5'), null, 'insufficient data yields null, not a crash');
  assert.equal(baselines(db, WTI, 'M5', { fromTime: '2027-01-01T00:00:00Z' }), null, 'fromTime beyond history yields null, never the whole history');
  const midBar = new Date(Date.parse(candles[40].time) + 90000).toISOString(); // 1.5min into candle 40
  assert.equal(baselines(db, WTI, 'M5', { fromTime: midBar }).window.candles, 40, 'mid-bar entry anchors at the containing candle, no one-bar skew');
  const inLastBar = new Date(Date.parse(candles[59].time) + 200000).toISOString();
  assert.ok(baselines(db, WTI, 'M5', { fromTime: inLastBar }), 'entry inside the still-open last bar still yields a window');
});

test('decisionAudit (#171 F24): surfaces the recorded sentinel headlines, null when the decision carried no news context', async () => {
  const db = fresh();
  await seededBotTrade(db); // a plain decision with no sentinel block
  const { withDb } = await import('../scripts/supertrend.mjs');
  withDb(db, (dbh) => dbh.prepare('INSERT INTO bot_journal (at, action, reason, context) VALUES (?,?,?,?)')
    .run(new Date().toISOString(), 'decision', 'with news', JSON.stringify({
      instrument: WTI, granularity: 'M5', event: 'flip', decision: { action: 'hold' },
      instrumentContext: { sentinel: { escalation: false, asOf: '2026-07-27T00:00:00Z', headlines: [{ title: 'OPEC+ trims output', source: 'reuters', time: '2026-07-27T00:00:00Z', url: 'https://reuters.example/1' }] } },
    })));
  const out = decisionAudit(db, { instrument: WTI, granularity: 'M5' });
  const withNews = out.find((a) => a.reason === 'with news');
  assert.equal(withNews.news.headlines.length, 1);
  assert.equal(withNews.news.headlines[0].title, 'OPEC+ trims output');
  const plain = out.find((a) => a.reason === 'per strategy');
  assert.equal(plain.news, null, 'a decision with no recorded sentinel block reports null, never invented headlines');
});

test('gateDisagreement (#171 3.6): counts suppress+open / alert+hold over a combo\'s last N flip decisions with a live gate verdict', async () => {
  const db = fresh();
  const { withDb } = await import('../scripts/supertrend.mjs');
  const cfg = botConfig({ bot: { riskPct: 100 } });
  openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 100, price: 87 }); // seeds bot_journal schema
  withDb(db, (dbh) => {
    dbh.exec("CREATE TABLE IF NOT EXISTS signals (instrument TEXT NOT NULL, granularity TEXT NOT NULL, time TEXT NOT NULL, signal TEXT NOT NULL, price REAL, win_rate REAL, verdict TEXT, reason TEXT, notified INTEGER DEFAULT 0, PRIMARY KEY (instrument, granularity, time))");
    const sig = dbh.prepare('INSERT INTO signals (instrument, granularity, time, signal, verdict) VALUES (?,?,?,?,?)');
    const dec = dbh.prepare('INSERT INTO bot_journal (at, action, reason, context) VALUES (?,?,?,?)');
    // 3 disagreements (suppress+open x2, alert+hold x1) + 7 agreements = 10 gate-bearing flip decisions
    const rows = [
      ['suppress', 'open'], ['suppress', 'open'], ['alert', 'hold'],
      ['suppress', 'hold'], ['alert', 'open'], ['alert', 'open'], ['alert', 'open'],
      ['suppress', 'hold'], ['alert', 'open'], ['suppress', 'hold'],
    ];
    rows.forEach(([verdict, action], i) => {
      const t = `2026-07-27T00:${String(i).padStart(2, '0')}:00.000Z`;
      sig.run(WTI, 'M5', t, 'buy', verdict);
      dec.run(t, 'decision', 'x', JSON.stringify({ instrument: WTI, granularity: 'M5', event: 'flip', decision: { action }, instrumentContext: { flip: { time: t } } }));
    });
    // a 'review' event (no flip) must never count toward the gate-bearing window
    dec.run('2026-07-27T00:20:00.000Z', 'decision', 'review', JSON.stringify({ instrument: WTI, granularity: 'M5', event: 'review', decision: { action: 'hold' } }));
  });
  const gd = gateDisagreement(db, { instrument: WTI, granularity: 'M5' });
  assert.equal(gd.checked, 10);
  assert.equal(gd.disagreements, 3);
  assert.equal(gateDisagreement(db, { instrument: 'SPX500/USD', granularity: 'M5' }), null, 'no history for a foreign combo ⇒ null, not a crash');
});

test('gateDisagreement: fewer than 10 gate-bearing decisions yields null (no noisy small-sample note)', async () => {
  const db = fresh();
  const { withDb } = await import('../scripts/supertrend.mjs');
  const cfg = botConfig({ bot: { riskPct: 100 } });
  openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 100, price: 87 });
  withDb(db, (dbh) => {
    dbh.exec("CREATE TABLE IF NOT EXISTS signals (instrument TEXT NOT NULL, granularity TEXT NOT NULL, time TEXT NOT NULL, signal TEXT NOT NULL, price REAL, win_rate REAL, verdict TEXT, reason TEXT, notified INTEGER DEFAULT 0, PRIMARY KEY (instrument, granularity, time))");
    dbh.prepare('INSERT INTO signals (instrument, granularity, time, signal, verdict) VALUES (?,?,?,?,?)').run(WTI, 'M5', '2026-07-27T00:00:00.000Z', 'buy', 'suppress');
    dbh.prepare('INSERT INTO bot_journal (at, action, reason, context) VALUES (?,?,?,?)')
      .run('2026-07-27T00:00:00.000Z', 'decision', 'x', JSON.stringify({ instrument: WTI, granularity: 'M5', event: 'flip', decision: { action: 'open' }, instrumentContext: { flip: { time: '2026-07-27T00:00:00.000Z' } } }));
  });
  assert.equal(gateDisagreement(db, { instrument: WTI, granularity: 'M5' }), null);
});
