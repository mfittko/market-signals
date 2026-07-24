#!/usr/bin/env node
/**
 * news-provider-report (issue #104) — the trial deliverable: quantify whether
 * NewsAPI.ai is worth keeping. Read-only. Reads news_provider_observations
 * (the append-only provenance log) and joins it against signals (fresh flips)
 * and bot_journal (bot/adverse-move events). NEVER alters trades or decisions,
 * never spends a NewsAPI.ai token — it only reads what the decision-path pulls
 * already recorded.
 *
 * Coverage, latency, and trading-relevance are computed from accumulated
 * observations; with the on-demand (decision-point) sampling this is an observed
 * end-to-end acquisition delay including our poll timing, not a vendor SLA.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDb } from './supertrend.mjs';

const NAI = 'newsapi-ai';

function median(xs) { const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; }
function pct(xs, p) { const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p / 100 * a.length))] : null; }
function domain(uri) { return String(uri || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase() || null; }

// Load observations for an instrument since a cutoff ISO date.
export function loadObservations(db, instrument, sinceIso) {
  return db.prepare(`SELECT provider, provider_item_id, canonical_url, normalized_title, publisher, source_uri, event_uri, published_at, first_seen_at, is_duplicate, sentiment
    FROM news_provider_observations WHERE instrument=? AND first_seen_at>=? ORDER BY first_seen_at ASC`).all(instrument, sinceIso);
}

// Coverage: totals, unique canonical articles, unique events, duplicate ratio,
// articles unique to the target provider vs the rest (matched on normalized
// title), and distinct publisher domains. `provider` is the reported provider
// (default newsapi-ai); "free"/rest is every other provider in the log.
export function coverage(obs, provider = NAI) {
  const nai = obs.filter((o) => o.provider === provider);
  const free = obs.filter((o) => o.provider !== provider);
  const titleSet = (rows) => new Set(rows.map((o) => o.normalized_title).filter(Boolean));
  const naiTitles = titleSet(nai);
  const freeTitles = titleSet(free);
  const uniqueToNai = [...naiTitles].filter((t) => !freeTitles.has(t)).length;
  const uniqueToFree = [...freeTitles].filter((t) => !naiTitles.has(t)).length;
  const dupCount = nai.filter((o) => o.is_duplicate === 1).length;
  return {
    observations: obs.length,
    newsApiAi: nai.length,
    free: free.length,
    uniqueCanonical: new Set(obs.map((o) => o.canonical_url || o.normalized_title).filter(Boolean)).size,
    uniqueEvents: new Set(nai.map((o) => o.event_uri).filter(Boolean)).size,
    duplicateRatio: nai.length ? Number((dupCount / nai.length).toFixed(3)) : 0,
    articlesUniqueToNewsApiAi: uniqueToNai,
    articlesUniqueToFree: uniqueToFree,
    distinctPublisherDomains: new Set(nai.map((o) => domain(o.source_uri)).filter(Boolean)).size,
  };
}

// Latency: for stories BOTH stacks saw (matched on normalized title), compare
// first_seen_at. Positive lead(min) = NewsAPI.ai saw it earlier.
export function latency(obs, provider = NAI) {
  const firstSeen = (rows) => { const m = new Map(); for (const o of rows) { const t = Date.parse(o.first_seen_at); if (!o.normalized_title || !Number.isFinite(t)) continue; if (!m.has(o.normalized_title) || t < m.get(o.normalized_title)) m.set(o.normalized_title, t); } return m; };
  const naiSeen = firstSeen(obs.filter((o) => o.provider === provider));
  const freeSeen = firstSeen(obs.filter((o) => o.provider !== provider));
  const leads = []; let naiWins = 0; let freeWins = 0;
  for (const [title, naiT] of naiSeen) {
    if (!freeSeen.has(title)) continue;
    const leadMin = (freeSeen.get(title) - naiT) / 60000;
    leads.push(leadMin);
    if (leadMin > 0) naiWins++; else if (leadMin < 0) freeWins++;
  }
  // Acquisition latency vs publish time (includes our poll cadence).
  const acqMin = obs.filter((o) => o.provider === NAI && o.published_at && o.first_seen_at)
    .map((o) => (Date.parse(o.first_seen_at) - Date.parse(o.published_at)) / 60000).filter((x) => Number.isFinite(x) && x >= 0);
  return {
    matchedStories: leads.length,
    newsApiAiFirstSeenWins: naiWins,
    freeFirstSeenWins: freeWins,
    medianLeadMin: median(leads),
    acquisitionMedianMin: median(acqMin),
    acquisitionP90Min: pct(acqMin, 90),
    acquisitionP95Min: pct(acqMin, 95),
  };
}

// Trading relevance: for each fresh flip (signals) and bot event (bot_journal),
// was a plausibly-relevant NewsAPI.ai headline first-seen within N minutes.
export function tradingRelevance(db, instrument, obs, sinceIso, provider = NAI) {
  const naiSeen = obs.filter((o) => o.provider === provider).map((o) => Date.parse(o.first_seen_at)).filter(Number.isFinite);
  const tableExists = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const flips = tableExists('signals')
    ? db.prepare('SELECT time FROM signals WHERE instrument=? AND time>=?').all(instrument, sinceIso).map((r) => Date.parse(r.time)).filter(Number.isFinite) : [];
  // bot_journal is created by the bot pipeline, not by withDb — absent in a fresh
  // candles.db, so guard rather than assume it exists (read-only, never creates).
  // It has no instrument column; the instrument lives in the context JSON, so
  // best-effort filter on a context match (else the report mixes other instruments).
  const events = tableExists('bot_journal')
    ? db.prepare("SELECT at FROM bot_journal WHERE at>=? AND (context LIKE ? OR reason LIKE ?)").all(sinceIso, `%${instrument}%`, `%${instrument}%`).map((r) => Date.parse(r.at)).filter(Number.isFinite) : [];
  // "Available at decision time": the headline must have been first-seen AT OR
  // BEFORE the event and within the window — a headline that arrives AFTER a flip
  // could not have informed it, so Math.abs() would wrongly credit it.
  const within = (eventTs, mins) => eventTs.filter((ts) => naiSeen.some((n) => n <= ts && ts - n <= mins * 60000)).length;
  const buckets = [5, 10, 15, 30];
  const cover = (eventTs) => Object.fromEntries(buckets.map((m) => [`within${m}min`, `${within(eventTs, m)}/${eventTs.length}`]));
  return { freshFlips: flips.length, flipsCovered: cover(flips), botEvents: events.length, botEventsCovered: cover(events) };
}

export function buildReport(db, { instrument, sinceIso, provider = NAI }) {
  const obs = loadObservations(db, instrument, sinceIso);
  const state = db.prepare('SELECT requests_used, last_success_at, last_attempt_at, disabled_reason, disabled_until FROM news_provider_state WHERE provider=? AND instrument=?').get(provider, instrument) || {};
  return {
    provider,
    instrument,
    since: sinceIso,
    apiOperation: {
      requestsUsed: state.requests_used ?? 0,
      lastSuccessAt: state.last_success_at ?? null,
      lastAttemptAt: state.last_attempt_at ?? null,
      circuit: state.disabled_reason ? { reason: state.disabled_reason, until: state.disabled_until } : null,
    },
    coverage: coverage(obs, provider),
    latency: latency(obs, provider),
    tradingRelevance: tradingRelevance(db, instrument, obs, sinceIso, provider),
  };
}

// --- CLI -------------------------------------------------------------------
const USAGE = `news-provider-report (issue #104) — trial benchmark for NewsAPI.ai. Read-only.

Options:
  --provider <name>     provider to report (default: newsapi-ai)
  --instrument <sym>    instrument, e.g. WTICO/USD (required)
  --since <YYYY-MM-DD>  lower bound on first_seen_at (default: 7 days ago... pass explicitly for determinism)
  --db <path>           sqlite path (default: data/candles.db)
  --json                emit JSON instead of text
  -h, --help            show this help
`;

export function parseArgs(argv) {
  const out = { provider: NAI, instrument: null, since: null, db: 'data/candles.db', json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--json') { out.json = true; continue; }
    if (k === '-h' || k === '--help') { out.help = true; continue; }
    const v = argv[i + 1];
    if (k === '--provider' && v) { out.provider = v; i++; }
    else if (k === '--instrument' && v) { out.instrument = v; i++; }
    else if (k === '--since' && v) { out.since = v; i++; }
    else if (k === '--db' && v) { out.db = v; i++; }
  }
  return out;
}

function render(r) {
  const L = [];
  L.push(`# Provider report: ${r.provider} — ${r.instrument} (since ${r.since})`);
  const a = r.apiOperation;
  L.push(`\n## API operation`);
  L.push(`- requests used: ${a.requestsUsed}`);
  L.push(`- last success: ${a.lastSuccessAt ?? '—'} · last attempt: ${a.lastAttemptAt ?? '—'}`);
  L.push(`- circuit: ${a.circuit ? `OPEN (${a.circuit.reason}, until ${a.circuit.until})` : 'closed'}`);
  const c = r.coverage;
  L.push(`\n## Coverage`);
  L.push(`- observations: ${c.observations} (newsapi-ai ${c.newsApiAi}, free ${c.free})`);
  L.push(`- unique canonical articles: ${c.uniqueCanonical} · unique events: ${c.uniqueEvents}`);
  L.push(`- unique to NewsAPI.ai: ${c.articlesUniqueToNewsApiAi} · unique to free: ${c.articlesUniqueToFree}`);
  L.push(`- distinct publisher domains: ${c.distinctPublisherDomains} · duplicate ratio: ${c.duplicateRatio}`);
  const l = r.latency;
  L.push(`\n## Latency (observed, includes poll cadence)`);
  L.push(`- matched stories: ${l.matchedStories} · NewsAPI.ai first-seen wins: ${l.newsApiAiFirstSeenWins} · free wins: ${l.freeFirstSeenWins}`);
  L.push(`- median lead: ${l.medianLeadMin ?? '—'} min · acquisition median/p90/p95: ${l.acquisitionMedianMin ?? '—'}/${l.acquisitionP90Min ?? '—'}/${l.acquisitionP95Min ?? '—'} min`);
  const t = r.tradingRelevance;
  L.push(`\n## Trading relevance`);
  L.push(`- fresh flips: ${t.freshFlips} — covered ${JSON.stringify(t.flipsCovered)}`);
  L.push(`- bot events: ${t.botEvents} — covered ${JSON.stringify(t.botEventsCovered)}`);
  return L.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE); return; }
  if (!args.instrument) { process.stderr.write('news-provider-report: --instrument is required\n' + USAGE); process.exitCode = 1; return; }
  const sinceIso = args.since ? new Date(`${args.since}T00:00:00Z`).toISOString() : new Date(Date.now() - 7 * 86400000).toISOString();
  const report = withDb(args.db, (db) => buildReport(db, { instrument: args.instrument, sinceIso, provider: args.provider }));
  process.stdout.write((args.json ? JSON.stringify(report, null, 2) : render(report)) + '\n');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main().catch((e) => { process.stderr.write(`news-provider-report error: ${e.message}\n`); process.exitCode = 1; });
