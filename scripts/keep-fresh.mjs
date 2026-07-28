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
  readSettings, dbg, barsForSpan, parseWatchers, runWatcherCycle, DEFAULT_ARGS,
  applyWatcherSettings, isServerOwned, refreshHtfCache,
} from './supertrend.mjs';
import { normCombo } from './bot.mjs';
import { isSettingOn } from './lib/settings-util.mjs';

// Default ON like sentinelSourceFootnotes: unset/'1'/true is on, '0'/false is off.
const isKeepFreshOn = (v) => (v === undefined ? true : isSettingOn(v));

const log = (msg) => dbg(`[keep-fresh] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MASTER_TICK_MS = 60000;
// #193/#195: single scheduled process — the server heartbeat runs the same
// decision cycle the LaunchAgent's plist ran by default (StartCalendarInterval
// minutes 1,6,11,...,56 — one minute after every M5 candle close), but now
// PER WATCHED GRANULARITY: `cycleMinutes[gran]` (default 5) sets that
// granularity's own candle-aligned cadence — minute % n === 1 % n is "in
// phase", and a bucket (floor(epoch ms / n min)) newer than that
// granularity's last cycle bucket is "not yet run this bar", so a restart
// mid-bucket waits for the next in-phase minute instead of firing off-phase
// immediately (no RunAtLoad-style burst). n=1 (M1) is in-phase every tick.
export const cycleCadenceMinutes = (cfg, gran) => {
  const n = Number(cfg?.cycleMinutes?.[gran]);
  return Number.isInteger(n) && n >= 1 ? n : 5;
};
export const cycleBucketFor = (nowMs, n) => Math.floor(nowMs / (n * 60000));
export const isCycleDue = (nowMs, n) => new Date(nowMs).getMinutes() % n === 1 % n;
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
// per-tick (checked every tick, so toggling needs no restart). The cycle and
// the sweep each have their OWN in-flight guard (#193 review): a stuck LLM
// cycle spanning multiple 60s ticks must never starve chart freshness, so a
// sweep still runs on every tick even while a cycle from a prior tick is
// still in flight.
// One status-shape source (#193 review): both the no-fetcher fixture path
// and the real getCycleStatus() build the same {lastCycleAt, lastCycleError}
// object from the same two closure vars, never two hand-written copies.
const cycleStatus = (lastCycleAt, lastCycleError) => ({
  lastCycleAt: lastCycleAt == null ? null : new Date(lastCycleAt).toISOString(),
  lastCycleError,
});

export function startKeepFresh({
  dbPath, settingsPath, fetcher, now = Date.now, logFn = log, tickMs = MASTER_TICK_MS,
  attempted = new Set(), lastLiveFetch, liveGateMs,
  runCycle = runWatcherCycle,
} = {}) {
  if (!fetcher) return { stop() {}, tick: async () => {}, getCycleStatus: () => cycleStatus(null, null) };
  // #195 review: ONE shared in-flight flag starved every granularity but M1
  // (M1's cadence keeps it in-flight at every :X1 minute once its own cycle
  // runs longer than 60s) — per-granularity tracking so a slow M1 cycle never
  // blocks a due M5/M15 cycle from starting.
  const cycleInFlight = new Set();
  let sweepInFlight = false;
  let lastCycleAt = null; // null = never run
  const lastCycleBucket = new Map(); // per-granularity: unset = never run, waits for the next in-phase minute (no immediate off-phase fire)
  let lastCycleError = null;
  const backoff = new Map(); // per-combo never-fresh backoff, lives as long as this loop
  const tick = async () => {
    const cfg = readSettings(settingsPath);
    // #193: decision cycle FIRST (latency-sensitive, matches the watcher's own
    // comment) — fired without blocking the sweep below. Read watcherOwner AT
    // RUN TIME (not at process start) — the single-owner guard's server-side
    // half. Owner flip hygiene: the moment ownership moves away from the
    // server, its stamped error clears (nothing else to stamp — the
    // LaunchAgent's own run, if any, isn't this process's to report on).
    if (isServerOwned(cfg)) {
      const nowMs = now();
      // #195: distinct granularities among the watched combos, each due
      // independently on its own cycleMinutes cadence. Fallback combo (no
      // `watchers` configured) mirrors the settings-over-defaults merge CLI
      // main() applies, so a bare settings.instrument/granularity override
      // still reaches the cycle the way it did pre-#195.
      const fallback = applyWatcherSettings({ instrument: DEFAULT_ARGS.instrument, granularity: DEFAULT_ARGS.granularity }, cfg);
      const allCombos = parseWatchers(cfg, fallback);
      const grans = [...new Set(allCombos.map((c) => c.granularity))];
      const dueGrans = grans.filter((gran) => {
        if (cycleInFlight.has(gran)) return false; // its own prior cycle still running
        const n = cycleCadenceMinutes(cfg, gran);
        if (!isCycleDue(nowMs, n)) return false;
        const bucket = cycleBucketFor(nowMs, n);
        const last = lastCycleBucket.get(gran);
        return last == null || bucket > last;
      });
      if (dueGrans.length) {
        // stamp the ATTEMPT (not just success) and each due granularity's
        // bucket + in-flight flag BEFORE the async call: a failing/slow cycle
        // still claims this bar instead of retrying every 60s tick within the
        // same bucket, and never runs twice concurrently for the same gran.
        for (const gran of dueGrans) {
          lastCycleBucket.set(gran, cycleBucketFor(nowMs, cycleCadenceMinutes(cfg, gran)));
          cycleInFlight.add(gran);
        }
        lastCycleAt = nowMs;
        // #195 review: co-due granularities run CONCURRENTLY (each its own
        // in-flight flag, cleared independently on completion) instead of a
        // serial loop that let one slow cycle delay every other due gran.
        // The HTF/news cache refresh tail is hoisted OUT of runWatcherCycle
        // and run once here for the union of due combos, not once per
        // granularity (opts.skipCacheRefresh: true skips it inside the cycle).
        Promise.allSettled(dueGrans.map(async (gran) => {
          // scope this granularity's watched combos only — a due
          // granularity cycles its own combos, not every watched combo.
          const combos = allCombos.filter((c) => c.granularity === gran);
          // the same settings-over-defaults merge CLI main() applies —
          // without it an empty `watchers` would fall back to DEFAULT_ARGS'
          // combo and run the wrong instrument from the server. #193 review:
          // freshBars defaults to the plist's operating value (1), not the
          // CLI's looser default (2), when settings don't say otherwise.
          const opts = applyWatcherSettings(
            { ...DEFAULT_ARGS, freshBars: 1, notify: true, pretty: false, db: dbPath, settings: settingsPath, combos, skipCacheRefresh: true },
            cfg,
          );
          try {
            await runCycle(opts, cfg);
          } finally {
            cycleInFlight.delete(gran);
          }
        })).then(async (settled) => {
          const firstFailure = settled.find((r) => r.status === 'rejected');
          if (firstFailure) logFn(`[watcher-cycle] failed: ${firstFailure.reason?.message}`);
          lastCycleError = firstFailure ? firstFailure.reason?.message ?? String(firstFailure.reason) : null;
          // hoisted cache tail: once per master tick for the union of due
          // combos, regardless of how many granularities were due (each
          // per-granularity runCycle above skipped it via skipCacheRefresh).
          try {
            await refreshHtfCache(dbPath, allCombos, cfg);
          } catch (err) {
            logFn(`HTF cache refresh failed: ${err.message}`);
          }
          try {
            const { refreshNewsCache } = await import('./news.mjs');
            await refreshNewsCache(dbPath, allCombos, cfg);
          } catch (err) {
            logFn(`news cache refresh failed: ${err.message}`);
          }
        });
      }
    } else {
      lastCycleError = null;
    }
    if (sweepInFlight) return;
    sweepInFlight = true;
    try {
      if (isKeepFreshOn(cfg.keepFresh)) {
        await sweepAll(dbPath, settingsPath, { fetcher, now, attempted, logFn, lastLiveFetch, liveGateMs, backoff });
      }
    } catch (err) {
      logFn(`tick failed: ${err.message}`);
    } finally {
      sweepInFlight = false;
    }
  };
  const timer = setInterval(() => { tick().catch((err) => logFn(`tick failed: ${err.message}`)); }, tickMs);
  timer.unref?.(); // never keep the process alive on its own
  return {
    stop: () => clearInterval(timer),
    tick,
    // #193: /api/health reads this — a bot/LLM failure never breaks chart serving.
    getCycleStatus: () => cycleStatus(lastCycleAt, lastCycleError),
  };
}
