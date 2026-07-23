#!/usr/bin/env node
// Virtual portfolio core (issue #22, epic #27). Paper money only.
// All mutations live here and are journaled; the HTTP layer must only ever
// import the read-side (portfolioView). CFD-style exposure: a trade specifies
// notional; margin = notional / leverage; fixed per-instrument spread is paid
// once on entry.
import { readFileSync } from 'node:fs';
import { withDb } from './supertrend.mjs';

const DDL = `CREATE TABLE IF NOT EXISTS portfolio (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  starting_balance REAL NOT NULL,
  cash REAL NOT NULL,
  halted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long','short')),
  notional REAL NOT NULL,
  units REAL NOT NULL,
  entry_price REAL NOT NULL,
  entry_time TEXT NOT NULL,
  leverage REAL NOT NULL,
  margin REAL NOT NULL,
  stop REAL,
  target REAL,
  last_mark REAL NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bot_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  instrument TEXT NOT NULL,
  side TEXT NOT NULL,
  notional REAL NOT NULL,
  units REAL NOT NULL,
  entry_price REAL NOT NULL,
  entry_time TEXT NOT NULL,
  close_price REAL NOT NULL,
  close_time TEXT NOT NULL,
  leverage REAL NOT NULL,
  realized REAL NOT NULL,
  close_reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  position_id INTEGER,
  reason TEXT,
  context TEXT
)`;

export const BOT_DEFAULTS = {
  startingBalance: 10000,
  riskPct: 1,
  maxPositions: 3,
  leverageCap: 20,
  defaultLeverage: 10,
  commission: 0,
};

export function botConfig(settings = {}, spreadsPath = 'config/spreads.json') {
  const bot = settings.bot || {};
  const cfg = { ...BOT_DEFAULTS, ...Object.fromEntries(Object.entries(bot).filter(([k, v]) => Object.hasOwn(BOT_DEFAULTS, k) && Number.isFinite(v) && v > 0)) };
  cfg.leverage = bot.leverage && typeof bot.leverage === 'object' ? bot.leverage : {};
  let spreads = {};
  try { spreads = JSON.parse(readFileSync(spreadsPath, 'utf8')); } catch { /* no spread config */ }
  cfg.spreads = spreads;
  return cfg;
}

export function instrumentSpread(cfg, instrument) {
  const s = cfg.spreads?.[instrument];
  return typeof s === 'number' && s >= 0 ? s : 0;
}

export function instrumentLeverage(cfg, instrument) {
  const lv = cfg.leverage[instrument];
  const chosen = Number.isFinite(lv) && lv > 0 ? lv : cfg.defaultLeverage;
  return Math.min(chosen, cfg.leverageCap);
}

function pdb(dbPath, cfg, fn) {
  return withDb(dbPath, (db) => {
    db.exec(DDL);
    const seeded = db.prepare('INSERT OR IGNORE INTO portfolio (id, starting_balance, cash, created_at) VALUES (1,?,?,?)')
      .run(cfg.startingBalance, cfg.startingBalance, new Date().toISOString());
    if (seeded.changes > 0) journal(db, 'init', null, 'portfolio seeded', { startingBalance: cfg.startingBalance });
    return fn(db);
  });
}

function journal(db, action, positionId, reason, context) {
  let ctx = null;
  if (context) {
    try { ctx = JSON.stringify(context); } catch { ctx = '{"unserializable":true}'; }
  }
  db.prepare('INSERT INTO bot_journal (at, action, position_id, reason, context) VALUES (?,?,?,?,?)')
    .run(new Date().toISOString(), action, positionId ?? null, reason ?? null, ctx);
}

export function unrealized(pos, mark) {
  const diff = pos.side === 'long' ? mark - pos.entry_price : pos.entry_price - mark;
  return diff * pos.units;
}

// --- mutations (module-internal to the bot; never wire to a POST route) -----

export function openPosition(dbPath, cfg, { instrument, side, notional, price, stop = null, target = null, reason = null, context = null } = {}) {
  if (typeof instrument !== 'string' || !instrument.trim()) throw new Error('instrument required');
  if (side !== 'long' && side !== 'short') throw new Error('side must be long|short');
  if (!(notional > 0) || !(price > 0)) throw new Error('notional and price must be > 0');
  for (const [name, v] of [['stop', stop], ['target', target]]) {
    if (v != null && !(Number.isFinite(v) && v > 0)) throw new Error(`${name} must be a positive number when set`);
  }
  return pdb(dbPath, cfg, (db) => {
    const p = db.prepare('SELECT * FROM portfolio WHERE id=1').get();
    if (p.halted) throw new Error('portfolio halted');
    const open = db.prepare('SELECT COUNT(*) c FROM positions').get().c;
    if (open >= cfg.maxPositions) throw new Error(`max ${cfg.maxPositions} concurrent positions`);
    const leverage = instrumentLeverage(cfg, instrument);
    const equityNow = viewInDb(db).equity;
    // per-INSTRUMENT equity allocation (#51): positions carry no granularity,
    // so the cap is shared by every bot on this instrument — same semantics
    // as leverage; labeled accordingly in the UI. Computed once, reused by
    // both the allocation cap below and the sizing math.
    const lockedHere = db.prepare('SELECT COALESCE(SUM(margin),0) m FROM positions WHERE instrument=?').get(instrument).m;

    // Server-side sizing (#83): the LLM's notional is only an upper-bound
    // hint — it has no numeric anchors to compute margin/leverage/budget
    // itself, so it always overshoots. Rather than reject an oversized
    // request, size it DOWN to whatever fits the risk% and allocation% caps.
    // Stop-distance-based sizing can replace this when the decision loop
    // (#23) needs it.
    const riskCap = Number.isFinite(cfg.riskPct) && cfg.riskPct > 0 ? (cfg.riskPct / 100) * equityNow : Infinity;
    const allocCap = Number.isFinite(cfg.allocationPct) && cfg.allocationPct > 0
      ? (cfg.allocationPct / 100) * equityNow - lockedHere
      : Infinity;
    const maxMargin = Math.min(riskCap, allocCap);
    const maxNotional = maxMargin * leverage;
    const requestedNotional = notional;
    const effectiveNotional = Math.min(requestedNotional, maxNotional);
    const EPS = 1e-9;
    const bindingCap = effectiveNotional >= requestedNotional - EPS ? 'none' : (riskCap <= allocCap ? 'risk' : 'allocation');

    if (maxMargin <= EPS || effectiveNotional <= EPS) {
      // Allocation/risk budget for this instrument is genuinely exhausted —
      // a legitimate no-trade skip, not an execution rejection (#83).
      journal(db, 'skip', null, 'no budget (allocation full)', {
        instrument, side, requestedNotional, effectiveNotional: 0, bindingCap, leverage, equityNow, lockedHere,
      });
      return null;
    }

    const margin = effectiveNotional / leverage;
    if (margin + cfg.commission > p.cash) throw new Error('insufficient cash for margin + commission');
    // Invariants, not gates: effectiveNotional was already sized above to
    // satisfy both caps, so these can never fire in practice — kept as cheap
    // defense-in-depth against a future edit breaking the sizing math.
    if (margin > riskCap + EPS) {
      throw new Error(`invariant violated: sized margin ${margin.toFixed(2)} exceeds risk cap ${riskCap.toFixed(2)}`);
    }
    if (margin > allocCap + EPS) {
      throw new Error(`invariant violated: sized margin ${margin.toFixed(2)} exceeds allocation cap`);
    }
    const spread = instrumentSpread(cfg, instrument);
    const entry = side === 'long' ? price + spread : price - spread;
    const units = effectiveNotional / price;
    const cash = p.cash - margin - cfg.commission;
    db.prepare('UPDATE portfolio SET cash=? WHERE id=1').run(cash);
    const id = db.prepare(`INSERT INTO positions
      (instrument, side, notional, units, entry_price, entry_time, leverage, margin, stop, target, last_mark)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(instrument, side, effectiveNotional, units, entry, new Date().toISOString(), leverage, margin, stop, target, price).lastInsertRowid;
    journal(db, 'open', id, reason, {
      ...context, side, notional: effectiveNotional, requestedNotional, effectiveNotional, bindingCap, price, entry, spread, leverage, margin,
    });
    return Number(id);
  });
}

export function closePosition(dbPath, cfg, positionId, price, closeReason, context = null) {
  if (!(price > 0)) throw new Error('close price must be > 0');
  if (typeof closeReason !== 'string' || !closeReason.trim()) throw new Error('closeReason required');
  return pdb(dbPath, cfg, (db) => closeInDb(db, cfg, positionId, price, closeReason, context));
}

function closeInDb(db, cfg, positionId, price, closeReason, context) {
  const pos = db.prepare('SELECT * FROM positions WHERE id=?').get(positionId);
  if (!pos) throw new Error('unknown position');
  const realized = unrealized(pos, price); // commission charged once, at open
  const p = db.prepare('SELECT * FROM portfolio WHERE id=1').get();
  db.prepare('UPDATE portfolio SET cash=? WHERE id=1').run(p.cash + pos.margin + realized);
  db.prepare(`INSERT INTO bot_trades
    (position_id, instrument, side, notional, units, entry_price, entry_time, close_price, close_time, leverage, realized, close_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(pos.id, pos.instrument, pos.side, pos.notional, pos.units, pos.entry_price, pos.entry_time, price, new Date().toISOString(), pos.leverage, realized, closeReason);
  db.prepare('DELETE FROM positions WHERE id=?').run(positionId);
  journal(db, 'close', positionId, closeReason, { ...context, price, realized });
  return { positionId, realized, closeReason };
}

// Mark all positions against quotes {instrument: price}. Missing quote → keep
// last mark, flag stale. Triggers stop/target/margin closes and the equity halt.
export function markToMarket(dbPath, cfg, quotes = {}) {
  return pdb(dbPath, cfg, (db) => {
    const closed = [];
    for (const pos of db.prepare('SELECT * FROM positions').all()) {
      const q = quotes[pos.instrument];
      if (!(q > 0)) {
        db.prepare('UPDATE positions SET stale=1 WHERE id=?').run(pos.id);
        continue;
      }
      db.prepare('UPDATE positions SET last_mark=?, stale=0 WHERE id=?').run(q, pos.id);
      const u = unrealized(pos, q);
      const stopHit = pos.stop != null && (pos.side === 'long' ? q <= pos.stop : q >= pos.stop);
      const targetHit = pos.target != null && (pos.side === 'long' ? q >= pos.target : q <= pos.target);
      if (u <= -pos.margin) closed.push(closeInDb(db, cfg, pos.id, q, 'margin'));
      else if (stopHit) closed.push(closeInDb(db, cfg, pos.id, q, 'stop'));
      else if (targetHit) closed.push(closeInDb(db, cfg, pos.id, q, 'target'));
    }
    let view = viewInDb(db);
    if (view.equity <= 0 && !view.halted) {
      for (const pos of db.prepare('SELECT * FROM positions').all()) {
        closed.push(closeInDb(db, cfg, pos.id, pos.last_mark, 'halt'));
      }
      db.prepare('UPDATE portfolio SET halted=1 WHERE id=1').run();
      journal(db, 'halt', null, 'equity <= 0', { equity: view.equity });
      view = viewInDb(db);
    }
    return { closed, ...view };
  });
}

// --- read side (the only thing the HTTP layer may use) ----------------------

const TRADES_QUERY = 'SELECT * FROM bot_trades ORDER BY id DESC LIMIT ?';

export function botTrades(dbPath, cfg, limit = 50) {
  return pdb(dbPath, cfg, (db) => db.prepare(TRADES_QUERY).all(limit));
}

function viewInDb(db) {
  const p = db.prepare('SELECT * FROM portfolio WHERE id=1').get();
  const positions = db.prepare(`SELECT p.*,
      (SELECT reason FROM bot_journal j WHERE j.position_id = p.id AND j.action = 'open' ORDER BY j.id LIMIT 1) AS reason
    FROM positions p ORDER BY p.id`).all().map((pos) => ({
    ...pos, unrealized: unrealized(pos, pos.last_mark), stale: !!pos.stale,
  }));
  const marginLocked = positions.reduce((s, x) => s + x.margin, 0);
  const unreal = positions.reduce((s, x) => s + x.unrealized, 0);
  return {
    startingBalance: p.starting_balance,
    cash: p.cash,
    marginLocked,
    unrealized: unreal,
    equity: p.cash + marginLocked + unreal,
    halted: !!p.halted,
    positions,
  };
}

export function portfolioView(dbPath, cfg) {
  return pdb(dbPath, cfg, (db) => ({
    ...viewInDb(db),
    trades: db.prepare(TRADES_QUERY).all(50),
    journal: db.prepare('SELECT * FROM bot_journal ORDER BY id DESC LIMIT 50').all(),
  }));
}
