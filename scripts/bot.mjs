#!/usr/bin/env node
// Trading-bot decision loop (issue #23, epic #27). Paper money only.
// Deterministic work happens every candle close (fills, mark-to-market,
// kill-switch); the LLM deliberates ONLY on events (fresh flip or adverse
// move past the review trigger). Decisions are fail-SAFE: any malformed
// output, timeout, or provider error is a journaled `hold` — the inverse of
// the alert filter's fail-open, deliberately.
import { createHash } from 'node:crypto';
import { withDb, llmChat, sendNotification } from './supertrend.mjs';
import {
  botConfig, instrumentLeverage, openPosition, closePosition, markToMarket, portfolioView,
} from './portfolio.mjs';

export const BOT_LOOP_DEFAULTS = {
  enabled: false,
  reviewTriggerPct: 1,
  killSwitchDrawdownPct: 20,
  strategy: 'Follow supertrend flips: open in the flip direction with a stop just beyond the supertrend line, close on the opposite flip. Skip chop (rapid alternating flips, thin volume).',
};

export function botLoopConfig(settings = {}) {
  const bot = settings.bot || {};
  return {
    ...BOT_LOOP_DEFAULTS,
    enabled: bot.enabled === true,
    reviewTriggerPct: Number.isFinite(bot.reviewTriggerPct) && bot.reviewTriggerPct > 0 ? bot.reviewTriggerPct : BOT_LOOP_DEFAULTS.reviewTriggerPct,
    killSwitchDrawdownPct: Number.isFinite(bot.killSwitchDrawdownPct) && bot.killSwitchDrawdownPct > 0 ? bot.killSwitchDrawdownPct : BOT_LOOP_DEFAULTS.killSwitchDrawdownPct,
    strategy: typeof bot.strategy === 'string' && bot.strategy.trim() ? bot.strategy : BOT_LOOP_DEFAULTS.strategy,
    resetHalt: bot.resetHalt === true,
  };
}

export const strategyVersion = (strategy) => createHash('sha256').update(strategy).digest('hex').slice(0, 8);

function journalBot(dbPath, cfg, action, reason, context) {
  withDb(dbPath, (db) => {
    db.exec('CREATE TABLE IF NOT EXISTS bot_journal (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, position_id INTEGER, reason TEXT, context TEXT)');
    let ctx = null;
    if (context) { try { ctx = JSON.stringify(context); } catch { ctx = '{"unserializable":true}'; } }
    db.prepare('INSERT INTO bot_journal (at, action, position_id, reason, context) VALUES (?,?,NULL,?,?)')
      .run(new Date().toISOString(), action, reason ?? null, ctx);
  });
}

// --- deterministic per-candle work ------------------------------------------

// Simulate stop/target fills from a completed candle. Gap-through the level at
// the open fills at the open (the realistic worse price); otherwise at the level.
export function simulateFills(dbPath, cfg, instrument, candle) {
  const closed = [];
  const positions = portfolioView(dbPath, cfg).positions.filter((p) => p.instrument === instrument);
  for (const pos of positions) {
    const long = pos.side === 'long';
    let fill = null;
    if (pos.stop != null) {
      if (long ? candle.open <= pos.stop : candle.open >= pos.stop) fill = { price: candle.open, reason: 'stop' };
      else if (long ? candle.low <= pos.stop : candle.high >= pos.stop) fill = { price: pos.stop, reason: 'stop' };
    }
    if (!fill && pos.target != null) {
      if (long ? candle.open >= pos.target : candle.open <= pos.target) fill = { price: candle.open, reason: 'target' };
      else if (long ? candle.high >= pos.target : candle.low <= pos.target) fill = { price: pos.target, reason: 'target' };
    }
    if (fill) closed.push(closePosition(dbPath, cfg, pos.id, fill.price, fill.reason, { candleTime: candle.time }));
  }
  return closed;
}

function peakEquity(dbPath, equity) {
  return withDb(dbPath, (db) => {
    db.exec('CREATE TABLE IF NOT EXISTS bot_state (key TEXT PRIMARY KEY, value REAL)');
    const row = db.prepare('SELECT value FROM bot_state WHERE key=?').get('peak_equity');
    const peak = Math.max(row?.value ?? 0, equity);
    db.prepare('INSERT INTO bot_state (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('peak_equity', peak);
    return peak;
  });
}

function setHalted(dbPath, cfg, halted) {
  withDb(dbPath, (db) => {
    db.exec('CREATE TABLE IF NOT EXISTS portfolio (id INTEGER PRIMARY KEY CHECK (id = 1), starting_balance REAL NOT NULL, cash REAL NOT NULL, halted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)');
    db.prepare('UPDATE portfolio SET halted=? WHERE id=1').run(halted ? 1 : 0);
  });
}

// --- decision layer ---------------------------------------------------------

const DECISION_RE = /\{[\s\S]*"action"[\s\S]*\}/;

export function parseDecision(text) {
  const m = String(text).match(DECISION_RE);
  if (!m) return null;
  let d;
  try { d = JSON.parse(m[0]); } catch { return null; }
  if (!['open', 'close', 'hold'].includes(d.action)) return null;
  if (d.action === 'open') {
    if (d.side !== 'long' && d.side !== 'short') return null;
    if (!(d.notional > 0) || !Number.isFinite(d.notional)) return null;
    if (!(d.stop > 0) || !Number.isFinite(d.stop)) return null; // stop is mandatory on open
    if (d.target != null && !(Number.isFinite(d.target) && d.target > 0)) return null;
  }
  if (d.action === 'close' && !(Number.isInteger(d.positionId) && d.positionId > 0)) return null;
  return d;
}

export function buildDecisionPrompt(loop, view, ctx) {
  return [
    `strategy (version ${strategyVersion(loop.strategy)}):\n${loop.strategy}`,
    `portfolio:\n${JSON.stringify({ equity: view.equity, cash: view.cash, halted: view.halted, positions: view.positions })}`,
    `instrument context:\n${JSON.stringify(ctx)}`,
    'Decide now. Reply with EXACTLY one JSON object, no prose:',
    '{"action":"open"|"close"|"hold","side":"long"|"short","notional":<number>,"stop":<number>,"target":<number|null>,"positionId":<number, close only>,"reasoning":"<max 200 chars>"}',
    'Rules: stop is REQUIRED on open. hold when unsure. Never exceed the risk budget.',
  ].join('\n\n');
}

const DECISION_SYSTEM = 'You are an automated trading strategy executing on a VIRTUAL paper portfolio. You receive a strategy, portfolio state, and instrument context; tools may be available for news/rates checks. Your reply MUST end with exactly one JSON decision object per the requested schema. Be conservative: hold when the setup is unclear.';

// One deliberation for one instrument event. Returns {decision, executed, error}.
export async function deliberate(dbPath, settings, { instrument, granularity, event, ctx, toolDefs = null, execTool = null }) {
  const cfg = botConfig(settings);
  const loop = botLoopConfig(settings);
  const view = portfolioView(dbPath, cfg);
  const version = strategyVersion(loop.strategy);
  const toolTrace = [];
  const tracedExec = execTool
    ? async (name, args) => { const out = await execTool(name, args); toolTrace.push({ name, args }); return out; }
    : null;
  let decision = null;
  let error = null;
  try {
    const reply = await llmChat(settings, DECISION_SYSTEM, buildDecisionPrompt(loop, view, ctx), {
      toolDefs: toolDefs || undefined, execTool: tracedExec || undefined,
    });
    decision = parseDecision(reply);
    if (!decision) error = 'malformed decision';
  } catch (err) {
    error = String(err.message || err).slice(0, 200);
  }
  if (!decision) decision = { action: 'hold', reasoning: `fail-safe hold: ${error}` };

  let executed = null;
  try {
    if (decision.action === 'open') {
      const price = ctx.quote?.last ?? ctx.close;
      const long = decision.side === 'long';
      if (long ? decision.stop >= price : decision.stop <= price) throw new Error(`stop ${decision.stop} on the wrong side of entry ${price} for ${decision.side}`);
      if (decision.target != null && (long ? decision.target <= price : decision.target >= price)) throw new Error(`target ${decision.target} on the wrong side of entry ${price} for ${decision.side}`);
      const id = openPosition(dbPath, cfg, {
        instrument, side: decision.side, notional: decision.notional, price,
        stop: decision.stop, target: decision.target ?? null,
        reason: decision.reasoning, context: { event, granularity, strategyVersion: version },
      });
      executed = { opened: id };
    } else if (decision.action === 'close') {
      const price = ctx.quote?.last ?? ctx.close;
      executed = closePosition(dbPath, cfg, decision.positionId, price, 'bot-close', { strategyVersion: version });
    }
  } catch (err) {
    error = `execution rejected: ${String(err.message || err).slice(0, 160)}`;
    decision = { ...decision, action: 'hold' };
  }
  journalBot(dbPath, cfg, 'decision', decision.reasoning ?? null, {
    instrument, granularity, event, decision, executed, error,
    strategyVersion: version, toolTrace, instrumentContext: ctx,
    snapshot: { equity: view.equity, cash: view.cash, marginLocked: view.marginLocked, unrealized: view.unrealized, halted: view.halted, positions: view.positions },
  });
  return { decision, executed, error };
}

// --- per-combo entry point (called from the watcher run) --------------------

// candle: the last COMPLETE candle. freshFlip: sig object when a lock-in flip
// fired this run. Returns a summary for logs/tests.
export async function runBot(dbPath, settings, { instrument, granularity, candle, quote, freshFlip = null, ctx = {}, toolDefs = null, execTool = null }) {
  const loop = botLoopConfig(settings);
  if (!loop.enabled) return { skipped: 'disabled' };
  const cfg = botConfig(settings);

  if (loop.resetHalt) {
    setHalted(dbPath, cfg, false);
    // Re-baseline the peak to current equity, else the same drawdown re-halts
    // on this very run and the operator reset is a no-op.
    const eq = portfolioView(dbPath, cfg).equity;
    withDb(dbPath, (db) => {
      db.exec('CREATE TABLE IF NOT EXISTS bot_state (key TEXT PRIMARY KEY, value REAL)');
      db.prepare('INSERT INTO bot_state (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('peak_equity', eq);
    });
    journalBot(dbPath, cfg, 'reset', 'halt cleared by operator (bot.resetHalt); peak re-baselined', { peakEquity: eq });
  }

  // 1) deterministic: candle fills, then mark everything at the close.
  const fills = candle ? simulateFills(dbPath, cfg, instrument, candle) : [];
  const marked = markToMarket(dbPath, cfg, { [instrument]: quote?.last ?? candle?.close });

  // 2) kill-switch on drawdown from peak equity.
  const peak = peakEquity(dbPath, marked.equity);
  const drawdownPct = peak > 0 ? ((peak - marked.equity) / peak) * 100 : 0;
  if (!marked.halted && drawdownPct > loop.killSwitchDrawdownPct) {
    setHalted(dbPath, cfg, true);
    journalBot(dbPath, cfg, 'halt', `kill-switch: drawdown ${drawdownPct.toFixed(1)}% > ${loop.killSwitchDrawdownPct}%`, { peak, equity: marked.equity });
    try {
      sendNotification(`bot halted — drawdown ${drawdownPct.toFixed(1)}% (equity ${marked.equity.toFixed(2)})`, null, settings);
    } catch { /* notification is best-effort */ }
    return { fills, halted: true, drawdownPct };
  }
  if (marked.halted) return { fills, halted: true, skipped: 'halted' };

  // 3) LLM deliberation only on events.
  const positions = portfolioView(dbPath, cfg).positions.filter((p) => p.instrument === instrument);
  const adverse = positions.some((p) => {
    const move = p.side === 'long' ? p.entry_price - p.last_mark : p.last_mark - p.entry_price;
    return (move / p.entry_price) * 100 > loop.reviewTriggerPct;
  });
  const event = freshFlip ? 'flip' : adverse ? 'review' : null;
  if (!event) return { fills, halted: false, deliberated: false };

  const result = await deliberate(dbPath, settings, {
    instrument, granularity, event,
    ctx: { ...ctx, close: candle?.close, quote, flip: freshFlip },
    toolDefs, execTool,
  });
  return { fills, halted: false, deliberated: true, ...result };
}
