// #191 proactive keep-fresh: a background loop that keeps every combo the
// operator has ever configured or stored candles for warm in SQLite, so a
// chart opened cold is never staring at a multi-hour-old series waiting on
// #190's on-read gap repair. Builds directly on #190's fetchCandles/findGaps/
// repairGap — no forked fetch/repair logic here, only scheduling.
//
// Ownership split vs supertrend.mjs's refreshHtfCache: the watcher process's
// refreshHtfCache warms the HTF ladder (M15/M30/H1/H4) it needs for ITS OWN
// watched combos during its own ticks. This module owns chart completeness
// for every combo the server might be asked to render, including combos the
// watcher never touches. Deliberately not merged — different owners, different
// lifetimes — and the shared 2×granMs freshness skip means the two overlap
// request-free: whichever one last fetched a combo makes the other a no-op.
import {
  fetchCandles, findGaps, repairGap, storeCandles, granularityMs, withDb,
  readSettings, dbg, barsForSpan, parseWatchers,
} from './supertrend.mjs';
import { normCombo } from './bot.mjs';
import { isSettingOn } from './lib/settings-util.mjs';

// Default ON like sentinelSourceFootnotes: unset/'1'/true is on, '0'/false is off.
const isKeepFreshOn = (v) => (v === undefined ? true : isSettingOn(v));

const log = (msg) => dbg(`[keep-fresh] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MASTER_TICK_MS = 60000;
const INTER_REQUEST_DELAY_MS = 250; // politeness: serial sweep, small gap between live requests
export const MAX_GAP_REPAIRS_PER_COMBO = 3; // residual gaps re-detect and repair next sweep
export const BOOTSTRAP_SEED_BARS = 500; // a never-fetched combo seeds deep, not staleness-derived
export const NEVER_FRESH_BACKOFF_MS = 30 * 60000; // a zero-row fetch (closed market, dead symbol) backs off this long

// Configured combos: watchers CSV ∪ bot.bots keys, both parsed with the
// existing helpers (parseWatchers, normCombo) — no hand-rolled splitting.
export function configuredCombos(cfg) {
  const watcherCfg = { ...cfg, watchers: String(cfg.watchers ?? '') };
  const watcherCombos = parseWatchers(watcherCfg, null).filter((c) => c?.instrument);
  const botKeys = cfg?.bot?.bots && typeof cfg.bot.bots === 'object' ? Object.keys(cfg.bot.bots) : [];
  const botCombos = botKeys.map(normCombo).filter((k) => k && k !== '|').map((k) => {
    const [instrument, granularity = 'M5'] = k.split('|');
    return { instrument, granularity };
  });
  return [...watcherCombos, ...botCombos];
}

// Universe = reality, not a cross product: configured combos ∪ DISTINCT
// (instrument, granularity) pairs actually present in candles — so a combo
// nobody configured but that has history (e.g. a deep-linked view) stays warm
// too, without fanning out to every instrument × every granularity.
export function comboUniverse(dbPath, settingsPath) {
  const cfg = readSettings(settingsPath);
  const stored = withDb(dbPath, (db) => db.prepare('SELECT DISTINCT instrument, granularity FROM candles').all());
  const byKey = new Map();
  for (const c of [...configuredCombos(cfg), ...stored]) {
    if (c?.instrument && c?.granularity) byKey.set(`${c.instrument}|${c.granularity}`, { instrument: c.instrument, granularity: c.granularity });
  }
  return [...byKey.values()];
}

// One sweep of the whole universe: batches newest-bar lookups in ONE withDb
// open (mirrors refreshHtfCache's pattern), then per combo — skip when fresh
// (candle `time` is the bar OPEN, so a fully-current series' newest bar opened
// up to ~1×granMs ago: "fresh" is within 2×granMs, one full bar-close period)
// or when the on-read path (signal-server's lastLiveFetch) already fetched it
// inside ITS gate window; otherwise tail-fetch, store, and repair up to
// MAX_GAP_REPAIRS_PER_COMBO gaps in the freshly fetched window only (not full
// history), throttled by the same politeness delay between every live request.
export async function sweepAll(dbPath, settingsPath, {
  fetcher, now = Date.now, attempted = new Set(), logFn = log,
  delayMs = INTER_REQUEST_DELAY_MS, lastLiveFetch, liveGateMs,
  backoff,
} = {}) {
  const combos = comboUniverse(dbPath, settingsPath);
  if (!combos.length) return { fetched: 0, skipped: 0 };
  const nowMs = now();
  const newest = withDb(dbPath, (db) => {
    const stmt = db.prepare('SELECT MAX(time) AS t FROM candles WHERE instrument=? AND granularity=?');
    const out = {};
    for (const c of combos) out[`${c.instrument}|${c.granularity}`] = stmt.get(c.instrument, c.granularity)?.t ?? null;
    return out;
  });

  let fetched = 0;
  let skipped = 0;
  const fetchKey = (dbPathArg, key) => `${dbPathArg}|${key}`;
  for (const combo of combos) {
    const key = `${combo.instrument}|${combo.granularity}`;
    try {
      const gate = lastLiveFetch?.get(fetchKey(dbPath, key));
      if (gate && nowMs - gate.at <= liveGateMs) { skipped++; continue; }
      const backoffUntil = backoff?.get(key);
      if (backoffUntil && nowMs < backoffUntil) { skipped++; continue; }
      const granMs = granularityMs(combo.granularity);
      const newestVal = newest[key];
      const parsed = newestVal ? Date.parse(newestVal) : NaN;
      // A missing OR unparseable MAX(time) is never-fetched territory (bootstrap
      // path), not a NaN stale-span — same "bad row self-heals" rule as
      // refreshHtfCache's ladder-staleness check.
      const bootstrap = newestVal == null || Number.isNaN(parsed);
      const newestMs = bootstrap ? null : parsed;
      if (!bootstrap && nowMs - newestMs <= 2 * granMs) { skipped++; continue; }
      const staleMs = bootstrap ? null : nowMs - newestMs;
      const count = bootstrap ? BOOTSTRAP_SEED_BARS : barsForSpan(staleMs, granMs);
      const rows = await fetcher({ instrument: combo.instrument, granularity: combo.granularity, count });
      const complete = rows.filter((c) => c.complete);
      if (complete.length) {
        storeCandles(dbPath, combo.instrument, combo.granularity, complete);
        backoff?.delete(key);
        // Two-way dedup: mirror the on-read gate (signal-server's lastLiveFetch)
        // so a chart opened right after this sweep reuses this fetch instead of
        // re-requesting the same tail.
        const tail = rows.find((c) => !c.complete) ?? null;
        lastLiveFetch?.set(fetchKey(dbPath, key), { at: nowMs, tail });
      } else {
        // Zero stored rows: closed market / unsupported granularity / dead
        // symbol — back off instead of hammering every 60s tick.
        backoff?.set(key, nowMs + NEVER_FRESH_BACKOFF_MS);
      }
      fetched++;
      logFn(`tail-fetched ${complete.length}/${rows.length} ${key} (stale ${bootstrap ? 'bootstrap' : `${Math.round(staleMs / 1000)}s`}, count=${count})`);
      if (delayMs) await sleep(delayMs);

      // Bounded gap scan: only the freshly fetched window (pre-fetch newest
      // minus one bar), not full history — the on-read path already owns full
      // history healing.
      const scanFrom = new Date((bootstrap ? nowMs : newestMs) - granMs).toISOString();
      const times = withDb(dbPath, (db) => db.prepare(
        'SELECT time FROM candles WHERE instrument=? AND granularity=? AND time >= ? ORDER BY time')
        .all(combo.instrument, combo.granularity, scanFrom).map((r) => Date.parse(r.time)));
      const gaps = findGaps(times, granMs).slice(0, MAX_GAP_REPAIRS_PER_COMBO);
      for (const gap of gaps) {
        try {
          await repairGap(dbPath, combo.instrument, combo.granularity, gap, { fetcher, attempted });
          if (delayMs) await sleep(delayMs);
        } catch (err) { logFn(`gap repair failed ${key}: ${err.message}`); }
      }
    } catch (err) {
      logFn(`sweep failed ${key}: ${err.message}`);
    }
  }
  logFn(`sweep summary: fetched=${fetched} skipped=${skipped} total=${combos.length}`);
  return { fetched, skipped };
}

// The master loop: one 60s tick sweeps the whole universe; the per-combo
// freshness check inside sweepAll is the only suppressor (no cadence table).
// Fixture safety: no live fetcher (tests/e2e pass `fetcher: null`) → never
// sweeps, no timer created at all. `keepFresh: false` in settings disables
// per-tick (checked every tick, so toggling needs no restart). An in-flight
// guard stops the next tick from overlapping a sweep still running.
export function startKeepFresh({
  dbPath, settingsPath, fetcher, now = Date.now, logFn = log, tickMs = MASTER_TICK_MS,
  attempted = new Set(), lastLiveFetch, liveGateMs,
} = {}) {
  if (!fetcher) return { stop() {}, tick: async () => {} };
  let inFlight = false;
  const backoff = new Map(); // per-combo never-fresh backoff, lives as long as this loop
  const tick = async () => {
    if (inFlight) return;
    const cfg = readSettings(settingsPath);
    if (!isKeepFreshOn(cfg.keepFresh)) return;
    inFlight = true;
    try {
      await sweepAll(dbPath, settingsPath, { fetcher, now, attempted, logFn, lastLiveFetch, liveGateMs, backoff });
    } catch (err) {
      logFn(`tick failed: ${err.message}`);
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => { tick().catch((err) => logFn(`tick failed: ${err.message}`)); }, tickMs);
  timer.unref?.(); // never keep the process alive on its own
  return { stop: () => clearInterval(timer), tick };
}
