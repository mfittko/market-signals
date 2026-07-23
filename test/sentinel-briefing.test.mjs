import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  renderSentinelBriefing, loadFixtureInstruments, buildSentinelDigest,
  defaultInstruments, parseArgs, MAX_HEADLINES_PER_INSTRUMENT,
} from '../skills/market-sentinel/scripts/sentinel_briefing.mjs';

const SCRIPT = fileURLToPath(new URL('../skills/market-sentinel/scripts/sentinel_briefing.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/sentinel_briefing_digest.json', import.meta.url));

// --- renderSentinelBriefing: pure, bounded, escaped ---------------------------
test('renderSentinelBriefing: escalation summary flags only the escalated instrument(s), by label', () => {
  const md = renderSentinelBriefing({
    asOf: '2026-07-23T12:00:00Z',
    instruments: [
      { instrument: 'WTICO/USD', label: 'WTI Oil', escalation: true, items: [] },
      { instrument: 'XAU/USD', label: 'Gold', escalation: false, items: [] },
    ],
  });
  assert.match(md, /# Market Sentinel Briefing/);
  assert.match(md, /asOf: 2026-07-23T12:00:00Z/);
  assert.match(md, /⚠ 1 of 2 tracked instrument\(s\) flagged: WTI Oil/);
  assert.ok(!md.includes('Gold ⚠'), 'unflagged instrument heading must not carry the escalation marker');
});

test('renderSentinelBriefing: no flags renders a clean "no escalation" line', () => {
  const md = renderSentinelBriefing({
    asOf: '2026-07-23T12:00:00Z',
    instruments: [{ instrument: 'XAU/USD', label: 'Gold', escalation: false, items: [] }],
  });
  assert.match(md, /No escalation flags across 1 tracked instrument\(s\)\./);
});

test('renderSentinelBriefing: groups headlines per instrument with source, link, and time', () => {
  const md = renderSentinelBriefing({
    asOf: '2026-07-23T12:00:00Z',
    instruments: [{
      instrument: 'WTICO/USD',
      label: 'WTI Oil',
      escalation: true,
      items: [{ source: 'google-news', title: 'Tanker attack near Hormuz', url: 'https://x/1', timeIso: '2026-07-23T09:00:00Z', escalation: true }],
    }],
  });
  assert.match(md, /### WTI Oil ⚠/);
  assert.match(md, /- \[google-news\] \[Tanker attack near Hormuz\]\(<https:\/\/x\/1>\) — 2026-07-23T09:00:00Z ⚠/);
});

test('renderSentinelBriefing: a javascript: url is dropped, headline renders as plain text (no link)', () => {
  const md = renderSentinelBriefing({
    asOf: 'x',
    instruments: [{
      instrument: 'WTICO/USD',
      label: 'WTI Oil',
      items: [{ source: 's', title: 'Unsafe link', url: 'javascript:alert(1)' }],
    }],
  });
  assert.ok(md.includes('- [s] Unsafe link'), 'plain text, no markdown link');
  assert.ok(!md.includes('javascript:'), 'unsafe scheme never reaches the output');
});

test('renderSentinelBriefing: a url containing whitespace is angle-bracketed so it cannot break the link', () => {
  const md = renderSentinelBriefing({
    asOf: 'x',
    instruments: [{
      instrument: 'WTICO/USD',
      label: 'WTI Oil',
      items: [{ source: 's', title: 'Spacey link', url: 'https://x/has space' }],
    }],
  });
  assert.match(md, /\[Spacey link\]\(<https:\/\/x\/has space>\)/);
});

test('renderSentinelBriefing: a normal http(s) url still renders as a link', () => {
  const md = renderSentinelBriefing({
    asOf: 'x',
    instruments: [{
      instrument: 'WTICO/USD',
      label: 'WTI Oil',
      items: [{ source: 's', title: 'Normal link', url: 'https://example.com/a' }],
    }],
  });
  assert.match(md, /\[Normal link\]\(<https:\/\/example\.com\/a>\)/);
});

test('renderSentinelBriefing: an instrument with zero headlines still gets a section, not an empty gap', () => {
  const md = renderSentinelBriefing({ asOf: '2026-07-23T12:00:00Z', instruments: [{ instrument: 'SPX500/USD', label: 'S&P 500', escalation: false, items: [] }] });
  assert.match(md, /### S&P 500\n\n_No recent headlines\._/);
});

test('renderSentinelBriefing: bounds headlines to MAX_HEADLINES_PER_INSTRUMENT, newest-first order preserved from input', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ source: 's', title: `Headline ${i}`, url: `https://x/${i}` }));
  const md = renderSentinelBriefing({ asOf: 'x', instruments: [{ instrument: 'WTICO/USD', label: 'WTI Oil', items }] });
  const bulletCount = (md.match(/^- \[s\]/gm) || []).length;
  assert.equal(bulletCount, MAX_HEADLINES_PER_INSTRUMENT);
  assert.ok(md.includes('Headline 0') && !md.includes('Headline 9'), 'keeps the first N, drops the rest');
});

test('renderSentinelBriefing: escapes markdown-breaking characters in title/label so the digest stays a valid, non-truncated document', () => {
  const md = renderSentinelBriefing({
    asOf: 'x',
    instruments: [{
      instrument: 'WTICO/USD',
      label: 'WTI | Oil',
      escalation: true,
      items: [{ source: 's', title: 'Oil [surges] on attack\nnewline', url: null }],
    }],
  });
  assert.match(md, /### WTI \\\| Oil ⚠/);
  assert.ok(md.includes('Oil \\[surges\\] on attack'), 'brackets escaped so it cannot be mistaken for a link label');
  assert.ok(!/attack\nnewline/.test(md), 'embedded newline collapsed, cannot break out of the bullet line');
});

// --- loadFixtureInstruments: offline path, no network -------------------------
test('loadFixtureInstruments: reads the committed fixture into the shape renderSentinelBriefing expects', () => {
  const instruments = loadFixtureInstruments(FIXTURE);
  assert.ok(Array.isArray(instruments) && instruments.length === 3);
  const md = renderSentinelBriefing({ asOf: '2026-07-23T12:00:00Z', instruments });
  assert.match(md, /⚠ 1 of 3 tracked instrument\(s\) flagged: WTI Oil/);
  assert.match(md, /### Gold/);
  assert.match(md, /### S&P 500/);
});

test('loadFixtureInstruments: rejects a non-array fixture rather than silently rendering garbage', () => {
  assert.throws(() => loadFixtureInstruments(fileURLToPath(new URL('./fixtures/sentinel_gdelt.json', import.meta.url))), /fixture must be a JSON array/);
});

// --- buildSentinelDigest: injectable fetchFn, never guesses a query ----------
test('buildSentinelDigest: skips an instrument with no committed sentinel config, fetches only the configured ones', async () => {
  const calls = [];
  const fetchFn = async ({ query }) => {
    calls.push(query);
    return { items: [], escalation: false, asOf: '2026-07-23T12:00:00Z' };
  };
  const digest = await buildSentinelDigest({ instruments: ['WTICO/USD', 'BTC/USD'], fetchFn, now: Date.parse('2026-07-23T12:00:00Z') });
  assert.equal(digest.instruments.length, 1);
  assert.equal(digest.instruments[0].instrument, 'WTICO/USD');
  assert.equal(digest.instruments[0].label, 'WTI Oil');
  assert.equal(calls.length, 1, 'BTC/USD (no sentinel config) never triggers a fetch');
});

test('defaultInstruments: every entry has a committed sentinel config (round-trips through buildSentinelDigest without being skipped)', async () => {
  const instruments = defaultInstruments();
  assert.ok(instruments.length > 0);
  const fetchFn = async () => ({ items: [], escalation: false, asOf: '2026-07-23T12:00:00Z' });
  const digest = await buildSentinelDigest({ instruments, fetchFn, now: Date.parse('2026-07-23T12:00:00Z') });
  assert.equal(digest.instruments.length, instruments.length);
});

// --- parseArgs -----------------------------------------------------------------
test('parseArgs: --instruments splits on comma, unknown flags fail loud', () => {
  const args = parseArgs(['--instruments', 'WTICO/USD,XAU/USD', '--hours', '6']);
  assert.deepEqual(args.instruments, ['WTICO/USD', 'XAU/USD']);
  assert.equal(args.hours, 6);
  assert.throws(() => parseArgs(['--bogus', 'x']), /unknown flag/);
});

test('parseArgs: single-dash typos fail loud instead of being silently ignored', () => {
  assert.throws(() => parseArgs(['-hours', '6']), /unknown flag/);
  assert.throws(() => parseArgs(['-x']), /unknown flag/);
});

// --- CLI: hermetic parts only (no live network) -------------------------------
test('sentinel_briefing --help exits 0 with usage, no network', () => {
  const res = spawnSync('node', [SCRIPT, '--help'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('sentinel_briefing'));
  assert.ok(res.stdout.includes('--fixture'));
});

test('sentinel_briefing --fixture renders the digest end-to-end without hitting the network', () => {
  const res = spawnSync('node', [SCRIPT, '--fixture', FIXTURE], { encoding: 'utf8', timeout: 20000 });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /# Market Sentinel Briefing/);
  assert.match(res.stdout, /## Escalation summary/);
  assert.match(res.stdout, /## Headlines by instrument/);
});

test('sentinel_briefing unknown flag fails loud', () => {
  const res = spawnSync('node', [SCRIPT, '--bogus', 'x'], { encoding: 'utf8', timeout: 20000 });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unknown flag/);
});


test('mdEscape neutralizes HTML tag delimiters in an untrusted headline (published md->HTML) (#91)', async () => {
  const { renderSentinelBriefing } = await import('../skills/market-sentinel/scripts/sentinel_briefing.mjs');
  const md = renderSentinelBriefing({ asOf: '2026-07-23T00:00:00Z', instruments: [
    { instrument: 'WTICO/USD', label: 'WTI', escalation: false, items: [
      { source: 'x', title: 'Oil <img src=x onerror=alert(1)> jumps', url: 'https://e.com', timeIso: '2026-07-23T00:00:00Z' },
    ] },
  ] });
  assert.ok(!md.includes('<img'), 'raw tag delimiter escaped');
  assert.ok(md.includes('&lt;img'), 'rendered as escaped text');
});

test('parseArgs: a flag-shaped token after a value-flag is not swallowed as its value (#91)', async () => {
  const { parseArgs } = await import('../skills/market-sentinel/scripts/sentinel_briefing.mjs');
  assert.throws(() => parseArgs(['--hours', '-x']), /unknown|unrecognized|-x/i);
  // a negative number is still a valid value
  const ok = parseArgs(['--hours', '6']);
  assert.equal(String(ok.hours), '6');
});
