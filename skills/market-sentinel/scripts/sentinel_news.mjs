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

// --- GNews provider --------------------------------------------------------
// A second, opt-in commercial provider layered onto the free stack + NewsAPI.ai
// (default off — it costs money/quota). Same normalized item shape, same
// failure-isolation contract as NewsAPI.ai. Endpoint: the `search` endpoint,
// query-filtered, sorted newest-first, lookback enforced locally.
export const GNEWS_SEARCH_URL = 'https://gnews.io/api/v4/search';
export const GNEWS_MAX_QUERY_LEN = 200; // GNews's documented query cap
// The free tier's fixed publication delay, measured from a live response (every
// article in test/fixtures/gnews_search_oil.json is exactly 12h old). Paid tiers
// are real-time; widening the window by this costs a few older items there and is
// what makes the free tier usable for measurement at all.
export const GNEWS_PUBLICATION_DELAY_HOURS = 12;
// A lifetime cap, not a per-day one (requests_used is never reset), chosen as a
// month of the free key's 100/day so an unattended shadow run cannot quietly
// spend forever. Operators set their own via GNEWS_REQUEST_BUDGET.
const DEFAULT_GNEWS_BUDGET = 2500;

// GNews takes a boolean query nearly verbatim (AND/OR/NOT, parens, quoted
// phrases) — no keyword-array translation needed like NewsAPI.ai. The one gap:
// an unquoted multi-word term (`natural gas`) is read as an implicit AND of two
// words, so every such term must be quoted. Parens and already-quoted phrases
// pass through unchanged. Throws (non-chargeable — no network attempt yet) if the
// result exceeds the 200-char cap; the longest query committed today builds to 109
// chars, so this is a guard against a future addition, not a live path.
//
// Splits on an UPPERCASE ` OR ` only. Every committed sentinel query writes its
// operators in caps and its terms in prose, and matching case-insensitively broke
// exactly that: the lowercase `and` inside `supply and demand` was read as an
// operator and the term shipped unquoted, for GNews to treat as an implicit AND.
// Lowercase `or` inside a term (`this or that`) would fail the same way, so the
// `i` flag is gone too — a lowercase operator word is treated as part of the term,
// which is the right default because it is genuinely ambiguous prose.
//
// AND/NOT are rejected outright rather than quoted into one literal phrase. Note
// the deliberate asymmetry with the line above: `(oil or crude)` becomes the
// phrase search `"oil or crude"` — quietly, and it costs a request — while
// `(oil AND OPEC)` throws for free. Uppercase operators are unambiguous authoring
// intent, so mis-serving them should be loud; lowercase ones are just words. The
// authoring-time guard is the test that runs every committed sentinel query
// through this function, so an AND/NOT query cannot reach production unnoticed.
export function buildGnewsQuery(sentinelQuery) {
  const raw = String(sentinelQuery || '').trim();
  if (!raw) throw new Error('empty sentinel query');
  if (/\b(AND|NOT)\b/.test(raw)) {
    throw new Error('gnews query builder supports OR lists only; rewrite the AND/NOT query as quoted phrases');
  }
  const parts = raw.split(/(\(|\)|\bOR\b)/g);
  const rebuilt = parts.map((part) => {
    if (/^(\(|\)|OR)$/.test(part)) return part;
    const t = part.trim();
    if (!t) return '';
    if (/^".*"$/.test(t)) return t; // already quoted, leave as-is
    return /\s/.test(t) ? `"${t}"` : t;
  }).filter((p) => p !== '');
  const query = rebuilt.join(' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s+/g, ' ').trim();
  if (query.length > GNEWS_MAX_QUERY_LEN) {
    throw new Error(`gnews query is ${query.length} chars, exceeds the ${GNEWS_MAX_QUERY_LEN}-char cap`);
  }
  return query;
}

// Normalize a GNews article (search.articles[]) into the common item shape.
// description is preferred over content: on the free tier content truncates
// to ~266 chars mid-sentence, while description is a complete sentence on both
// tiers. GNews has no event clustering/sentiment/concepts, so those stay null
// — nothing in this repo reads them for gnews besides the benchmark's
// uniqueEvents metric, which already degrades gracefully for a null event_uri.
export function normalizeGnewsArticle(article) {
  const title = article?.title || '';
  const summary = article?.description || article?.content || null;
  return {
    provider: 'gnews',
    providerItemId: article?.id || null,
    source: article?.source?.name || 'unknown',
    sourceUri: article?.source?.url || null,
    title,
    timeIso: parseFeedDate(article?.publishedAt),
    summary,
    url: article?.url || null,
    eventUri: null,
    sentiment: null,
    concepts: null,
    isDuplicate: false, // flipped true for a later sighting by markGnewsDuplicates
    tone: null,
    themes: null,
    escalation: computeEscalation({ title, summary }),
  };
}

// GNews's word-overlap threshold for "same story, different outlet" within one
// response: GNews has no event clustering, and real same-story headlines from
// different outlets vary in wording (e.g. "BP puts UK North Sea oil and gas
// assets up for sale as CEO pushes overhaul" vs "BP puts North Sea business up
// for sale") — an exact-title match (dedupeItems' fallback) would miss them.
// Overlap coefficient (shared words / smaller title's word count) is robust to
// one headline being a longer/shorter rewrite of the other.
//
// ponytail: known ceiling — word overlap cannot see the words that carry the
// meaning, so an opposite-direction pair on the same subject scores as one story
// ("OPEC agrees to raise output" vs "...to cut output" = 0.80, "Iran seizes
// tanker in Strait of Hormuz" vs "Iran releases tanker..." = 0.86). That is why this
// mark is provenance only and never gates the prompt-facing union (see
// fetchSentinelNews). Upgrade path if it should ever gate anything: cluster on
// the provider's own event id (GNews has none today) or require the
// distinguishing tokens to agree, not just the shared ones.
export const GNEWS_DUPLICATE_OVERLAP_THRESHOLD = 0.7;

function titleWordOverlap(a, b) {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
}

// Marks (does not drop — provenance keeps every sighting) items whose
// normalized title overlaps an EARLIER item (array order, i.e. GNews's own
// newest-first order) above the threshold. Mutates items in place.
export function markGnewsDuplicates(items) {
  const seen = [];
  for (const it of items) {
    const words = new Set(normTitle(it.title).split(/\s+/).filter(Boolean));
    const isDup = words.size > 0 && seen.some((s) => titleWordOverlap(words, s) >= GNEWS_DUPLICATE_OVERLAP_THRESHOLD);
    if (isDup) it.isDuplicate = true;
    else seen.push(words);
  }
  return items;
}

// The provider adapter: GET search, with the requested lookback enforced
// locally. Security: GNews takes the key as a QUERY PARAMETER (unlike NewsAPI.ai's
// body), so the built URL must never be logged, and any thrown error must have
// the key redacted before it can reach a log line or diagnostic.
export async function fetchGnewsArticles({
  query, hours = DEFAULT_HOURS, maxItems = PER_SOURCE_CAP,
  apiKey, fetcher = defaultFetcher, timeoutMs = FETCH_TIMEOUT_MS, now = Date.now(),
} = {}) {
  if (!apiKey) throw new Error('fetchGnewsArticles requires an apiKey');
  const q = buildGnewsQuery(query); // throws on the char cap — non-chargeable, no network yet
  // The free tier publishes on a 12-hour delay, and the callers' default lookback
  // is also 12 hours — so an unwidened window would filter out nearly everything
  // this provider can return, making it look empty rather than delayed. Widening
  // by the delay keeps the shadow comparison able to see anything at all; on a
  // paid key nothing is delayed, so the extra span costs only a few older items.
  const fromIso = new Date(now - (hours + GNEWS_PUBLICATION_DELAY_HOURS) * 3600000).toISOString();
  const params = new URLSearchParams({
    q, lang: 'en', sortby: 'publishedAt', max: String(Math.min(maxItems, 100)), from: fromIso, apikey: apiKey,
  });
  const url = `${GNEWS_SEARCH_URL}?${params.toString()}`;
  let json;
  try {
    const res = await fetcher(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    json = JSON.parse(await res.text());
  } catch (err) {
    // Redact the key out of ANY thrown message (HTTP status errors never carry
    // it, but a network-layer error from the fetcher itself might echo the url).
    // Both forms: the key rides in the query string, so URLSearchParams has
    // percent-encoded it there. Redacting only the raw string works by accident
    // for an alphanumeric key and silently fails the day one contains `+`, `/`
    // or `=` — the redaction must not depend on the key's character set.
    const raw = err && err.message ? err.message : String(err);
    const msg = raw.split(apiKey).join('[redacted]').split(encodeURIComponent(apiKey)).join('[redacted]');
    const sanitized = new Error(msg);
    if (err?.status) sanitized.status = err.status;
    throw sanitized;
  }
  const arr = Array.isArray(json?.articles) ? json.articles : [];
  const cutoffMs = now - (hours + GNEWS_PUBLICATION_DELAY_HOURS) * 3600000;
  const items = arr.map(normalizeGnewsArticle)
    .filter((it) => !it.timeIso || Date.parse(it.timeIso) >= cutoffMs); // locally enforce --hours
  markGnewsDuplicates(items);
  return { items, endpoint: 'search' };
}

// The settings-first GNEWS_* resolver lives in a tiny standalone lib so
// consumers (signal-server) don't take a hard startup dependency on this skill
// module (same #114 boundary as NewsAPI.ai); re-exported here for existing importers.
export { GNEWS_SETTING_KEYS, resolveGnewsSource, GNEWS_MODES } from '../../../scripts/lib/gnews-source.mjs';
import { GNEWS_MODES } from '../../../scripts/lib/gnews-source.mjs';

// Resolve GNews config from env into a single enabled/shadow verdict. Default
// mode 'off'. Deliberately fails CLOSED on an unknown mode string (unlike
// resolveNewsApiAiConfig's fallback to 'auto'): GNews is opt-in and spends
// quota/money, so an unrecognized mode must never silently start spending —
// NewsAPI.ai's fallback predates this provider and carries an accepted risk
// this one should not inherit.
export function resolveGnewsConfig(env = process.env, { instrument = null } = {}) {
  const apiKey = env.GNEWS_KEY || null;
  let mode = String(env.GNEWS_MODE || 'off').toLowerCase();
  if (!GNEWS_MODES.includes(mode)) mode = 'off';
  const parsedBudget = Number.parseInt(env.GNEWS_REQUEST_BUDGET, 10);
  const requestBudget = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : DEFAULT_GNEWS_BUDGET;
  const allow = String(env.GNEWS_INSTRUMENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const instrumentAllowed = !allow.length || !instrument || allow.includes(instrument);
  const enabled = mode !== 'off' && !!apiKey && instrumentAllowed;
  // Background polling is its own opt-in, off by default — the same shape the
  // paid provider settled on, and here the arithmetic forces it: GNews meters
  // per DAY (100/day on the free key), while the background refresh visits every
  // instrument that carries a sentinel query every 8 minutes. That is 4 of the 7
  // watched instruments today, ~720 requests/day, so riding it would spend a free
  // day's quota before breakfast and then wall for the rest of it. Off, the
  // provider spends only at decision points — the same moments the paid provider
  // spends, which is what makes the two comparable in the provider report.
  const background = ['1', 'true', 'yes', 'on'].includes(String(env.GNEWS_BACKGROUND || '').toLowerCase());
  return { apiKey, mode, enabled, shadow: enabled && mode === 'shadow', requestBudget, allow, instrumentAllowed, background };
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
  gnews = null, // resolveGnewsConfig() verdict; null => no gnews, i.e. unchanged behavior
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

  // GNews mirrors the NewsAPI.ai isolation pattern above — a
  // local query-cap failure is non-chargeable, a network failure is
  // chargeable but never breaks the free stack, NewsAPI.ai, or each other.
  // shadow mode records but never merges; auto merges into the same union.
  let gnewsItems = [];
  let gnewsShadowItems = [];
  let gnewsOutcome = null;
  if (gnews?.enabled) {
    providersAttempted.push('gnews');
    let gnewsQuery = null;
    try {
      gnewsQuery = buildGnewsQuery(query);
    } catch (err) {
      gnewsOutcome = { ok: false, requestMade: false, status: null, items: [], error: err?.message || String(err) };
      log(`gnews query unsupported, using free stack: ${gnewsOutcome.error}`);
    }
    if (gnewsQuery) {
      try {
        const r = await fetchGnewsArticles({ query, hours, maxItems: perSourceCap, apiKey: gnews.apiKey, fetcher, timeoutMs, now });
        gnewsOutcome = { ok: true, requestMade: true, status: 200, items: r.items };
      } catch (err) {
        // A network attempt WAS made (chargeable): requestMade stays true.
        gnewsOutcome = { ok: false, requestMade: true, status: err?.status ?? null, error: err?.message || String(err) };
        log(`gnews failed: ${gnewsOutcome.error}`);
      }
    }
    const fetched = gnewsOutcome.items || [];
    if (gnews.shadow) gnewsShadowItems = fetched; else gnewsItems = fetched;
  }

  const cutoffMs = now - hours * 3600000;
  const inWin = (it) => !it.timeIso || Date.parse(it.timeIso) >= cutoffMs;
  const naiInWindow = newsApiItems.filter(inWin);
  // gnews's intra-response duplicate marks are PROVENANCE ONLY and deliberately
  // do not gate this union. The mark comes from a word-overlap heuristic, and
  // overlap on a short headline is blind to the words that carry the meaning:
  // "OPEC agrees to raise output" vs "OPEC agrees to cut output" scores as one
  // story, as do "Iran seizes tanker in Strait of Hormuz" vs "Iran releases
  // tanker...". Dropping the second of such a pair would hide the contradicting
  // — often the newer and more tradeable — event from the model, so every
  // in-window item goes into the union and the shared dedupeItems below (exact
  // url, else publisher-stripped exact title) decides what collapses, on the
  // same conservative rule every other source gets.
  // gnews gets the delay-widened window (see GNEWS_PUBLICATION_DELAY_HOURS): the
  // free tier's newest article is already 12h old, so the shared cutoff would
  // discard exactly what was just fetched.
  const gnewsCutoffMs = now - (hours + GNEWS_PUBLICATION_DELAY_HOURS) * 3600000;
  const gnewsInWindow = gnewsItems.filter((it) => !it.timeIso || Date.parse(it.timeIso) >= gnewsCutoffMs);
  const freeInWindow = results.flat().filter(inWin);
  // Union every stack (#115 revisited): paid MIGHT be faster, but we want
  // COMPLETE results — so merge rather than suppressing free when paid
  // returns. Paid items go FIRST, so on a canonical (url/fuzzy-title)
  // collision the richer paid item wins the dedup below.
  const merged = [...naiInWindow, ...gnewsInWindow, ...freeInWindow];
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
  // key the output shape stays byte-for-byte the free stack, per each
  // provider's own acceptance criteria (#104), and the same holds for GNews.
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
  }
  if (gnews?.enabled) {
    out.gnews = {
      mode: gnews.mode,
      requestMade: gnewsOutcome?.requestMade === true,
      ok: gnewsOutcome ? gnewsOutcome.ok : null,
      status: gnewsOutcome ? gnewsOutcome.status : null,
      shadow: gnews.shadow === true,
      itemsReturned: gnews.shadow ? gnewsShadowItems.length : gnewsItems.length,
    };
  }
  if (newsApiAi?.enabled || gnews?.enabled) {
    out.providersAttempted = providersAttempted;
    // Pre-dedup, in-window, provider-tagged items for provenance recording:
    // every provider's sighting is kept (dedup would drop the free-source twin,
    // and gnews's OWN intra-response duplicates are kept here too — marked,
    // not dropped, so the trial benchmark can see them).
    // Each provider's sightings are filtered by ITS OWN window: gnews gets the
    // delay-widened one, or shadow mode would log ~1 of every 10 articles it just
    // paid for and the comparison this provider exists to enable would read empty.
    const inGnewsWin = (it) => !it.timeIso || Date.parse(it.timeIso) >= gnewsCutoffMs;
    out.observed = [
      ...(newsApiAi?.shadow ? shadowItems : newsApiItems).filter(inWin),
      ...(gnews?.shadow ? gnewsShadowItems : gnewsItems).filter(inGnewsWin),
      ...results.flat().filter(inWin),
    ];
    if (newsApiAi?.shadow) out.shadowItems = shadowItems;
    if (gnews?.shadow) out.gnewsShadowItems = gnewsShadowItems;
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
  const gnews = resolveGnewsConfig(process.env, { instrument });
  const result = process.env.SENTINEL_NEWS_OFFLINE === '1'
    ? { items: [], escalation: false, asOf: new Date().toISOString() }
    : await fetchSentinelNews({ query, yahooSymbol, hours: args.hours, totalCap: args.maxItems, newsApiAi, gnews });

  if (args.json) {
    const meta = { instrument, query, yahooSymbol, hours: args.hours };
    // Always surface the RESOLVED provider config (from process.env) so callers
    // can confirm the key/mode reached the CLI — e.g. the server injects it from
    // settings.json into the spawn env (issue #114); observable even offline.
    meta.newsApiAiMode = newsApiAi.mode;
    meta.newsApiAiEnabled = newsApiAi.enabled;
    meta.gnewsMode = gnews.mode;
    meta.gnewsEnabled = gnews.enabled;
    if (result.newsApiAi) { meta.primaryProvider = result.newsApiAi.requestMade ? 'newsapi-ai' : null; meta.newsApiAi = result.newsApiAi; }
    if (result.gnews) meta.gnews = result.gnews;
    if (result.providersAttempted) meta.providersAttempted = result.providersAttempted;
    // Shadow items and the raw provenance list exist for the persistence layer,
    // NOT for a reader. This payload is returned verbatim by the sentinel_news
    // chat tool, so leaving them in would put a shadow provider's articles in
    // front of a model — the one thing shadow mode promises not to do. Counts stay
    // in `meta` (via result.gnews/newsApiAi) so the mode is still observable.
    const { shadowItems, gnewsShadowItems, observed, ...emitted } = result;
    process.stdout.write(JSON.stringify({ ...emitted, meta }, null, 2));
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
