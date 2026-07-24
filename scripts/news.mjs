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
import {
  fetchSentinelNews, createGdeltThrottle, resolveNewsApiAiConfig, normTitle,
} from '../skills/market-sentinel/scripts/sentinel_news.mjs';

// NewsAPI.ai provider persistence (issue #104), kept separate from the canonical
// `news` cache. news_provider_state holds the per-instrument request budget +
// circuit-breaker (cursor_news reserved, unused: the background poll uses the
// query-filtered getArticles endpoint, not the global minuteStream firehose).
// news_provider_observations is the append-only provenance log the trial
// benchmark reads — one row per (instrument, provider, item), first_seen_at
// preserved so "which provider saw it first" survives repeat polls.
const PROVIDER_STATE_DDL = `CREATE TABLE IF NOT EXISTS news_provider_state (
  provider TEXT NOT NULL, instrument TEXT NOT NULL,
  cursor_news TEXT, last_attempt_at TEXT, last_success_at TEXT,
  disabled_reason TEXT, disabled_until TEXT,
  requests_used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, instrument)
)`;
const PROVIDER_OBS_DDL = `CREATE TABLE IF NOT EXISTS news_provider_observations (
  instrument TEXT NOT NULL, provider TEXT NOT NULL, provider_item_id TEXT NOT NULL,
  canonical_url TEXT, normalized_title TEXT, publisher TEXT, source_uri TEXT,
  event_uri TEXT, published_at TEXT, first_seen_at TEXT NOT NULL,
  is_duplicate INTEGER, sentiment REAL,
  PRIMARY KEY (instrument, provider, provider_item_id)
)`;
export const NEWSAPI_AI_PROVIDER = 'newsapi-ai';

// Keyed on (instrument, url), NOT url alone: two instruments can share a
// sentinel query (e.g. WTI + Brent both query oil/OPEC/Hormuz, per
// config/instruments.yaml) and so can both legitimately see the same
// headline — a global UNIQUE(url) would bind a shared headline to only the
// FIRST instrument that polled it, leaving the second with no cached row
// (and an empty/wrong newsContextFor) for a story it should also see.
const NEWS_DDL = `CREATE TABLE IF NOT EXISTS news (
  instrument TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, time TEXT,
  summary TEXT, url TEXT NOT NULL, tone REAL, themes TEXT,
  escalation INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL,
  UNIQUE(instrument, url)
)`;

// Guarded rebuild (review fix for issue #86): an existing news table from
// before this change has a single-column UNIQUE(url) — re-key it to
// (instrument, url) so already-cached headlines survive. Same transactional
// rename -> create -> copy -> drop pattern as gate-prompts.mjs's
// migrateCheckConstraint: a crash mid-rebuild must never leave
// news_pre_instrument_key lingering (BEGIN IMMEDIATE/COMMIT/ROLLBACK).
// Every pre-migration row is unique on url alone, so re-inserting under the
// new (instrument, url) key can never collide.
// exported for the transactional-rollback test only (forces a mid-rebuild
// failure via a monkeypatched db.exec, same convention as gate-prompts.mjs).
export function migrateNewsUniqueKey(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='news'").get();
  if (row?.sql && /\burl\s+TEXT\s+NOT\s+NULL\s+UNIQUE\b/i.test(row.sql)) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('ALTER TABLE news RENAME TO news_pre_instrument_key');
      db.exec(NEWS_DDL);
      db.exec(`INSERT INTO news (instrument, source, title, time, summary, url, tone, themes, escalation, fetched_at)
        SELECT instrument, source, title, time, summary, url, tone, themes, escalation, fetched_at FROM news_pre_instrument_key`);
      db.exec('DROP TABLE news_pre_instrument_key');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

// The migration scan is idempotent but not free, and refreshNewsCache opens the
// DB per write on the watcher tick — run the heavy check once per db per process.
const migrated = new Set();

function newsDb(dbPath, fn) {
  return withDb(dbPath, (db) => {
    // CREATE IF NOT EXISTS is cheap and must run on every fresh connection
    // (:memory:, a recreated file); only the migrate scan is cached away.
    db.exec(NEWS_DDL);
    db.exec(PROVIDER_STATE_DDL);
    db.exec(PROVIDER_OBS_DDL);
    if (!migrated.has(dbPath)) {
      migrateNewsUniqueKey(db);
      migrated.add(dbPath);
    }
    return fn(db);
  });
}

// --- NewsAPI.ai request budget + circuit breaker (issue #104) ---------------
// The trial budget is a single global cap across all instruments: sum
// requests_used over every (provider, *) row and compare to the configured
// NEWSAPI_AI_REQUEST_BUDGET. Persisted, so it survives process restarts.
export function providerRequestsUsed(dbPath, provider = NEWSAPI_AI_PROVIDER) {
  return newsDb(dbPath, (db) =>
    db.prepare('SELECT COALESCE(SUM(requests_used),0) AS n FROM news_provider_state WHERE provider=?').get(provider).n);
}

// A persistent circuit is open when disabled_until is set and still in the
// future (401/403). Returns the reason string while open, else null.
export function providerCircuitOpen(dbPath, provider, instrument, now = Date.now()) {
  return newsDb(dbPath, (db) => {
    const row = db.prepare('SELECT disabled_reason, disabled_until FROM news_provider_state WHERE provider=? AND instrument=?').get(provider, instrument);
    if (!row?.disabled_until) return null;
    return Date.parse(row.disabled_until) > now ? (row.disabled_reason || 'circuit open') : null;
  });
}

// Record one chargeable attempt + its outcome in a single transaction: bump
// requests_used and last_attempt_at always; on success stamp last_success_at
// and clear any circuit; on 401/403 open a persistent circuit; on 429/5xx/etc
// leave the circuit closed (transient — retried next tick). `disabledForMs`
// bounds the 401/403 circuit so a rotated key can recover without a restart.
export function recordProviderCall(dbPath, provider, instrument, { ok, status, now = Date.now(), disabledForMs = 6 * 60 * 60 * 1000 } = {}) {
  return newsDb(dbPath, (db) => {
    const at = new Date(now).toISOString();
    db.prepare(`INSERT INTO news_provider_state (provider, instrument, requests_used, last_attempt_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(provider, instrument) DO UPDATE SET requests_used = requests_used + 1, last_attempt_at = excluded.last_attempt_at`)
      .run(provider, instrument, at);
    if (ok) {
      db.prepare('UPDATE news_provider_state SET last_success_at=?, disabled_reason=NULL, disabled_until=NULL WHERE provider=? AND instrument=?')
        .run(at, provider, instrument);
    } else if (status === 401 || status === 403) {
      db.prepare('UPDATE news_provider_state SET disabled_reason=?, disabled_until=? WHERE provider=? AND instrument=?')
        .run(`auth/quota HTTP ${status}`, new Date(now + disabledForMs).toISOString(), provider, instrument);
    }
  });
}

// Append-only provenance: one row per (instrument, provider, item). first_seen_at
// is preserved via DO NOTHING so a repeat poll never rewrites when THIS provider
// first saw the article. Free-source items key on their url (no providerItemId);
// items lacking any stable id are skipped. `provider` is the newsapi-ai tag or
// the free source name (google-news/gdelt/...).
export function recordProviderObservations(dbPath, instrument, items, now = Date.now()) {
  return newsDb(dbPath, (db) => {
    const at = new Date(now).toISOString();
    const stmt = db.prepare(`INSERT INTO news_provider_observations
      (instrument, provider, provider_item_id, canonical_url, normalized_title, publisher, source_uri, event_uri, published_at, first_seen_at, is_duplicate, sentiment)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(instrument, provider, provider_item_id) DO NOTHING`);
    let recorded = 0;
    for (const it of items) {
      const provider = it.provider || it.source;
      const itemId = it.providerItemId || it.url;
      if (!provider || !itemId) continue;
      recorded += stmt.run(
        instrument, provider, itemId, it.url ?? null, normTitle(it.title), it.source ?? null,
        it.sourceUri ?? null, it.eventUri ?? null, it.timeIso ?? null, at,
        typeof it.isDuplicate === 'boolean' ? (it.isDuplicate ? 1 : 0) : null,
        Number.isFinite(it.sentiment) ? it.sentiment : null,
      ).changes;
    }
    return { recorded };
  });
}

// Idempotent upsert keyed on (instrument, url) (same convention storeCandles
// uses on its own key): a headline already cached FOR THIS INSTRUMENT is
// never duplicated by a later poll — but a different instrument sharing the
// same query still gets its own row for the same headline (see NEWS_DDL).
export function upsertNews(dbPath, instrument, items, fetchedAt) {
  return newsDb(dbPath, (db) => {
    const stmt = db.prepare(`INSERT INTO news (instrument, source, title, time, summary, url, tone, themes, escalation, fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(instrument, url) DO NOTHING`);
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
      ON CONFLICT(instrument, url) DO UPDATE SET fetched_at=excluded.fetched_at`)
      .run(instrument, `poll marker: ${instrument}`, `local://news-poll-marker/${instrument}`, fetchedAt);
  });
}

// Poll at most this often per instrument (locked design: "per-instrument poll
// at most every ~5-10 min"); a per-tick watcher gate, not a scheduler.
export const NEWS_POLL_INTERVAL_MS = 8 * 60 * 1000;
// NewsAPI.ai-enabled instruments poll on a shorter interval — eligible on every
// M5 watcher tick (issue #104), giving a ~5-min cadence vs the free stack's
// ~8-min. 4 min so a 5-min tick is always due but a stray rapid re-tick isn't.
export const NEWSAPI_AI_POLL_INTERVAL_MS = 4 * 60 * 1000;
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
  env = process.env, // injectable so tests can drive NEWSAPI_AI_* without touching the real env
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

  // A NewsAPI.ai request is charged this tick only when the provider is enabled,
  // the persisted trial budget still has room, and no auth/quota circuit is open.
  // Budget is a single global cap, so it's read once and decremented locally as
  // instruments spend within the tick (re-read next tick from the DB).
  let budgetUsed = providerRequestsUsed(dbPath, NEWSAPI_AI_PROVIDER);
  const naiFor = (instrument) => {
    const c = resolveNewsApiAiConfig(env, { instrument });
    if (!c.enabled) return { cfg: c, active: false };
    if (budgetUsed >= c.requestBudget) return { cfg: c, active: false, budgetExhausted: true };
    if (providerCircuitOpen(dbPath, NEWSAPI_AI_PROVIDER, instrument, now)) return { cfg: c, active: false, circuitOpen: true };
    return { cfg: c, active: true };
  };

  const newest = newsDb(dbPath, (db) => {
    const stmt = db.prepare('SELECT MAX(fetched_at) AS t FROM news WHERE instrument=?');
    const out = {};
    for (const { instrument } of withConfig) out[instrument] = stmt.get(instrument)?.t ?? null;
    return out;
  });

  const due = withConfig.map((x) => ({ ...x, nai: naiFor(x.instrument) })).filter(({ instrument, nai }) => {
    const t = newest[instrument];
    const parsed = t ? Date.parse(t) : NaN;
    const ageMs = Number.isNaN(parsed) ? Infinity : now - parsed;
    // Shorter interval when NewsAPI.ai will actually run this tick, else free cadence.
    return ageMs > (nai.active ? NEWSAPI_AI_POLL_INTERVAL_MS : NEWS_POLL_INTERVAL_MS);
  });

  const toFetch = due.slice(0, cap);
  const skipped = due.slice(cap);
  if (skipped.length) {
    log(`per-tick cap (${cap}) reached, skipped ${skipped.map((c) => c.instrument).join(', ')}`);
  }

  // One throttle shared across this tick's GDELT calls (≥5s apart per IP).
  const gdeltThrottle = createGdeltThrottle(sleep ? { sleep, now: () => now } : {});
  const refreshed = [];
  for (const { instrument, sentinel, nai } of toFetch) {
    try {
      const result = await fetchSentinelNews({
        query: sentinel.query, yahooSymbol: sentinel.yahooSymbol, fetcher, now, log, gdeltThrottle,
        newsApiAi: nai.active ? nai.cfg : null,
      });
      const fetchedAt = new Date(now).toISOString();
      const { added } = upsertNews(dbPath, instrument, result.items, fetchedAt);
      recordPollMarker(dbPath, instrument, fetchedAt);
      // Charge the budget + drive the circuit breaker from the actual outcome.
      if (result.newsApiAi?.requestMade) {
        recordProviderCall(dbPath, NEWSAPI_AI_PROVIDER, instrument, { ok: result.newsApiAi.ok, status: result.newsApiAi.status, now });
        budgetUsed += 1;
      }
      // Provenance for the trial benchmark: every provider's in-window sighting.
      if (nai.active && Array.isArray(result.observed)) recordProviderObservations(dbPath, instrument, result.observed, now);
      refreshed.push({ instrument, added, escalation: result.escalation, newsApiAi: result.newsApiAi ?? null });
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
