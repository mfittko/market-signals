import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDb } from '../scripts/supertrend.mjs';
import { recordProviderObservations } from '../scripts/news.mjs';
import { buildReport, coverage, latency, parseArgs } from '../scripts/news-provider-report.mjs';

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
