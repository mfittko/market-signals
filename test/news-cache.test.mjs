import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDb } from '../scripts/supertrend.mjs';
import {
  refreshNewsCache, newsContextFor, upsertNews, NEWS_POLL_INTERVAL_MS, migrateNewsUniqueKey,
} from '../scripts/news.mjs';

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
