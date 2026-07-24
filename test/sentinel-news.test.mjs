import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ESCALATION_LEXICON, GDELT_TONE_ESCALATION_THRESHOLD, computeEscalation,
  parseFeedItems, normalizeRssItem, normalizeGdeltArticle, dedupeItems,
  fetchSentinelNews, createGdeltThrottle, resolveQuery, parseArgs,
  parseSentinelQueryToKeywords, normalizeNewsApiAiArticle, fetchNewsApiAiArticles,
  resolveNewsApiAiConfig, NEWSAPI_AI_MAX_KEYWORDS, resolveNewsApiAiSource,
} from '../skills/market-sentinel/scripts/sentinel_news.mjs';

// A fetch double: returns `body` (object => JSON) with status 200, or a chosen
// status. Records the requested url + parsed request body for assertions.
function mockFetcher(responses) {
  const calls = [];
  const fetcher = async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    const status = r?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof r?.json === 'string' ? r.json : JSON.stringify(r?.json ?? {})),
    };
  };
  return { fetcher, calls };
}
const jsonFixture = (name) => JSON.parse(fixture(name));

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

test('computeEscalation: "war"/"strike" are word-boundary matched, not raw substrings', () => {
  assert.equal(computeEscalation({ title: 'warning of rain' }), false, 'warn(ing) is not war');
  assert.equal(computeEscalation({ title: 'Traffic pushes forward toward downtown' }), false, 'forward/toward are not war');
  assert.equal(computeEscalation({ title: 'missile strike on tanker' }), true);
  assert.equal(computeEscalation({ title: 'Vendors strikes a deal on new supply contract' }), false, 'strikes-a-deal is not a strike');
  assert.equal(computeEscalation({ title: 'war breaks out' }), true);
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
  // GDELT's seendate is compact ISO 8601 ("20260723T090500Z", no separators)
  // — Date.parse alone returns NaN for this shape, which would silently drop
  // GDELT items' timestamps (bypassing the lookback window, sorting as 0).
  assert.equal(item.timeIso, '2026-07-23T09:05:00.000Z');

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

test('dedupeItems: strips a Google News " - Publisher" suffix before the fuzzy-title fallback, so a real cross-source story (different urls) collapses', () => {
  const items = [
    { title: 'Oil jumps on Houthi attack - Reuters', url: 'https://news.google.com/rss/articles/abc' },
    { title: 'Oil jumps on Houthi attack', url: 'https://gdelt.example/houthi-attack' }, // same story, bare title from GDELT
  ];
  const out = dedupeItems(items);
  assert.equal(out.length, 1);
});

test('dedupeItems: does not corrupt a legitimate title that happens to contain " - "', () => {
  const items = [
    { title: 'Crude oil - a deep dive into the 2026 supply glut and what it means for prices', url: 'https://a/1' },
    { title: 'Oil demand outlook - 2026 edition - full report with methodology notes', url: 'https://a/2' },
  ];
  const out = dedupeItems(items);
  assert.equal(out.length, 2, 'long/clausal " - " segments are not mistaken for a publisher suffix');
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

// --- parseArgs: boolean flags (--json/--help) never consume the next token --
test('parseArgs: --json before a value flag does not swallow the following flag/value (order-independent)', () => {
  const withJsonFirst = parseArgs(['--json', '--instrument', 'WTICO/USD', '--hours', '6']);
  const withJsonLast = parseArgs(['--instrument', 'WTICO/USD', '--hours', '6', '--json']);
  assert.deepEqual(withJsonFirst, withJsonLast);
  assert.equal(withJsonFirst.json, true);
  assert.equal(withJsonFirst.instrument, 'WTICO/USD');
  assert.equal(withJsonFirst.hours, 6);
});

test('parseArgs: --json followed by a bare positional does not get treated as its value', () => {
  const out = parseArgs(['--json', 'unexpected-positional', '--max-items', '5']);
  assert.equal(out.json, true);
  assert.equal(out.maxItems, 5, 'the positional after --json never binds to --json, so --max-items still gets its own value');
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

// --- NewsAPI.ai provider (issue #104) --------------------------------------
test('parseSentinelQueryToKeywords: OR-splits, strips one paren pair + quotes, keeps phrases', () => {
  const kws = parseSentinelQueryToKeywords('(oil OR crude OR OPEC OR "supply disruption")');
  assert.deepEqual(kws, ['oil', 'crude', 'OPEC', 'supply disruption']);
});
test('parseSentinelQueryToKeywords: case-insensitive OR, unquoted multi-word phrase preserved', () => {
  assert.deepEqual(parseSentinelQueryToKeywords('natural gas OR LNG or gas pipeline'), ['natural gas', 'LNG', 'gas pipeline']);
});
test('parseSentinelQueryToKeywords: empty query rejected, never silently empty', () => {
  assert.throws(() => parseSentinelQueryToKeywords('   '), /empty sentinel query/);
  assert.throws(() => parseSentinelQueryToKeywords('()'), /empty sentinel query/);
});
test('parseSentinelQueryToKeywords: over the 15-keyword trial limit throws (no silent truncation)', () => {
  const many = Array.from({ length: NEWSAPI_AI_MAX_KEYWORDS + 1 }, (_, i) => `k${i}`).join(' OR ');
  assert.throws(() => parseSentinelQueryToKeywords(many), /exceeds trial limit of 15/);
});

test('normalizeNewsApiAiArticle: maps a real fixture article, prefers dateTimePub, carries provider metadata', () => {
  const article = jsonFixture('newsapi_ai_get_articles.json').articles.results[0];
  const it = normalizeNewsApiAiArticle(article);
  assert.equal(it.provider, 'newsapi-ai');
  assert.equal(it.providerItemId, article.uri);
  assert.equal(it.timeIso, new Date(article.dateTimePub).toISOString());
  assert.equal(it.sourceUri, article.source.uri);
  assert.notEqual(it.source, it.sourceUri, 'display title distinct from source domain/uri');
  assert.ok(it.summary === null || it.summary.length <= 500);
});
test('normalizeNewsApiAiArticle: falls back to dateTime when dateTimePub is absent', () => {
  const it = normalizeNewsApiAiArticle({ title: 't', dateTime: '2026-07-24T10:00:00Z', dateTimePub: null });
  assert.equal(it.timeIso, '2026-07-24T10:00:00.000Z');
});

test('fetchNewsApiAiArticles: getArticles path parses results, sends the key only in the body', async () => {
  const { fetcher, calls } = mockFetcher([{ json: jsonFixture('newsapi_ai_get_articles.json') }]);
  const r = await fetchNewsApiAiArticles({ query: '(oil OR OPEC)', apiKey: 'SECRET', fetcher, hours: 24, now: Date.parse('2026-07-24T20:00:00Z') });
  assert.equal(r.endpoint, 'getArticles');
  assert.equal(r.cursor, null);
  assert.ok(r.items.length >= 1 && r.items.every((it) => it.provider === 'newsapi-ai'));
  assert.match(calls[0].url, /getArticles$/);
  assert.equal(calls[0].body.apiKey, 'SECRET');
  assert.deepEqual(calls[0].body.keyword, ['oil', 'OPEC']);
});
test('fetchNewsApiAiArticles: minuteStream path advances the cursor from the response', async () => {
  const fx = jsonFixture('newsapi_ai_minute_stream.json');
  const { fetcher, calls } = mockFetcher([{ json: fx }]);
  const r = await fetchNewsApiAiArticles({ query: '(oil)', apiKey: 'SECRET', fetcher, cursor: 'prev-cursor' });
  assert.equal(r.endpoint, 'minuteStream');
  assert.equal(r.cursor, fx.recentActivityArticles.newestUri.news);
  assert.match(calls[0].url, /minuteStreamArticles$/);
  assert.equal(calls[0].body.recentActivityArticlesNewsUpdatesAfterUri, 'prev-cursor');
});
test('fetchNewsApiAiArticles: keeps the prior cursor when the response omits newestUri', async () => {
  const { fetcher } = mockFetcher([{ json: { recentActivityArticles: { activity: [] } } }]);
  const r = await fetchNewsApiAiArticles({ query: '(oil)', apiKey: 'K', fetcher, cursor: 'keep-me' });
  assert.equal(r.cursor, 'keep-me');
});
test('fetchNewsApiAiArticles: requires an apiKey', async () => {
  await assert.rejects(() => fetchNewsApiAiArticles({ query: '(oil)' }), /requires an apiKey/);
});

test('resolveNewsApiAiConfig: key absent => disabled regardless of mode', () => {
  for (const mode of ['auto', 'primary', 'shadow']) {
    const c = resolveNewsApiAiConfig({ NEWSAPI_AI_MODE: mode });
    assert.equal(c.enabled, false, mode);
  }
  assert.match(resolveNewsApiAiConfig({ NEWSAPI_AI_MODE: 'primary' }).warn, /falling back to free/);
});
test('resolveNewsApiAiConfig: auto with a key enables it; off ignores the key', () => {
  assert.equal(resolveNewsApiAiConfig({ NEWSAPI_AI_KEY: 'K', NEWSAPI_AI_MODE: 'auto' }).enabled, true);
  assert.equal(resolveNewsApiAiConfig({ NEWSAPI_AI_KEY: 'K', NEWSAPI_AI_MODE: 'off' }).enabled, false);
});
test('resolveNewsApiAiConfig: shadow enables but flags shadow; unknown mode falls back to auto', () => {
  assert.deepEqual(
    (({ enabled, shadow }) => ({ enabled, shadow }))(resolveNewsApiAiConfig({ NEWSAPI_AI_KEY: 'K', NEWSAPI_AI_MODE: 'shadow' })),
    { enabled: true, shadow: true },
  );
  assert.equal(resolveNewsApiAiConfig({ NEWSAPI_AI_KEY: 'K', NEWSAPI_AI_MODE: 'bogus' }).mode, 'auto');
});
test('resolveNewsApiAiConfig: instrument allowlist gates background instruments, passes on-demand (null)', () => {
  const env = { NEWSAPI_AI_KEY: 'K', NEWSAPI_AI_INSTRUMENTS: 'WTICO/USD' };
  assert.equal(resolveNewsApiAiConfig(env, { instrument: 'WTICO/USD' }).enabled, true);
  assert.equal(resolveNewsApiAiConfig(env, { instrument: 'XAU/USD' }).enabled, false);
  assert.equal(resolveNewsApiAiConfig(env, { instrument: null }).enabled, true);
});

test('fetchSentinelNews: newsApiAi=null preserves free-only behavior (no newsApiAi diagnostics)', async () => {
  const { fetcher } = mockFetcher([]); // will not be used by RSS sources? — force all free sources to fail
  const failing = async () => { throw new Error('offline'); };
  const res = await fetchSentinelNews({ query: '(oil)', fetcher: failing, now: Date.now() });
  assert.equal(res.newsApiAi, undefined);
  assert.equal(res.providersAttempted, undefined);
  assert.deepEqual(res.items, []);
});
test('fetchSentinelNews: NewsAPI.ai wins the canonical merge over a free-source duplicate', async () => {
  // Free stack: one Google-News style item; NewsAPI.ai: same story, richer.
  const gnews = `<rss><channel><item><title>Oil jumps on Houthi tanker attack - Reuters</title>
    <link>https://news.google.com/x</link><pubDate>Fri, 24 Jul 2026 18:00:00 GMT</pubDate><description>d</description></item></channel></rss>`;
  const naiFx = { articles: { results: [{
    uri: 'nai-1', url: 'https://eventregistry.org/a/1', title: 'Oil jumps on Houthi tanker attack',
    dateTimePub: '2026-07-24T18:01:00Z', source: { uri: 'reuters.com', title: 'Reuters' }, eventUri: 'evt-9', sentiment: -0.3,
  }] } };
  const now = Date.parse('2026-07-24T19:00:00Z');
  // google-news is the FIRST free fetch; others fail. newsapi-ai uses its own body call.
  const routes = async (url) => {
    if (/news\.google\.com/.test(url)) return { ok: true, status: 200, text: async () => gnews };
    if (/getArticles/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify(naiFx) };
    throw new Error('source offline');
  };
  const res = await fetchSentinelNews({
    query: '(oil OR tanker)', now, fetcher: routes,
    newsApiAi: { enabled: true, mode: 'primary', apiKey: 'K', shadow: false },
  });
  const merged = res.items.filter((it) => /Houthi tanker attack/.test(it.title));
  assert.equal(merged.length, 1, 'duplicate collapsed to one canonical item');
  assert.equal(merged[0].provider, 'newsapi-ai', 'richer NewsAPI.ai item kept');
  assert.equal(merged[0].eventUri, 'evt-9');
  assert.equal(res.newsApiAi.requestMade, true);
  assert.equal(res.providersAttempted[0], 'newsapi-ai');
});
test('fetchSentinelNews: shadow mode records NewsAPI.ai but never merges into items/ordering', async () => {
  const naiFx = { articles: { results: [{ uri: 's1', url: 'https://x/s1', title: 'Shadow only story', dateTimePub: '2026-07-24T18:30:00Z', source: { title: 'Src' } }] } };
  const now = Date.parse('2026-07-24T19:00:00Z');
  const routes = async (url) => {
    if (/getArticles/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify(naiFx) };
    throw new Error('offline');
  };
  const res = await fetchSentinelNews({ query: '(oil)', now, fetcher: routes, newsApiAi: { enabled: true, shadow: true, mode: 'shadow', apiKey: 'K' } });
  assert.equal(res.items.length, 0, 'shadow item not merged');
  assert.equal(res.shadowItems.length, 1, 'shadow item recorded separately');
  assert.equal(res.newsApiAi.shadow, true);
});
test('fetchSentinelNews: a NewsAPI.ai failure never aborts the aggregate (free stack carries)', async () => {
  const gnews = `<rss><channel><item><title>Oil steady</title><link>https://g/1</link><pubDate>Fri, 24 Jul 2026 18:00:00 GMT</pubDate><description>d</description></item></channel></rss>`;
  const now = Date.parse('2026-07-24T19:00:00Z');
  const routes = async (url) => {
    if (/news\.google\.com/.test(url)) return { ok: true, status: 200, text: async () => gnews };
    if (/getArticles/.test(url)) return { ok: false, status: 503, text: async () => 'boom' };
    throw new Error('offline');
  };
  const res = await fetchSentinelNews({ query: '(oil)', now, fetcher: routes, newsApiAi: { enabled: true, mode: 'auto', apiKey: 'K' } });
  assert.ok(res.items.some((it) => it.title === 'Oil steady'), 'free-stack item survived NewsAPI.ai failure');
  assert.equal(res.newsApiAi.itemsReturned, 0);
});

// --- Copilot review fixes (PR #105) ----------------------------------------
test('fetchSentinelNews: an over-limit/unsupported query is a local parse error — non-chargeable (requestMade false), no network call', async () => {
  const overLimit = `(${Array.from({ length: 20 }, (_, i) => `k${i}`).join(' OR ')})`;
  let getArticlesCalls = 0;
  const routes = async (url) => {
    if (/getArticles/.test(url)) { getArticlesCalls++; return { ok: true, status: 200, text: async () => '{}' }; }
    throw new Error('free offline');
  };
  const res = await fetchSentinelNews({
    query: overLimit, now: Date.now(), fetcher: routes,
    newsApiAi: { enabled: true, mode: 'primary', apiKey: 'K', shadow: false },
  });
  assert.equal(getArticlesCalls, 0, 'no network call for a query that fails local parse');
  assert.equal(res.newsApiAi.requestMade, false, 'a local parse failure is not chargeable');
  assert.equal(res.newsApiAi.ok, false);
});

test('fetchSentinelNews: a disabled newsApiAi config attaches NO diagnostics (no-key output stays byte-for-byte free)', async () => {
  const failing = async () => { throw new Error('offline'); };
  // enabled:false is what resolveNewsApiAiConfig returns without a key (incl. primary-mode warn).
  const res = await fetchSentinelNews({ query: '(oil)', now: Date.now(), fetcher: failing, newsApiAi: { enabled: false, mode: 'primary', warn: 'primary but no key' } });
  assert.equal(res.newsApiAi, undefined, 'no diagnostics when the provider did not run');
  assert.equal(res.providersAttempted, undefined);
  assert.equal(res.observed, undefined);
});

test('resolveNewsApiAiSource: settings.json wins over env; env is the fallback (LaunchAgent never loads .env)', () => {
  // settings present -> used; env ignored for that key
  const s = resolveNewsApiAiSource({ NEWSAPI_AI_KEY: 'from-settings', NEWSAPI_AI_MODE: 'primary' }, { NEWSAPI_AI_KEY: 'from-env', NEWSAPI_AI_REQUEST_BUDGET: '900' });
  assert.equal(s.NEWSAPI_AI_KEY, 'from-settings');
  assert.equal(s.NEWSAPI_AI_MODE, 'primary');
  assert.equal(s.NEWSAPI_AI_REQUEST_BUDGET, '900', 'env fills keys settings omits');
  // it feeds resolveNewsApiAiConfig directly
  assert.equal(resolveNewsApiAiConfig(s).enabled, true);
  // empty settings + empty env -> nothing
  assert.deepEqual(resolveNewsApiAiSource({}, {}), {});
});
