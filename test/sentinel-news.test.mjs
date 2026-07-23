import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ESCALATION_LEXICON, GDELT_TONE_ESCALATION_THRESHOLD, computeEscalation,
  parseFeedItems, normalizeRssItem, normalizeGdeltArticle, dedupeItems,
  fetchSentinelNews, createGdeltThrottle, resolveQuery,
} from '../skills/market-sentinel/scripts/sentinel_news.mjs';

const SCRIPT = fileURLToPath(new URL('../skills/market-sentinel/scripts/sentinel_news.mjs', import.meta.url));
const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

// --- escalation (issue #86 AC6): named constants, fixture-pinned flag -------
test('escalation lexicon + GDELT tone threshold are named constants', () => {
  assert.ok(Array.isArray(ESCALATION_LEXICON) && ESCALATION_LEXICON.length > 0);
  assert.ok(ESCALATION_LEXICON.includes('tanker') && ESCALATION_LEXICON.includes('hormuz'));
  assert.equal(GDELT_TONE_ESCALATION_THRESHOLD, -5);
});

test('computeEscalation: tanker-attack headline flags true, benign headline flags false', () => {
  assert.equal(computeEscalation({ title: 'Houthi tanker attack near Hormuz sparks crude oil surge' }), true);
  assert.equal(computeEscalation({ title: 'Oil prices steady amid summer demand outlook' }), false);
});

test('computeEscalation: GDELT tone below the threshold flags true even with a benign title', () => {
  assert.equal(computeEscalation({ title: 'Quarterly market recap', tone: -6 }), true);
  assert.equal(computeEscalation({ title: 'Quarterly market recap', tone: -4 }), false, 'above the threshold does not flag');
  assert.equal(computeEscalation({ title: 'Quarterly market recap' }), false, 'no tone, no keyword: benign');
});

// --- RSS/Atom parse ----------------------------------------------------------
test('parseFeedItems: extracts title/link/pubDate/description from RSS 2.0 items, decoding entities', () => {
  const items = parseFeedItems(fixture('sentinel_google_news.xml'));
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Houthi tanker attack near Hormuz sparks crude oil surge');
  assert.equal(items[0].link, 'https://news.example.com/houthi-tanker-attack');
  assert.match(items[0].pubDate, /23 Jul 2026/);
  assert.ok(items[0].description.length > 0 && !/</.test(items[0].description), 'description HTML stripped');
});

test('parseFeedItems: also parses Atom <entry>/<link href> shape', () => {
  const atom = '<feed><entry><title>Atom item</title><link href="https://x.example/atom1"/><updated>2026-07-23T08:00:00Z</updated><summary>hi</summary></entry></feed>';
  const items = parseFeedItems(atom);
  assert.equal(items.length, 1);
  assert.equal(items[0].link, 'https://x.example/atom1');
  assert.equal(items[0].pubDate, '2026-07-23T08:00:00Z');
});

// --- normalize ---------------------------------------------------------------
test('normalizeRssItem: maps a raw feed item to the shared schema and computes escalation', () => {
  const [raw] = parseFeedItems(fixture('sentinel_google_news.xml'));
  const item = normalizeRssItem('google-news', raw);
  assert.equal(item.source, 'google-news');
  assert.equal(item.escalation, true);
  assert.ok(item.timeIso.startsWith('2026-07-23'));
  assert.equal(item.tone, null);
  assert.equal(item.themes, null);
});

test('normalizeGdeltArticle: parses tone (number) and themes (semicolon list)', () => {
  const gdelt = JSON.parse(fixture('sentinel_gdelt.json'));
  const item = normalizeGdeltArticle(gdelt.articles[0]);
  assert.equal(item.source, 'gdelt');
  assert.equal(item.tone, -8.2);
  assert.deepEqual(item.themes, ['ARMEDCONFLICT', 'MARITIME_INCIDENT', 'ECON_OILPRICE']);
  assert.equal(item.escalation, true, 'tone < -5 flags escalation even before keyword check');

  const benign = normalizeGdeltArticle(gdelt.articles[1]);
  assert.equal(benign.escalation, false);
});

// --- dedup: url first, fuzzy title as a fallback ----------------------------
test('dedupeItems: drops an exact url repeat and a fuzzy-title repeat, keeps distinct items', () => {
  const items = [
    { title: 'Tanker Attack Near Hormuz!', url: 'https://a/1' },
    { title: 'tanker attack near hormuz', url: 'https://a/1-mirror' }, // same story, different url
    { title: 'Unrelated market recap', url: 'https://a/2' },
    { title: 'Unrelated market recap', url: 'https://a/2' }, // exact repeat
  ];
  const out = dedupeItems(items);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((i) => i.url), ['https://a/1', 'https://a/2']);
});

// --- fetchSentinelNews: bounded, dedup across sources, failure-isolated -----
function stubFetcher({ fail = [] } = {}) {
  return async (url) => {
    if (fail.some((s) => url.includes(s))) throw new Error('simulated network failure');
    if (url.includes('news.google.com')) return { ok: true, status: 200, text: async () => fixture('sentinel_google_news.xml') };
    if (url.includes('gdeltproject.org')) return { ok: true, status: 200, text: async () => fixture('sentinel_gdelt.json') };
    if (url.includes('aljazeera.com')) return { ok: true, status: 200, text: async () => fixture('sentinel_aljazeera.xml') };
    return { ok: true, status: 200, text: async () => '<rss><channel></channel></rss>' };
  };
}

test('fetchSentinelNews: normalizes every source, dedups the cross-source url overlap, sorts newest-first, flags escalation', async () => {
  const now = Date.parse('2026-07-23T12:00:00Z');
  const result = await fetchSentinelNews({ query: 'oil', hours: 24, fetcher: stubFetcher(), now, log: () => {} });
  const urls = result.items.map((i) => i.url);
  assert.equal(new Set(urls).size, urls.length, 'no duplicate urls survived dedup');
  // google-news + gdelt both carry the tanker-attack url; al-jazeera carries a
  // distinct (different-url) story on the same event — none collapse wrongly.
  assert.ok(urls.includes('https://news.example.com/houthi-tanker-attack'));
  assert.ok(urls.includes('https://aljazeera.example.com/gulf-tanker-seizure'));
  const times = result.items.map((i) => Date.parse(i.timeIso));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
  assert.equal(result.escalation, true);
  assert.ok(typeof result.asOf === 'string' && result.asOf.length > 0);
});

test('fetchSentinelNews: one failing source (dead feed) yields [] for it and never fails the whole call', async () => {
  const now = Date.parse('2026-07-23T12:00:00Z');
  const result = await fetchSentinelNews({
    query: 'oil', hours: 24, fetcher: stubFetcher({ fail: ['gdeltproject.org'] }), now, log: () => {},
  });
  assert.ok(result.items.length > 0, 'other sources still contributed items');
  assert.ok(!result.items.some((i) => i.source === 'gdelt'), 'the failing source contributed nothing');
});

test('fetchSentinelNews: every source failing still returns the well-shaped empty payload, not a throw', async () => {
  const now = Date.parse('2026-07-23T12:00:00Z');
  const result = await fetchSentinelNews({
    query: 'oil', hours: 24,
    fetcher: stubFetcher({ fail: ['google.com', 'gdeltproject.org', 'aljazeera.com', 'oilprice.com', 'yahoo.com'] }),
    now, log: () => {},
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.escalation, false);
});

test('fetchSentinelNews: totalCap bounds the output regardless of source volume', async () => {
  const now = Date.parse('2026-07-23T12:00:00Z');
  const result = await fetchSentinelNews({ query: 'oil', hours: 24, fetcher: stubFetcher(), now, totalCap: 1, log: () => {} });
  assert.equal(result.items.length, 1);
});

// --- GDELT throttle: ≥5s spacing across successive calls, no wait on the first ---
test('createGdeltThrottle: spaces successive calls by minGapMs, first call never waits', async () => {
  let now = 1000;
  const sleeps = [];
  const throttle = createGdeltThrottle({ minGapMs: 5000, now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
  await throttle();
  assert.deepEqual(sleeps, [], 'first call does not wait');
  now += 1000; // only 1s elapsed
  await throttle();
  assert.deepEqual(sleeps, [4000], 'second call waits out the remaining gap to 5s');
});

// --- resolveQuery: never guesses ---------------------------------------------
test('resolveQuery: --query is used verbatim; --instrument without a committed sentinel entry throws (never guesses)', () => {
  assert.deepEqual(
    resolveQuery({ query: 'oil OR crude', yahooSymbol: 'CL=F', instrument: null }),
    { query: 'oil OR crude', yahooSymbol: 'CL=F', instrument: null },
  );
  assert.throws(() => resolveQuery({ instrument: 'ZZZ/USD' }), /no sentinel query configured/);
  assert.throws(() => resolveQuery({}), /--instrument or --query is required/);
});

// --- CLI: hermetic parts only (no live network) ------------------------------
test('sentinel_news --help exits 0 with usage, no network', () => {
  const res = spawnSync('node', [SCRIPT, '--help'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('market-sentinel'));
  assert.ok(res.stdout.includes('--json'));
});

test('sentinel_news --json (offline escape hatch) emits the documented shape without hitting the network', () => {
  const res = spawnSync('node', [SCRIPT, '--instrument', 'WTICO/USD', '--json'], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, SENTINEL_NEWS_OFFLINE: '1' },
  });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.items, []);
  assert.equal(out.escalation, false);
  assert.ok(typeof out.asOf === 'string');
  assert.equal(out.meta.instrument, 'WTICO/USD');
});

test('sentinel_news --instrument with no committed config fails loud, no network attempted', () => {
  const res = spawnSync('node', [SCRIPT, '--instrument', 'ZZZ/USD', '--json'], { encoding: 'utf8', timeout: 20000 });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no sentinel query configured/);
});
