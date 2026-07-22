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
  botConfig, openPosition, closePosition, markToMarket, portfolioView,
} from './portfolio.mjs';
import { activeStrategy, listStrategies } from './strategies.mjs';

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
    // Gap-at-open events execute at t=0, BEFORE any intrabar level can trade —
    // evaluate them first or a both-touched candle inverts a win into a loss.
    // In the intrabar both-touched case (no gap) the stop wins: pessimistic fill.
    const gapStop = pos.stop != null && (long ? candle.open <= pos.stop : candle.open >= pos.stop);
    const gapTarget = pos.target != null && (long ? candle.open >= pos.target : candle.open <= pos.target);
    let fill = null;
    if (gapStop) fill = { price: candle.open, reason: 'stop' };
    else if (gapTarget) fill = { price: candle.open, reason: 'target' };
    else if (pos.stop != null && (long ? candle.low <= pos.stop : candle.high >= pos.stop)) fill = { price: pos.stop, reason: 'stop' };
    else if (pos.target != null && (long ? candle.high >= pos.target : candle.low <= pos.target)) fill = { price: pos.target, reason: 'target' };
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

function buildDecisionPrompt(loop, view, ctx) {
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
export async function deliberate(dbPath, settings, { instrument, granularity, event, ctx, toolDefs = null, execTool = null, strategyRow = null }) {
  const cfg = botConfig(settings);
  const loop = botLoopConfig(settings);
  // The ACTIVE db strategy (#25) outranks the settings/default prompt; journal
  // rows pin its exact id+version so past decisions stay attributed.
  if (strategyRow?.prompt) loop.strategy = strategyRow.prompt;
  const view = portfolioView(dbPath, cfg);
  const version = strategyVersion(loop.strategy);
  const toolTrace = [];
  const tracedExec = execTool
    ? async (name, args) => {
      try {
        const out = await execTool(name, args);
        toolTrace.push({ name, args, ok: true });
        return out;
      } catch (err) {
        toolTrace.push({ name, args, ok: false, error: String(err.message || err).slice(0, 120) });
        throw err;
      }
    }
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
      // Clamp closes to the triggering instrument: the prompt shows the whole
      // portfolio (and tool output feeds it), so a hallucinated or injected
      // cross-instrument positionId must never close at this instrument's price.
      const target_ = view.positions.find((pp) => pp.id === decision.positionId);
      if (!target_) throw new Error(`unknown position ${decision.positionId}`);
      if (target_.instrument !== instrument) throw new Error(`position ${decision.positionId} belongs to ${target_.instrument}, not ${instrument}`);
      executed = closePosition(dbPath, cfg, decision.positionId, price, 'bot-close', { strategyVersion: version });
    }
  } catch (err) {
    error = `execution rejected: ${String(err.message || err).slice(0, 160)}`;
    decision = { ...decision, action: 'hold', reasoning: `fail-safe hold: ${error}` };
  }
  journalBot(dbPath, cfg, 'decision', decision.reasoning ?? null, {
    instrument, granularity, event, decision, executed, error,
    strategyVersion: version, strategyId: strategyRow?.id ?? null, strategyName: strategyRow?.name ?? null, strategyDbVersion: strategyRow?.version ?? null, toolTrace, instrumentContext: ctx,
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

  // Active strategy scoping: an instruments CSV on the active strategy limits
  // deliberation to those combos (deterministic fills always run).
  let strategyRow = null;
  let anyStrategies = false;
  try {
    strategyRow = activeStrategy(dbPath);
    anyStrategies = strategyRow != null || listStrategies(dbPath).length > 0;
  } catch { /* strategies table optional */ }
  // Strategies exist but none is active: the operator turned them off — pause
  // deliberation rather than silently trading the hardcoded default prompt.
  if (!strategyRow && anyStrategies) return { fills, halted: false, deliberated: false, skipped: 'no active strategy' };
  if (strategyRow?.instruments) {
    // normalize each combo the same way the watchers parser does — spaces
    // around the pipe must not silently unscope a combo
    const combos = strategyRow.instruments.split(',').map((x) => x.split('|').map((p) => p.trim()).join('|')).filter((x) => x !== '|' && x);
    if (!combos.includes(`${instrument}|${granularity}`)) return { fills, halted: false, deliberated: false, skipped: 'combo not in active strategy scope' };
  }

  const result = await deliberate(dbPath, settings, {
    instrument, granularity, event,
    ctx: { ...ctx, close: candle?.close, quote, flip: freshFlip },
    toolDefs, execTool, strategyRow,
  });
  return { fills, halted: false, deliberated: true, ...result };
}
