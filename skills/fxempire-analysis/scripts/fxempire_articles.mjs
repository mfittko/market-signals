#!/usr/bin/env node
/**
 * FXEmpire articles-only fetcher.
 *
 * Responsibility:
 * - Retrieve news/forecast article metadata and text snippets.
 */

import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_TZ = 'Europe/Berlin';

function parseArgs(argv) {
  const out = {
    locale: 'en',
    tz: DEFAULT_TZ,
    hours: null,
    commodities: [
      'brent-crude-oil',
      'wti-crude-oil',
      'natural-gas',
      'gold',
      'silver',
      'platinum',
      'spx',
      'tech100-usd',
      'us30-usd',
      'eur-usd',
      'usd-jpy',
      'bitcoin',
      'ethereum',
      'solana',
    ],
    maxItems: 6,
    pageSize: 50,
    maxPages: 10,
    json: false,
    fullText: false,
    maxTextChars: 12000,
    tags: {
      'brent-crude-oil': 'co-brent-crude-oil',
      'wti-crude-oil': 'co-wti-crude-oil',
      'natural-gas': 'co-natural-gas',
      gold: 'co-gold',
      silver: 'co-silver',
      platinum: 'co-platinum',
      spx: 'i-spx',
      'tech100-usd': 'i-tech100-usd',
      'us30-usd': 'i-us30-usd',
      'eur-usd': 'c-eur-usd',
      'usd-jpy': 'c-usd-jpy',
      bitcoin: 'cc-bitcoin',
      ethereum: 'cc-ethereum',
      solana: 'cc-solana',
    },
  };
  const unknown = [];

  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    const hasValue = next && !next.startsWith('--');
    const val = hasValue ? next : null;
    if (hasValue) i++;

    if (key === 'help' || key === 'h') continue;
    else if (key === 'locale' && val) out.locale = val;
    else if (key === 'tz' && val) out.tz = val;
    else if (key === 'hours' && val) out.hours = Number(val);
    else if (key === 'commodities' && val)
      out.commodities = val.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'max-items' && val) out.maxItems = Number(val);
    else if (key === 'page-size' && val) out.pageSize = Number(val);
    else if (key === 'max-pages' && val) out.maxPages = Number(val);
    else if (key === 'json') out.json = true;
    else if (key === 'full-text') out.fullText = true;
    else if (key === 'max-text-chars' && val) out.maxTextChars = Number(val);
    else if (key === 'tags' && val) {
      for (const pair of val.split(',')) {
        const [slug, tag] = pair.split('=');
        if (slug && tag) out.tags[slug.trim()] = tag.trim();
      }
    }
    else unknown.push(`--${key}`);
  }

  if (unknown.length) throw new Error(`unknown flag(s): ${unknown.join(', ')} (run --help)`);
  if (!out.hours || !Number.isFinite(out.hours) || out.hours <= 0) out.hours = null;
  if (!Number.isFinite(out.maxItems) || out.maxItems <= 0) out.maxItems = 6;
  if (!Number.isFinite(out.pageSize) || out.pageSize <= 0) out.pageSize = 50;
  if (!Number.isFinite(out.maxPages) || out.maxPages <= 0) out.maxPages = 10;
  if (!Number.isFinite(out.maxTextChars) || out.maxTextChars <= 0) out.maxTextChars = 12000;

  return out;
}

function weekdayInTz(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone });
  return fmt.format(date);
}

function windowHoursFor(date, timeZone) {
  const w = weekdayInTz(date, timeZone);
  if (w === 'Sun') return 72;
  if (w === 'Sat') return 48;
  return 24;
}

async function fetchText(url, { timeoutMs = 20000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (market-signals; fxempire-articles)',
        accept: '*/*',
      },
      redirect: 'follow',
      signal: ac.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, url: res.url };
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, opts) {
  const r = await fetchText(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  try {
    return JSON.parse(r.text);
  } catch (e) {
    throw new Error(`JSON parse failed for ${url}: ${e.message}`);
  }
}

function decodeHtmlEntities(text) {
  const named = {
    nbsp: ' ',
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    ndash: '–',
    mdash: '—',
    hellip: '…',
  };

  return String(text || '')
    .replace(/&([a-zA-Z]+);/g, (match, name) => named[name] ?? match)
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      if (!Number.isFinite(code)) return _;
      return String.fromCodePoint(code);
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      if (!Number.isFinite(code)) return _;
      return String.fromCodePoint(code);
    });
}

function normalizeExtractedText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/(?<!\b[A-Z])([.!?;:])([A-Z])/g, '$1 $2')
    .replace(/([\)\]])([A-Z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripHtml(html) {
  const withBlockBoundaries = String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|aside|header|footer|h[1-6]|li|ul|ol|blockquote|pre|table|tr|td)\s*>/gi, '\n')
    .replace(/<(p|div|section|article|aside|header|footer|h[1-6]|li|ul|ol|blockquote|pre|table|tr|td)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const decoded = decodeHtmlEntities(withBlockBoundaries);
  return normalizeExtractedText(decoded);
}

function trimBoilerplate(text) {
  const cutAt = [
    'Important Disclaimers',
    'Risk Disclaimers',
    'FXEmpire is owned and operated',
    'Scan QR code to install app',
  ];
  let t = text;
  for (const marker of cutAt) {
    const idx = t.indexOf(marker);
    if (idx !== -1 && idx > 200) t = t.slice(0, idx).trim();
  }
  return t;
}

function deepFindFirstStringByKey(value, keyName) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindFirstStringByKey(item, keyName);
      if (found) return found;
    }
    return null;
  }

  if (typeof value[keyName] === 'string' && value[keyName].trim()) {
    return value[keyName].trim();
  }

  for (const child of Object.values(value)) {
    const found = deepFindFirstStringByKey(child, keyName);
    if (found) return found;
  }
  return null;
}

function extractStructuredArticleBody(html) {
  const scripts = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const script of scripts) {
    const content = script
      .replace(/^<script[^>]*>/i, '')
      .replace(/<\/script>$/i, '')
      .trim();
    if (!content) continue;
    try {
      const parsed = JSON.parse(content);
      const body = deepFindFirstStringByKey(parsed, 'articleBody');
      if (body && body.length > 200) return body;
    } catch {
      // ignore malformed JSON-LD block
    }
  }

  const nextDataMatch = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch && nextDataMatch[1]) {
    try {
      const parsed = JSON.parse(nextDataMatch[1]);
      const body = deepFindFirstStringByKey(parsed, 'articleBody');
      if (body && body.length > 200) return body;
    } catch {
      // ignore malformed app state
    }
  }

  return null;
}

async function fetchArticleSnippet(fullUrl) {
  const r = await fetchText(fullUrl, { timeoutMs: 25000 });
  if (!r.ok) return null;
  const structured = extractStructuredArticleBody(r.text);
  const raw = structured ? stripHtml(structured) : stripHtml(r.text);
  const cleaned = trimBoilerplate(raw);
  if (/Markets Crypto Forecasts News Education Forex Brokers/i.test(cleaned)) return null;
  if ((cleaned.match(/https?:\/\//g) || []).length > 5) return null;
  if (cleaned.length < 240) return null;
  return cleaned.slice(0, 900);
}

async function fetchArticleText(fullUrl, maxChars) {
  const r = await fetchText(fullUrl, { timeoutMs: 25000 });
  if (!r.ok) return null;
  const structured = extractStructuredArticleBody(r.text);
  const raw = structured ? stripHtml(structured) : stripHtml(r.text);
  const cleaned = trimBoilerplate(raw);
  if (/Markets Crypto Forecasts News Education Forex Brokers/i.test(cleaned)) return null;
  if ((cleaned.match(/https?:\/\//g) || []).length > 8) return null;
  if (cleaned.length < 300) return null;
  return cleaned.slice(0, maxChars);
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function mdEscape(s) {
  return String(s).replace(/\|/g, '\\|');
}

function markdownLinkText(s) {
  return String(s)
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function markdownLinkUrl(url) {
  return encodeURI(String(url || ''))
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function resolveArticleUrl(article) {
  const articleUrl = String(article?.articleUrl || '').trim();
  if (articleUrl) {
    if (/^https?:\/\//i.test(articleUrl)) return articleUrl;
    return `https://www.fxempire.com${articleUrl}`;
  }

  const fullUrl = String(article?.fullUrl || '').trim();
  if (fullUrl) return fullUrl;

  const slug = String(article?.slug || '').trim();
  const id = article?.id;
  const type = article?.type === 'news' ? 'news' : article?.type === 'forecasts' ? 'forecasts' : null;
  if (slug && id && type) {
    return `https://www.fxempire.com/${type}/article/${slug}-${id}`;
  }
  return null;
}

function formatArticleMarkdownLink(article) {
  const title = markdownLinkText(article?.title || 'Untitled');
  const url = resolveArticleUrl(article);
  if (!url) return { label: mdEscape(title), hasLink: false };
  return { label: `[${title}](${markdownLinkUrl(url)})`, hasLink: true };
}

export function normalizeArticles(hubArticles, { cutoffTs, nowTs }) {
  return hubArticles
    .map((a) => {
      const ts = articleTs(a);
      return {
        id: a.id,
        title: a.title,
        slug: a.slug,
        description: a.description || null,
        excerpt: a.excerpt || null,
        tags: a.tags || [],
        type: a._type,
        tag: a._tag,
        commodity: a._slug || null,
        timestamp: ts,
        iso: ts ? new Date(ts).toISOString() : null,
        author: a.author?.name || null,
        articleUrl: a.articleUrl || null,
        fullUrl: resolveArticleUrl(a),
      };
    })
    .filter((a) => Number.isFinite(a.timestamp) && a.timestamp >= cutoffTs && a.timestamp <= nowTs);
}

// --- SSR news-page source (issue #28) -------------------------------------
// The JSON hub API froze upstream (issue #11); the site's server-rendered
// news pages stay fresh and embed an id-keyed article map in __NEXT_DATA__.
// Pages follow /{market}/{slug}/news (probed across all four markets).

const BUILTIN_SLUG_MARKETS = {
  spx: 'indices', 'tech100-usd': 'indices', 'us30-usd': 'indices',
  'de30-eur': 'indices', 'uk100-gbp': 'indices', 'jp225-usd': 'indices',
  'eur-usd': 'currencies', 'usd-jpy': 'currencies',
  bitcoin: 'crypto', ethereum: 'crypto', solana: 'crypto',
};

let slugMarketCache = null;
export function slugMarket(slug) {
  if (slugMarketCache) return slugMarketCache.get(slug) || BUILTIN_SLUG_MARKETS[slug] || 'commodities';
  try {
    const yml = fs.readFileSync(path.join(process.cwd(), 'config', 'instruments.yaml'), 'utf8');
    let market = null;
    for (const line of yml.split('\n')) {
      const m = line.match(/^  (\w[\w-]*):/);
      if (m) { market = m[1]; continue; }
      const sm = line.match(/- slug: (\S+)/);
      if (sm && market) {
        if (!slugMarketCache) slugMarketCache = new Map();
        slugMarketCache.set(sm[1], market === 'crypto-coin' ? 'crypto' : market);
      }
    }
  } catch { /* no catalog in cwd */ }
  if (!slugMarketCache) slugMarketCache = new Map();
  return slugMarketCache.get(slug) || BUILTIN_SLUG_MARKETS[slug] || 'commodities';
}

// Tag-based relevance: SSR pages embed a site-wide article mix; an article
// belongs to a slug when one of its tags carries it (co-/c-/i-/cc- prefixes).
export function articleMatchesSlug(a, slug) {
  return (a.tags || []).some((t) => String(t).toLowerCase().includes(String(slug).toLowerCase()));
}

export function extractNextData(html) {
  const m = String(html).match(/<script[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// Walk __NEXT_DATA__ for id-keyed article objects ({title, url, date, ...}).
export function extractSsrArticles(html) {
  const data = extractNextData(html);
  if (!data) return [];
  const out = new Map();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 16) return;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && /^\d+$/.test(k)
        && typeof v.title === 'string' && typeof v.url === 'string' && (v.date || typeof v.timestamp === 'number')) {
        out.set(Number(k), {
          id: Number(k),
          title: v.title,
          date: v.date ?? null,
          timestamp: typeof v.timestamp === 'number' ? v.timestamp : parseUpstreamDate(v.date),
          articleUrl: v.url,
          tags: (Array.isArray(v.tags) ? v.tags : []).map((t) => (typeof t === 'string' ? t : t?.slug)).filter(Boolean),
        });
      } else if (v && typeof v === 'object') {
        walk(v, depth + 1);
      }
    }
  };
  walk(data, 0);
  return [...out.values()];
}

// Articles are best-effort enrichment. Classify whether the upstream feed
// yielded anything usable so the report can signal degradation instead of a
// silent 0. See issue #11 (frozen/mis-tagged upstream news hub).
// Upstream date strings are UTC but carry no timezone suffix (verified: hub
// items' epoch timestamps equal Date.parse(date + 'Z')). Parse them as UTC so
// recency filtering is machine-timezone independent.
export function parseUpstreamDate(d) {
  if (typeof d !== 'string' || !d) return NaN;
  return Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(d) ? d : `${d}Z`);
}

// Single timestamp-parse rule for upstream article objects.
export function articleTs(a) {
  return typeof a.timestamp === 'number' ? a.timestamp : parseUpstreamDate(a.date);
}

export function assessArticleFeed({ rawCount, emittedCount, newestRawTs, cutoffTs }) {
  if (emittedCount > 0) return { degraded: false, reason: null };
  if (!rawCount) {
    return { degraded: true, reason: 'FXEmpire news feed returned no items (upstream unavailable).' };
  }
  const start = new Date(cutoffTs).toISOString().slice(0, 10);
  if (!Number.isFinite(newestRawTs)) {
    return {
      degraded: true,
      reason: `FXEmpire news feed returned ${rawCount} item(s) but none carried a parseable timestamp, so recency could not be assessed. See issue #11.`,
    };
  }
  const newest = new Date(newestRawTs).toISOString().slice(0, 10);
  return {
    degraded: true,
    reason: `FXEmpire news feed returned ${rawCount} item(s) but none passed recency/relevance filtering (newest ${newest} predates window start ${start}; upstream tag filter appears ignored). See issue #11.`,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`fxempire_articles — fetch recent FXEmpire news articles for tracked instruments.

Options:
  --locale <code>          locale segment (default: en)
  --tz <zone>              timezone for the default window (default: ${DEFAULT_TZ})
  --hours <n>              lookback window in hours
  --commodities <csv>      instrument slugs to fetch
  --max-items <n>          max articles to emit (default: 6)
  --page-size <n>          API page size (default: 50)
  --max-pages <n>          max API pages (default: 10)
  --json                   emit JSON instead of text
  --full-text              fetch article full text
  --max-text-chars <n>     cap on full-text length (default: 12000)
  --tags <slug=tag,...>    override slug→tag mapping
  -h, --help               show this help (no network)
`);
    return;
  }
  const args = parseArgs(argv);
  const now = new Date();
  const hours = args.hours ?? windowHoursFor(now, args.tz);
  const cutoff = new Date(now.getTime() - hours * 3600 * 1000);
  const base = `https://www.fxempire.com/api/v1/${args.locale}`;

  async function fetchHub(type, tag) {
    let page = 1;
    const out = [];

    while (page <= args.maxPages) {
      const url =
        type === 'news'
          ? `${base}/articles/hub/news?size=${args.pageSize}&page=${page}&tag=${encodeURIComponent(tag)}`
          : `${base}/articles/hub/forecasts?size=${args.pageSize}&page=${page}&tag=${encodeURIComponent(tag)}`;

      let json;
      try {
        json = await fetchJson(url, { timeoutMs: 20000 });
      } catch {
        break;
      }

      const items =
        type === 'news'
          ? Array.isArray(json)
            ? json
            : []
          : Array.isArray(json?.articles)
            ? json.articles
            : [];

      if (!items.length) break;
      out.push(...items.map((a) => ({ ...a, _type: type, _tag: tag })));

      const ts = items
        .map((a) => articleTs(a))
        .filter((x) => Number.isFinite(x));
      if (ts.length) {
        const min = Math.min(...ts);
        if (min < cutoff.getTime()) break;
      }

      const tp = json?.paging?.totalPages;
      if (tp && page >= tp) break;
      page++;
      await delay(150);
    }

    return out;
  }

  const tagsUsed = args.commodities
    .map((slug) => ({ slug, tag: args.tags[slug] }))
    .filter((x) => x.tag);

  async function fetchSsrPage(pagePath) {
    try {
      const r = await fetchText(`https://www.fxempire.com${pagePath}`, { timeoutMs: 20000 });
      if (!r.ok) return [];
      return extractSsrArticles(r.text);
    } catch {
      return [];
    }
  }

  // SSR news pages are the live source (issue #28): one global fetch, articles
  // attributed to slugs by tag match; a per-instrument page is fetched only for
  // slugs the global mix missed; the frozen hub API is the last-resort fallback
  // so a markup change degrades instead of breaking.
  const globalSsr = await fetchSsrPage('/news');
  let hubArticles = [];
  for (const { slug, tag } of tagsUsed) {
    let batch = globalSsr.filter((a) => articleMatchesSlug(a, slug));
    if (!batch.length) {
      batch = (await fetchSsrPage(`/${slugMarket(slug)}/${slug}/news`)).filter((a) => articleMatchesSlug(a, slug));
      await delay(120);
    }
    if (batch.length) {
      batch = batch.map((a) => ({ ...a, _type: 'news', _tag: `ssr:${slug}` }));
    } else {
      const [n, f] = await Promise.all([fetchHub('news', tag), fetchHub('forecasts', tag)]);
      batch = [...n, ...f];
    }
    for (const a of batch) a._slug = slug;
    hubArticles.push(...batch);
  }

  const cutoffTs = cutoff.getTime();
  const nowTs = now.getTime();
  const norm = normalizeArticles(hubArticles, { cutoffTs, nowTs });

  const dedup = uniqBy(norm, (a) => `${a.id}:${a.type}`).sort((a, b) => b.timestamp - a.timestamp);

  const capped = [];
  const counts = new Map();
  for (const a of dedup) {
    const key = `${a.commodity}:${a.type}`;
    const c = counts.get(key) || 0;
    if (c >= args.maxItems) continue;
    counts.set(key, c + 1);
    capped.push(a);
  }

  const rawTimestamps = hubArticles
    .map((a) => articleTs(a))
    .filter((x) => Number.isFinite(x));
  const newestRawTs = rawTimestamps.length ? Math.max(...rawTimestamps) : null;
  const feed = assessArticleFeed({
    rawCount: hubArticles.length,
    emittedCount: capped.length,
    newestRawTs,
    cutoffTs,
  });

  const idsNeedingDetails = capped
    .filter((a) => !a.articleUrl || (!a.description && !a.excerpt))
    .map((a) => a.id)
    .filter(Boolean);

  async function fetchDetailsByIds(ids) {
    const url = `${base}/articles?ids=${ids.join(',')}`;
    const json = await fetchJson(url, { timeoutMs: 20000 });
    if (!Array.isArray(json)) return [];
    return json;
  }

  const detailsMap = new Map();
  const BATCH = 20;
  for (let i = 0; i < idsNeedingDetails.length; i += BATCH) {
    const batch = idsNeedingDetails.slice(i, i + BATCH);
    try {
      const rows = await fetchDetailsByIds(batch);
      for (const r of rows) detailsMap.set(r.id, r);
    } catch {
      // ignore
    }
    await delay(120);
  }

  for (const a of capped) {
    const d = detailsMap.get(a.id);
    if (!d) continue;
    if (!a.articleUrl && d.articleUrl) {
      a.articleUrl = d.articleUrl;
      a.fullUrl = resolveArticleUrl(a);
    }
    if (!a.description && d.description) a.description = d.description;
    if (!a.excerpt && d.excerpt) a.excerpt = d.excerpt;
    if (!a.author && d.author?.name) a.author = d.author.name;
  }

  for (const a of capped) {
    if (a.fullUrl) {
      if (args.fullText) {
        a.textFull = await fetchArticleText(a.fullUrl, args.maxTextChars);
        a.textSnippet = a.textFull ? a.textFull.slice(0, 900) : null;
      } else {
        a.textSnippet = await fetchArticleSnippet(a.fullUrl);
      }
      await delay(100);
    }
    if (!a.textSnippet) {
      a.textSnippet = a.description || a.excerpt || null;
    }
    if (args.fullText && !a.textFull) {
      a.textFull = a.textSnippet;
    }
  }

  const payload = {
    meta: {
      now: now.toISOString(),
      cutoff: cutoff.toISOString(),
      hours,
      tz: args.tz,
      locale: args.locale,
      commodities: args.commodities,
      degraded: feed.degraded,
      degradedReason: feed.reason,
      rawArticleCount: hubArticles.length,
      newestRawArticle: newestRawTs ? new Date(newestRawTs).toISOString() : null,
    },
    articles: capped,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(payload, null, 2));
    return;
  }

  const lines = [];
  lines.push(`## FXEmpire articles — last ${hours}h (${args.tz})`);
  if (feed.degraded) {
    lines.push('');
    lines.push(`> Articles degraded/unavailable: ${feed.reason}`);
  }
  for (const slug of args.commodities) {
    const items = capped.filter((a) => a.commodity === slug);
    if (!items.length) continue;
    lines.push(`\n### ${mdEscape(slug)}`);

    const byType = {
      news: items.filter((x) => x.type === 'news'),
      forecasts: items.filter((x) => x.type === 'forecasts'),
    };

    for (const [t, arr] of Object.entries(byType)) {
      if (!arr.length) continue;
      lines.push(`\n**${t}**`);
      for (const a of arr) {
        const when = a.iso ? a.iso.replace('T', ' ').replace('Z', 'Z') : '';
        const link = formatArticleMarkdownLink(a);
        lines.push(`- ${link.label} (${when}${a.author ? `, ${mdEscape(a.author)}` : ''})${link.hasLink ? '' : ' — link unavailable'}`);
      }
    }
  }

  process.stdout.write(lines.join('\n') + '\n');
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    process.stderr.write(`fxempire_articles error: ${e.message}\n`);
    process.exitCode = 1;
  });
}
