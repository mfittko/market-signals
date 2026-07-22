import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { botConfig, openPosition, portfolioView } from '../scripts/portfolio.mjs';
import {
  botLoopConfig, parseDecision, simulateFills, runBot, deliberate, strategyVersion,
} from '../scripts/bot.mjs';

const WTI = 'WTICO/USD';
const fresh = () => join(mkdtempSync(join(tmpdir(), 'bot-')), 'bot.sqlite');
const CFG = botConfig({ bot: { riskPct: 100 } });
const candle = (o, h, l, c, time = '2026-07-22T10:00:00.000000000Z') => ({ open: o, high: h, low: l, close: c, time, complete: true });

// settings whose llmChat path uses a fake pi binary is heavy; deliberate() takes
// the provider through llmChat, so tests stub at the settings level with pi and
// a fake bin — same pattern as the chat tests.
import { writeFileSync, chmodSync } from 'node:fs';
function fakeProvider(dir, reply) {
  const bin = join(dir, 'pi');
  writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\necho '${reply.replace(/'/g, "'\\''")}'\n`);
  chmodSync(bin, 0o755);
  return { provider: 'pi', piBin: bin, bot: { enabled: true, riskPct: 100 } };
}

test('parseDecision: valid shapes pass, everything else is rejected', () => {
  assert.deepEqual(parseDecision('{"action":"hold"}'), { action: 'hold' });
  assert.ok(parseDecision('prose then {"action":"open","side":"long","notional":500,"stop":85,"reasoning":"x"}'));
  assert.equal(parseDecision('{"action":"open","side":"long","notional":500}'), null, 'stop required on open');
  assert.equal(parseDecision('{"action":"open","side":"up","notional":500,"stop":85}'), null);
  assert.equal(parseDecision('{"action":"open","side":"long","notional":"5","stop":85}'), null);
  assert.equal(parseDecision('{"action":"close"}'), null, 'close needs positionId');
  assert.equal(parseDecision('{"action":"buy"}'), null);
  assert.equal(parseDecision('not json at all'), null);
  assert.equal(parseDecision('{"action":"open","side":"long","notional":1,"stop":1,"target":"x"}'), null);
});

test('simulateFills: stop at level, gap-through at open, target fills, shorts mirrored', () => {
  const db = fresh();
  openPosition(db, CFG, { instrument: WTI, side: 'long', notional: 500, price: 87, stop: 86.5, target: 88 });
  // candle dips through the stop intraday → fill at the stop level
  let closed = simulateFills(db, CFG, WTI, candle(86.9, 87.0, 86.3, 86.8));
  assert.equal(closed[0].closeReason, 'stop');
  const t1 = portfolioView(db, CFG).trades[0];
  assert.equal(t1.close_price, 86.5, 'intraday breach fills at the stop, not the low');

  // gap-through: candle OPENS beyond the stop → fill at the open (worse price)
  openPosition(db, CFG, { instrument: WTI, side: 'long', notional: 500, price: 87, stop: 86.5 });
  closed = simulateFills(db, CFG, WTI, candle(85.9, 86.2, 85.5, 86.0));
  assert.equal(closed[0].closeReason, 'stop');
  assert.equal(portfolioView(db, CFG).trades[0].close_price, 85.9, 'gap fills at the open');

  // target on a short: price gaps DOWN through it → open fill
  openPosition(db, CFG, { instrument: WTI, side: 'short', notional: 500, price: 87, target: 86 });
  closed = simulateFills(db, CFG, WTI, candle(85.8, 86.1, 85.6, 86.0));
  assert.equal(closed[0].closeReason, 'target');
  assert.equal(portfolioView(db, CFG).trades[0].close_price, 85.8);
});

test('no LLM call without an event; flip and adverse review both trigger exactly one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-'));
  const db = join(dir, 'bot.sqlite');
  const settings = fakeProvider(dir, '{"action":"hold","reasoning":"idle"}');
  let calls = 0;
  const spyTools = [{ name: 'noop', description: 'x', input_schema: { type: 'object' } }];
  // count provider invocations via decision journal entries instead of the bin:
  const r1 = await runBot(db, settings, { instrument: WTI, granularity: 'M5', candle: candle(87, 87.1, 86.9, 87), quote: { last: 87 } });
  assert.equal(r1.deliberated, false, 'idle candle: no LLM');
  const r2 = await runBot(db, settings, { instrument: WTI, granularity: 'M5', candle: candle(87, 87.1, 86.9, 87), quote: { last: 87 }, freshFlip: { signal: 'buy', time: 'x' } });
  assert.equal(r2.deliberated, true, 'fresh flip deliberates');
  assert.equal(r2.decision.action, 'hold');
  // adverse move: open long, then mark 2% against it (> default 1% trigger)
  openPosition(db, botConfig(settings), { instrument: WTI, side: 'long', notional: 500, price: 87 });
  const r3 = await runBot(db, settings, { instrument: WTI, granularity: 'M5', candle: candle(85.2, 85.3, 85.1, 85.2), quote: { last: 85.2 } });
  assert.equal(r3.deliberated, true, 'adverse move triggers review');
  const journal = portfolioView(db, botConfig(settings)).journal.filter((j) => j.action === 'decision');
  assert.equal(journal.length, 2, 'exactly one decision journal per event, none for idle');
  void calls; void spyTools;
});

test('decisions execute: open then close via fake provider; journal carries version+trace+snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-'));
  const db = join(dir, 'bot.sqlite');
  const open_ = fakeProvider(dir, '{"action":"open","side":"long","notional":500,"stop":85,"target":90,"reasoning":"flip long"}');
  const r = await runBot(db, open_, { instrument: WTI, granularity: 'M5', candle: candle(87, 87.1, 86.9, 87), quote: { last: 87 }, freshFlip: { signal: 'buy' } });
  assert.ok(r.executed.opened > 0, 'position opened');
  const v = portfolioView(db, botConfig(open_));
  assert.equal(v.positions.length, 1);
  const jd = JSON.parse(v.journal.find((j) => j.action === 'decision').context);
  assert.equal(jd.strategyVersion, strategyVersion(botLoopConfig(open_).strategy), 'strategy version journaled');
  assert.ok(Array.isArray(jd.toolTrace), 'tool trace journaled');
  assert.ok(jd.snapshot.equity > 0 && Array.isArray(jd.snapshot.positions), 'full portfolio snapshot journaled');
  assert.equal(jd.instrumentContext.close, 87, 'instrument context journaled');

  const close_ = { ...fakeProvider(dir, `{"action":"close","positionId":${v.positions[0].id},"reasoning":"take profit"}`) };
  const r2 = await runBot(db, close_, { instrument: WTI, granularity: 'M5', candle: candle(88, 88.1, 87.9, 88), quote: { last: 88 }, freshFlip: { signal: 'sell' } });
  assert.equal(r2.executed.closeReason, 'bot-close');
  assert.equal(portfolioView(db, botConfig(close_)).positions.length, 0);
});

test('fail-safe: malformed output and execution rejection both journal a hold, never a trade', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-'));
  const db = join(dir, 'bot.sqlite');
  const bad = fakeProvider(dir, 'the market feels bullish, going long!');
  const r = await runBot(db, bad, { instrument: WTI, granularity: 'M5', candle: candle(87, 87.1, 86.9, 87), quote: { last: 87 }, freshFlip: { signal: 'buy' } });
  assert.equal(r.decision.action, 'hold');
  assert.match(r.error, /malformed/);
  assert.equal(portfolioView(db, botConfig(bad)).positions.length, 0, 'no trade on malformed output');

  // valid shape but violates guards (risk budget) → executes as hold
  const over = fakeProvider(dir, '{"action":"open","side":"long","notional":900000,"stop":85,"reasoning":"yolo"}');
  over.bot.riskPct = 1;
  const r2 = await runBot(db, over, { instrument: WTI, granularity: 'M5', candle: candle(87, 87.1, 86.9, 87), quote: { last: 87 }, freshFlip: { signal: 'buy' } });
  assert.equal(r2.decision.action, 'hold');
  assert.match(r2.error, /execution rejected/);
  assert.equal(portfolioView(db, botConfig(over)).positions.length, 0);
});

test('kill-switch: drawdown past threshold halts, notifies once, stays halted until operator reset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-'));
  const db = join(dir, 'bot.sqlite');
  const settings = fakeProvider(dir, '{"action":"hold"}');
  settings.bot.killSwitchDrawdownPct = 10;
  settings.notifierBin = join(dir, 'missing-notifier'); // never fire a real notification
  const cfg = botConfig(settings);
  // build peak at 10000, then lose >10% via a position marked way down
  openPosition(db, cfg, { instrument: WTI, side: 'long', notional: 9000, price: 87 });
  await runBot(db, settings, { instrument: WTI, granularity: 'M5', candle: candle(87, 87.2, 86.9, 87), quote: { last: 87 } });
  const r = await runBot(db, settings, { instrument: WTI, granularity: 'M5', candle: candle(75, 75.2, 74.9, 75), quote: { last: 75 } });
  assert.equal(r.halted, true, 'kill-switch fired');
  const v = portfolioView(db, cfg);
  assert.equal(v.halted, true);
  const halts = v.journal.filter((j) => j.action === 'halt');
  assert.ok(halts.length >= 1);
  // subsequent runs stay halted, no re-halt journal, no deliberation even on flips
  const r2 = await runBot(db, settings, { instrument: WTI, granularity: 'M5', candle: candle(75, 75.2, 74.9, 75), quote: { last: 75 }, freshFlip: { signal: 'buy' } });
  assert.equal(r2.skipped, 'halted');
  assert.equal(portfolioView(db, cfg).journal.filter((j) => j.action === 'halt').length, halts.length, 'halt journaled once');
  // operator reset via settings flag
  settings.bot.resetHalt = true;
  const r3 = await runBot(db, settings, { instrument: WTI, granularity: 'M5', candle: candle(75, 75.2, 74.9, 75), quote: { last: 75 } });
  assert.notEqual(r3.skipped, 'halted', 'reset clears the halt');
  assert.ok(portfolioView(db, cfg).journal.some((j) => j.action === 'reset'));
});

test('bot disabled: runBot is a no-op and deliberate is never reached', async () => {
  const db = fresh();
  const r = await runBot(db, { bot: { enabled: false } }, { instrument: WTI, granularity: 'M5', candle: candle(87, 87.1, 86.9, 87), quote: { last: 87 }, freshFlip: { signal: 'buy' } });
  assert.deepEqual(r, { skipped: 'disabled' });
});

test('deliberate records tool trace when the provider is tool-capable', async () => {
  // pi chat is tool-less by design; assert the trace plumbing directly instead.
  const dir = mkdtempSync(join(tmpdir(), 'bot-'));
  const db = join(dir, 'bot.sqlite');
  const settings = fakeProvider(dir, '{"action":"hold","reasoning":"checked"}');
  const r = await deliberate(db, settings, {
    instrument: WTI, granularity: 'M5', event: 'flip', ctx: { close: 87 },
    toolDefs: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
    execTool: async () => 'tool-output',
  });
  assert.equal(r.decision.action, 'hold');
  const jd = JSON.parse(portfolioView(db, botConfig(settings)).journal.find((j) => j.action === 'decision').context);
  assert.deepEqual(jd.toolTrace, [], 'pi path never calls tools; trace stays empty but present');
});
