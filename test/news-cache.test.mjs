import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDb } from '../scripts/supertrend.mjs';
import {
  refreshNewsCache, newsContextFor, upsertNews, NEWS_POLL_INTERVAL_MS, migrateNewsUniqueKey,
  NEWSAPI_AI_POLL_INTERVAL_MS, NEWSAPI_AI_PROVIDER, providerRequestsUsed, providerCircuitOpen,
  recordProviderCall, recordProviderObservations,
  refreshNewsForDecision, sentinelDecisionContext, DECISION_PULL_THROTTLE_MS, DECISION_FETCH_TIMEOUT_MS,
} from '../scripts/news.mjs';

// getArticles JSON body for the WTI oil query — one article, newest-first.
function naiJson(title = 'Iran strikes tanker near Hormuz', uri = 'nai-1', dateTimePub = '2026-07-23T09:45:00Z') {
  return JSON.stringify({ articles: { results: [{
    uri, url: `https://eventregistry.org/a/${uri}`, title, body: 'body text',
    dateTimePub, source: { uri: 'reuters.com', title: 'Reuters' }, eventUri: 'evt-1', sentiment: -0.4, isDuplicate: false,
  }] } });
}
// Fetcher that also answers the NewsAPI.ai getArticles endpoint. `naiStatus`
// forces a non-200 (e.g. 401 for the circuit-breaker path).
function naiFetcher({ googleXml = EMPTY_RSS, nai = naiJson(), naiStatus = 200 } = {}) {
  return async (url) => {
    if (url.includes('getArticles')) return { ok: naiStatus < 300, status: naiStatus, text: async () => (naiStatus < 300 ? nai : 'err') };
    if (url.includes('news.google.com')) return { ok: true, status: 200, text: async () => googleXml };
    if (url.includes('gdeltproject.org')) return { ok: true, status: 200, text: async () => EMPTY_GDELT };
    return { ok: true, status: 200, text: async () => EMPTY_RSS };
  };
}
// NEWSAPI_AI_BACKGROUND opts the poller in — it is OFF by default (the primary
// path is the on-demand decision pull); these poller tests exercise the opt-in.
const NAI_ENV = { NEWSAPI_AI_KEY: 'K', NEWSAPI_AI_MODE: 'auto', NEWSAPI_AI_INSTRUMENTS: 'WTICO/USD', NEWSAPI_AI_REQUEST_BUDGET: '1800', NEWSAPI_AI_BACKGROUND: '1' };
const WTI = [{ instrument: 'WTICO/USD', granularity: 'M5' }];

function dbPathIn(dir) {
  const p = join(dir, 'news-test.sqlite');
  rmSync(p, { force: true });
  return p;
}

function googleXmlWith(title, link, pubDate) {
  return `<rss><channel><item><title>${title}</title><link>${link}</link><pubDate>${pubDate}</pubDate><description>d</description></item></channel></rss>`;
}

const EMPTY_RSS = '<rss><channel></channel></rss>';
const EMPTY_GDELT = '{"articles":[]}';

function stubFetcher({ googleXml = EMPTY_RSS, gdeltJson = EMPTY_GDELT, fail = [] } = {}) {
  return async (url) => {
    if (fail.some((s) => url.includes(s))) throw new Error('simulated failure');
    if (url.includes('news.google.com')) return { ok: true, status: 200, text: async () => googleXml };
    if (url.includes('gdeltproject.org')) return { ok: true, status: 200, text: async () => gdeltJson };
    return { ok: true, status: 200, text: async () => EMPTY_RSS };
  };
}

// --- trackedInstruments union + never-guess config gate ----------------------
test('refreshNewsCache: an instrument with no committed sentinel config is skipped entirely (never guesses a query)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const combos = [{ instrument: 'BTC/USD', granularity: 'M5' }]; // not in config/instruments.yaml's sentinel map
  const result = await refreshNewsCache(dbPath, combos, {}, { fetcher: stubFetcher(), now: Date.now(), log: () => {} });
  assert.deepEqual(result, { refreshed: [], skipped: [] });
});

// --- staleness gate: fresh skipped, stale fetched ----------------------------
test('refreshNewsCache: first poll fetches (no cache yet); an immediate re-run within the poll interval is skipped (fresh)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const combos = [{ instrument: 'WTICO/USD', granularity: 'M5' }];
  const now = Date.parse('2026-07-23T10:00:00Z');
  const fetcher = stubFetcher({ googleXml: googleXmlWith('Tanker attack near Hormuz', 'https://x/1', 'Thu, 23 Jul 2026 09:00:00 GMT') });

  const first = await refreshNewsCache(dbPath, combos, {}, { fetcher, now, log: () => {} });
  assert.equal(first.refreshed.length, 1);
  assert.equal(first.refreshed[0].instrument, 'WTICO/USD');
  assert.equal(first.refreshed[0].added, 1);

  const second = await refreshNewsCache(dbPath, combos, {}, { fetcher, now: now + 60000, log: () => {} });
  assert.deepEqual(second.refreshed, [], 'still fresh — not re-fetched a minute later');
});

test('refreshNewsCache: a stale cache (older than the poll interval) is re-fetched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const combos = [{ instrument: 'WTICO/USD', granularity: 'M5' }];
  const now = Date.parse('2026-07-23T10:00:00Z');
  const fetcher = stubFetcher({ googleXml: googleXmlWith('Oil steady', 'https://x/2', 'Thu, 23 Jul 2026 09:30:00 GMT') });

  await refreshNewsCache(dbPath, combos, {}, { fetcher, now, log: () => {} });
  const later = now + NEWS_POLL_INTERVAL_MS + 60000;
  const result = await refreshNewsCache(dbPath, combos, {}, { fetcher, now: later, log: () => {} });
  assert.equal(result.refreshed.length, 1, 'stale cache triggers a re-fetch');
});

// --- zero-item polls still update the staleness gate --------------------------
test('refreshNewsCache: a poll that returns zero items still marks the instrument fresh (no hammering the source every tick)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const combos = [{ instrument: 'WTICO/USD', granularity: 'M5' }];
  const now = Date.parse('2026-07-23T10:00:00Z');
  const fetcher = stubFetcher(); // EMPTY_RSS/EMPTY_GDELT everywhere -> zero items

  const first = await refreshNewsCache(dbPath, combos, {}, { fetcher, now, log: () => {} });
  assert.equal(first.refreshed.length, 1);
  assert.equal(first.refreshed[0].added, 0);

  const second = await refreshNewsCache(dbPath, combos, {}, { fetcher, now: now + 60000, log: () => {} });
  assert.deepEqual(second.refreshed, [], 'still fresh a minute later, even though the first poll cached nothing');

  const ctx = newsContextFor(dbPath, 'WTICO/USD', { now: now + 60000 });
  assert.equal(ctx, null, 'the poll marker never leaks into prompt context');
});

// --- one instrument's failure never aborts the tick --------------------------
test('refreshNewsCache: one instrument failing (e.g. every source down) does not prevent the others', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const combos = [{ instrument: 'WTICO/USD', granularity: 'M5' }, { instrument: 'XAU/USD', granularity: 'M5' }];
  const now = Date.now();
  let calls = 0;
  const fetcher = async (url) => {
    calls++;
    if (url.includes('news.google.com')) throw new Error('down'); // every source errors, but the call itself never throws (failure-isolated)
    return { ok: true, status: 200, text: async () => EMPTY_RSS };
  };
  const result = await refreshNewsCache(dbPath, combos, {}, { fetcher, now, log: () => {}, sleep: async () => {} });
  assert.equal(result.refreshed.length, 2, 'both instruments were attempted and completed (0 items each is not a failure)');
  assert.ok(calls > 0);
});

test('refreshNewsCache: a throwing fetchSentinelNews call for one instrument does not prevent the other (upsert failure isolation)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const combos = [{ instrument: 'WTICO/USD', granularity: 'M5' }, { instrument: 'XAU/USD', granularity: 'M5' }];
  const now = Date.now();
  // A non-Error thrown from the fetcher (malformed JSON from GDELT) makes
  // fetchSentinelNews itself reject only if the query builder throws before
  // fetch — here we simulate the fetch call itself always resolving but with
  // a bad JSON body for XAU to exercise refreshNewsCache's own try/catch.
  const fetcher = async (url) => {
    if (url.includes('gdeltproject.org')) return { ok: true, status: 200, text: async () => 'not json' };
    return { ok: true, status: 200, text: async () => EMPTY_RSS };
  };
  const result = await refreshNewsCache(dbPath, combos, {}, { fetcher, now, log: () => {}, sleep: async () => {} });
  // gdelt's JSON.parse throws inside fetchGdelt but is caught per-source
  // (fetchSourceSafe) — so the aggregate call still succeeds for both.
  assert.equal(result.refreshed.length, 2);
});

// --- per-tick fetch cap -------------------------------------------------------
test('refreshNewsCache: per-tick cap truncates fan-out and reports what was skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const combos = [
    { instrument: 'WTICO/USD', granularity: 'M5' },
    { instrument: 'XAU/USD', granularity: 'M5' },
    { instrument: 'XAG/USD', granularity: 'M5' },
  ];
  const now = Date.now();
  const result = await refreshNewsCache(dbPath, combos, {}, { fetcher: stubFetcher(), now, cap: 2, log: () => {}, sleep: async () => {} });
  assert.equal(result.refreshed.length, 2);
  assert.equal(result.skipped.length, 1);
});

// --- cache-only: no signal rows -----------------------------------------------
test('refreshNewsCache: writes news rows only — no signal rows, no bot journal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const combos = [{ instrument: 'WTICO/USD', granularity: 'M5' }];
  const now = Date.now();
  const fetcher = stubFetcher({ googleXml: googleXmlWith('Tanker attack near Hormuz', 'https://x/3', new Date(now).toUTCString()) });
  await refreshNewsCache(dbPath, combos, {}, { fetcher, now, log: () => {} });
  const [newsCount, signalCount] = withDb(dbPath, (db) => [
    db.prepare('SELECT COUNT(*) AS n FROM news').get().n,
    db.prepare('SELECT COUNT(*) AS n FROM signals').get().n,
  ]);
  assert.ok(Number(newsCount) > 0, 'news rows were written');
  assert.equal(Number(signalCount), 0, 'no signal rows result from the news poll');
});

// --- newsContextFor: advisory context block, empty ⇒ null --------------------
test('newsContextFor: returns null when the cache has no rows for the instrument', () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  assert.equal(newsContextFor(dbPath, 'WTICO/USD'), null);
});

test('newsContextFor: returns {escalation, headlines, asOf} when the cache has recent rows for the instrument', () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const now = Date.parse('2026-07-23T12:00:00Z');
  upsertNews(dbPath, 'WTICO/USD', [
    { source: 'google-news', title: 'Tanker attack near Hormuz', timeIso: new Date(now - 3600000).toISOString(), url: 'https://x/4', escalation: true },
    { source: 'oilprice', title: 'Refinery maintenance update', timeIso: new Date(now - 7200000).toISOString(), url: 'https://x/5', escalation: false },
  ], new Date(now).toISOString());

  const ctx = newsContextFor(dbPath, 'WTICO/USD', { now });
  assert.equal(ctx.escalation, true);
  assert.equal(ctx.headlines.length, 2);
  assert.equal(ctx.headlines[0].title, 'Tanker attack near Hormuz');
  assert.equal(ctx.asOf, new Date(now - 3600000).toISOString());
});

test('newsContextFor: rows older than the context window are excluded (stale cache does not haunt the prompt forever)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const now = Date.parse('2026-07-23T12:00:00Z');
  upsertNews(dbPath, 'WTICO/USD', [
    { source: 'oilprice', title: 'Old story', timeIso: new Date(now - 48 * 3600000).toISOString(), url: 'https://x/6', escalation: false },
  ], new Date(now).toISOString());
  assert.equal(newsContextFor(dbPath, 'WTICO/USD', { now, windowHours: 24 }), null);
});

// --- upsertNews: idempotent on (instrument, url) -----------------------------
test('upsertNews: idempotent upsert keyed on (instrument, url) — a re-seen url for the SAME instrument is not duplicated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const item = { source: 'google-news', title: 'Same story', timeIso: new Date().toISOString(), url: 'https://x/7', escalation: false };
  const first = upsertNews(dbPath, 'WTICO/USD', [item], new Date().toISOString());
  const again = upsertNews(dbPath, 'WTICO/USD', [item], new Date().toISOString());
  assert.equal(first.added, 1);
  assert.equal(again.added, 0, 'no duplicate row for a url already cached for this instrument');
});

// --- shared-query correctness (review fix): two instruments sharing a
// sentinel query (e.g. WTI + Brent both querying oil/OPEC/Hormuz, per
// config/instruments.yaml) must each cache — and each see — the same
// headline. A global UNIQUE(url) would bind it to only the first instrument. --
test('upsertNews + newsContextFor: two instruments sharing a query each cache the same headline and each see it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const now = Date.parse('2026-07-23T12:00:00Z');
  const shared = { source: 'google-news', title: 'OPEC cuts supply amid Hormuz tensions', timeIso: new Date(now - 3600000).toISOString(), url: 'https://shared/1', escalation: true };

  const wti = upsertNews(dbPath, 'WTICO/USD', [shared], new Date(now).toISOString());
  const brent = upsertNews(dbPath, 'BCO/USD', [shared], new Date(now).toISOString());
  assert.equal(wti.added, 1, 'first instrument caches the shared headline');
  assert.equal(brent.added, 1, 'second instrument ALSO caches the same shared headline — not swallowed by a global UNIQUE(url)');

  const wtiCtx = newsContextFor(dbPath, 'WTICO/USD', { now });
  const brentCtx = newsContextFor(dbPath, 'BCO/USD', { now });
  assert.ok(wtiCtx, 'WTI sees the shared headline');
  assert.ok(brentCtx, 'Brent ALSO sees the shared headline (the actual bug this fixes)');
  assert.equal(wtiCtx.headlines[0].title, shared.title);
  assert.equal(brentCtx.headlines[0].title, shared.title);
});

// --- guarded migration: pre-existing single-column UNIQUE(url) tables -------
test('migrateNewsUniqueKey: rebuilds a pre-existing UNIQUE(url) news table to (instrument, url), preserving rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  withDb(dbPath, (db) => {
    db.exec(`CREATE TABLE news (
      instrument TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, time TEXT,
      summary TEXT, url TEXT NOT NULL UNIQUE, tone REAL, themes TEXT,
      escalation INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL
    )`);
    db.prepare(`INSERT INTO news (instrument, source, title, time, summary, url, tone, themes, escalation, fetched_at)
      VALUES ('WTICO/USD', 'google-news', 'Pre-migration headline', '2026-07-20T00:00:00Z', NULL, 'https://pre/1', NULL, NULL, 0, '2026-07-20T00:00:00Z')`).run();

    migrateNewsUniqueKey(db);

    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='news'").get();
    assert.ok(/UNIQUE\s*\(\s*instrument\s*,\s*url\s*\)/i.test(row.sql), 're-keyed to UNIQUE(instrument, url)');
    const stray = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='news_pre_instrument_key'").get();
    assert.equal(stray, undefined, 'no news_pre_instrument_key left lingering');
    const rows = db.prepare('SELECT * FROM news').all();
    assert.equal(rows.length, 1, 'the pre-existing row survived the rebuild');
    assert.equal(rows[0].title, 'Pre-migration headline');
  });

  // A fresh (already-migrated) db is a no-op — migrateNewsUniqueKey never
  // rebuilds a table that already has the new key.
  const upsertResult = upsertNews(dbPath, 'BCO/USD', [{ source: 'google-news', title: 'Brent shares this url', timeIso: '2026-07-20T00:00:00Z', url: 'https://pre/1', escalation: false }], '2026-07-20T00:00:00Z');
  assert.equal(upsertResult.added, 1, 'a different instrument can now cache the same url the pre-migration row used');
});

test('migrateNewsUniqueKey (review fix for #86): a forced mid-rebuild failure rolls back cleanly — no stray table, original schema and rows intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  withDb(dbPath, (db) => {
    db.exec(`CREATE TABLE news (
      instrument TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, time TEXT,
      summary TEXT, url TEXT NOT NULL UNIQUE, tone REAL, themes TEXT,
      escalation INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL
    )`);
    db.prepare(`INSERT INTO news (instrument, source, title, time, summary, url, tone, themes, escalation, fetched_at)
      VALUES ('WTICO/USD', 'google-news', 'Pre-migration headline', '2026-07-20T00:00:00Z', NULL, 'https://pre/2', NULL, NULL, 0, '2026-07-20T00:00:00Z')`).run();

    const realExec = db.exec.bind(db);
    let calls = 0;
    db.exec = (sql) => {
      calls += 1;
      if (calls === 3) throw new Error('forced failure mid-rebuild');
      return realExec(sql);
    };
    try {
      assert.throws(() => migrateNewsUniqueKey(db), /forced failure mid-rebuild/);
    } finally {
      db.exec = realExec;
    }

    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='news'").get();
    assert.ok(/url\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(row.sql), 'original single-column UNIQUE(url) is back after rollback');
    const stray = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='news_pre_instrument_key'").get();
    assert.equal(stray, undefined, 'no news_pre_instrument_key left lingering');
    const rows = db.prepare('SELECT * FROM news').all();
    assert.equal(rows.length, 1, 'the pre-existing row survived the rollback');
    assert.equal(rows[0].title, 'Pre-migration headline');

    // A retry (no monkeypatch this time) still succeeds.
    migrateNewsUniqueKey(db);
    const after = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='news'").get();
    assert.ok(/UNIQUE\s*\(\s*instrument\s*,\s*url\s*\)/i.test(after.sql), 'a clean retry after rollback completes the migration');
  });
});

// --- NewsAPI.ai provider persistence (issue #104) --------------------------
test('refreshNewsCache: no NEWSAPI_AI_KEY => byte-for-byte free behavior, no provider rows written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const now = Date.parse('2026-07-23T10:00:00Z');
  await refreshNewsCache(dbPath, WTI, {}, { fetcher: naiFetcher(), now, log: () => {}, env: {} });
  assert.equal(providerRequestsUsed(dbPath), 0, 'no chargeable requests without a key');
  withDb(dbPath, (db) => {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM news_provider_state').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM news_provider_observations').get().n, 0);
  });
});

test('refreshNewsCache: with a key, charges the budget once per tick and records observations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const now = Date.parse('2026-07-23T10:00:00Z');
  const r = await refreshNewsCache(dbPath, WTI, {}, { fetcher: naiFetcher(), now, log: () => {}, env: NAI_ENV });
  assert.equal(r.refreshed[0].newsApiAi.requestMade, true);
  assert.equal(providerRequestsUsed(dbPath), 1, 'exactly one chargeable request this tick');
  withDb(dbPath, (db) => {
    const obs = db.prepare("SELECT provider, provider_item_id, event_uri, sentiment FROM news_provider_observations WHERE provider=?").all(NEWSAPI_AI_PROVIDER);
    assert.equal(obs.length, 1, 'the newsapi-ai sighting is logged');
    assert.equal(obs[0].event_uri, 'evt-1');
    assert.equal(obs[0].sentiment, -0.4);
  });
});

test('refreshNewsCache: budget survives restart and, once exhausted, falls back to free without an API call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const env = { ...NAI_ENV, NEWSAPI_AI_REQUEST_BUDGET: '1' };
  let calledGetArticles = 0;
  const countingFetcher = (inner) => async (url, opts) => { if (url.includes('getArticles')) calledGetArticles++; return inner(url, opts); };
  const now = Date.parse('2026-07-23T10:00:00Z');
  // Tick 1 spends the single budgeted request.
  await refreshNewsCache(dbPath, WTI, {}, { fetcher: countingFetcher(naiFetcher()), now, log: () => {}, env });
  assert.equal(calledGetArticles, 1);
  assert.equal(providerRequestsUsed(dbPath), 1);
  // Tick 2 (a fresh call = simulated restart, budget read from disk) must NOT hit the API.
  const later = now + NEWS_POLL_INTERVAL_MS + 60000;
  const r2 = await refreshNewsCache(dbPath, WTI, {}, { fetcher: countingFetcher(naiFetcher()), now: later, log: () => {}, env });
  assert.equal(calledGetArticles, 1, 'exhausted budget => no further API calls');
  // Free stack still refreshed the instrument.
  assert.ok(r2.refreshed.length === 1 && (r2.refreshed[0].newsApiAi === null || r2.refreshed[0].newsApiAi.requestMade === false));
});

test('refreshNewsCache: a 401 opens a persistent circuit; the next tick skips NewsAPI.ai (no repeated auth call)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const now = Date.parse('2026-07-23T10:00:00Z');
  let calls = 0;
  const f = (naiStatus) => async (url, opts) => {
    if (url.includes('getArticles')) { calls++; return { ok: false, status: naiStatus, text: async () => 'unauthorized' }; }
    return naiFetcher()(url, opts);
  };
  await refreshNewsCache(dbPath, WTI, {}, { fetcher: f(401), now, log: () => {}, env: NAI_ENV });
  assert.equal(calls, 1, 'first tick attempts and gets 401');
  assert.ok(providerCircuitOpen(dbPath, NEWSAPI_AI_PROVIDER, 'WTICO/USD', now), 'circuit is open after 401');
  const later = now + NEWS_POLL_INTERVAL_MS + 60000;
  const r2 = await refreshNewsCache(dbPath, WTI, {}, { fetcher: f(401), now: later, log: () => {}, env: NAI_ENV });
  assert.equal(calls, 1, 'circuit open => NewsAPI.ai not called again');
  assert.ok(r2.refreshed.length === 1, 'free stack still carries the tick');
});

test('recordProviderObservations: first_seen_at is preserved across repeat polls (who-saw-it-first)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const item = { provider: 'newsapi-ai', providerItemId: 'x1', url: 'https://x/1', title: 'T', source: 'Reuters', sourceUri: 'reuters.com', timeIso: '2026-07-23T09:00:00Z', sentiment: -0.2 };
  recordProviderObservations(dbPath, 'WTICO/USD', [item], Date.parse('2026-07-23T09:05:00Z'));
  recordProviderObservations(dbPath, 'WTICO/USD', [item], Date.parse('2026-07-23T09:30:00Z'));
  withDb(dbPath, (db) => {
    const rows = db.prepare('SELECT first_seen_at FROM news_provider_observations WHERE provider_item_id=?').all('x1');
    assert.equal(rows.length, 1, 'one row, not duplicated');
    assert.equal(rows[0].first_seen_at, '2026-07-23T09:05:00.000Z', 'first sighting preserved, not overwritten');
  });
});

test('refreshNewsCache: mode=off ignores a present key entirely', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const now = Date.parse('2026-07-23T10:00:00Z');
  let calls = 0;
  const f = async (url, opts) => { if (url.includes('getArticles')) calls++; return naiFetcher()(url, opts); };
  await refreshNewsCache(dbPath, WTI, {}, { fetcher: f, now, log: () => {}, env: { ...NAI_ENV, NEWSAPI_AI_MODE: 'off' } });
  assert.equal(calls, 0, 'off => no NewsAPI.ai call even with a key');
  assert.equal(providerRequestsUsed(dbPath), 0);
});

// --- on-demand decision-point pull (issue #104, primary path) --------------
test('refreshNewsForDecision: no key => no network, no rows (byte-for-byte current behavior)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  let calls = 0;
  const f = async (url, opts) => { calls++; return naiFetcher()(url, opts); };
  const r = await refreshNewsForDecision(dbPath, 'WTICO/USD', { env: {}, fetcher: f, now: Date.now() });
  assert.equal(r.pulled, false);
  assert.equal(r.reason, 'disabled');
  assert.equal(calls, 0, 'no network without a key');
});

test('refreshNewsForDecision: with a key, pulls once, charges budget, records observations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const now = Date.parse('2026-07-23T10:00:00Z');
  const env = { NEWSAPI_AI_KEY: 'K', NEWSAPI_AI_MODE: 'auto', NEWSAPI_AI_INSTRUMENTS: 'WTICO/USD', NEWSAPI_AI_REQUEST_BUDGET: '1800' };
  const r = await refreshNewsForDecision(dbPath, 'WTICO/USD', { env, fetcher: naiFetcher(), now, log: () => {} });
  assert.equal(r.pulled, true);
  assert.equal(providerRequestsUsed(dbPath), 1);
  withDb(dbPath, (db) => {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM news_provider_observations WHERE provider=?').get(NEWSAPI_AI_PROVIDER).n, 1);
  });
});

test('refreshNewsForDecision: a second call within the throttle window does not re-pull (filter+bot share one pull)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const now = Date.parse('2026-07-23T10:00:00Z');
  const env = { NEWSAPI_AI_KEY: 'K', NEWSAPI_AI_MODE: 'auto', NEWSAPI_AI_INSTRUMENTS: 'WTICO/USD', NEWSAPI_AI_REQUEST_BUDGET: '1800' };
  await refreshNewsForDecision(dbPath, 'WTICO/USD', { env, fetcher: naiFetcher(), now, log: () => {} });
  const r2 = await refreshNewsForDecision(dbPath, 'WTICO/USD', { env, fetcher: naiFetcher(), now: now + 60000, log: () => {} });
  assert.equal(r2.reason, 'throttled');
  assert.equal(providerRequestsUsed(dbPath), 1, 'still just one chargeable request');
  // Past the throttle window it pulls again.
  const r3 = await refreshNewsForDecision(dbPath, 'WTICO/USD', { env, fetcher: naiFetcher(), now: now + DECISION_PULL_THROTTLE_MS + 60000, log: () => {} });
  assert.equal(r3.pulled, true);
  assert.equal(providerRequestsUsed(dbPath), 2);
});

test('sentinelDecisionContext: returns the fresh headline after the pull', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const now = Date.parse('2026-07-23T10:00:00Z');
  const env = { NEWSAPI_AI_KEY: 'K', NEWSAPI_AI_MODE: 'auto', NEWSAPI_AI_INSTRUMENTS: 'WTICO/USD', NEWSAPI_AI_REQUEST_BUDGET: '1800' };
  const ctx = await sentinelDecisionContext(dbPath, 'WTICO/USD', { env, fetcher: naiFetcher(), now, log: () => {} });
  assert.ok(ctx && ctx.headlines.some((h) => /Hormuz/.test(h.title)), 'freshly-pulled headline is in the decision context');
});

test('refreshNewsCache: background poller is OFF by default (no NEWSAPI_AI_BACKGROUND) even with a key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const dbPath = dbPathIn(dir);
  const now = Date.parse('2026-07-23T10:00:00Z');
  let calls = 0;
  const f = async (url, opts) => { if (url.includes('getArticles')) calls++; return naiFetcher()(url, opts); };
  // NAI_ENV-style but WITHOUT NEWSAPI_AI_BACKGROUND.
  const env = { NEWSAPI_AI_KEY: 'K', NEWSAPI_AI_MODE: 'auto', NEWSAPI_AI_INSTRUMENTS: 'WTICO/USD', NEWSAPI_AI_REQUEST_BUDGET: '1800' };
  await refreshNewsCache(dbPath, WTI, {}, { fetcher: f, now, log: () => {}, env });
  assert.equal(calls, 0, 'poller does not call NewsAPI.ai unless NEWSAPI_AI_BACKGROUND is set');
  assert.equal(providerRequestsUsed(dbPath), 0);
});

// --- decision-pull reason accuracy + bounded timeout (Copilot round 4) ------
test('refreshNewsForDecision: reason reflects the outcome (ok / request-failed / not-made)', async () => {
  const env = { NEWSAPI_AI_KEY: 'K', NEWSAPI_AI_MODE: 'auto', NEWSAPI_AI_INSTRUMENTS: 'WTICO/USD', NEWSAPI_AI_REQUEST_BUDGET: '1800' };
  const now = Date.parse('2026-07-23T10:00:00Z');
  // ok: a real successful pull
  let d = mkdtempSync(join(tmpdir(), 'news-')); let db = dbPathIn(d);
  let r = await refreshNewsForDecision(db, 'WTICO/USD', { env, fetcher: naiFetcher(), now, log: () => {} });
  assert.equal(r.reason, 'ok'); assert.equal(r.pulled, true);
  // request-failed: network 5xx (a chargeable attempt that failed)
  d = mkdtempSync(join(tmpdir(), 'news-')); db = dbPathIn(d);
  r = await refreshNewsForDecision(db, 'WTICO/USD', { env, fetcher: naiFetcher({ naiStatus: 503 }), now, log: () => {} });
  assert.equal(r.reason, 'request-failed'); assert.equal(r.pulled, true);
});

test('DECISION_FETCH_TIMEOUT_MS is tighter than the default, so a slow source cannot stall alert delivery', () => {
  assert.ok(DECISION_FETCH_TIMEOUT_MS <= 6000 && DECISION_FETCH_TIMEOUT_MS < 15000);
});

test('sentinelDecisionContext: fails open — a DB error degrades to null, never throws into the alert path', async () => {
  // A bogus dbPath (a directory) makes the underlying withDb/reads throw; the
  // decision context must swallow it and return null, not propagate (dropping an alert).
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const env = { NEWSAPI_AI_KEY: 'K', NEWSAPI_AI_MODE: 'auto', NEWSAPI_AI_INSTRUMENTS: 'WTICO/USD' };
  const ctx = await sentinelDecisionContext(dir /* a directory, not a db file */, 'WTICO/USD', { env, fetcher: naiFetcher(), now: Date.now(), log: () => {} });
  assert.equal(ctx, null, 'a DB failure degrades to no-context, not a throw');
});
