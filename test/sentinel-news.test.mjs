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
  buildGnewsQuery, GNEWS_MAX_QUERY_LEN, normalizeGnewsArticle, markGnewsDuplicates,
  fetchGnewsArticles, resolveGnewsConfig, resolveGnewsSource, TOTAL_CAP,
} from '../skills/market-sentinel/scripts/sentinel_news.mjs';
import { loadInstrumentsConfig } from '../scripts/lib/instruments.mjs';

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

// A GET-request fetch double (GNews has no request body, just query params):
// returns `body`/status 200, or a chosen status. Records the requested url.
function mockGnewsFetcher(responses) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push({ url });
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
  assert.ok(r.items.length >= 1 && r.items.every((it) => it.provider === 'newsapi-ai'));
  assert.match(calls[0].url, /getArticles$/);
  assert.equal(calls[0].body.apiKey, 'SECRET');
  assert.deepEqual(calls[0].body.keyword, ['oil', 'OPEC']);
});
test('fetchNewsApiAiArticles: requires an apiKey', async () => {
  await assert.rejects(() => fetchNewsApiAiArticles({ query: '(oil)' }), /requires an apiKey/);
});

test('resolveNewsApiAiConfig: key absent => disabled regardless of mode', () => {
  for (const mode of ['auto', 'shadow']) {
    const c = resolveNewsApiAiConfig({ NEWSAPI_AI_MODE: mode });
    assert.equal(c.enabled, false, mode);
    assert.equal(c.warn, null, mode + ' sets no warn (primary mode removed, #128)');
  }
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
    newsApiAi: { enabled: true, mode: 'auto', apiKey: 'K', shadow: false },
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
    newsApiAi: { enabled: true, mode: 'auto', apiKey: 'K', shadow: false },
  });
  assert.equal(getArticlesCalls, 0, 'no network call for a query that fails local parse');
  assert.equal(res.newsApiAi.requestMade, false, 'a local parse failure is not chargeable');
  assert.equal(res.newsApiAi.ok, false);
});

test('fetchSentinelNews: a disabled newsApiAi config attaches NO diagnostics (no-key output stays byte-for-byte free)', async () => {
  const failing = async () => { throw new Error('offline'); };
  // enabled:false is what resolveNewsApiAiConfig returns without a key.
  const res = await fetchSentinelNews({ query: '(oil)', now: Date.now(), fetcher: failing, newsApiAi: { enabled: false, mode: 'auto', warn: null } });
  assert.equal(res.newsApiAi, undefined, 'no diagnostics when the provider did not run');
  assert.equal(res.providersAttempted, undefined);
  assert.equal(res.observed, undefined);
});

test('resolveNewsApiAiSource: settings.json wins over env; env is the fallback (LaunchAgent never loads .env)', () => {
  // settings present -> used; env ignored for that key
  const s = resolveNewsApiAiSource({ NEWSAPI_AI_KEY: 'from-settings', NEWSAPI_AI_MODE: 'shadow' }, { NEWSAPI_AI_KEY: 'from-env', NEWSAPI_AI_REQUEST_BUDGET: '900' });
  assert.equal(s.NEWSAPI_AI_KEY, 'from-settings');
  assert.equal(s.NEWSAPI_AI_MODE, 'shadow');
  assert.equal(s.NEWSAPI_AI_REQUEST_BUDGET, '900', 'env fills keys settings omits');
  // it feeds resolveNewsApiAiConfig directly
  assert.equal(resolveNewsApiAiConfig(s).enabled, true);
  // empty settings + empty env -> nothing
  assert.deepEqual(resolveNewsApiAiSource({}, {}), {});
});

test('sentinel_news CLI reads NEWSAPI_AI_* from its process env — the server injects these from settings.json into the spawn (#114)', () => {
  // offline: no network; we only assert the CLI resolved the provider config from
  // the env the server would inject (resolveNewsApiAiSource(settings) -> spawn env).
  const res = spawnSync('node', [SCRIPT, '--instrument', 'WTICO/USD', '--json'], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, SENTINEL_NEWS_OFFLINE: '1', NEWSAPI_AI_KEY: 'injected-from-settings', NEWSAPI_AI_MODE: 'shadow' },
  });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.meta.newsApiAiMode, 'shadow', 'CLI honored the injected NEWSAPI_AI_MODE from env');
  assert.equal(out.meta.newsApiAiEnabled, true, 'a key + non-off mode enables the provider');
});

test('sentinel_news CLI: no key in env => provider disabled (free stack only)', () => {
  const res = spawnSync('node', [SCRIPT, '--instrument', 'WTICO/USD', '--json'], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, SENTINEL_NEWS_OFFLINE: '1', NEWSAPI_AI_KEY: '', NEWSAPI_AI_MODE: '' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).meta.newsApiAiEnabled, false);
});

// --- union (#115 revisited): paid + free merged for COMPLETE results ---------
test('fetchSentinelNews: NewsAPI.ai + free are unioned — paid items lead, free items are kept too', async () => {
  const gnews = '<rss><channel><item><title>Free-only oil story</title><link>https://g/free1</link><pubDate>Fri, 24 Jul 2026 18:00:00 GMT</pubDate><description>d</description></item></channel></rss>';
  const naiFx = { articles: { results: [{ uri: 'n1', url: 'https://e/n1', title: 'NewsAPI oil story', dateTimePub: '2026-07-24T18:30:00Z', source: { title: 'Reuters', uri: 'reuters.com' } }] } };
  const now = Date.parse('2026-07-24T19:00:00Z');
  const routes = async (url) => {
    if (/news\.google\.com/.test(url)) return { ok: true, status: 200, text: async () => gnews };
    if (/getArticles/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify(naiFx) };
    throw new Error('offline');
  };
  const res = await fetchSentinelNews({ query: '(oil)', now, fetcher: routes, newsApiAi: { enabled: true, mode: 'auto', apiKey: 'K' } });
  assert.equal(res.newsApiAi.authoritative, true, 'NewsAPI.ai returned items => authoritative flag stays true');
  assert.ok(res.items.some((it) => it.provider === 'newsapi-ai'), 'paid story present in the result');
  assert.ok(res.items.some((it) => it.title === 'Free-only oil story'), 'free-only story merged into the result (not suppressed)');
  assert.equal(res.items[0].provider, 'newsapi-ai', 'newest item (paid, 18:30 > free 18:00) leads after time-sort');
  // provenance intact: every provider's in-window sighting still recorded in `observed`
  assert.ok(res.observed.some((it) => it.title === 'Free-only oil story'), 'free story recorded in observed');
  assert.ok(res.observed.some((it) => it.provider === 'newsapi-ai'), 'paid story recorded in observed');
});

// --- GNews provider --------------------------------------------------------
test('buildGnewsQuery: quotes unquoted multi-word terms, leaves single words and already-quoted phrases alone', () => {
  assert.equal(
    buildGnewsQuery('(natural gas OR LNG OR gas pipeline OR gas supply OR Freeport LNG OR Nord Stream)'),
    '("natural gas" OR LNG OR "gas pipeline" OR "gas supply" OR "Freeport LNG" OR "Nord Stream")',
  );
  assert.equal(
    buildGnewsQuery('(oil OR crude OR OPEC OR "supply disruption")'),
    '(oil OR crude OR OPEC OR "supply disruption")',
    'an already-quoted phrase is left as-is, not double-quoted',
  );
});
test('buildGnewsQuery: rejects an empty query', () => {
  assert.throws(() => buildGnewsQuery('   '), /empty sentinel query/);
});
test('buildGnewsQuery: over the 200-char cap throws — non-chargeable (no network attempt)', () => {
  const long = `(${Array.from({ length: 30 }, (_, i) => `keyword phrase ${i}`).join(' OR ')})`;
  assert.throws(() => buildGnewsQuery(long), new RegExp(`exceeds the ${GNEWS_MAX_QUERY_LEN}-char cap`));
});
test('buildGnewsQuery: every committed sentinel query in config/instruments.yaml fits the 200-char cap', () => {
  const cfg = loadInstrumentsConfig();
  for (const entries of Object.values(cfg.markets)) {
    for (const e of entries) {
      if (!e.sentinel) continue;
      const q = buildGnewsQuery(e.sentinel);
      assert.ok(q.length <= GNEWS_MAX_QUERY_LEN, `${e.slug}: gnews query is ${q.length} chars (${q})`);
    }
  }
});

test('normalizeGnewsArticle: maps a real fixture article, prefers description over content, tags provider gnews', () => {
  const fx = jsonFixture('gnews_search_oil.json');
  const it = normalizeGnewsArticle(fx.articles[0]);
  assert.equal(it.provider, 'gnews');
  assert.equal(it.providerItemId, fx.articles[0].id);
  assert.equal(it.source, fx.articles[0].source.name);
  assert.equal(it.sourceUri, fx.articles[0].source.url);
  assert.equal(it.summary, fx.articles[0].description, 'description preferred over the truncated content');
  assert.equal(it.timeIso, new Date(fx.articles[0].publishedAt).toISOString());
  assert.equal(it.eventUri, null);
  assert.equal(it.sentiment, null);
  assert.equal(it.concepts, null);
  assert.equal(it.isDuplicate, false, 'not yet run through markGnewsDuplicates');
});
test('normalizeGnewsArticle: falls back to (truncated) content when description is absent', () => {
  const it = normalizeGnewsArticle({ title: 't', content: 'body text', description: null });
  assert.equal(it.summary, 'body text');
});

test('markGnewsDuplicates: the 3x BP North Sea case (different outlets, different wording) all mark after the first', () => {
  const fx = jsonFixture('gnews_search_oil.json');
  const items = fx.articles.map(normalizeGnewsArticle);
  markGnewsDuplicates(items);
  const bp = items.filter((it) => /BP puts/.test(it.title));
  assert.equal(bp.length, 3, 'fixture has 3 BP North Sea variants');
  assert.equal(bp[0].isDuplicate, false, 'first sighting (array order) is canonical');
  assert.ok(bp[1].isDuplicate && bp[2].isDuplicate, 'the two later sightings are marked, not dropped');
  assert.equal(items.length, fx.articles.length, 'marking never drops rows — every sighting survives');
});
test('markGnewsDuplicates: distinct stories are never marked as duplicates of each other', () => {
  const items = [
    { title: 'Ukraine strikes Russian oil refinery' },
    { title: 'Gold prices steady amid Fed rate-cut bets' },
  ];
  markGnewsDuplicates(items);
  assert.ok(items.every((it) => !it.isDuplicate));
});

test('fetchGnewsArticles: parses the fixture, marks intra-response duplicates, enforces the lookback locally', async () => {
  const now = Date.parse('2026-07-31T20:00:00Z'); // 12h after the fixture's newest article
  const { fetcher, calls } = mockGnewsFetcher([{ json: jsonFixture('gnews_search_oil.json') }]);
  const r = await fetchGnewsArticles({ query: '(oil OR crude)', apiKey: 'SECRET', fetcher, hours: 24, now });
  assert.equal(r.endpoint, 'search');
  assert.equal(r.items.length, 10, 'every fixture article is within the 24h window');
  assert.ok(r.items.every((it) => it.provider === 'gnews'));
  assert.ok(r.items.some((it) => it.isDuplicate === true), 'the BP/British-man near-duplicates got marked');
  assert.match(calls[0].url, /apikey=SECRET/, 'key travels as a query param (GNews API shape)');
  // The window is widened by the free tier's 12h publication delay, so a 1h
  // lookback still admits these 12h-old articles — without that widening the
  // provider would look empty rather than delayed.
  const shortWindow = await fetchGnewsArticles({ query: '(oil)', apiKey: 'SECRET', fetcher: mockGnewsFetcher([{ json: jsonFixture('gnews_search_oil.json') }]).fetcher, hours: 1, now });
  assert.equal(shortWindow.items.length, 10, 'a 1h lookback still sees 12h-delayed articles (window widened by the delay)');
  // genuinely stale items are still excluded: 48h on, even the widened window drops them
  const stale = await fetchGnewsArticles({ query: '(oil)', apiKey: 'SECRET', fetcher: mockGnewsFetcher([{ json: jsonFixture('gnews_search_oil.json') }]).fetcher, hours: 1, now: now + 48 * 3600000 });
  assert.equal(stale.items.length, 0, 'the widened window is still a window — 48h-old articles are dropped');
});
test('fetchGnewsArticles: requires an apiKey', async () => {
  await assert.rejects(() => fetchGnewsArticles({ query: '(oil)' }), /requires an apiKey/);
});
test('fetchGnewsArticles: a failing fetch never leaks the key in the thrown error string', async () => {
  const leaky = async (url) => { throw new Error(`request to ${url} failed`); }; // simulates a fetch impl that echoes the url
  await assert.rejects(
    () => fetchGnewsArticles({ query: '(oil)', apiKey: 'TOP-SECRET-KEY', fetcher: leaky }),
    (err) => { assert.ok(!err.message.includes('TOP-SECRET-KEY'), `key leaked: ${err.message}`); return true; },
  );
});

test('resolveGnewsConfig: default mode is off; an unknown mode fails CLOSED to off (unlike NewsAPI.ai\'s auto fallback)', () => {
  assert.equal(resolveGnewsConfig({ GNEWS_KEY: 'K' }).mode, 'off');
  assert.equal(resolveGnewsConfig({ GNEWS_KEY: 'K' }).enabled, false, 'off ignores a present key');
  assert.equal(resolveGnewsConfig({ GNEWS_KEY: 'K', GNEWS_MODE: 'bogus' }).mode, 'off');
  assert.equal(resolveGnewsConfig({ GNEWS_KEY: 'K', GNEWS_MODE: 'bogus' }).enabled, false);
});
test('resolveGnewsConfig: key absent => disabled regardless of mode', () => {
  for (const mode of ['auto', 'shadow']) {
    assert.equal(resolveGnewsConfig({ GNEWS_MODE: mode }).enabled, false, mode);
  }
});
test('resolveGnewsConfig: auto/shadow with a key enables it; shadow flags shadow', () => {
  assert.equal(resolveGnewsConfig({ GNEWS_KEY: 'K', GNEWS_MODE: 'auto' }).enabled, true);
  assert.deepEqual(
    (({ enabled, shadow }) => ({ enabled, shadow }))(resolveGnewsConfig({ GNEWS_KEY: 'K', GNEWS_MODE: 'shadow' })),
    { enabled: true, shadow: true },
  );
  assert.equal(resolveGnewsConfig({ GNEWS_KEY: 'K', GNEWS_MODE: 'auto' }).shadow, false);
});
test('resolveGnewsConfig: instrument allowlist gates enablement', () => {
  const env = { GNEWS_KEY: 'K', GNEWS_MODE: 'auto', GNEWS_INSTRUMENTS: 'WTICO/USD' };
  assert.equal(resolveGnewsConfig(env, { instrument: 'WTICO/USD' }).enabled, true);
  assert.equal(resolveGnewsConfig(env, { instrument: 'XAU/USD' }).enabled, false);
  assert.equal(resolveGnewsConfig(env, { instrument: null }).enabled, true);
});

test('resolveGnewsSource: settings.json wins over env; empty settings + empty env -> nothing', () => {
  const s = resolveGnewsSource({ GNEWS_KEY: 'from-settings', GNEWS_MODE: 'shadow' }, { GNEWS_KEY: 'from-env', GNEWS_REQUEST_BUDGET: '500' });
  assert.equal(s.GNEWS_KEY, 'from-settings');
  assert.equal(s.GNEWS_MODE, 'shadow');
  assert.equal(s.GNEWS_REQUEST_BUDGET, '500', 'env fills keys settings omits');
  assert.equal(resolveGnewsConfig(s).enabled, true);
  assert.deepEqual(resolveGnewsSource({}, {}), {});
});

// --- fetchSentinelNews: gnews wiring ---------------------------------------
function gnewsFetchOnly(fixtureName) {
  return async (url) => {
    if (/gnews\.io/.test(url)) return { ok: true, status: 200, text: async () => fixture(fixtureName) };
    throw new Error('offline');
  };
}

test('fetchSentinelNews: gnews absent/off => byte-identical to today\'s free-only output (AC3c)', async () => {
  const now = Date.parse('2026-07-23T12:00:00Z');
  const withoutGnews = await fetchSentinelNews({ query: '(oil)', now, fetcher: gnewsFetchOnly('gnews_search_oil.json'), log: () => {} });
  const withOffGnews = await fetchSentinelNews({
    query: '(oil)', now, fetcher: gnewsFetchOnly('gnews_search_oil.json'), log: () => {},
    gnews: { enabled: false, mode: 'off' },
  });
  assert.deepEqual(withOffGnews, withoutGnews, 'a disabled gnews verdict changes nothing');
  assert.equal(withoutGnews.gnews, undefined);
  assert.equal(withoutGnews.providersAttempted, undefined);
});

test('fetchSentinelNews: shadow mode — the prompt-facing payload (items/escalation/asOf) is byte-identical to off, gnews recorded separately', async () => {
  const now = Date.parse('2026-07-31T20:00:00Z');
  const off = await fetchSentinelNews({ query: '(oil)', now, fetcher: async () => { throw new Error('offline'); }, log: () => {} });
  const shadow = await fetchSentinelNews({
    query: '(oil)', now, fetcher: gnewsFetchOnly('gnews_search_oil.json'), log: () => {},
    gnews: { enabled: true, shadow: true, mode: 'shadow', apiKey: 'K' },
  });
  assert.deepEqual(shadow.items, off.items, 'shadow gnews items never merge into the prompt-facing union');
  assert.equal(shadow.escalation, off.escalation);
  assert.equal(shadow.asOf, off.asOf);
  assert.equal(shadow.gnews.shadow, true);
  assert.ok(shadow.gnewsShadowItems.length > 0, 'gnews items recorded separately for provenance');
});

test('fetchSentinelNews: auto mode merges gnews items into the same deduped/ordered/capped union as every other source', async () => {
  const now = Date.parse('2026-07-31T20:00:00Z');
  const res = await fetchSentinelNews({
    query: '(oil)', now, fetcher: gnewsFetchOnly('gnews_search_oil.json'), log: () => {},
    gnews: { enabled: true, shadow: false, mode: 'auto', apiKey: 'K' },
  });
  const gnewsItems = res.items.filter((it) => it.provider === 'gnews');
  assert.ok(gnewsItems.length >= 8, `the whole delay-widened fixture page reaches the union, got ${gnewsItems.length}`);
  assert.equal(res.gnews.mode, 'auto');
  assert.equal(res.gnews.requestMade, true);
  const times = res.items.map((i) => Date.parse(i.timeIso));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'still newest-first after merging gnews');
  assert.ok(res.items.length <= TOTAL_CAP, 'still capped');
  // The duplicate mark is provenance, NOT a filter: word overlap cannot tell
  // "OPEC agrees to raise output" from "...to cut output", so filtering on it
  // would hide the contradicting event from the model. Marked items must arrive.
  assert.ok(gnewsItems.some((it) => it.isDuplicate === true),
    'items the overlap heuristic marked still reach the union — the mark never filters the prompt');
});

test('fetchSentinelNews: a gnews network failure never aborts the aggregate (free stack + other providers carry)', async () => {
  const now = Date.parse('2026-07-31T20:00:00Z');
  const failer = async (url) => { if (/gnews\.io/.test(url)) return { ok: false, status: 503, text: async () => 'boom' }; throw new Error('offline'); };
  const res = await fetchSentinelNews({
    query: '(oil)', now, fetcher: failer, log: () => {},
    gnews: { enabled: true, shadow: false, mode: 'auto', apiKey: 'K' },
  });
  assert.equal(res.gnews.requestMade, true);
  assert.equal(res.gnews.ok, false);
  assert.equal(res.gnews.status, 503);
  assert.deepEqual(res.items, [], 'no items from any source, but the call itself never throws');
});

test('fetchSentinelNews: an over-cap gnews query is a local, non-chargeable failure (no network call, requestMade false)', async () => {
  const overCap = `(${Array.from({ length: 30 }, (_, i) => `keyword phrase ${i}`).join(' OR ')})`;
  let gnewsCalls = 0;
  const routes = async (url) => { if (/gnews\.io/.test(url)) { gnewsCalls++; return { ok: true, status: 200, text: async () => '{}' }; } throw new Error('offline'); };
  const res = await fetchSentinelNews({
    query: overCap, now: Date.now(), fetcher: routes, log: () => {},
    gnews: { enabled: true, shadow: false, mode: 'auto', apiKey: 'K' },
  });
  assert.equal(gnewsCalls, 0, 'no network call for a query that fails the local char-cap check');
  assert.equal(res.gnews.requestMade, false, 'a local cap failure is not chargeable');
  assert.equal(res.gnews.ok, false);
});

test('fetchSentinelNews: NewsAPI.ai and gnews can both be active without interfering with each other', async () => {
  const now = Date.parse('2026-07-31T20:00:00Z');
  const naiFx = { articles: { results: [{ uri: 'n1', url: 'https://e/n1', title: 'NewsAPI oil story', dateTimePub: '2026-07-31T19:30:00Z', source: { title: 'Reuters', uri: 'reuters.com' } }] } };
  const routes = async (url) => {
    if (/getArticles/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify(naiFx) };
    if (/gnews\.io/.test(url)) return { ok: true, status: 200, text: async () => fixture('gnews_search_oil.json') };
    throw new Error('offline');
  };
  const res = await fetchSentinelNews({
    query: '(oil)', now, fetcher: routes, log: () => {},
    newsApiAi: { enabled: true, mode: 'auto', apiKey: 'K', shadow: false },
    gnews: { enabled: true, mode: 'auto', apiKey: 'K', shadow: false },
  });
  assert.ok(res.items.some((it) => it.provider === 'newsapi-ai'));
  assert.ok(res.items.some((it) => it.provider === 'gnews'));
  assert.equal(res.providersAttempted.includes('newsapi-ai'), true);
  assert.equal(res.providersAttempted.includes('gnews'), true);
});

test('fetchSentinelNews: NewsAPI.ai empty => free-stack fallback (authoritative false)', async () => {
  const gnews = '<rss><channel><item><title>Free fallback story</title><link>https://g/f1</link><pubDate>Fri, 24 Jul 2026 18:00:00 GMT</pubDate><description>d</description></item></channel></rss>';
  const now = Date.parse('2026-07-24T19:00:00Z');
  const routes = async (url) => {
    if (/news\.google\.com/.test(url)) return { ok: true, status: 200, text: async () => gnews };
    if (/getArticles/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ articles: { results: [] } }) };
    throw new Error('offline');
  };
  const res = await fetchSentinelNews({ query: '(oil)', now, fetcher: routes, newsApiAi: { enabled: true, mode: 'auto', apiKey: 'K' } });
  assert.equal(res.newsApiAi.authoritative, false, 'NewsAPI.ai empty => not authoritative');
  assert.ok(res.items.some((it) => it.title === 'Free fallback story'), 'free stack used as fallback when NewsAPI.ai is empty');
});

// The duplicate mark is provenance only and must never gate what the model sees:
// word overlap is blind to the words that carry the meaning, so an
// opposite-direction pair on one subject scores as a single story. Dropping the
// second of such a pair would hide the contradicting — often newer and more
// tradeable — event.
test('markGnewsDuplicates: opposite-direction headlines on one subject DO collide (the heuristic ceiling, documented)', () => {
  const items = [{ title: 'OPEC agrees to raise output', isDuplicate: false }, { title: 'OPEC agrees to cut output', isDuplicate: false }];
  markGnewsDuplicates(items);
  assert.equal(items[1].isDuplicate, true, 'word overlap cannot tell raise from cut — this is why the mark must not gate the prompt');
});

test('fetchSentinelNews: a gnews item marked duplicate still reaches the merged union (marks are provenance, not a filter)', async () => {
  const dupPair = JSON.stringify({ articles: [
    { id: 'g-a', title: 'OPEC agrees to raise output', description: 'a', url: 'https://gnews.example/a', publishedAt: '2026-07-23T09:50:00Z', source: { name: 'Reuters', url: 'reuters.com' } },
    { id: 'g-b', title: 'OPEC agrees to cut output', description: 'b', url: 'https://gnews.example/b', publishedAt: '2026-07-23T09:49:00Z', source: { name: 'AP', url: 'ap.org' } },
  ] });
  const fetcher = async (url) => {
    if (/gnews\.io/.test(url)) return { ok: true, status: 200, text: async () => dupPair };
    throw new Error('offline'); // every free source fails => only gnews contributes
  };
  const out = await fetchSentinelNews({
    query: '(oil OR crude)', hours: 24, fetcher, timeoutMs: 5000, now: Date.parse('2026-07-23T10:00:00Z'), log: () => {},
    gnews: { apiKey: 'GK', mode: 'auto', enabled: true, shadow: false, requestBudget: 100, allow: [], instrumentAllowed: true, background: false },
  });
  const titles = out.items.map((i) => i.title);
  assert.ok(titles.includes('OPEC agrees to raise output'), 'first sighting present');
  assert.ok(titles.includes('OPEC agrees to cut output'), 'the contradicting headline is NOT dropped by the duplicate mark');
});

// The lowercase `and` inside a term used to be treated as an operator, so the
// term was emitted unquoted and GNews read it as an implicit AND — the exact
// failure the quoting exists to prevent.
test('buildGnewsQuery: a term containing "and" stays one quoted phrase, not an implicit AND', () => {
  assert.equal(buildGnewsQuery('(oil OR supply and demand OR crude)'), '(oil OR "supply and demand" OR crude)');
});

// Shadow mode's promise is that nothing it fetched reaches a reader. The CLI's
// --json payload is returned verbatim by the sentinel_news chat tool, so the
// shadow items and the raw provenance list must not ride along in it.
test('sentinel_news --json: shadow items and the provenance list never appear in the CLI payload', () => {
  const res = spawnSync(process.execPath, [
    fileURLToPath(new URL('../skills/market-sentinel/scripts/sentinel_news.mjs', import.meta.url)),
    '--query', '(oil)', '--hours', '6', '--json',
  ], { encoding: 'utf8', env: { ...process.env, GNEWS_KEY: '', NEWSAPI_AI_KEY: '' }, timeout: 30000 });
  const payload = JSON.parse(res.stdout);
  assert.equal('gnewsShadowItems' in payload, false, 'no gnews shadow items in the tool payload');
  assert.equal('shadowItems' in payload, false, 'no paid-provider shadow items in the tool payload');
  assert.equal('observed' in payload, false, 'no raw provenance list in the tool payload');
  assert.ok(Array.isArray(payload.items), 'the prompt-facing items array is still there');
});

// Shadow mode's whole purpose is the provenance log the provider report reads.
// Filtering it by the narrow window recorded ~1 of every 10 articles just paid
// for, leaving the comparison empty in exactly the mode the free key supports.
test('fetchSentinelNews: shadow records every in-window gnews sighting, using the delay-widened window', async () => {
  const now = Date.parse('2026-07-31T20:00:00Z');
  const res = await fetchSentinelNews({
    query: '(oil)', now, hours: 6, fetcher: gnewsFetchOnly('gnews_search_oil.json'), log: () => {},
    gnews: { enabled: true, shadow: true, mode: 'shadow', apiKey: 'K' },
  });
  const observedGnews = (res.observed || []).filter((it) => it.provider === 'gnews');
  assert.equal(observedGnews.length, 10, `all 10 fetched articles are recorded, got ${observedGnews.length}`);
  assert.equal(res.items.some((it) => it.provider === 'gnews'), false, 'and none of them reaches the prompt-facing items');
});

test('buildGnewsQuery: operators must be uppercase, and AND/NOT is rejected rather than quoted into a phrase', () => {
  // a lowercase `or` inside a term is part of the term, not an operator
  assert.equal(buildGnewsQuery('(rate cut or hike OR crude)'), '("rate cut or hike" OR crude)');
  // silently searching for the literal string "oil AND OPEC" is the same class of
  // mangling as an unquoted phrase — fail loud, and non-chargeably
  assert.throws(() => buildGnewsQuery('(oil AND OPEC)'), /OR lists only/);
  assert.throws(() => buildGnewsQuery('(oil NOT shale)'), /OR lists only/);
});
