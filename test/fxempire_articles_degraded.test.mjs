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

// --- SSR news-page source (issue #28) ---
import { extractSsrArticles, extractNextData, slugMarket, articleMatchesSlug } from '../skills/fxempire-analysis/scripts/fxempire_articles.mjs';

const ssrHtml = fs.readFileSync(new URL('./fixtures/fxempire_ssr_news_page.html', import.meta.url), 'utf8');

test('extractSsrArticles pulls id-keyed articles from __NEXT_DATA__, skipping non-article entries', () => {
  const arts = extractSsrArticles(ssrHtml);
  assert.equal(arts.length, 3, 'three article-shaped entries (the tag object skipped)');
  const wti = arts.find((a) => a.id === 1612050);
  assert.equal(wti.title, 'WTI Slides as Hormuz Premium Fades');
  assert.ok(Number.isFinite(wti.timestamp));
  assert.equal(wti.articleUrl, '/news/article/wti-slides-1612050');
});

test('SSR articles flow through normalizeArticles with recency filtering', () => {
  const nowTs = Date.parse('2026-07-22T17:00:00Z');
  const cutoffTs = Date.parse('2026-07-22T05:00:00Z');
  const norm = normalizeArticles(extractSsrArticles(ssrHtml).map((a) => ({ ...a, _type: 'news', _tag: 'ssr:test', _slug: 'wti-crude-oil' })), { cutoffTs, nowTs });
  assert.equal(norm.length, 2, 'ancient article filtered out');
  assert.ok(norm.every((a) => a.fullUrl.startsWith('https://www.fxempire.com/')));
});

test('mangled SSR page degrades to empty (hub fallback path), never throws', () => {
  const mangled = fs.readFileSync(new URL('./fixtures/fxempire_ssr_mangled.html', import.meta.url), 'utf8');
  assert.equal(extractNextData(mangled), null);
  assert.deepEqual(extractSsrArticles(mangled), []);
  assert.deepEqual(extractSsrArticles('<html>no data at all</html>'), []);
});

test('slugMarket resolves from catalog or builtin, defaults to commodities', () => {
  assert.equal(slugMarket('spx'), 'indices');
  assert.equal(slugMarket('bitcoin'), 'crypto');
  assert.equal(slugMarket('wti-crude-oil'), 'commodities');
  assert.equal(slugMarket('never-heard-of-it'), 'commodities');
});


test('articleMatchesSlug: tag-prefix convention attribution', () => {
  const arts = extractSsrArticles(ssrHtml);
  const gold = arts.filter((a) => articleMatchesSlug(a, 'gold'));
  const wti = arts.filter((a) => articleMatchesSlug(a, 'wti-crude-oil'));
  assert.equal(gold.length, 1);
  assert.equal(gold[0].id, 1612117);
  assert.equal(wti.length, 1);
  assert.equal(wti[0].id, 1612050);
  assert.equal(arts.filter((a) => articleMatchesSlug(a, 'bitcoin')).length, 0, 'untagged instruments get nothing from the mix');
  // Prefix-exact semantics: partial containment must not match.
  assert.equal(articleMatchesSlug({ tags: ['co-golden-cross'] }, 'gold'), false, 'no substring misattribution');
  assert.equal(articleMatchesSlug({ tags: ['co-gold'] }, 'gold'), true);
  assert.equal(articleMatchesSlug({ tags: ['i-spx'] }, 'spx'), true);
  assert.equal(articleMatchesSlug({ tags: ['spx'] }, 'spx'), true, 'bare exact tag matches');
});


test('upstream dates parse as UTC regardless of machine timezone; explicit offsets respected', async () => {
  const { parseUpstreamDate } = await import('../skills/fxempire-analysis/scripts/fxempire_articles.mjs');
  assert.equal(parseUpstreamDate('2026-04-30T10:24:35'), 1777544675000, 'matches the hub epoch pair');
  assert.equal(parseUpstreamDate('2026-04-30T10:24:35Z'), 1777544675000);
  assert.equal(parseUpstreamDate('2026-04-30T12:24:35+02:00'), 1777544675000);
  assert.ok(Number.isNaN(parseUpstreamDate(null)));
});

test('extractNextData tolerates attribute reordering and extra attributes', () => {
  const wrapped = '<script type="application/json" nonce="abc" id="__NEXT_DATA__" crossorigin>{"a":1}</script>';
  assert.deepEqual(extractNextData(wrapped), { a: 1 });
});

test('article page cache: roundtrip, TTL expiry, atomic write', async () => {
  const { readArticleCache, writeArticleCache, cacheGet, ARTICLE_CACHE_TTL_MS } = await import('../skills/fxempire-analysis/scripts/fxempire_articles.mjs');
  const os = await import('node:os');
  const pth = await import('node:path');
  const dir = fs.mkdtempSync(pth.join(os.tmpdir(), 'artcache-'));
  const cachePath = pth.join(dir, 'nested', 'cache.json');
  const now = Date.now();
  const cache = { '/news': { at: now, articles: [{ id: 1, title: 'x' }] } };
  writeArticleCache(cachePath, cache);
  const back = readArticleCache(cachePath);
  assert.deepEqual(cacheGet(back, '/news', ARTICLE_CACHE_TTL_MS, now + 1000)[0].id, 1, 'fresh hit');
  assert.equal(cacheGet(back, '/news', ARTICLE_CACHE_TTL_MS, now + ARTICLE_CACHE_TTL_MS + 1), null, 'expired');
  assert.equal(cacheGet(back, '/other'), null, 'unknown key');
  assert.deepEqual(readArticleCache(pth.join(dir, 'missing.json')), {}, 'missing file is empty cache');
});
