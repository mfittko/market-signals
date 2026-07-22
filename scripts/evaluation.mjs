#!/usr/bin/env node
// Evaluation layer (issue #26, epic #27): per-strategy performance from the
// trades journal, baselines from the same candle windows, and the decision
// audit — all read-only, computed on demand from what #22/#23 already record.
import { withDb, computeSupertrend, detectFlips, backtestFlips } from './supertrend.mjs';

function rows(dbPath, sql, args = []) {
  return withDb(dbPath, (db) => {
    try { return db.prepare(sql).all(...args); } catch (err) {
      if (/no such table/i.test(String(err.message))) return []; // pre-schema db: nothing recorded yet
      throw err;
    }
  });
}

// position id → {strategyId, strategyName, strategyDbVersion, strategyVersion}
// via the decision journal (deliberate journals executed.opened).
export function positionAttribution(dbPath) {
  const map = new Map();
  for (const j of rows(dbPath, "SELECT context FROM bot_journal WHERE action='decision'")) {
    try {
      const ctx = JSON.parse(j.context);
      const opened = ctx?.executed?.opened;
      if (opened) {
        map.set(opened, {
          strategyId: ctx.strategyId ?? null,
          strategyName: ctx.strategyName ?? null,
          strategyDbVersion: ctx.strategyDbVersion ?? null,
          strategyVersion: ctx.strategyVersion ?? null,
        });
      }
    } catch { /* unparseable journal rows are skipped */ }
  }
  return map;
}

// Pure metrics over a chronological list of realized trade P&Ls.
export function tradeMetrics(realizedSeries, startingEquity = 0) {
  const wins = realizedSeries.filter((r) => r > 0);
  const losses = realizedSeries.filter((r) => r < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  let equity = startingEquity;
  let peak = startingEquity;
  let maxDrawdown = 0;
  const curve = [startingEquity];
  for (const r of realizedSeries) {
    equity += r;
    curve.push(equity);
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  return {
    trades: realizedSeries.length,
    winRatePct: realizedSeries.length ? Math.round((wins.length / realizedSeries.length) * 1000) / 10 : null,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    totalRealized: grossWin - grossLoss,
    maxDrawdownPct: Math.round(maxDrawdown * 1000) / 10,
    equityCurve: curve,
  };
}

// Earliest attributed entry time for a baseline window: scoped to the
// requested instrument (trades in other instruments must not shift it) and,
// when given, to one strategy; unattributed trades never define the window.
export function earliestAttributedEntry(dbPath, { instrument, strategyId = null } = {}) {
  const attribution = positionAttribution(dbPath);
  let earliest = null;
  for (const t of rows(dbPath, 'SELECT position_id, instrument, entry_time FROM bot_trades ORDER BY id')) {
    if (instrument && t.instrument !== instrument) continue;
    const a = attribution.get(t.position_id);
    if (!a || a.strategyId == null) continue;
    if (strategyId != null && a.strategyId !== strategyId) continue;
    if (earliest === null || t.entry_time < earliest) earliest = t.entry_time;
  }
  return earliest;
}

// Per-strategy(+version) scoreboard from bot_trades, attributed via the journal.
export function strategyScoreboard(dbPath, startingBalance = 10000) {
  const attribution = positionAttribution(dbPath);
  const trades = rows(dbPath, 'SELECT * FROM bot_trades ORDER BY id');
  const groups = new Map();
  for (const t of trades) {
    const a = attribution.get(t.position_id) ?? { strategyId: null, strategyName: null, strategyDbVersion: null, strategyVersion: null };
    // versions are distinct rows: id+dbVersion (falling back to the content hash)
    const key = a.strategyId != null ? `${a.strategyId}:${a.strategyDbVersion ?? 0}` : `hash:${a.strategyVersion ?? 'unattributed'}`;
    if (!groups.has(key)) groups.set(key, { ...a, realized: [], firstTrade: t.entry_time, lastTrade: t.close_time });
    const g = groups.get(key);
    g.realized.push(t.realized);
    if (t.entry_time < g.firstTrade) g.firstTrade = t.entry_time;
    if (t.close_time > g.lastTrade) g.lastTrade = t.close_time;
  }
  return [...groups.values()].map((g) => ({
    strategyId: g.strategyId,
    strategyName: g.strategyName,
    strategyDbVersion: g.strategyDbVersion,
    strategyVersion: g.strategyVersion,
    firstTrade: g.firstTrade,
    lastTrade: g.lastTrade,
    ...tradeMetrics(g.realized, startingBalance),
  }));
}

// Baselines over the SAME stored-candle window the strategy traded (or the
// full stored history when no fromTime is given): raw flip-following via the
// existing backtest math, and buy-and-hold first→last close.
export function baselines(dbPath, instrument, granularity, opts = {}) {
  const candles = rows(dbPath,
    'SELECT time, open, high, low, close, volume, 1 AS complete FROM candles WHERE instrument=? AND granularity=? ORDER BY time',
    [instrument, granularity]);
  if (candles.length < 20) return null;
  let win = candles;
  if (opts.fromTime) {
    const from = candles.findIndex((c) => c.time >= opts.fromTime);
    if (from === -1) return null; // fromTime beyond stored history: no window, never the whole history
    // keep supertrend warm-up context before the window start
    win = candles.slice(Math.max(0, from - 20));
  }
  const st = computeSupertrend(win, { period: 10, multiplier: 3 });
  const flips = detectFlips(win, st);
  const flipFollowing = backtestFlips(win, flips);
  const first = win[0].close;
  const last = win[win.length - 1].close;
  return {
    window: { from: win[0].time, to: win[win.length - 1].time, candles: win.length },
    flipFollowing: { winRatePct: flipFollowing.winRatePct, totalReturnPct: flipFollowing.totalReturnPct, trades: flipFollowing.trades },
    buyAndHold: { totalReturnPct: Math.round(((last - first) / first) * 10000) / 100 },
  };
}

// Decision audit: newest-first journal decisions with parsed context, filterable
// by strategy id. Read-only; the exact pinned prompt text lives in strategies.
export function decisionAudit(dbPath, { strategyId = null, limit = 50 } = {}) {
  const out = [];
  const scan = Math.max(500, limit * 10);
  for (const j of rows(dbPath, `SELECT id, at, action, reason, context FROM bot_journal WHERE action IN ('decision','halt','reset') ORDER BY id DESC LIMIT ${scan}`)) {
    let ctx = null;
    try { ctx = JSON.parse(j.context); } catch { /* keep raw-less entry */ }
    if (strategyId != null && ctx?.strategyId !== strategyId) continue;
    out.push({
      id: j.id, at: j.at, action: j.action, reason: j.reason,
      instrument: ctx?.instrument ?? null, event: ctx?.event ?? null,
      decision: ctx?.decision ?? null, executed: ctx?.executed ?? null, error: ctx?.error ?? null,
      strategyId: ctx?.strategyId ?? null, strategyName: ctx?.strategyName ?? null,
      strategyDbVersion: ctx?.strategyDbVersion ?? null,
      toolTrace: ctx?.toolTrace ?? [], snapshot: ctx?.snapshot ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// Compact summary for the chat context — only meaningful once trades exist.
export function botPerformanceSummary(dbPath, startingBalance = 10000) {
  const board = strategyScoreboard(dbPath, startingBalance);
  if (!board.length) return null;
  const total = board.reduce((a, s) => a + s.totalRealized, 0);
  const trades = board.reduce((a, s) => a + s.trades, 0);
  return {
    trades,
    totalRealized: Math.round(total * 100) / 100,
    perStrategy: board.map((s) => ({
      name: s.strategyName ?? (s.strategyVersion ? `hash ${s.strategyVersion}` : 'unattributed'),
      version: s.strategyDbVersion,
      trades: s.trades,
      winRatePct: s.winRatePct,
      totalRealized: Math.round(s.totalRealized * 100) / 100,
      maxDrawdownPct: s.maxDrawdownPct,
    })),
  };
}
