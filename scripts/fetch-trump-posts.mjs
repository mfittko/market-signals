#!/usr/bin/env node
// Post ingestion (issue #7, component 1).
// Fetches the CNN-hosted Trump Truth Social archive, window-filters by
// created_at, strips HTML, dedupes by id, and writes normalized posts
// { id, createdAtISO, text, url, engagement }. Stdlib only, bounded retry.
import { writeFileSync } from 'node:fs';

export const ARCHIVE_URL = 'https://ix.cnn.io/data/truth-social/truth_archive.json';

export function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizePost(raw) {
  const createdAt = raw.created_at || raw.createdAt || raw.createdAtISO || null;
  const ms = Date.parse(createdAt);
  return {
    id: String(raw.id ?? raw.post_id ?? ''),
    createdAtISO: Number.isFinite(ms) ? new Date(ms).toISOString() : createdAt,
    text: stripHtml(raw.content ?? raw.text ?? ''),
    url: raw.url || raw.uri || null,
    engagement: {
      replies: Number(raw.replies_count ?? raw.replies ?? 0) || 0,
      reblogs: Number(raw.reblogs_count ?? raw.reblogs ?? 0) || 0,
      favourites: Number(raw.favourites_count ?? raw.favourites ?? raw.likes ?? 0) || 0,
    },
  };
}

// Normalize + window-filter [sinceMs, untilMs] + dedupe by id, newest first.
export function ingest(rawPosts, { sinceMs = -Infinity, untilMs = Infinity } = {}) {
  const arr = Array.isArray(rawPosts) ? rawPosts : rawPosts?.posts || [];
  const byId = new Map();
  for (const raw of arr) {
    const p = normalizePost(raw);
    if (!p.id || !p.createdAtISO || !p.text) continue;
    const ms = Date.parse(p.createdAtISO);
    if (!Number.isFinite(ms) || ms < sinceMs || ms > untilMs) continue;
    if (!byId.has(p.id)) byId.set(p.id, p); // dedupe by id
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.createdAtISO) - Date.parse(a.createdAtISO));
}

async function fetchArchive(url, { retries = 3, timeoutMs = 60000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, attempt * 1500));
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error(`archive fetch failed after ${retries} tries: ${lastErr?.message}`);
}

async function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i]);
  }
  if (args.has('help')) {
    process.stdout.write('fetch-trump-posts — pull + normalize the CNN Trump archive.\n  --since <ISO>   window start (default: 14 days ago)\n  --until <ISO>   window end (default: now)\n  --out <file>    write JSON array (default: stdout)\n  --url <url>     override archive URL\n');
    return;
  }
  const now = Date.now();
  const sinceMs = args.has('since') ? Date.parse(String(args.get('since'))) : now - 14 * 864e5;
  const untilMs = args.has('until') ? Date.parse(String(args.get('until'))) : now;
  const raw = await fetchArchive(String(args.get('url') || ARCHIVE_URL));
  const posts = ingest(raw, { sinceMs, untilMs });
  const json = JSON.stringify(posts, null, 2);
  if (args.has('out')) {
    writeFileSync(String(args.get('out')), json);
    process.stderr.write(`wrote ${posts.length} posts to ${args.get('out')}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`fetch-trump-posts error: ${e.message}\n`);
    process.exit(1);
  });
}
