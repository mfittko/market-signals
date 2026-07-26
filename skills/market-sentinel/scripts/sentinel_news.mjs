#!/usr/bin/env node
/**
 * market-sentinel / sentinel_news — free, query-driven breaking-news fetcher
 * (issue #86): Google News RSS, GDELT DOC 2.0, Al Jazeera, OilPrice.com, and a
 * per-instrument Yahoo Finance headline feed. Normalizes every source to one
 * schema, dedups (url + fuzzy title), sorts newest-first, and computes an
 * escalationFlag. Bounded (per-source cap, total cap, per-fetch timeout) and
 * failure-isolated: a dead feed yields [] + a log line, never a throw.
 *
 * Mirrors skills/fxempire-analysis/scripts/fxempire_articles.mjs's shape:
 * emits JSON via --json, wired as a CHAT_TOOL by scripts/signal-server.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { sentinelConfigForInstrument } from '../../../scripts/lib/instruments.mjs';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// --- escalation (named constants, issue #86 AC6) ---------------------------
export const ESCALATION_LEXICON = [
  'attack', 'strike', 'sanction', 'embargo', 'hormuz', 'tanker', 'missile',
  'drone', 'escalat', 'war', 'opec cut', 'supply disruption',
];
export const GDELT_TONE_ESCALATION_THRESHOLD = -5;

// 'war' and 'strike' are short, common English words that over-fire as a raw
// substring (e.g. 'warn'/'warning'/'forward'/'toward' contain 'war'; 'strikes
// a deal' contains 'strike') — matched whole-word instead. Everything else in
// the lexicon (longer single words, the 'escalat*' stem, and multi-word
// phrases) is precise enough as a plain substring.
const WORD_BOUNDARY_TERMS = new Set(['war', 'strike']);

function termMatches(term, text) {
  if (WORD_BOUNDARY_TERMS.has(term)) return new RegExp(`\\b${term}\\b`, 'i').test(text);
  return text.includes(term);
}

export function computeEscalation({ title, summary, tone } = {}) {
  if (Number.isFinite(tone) && tone < GDELT_TONE_ESCALATION_THRESHOLD) return true;
  const text = `${title || ''} ${summary || ''}`.toLowerCase();
  return ESCALATION_LEXICON.some((kw) => termMatches(kw, text));
}

// --- tiny RSS/Atom parse (no new deps; a hand-rolled regex parser, same
// spirit as fxempire_articles' own HTML/entity handling) --------------------
function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/g, (m, n) => named[n] ?? m);
}

// Google News' <description> is entity-encoded HTML (e.g. "&lt;a href=...&gt;"),
// not literal tags — decode BEFORE stripping, then decode once more for
// anything the first pass unwrapped into a fresh entity.
function stripTags(html) {
  const unwrapped = decodeEntities(String(html || ''));
  return decodeEntities(unwrapped.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tagValue(block, name) {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].trim() : null;
}

function linkValue(block) {
  const withHref = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i);
  if (withHref) return withHref[1];
  return tagValue(block, 'link');
}

// Parses RSS 2.0 <item> and Atom <entry> blocks into raw {title, link, pubDate, description}.
export function parseFeedItems(xml) {
  const items = [];
  const re = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const block = m[2];
    items.push({
      title: decodeEntities(tagValue(block, 'title') || '').trim(),
      link: (linkValue(block) || '').trim(),
      pubDate: tagValue(block, 'pubDate') || tagValue(block, 'published') || tagValue(block, 'updated'),
      description: stripTags(tagValue(block, 'description') || tagValue(block, 'summary') || tagValue(block, 'content') || ''),
    });
  }
  return items;
}

function parseFeedDate(raw) {
  if (!raw) return null;
  // GDELT's seendate is compact "basic" ISO 8601 (e.g. "20260723T090500Z", no
  // dashes/colons) — V8's Date.parse only recognizes the "extended" form, so
  // it returns NaN for this shape. Expand to extended ISO 8601 first.
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(raw));
  const normalized = compact ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z` : raw;
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// --- normalize: every source lands on {source,title,timeIso,summary,url,tone?,themes?} ---
export function normalizeRssItem(source, raw) {
  const title = raw.title || '';
  const summary = (raw.description || '').slice(0, 500) || null;
  return {
    source,
    title,
    timeIso: parseFeedDate(raw.pubDate),
    summary,
    url: raw.link || null,
    tone: null,
    themes: null,
    escalation: computeEscalation({ title, summary }),
  };
}

export function normalizeGdeltArticle(article) {
  const title = article?.title || '';
  const tone = Number(article?.tone);
  const toneVal = Number.isFinite(tone) ? tone : null;
  const themes = typeof article?.themes === 'string'
    ? article.themes.split(';').map((t) => t.trim()).filter(Boolean)
    : null;
  return {
    source: 'gdelt',
    title,
    timeIso: parseFeedDate(article?.seendate),
    summary: null,
    url: article?.url || null,
    tone: toneVal,
    themes,
    escalation: computeEscalation({ title, tone: toneVal }),
  };
}

// --- NewsAPI.ai / Event Registry provider (issue #104) ----------------------
// A preferred commercial provider layered onto the free stack: same normalized
// item shape (extended with optional provider metadata), same failure-isolation
// contract. One adapter over the query-filtered getArticles endpoint, used for
// both the on-demand --hours lookback and the decision-point pull. Host is
// eventregistry.org (newsapi.ai is an alias for the same API).
export const NEWSAPI_AI_HOST = 'https://eventregistry.org';
export const NEWSAPI_AI_GET_ARTICLES_URL = `${NEWSAPI_AI_HOST}/api/v1/article/getArticles`;
export const NEWSAPI_AI_MAX_KEYWORDS = 15;         // trial limit
export const DEFAULT_NEWSAPI_AI_BUDGET = 1800;
// Initial API filters — named so they can be tuned from trial evidence.
export const NEWSAPI_AI_FILTERS = {
  dataType: ['news'], lang: ['eng'], keywordOper: 'or', keywordLoc: 'title', isDuplicateFilter: 'skipDuplicates',
};

// Convert a committed sentinel OR-query into a NewsAPI.ai keyword array.
// `(oil OR crude OR "supply disruption")` -> ['oil','crude','supply disruption'].
// Splits only on case-insensitive ` OR `, strips one surrounding paren pair and
// surrounding quotes, preserves multi-word phrases, rejects empty, and never
// silently truncates: >15 keywords throws so the caller falls back to free.
export function parseSentinelQueryToKeywords(query) {
  let q = String(query || '').trim();
  if (q.startsWith('(') && q.endsWith(')')) q = q.slice(1, -1).trim();
  if (!q) throw new Error('empty sentinel query');
  const keywords = q.split(/\s+OR\s+/i)
    .map((t) => t.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
  if (!keywords.length) throw new Error('sentinel query produced no keywords');
  if (keywords.length > NEWSAPI_AI_MAX_KEYWORDS) {
    throw new Error(`sentinel query has ${keywords.length} keywords, exceeds trial limit of ${NEWSAPI_AI_MAX_KEYWORDS}`);
  }
  return keywords;
}

// Normalize a NewsAPI.ai article (getArticles.results[]) into the common item,
// extended with provider metadata. dateTimePub is preferred (publish time) over
// dateTime (ingest time).
export function normalizeNewsApiAiArticle(article) {
  const title = article?.title || '';
  const body = article?.body || '';
  const summary = body ? body.slice(0, 500) : null;
  return {
    provider: 'newsapi-ai',
    providerItemId: article?.uri || null,
    source: article?.source?.title || article?.source?.uri || 'unknown',
    sourceUri: article?.source?.uri || null,
    title,
    timeIso: parseFeedDate(article?.dateTimePub || article?.dateTime),
    summary,
    url: article?.url || null,
    eventUri: article?.eventUri || null,
    sentiment: Number.isFinite(article?.sentiment) ? article.sentiment : null,
    concepts: Array.isArray(article?.concepts) ? article.concepts : null,
    isDuplicate: typeof article?.isDuplicate === 'boolean' ? article.isDuplicate : null,
    tone: null,
    themes: null,
    // Escalation on the SAME truncated summary the other providers use (not the
    // full raw body) — consistent behavior, no over-trigger on long bodies.
    escalation: computeEscalation({ title, summary }),
  };
}

async function safeFetchJson(url, { fetcher, timeoutMs, body }) {
  const res = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(await res.text());
}

// The provider adapter: the query-filtered getArticles endpoint (newest-first),
// with the requested lookback enforced locally. The key is only ever sent in the
// request body, never returned, logged, or persisted by this function.
export async function fetchNewsApiAiArticles({
  query, hours = DEFAULT_HOURS, maxItems = PER_SOURCE_CAP,
  apiKey, fetcher = defaultFetcher, timeoutMs = FETCH_TIMEOUT_MS, now = Date.now(),
} = {}) {
  if (!apiKey) throw new Error('fetchNewsApiAiArticles requires an apiKey');
  const keywords = parseSentinelQueryToKeywords(query); // throws on unsupported/over-limit
  const body = {
    action: 'getArticles',
    keyword: keywords, keywordOper: NEWSAPI_AI_FILTERS.keywordOper, keywordLoc: NEWSAPI_AI_FILTERS.keywordLoc,
    lang: NEWSAPI_AI_FILTERS.lang, dataType: NEWSAPI_AI_FILTERS.dataType, isDuplicateFilter: NEWSAPI_AI_FILTERS.isDuplicateFilter,
    articlesSortBy: 'date', articlesCount: Math.min(maxItems, 100),
    includeArticleConcepts: true, includeArticleSentiment: true, includeArticleEventUri: true,
    resultType: 'articles', apiKey,
  };
  const json = await safeFetchJson(NEWSAPI_AI_GET_ARTICLES_URL, { fetcher, timeoutMs, body });
  const arr = Array.isArray(json?.articles?.results) ? json.articles.results : [];
  const cutoffMs = now - hours * 3600000;
  const items = arr.map(normalizeNewsApiAiArticle)
    .filter((it) => !it.timeIso || Date.parse(it.timeIso) >= cutoffMs); // locally enforce --hours
  return { items, endpoint: 'getArticles' };
}

// The settings-first NEWSAPI_AI_* resolver lives in a tiny standalone lib so
// consumers (signal-server) don't take a hard startup dependency on this skill
// module (issue #114 review); re-exported here for existing importers.
export { NEWSAPI_AI_SETTING_KEYS, resolveNewsApiAiSource, NEWSAPI_AI_MODES } from '../../../scripts/lib/newsapi-ai-source.mjs';
import { NEWSAPI_AI_MODES } from '../../../scripts/lib/newsapi-ai-source.mjs';

// Resolve provider config from env (mode/key/budget/instrument allowlist) into a
// single `enabled/shadow` verdict. `off` and a missing key both disable it;
// `primary` without a key warns but still falls back to the free stack (never a
// single point of failure). An empty allowlist means "all sentinel instruments".
export function resolveNewsApiAiConfig(env = process.env, { instrument = null } = {}) {
  const apiKey = env.NEWSAPI_AI_KEY || null;
  let mode = String(env.NEWSAPI_AI_MODE || 'auto').toLowerCase();
  if (!NEWSAPI_AI_MODES.includes(mode)) mode = 'auto';
  const parsedBudget = Number.parseInt(env.NEWSAPI_AI_REQUEST_BUDGET, 10);
  const requestBudget = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : DEFAULT_NEWSAPI_AI_BUDGET;
  const allow = String(env.NEWSAPI_AI_INSTRUMENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const instrumentAllowed = !allow.length || !instrument || allow.includes(instrument);

  // enabled only when on, keyed, and instrument-allowed. (`warn` stays in the
  // shape — fetchSentinelNews still logs a caller-supplied warn — but no mode
  // sets it anymore since `primary` was dropped.)
  const enabled = mode !== 'off' && !!apiKey && instrumentAllowed;
  const warn = null;

  return { apiKey, mode, enabled, shadow: enabled && mode === 'shadow', requestBudget, allow, instrumentAllowed, warn };
}

// --- dedup: exact url match, else fuzzy (normalized) title match ------------
// Google News' <title> appends " - Publisher" (e.g. "Oil jumps on Houthi
// attack - Reuters"); GDELT/Al Jazeera/OilPrice carry the bare headline for
// the same story. Strip a trailing " - X" segment before normalizing so the
// two collapse — but only when X reads like a short publisher name, so a
// legitimate " - " elsewhere in a title (a real clause, a dash-joined date)
// is left alone.
function stripPublisherSuffix(title) {
  const s = String(title || '');
  const idx = s.lastIndexOf(' - ');
  if (idx === -1) return s;
  const suffix = s.slice(idx + 3).trim();
  const looksLikePublisher = suffix.length > 0 && suffix.length <= 30
    && suffix.split(/\s+/).length <= 4 && !/[.!?:;]/.test(suffix);
  return looksLikePublisher ? s.slice(0, idx) : s;
}

export function normTitle(t) {
  return stripPublisherSuffix(String(t || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function dedupeItems(items) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  const out = [];
  for (const it of items) {
    const t = normTitle(it.title);
    if ((it.url && seenUrls.has(it.url)) || (t && seenTitles.has(t))) continue;
    if (it.url) seenUrls.add(it.url);
    if (t) seenTitles.add(t);
    out.push(it);
  }
  return out;
}

// --- fetch plumbing: bounded, failure-isolated ------------------------------
async function defaultFetcher(url, opts) {
  return fetch(url, opts);
}

async function safeFetchText(url, { fetcher, timeoutMs, headers }) {
  const res = await fetcher(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// One failing source must never fail the whole call (issue #86 AC1): logs and
// yields [] instead of throwing.
async function fetchSourceSafe(name, run, log) {
  try {
    return await run();
  } catch (err) {
    log(`${name} failed: ${err && err.message ? err.message : String(err)}`);
    return [];
  }
}

// GDELT's DOC 2.0 API is rate-limited to ~1 req/5s per IP; the background
// poller shares ONE throttle instance across its per-instrument fetches in a
// tick so successive GDELT calls stay spaced, without ever sleeping when only
// one instrument (or the on-demand tool) is in play.
export function createGdeltThrottle({ minGapMs = 5000, sleep = (ms) => delay(ms), now = () => Date.now() } = {}) {
  let last = 0;
  return async function throttle() {
    const wait = last ? minGapMs - (now() - last) : 0;
    if (wait > 0) await sleep(wait);
    last = now();
  };
}

async function fetchGoogleNews(query, { fetcher, timeoutMs, perSourceCap }) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const text = await safeFetchText(url, { fetcher, timeoutMs, headers: { 'user-agent': USER_AGENT, accept: '*/*' } });
  return parseFeedItems(text).slice(0, perSourceCap).map((r) => normalizeRssItem('google-news', r));
}

async function fetchAlJazeera({ fetcher, timeoutMs, perSourceCap }) {
  const text = await safeFetchText('https://www.aljazeera.com/xml/rss/all.xml', { fetcher, timeoutMs, headers: { 'user-agent': USER_AGENT, accept: '*/*' } });
  return parseFeedItems(text).slice(0, perSourceCap).map((r) => normalizeRssItem('al-jazeera', r));
}

async function fetchOilPrice({ fetcher, timeoutMs, perSourceCap }) {
  const text = await safeFetchText('https://oilprice.com/rss/main', { fetcher, timeoutMs, headers: { 'user-agent': USER_AGENT, accept: '*/*' } });
  return parseFeedItems(text).slice(0, perSourceCap).map((r) => normalizeRssItem('oilprice', r));
}

async function fetchYahoo(symbol, { fetcher, timeoutMs, perSourceCap }) {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
  const text = await safeFetchText(url, { fetcher, timeoutMs, headers: { 'user-agent': USER_AGENT, accept: '*/*' } });
  return parseFeedItems(text).slice(0, perSourceCap).map((r) => normalizeRssItem('yahoo', r));
}

async function fetchGdelt(query, { fetcher, timeoutMs, perSourceCap, hours, gdeltThrottle }) {
  if (gdeltThrottle) await gdeltThrottle();
  const span = Math.max(1, Math.min(Math.round(hours), 1440));
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=json&timespan=${span}h&sort=datedesc`;
  const text = await safeFetchText(url, { fetcher, timeoutMs, headers: { accept: 'application/json' } });
  const json = JSON.parse(text);
  const arr = Array.isArray(json?.articles) ? json.articles : [];
  return arr.slice(0, perSourceCap).map(normalizeGdeltArticle);
}

export const DEFAULT_HOURS = 12;
export const PER_SOURCE_CAP = 10;
export const TOTAL_CAP = 30;
export const FETCH_TIMEOUT_MS = 15000;

// The one aggregate entry point: fetches every source in parallel (each
// failure-isolated), filters to the lookback window, dedups, sorts
// newest-first, caps, and computes the aggregate escalation flag.
export async function fetchSentinelNews({
  query,
  yahooSymbol = null,
  hours = DEFAULT_HOURS,
  perSourceCap = PER_SOURCE_CAP,
  totalCap = TOTAL_CAP,
  fetcher = defaultFetcher,
  timeoutMs = FETCH_TIMEOUT_MS,
  now = Date.now(),
  log = (m) => process.stderr.write(`[sentinel-news] ${m}\n`),
  gdeltThrottle = null,
  newsApiAi = null, // resolveNewsApiAiConfig() verdict; null => free stack only (today's behavior)
} = {}) {
  if (!query) throw new Error('fetchSentinelNews requires a query');
  const opts = { fetcher, timeoutMs, perSourceCap, hours };
  const results = await Promise.all([
    fetchSourceSafe('google-news', () => fetchGoogleNews(query, opts), log),
    fetchSourceSafe('gdelt', () => fetchGdelt(query, { ...opts, gdeltThrottle }), log),
    fetchSourceSafe('al-jazeera', () => fetchAlJazeera(opts), log),
    fetchSourceSafe('oilprice', () => fetchOilPrice(opts), log),
    yahooSymbol ? fetchSourceSafe('yahoo', () => fetchYahoo(yahooSymbol, opts), log) : Promise.resolve([]),
  ]);
  const providersAttempted = ['google-news', 'gdelt', 'al-jazeera', 'oilprice', ...(yahooSymbol ? ['yahoo'] : [])];

  // NewsAPI.ai (issue #104): failure-isolated like every other source. Fetched
  // via the on-demand getArticles path; a failure yields [] + a log line and
  // the free stack carries the tick. shadow mode records but never merges.
  // The outcome (ok/status) is captured — not swallowed — so the persistence
  // layer (scripts/news.mjs) can drive the request budget + circuit breaker.
  let newsApiItems = [];
  let shadowItems = [];
  let newsApiOutcome = null;
  if (newsApiAi?.enabled) {
    if (newsApiAi.warn) log(newsApiAi.warn);
    providersAttempted.unshift('newsapi-ai');
    // Validate the query -> keywords locally FIRST. A parse/keyword-limit failure
    // is NOT chargeable (no network, no token) — log a sanitized warning, fall
    // back to the free stack, and report requestMade:false so the persistence
    // layer never charges the budget or trips the circuit for a bad query.
    let keywords = null;
    try {
      keywords = parseSentinelQueryToKeywords(query);
    } catch (err) {
      newsApiOutcome = { ok: false, requestMade: false, status: null, items: [], error: err?.message || String(err) };
      log(`newsapi-ai query unsupported, using free stack: ${newsApiOutcome.error}`);
    }
    if (keywords) {
      try {
        const r = await fetchNewsApiAiArticles({ query, hours, maxItems: perSourceCap, apiKey: newsApiAi.apiKey, fetcher, timeoutMs, now });
        newsApiOutcome = { ok: true, requestMade: true, status: 200, items: r.items };
      } catch (err) {
        // A network attempt WAS made (chargeable): requestMade stays true.
        newsApiOutcome = { ok: false, requestMade: true, status: err?.status ?? null, error: err?.message || String(err) };
        log(`newsapi-ai failed: ${newsApiOutcome.error}`);
      }
    }
    const fetched = newsApiOutcome.items || [];
    if (newsApiAi.shadow) shadowItems = fetched; else newsApiItems = fetched;
  } else if (newsApiAi?.warn) {
    log(newsApiAi.warn);
  }

  const cutoffMs = now - hours * 3600000;
  const inWin = (it) => !it.timeIso || Date.parse(it.timeIso) >= cutoffMs;
  const naiInWindow = newsApiItems.filter(inWin);
  const freeInWindow = results.flat().filter(inWin);
  // Union both stacks (#115 revisited): paid MIGHT be faster, but we want
  // COMPLETE results — so merge NewsAPI.ai + free rather than suppressing free
  // when paid returns. NewsAPI.ai items go FIRST, so on a canonical (url/fuzzy-
  // title) collision the richer NewsAPI.ai item wins the dedup below.
  const merged = [...naiInWindow, ...freeInWindow];
  // Retained for diagnostics: paid provider had in-window results AND is not in
  // shadow mode (shadow can return in-window items yet stays false by design).
  const naiAuthoritative = newsApiAi?.enabled === true && newsApiAi.shadow !== true && naiInWindow.length > 0;
  const deduped = dedupeItems(merged).sort((a, b) => (Date.parse(b.timeIso) || 0) - (Date.parse(a.timeIso) || 0));
  const items = deduped.slice(0, totalCap);
  const out = {
    items,
    escalation: items.some((it) => it.escalation),
    asOf: new Date(now).toISOString(),
  };
  // Diagnostics attach ONLY when the provider actually ran (enabled). Without a
  // key — or in primary-mode-without-a-key (disabled + warn) — the output shape
  // stays byte-for-byte the free stack, per the #104 acceptance criteria.
  if (newsApiAi?.enabled) {
    out.newsApiAi = {
      mode: newsApiAi.mode,
      requestMade: newsApiOutcome?.requestMade === true,
      ok: newsApiOutcome ? newsApiOutcome.ok : null,
      status: newsApiOutcome ? newsApiOutcome.status : null,
      shadow: newsApiAi.shadow === true,
      itemsReturned: newsApiAi.shadow ? shadowItems.length : newsApiItems.length,
      // true => paid returned in-window items and is not in shadow mode (now merged WITH free, not instead of it).
      authoritative: naiAuthoritative,
    };
    out.providersAttempted = providersAttempted;
    // Pre-dedup, in-window, provider-tagged items for provenance recording:
    // every provider's sighting is kept (dedup would drop the free-source twin).
    out.observed = [...(newsApiAi.shadow ? shadowItems : newsApiItems), ...results.flat()]
      .filter((it) => !it.timeIso || Date.parse(it.timeIso) >= cutoffMs);
    if (newsApiAi.shadow) out.shadowItems = shadowItems;
  }
  return out;
}

// --- CLI ---------------------------------------------------------------
const USAGE = `sentinel_news (market-sentinel) — fetch breaking geopolitical/macro news from free, query-driven sources.

Options:
  --instrument <sym>    candle symbol (e.g. WTICO/USD); resolves query + Yahoo symbol from config/instruments.yaml
  --query <text>        explicit search query (overrides --instrument's config lookup)
  --yahoo-symbol <sym>  explicit Yahoo Finance symbol (e.g. CL=F), used only alongside --query
  --hours <n>           lookback window in hours (default: ${DEFAULT_HOURS})
  --max-items <n>       total cap across all sources after dedup (default: ${TOTAL_CAP})
  --json                emit JSON instead of text
  -h, --help            show this help (no network)
`;

// Flags that never take a value. Checked BEFORE the value-consuming path
// below so their position in argv can never cause the next token to be
// mis-swallowed as a bogus value (e.g. `--json --instrument WTICO/USD` must
// parse identically to `--instrument WTICO/USD --json`).
const BOOLEAN_FLAGS = new Set(['json', 'help', 'h']);

export function parseArgs(argv) {
  const out = { instrument: null, query: null, yahooSymbol: null, hours: DEFAULT_HOURS, maxItems: TOTAL_CAP, json: false };
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      if (key === 'json') out.json = true;
      continue;
    }
    const next = argv[i + 1];
    const hasValue = next !== undefined && !next.startsWith('--');
    const val = hasValue ? next : null;
    if (hasValue) i++;

    if (key === 'instrument' && val) out.instrument = val;
    else if (key === 'query' && val) out.query = val;
    else if (key === 'yahoo-symbol' && val) out.yahooSymbol = val;
    else if (key === 'hours' && val) out.hours = Number(val);
    else if (key === 'max-items' && val) out.maxItems = Number(val);
    else unknown.push(`--${key}`);
  }
  if (unknown.length) throw new Error(`unknown flag(s): ${unknown.join(', ')} (run --help)`);
  if (!Number.isFinite(out.hours) || out.hours <= 0) out.hours = DEFAULT_HOURS;
  if (!Number.isFinite(out.maxItems) || out.maxItems <= 0) out.maxItems = TOTAL_CAP;
  return out;
}

// Resolves {query, yahooSymbol} from either an explicit --query, or
// config/instruments.yaml via --instrument — never guesses a query for an
// instrument that has no committed sentinel entry.
export function resolveQuery(args) {
  if (args.query) return { query: args.query, yahooSymbol: args.yahooSymbol || null, instrument: args.instrument || null };
  if (args.instrument) {
    const cfg = sentinelConfigForInstrument(args.instrument);
    if (!cfg) throw new Error(`no sentinel query configured for instrument ${args.instrument} (config/instruments.yaml)`);
    return { query: cfg.query, yahooSymbol: cfg.yahooSymbol, instrument: args.instrument };
  }
  throw new Error('one of --instrument or --query is required');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const args = parseArgs(argv);
  const { query, yahooSymbol, instrument } = resolveQuery(args);
  // ponytail: hermetic escape hatch for the offline --json shape smoke check
  // (scripts/smoke-skills.mjs) — never set by real usage, no live sources hit.
  const newsApiAi = resolveNewsApiAiConfig(process.env, { instrument });
  const result = process.env.SENTINEL_NEWS_OFFLINE === '1'
    ? { items: [], escalation: false, asOf: new Date().toISOString() }
    : await fetchSentinelNews({ query, yahooSymbol, hours: args.hours, totalCap: args.maxItems, newsApiAi });

  if (args.json) {
    const meta = { instrument, query, yahooSymbol, hours: args.hours };
    // Always surface the RESOLVED provider config (from process.env) so callers
    // can confirm the key/mode reached the CLI — e.g. the server injects it from
    // settings.json into the spawn env (issue #114); observable even offline.
    meta.newsApiAiMode = newsApiAi.mode;
    meta.newsApiAiEnabled = newsApiAi.enabled;
    if (result.newsApiAi) { meta.primaryProvider = result.newsApiAi.requestMade ? 'newsapi-ai' : null; meta.newsApiAi = result.newsApiAi; meta.providersAttempted = result.providersAttempted; }
    process.stdout.write(JSON.stringify({ ...result, meta }, null, 2));
    return;
  }

  const lines = [`## market-sentinel — last ${args.hours}h${instrument ? ` (${instrument})` : ''}`];
  if (result.escalation) lines.push('\n> ⚠ escalation signal present');
  for (const it of result.items) {
    lines.push(`- [${it.source}] ${it.title}${it.url ? ` (${it.url})` : ''}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    process.stderr.write(`sentinel_news error: ${e.message}\n`);
    process.exitCode = 1;
  });
}
