// #191 proactive keep-fresh: a background loop that keeps every combo the
// operator has ever configured or stored candles for warm in SQLite, so a
// chart opened cold is never staring at a multi-hour-old series waiting on
// #190's on-read gap repair. Builds directly on #190's fetchCandles/findGaps/
// repairGap — no forked fetch/repair logic here, only scheduling.
import { fetchCandles, findGaps, repairGap, storeCandles, granularityMs, withDb, readSettings } from './supertrend.mjs';

const dbg = (msg) => process.stderr.write(`[keep-fresh] ${msg}\n`);

// One cadence per granularity (ms) — the plan's table. Intraday grains that
// share a natural bucket (M1+M5, M15+M30, H1+H4) share a cadence so the master
// tick only has to track 3 distinct due-times, not 6.
export const CADENCE_MS = {
  M1: 5 * 60000, M5: 5 * 60000,
  M15: 15 * 60000, M30: 15 * 60000,
  H1: 60 * 60000, H4: 60 * 60000,
};
export const GRANULARITIES = Object.keys(CADENCE_MS);
export const MASTER_TICK_MS = 60000;
export const INTER_REQUEST_DELAY_MS = 250; // politeness: serial sweep, small gap between live requests

// Pure scheduling: which granularity buckets are due this tick. A bucket with
// no prior sweep (undefined lastSweepAt entry) is due immediately (cold start).
export function dueGranularities(lastSweepAt, now, cadence = CADENCE_MS) {
  return Object.keys(cadence).filter((g) => now - (lastSweepAt[g] ?? -Infinity) >= cadence[g]);
}

// Universe: every instrument the operator has configured (bot combos or
// watchers) or ever stored candles for, crossed with every supported
// granularity — so a combo nobody trades but might chart is still warm.
// Recomputed per sweep (cheap query) so config changes take effect without a
// restart.
export function instrumentUniverse(dbPath, settingsPath) {
  const cfg = readSettings(settingsPath);
  const botKeys = cfg?.bot?.bots && typeof cfg.bot.bots === 'object' ? Object.keys(cfg.bot.bots) : [];
  const fromBots = botKeys.map((k) => String(k).split('|')[0].trim()).filter(Boolean);
  const fromWatchers = (cfg.watchers ?? '').split(',').map((x) => x.split('|')[0].trim()).filter(Boolean);
  const fromDb = withDb(dbPath, (db) => db.prepare('SELECT DISTINCT instrument FROM candles').all().map((r) => r.instrument));
  return [...new Set([...fromBots, ...fromWatchers, ...fromDb])];
}

// Bounded tail-fetch count: enough bars to cover the staleness plus a small
// pad, capped at the same 2500 the provider caps a single request to (#190).
export function tailFetchCount(staleMs, granMs) {
  return Math.max(Math.min(Math.ceil(staleMs / granMs) + 2, 2500), 1);
}

// One combo: skip (no request) when the newest stored bar is within one
// granularity period of now; otherwise tail-fetch, store, and repair any
// resulting gaps (shared attempted-memory with the on-read path).
export async function sweepCombo(dbPath, instrument, granularity, { fetcher, now = Date.now, attempted, log = dbg } = {}) {
  const granMs = granularityMs(granularity);
  const newest = withDb(dbPath, (db) => db.prepare(
    'SELECT MAX(time) AS t FROM candles WHERE instrument=? AND granularity=?').get(instrument, granularity)?.t ?? null);
  const newestMs = newest ? Date.parse(newest) : null;
  const nowMs = now();
  // candle `time` is the bar OPEN time: a fully-current series' newest bar
  // opened up to ~1×granMs ago, so "fresh" means within 2×granMs (one full
  // bar-close period) — ≤1× would misread current series as stale every sweep.
  if (newestMs != null && nowMs - newestMs <= 2 * granMs) {
    log(`skip ${instrument}|${granularity} (fresh, last=${newest})`);
    return { fetched: false };
  }
  const staleMs = newestMs != null ? nowMs - newestMs : granMs * 3;
  const count = tailFetchCount(staleMs, granMs);
  const rows = await fetcher({ instrument, granularity, count });
  const complete = rows.filter((c) => c.complete);
  if (complete.length) storeCandles(dbPath, instrument, granularity, complete);
  log(`tail-fetched ${complete.length}/${rows.length} ${instrument}|${granularity} (stale ${Math.round(staleMs / 1000)}s, count=${count})`);
  const times = withDb(dbPath, (db) => db.prepare(
    'SELECT time FROM candles WHERE instrument=? AND granularity=? ORDER BY time').all(instrument, granularity)
    .map((r) => Date.parse(r.time)));
  const gaps = findGaps(times, granMs);
  for (const gap of gaps) {
    // one gap failing to repair must not stop the sweep (error isolation)
    try { await repairGap(dbPath, instrument, granularity, gap, { fetcher, attempted }); }
    catch (err) { log(`gap repair failed ${instrument}|${granularity}: ${err.message}`); }
  }
  return { fetched: true, stored: complete.length };
}

// Sweep every instrument in the universe at one due granularity, strictly
// serial with a politeness delay between actual (non-skipped) requests, and
// one combo's failure isolated so it never stops the sweep.
export async function sweepGranularity(dbPath, settingsPath, granularity, { fetcher, now = Date.now, attempted, log = dbg, delayMs = INTER_REQUEST_DELAY_MS } = {}) {
  const instruments = instrumentUniverse(dbPath, settingsPath);
  for (const instrument of instruments) {
    try {
      const { fetched } = await sweepCombo(dbPath, instrument, granularity, { fetcher, now, attempted, log });
      if (fetched && delayMs) await new Promise((r) => setTimeout(r, delayMs));
    } catch (err) {
      log(`sweep failed ${instrument}|${granularity}: ${err.message}`);
    }
  }
}

// The master loop. Fixture safety: no live fetcher (tests pass `fetcher:
// null`) → never sweeps, no timer created at all. `keepFresh: false` in
// settings disables per-tick (checked every tick, so toggling needs no
// restart). An in-flight guard stops the next tick from overlapping a sweep
// still running (review risk #3).
export function startKeepFresh({ dbPath, settingsPath, fetcher, now = Date.now, log = dbg, tickMs = MASTER_TICK_MS, attempted = new Set() } = {}) {
  if (!fetcher) return { stop() {}, tick: async () => {} };
  const lastSweepAt = {};
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    const cfg = readSettings(settingsPath);
    if (cfg.keepFresh === false) return;
    const nowMs = now();
    const due = dueGranularities(lastSweepAt, nowMs);
    if (!due.length) return;
    inFlight = true;
    try {
      for (const g of due) {
        await sweepGranularity(dbPath, settingsPath, g, { fetcher, now, attempted, log });
        lastSweepAt[g] = now();
      }
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => { tick().catch((err) => log(`tick failed: ${err.message}`)); }, tickMs);
  timer.unref?.(); // never keep the process alive on its own
  return { stop: () => clearInterval(timer), tick };
}
