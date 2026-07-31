import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDb } from '../scripts/supertrend.mjs';
import { recordProviderObservations } from '../scripts/news.mjs';
import { buildReport, coverage, latency, onTopicRate, parseArgs, pct } from '../scripts/news-provider-report.mjs';

function seed(dbPath) {
  // NewsAPI.ai saw the tanker story at 09:41; the free stack (google-news) saw
  // the same story at 09:46 (5 min later) -> a matched story NewsAPI.ai won.
  recordProviderObservations(dbPath, 'WTICO/USD', [
    { provider: 'newsapi-ai', providerItemId: 'nai-1', url: 'https://e/1', title: 'Iran strikes tanker near Hormuz', source: 'Reuters', sourceUri: 'reuters.com', eventUri: 'evt-1', timeIso: '2026-07-23T09:40:00Z', sentiment: -0.4, isDuplicate: false },
    { provider: 'newsapi-ai', providerItemId: 'nai-2', url: 'https://e/2', title: 'OPEC weighs output cut', source: 'Bloomberg', sourceUri: 'bloomberg.com', eventUri: 'evt-2', timeIso: '2026-07-23T09:00:00Z', sentiment: 0.1, isDuplicate: false },
  ], Date.parse('2026-07-23T09:41:00Z'));
  recordProviderObservations(dbPath, 'WTICO/USD', [
    { provider: 'google-news', url: 'https://g/1', title: 'Iran strikes tanker near Hormuz - Reuters', source: 'google-news', timeIso: '2026-07-23T09:40:00Z' },
  ], Date.parse('2026-07-23T09:46:00Z'));
  // A fresh flip at 09:45 — within 5 min of the NewsAPI.ai sighting (09:41).
  withDb(dbPath, (db) => {
    db.prepare('INSERT INTO signals (instrument, granularity, time, signal, price) VALUES (?,?,?,?,?)')
      .run('WTICO/USD', 'M5', '2026-07-23T09:45:00Z', 'buy', 70.5);
  });
}

test('news-provider-report: coverage counts unique-to-NewsAPI.ai, events, and publisher domains', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rep-'));
  const dbPath = join(dir, 'c.db'); rmSync(dbPath, { force: true });
  seed(dbPath);
  const report = withDb(dbPath, (db) => buildReport(db, { instrument: 'WTICO/USD', sinceIso: '2026-07-23T00:00:00.000Z' }));
  const c = report.coverage;
  assert.equal(c.newsApiAi, 2);
  assert.equal(c.free, 1);
  assert.equal(c.uniqueEvents, 2, 'two distinct eventUris');
  assert.equal(c.articlesUniqueToNewsApiAi, 1, 'the OPEC story only NewsAPI.ai saw');
  assert.equal(c.distinctPublisherDomains, 2, 'reuters.com + bloomberg.com');
});

test('news-provider-report: latency credits NewsAPI.ai the 5-min first-seen lead on the matched story', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rep-'));
  const dbPath = join(dir, 'c.db'); rmSync(dbPath, { force: true });
  seed(dbPath);
  const report = withDb(dbPath, (db) => buildReport(db, { instrument: 'WTICO/USD', sinceIso: '2026-07-23T00:00:00.000Z' }));
  const l = report.latency;
  assert.equal(l.matchedStories, 1);
  assert.equal(l.newsApiAiFirstSeenWins, 1);
  assert.equal(l.medianLeadMin, 5, 'NewsAPI.ai saw the tanker story 5 min before the free stack');
});

test('news-provider-report: trading relevance flags a headline within 5 min of the fresh flip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rep-'));
  const dbPath = join(dir, 'c.db'); rmSync(dbPath, { force: true });
  seed(dbPath);
  const report = withDb(dbPath, (db) => buildReport(db, { instrument: 'WTICO/USD', sinceIso: '2026-07-23T00:00:00.000Z' }));
  assert.equal(report.tradingRelevance.freshFlips, 1);
  assert.equal(report.tradingRelevance.flipsCovered.within5min, '1/1', 'a NewsAPI.ai headline existed within 5 min of the flip');
});

test('news-provider-report: parseArgs requires nothing crazy, defaults provider to newsapi-ai', () => {
  const a = parseArgs(['--instrument', 'WTICO/USD', '--since', '2026-07-23', '--json']);
  assert.equal(a.instrument, 'WTICO/USD');
  assert.equal(a.provider, 'newsapi-ai');
  assert.equal(a.json, true);
});

test('news-provider-report: --provider threads through (report a free provider vs the rest)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rep-'));
  const dbPath = join(dir, 'c.db'); rmSync(dbPath, { force: true });
  seed(dbPath);
  const report = withDb(dbPath, (db) => buildReport(db, { instrument: 'WTICO/USD', sinceIso: '2026-07-23T00:00:00.000Z', provider: 'google-news' }));
  assert.equal(report.provider, 'google-news');
  assert.equal(report.coverage.newsApiAi, 1, 'the target provider (google-news) has 1 observation');
  assert.equal(report.coverage.free, 2, 'the rest (2 newsapi-ai obs) are "the rest"');
});

test('pct: nearest-rank on n-1 base — p90 of 10 items is the 9th value, not the max', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(pct(xs, 90), 9, 'p90 -> index round(0.9*9)=8 -> 9, not 10');
  assert.equal(pct(xs, 50), 6, 'p50 -> index round(0.5*9)=5 -> 6');
  assert.equal(pct(xs, 100), 10);
  assert.equal(pct(xs, 0), 1);
  assert.equal(pct([], 90), null);
  assert.equal(pct([42], 90), 42, 'single sample');
});

// --- on-topic rate + gnews degradation (issue #212) -------------------------
test('onTopicRate: rows matching the instrument\'s sentinel terms count as on-topic; off-topic rows do not', () => {
  const obs = [
    { provider: 'gdelt', normalized_title: 'iran strikes tanker near hormuz' }, // matches "iran"/"tanker"/"hormuz"
    { provider: 'gdelt', normalized_title: 'local election results announced downtown' }, // matches nothing
  ];
  const r = onTopicRate(obs, 'WTICO/USD', 'gdelt');
  assert.equal(r.total, 2);
  assert.equal(r.onTopic, 1);
  assert.equal(r.rate, 0.5);
});
test('onTopicRate: an instrument with no committed sentinel query degrades to a null rate (never a misleading 0)', () => {
  const r = onTopicRate([{ provider: 'gdelt', normalized_title: 'anything' }], 'ZZZ/USD', 'gdelt');
  assert.equal(r.rate, null);
  assert.equal(r.onTopic, null);
});

test('coverage: a provider with no event clustering (e.g. gnews) reports uniqueEvents as null, not a misleading 0', () => {
  const obs = [
    { provider: 'gnews', normalized_title: 'bp puts north sea assets up for sale', source_uri: 'bbc.com', is_duplicate: 0 },
    { provider: 'gnews', normalized_title: 'oil steady on demand outlook', source_uri: 'reuters.com', is_duplicate: 0 },
  ];
  const c = coverage(obs, 'gnews');
  assert.equal(c.uniqueEvents, null, 'gnews never carries an event_uri — null, not 0');
});
test('coverage: a provider WITH event clustering still reports a real uniqueEvents count', () => {
  const obs = [
    { provider: 'newsapi-ai', normalized_title: 't1', event_uri: 'evt-1', source_uri: 'reuters.com', is_duplicate: 0 },
    { provider: 'newsapi-ai', normalized_title: 't2', event_uri: 'evt-1', source_uri: 'reuters.com', is_duplicate: 0 },
  ];
  const c = coverage(obs, 'newsapi-ai');
  assert.equal(c.uniqueEvents, 1);
});

test('buildReport: onTopic is reported alongside coverage/latency for a gnews-style provider (no event clustering, real on-topic terms)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rep-'));
  const dbPath = join(dir, 'c.db'); rmSync(dbPath, { force: true });
  recordProviderObservations(dbPath, 'WTICO/USD', [
    { provider: 'gnews', providerItemId: 'g1', url: 'https://g/1', title: 'Iran strikes tanker near Hormuz', source: 'Reuters', sourceUri: 'reuters.com', timeIso: '2026-07-23T09:41:00Z', isDuplicate: false },
    { provider: 'gnews', providerItemId: 'g2', url: 'https://g/2', title: 'Local council approves new library', source: 'Local Times', sourceUri: 'localtimes.com', timeIso: '2026-07-23T09:00:00Z', isDuplicate: false },
  ], Date.parse('2026-07-23T09:41:00Z'));
  const report = withDb(dbPath, (db) => buildReport(db, { instrument: 'WTICO/USD', sinceIso: '2026-07-23T00:00:00.000Z', provider: 'gnews' }));
  assert.equal(report.onTopic.total, 2);
  assert.equal(report.onTopic.onTopic, 1, 'only the Iran/tanker/Hormuz headline matches the WTI sentinel terms');
  assert.equal(report.coverage.uniqueEvents, null, 'gnews has no event clustering');
});
