#!/usr/bin/env node
/**
 * market-sentinel / sentinel_briefing (issue #91) — renders a markdown
 * digest across tracked instruments, meant to feed
 * skills/briefing-publisher/scripts/publish_briefing.mjs --series sentinel.
 *
 * Replaces the dried-up FXEmpire market-analysis briefing input (#11/#28):
 * this pulls from sentinel_news.mjs (same free sources/escalation logic as
 * #86) per instrument instead of the stale FXEmpire article scrape.
 *
 * Two ways to get data:
 *   --fixture <path>   JSON array of {instrument, label, items, escalation}
 *                       (same item shape fetchSentinelNews returns) — the
 *                       offline/test path, no network at all.
 *   (default)          live fetchSentinelNews per --instruments, using
 *                       config/instruments.yaml sentinel queries.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSentinelNews, DEFAULT_HOURS as NEWS_DEFAULT_HOURS } from './sentinel_news.mjs';
import {
  sentinelConfigForInstrument, findInstrumentBySlug, loadInstrumentsConfig, SYMBOL_TO_SLUG,
} from '../../../scripts/lib/instruments.mjs';

export const DEFAULT_HOURS = NEWS_DEFAULT_HOURS;
export const MAX_HEADLINES_PER_INSTRUMENT = 5;

function mdEscape(text) {
  // published as markdown -> HTML on GitHub Pages: neutralize raw-HTML chars so an
  // untrusted headline can't inject markup, plus table-pipe and newline handling
  // strip the HTML-tag delimiters (the actual injection vector for an untrusted
  // headline rendered md->HTML) plus table-pipe/newline; a bare & is left as-is —
  // it can't open a tag and escaping it would mangle legit labels like 'S&P 500'
  return String(text ?? '')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

// Markdown link text: escape ] and [ so a headline containing brackets can
// never break out of the [label](url) shape.
function linkText(text) {
  return mdEscape(text).replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

// Only http(s) URLs get linked; anything else (javascript:, data:, malformed)
// renders as plain text. Angle-bracket form so a stray space/paren in the
// destination can't break out of the markdown link syntax.
function sanitizeUrl(url) {
  if (!url) return null;
  const collapsed = String(url).replace(/\s+/g, ' ').trim();
  return /^https?:\/\//i.test(collapsed) ? collapsed : null;
}

function headlineLine(item) {
  const source = mdEscape(item?.source || 'source');
  const title = linkText(item?.title || 'Untitled');
  const safeUrl = sanitizeUrl(item?.url);
  const label = safeUrl ? `[${title}](<${safeUrl}>)` : title;
  const when = item?.timeIso ? ` — ${mdEscape(item.timeIso)}` : '';
  const flag = item?.escalation ? ' ⚠' : '';
  return `- [${source}] ${label}${when}${flag}`;
}

// Pure renderer: no fs/network, so tests exercise it directly on fixture data.
// Bounded output: caps headlines per instrument (MAX_HEADLINES_PER_INSTRUMENT).
export function renderSentinelBriefing({ asOf, instruments = [] } = {}) {
  const flagged = instruments.filter((inst) => inst.escalation);
  const lines = [];

  lines.push('# Market Sentinel Briefing');
  lines.push('');
  lines.push(`asOf: ${asOf || new Date().toISOString()}`);
  lines.push('');
  lines.push('## Escalation summary');
  lines.push('');
  lines.push(
    flagged.length
      ? `⚠ ${flagged.length} of ${instruments.length} tracked instrument(s) flagged: ${flagged
        .map((inst) => mdEscape(inst.label || inst.instrument))
        .join(', ')}`
      : `No escalation flags across ${instruments.length} tracked instrument(s).`
  );
  lines.push('');
  lines.push('## Headlines by instrument');
  lines.push('');

  for (const inst of instruments) {
    const label = mdEscape(inst.label || inst.instrument);
    lines.push(`### ${label}${inst.escalation ? ' ⚠' : ''}`);
    lines.push('');
    const top = (inst.items || []).slice(0, MAX_HEADLINES_PER_INSTRUMENT);
    if (!top.length) {
      lines.push('_No recent headlines._');
    } else {
      for (const item of top) lines.push(headlineLine(item));
    }
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// Reads a fixture file (JSON array, offline path — no network).
export function loadFixtureInstruments(fixturePath) {
  const raw = fs.readFileSync(path.resolve(fixturePath), 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('fixture must be a JSON array of per-instrument sentinel results');
  return parsed;
}

// Committed instruments = every candle symbol with a sentinel query in
// config/instruments.yaml (scripts/lib/instruments.mjs's SYMBOL_TO_SLUG
// bridge) — never guess a query for anything not committed there.
export function defaultInstruments() {
  return Object.keys(SYMBOL_TO_SLUG);
}

// Gathers live sentinel data per instrument (fetchFn injectable for tests,
// same convention fetchSentinelNews itself uses for its own fetcher param).
export async function buildSentinelDigest({
  instruments = defaultInstruments(),
  hours = DEFAULT_HOURS,
  now = Date.now(),
  fetchFn = fetchSentinelNews,
  log = () => {},
} = {}) {
  const cfg = loadInstrumentsConfig();
  const out = [];
  for (const instrument of instruments) {
    const sentinelCfg = sentinelConfigForInstrument(instrument, cfg);
    if (!sentinelCfg) {
      log(`skipping ${instrument}: no committed sentinel config`);
      continue;
    }
    const entry = findInstrumentBySlug(sentinelCfg.slug, cfg);
    const result = await fetchFn({
      query: sentinelCfg.query, yahooSymbol: sentinelCfg.yahooSymbol, hours, now, log,
    });
    out.push({
      instrument, label: entry?.name || sentinelCfg.slug, escalation: result.escalation, items: result.items,
    });
  }
  return { asOf: new Date(now).toISOString(), instruments: out };
}

// --- CLI ---------------------------------------------------------------
const USAGE = `sentinel_briefing (market-sentinel) — render a markdown digest across tracked instruments, for briefing-publisher (--series sentinel).

Options:
  --instruments <csv>   candle symbols, comma-separated (default: all with a committed sentinel query)
  --hours <n>           lookback window in hours (default: ${DEFAULT_HOURS})
  --fixture <path>      offline fixture: JSON array of {instrument,label,items,escalation} — skips network entirely
  --output-file <path>  write markdown here instead of stdout
  -h, --help            show this help (no network)
`;

// only --help is a real long boolean; -h (short) is handled at the entrypoint, so
// a bare --h is a typo that must fail loud rather than be silently accepted
const BOOLEAN_FLAGS = new Set(['help']);

export function parseArgs(argv) {
  const out = { instruments: null, hours: DEFAULT_HOURS, fixture: null, outputFile: null };
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('-')) continue;
    if (token === '-h') continue; // alias for --help, handled at the CLI entrypoint
    if (!token.startsWith('--')) { unknown.push(token); continue; }
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) continue;
    const next = argv[i + 1];
    // a following token that starts with '-' is another flag, not this flag's value —
    // except a numeric token (e.g. --hours -3 is parsed as a value; hours<=0 later
    // normalizes to DEFAULT_HOURS); otherwise '--hours -x' would swallow the -x flag
    const nextIsFlag = next !== undefined && next.startsWith('-') && !/^-\d/.test(next);
    const hasValue = next !== undefined && !nextIsFlag;
    const val = hasValue ? next : null;
    if (hasValue) i++;

    if (key === 'instruments' && val) out.instruments = val.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'hours' && val) out.hours = Number(val);
    else if (key === 'fixture' && val) out.fixture = val;
    else if (key === 'output-file' && val) out.outputFile = val;
    else unknown.push(`--${key}`);
  }
  if (unknown.length) throw new Error(`unknown flag(s): ${unknown.join(', ')} (run --help)`);
  if (!Number.isFinite(out.hours) || out.hours <= 0) out.hours = DEFAULT_HOURS;
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const args = parseArgs(argv);

  const digest = args.fixture
    ? { asOf: new Date().toISOString(), instruments: loadFixtureInstruments(args.fixture) }
    : await buildSentinelDigest({ instruments: args.instruments || defaultInstruments(), hours: args.hours });

  const markdown = renderSentinelBriefing(digest);
  if (args.outputFile) {
    fs.mkdirSync(path.dirname(path.resolve(args.outputFile)), { recursive: true });
    fs.writeFileSync(path.resolve(args.outputFile), markdown);
  } else {
    process.stdout.write(markdown);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    process.stderr.write(`sentinel_briefing error: ${e.message}\n`);
    process.exitCode = 1;
  });
}
