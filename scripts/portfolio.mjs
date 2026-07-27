#!/usr/bin/env node
// Virtual portfolio core (issue #22, epic #27). Paper money only.
// All mutations live here and are journaled; the HTTP layer must only ever
// import the read-side (portfolioView). CFD-style exposure: a trade specifies
// notional; margin = notional / leverage; fixed per-instrument spread is paid
// once on entry.
import { readFileSync } from 'node:fs';
import { withDb, LOCAL_TZ } from './supertrend.mjs';
import { positionAttribution } from './evaluation.mjs';

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
);
-- One row per completed one-time migration, keyed by name. Crash-safety
-- anchor for #169's backfill: "did I ALTER a column" is not the same fact
-- as "did the backfill finish" (a crash between the two would otherwise
-- leave derivable rows permanently NULL), so the marker is only written
-- AFTER the backfill returns, not alongside the ALTER.
CREATE TABLE IF NOT EXISTS migrations (
  key TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`;

export const BOT_DEFAULTS = {
  startingBalance: 10000,
  riskPct: 1,
  maxPositions: 3,
  leverageCap: 20,
  defaultLeverage: 10,
  commission: 0,
  staleAfterMs: 10 * 60 * 1000, // #163: absent-from-quotes staleness threshold
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

// #169: the granularity-column migration (ALTER + one-time backfill) is
// idempotent but not free — same "run once per db file per process" pattern
// strategies.mjs uses for its scope columns.
const granularityMigrated = new Set();

function addColumnIfMissing(db, table, col, ddl) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); return true; } catch (err) {
    if (/duplicate column/i.test(String(err?.message))) return false;
    throw err;
  }
}

function pdb(dbPath, cfg, fn) {
  return withDb(dbPath, (db) => {
    db.exec(DDL);
    // #163: additive column for the last markToMarket timestamp, so staleness
    // can be detected even when an instrument is absent from a run's quotes
    // map (positions previously had no mark-time record at all). Same
    // try/catch-duplicate-column pattern as chatDb's migration in signal-server.
    try {
      db.exec('ALTER TABLE positions ADD COLUMN last_mark_at TEXT');
    } catch (err) {
      if (!/duplicate column/i.test(String(err?.message))) throw err;
    }
    if (!granularityMigrated.has(dbPath)) {
      // #169: durable per-position granularity, additive on both tables so
      // old rows stay NULL ("unattributed") until backfilled below.
      addColumnIfMissing(db, 'positions', 'granularity', 'TEXT');
      addColumnIfMissing(db, 'bot_trades', 'granularity', 'TEXT');
      // Crash-safe: keyed on the migrations MARKER, not on whether the ALTER
      // just added a column. A crash after the columns land but before this
      // marker is set would otherwise make the next start's ALTERs both hit
      // duplicate-column and skip backfill forever, leaving derivable rows
      // NULL permanently. backfillGranularity() only ever touches rows WHERE
      // granularity IS NULL, so re-running it (crash-recovery or otherwise)
      // is always safe.
      if (!db.prepare('SELECT 1 FROM migrations WHERE key=?').get('granularity_backfill_169')) {
        backfillGranularity(dbPath, db);
        db.prepare('INSERT OR IGNORE INTO migrations (key, applied_at) VALUES (?,?)')
          .run('granularity_backfill_169', new Date().toISOString());
      }
      granularityMigrated.add(dbPath);
    }
    const seeded = db.prepare('INSERT OR IGNORE INTO portfolio (id, starting_balance, cash, created_at) VALUES (1,?,?,?)')
      .run(cfg.startingBalance, cfg.startingBalance, new Date().toISOString());
    if (seeded.changes > 0) journal(db, 'init', null, 'portfolio seeded', { startingBalance: cfg.startingBalance });
    return fn(db);
  });
}

// One-time backfill (plan item 3): derive granularity for pre-#169 rows from
// the same journal walk positionAttribution() already does, writing only
// rows that are actually derivable — anything the journal never attributed
// stays NULL ("unattributed"), same as it was pre-migration. Only ever
// touches rows WHERE granularity IS NULL, so it is safe to call again (it
// won't be, given the migrated-once guard above, but crash-safety requires
// this to be idempotent regardless).
function backfillGranularity(dbPath, db) {
  const attribution = positionAttribution(dbPath);
  const updatePos = db.prepare('UPDATE positions SET granularity=? WHERE id=? AND granularity IS NULL');
  const updateTrade = db.prepare('UPDATE bot_trades SET granularity=? WHERE position_id=? AND granularity IS NULL');
  for (const [positionId, a] of attribution) {
    if (!a.granularity) continue;
    updatePos.run(a.granularity, positionId);
    updateTrade.run(a.granularity, positionId);
  }
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

export function openPosition(dbPath, cfg, { instrument, side, notional, price, stop = null, target = null, reason = null, context = null, granularity = null } = {}) {
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

    if (maxMargin <= EPS) {
      // Budget for this instrument is genuinely exhausted — a legitimate
      // no-trade skip, not an execution rejection (#83). Name the cap that
      // actually bound (risk vs allocation), not always 'allocation'.
      const skipCap = riskCap <= allocCap ? 'risk' : 'allocation';
      journal(db, 'skip', null, `no budget (${skipCap} cap exhausted)`, {
        instrument, side, requestedNotional, effectiveNotional: 0, bindingCap: skipCap, leverage, equityNow, lockedHere,
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
      throw new Error(`invariant violated: sized margin ${margin.toFixed(2)} exceeds allocation cap ${allocCap.toFixed(2)}`);
    }
    const spread = instrumentSpread(cfg, instrument);
    const entry = side === 'long' ? price + spread : price - spread;
    const units = effectiveNotional / price;
    const cash = p.cash - margin - cfg.commission;
    db.prepare('UPDATE portfolio SET cash=? WHERE id=1').run(cash);
    const now = new Date().toISOString();
    const id = db.prepare(`INSERT INTO positions
      (instrument, side, notional, units, entry_price, entry_time, leverage, margin, stop, target, last_mark, last_mark_at, granularity)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(instrument, side, effectiveNotional, units, entry, now, leverage, margin, stop, target, price, now, granularity).lastInsertRowid;
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
    (position_id, instrument, side, notional, units, entry_price, entry_time, close_price, close_time, leverage, realized, close_reason, granularity)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(pos.id, pos.instrument, pos.side, pos.notional, pos.units, pos.entry_price, pos.entry_time, price, new Date().toISOString(), pos.leverage, realized, closeReason, pos.granularity ?? null);
  db.prepare('DELETE FROM positions WHERE id=?').run(positionId);
  journal(db, 'close', positionId, closeReason, { ...context, price, realized });
  return { positionId, realized, closeReason };
}

// Mark all positions against quotes {instrument: price}. An instrument that was
// QUOTED but came back without a usable price → keep last mark, flag stale. An
// instrument absent from the map was never asked about on this run, so its
// mark/price is left untouched: bot runs are per-combo (bot.mjs passes a
// single-instrument map), and staling every other instrument's position on
// every unrelated run made the flag flap. It is still flagged stale, though,
// once its last mark is older than the threshold — an instrument that stops
// being watched entirely must not look perpetually fresh (#163).
export function markToMarket(dbPath, cfg, quotes = {}) {
  // botConfig() already filters/validates against BOT_DEFAULTS, so cfg.staleAfterMs
  // is always a valid positive number here — no need to re-validate.
  const { staleAfterMs } = cfg;
  return pdb(dbPath, cfg, (db) => {
    const closed = [];
    const now = new Date().toISOString();
    for (const pos of db.prepare('SELECT * FROM positions').all()) {
      // own-property only: `in` would count prototype keys, so an instrument
      // named "constructor" would take the quoted path and get staled.
      if (!Object.hasOwn(quotes, pos.instrument)) {
        // Only ever SET stale here, never clear — clearing is the quoted-and-
        // usable path below; an absent instrument stays untouched unless its
        // mark has aged past the threshold (#163), same "leave it alone"
        // contract #151 relies on for the common per-combo-run case.
        // No last_mark_at yet (legacy row, or never marked) → treat as fresh
        // (age 0): it gets stamped on the next successful mark rather than
        // being instantly flagged stale.
        const ageMs = pos.last_mark_at ? Date.now() - Date.parse(pos.last_mark_at) : 0;
        if (ageMs > staleAfterMs && !pos.stale) {
          db.prepare('UPDATE positions SET stale=1 WHERE id=?').run(pos.id);
        }
        continue;
      }
      const q = quotes[pos.instrument];
      if (!(q > 0)) {
        db.prepare('UPDATE positions SET stale=1 WHERE id=?').run(pos.id);
        continue;
      }
      db.prepare('UPDATE positions SET last_mark=?, last_mark_at=?, stale=0 WHERE id=?').run(q, now, pos.id);
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
  return pdb(dbPath, cfg, (db) => {
    const view = viewInDb(db);
    const trades = db.prepare(TRADES_QUERY).all(50);
    // #163: realizedTotal is SUM(realized) over ALL bot_trades — the 50-row
    // TRADES_QUERY slice above is display-only and would silently undercount
    // once a bot has traded more than 50 times.
    const realizedTotal = db.prepare('SELECT COALESCE(SUM(realized),0) r FROM bot_trades').get().r;
    // dayPnl formula: realized P&L from trades whose close_time falls on
    // today (server machine's local calendar day — this is a single-trader
    // local app, so "trader-local" == the process's own local timezone, same
    // basis localFull/localHm already use) + the portfolio's CURRENT total
    // unrealized (open positions' P&L isn't attributable to a single day).
    const dayRealized = db.prepare("SELECT COALESCE(SUM(realized),0) r FROM bot_trades WHERE date(close_time,'localtime')=date('now','localtime')").get().r;
    const dayPnl = dayRealized + view.unrealized;
    return {
      ...view,
      trades,
      realizedTotal,
      dayPnl,
      journal: db.prepare('SELECT * FROM bot_journal ORDER BY id DESC LIMIT 50').all(),
      // #163: the one tz pipeline — server exposes its trader timezone once;
      // every client-rendered timestamp formats with `timeZone: tz` instead
      // of a server-formatted *_local field per row.
      tz: LOCAL_TZ,
    };
  });
}

// The canonical trade timeline (issue #162, docs/ux-redesign-plan.md §3): one
// shape for a position's whole life, open or closed — open positions first
// (chronology doesn't matter for a handful of live positions), then closed
// trades from bot_trades newest-first. Attribution (combo/granularity/
// strategyName) comes from the single shared positionAttribution() walk —
// null for anything the journal never attributed.
export function tradeTimeline(dbPath, cfg, { instrument = null, granularity = null, state = null, limit = 100 } = {}) {
  // computed before pdb() so we never hold two connections to the same db
  const attribution = positionAttribution(dbPath);
  return pdb(dbPath, cfg, (db) => {
    const openAgeMin = (t) => Math.round((Date.now() - Date.parse(t)) / 60000);
    // closed rows: ageMin is the HOLD duration, not elapsed-since-entry —
    // otherwise it grows forever after close (#162 finding).
    const closedAgeMin = (entry, close) => Math.round((Date.parse(close) - Date.parse(entry)) / 60000);
    // #169: prefer the row's OWN granularity column over the journal-derived
    // value — it's already in hand (no extra query) and survives even when
    // the decision journal never carried granularity (legacy/backfilled
    // rows). combo is recomputed from it rather than trusting a.combo, which
    // may still reflect the journal's (possibly stale) granularity.
    const granFor = (row, a) => row.granularity ?? a?.granularity ?? null;
    const rowFor = (row, a, gran) => ({
      combo: row.instrument && gran ? `${row.instrument}|${gran}` : null,
      strategyName: a?.strategyName ?? null,
    });

    // openReason: same per-position subquery pattern as viewInDb() — one query
    // for all positions instead of one bot_journal SELECT per position (N+1).
    const openRows = state === 'closed' ? [] : db.prepare(`SELECT p.*,
        (SELECT reason FROM bot_journal j WHERE j.position_id = p.id AND j.action = 'open' ORDER BY j.id LIMIT 1) AS openReason
      FROM positions p ORDER BY p.id DESC`).all()
      .filter((p) => (!instrument || p.instrument === instrument))
      .map((p) => {
        const a = attribution.get(p.id) ?? null;
        const gran = granFor(p, a);
        if (granularity && gran !== granularity) return null;
        const pnl = unrealized(p, p.last_mark);
        const { openReason } = p;
        return {
          id: p.id, state: 'open', instrument: p.instrument, granularity: gran,
          ...rowFor(p, a, gran), side: p.side, notional: p.notional, units: p.units, leverage: p.leverage,
          margin: p.margin, entryPrice: p.entry_price, entryTime: p.entry_time,
          mark: p.last_mark, exitTime: null, stop: p.stop, target: p.target,
          pnl, pnlPct: p.margin > 0 ? Math.round((pnl / p.margin) * 10000) / 100 : null,
          stale: !!p.stale, closeReason: null, openReason, ageMin: openAgeMin(p.entry_time),
        };
      }).filter(Boolean);

    // Instrument filter pushed into SQL; granularity needs attribution so it
    // stays post-SQL — iterate newest-first and stop at the remaining budget
    // instead of loading the whole trade history.
    const closedBudget = state === 'open' ? 0 : Math.max(0, limit - openRows.length);
    const closedRows = [];
    if (closedBudget > 0) {
      // #166 AC: closed rows get the same [why? ▸] as open ones — one
      // prepared statement reused per row (no N+1 query *planning*), same
      // bot_journal open-row lookup keyed by position_id as openRows above.
      const openReasonStmt = db.prepare("SELECT reason FROM bot_journal WHERE position_id=? AND action='open' ORDER BY id LIMIT 1");
      const stmt = instrument
        ? db.prepare('SELECT * FROM bot_trades WHERE instrument=? ORDER BY id DESC').iterate(instrument)
        : db.prepare('SELECT * FROM bot_trades ORDER BY id DESC').iterate();
      // Bounded scan (mirrors /api/bots' lastDecisionByCombo): granularity-only
      // filters have no SQL pushdown, so cap the walk instead of scanning the
      // whole table.
      const SCAN_CEILING = 20000;
      let scanned = 0;
      for (const t of stmt) {
        if (closedRows.length >= closedBudget || scanned >= SCAN_CEILING) break;
        scanned++;
        const a = attribution.get(t.position_id) ?? null;
        const gran = granFor(t, a);
        if (granularity && gran !== granularity) continue;
        // margin isn't stored on bot_trades but is derivable — keeps pnlPct
        // comparable across open and closed rows (plan §3)
        const margin = t.leverage > 0 ? t.notional / t.leverage : null;
        closedRows.push({
          id: t.position_id, state: 'closed', instrument: t.instrument, granularity: gran,
          ...rowFor(t, a, gran), side: t.side, notional: t.notional, units: t.units, leverage: t.leverage,
          margin, entryPrice: t.entry_price, entryTime: t.entry_time,
          mark: t.close_price, exitTime: t.close_time, stop: null, target: null,
          pnl: t.realized, pnlPct: margin > 0 ? Math.round((t.realized / margin) * 10000) / 100 : null, stale: false, closeReason: t.close_reason,
          openReason: openReasonStmt.get(t.position_id)?.reason ?? null, ageMin: closedAgeMin(t.entry_time, t.close_time),
        });
      }
    }

    return [...openRows, ...closedRows].slice(0, limit);
  });
}
