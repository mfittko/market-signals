import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeArticles, assessArticleFeed } from '../skills/fxempire-analysis/scripts/fxempire_articles.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/fxempire_news_hub_stale.json', import.meta.url));
const stale = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).map((a) => ({ ...a, _type: 'news' }));

test('stale upstream feed: recency filter drops all items and feed is flagged degraded', () => {
  const now = Date.parse('2026-07-13T00:00:00Z');
  const cutoffTs = now - 24 * 3600 * 1000;
  const emitted = normalizeArticles(stale, { cutoffTs, nowTs: now });
  assert.equal(emitted.length, 0, 'stale months-old items must be filtered out');

  const feed = assessArticleFeed({
    rawCount: stale.length,
    emittedCount: emitted.length,
    newestRawTs: Math.max(...stale.map((a) => a.timestamp)),
    cutoffTs,
  });
  assert.equal(feed.degraded, true);
  assert.match(feed.reason, /recency\/relevance/);
  assert.match(feed.reason, /#11/);
});

test('fresh relevant items pass the filter and feed is not degraded', () => {
  const now = Date.parse('2026-07-13T00:00:00Z');
  const cutoffTs = now - 24 * 3600 * 1000;
  const fresh = [
    { id: 1, title: 'Brent rallies', slug: 'brent-rallies', timestamp: now - 3600 * 1000, _type: 'news', _slug: 'brent-crude-oil', tags: ['co-brent-crude-oil'] },
  ];
  const emitted = normalizeArticles(fresh, { cutoffTs, nowTs: now });
  assert.equal(emitted.length, 1);
  const feed = assessArticleFeed({ rawCount: 1, emittedCount: emitted.length, newestRawTs: fresh[0].timestamp, cutoffTs });
  assert.equal(feed.degraded, false);
  assert.equal(feed.reason, null);
});

test('empty upstream feed is flagged degraded with an unavailable reason', () => {
  const feed = assessArticleFeed({ rawCount: 0, emittedCount: 0, newestRawTs: null, cutoffTs: Date.now() });
  assert.equal(feed.degraded, true);
  assert.match(feed.reason, /no items/);
});

test('no parseable timestamps yields an accurate degraded reason (not "newest unknown predates")', () => {
  const r = assessArticleFeed({ rawCount: 7, emittedCount: 0, newestRawTs: null, cutoffTs: Date.parse('2026-07-22T00:00:00Z') });
  assert.equal(r.degraded, true);
  assert.match(r.reason, /parseable timestamp/);
  assert.ok(!r.reason.includes('unknown predates'), 'misleading phrasing gone');
});
