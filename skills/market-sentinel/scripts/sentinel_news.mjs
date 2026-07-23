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

function normTitle(t) {
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

  const cutoffMs = now - hours * 3600000;
  const inWindow = results.flat().filter((it) => !it.timeIso || Date.parse(it.timeIso) >= cutoffMs);
  const deduped = dedupeItems(inWindow).sort((a, b) => (Date.parse(b.timeIso) || 0) - (Date.parse(a.timeIso) || 0));
  const items = deduped.slice(0, totalCap);
  return {
    items,
    escalation: items.some((it) => it.escalation),
    asOf: new Date(now).toISOString(),
  };
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
  const result = process.env.SENTINEL_NEWS_OFFLINE === '1'
    ? { items: [], escalation: false, asOf: new Date().toISOString() }
    : await fetchSentinelNews({ query, yahooSymbol, hours: args.hours, totalCap: args.maxItems });

  if (args.json) {
    process.stdout.write(JSON.stringify({ ...result, meta: { instrument, query, yahooSymbol, hours: args.hours } }, null, 2));
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
