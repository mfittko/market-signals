#!/usr/bin/env node
// Background news-sentinel cache (issue #86): staleness-gated, cache-only
// polling of the market-sentinel skill over TRACKED instruments (watchers ∪
// configured bots — the same union #81's HTF cache uses), plus the compact
// advisory context block the filter/bot prompts read from the cache.
// Cache-only: this module never evaluates signals, sends notifications, or
// runs bot deliberation — it purely grounds prompts + backs the on-demand tool.
// Static imports from supertrend.mjs are safe in this direction only because
// supertrend.mjs never statically imports this file back (it dynamically
// imports news.mjs at call sites instead, the same lazy-import convention it
// already uses for bot.mjs/memories.mjs/signal-server.mjs to dodge cycles).
import { withDb, trackedInstruments } from './supertrend.mjs';
import { sentinelConfigForInstrument, loadInstrumentsConfig } from './lib/instruments.mjs';
import { fetchSentinelNews, createGdeltThrottle } from '../skills/market-sentinel/scripts/sentinel_news.mjs';

const NEWS_DDL = `CREATE TABLE IF NOT EXISTS news (
  instrument TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, time TEXT,
  summary TEXT, url TEXT NOT NULL UNIQUE, tone REAL, themes TEXT,
  escalation INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL
)`;

function newsDb(dbPath, fn) {
  return withDb(dbPath, (db) => {
    db.exec(NEWS_DDL);
    return fn(db);
  });
}

// Idempotent upsert keyed on url (same convention storeCandles uses on its own
// key): a headline already cached (however it was first attributed) is never
// duplicated by a later poll or a different instrument's overlapping query.
export function upsertNews(dbPath, instrument, items, fetchedAt) {
  return newsDb(dbPath, (db) => {
    const stmt = db.prepare(`INSERT INTO news (instrument, source, title, time, summary, url, tone, themes, escalation, fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(url) DO NOTHING`);
    let added = 0;
    for (const it of items) {
      if (!it.url || !it.title) continue;
      added += stmt.run(
        instrument, it.source, it.title, it.timeIso ?? null, it.summary ?? null, it.url,
        Number.isFinite(it.tone) ? it.tone : null, it.themes ? JSON.stringify(it.themes) : null,
        it.escalation ? 1 : 0, fetchedAt,
      ).changes;
    }
    return { added };
  });
}

// A poll can legitimately return zero items (quiet news day, or every source
// down) — upsertNews then writes nothing, so MAX(fetched_at) would stay null
// forever and every future tick would treat the instrument as infinitely
// stale, re-fetching (and hammering the sources) on every tick. Record a
// per-instrument poll marker row instead: time=NULL, so newsContextFor's own
// `time IS NOT NULL` filter already excludes it from prompt context, but the
// staleness MAX(fetched_at) query below still picks it up. One row per
// instrument (upserted on its own stable url), not one per empty poll.
function recordPollMarker(dbPath, instrument, fetchedAt) {
  return newsDb(dbPath, (db) => {
    db.prepare(`INSERT INTO news (instrument, source, title, time, summary, url, tone, themes, escalation, fetched_at)
      VALUES (?, 'poll-marker', ?, NULL, NULL, ?, NULL, NULL, 0, ?)
      ON CONFLICT(url) DO UPDATE SET fetched_at=excluded.fetched_at`)
      .run(instrument, `poll marker: ${instrument}`, `local://news-poll-marker/${instrument}`, fetchedAt);
  });
}

// Poll at most this often per instrument (locked design: "per-instrument poll
// at most every ~5-10 min"); a per-tick watcher gate, not a scheduler.
export const NEWS_POLL_INTERVAL_MS = 8 * 60 * 1000;
export const NEWS_FETCH_CAP = 4; // bound per-tick fan-out across tracked instruments
export const NEWS_CONTEXT_WINDOW_HOURS = 24;
export const NEWS_CONTEXT_TOP_N = 5;

// Cache-only per-tick refresh: bounded, staleness-gated, failure-isolated.
// Mirrors refreshHtfCache's shape (#81): `combos` is whatever parseWatchers
// already resolved this tick; trackedInstruments folds in configured bot
// instruments too, same union the HTF cache uses.
export async function refreshNewsCache(dbPath, combos, cfg, {
  fetcher = undefined, log = (m) => process.stderr.write(`[news] ${m}\n`), now = Date.now(), cap = NEWS_FETCH_CAP,
  sleep = undefined, // injectable so tests spanning multiple GDELT calls need not sleep for real
} = {}) {
  const instruments = trackedInstruments(combos, cfg);
  if (!instruments.length) return { refreshed: [], skipped: [] };

  // Never guess a query: an instrument with no committed sentinel/yahooSymbol
  // entry in config/instruments.yaml is simply not tracked here.
  // parse the instruments config ONCE per tick, not per instrument
  const instrCfg = loadInstrumentsConfig();
  const withConfig = instruments
    .map((instrument) => ({ instrument, sentinel: sentinelConfigForInstrument(instrument, instrCfg) }))
    .filter((x) => x.sentinel);
  if (!withConfig.length) return { refreshed: [], skipped: [] };

  const newest = newsDb(dbPath, (db) => {
    const stmt = db.prepare('SELECT MAX(fetched_at) AS t FROM news WHERE instrument=?');
    const out = {};
    for (const { instrument } of withConfig) out[instrument] = stmt.get(instrument)?.t ?? null;
    return out;
  });

  const due = withConfig.filter(({ instrument }) => {
    const t = newest[instrument];
    const parsed = t ? Date.parse(t) : NaN;
    const ageMs = Number.isNaN(parsed) ? Infinity : now - parsed;
    return ageMs > NEWS_POLL_INTERVAL_MS;
  });

  const toFetch = due.slice(0, cap);
  const skipped = due.slice(cap);
  if (skipped.length) {
    log(`per-tick cap (${cap}) reached, skipped ${skipped.map((c) => c.instrument).join(', ')}`);
  }

  // One throttle shared across this tick's GDELT calls (≥5s apart per IP).
  const gdeltThrottle = createGdeltThrottle(sleep ? { sleep, now: () => now } : {});
  const refreshed = [];
  for (const { instrument, sentinel } of toFetch) {
    try {
      const result = await fetchSentinelNews({
        query: sentinel.query, yahooSymbol: sentinel.yahooSymbol, fetcher, now, log, gdeltThrottle,
      });
      const fetchedAt = new Date(now).toISOString();
      const { added } = upsertNews(dbPath, instrument, result.items, fetchedAt);
      recordPollMarker(dbPath, instrument, fetchedAt);
      refreshed.push({ instrument, added, escalation: result.escalation });
    } catch (err) {
      log(`refresh failed for ${instrument}: ${err.message}`);
    }
  }
  return { refreshed, skipped };
}

// Advisory context block for the filter + bot prompts (mirrors
// memoriesContext's "empty ⇒ null" convention): the caller omits the whole
// `sentinel` block from the payload when this returns null, per the locked
// design ("empty/no-news ⇒ block omitted").
export function newsContextFor(dbPath, instrument, { now = Date.now(), windowHours = NEWS_CONTEXT_WINDOW_HOURS, topN = NEWS_CONTEXT_TOP_N } = {}) {
  return newsDb(dbPath, (db) => {
    const cutoff = new Date(now - windowHours * 3600000).toISOString();
    const rows = db.prepare(
      'SELECT title, source, time, escalation FROM news WHERE instrument=? AND time IS NOT NULL AND time>=? ORDER BY time DESC LIMIT ?',
    ).all(instrument, cutoff, topN);
    if (!rows.length) return null;
    return {
      escalation: rows.some((r) => r.escalation === 1),
      headlines: rows.map((r) => ({ title: r.title, source: r.source, time: r.time })),
      asOf: rows[0].time,
    };
  });
}
