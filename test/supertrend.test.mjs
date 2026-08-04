import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeSupertrend, detectFlips, backtestFlips, storeCandles, recordSignal, signalOutcomes, withDb, excursionSince } from '../scripts/supertrend.mjs';

// Synthetic series: flat, crash, rally, crash — must flip sell, buy, sell.
function series(closes) {
  return closes.map((close, i) => ({
    time: new Date(Date.parse('2026-07-22T08:00:00Z') + i * 300000).toISOString(),
    open: close, high: close + 0.2, low: close - 0.2, close, complete: true,
  }));
}

const closes = [
  ...Array(15).fill(100),
  ...Array.from({ length: 10 }, (_, i) => 100 - (i + 1) * 2), // crash to 80
  ...Array.from({ length: 20 }, (_, i) => 80 + (i + 1) * 2),  // rally to 120
  ...Array.from({ length: 15 }, (_, i) => 120 - (i + 1) * 2), // crash to 90
];
const candles = series(closes);

test('supertrend flips sell on crashes and buy on the rally', () => {
  const st = computeSupertrend(candles, { period: 10, multiplier: 3 });
  const flips = detectFlips(candles, st);
  assert.deepEqual(flips.map((f) => f.signal), ['sell', 'buy', 'sell']);
  assert.equal(st[st.length - 1].trend, 'down');
});

test('backtest: two closed winning trades, trailing sell trade marked open', () => {
  const st = computeSupertrend(candles, { period: 10, multiplier: 3 });
  const flips = detectFlips(candles, st);
  const bt = backtestFlips(candles, flips);
  assert.equal(bt.trades, 3);
  assert.equal(bt.closed, 2);
  assert.ok(bt.perTrade[0].returnPct > 0, 'short caught part of the first crash');
  assert.ok(bt.perTrade[1].returnPct > 0, 'long caught part of the rally');
  assert.equal(bt.perTrade[2].open, true);
  assert.equal(bt.winRatePct, 100);
  assert.ok(bt.totalReturnPct > 0);
});

test('signal memory: dedup by flip time, 30-min outcome computed from stored candles', () => {
  const dbPath = fileURLToPath(new URL('./tmp-signals-test.db', import.meta.url));
  rmSync(dbPath, { force: true });
  storeCandles(dbPath, 'WTICO/USD', 'M5', candles);

  // Sell signal at index 20 (during the crash): 6 bars later price is lower → positive outcome.
  const sig = { time: candles[20].time, signal: 'sell', price: candles[20].close };
  assert.equal(recordSignal(dbPath, 'WTICO/USD', 'M5', sig, 50).isNew, true);
  assert.equal(recordSignal(dbPath, 'WTICO/USD', 'M5', sig, 50).isNew, false, 'same flip records once');

  const [row] = signalOutcomes(dbPath, 'WTICO/USD', 'M5');
  const expected = -(candles[26].close - candles[20].close) / candles[20].close * 100;
  assert.ok(Math.abs(row.outcomePct - expected) < 1e-3, `direction-adjusted outcome, got ${row.outcomePct}`);
  assert.ok(row.outcomePct > 0, 'short during a crash is a winning outcome');
  rmSync(dbPath, { force: true });
});

test('signalOutcomes: adverse outcome held to the next opposite signal, open flag, before-pagination', () => {
  const dbPath = fileURLToPath(new URL('./tmp-adverse-test.db', import.meta.url));
  rmSync(dbPath, { force: true });
  storeCandles(dbPath, 'WTICO/USD', 'M5', candles);
  const buy = { time: candles[10].time, signal: 'buy', price: candles[10].close };
  const sell = { time: candles[20].time, signal: 'sell', price: candles[20].close };
  recordSignal(dbPath, 'WTICO/USD', 'M5', buy, 50);
  recordSignal(dbPath, 'WTICO/USD', 'M5', sell, 50);
  const rows = signalOutcomes(dbPath, 'WTICO/USD', 'M5');
  const buyRow = rows.find((r) => r.time === buy.time);
  const sellRow = rows.find((r) => r.time === sell.time);
  // buy held until the next opposite (the sell) — return measured to the sell's price
  const expectedAdv = (candles[20].close - candles[10].close) / candles[10].close * 100;
  assert.ok(Math.abs(buyRow.adverseOutcomePct - expectedAdv) < 1e-3, `buy adverse to next sell, got ${buyRow.adverseOutcomePct}`);
  assert.equal(buyRow.adverseOpen, false, 'buy has a following opposite signal — not open');
  // the sell is the latest — no opposite after it — so it is still open (to last close)
  assert.equal(sellRow.adverseOpen, true, 'latest signal is still open');
  assert.notEqual(sellRow.adverseOutcomePct, null, 'open outcome measured to the last close');
  // before-pagination: before the sell returns only the older buy
  const older = signalOutcomes(dbPath, 'WTICO/USD', 'M5', { before: sell.time, limit: 10 });
  assert.deepEqual(older.map((r) => r.time), [buy.time], 'before=<sell> pages in the older buy only');
  rmSync(dbPath, { force: true });
});

test('storeCandles upserts idempotently', () => {
  const dbPath = fileURLToPath(new URL('./tmp-candles-test.db', import.meta.url));
  rmSync(dbPath, { force: true });
  const first = storeCandles(dbPath, 'BCO/USD', 'M5', candles);
  const again = storeCandles(dbPath, 'BCO/USD', 'M5', candles);
  assert.equal(first.totalRows, candles.length);
  assert.equal(again.totalRows, candles.length, 'no duplicates on re-run');
  rmSync(dbPath, { force: true });
});

// --- excursionSince (#70): direction-adjusted current/best/worst since a signal ---
test('excursionSince: direction-adjusted current/best/worst move since entry, for both buy and sell', () => {
  const entryPrice = 100;
  const candlesSince = [{ close: 102 }, { close: 95 }, { close: 108 }, { close: 101 }];
  const buy = excursionSince(1, entryPrice, candlesSince);
  assert.deepEqual(buy, { currentPct: 1, maxFavorablePct: 8, maxAdversePct: -5 });
  const sell = excursionSince(-1, entryPrice, candlesSince);
  assert.deepEqual(sell, { currentPct: -1, maxFavorablePct: 5, maxAdversePct: -8 });
  assert.equal(excursionSince(1, 0, candlesSince), null, 'no entry price: no excursion');
  assert.equal(excursionSince(1, entryPrice, []), null, 'no candles since: no excursion');
});

test('excursionSince: a very large candlesSince array computes without throwing (Math.max/min(...array) would stack-overflow on this size)', () => {
  const entryPrice = 100;
  const n = 200000;
  const candlesSince = Array.from({ length: n }, (_, i) => ({ close: 100 + (i % 1000) - 500 }));
  const result = excursionSince(1, entryPrice, candlesSince);
  assert.ok(Number.isFinite(result.currentPct));
  assert.ok(Number.isFinite(result.maxFavorablePct));
  assert.ok(Number.isFinite(result.maxAdversePct));
  assert.equal(result.maxFavorablePct, 499, 'best move: close hits 100+499');
  assert.equal(result.maxAdversePct, -500, 'worst move: close hits 100-500');
});

test('--help exits 0 with usage, no network, no db writes', () => {
  const script = fileURLToPath(new URL('../scripts/supertrend.mjs', import.meta.url));
  const cwd = mkdtempSync(join(tmpdir(), 'st-help-'));
  const res = spawnSync('node', [script, '--help'], { encoding: 'utf8', timeout: 20000, cwd });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('supertrend'), res.stdout);
  assert.ok(res.stdout.includes('--settings'), 'usage documents the settings flag');
  assert.ok(/manual\/debug/i.test(res.stdout), 'usage warns this is a manual/debug runner (#199)');
  assert.ok(/double-execute/i.test(res.stdout), 'usage warns about double-executing a cycle alongside the server heartbeat');
  assert.equal(existsSync(join(cwd, 'data')), false, '--help must not create the data dir/db');
});

// --- processSignal: opt-in filter, fail-open, dedup (no real pi/osascript/network) ---
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processSignal } from '../scripts/supertrend.mjs';

function fakeBin(dir, name, script) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

function fixture(dir, { notify = true, settings = {}, candleCount = 20 } = {}) {
  const settingsPath = join(dir, 'settings.json');
  // Defense in depth: even without the MS_NO_NOTIFY env guard, a fixture-pinned
  // missing notifierBin trips the explicitly-configured-missing suppression in
  // sendNotification, so no test can ever reach a real terminal-notifier/osascript.
  writeFileSync(settingsPath, JSON.stringify({ notifierBin: join(dir, 'no-such-notifier'), ...settings }));
  const opts = { db: join(dir, 'db.sqlite'), instrument: 'WTICO/USD', granularity: 'M5', notify, settings: settingsPath };
  const result = {
    close: 88.0, trend: 'down', supertrend: 88.8,
    signal: { time: '2026-07-22T10:15:00Z', signal: 'sell', price: 88.35, barsAgo: 0, fresh: true },
    backtest: { winRatePct: 50, totalReturnPct: 1, trades: 4 },
  };
  return { opts, result, candles: candles.slice(0, candleCount) };
}

test('processSignal records fresh flips with notify off, and dedups', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const { opts, result, candles: c } = fixture(dir, { notify: false });
  const first = await processSignal(opts, result, c);
  assert.equal(first.sent, false);
  assert.match(first.reason, /recorded/);
  const [row] = signalOutcomes(opts.db, 'WTICO/USD', 'M5');
  assert.equal(row.signal, 'sell');
  const again = await processSignal(opts, result, c);
  assert.equal(again.reason, 'already processed');
});

test('processSignal suppresses when the filter says no (fake pi), no notification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const piBin = fakeBin(dir, 'pi', `echo "$@" > ${join(dir, 'pi-args.txt')}\necho '{"alert": false, "reason": "test suppress"}'`);
  const { opts, result, candles: c } = fixture(dir, { settings: { provider: 'pi', piBin } });
  const res = await processSignal(opts, result, c);
  assert.equal(res.sent, false);
  assert.match(res.reason, /suppressed by filter: test suppress/);
  assert.match(readFileSync(join(dir, 'pi-args.txt'), 'utf8'), /volumeContext/, 'filter payload carries volume context');
  const [row] = signalOutcomes(opts.db, 'WTICO/USD', 'M5');
  assert.equal(row.verdict, 'suppress');
  assert.equal(row.notified, 0);
});

test('buildFilterPayload (#102): pins the payload object shape + key insertion order (NB: llmVerdict JSON.stringifies it, dropping undefined-valued keys) so processSignal and refilter-signals.mjs never drift', async () => {
  const { buildFilterPayload } = await import('../scripts/supertrend.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const dbPath = join(dir, 'db.sqlite');
  storeCandles(dbPath, 'WTICO/USD', 'M5', candles);
  const sig = { time: candles[20].time, signal: 'sell', price: candles[20].close, index: 20, barsAgo: 0, fresh: true };
  const result = { close: candles[20].close, trend: 'down', supertrend: 88.8, backtest: { winRatePct: 50, totalReturnPct: 1, trades: 4 } };
  const payload = await buildFilterPayload({
    dbPath, instrument: 'WTICO/USD', granularity: 'M5', sig, result,
    candles: candles.slice(0, 21), history: [], gateSnapshot: null, notes: 'note text',
  });
  assert.deepEqual(Object.keys(payload), [
    'current', 'backtestWindow', 'recentCandles', 'volumeContext',
    'pastSignals30mOutcomes', 'axisGate', 'traderNotes', 'traderMemories', 'sentinel',
  ]);
  assert.equal(payload.current.signal, 'sell');
  assert.equal(payload.traderNotes, 'note text');
  assert.equal(payload.axisGate, null, 'no gateSnapshot: axisGate is null');
});

test('processSignal filter payload (#86): a sentinel block is injected only when the news cache has recent rows for the instrument, framed as advisory', async () => {
  const { upsertNews } = await import('../scripts/news.mjs');
  const { FILTER_RULES } = await import('../scripts/supertrend.mjs');

  // No cache rows: the sentinel key is entirely absent from the filter payload.
  {
    const dir = mkdtempSync(join(tmpdir(), 'st-'));
    const piBin = fakeBin(dir, 'pi', `echo "$@" > ${join(dir, 'pi-args.txt')}\necho '{"alert": true, "reason": "ok"}'`);
    const { opts, result, candles: c } = fixture(dir, { settings: { provider: 'pi', piBin } });
    await processSignal(opts, result, c);
    const args = readFileSync(join(dir, 'pi-args.txt'), 'utf8');
    assert.ok(!args.includes('"sentinel"'), 'empty news cache: sentinel block omitted');
  }

  // Cache has a recent row for the instrument: sentinel block present with escalation+headlines.
  {
    const dir = mkdtempSync(join(tmpdir(), 'st-'));
    const piBin = fakeBin(dir, 'pi', `echo "$@" > ${join(dir, 'pi-args.txt')}\necho '{"alert": true, "reason": "ok"}'`);
    const { opts, result, candles: c } = fixture(dir, { settings: { provider: 'pi', piBin } });
    upsertNews(opts.db, 'WTICO/USD', [
      { source: 'google-news', title: 'Tanker attack near Hormuz', timeIso: new Date().toISOString(), url: 'https://x/86-filter', escalation: true },
    ], new Date().toISOString());
    await processSignal(opts, result, c);
    const args = readFileSync(join(dir, 'pi-args.txt'), 'utf8');
    assert.match(args, /"sentinel":\{"escalation":true,"headlines":\[\{"title":"Tanker attack near Hormuz"/);
  }

  assert.match(FILTER_RULES, /sentinel/i, 'the filter prompt frames the sentinel block as advisory');
});

test('processSignal fails open on filter error and records the verdict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  fakeBin(dir, 'osascript', 'exit 0'); // shadow real osascript via PATH
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}:${prevPath}`;
  try {
    const { opts, result, candles: c } = fixture(dir, { settings: { provider: 'pi', piBin: join(dir, 'missing-pi'), notifierBin: join(dir, 'missing-notifier') } });
    const res = await processSignal(opts, result, c);
    assert.equal(res.sent, true, res.reason);
    assert.equal(res.verdictSource, 'error');
    const [row] = signalOutcomes(opts.db, 'WTICO/USD', 'M5');
    assert.equal(row.verdict, 'alert');
    assert.match(row.reason, /filter error/);
    assert.equal(row.notified, 1);
  } finally {
    process.env.PATH = prevPath;
  }
});

test('resolveFilterSystem falls back to the builtin prompt when gate-prompt resolution throws (fail-open, #58)', async () => {
  const { resolveFilterSystem } = await import('../scripts/supertrend.mjs');
  const r = await resolveFilterSystem('/nonexistent-dir/nope/db.sqlite');
  assert.equal(r.promptVersion, 'builtin', 'resolution errors never break the alert path');
});

test('processSignal filter: active gate-prompt override feeds the filter system text; promptVersion lands in provenance both ways (#58)', async () => {
  const { saveGatePrompt, activateGatePrompt } = await import('../scripts/gate-prompts.mjs');
  const { FILTER_RULES, FILTER_SCHEMA_SUFFIX } = await import('../scripts/supertrend.mjs');
  const { promptHash } = await import('../scripts/axis-snapshot.mjs');
  const builtinHash = promptHash(FILTER_RULES + FILTER_SCHEMA_SUFFIX);
  const OVERRIDE_RULES = 'OVERRIDE-RULES-MARKER: require two confirming bars before any alert.';

  // Without an override: builtin rules used, promptVersion 'builtin' recorded.
  {
    const dir = mkdtempSync(join(tmpdir(), 'st-'));
    const piBin = fakeBin(dir, 'pi', `echo "$@" > ${join(dir, 'pi-args.txt')}\necho '{"alert": true, "reason": "ok"}'`);
    const { opts, result, candles: c } = fixture(dir, { settings: { provider: 'pi', piBin }, candleCount: 40 });
    await processSignal(opts, result, c);
    const args = readFileSync(join(dir, 'pi-args.txt'), 'utf8');
    assert.ok(!args.includes('OVERRIDE-RULES-MARKER'), 'no override active: builtin rules used');
    assert.ok(args.includes(FILTER_SCHEMA_SUFFIX.trim()), 'code-owned schema suffix always present');
    const row = withDb(opts.db, (d) => d.prepare('SELECT filter_prompt_version, filter_prompt_hash FROM signal_snapshots').get());
    assert.equal(row.filter_prompt_version, 'builtin');
    assert.equal(row.filter_prompt_hash, builtinHash, 'no override active: hash matches the builtin prompt actually used');
  }

  // With an active override: its rules text feeds the filter (ending with the
  // code-owned schema suffix, never overridable), and its version is recorded.
  {
    const dir = mkdtempSync(join(tmpdir(), 'st-'));
    const dbPath = join(dir, 'db.sqlite');
    const draft = saveGatePrompt(dbPath, { gate: 'filter', prompt: OVERRIDE_RULES });
    activateGatePrompt(dbPath, draft.id);
    const piBin = fakeBin(dir, 'pi', `echo "$@" > ${join(dir, 'pi-args.txt')}\necho '{"alert": true, "reason": "ok"}'`);
    const { opts, result, candles: c } = fixture(dir, { settings: { provider: 'pi', piBin }, candleCount: 40 });
    await processSignal(opts, result, c);
    const args = readFileSync(join(dir, 'pi-args.txt'), 'utf8');
    const rulesAt = args.indexOf(OVERRIDE_RULES);
    const schemaAt = args.indexOf(FILTER_SCHEMA_SUFFIX.trim());
    assert.ok(rulesAt >= 0, 'override rules text used as the system prompt');
    assert.ok(schemaAt > rulesAt, 'code-owned schema suffix appended AFTER the override text');
    const row = withDb(opts.db, (d) => d.prepare('SELECT filter_prompt_version, filter_prompt_hash FROM signal_snapshots').get());
    assert.equal(row.filter_prompt_version, String(draft.version));
    assert.notEqual(row.filter_prompt_hash, builtinHash, 'override active: recorded hash differs from the builtin prompt hash');
    assert.equal(row.filter_prompt_hash, promptHash(OVERRIDE_RULES + FILTER_SCHEMA_SUFFIX), 'recorded hash matches the effective (override) prompt text actually used');
  }
});

// --- recheckSignal (#70): dedicated re-check gate, never mutates recorded verdicts ---
test('recheckSignal (#70): fake pi persists a NEW signal_rechecks row and returns it; the original signal + its snapshot are byte-identical after', async () => {
  const { recheckSignal, signalOutcomes: outcomes } = await import('../scripts/supertrend.mjs');
  const { recordSnapshot, promptHash } = await import('../scripts/axis-snapshot.mjs');
  const { latestRecheck } = await import('../scripts/signal-rechecks.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const dbPath = join(dir, 'db.sqlite');
  const settingsPath = join(dir, 'settings.json');
  const piBin = fakeBin(dir, 'pi', `echo "$@" > ${join(dir, 'pi-args.txt')}\necho '{"verdict": "played-out", "reason": "already ran 3x the typical range"}'`);
  writeFileSync(settingsPath, JSON.stringify({ provider: 'pi', piBin }));

  storeCandles(dbPath, 'WTICO/USD', 'M5', candles);
  const sig = candles[30];
  recordSignal(dbPath, 'WTICO/USD', 'M5', { time: sig.time, signal: 'buy', price: sig.close }, 60);
  const snapshot = {
    schema_version: 1, at: sig.time, instrument: 'WTICO/USD', granularity: 'M5', flip: 'buy',
    axes: { trendStrength: { adx: 30, verdict: 'trending' }, direction: { verdict: 'aligned' }, impulse: { verdict: 'impulsive' }, location: { verdict: 'aligned' }, exhaustion: { verdict: 'clear' } },
  };
  recordSnapshot(dbPath, snapshot, { filterVerdict: 'alert', filterModel: 'test', filterPromptHash: promptHash('x'), filterPromptVersion: 'builtin' });

  const beforeSignal = withDb(dbPath, (d) => d.prepare('SELECT * FROM signals').all());
  const beforeSnap = withDb(dbPath, (d) => d.prepare('SELECT * FROM signal_snapshots').all());

  const [signalRow] = outcomes(dbPath, 'WTICO/USD', 'M5', { time: sig.time });
  const result = await recheckSignal(dbPath, settingsPath, 'WTICO/USD', 'M5', signalRow);
  assert.equal(result.verdict, 'played-out');
  assert.equal(result.reason, 'already ran 3x the typical range');
  assert.equal(result.promptVersion, 'builtin');
  assert.match(result.at, /^\d{4}-\d{2}-\d{2}T/, 'at is an ISO timestamp');

  const persisted = latestRecheck(dbPath, 'WTICO/USD', 'M5', sig.time);
  assert.equal(persisted.verdict, 'played-out');
  assert.equal(persisted.reason, 'already ran 3x the typical range');
  assert.equal(persisted.signal_time, sig.time);
  assert.equal(persisted.prompt_version, 'builtin');

  // the payload sent to the LLM carries the axis snapshot and an excursion, not just the flip
  const args = readFileSync(join(dir, 'pi-args.txt'), 'utf8');
  assert.match(args, /axisSnapshotAtFlip/);
  assert.match(args, /trendStrength/, 'the recorded axis snapshot rides in the payload');
  assert.match(args, /excursion/);
  assert.match(args, /priceSince/);

  // non-destructive guarantee: the ORIGINAL signal row and its snapshot are untouched
  const afterSignal = withDb(dbPath, (d) => d.prepare('SELECT * FROM signals').all());
  const afterSnap = withDb(dbPath, (d) => d.prepare('SELECT * FROM signal_snapshots').all());
  assert.deepEqual(afterSignal, beforeSignal, 'the signals table is byte-identical after a re-check');
  assert.deepEqual(afterSnap, beforeSnap, 'the signal_snapshots table is byte-identical after a re-check');
});

test('recheckSignal (#70): an active recheck gate-prompt override feeds the recheck system text; the code-owned schema suffix always follows it; promptVersion recorded', async () => {
  const { saveGatePrompt, activateGatePrompt } = await import('../scripts/gate-prompts.mjs');
  const { recheckSignal, RECHECK_SCHEMA_SUFFIX, signalOutcomes: outcomes } = await import('../scripts/supertrend.mjs');
  const OVERRIDE_RULES = 'RECHECK-OVERRIDE-MARKER: weigh realized excursion above everything else.';

  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const dbPath = join(dir, 'db.sqlite');
  const settingsPath = join(dir, 'settings.json');
  const draft = saveGatePrompt(dbPath, { gate: 'recheck', prompt: OVERRIDE_RULES });
  activateGatePrompt(dbPath, draft.id);
  const piBin = fakeBin(dir, 'pi', `echo "$@" > ${join(dir, 'pi-args.txt')}\necho '{"verdict": "valid", "reason": "still tracking"}'`);
  writeFileSync(settingsPath, JSON.stringify({ provider: 'pi', piBin }));

  storeCandles(dbPath, 'WTICO/USD', 'M5', candles);
  const sig = candles[30];
  recordSignal(dbPath, 'WTICO/USD', 'M5', { time: sig.time, signal: 'buy', price: sig.close }, 60);
  const [signalRow] = outcomes(dbPath, 'WTICO/USD', 'M5', { time: sig.time });

  const result = await recheckSignal(dbPath, settingsPath, 'WTICO/USD', 'M5', signalRow);
  assert.equal(result.promptVersion, String(draft.version), 'promptVersion is a string, consistent with /api/chart');

  const args = readFileSync(join(dir, 'pi-args.txt'), 'utf8');
  const rulesAt = args.indexOf(OVERRIDE_RULES);
  const schemaAt = args.indexOf(RECHECK_SCHEMA_SUFFIX.trim());
  assert.ok(rulesAt >= 0, 'override rules text used as the system prompt');
  assert.ok(schemaAt > rulesAt, 'code-owned JSON schema suffix appended AFTER the override text — never overridable');
});

test('resolveRecheckSystem falls back to the builtin prompt when gate-prompt resolution throws (fail-open, #70)', async () => {
  const { resolveRecheckSystem, RECHECK_RULES, RECHECK_SCHEMA_SUFFIX } = await import('../scripts/supertrend.mjs');
  const r = await resolveRecheckSystem('/nonexistent-dir/nope/db.sqlite');
  assert.equal(r.promptVersion, 'builtin');
  assert.equal(r.system, RECHECK_RULES + RECHECK_SCHEMA_SUFFIX, 'fallback is byte-identical to the shipped constant');
});

test('recheckSignal (#70): a verdict with a missing/non-string reason is rejected, never persisted as null/undefined', async () => {
  const { recheckSignal, signalOutcomes: outcomes } = await import('../scripts/supertrend.mjs');
  const { latestRecheck } = await import('../scripts/signal-rechecks.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const dbPath = join(dir, 'db.sqlite');
  const settingsPath = join(dir, 'settings.json');
  // valid verdict, but reason is missing entirely — the provider-schema mode
  // constrains type shape, not content, so this can come back from a real LLM.
  const piBin = fakeBin(dir, 'pi', `echo '{"verdict": "valid"}'`);
  writeFileSync(settingsPath, JSON.stringify({ provider: 'pi', piBin }));

  storeCandles(dbPath, 'WTICO/USD', 'M5', candles);
  const sig = candles[30];
  recordSignal(dbPath, 'WTICO/USD', 'M5', { time: sig.time, signal: 'buy', price: sig.close }, 60);
  const [signalRow] = outcomes(dbPath, 'WTICO/USD', 'M5', { time: sig.time });

  await assert.rejects(() => recheckSignal(dbPath, settingsPath, 'WTICO/USD', 'M5', signalRow), /invalid recheck verdict/);
  assert.equal(latestRecheck(dbPath, 'WTICO/USD', 'M5', sig.time), null, 'a rejected verdict is never persisted');
});

test('recheckSignal (#70): a verdict with a non-string reason is rejected the same way', async () => {
  const { recheckSignal, signalOutcomes: outcomes } = await import('../scripts/supertrend.mjs');
  const { latestRecheck } = await import('../scripts/signal-rechecks.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const dbPath = join(dir, 'db.sqlite');
  const settingsPath = join(dir, 'settings.json');
  const piBin = fakeBin(dir, 'pi', `echo '{"verdict": "valid", "reason": null}'`);
  writeFileSync(settingsPath, JSON.stringify({ provider: 'pi', piBin }));

  storeCandles(dbPath, 'WTICO/USD', 'M5', candles);
  const sig = candles[30];
  recordSignal(dbPath, 'WTICO/USD', 'M5', { time: sig.time, signal: 'buy', price: sig.close }, 60);
  const [signalRow] = outcomes(dbPath, 'WTICO/USD', 'M5', { time: sig.time });

  await assert.rejects(() => recheckSignal(dbPath, settingsPath, 'WTICO/USD', 'M5', signalRow), /invalid recheck verdict/);
  assert.equal(latestRecheck(dbPath, 'WTICO/USD', 'M5', sig.time), null, 'a rejected verdict is never persisted');
});

test('recheckSignal (#70): a long reason is capped to the schema-advertised 90 chars, never stored raw', async () => {
  const { recheckSignal } = await import('../scripts/supertrend.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const dbPath = join(dir, 'db.sqlite');
  const settingsPath = join(dir, 'settings.json');
  const longReason = 'x'.repeat(300);
  const piBin = fakeBin(dir, 'pi', `echo '{"verdict": "valid", "reason": "${longReason}"}'`);
  writeFileSync(settingsPath, JSON.stringify({ provider: 'pi', piBin }));

  storeCandles(dbPath, 'WTICO/USD', 'M5', candles);
  const sig = candles[30];
  recordSignal(dbPath, 'WTICO/USD', 'M5', { time: sig.time, signal: 'buy', price: sig.close }, 60);
  const { signalOutcomes: outcomes } = await import('../scripts/supertrend.mjs');
  const [signalRow] = outcomes(dbPath, 'WTICO/USD', 'M5', { time: sig.time });

  const result = await recheckSignal(dbPath, settingsPath, 'WTICO/USD', 'M5', signalRow);
  assert.equal(result.reason.length, 90, 'reason capped to the schema-advertised max');
});

test('recheckSignal (#70) throws when no LLM provider is configured — caller (the HTTP route) turns this into a visible error, never a crash', async () => {
  const { recheckSignal, signalOutcomes: outcomes } = await import('../scripts/supertrend.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const dbPath = join(dir, 'db.sqlite');
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ provider: 'none' }));
  storeCandles(dbPath, 'WTICO/USD', 'M5', candles);
  const sig = candles[30];
  recordSignal(dbPath, 'WTICO/USD', 'M5', { time: sig.time, signal: 'buy', price: sig.close }, 60);
  const [signalRow] = outcomes(dbPath, 'WTICO/USD', 'M5', { time: sig.time });
  await assert.rejects(() => recheckSignal(dbPath, settingsPath, 'WTICO/USD', 'M5', signalRow), /no LLM provider configured/);
});

test('parseWatchers: CSV combos with default granularity, falls back to single', async () => {
  const { parseWatchers } = await import('../scripts/supertrend.mjs');
  assert.deepEqual(parseWatchers({ watchers: 'WTICO/USD|M5, XAU/USD|M15, BCO/USD' }, { instrument: 'X', granularity: 'M5' }), [
    { instrument: 'WTICO/USD', granularity: 'M5' },
    { instrument: 'XAU/USD', granularity: 'M15' },
    { instrument: 'BCO/USD', granularity: 'M5' },
  ]);
  assert.deepEqual(parseWatchers({}, { instrument: 'WTICO/USD', granularity: 'M5' }), [{ instrument: 'WTICO/USD', granularity: 'M5' }]);
});

test('openaiEndpoint + explicit provider resolution (#42/#99 split)', async () => {
  const { openaiEndpoint, resolveProvider } = await import('../scripts/supertrend.mjs');
  // official openai ALWAYS hits api.openai.com and IGNORES any base URL (#99)
  assert.equal(openaiEndpoint({}, 'openai'), 'https://api.openai.com/v1/chat/completions', 'official openai → api.openai.com');
  assert.equal(openaiEndpoint({ OPENAI_BASE_URL: 'http://ignored/' }, 'openai'), 'https://api.openai.com/v1/chat/completions', 'official ignores a stored base URL');
  // openai-compatible REQUIRES a base URL and points there (normalization preserved)
  assert.equal(openaiEndpoint({ OPENAI_BASE_URL: 'http://localhost:8080/' }, 'openai-compatible'), 'http://localhost:8080/v1/chat/completions', 'trailing slash normalized');
  assert.equal(openaiEndpoint({ OPENAI_BASE_URL: 'http://localhost:8080/v1' }, 'openai-compatible'), 'http://localhost:8080/v1/chat/completions', 'base URLs already ending in /v1 do not double the segment');
  assert.throws(() => openaiEndpoint({}, 'openai-compatible'), /requires OPENAI_BASE_URL/, 'compatible with no base URL → clear error');
  // #99 backward-compat migration: a stored openai WITH a base URL is the pre-split
  // GLM-via-Makora config → resolves as openai-compatible so live routing survives.
  assert.equal(resolveProvider({ provider: 'openai', OPENAI_BASE_URL: 'http://makora/' }), 'openai-compatible', 'openai+base-url migrates to compatible');
  assert.equal(resolveProvider({ provider: 'openai' }), 'openai', 'official openai (no base url) stays openai');
  assert.equal(openaiEndpoint({ provider: 'openai', OPENAI_BASE_URL: 'http://makora/' }), 'http://makora/v1/chat/completions', 'migrated config still points at its base URL (default provider arg resolves)');
  assert.equal(resolveProvider({ provider: 'openai', ANTHROPIC_API_KEY: 'x' }), 'openai', 'explicit choice beats key-derived resolution');
  assert.equal(resolveProvider({ provider: 'anthropic' }), 'anthropic');
  assert.equal(resolveProvider({ ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y' }), 'anthropic', 'legacy empty provider keeps key-derived behavior');
  // #99: a legacy config (NO explicit provider) with a base URL is a pre-#42
  // OpenAI-compatible setup — must resolve to openai-compatible so its base URL is
  // honored, not routed to api.openai.com.
  assert.equal(resolveProvider({ OPENAI_API_KEY: 'y', OPENAI_BASE_URL: 'http://makora/' }), 'openai-compatible', 'legacy base-url config → openai-compatible');
  assert.equal(resolveProvider({ OPENAI_API_KEY: 'y' }), 'openai', 'legacy key-only config → official openai');
  assert.equal(openaiEndpoint({ OPENAI_API_KEY: 'y', OPENAI_BASE_URL: 'http://makora/' }), 'http://makora/v1/chat/completions', 'legacy compatible config still hits its base URL');
  assert.equal(resolveProvider({}), 'none');
});

test('effectiveModel: per-provider binding, active-only flat fallback, no cross-provider bleed (#99)', async () => {
  const { effectiveModel } = await import('../scripts/supertrend.mjs');
  // bound model wins
  assert.equal(effectiveModel({ provider: 'anthropic', models: { anthropic: 'claude-x' } }, 'anthropic'), 'claude-x');
  // provider default when nothing bound and no flat model
  assert.equal(effectiveModel({ provider: 'anthropic' }, 'anthropic'), 'claude-opus-4-8');
  assert.equal(effectiveModel({ provider: 'openai' }, 'openai'), 'gpt-5.4-mini');
  // openai-compatible has NO default → null when unset
  assert.equal(effectiveModel({ provider: 'openai-compatible', OPENAI_BASE_URL: 'http://x' }, 'openai-compatible'), null);
  assert.equal(effectiveModel({ provider: 'openai-compatible', OPENAI_BASE_URL: 'http://x', models: { 'openai-compatible': 'GLM-5' } }, 'openai-compatible'), 'GLM-5');
  // flat model is ONLY the ACTIVE provider's fallback — the #99 footgun: a GLM slug
  // left in flat `model` while active provider is anthropic must NOT reach anthropic.
  const stale = { provider: 'anthropic', model: 'zai-org/GLM-5' };
  assert.equal(effectiveModel(stale, 'anthropic'), 'zai-org/GLM-5', 'active provider still honors flat model');
  assert.equal(effectiveModel(stale, 'openai'), 'gpt-5.4-mini', 'non-active provider ignores the stale flat model (gets its default)');
  // migrated openai+base-url: active provider is openai-compatible, so flat model
  // is its fallback (live GLM-via-Makora config keeps working with no models map).
  const migrated = { provider: 'openai', OPENAI_BASE_URL: 'http://makora', model: 'zai-org/GLM-5' };
  assert.equal(effectiveModel(migrated, 'openai-compatible'), 'zai-org/GLM-5', 'migrated config resolves its flat model under openai-compatible');
});

test('requireModel: fails fast for a no-default provider with no model, else returns it (#99 review)', async () => {
  const { requireModel } = await import('../scripts/supertrend.mjs');
  assert.throws(() => requireModel({ provider: 'openai-compatible', OPENAI_BASE_URL: 'http://x' }, 'openai-compatible'), /no model configured/, 'openai-compatible with no model → clear config error (not a null model in the request body)');
  assert.equal(requireModel({ provider: 'openai' }, 'openai'), 'gpt-5.4-mini', 'official openai always has a default');
  assert.equal(requireModel({ provider: 'openai-compatible', OPENAI_BASE_URL: 'http://x', models: { 'openai-compatible': 'GLM' } }, 'openai-compatible'), 'GLM');
});

test('explicit anthropic provider without ANTHROPIC_API_KEY fails fast (no x-api-key: undefined) (#42)', async () => {
  const { llmRequest } = await import('../scripts/supertrend.mjs');
  await assert.rejects(
    llmRequest({ provider: 'anthropic' }, 'sys', 'user'),
    /ANTHROPIC_API_KEY is not set/,
  );
});

// --- HTF cache grounding (issue #81): cache-only, staleness-gated, capped ---
import { trackedInstruments, refreshHtfCache } from '../scripts/supertrend.mjs';

test('trackedInstruments: union of watched combos + configured bot keys, including a disabled bot', () => {
  const combos = [{ instrument: 'WTICO/USD', granularity: 'M5' }];
  const cfg = { bot: { bots: { 'XAU/USD|M15': { enabled: false }, 'WTICO/USD|M5': { enabled: true } } } };
  assert.deepEqual(trackedInstruments(combos, cfg), ['WTICO/USD', 'XAU/USD'], 'disabled bot instrument still tracked');
});

function htfDb(dir) {
  const dbPath = join(dir, 'htf.sqlite');
  rmSync(dbPath, { force: true });
  return dbPath;
}

function seedBar(dbPath, instrument, granularity, time) {
  storeCandles(dbPath, instrument, granularity, [{ time, open: 1, high: 1.1, low: 0.9, close: 1, volume: 1, complete: true }]);
}

test('refreshHtfCache: fresh granularity skipped, stale one fetched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'htf-'));
  const dbPath = htfDb(dir);
  const now = Date.now();
  seedBar(dbPath, 'WTICO/USD', 'M15', new Date(now - 5 * 60000).toISOString()); // fresh (5min < 15*2)
  seedBar(dbPath, 'WTICO/USD', 'M30', new Date(now - 46 * 60000).toISOString()); // 46min: DUE at 1.5x (>45), FRESH at 2x (<60) — pins that 1.5x refetched early
  seedBar(dbPath, 'WTICO/USD', 'H1', new Date(now - 3 * 3600000).toISOString()); // stale (3h > 2h)
  // H4 has no cached bar at all -> also due.
  const calls = [];
  const fetcher = async ({ instrument, granularity }) => {
    calls.push(`${instrument}|${granularity}`);
    return [{ time: new Date(now).toISOString(), open: 1, high: 1.1, low: 0.9, close: 1, volume: 1, complete: true }];
  };
  const { refreshed, skipped } = await refreshHtfCache(dbPath, [{ instrument: 'WTICO/USD', granularity: 'M5' }], {}, { fetcher, now });
  assert.equal(skipped.length, 0);
  assert.ok(!calls.includes('WTICO/USD|M15'), 'fresh M15 was not fetched');
  assert.ok(!calls.includes('WTICO/USD|M30'), 'M30 at 45min (1.5x boundary) is fresh at 2x — not refetched before its next bar completes');
  assert.ok(calls.includes('WTICO/USD|H1'), 'stale H1 was fetched');
  assert.ok(calls.includes('WTICO/USD|H4'), 'uncached H4 was fetched');
  assert.deepEqual(refreshed.map((c) => `${c.instrument}|${c.granularity}`).sort(), calls.sort());
});

test('refreshHtfCache: per-tick cap truncates fan-out and logs what was skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'htf-'));
  const dbPath = htfDb(dir);
  const now = Date.now();
  // Two instruments, all 4 ladder rungs uncached each -> 8 due combos, capped to 3.
  const combos = [{ instrument: 'WTICO/USD', granularity: 'M5' }, { instrument: 'XAU/USD', granularity: 'M5' }];
  let calls = 0;
  const fetcher = async () => { calls++; return []; };
  const logs = [];
  const result = await refreshHtfCache(dbPath, combos, {}, { fetcher, now, cap: 3, log: (m) => logs.push(m) });
  assert.equal(calls, 3, 'only the capped number of fetches ran');
  assert.equal(result.refreshed.length, 3);
  assert.equal(result.skipped.length, 5);
  assert.ok(logs.some((m) => /per-tick cap \(3\) reached, skipped/.test(m)), 'truncation is logged');
});

test('refreshHtfCache: an unparseable cached timestamp is treated as stale (self-heals)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'htf-'));
  const dbPath = htfDb(dir);
  const now = Date.now();
  seedBar(dbPath, 'WTICO/USD', 'H1', 'not-a-date'); // malformed → must not freeze the rung
  const calls = [];
  const fetcher = async ({ instrument, granularity }) => {
    calls.push(`${instrument}|${granularity}`);
    return [{ time: new Date(now).toISOString(), open: 1, high: 1, low: 1, close: 1, volume: 1, complete: true }];
  };
  await refreshHtfCache(dbPath, [{ instrument: 'WTICO/USD', granularity: 'M5' }], {}, { fetcher, now });
  assert.ok(calls.includes('WTICO/USD|H1'), 'a bad timestamp is refetched, not skipped forever');
});

test('refreshHtfCache: a throwing fetch for one combo does not prevent the others', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'htf-'));
  const dbPath = htfDb(dir);
  const now = Date.now();
  const combos = [{ instrument: 'WTICO/USD', granularity: 'M5' }];
  const fetcher = async ({ granularity }) => {
    if (granularity === 'H1') throw new Error('upstream down');
    return [{ time: new Date(now).toISOString(), open: 1, high: 1.1, low: 0.9, close: 1, volume: 1, complete: true }];
  };
  const { refreshed } = await refreshHtfCache(dbPath, combos, {}, { fetcher, now });
  assert.ok(!refreshed.some((c) => c.granularity === 'H1'), 'the failing combo is absent from refreshed');
  assert.ok(refreshed.some((c) => c.granularity === 'M15'), 'other combos still refreshed despite the throw');
  assert.ok(refreshed.some((c) => c.granularity === 'H4'), 'the tick did not abort after the throw');
});

// --- bot deliberation context (issue #86): sentinel present only when the news cache has rows ---
test('buildBotContext: sentinel omitted when the news cache is empty for the instrument, present when it has recent rows', async () => {
  const { buildBotContext } = await import('../scripts/supertrend.mjs');
  const { upsertNews } = await import('../scripts/news.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'bot-ctx-'));
  const dbPath = join(dir, 'db.sqlite');

  const empty = await buildBotContext(dbPath, 'WTICO/USD', { supertrend: 1, trend: 'up', backtest: {}, axisGate: null });
  assert.equal(empty.sentinel, undefined, 'empty cache: sentinel key entirely absent');
  assert.ok(!('sentinel' in JSON.parse(JSON.stringify(empty))), 'JSON-serialized ctx drops the key, not just nulls it');

  upsertNews(dbPath, 'WTICO/USD', [
    { source: 'oilprice', title: 'Tanker attack near Hormuz', timeIso: new Date().toISOString(), url: 'https://x/86-bot', escalation: true },
  ], new Date().toISOString());
  const withNews = await buildBotContext(dbPath, 'WTICO/USD', { supertrend: 1, trend: 'up', backtest: {}, axisGate: null });
  assert.equal(withNews.sentinel.escalation, true);
  assert.equal(withNews.sentinel.headlines[0].title, 'Tanker attack near Hormuz');

  // A different instrument's cache never leaks into this one's context.
  const otherInstrument = await buildBotContext(dbPath, 'XAU/USD', { supertrend: 1, trend: 'up', backtest: {}, axisGate: null });
  assert.equal(otherInstrument.sentinel, undefined);
});

test('DECISION_SYSTEM (bot.mjs) frames the sentinel block as advisory, same as traderMemories', async () => {
  const { DECISION_SYSTEM } = await import('../scripts/bot.mjs');
  assert.match(DECISION_SYSTEM, /sentinel block.*advisory/i);
});

test('refreshHtfCache: writes candles only — no signal rows, no notifications', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'htf-'));
  const dbPath = htfDb(dir);
  const now = Date.now();
  const combos = [{ instrument: 'WTICO/USD', granularity: 'M5' }];
  // A flip-shaped series so a naive signal path WOULD detect a flip if one ran.
  const flipCandles = candles.map((c) => ({ ...c }));
  const fetcher = async () => flipCandles;
  await refreshHtfCache(dbPath, combos, {}, { fetcher, now });
  const [storedCount, signalCount] = withDb(dbPath, (db) => [
    db.prepare('SELECT COUNT(*) AS n FROM candles').get().n,
    db.prepare('SELECT COUNT(*) AS n FROM signals').get().n,
  ]);
  assert.ok(Number(storedCount) > 0, 'HTF fetches did upsert candles');
  assert.equal(Number(signalCount), 0, 'no signal rows result from HTF refreshes');
});

test('OPENAI_BASE_URL drives the request URL and the model passes through unchanged (#42)', async () => {
  const { llmRequest } = await import('../scripts/supertrend.mjs');
  const { createServer } = await import('node:http');
  const hits = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ url: req.url, model: JSON.parse(body).model });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok-from-compatible' } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const out = await llmRequest({ provider: 'openai', OPENAI_API_KEY: 'k', OPENAI_BASE_URL: base, model: 'llama-3.3-70b-local' }, 'sys', 'user', { timeoutMs: 10000 });
    assert.equal(out, 'ok-from-compatible');
    assert.equal(hits[0].url, '/v1/chat/completions', 'compatible endpoint hit');
    assert.equal(hits[0].model, 'llama-3.3-70b-local', 'non-OpenAI model id passes through unchanged');
    await assert.rejects(
      () => llmRequest({ provider: 'openai', OPENAI_BASE_URL: base, model: 'x' }, 'sys', 'user', { timeoutMs: 5000 }),
      /OPENAI_API_KEY is not set/, 'missing key fails fast with a clear message');
  } finally { await new Promise((r) => srv.close(r)); }
});


// --- llmRequest onUsage (#93): additive usage/provider/model capture, return type unchanged ---

test('llmRequest onUsage: fake anthropic body reports provider/model/tokens', async () => {
  const { llmRequest } = await import('../scripts/supertrend.mjs');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    content: [{ type: 'text', text: 'ok-anthropic' }],
    usage: { input_tokens: 120, output_tokens: 34 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    let captured = null;
    const out = await llmRequest({ provider: 'anthropic', ANTHROPIC_API_KEY: 'sk-secret-testkey', model: 'claude-test' }, 'sys', 'user', { onUsage: (info) => { captured = info; } });
    assert.equal(out, 'ok-anthropic', 'return type unchanged: still the plain text');
    assert.deepEqual(captured, { provider: 'anthropic', model: 'claude-test', usage: { inputTokens: 120, outputTokens: 34 } });
  } finally { globalThis.fetch = realFetch; }
});

test('llmRequest onUsage: fake openai-compatible body reports provider/model/tokens', async () => {
  const { llmRequest } = await import('../scripts/supertrend.mjs');
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok-openai' } }], usage: { prompt_tokens: 55, completion_tokens: 12 } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    let captured = null;
    const out = await llmRequest({ provider: 'openai', OPENAI_API_KEY: 'sk-secret-testkey', OPENAI_BASE_URL: base, model: 'gpt-test' }, 'sys', 'user', { onUsage: (info) => { captured = info; } });
    assert.equal(out, 'ok-openai');
    // #99: this config (openai + base URL) resolves to openai-compatible, and the
    // telemetry must report the RESOLVED provider, not a hardcoded 'openai'.
    assert.deepEqual(captured, { provider: 'openai-compatible', model: 'gpt-test', usage: { inputTokens: 55, outputTokens: 12 } });
  } finally { await new Promise((r) => srv.close(r)); }
});

test('llmRequest onUsage: pi path reports provider/model, usage null (never faked)', async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { llmRequest } = await import('../scripts/supertrend.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'pi-'));
  const piBin = join(dir, 'pi');
  writeFileSync(piBin, '#!/bin/sh\necho "pi reply"\n');
  chmodSync(piBin, 0o755);
  let captured = null;
  const out = await llmRequest({ provider: 'pi', piBin, model: 'pi-model' }, 'sys', 'user', { onUsage: (info) => { captured = info; } });
  assert.equal(out, 'pi reply');
  assert.deepEqual(captured, { provider: 'pi', model: 'pi-model', usage: null });
});

test('llmRequest onUsage: a throwing callback never breaks the request (missing/faulty usage must never throw)', async () => {
  const { llmRequest } = await import('../scripts/supertrend.mjs');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'still ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const out = await llmRequest({ provider: 'openai', OPENAI_API_KEY: 'k' }, 'sys', 'user', { onUsage: () => { throw new Error('boom'); } });
    assert.equal(out, 'still ok', 'a throwing onUsage callback must not break the actual response');
  } finally { globalThis.fetch = realFetch; }
});

// --- #98: reasoning-model null-content guard + reasoning-friendly budget ---

test('llmRequest (openai): default max_completion_tokens floors at OPENAI_REASONING_FLOOR (8192), honors settings.maxCompletionTokens', async () => {
  const { llmRequest, OPENAI_REASONING_FLOOR } = await import('../scripts/supertrend.mjs');
  const { createServer } = await import('node:http');
  assert.equal(OPENAI_REASONING_FLOOR, 8192);
  const bodies = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    // small call-site maxTokens (1024, the filter's actual budget): floors at 8192.
    await llmRequest({ provider: 'openai', OPENAI_API_KEY: 'k', OPENAI_BASE_URL: base, model: 'm' }, 'sys', 'user', { maxTokens: 1024, timeoutMs: 5000 });
    assert.equal(bodies[0].max_completion_tokens, 8192, 'floors up to the reasoning default, not the small call-site budget');

    // operator-configured maxCompletionTokens overrides the floor.
    await llmRequest({ provider: 'openai', OPENAI_API_KEY: 'k', OPENAI_BASE_URL: base, model: 'm', maxCompletionTokens: 16000 }, 'sys', 'user', { maxTokens: 1024, timeoutMs: 5000 });
    assert.equal(bodies[1].max_completion_tokens, 16000, 'settings.maxCompletionTokens overrides the built-in floor');

    // a call site asking for MORE than the floor is never clamped down.
    await llmRequest({ provider: 'openai', OPENAI_API_KEY: 'k', OPENAI_BASE_URL: base, model: 'm' }, 'sys', 'user', { maxTokens: 20000, timeoutMs: 5000 });
    assert.equal(bodies[2].max_completion_tokens, 20000, 'a larger call-site budget always wins over the floor');
  } finally { await new Promise((r) => srv.close(r)); }
});

test('llmRequest (openai): null content at finish_reason=length throws a descriptive error, never a TypeError (#98)', async () => {
  const { llmRequest } = await import('../scripts/supertrend.mjs');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'length', message: { content: null } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(
      () => llmRequest({ provider: 'openai', OPENAI_API_KEY: 'k' }, 'sys', 'user', { maxTokens: 1024 }),
      (err) => {
        assert.match(err.message, /no content/);
        assert.match(err.message, /finish_reason=length/);
        assert.match(err.message, /max_completion_tokens=8192/);
        assert.match(err.message, /maxCompletionTokens/);
        return true;
      },
    );
  } finally { globalThis.fetch = realFetch; }
});

test('llmRequest (openai): empty-string content is treated the same as null', async () => {
  const { llmRequest } = await import('../scripts/supertrend.mjs');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'length', message: { content: '' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(() => llmRequest({ provider: 'openai', OPENAI_API_KEY: 'k' }, 'sys', 'user', {}), /no content/);
  } finally { globalThis.fetch = realFetch; }
});

test('llmRequest (anthropic): no text block throws a clear message, not a TypeError', async () => {
  const { llmRequest } = await import('../scripts/supertrend.mjs');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(
      () => llmRequest({ provider: 'anthropic', ANTHROPIC_API_KEY: 'k' }, 'sys', 'user', {}),
      /anthropic returned no text block \(stop_reason=max_tokens\)/,
    );
  } finally { globalThis.fetch = realFetch; }
});

test('llmChat tool-loop (openai): null content at finish_reason=length throws the same descriptive error (#98)', async () => {
  const { llmChat } = await import('../scripts/supertrend.mjs');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'length', message: { content: null } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(
      () => llmChat({ provider: 'openai', OPENAI_API_KEY: 'k' }, 'sys', 'user', {
        toolDefs: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
        execTool: async () => 'out',
      }),
      (err) => {
        assert.match(err.message, /no content/);
        assert.match(err.message, /finish_reason=length/);
        return true;
      },
    );
  } finally { globalThis.fetch = realFetch; }
});

test('processSignal (#98): a reasoning-model null-content openai filter fails OPEN with a readable reason, not "reading \'match\'"', async () => {
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: null } }] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'st-'));
    const { opts, result, candles: c } = fixture(dir, { settings: { provider: 'openai', OPENAI_API_KEY: 'k', OPENAI_BASE_URL: base, model: 'm' } });
    const res = await processSignal(opts, result, c);
    assert.equal(res.sent, true, 'fails open: the alert is still recorded');
    assert.equal(res.verdictSource, 'error');
    const [row] = signalOutcomes(opts.db, 'WTICO/USD', 'M5');
    assert.equal(row.verdict, 'alert');
    assert.match(row.reason, /filter error/);
    assert.match(row.reason, /no content/, 'the readable llmRequest message, not a generic crash');
    assert.doesNotMatch(row.reason, /reading 'match'/, 'never the cryptic null.match TypeError text');
  } finally { await new Promise((r) => srv.close(r)); }
});

test('processSignal (#164): non-pi filter llmRequest uses a 90s timeout, not 30s (Makora/GLM generations routinely exceed 30s)', async () => {
  const realTimeout = AbortSignal.timeout;
  const seen = [];
  AbortSignal.timeout = (ms) => { seen.push(ms); return realTimeout(ms); };
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '{"alert":true,"reason":"ok"}' } }] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    AbortSignal.timeout = (ms) => { seen.push(ms); return realTimeout(ms); };
    const dir = mkdtempSync(join(tmpdir(), 'st-'));
    const { opts, result, candles: c } = fixture(dir, { settings: { provider: 'openai', OPENAI_API_KEY: 'k', OPENAI_BASE_URL: base, model: 'm' } });
    await processSignal(opts, result, c);
    assert.ok(seen.length > 0, 'the filter call went through fetch/AbortSignal.timeout');
    assert.ok(seen.every((ms) => ms === 90000), `expected every AbortSignal.timeout during this processSignal run to be 90000, saw ${seen}`);
  } finally {
    AbortSignal.timeout = realTimeout;
    await new Promise((r) => srv.close(r));
  }
});

test('recheckSignal (#164): non-pi recheck llmRequest also uses the 90s timeout', async () => {
  const realTimeout = AbortSignal.timeout;
  const seen = [];
  AbortSignal.timeout = (ms) => { seen.push(ms); return realTimeout(ms); };
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '{"assessment":"played out","reason":"ok"}' } }] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    AbortSignal.timeout = (ms) => { seen.push(ms); return realTimeout(ms); };
    const dir = mkdtempSync(join(tmpdir(), 'st-'));
    const { opts, result, candles: c } = fixture(dir, { notify: false, settings: { provider: 'openai', OPENAI_API_KEY: 'k', OPENAI_BASE_URL: base, model: 'm' } });
    await processSignal(opts, result, c); // seeds the signal row + candles
    seen.length = 0;
    const { recheckSignal } = await import('../scripts/supertrend.mjs');
    await recheckSignal(opts.db, opts.settings, opts.instrument, opts.granularity, result.signal).catch(() => {});
    assert.ok(seen.length > 0, 'the recheck call went through fetch/AbortSignal.timeout');
    assert.ok(seen.every((ms) => ms === 90000), `expected every AbortSignal.timeout during this recheckSignal run to be 90000, saw ${seen}`);
  } finally {
    AbortSignal.timeout = realTimeout;
    await new Promise((r) => srv.close(r));
  }
});

// --- Verdict-path token budget + fallback provider (filter + recheck ONLY,
// never the bot's tool loop) ---
// Primary is openai-compatible ('http://primary.test'), fallback is anthropic
// (a fixed https://api.anthropic.com/... URL) — two different endpoints let
// one fetch stub route by URL and prove the fallback used its OWN key/model
// (AC5), never the primary's, without spinning up a real HTTP server.
function fallbackFilterSettings(overrides = {}) {
  return {
    provider: 'openai-compatible',
    OPENAI_API_KEY: 'primary-key',
    OPENAI_BASE_URL: 'http://primary.test',
    model: 'primary-model',
    llmFallbackProvider: 'anthropic',
    ANTHROPIC_API_KEY: 'fallback-key',
    models: { anthropic: 'fallback-model' },
    ...overrides,
  };
}
const anthropicVerdictOk = (alert, reason) => new Response(
  JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ alert, reason }) }] }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);
// One fetch stub shared by the four AC4 failure-kind tests below: only the
// primary's response/rejection varies per test; the fallback always succeeds.
function stubPrimaryThenFallback(primaryBehavior) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), auth: opts.headers.authorization ?? opts.headers['x-api-key'], body: JSON.parse(opts.body) });
    if (String(url).includes('primary.test')) return primaryBehavior();
    return anthropicVerdictOk(true, 'fallback caught it');
  };
  return calls;
}

test('llmVerdict fallback (AC4/AC5/AC8): a primary TRANSPORT ERROR triggers exactly one fallback attempt, using its own key/model', async () => {
  const { llmVerdict } = await import('../scripts/supertrend.mjs');
  const realFetch = globalThis.fetch;
  const calls = stubPrimaryThenFallback(() => { throw new Error('fetch failed: ECONNREFUSED'); });
  try {
    const verdict = await llmVerdict(fallbackFilterSettings(), { some: 'payload' }, 'system', null);
    assert.equal(calls.length, 2, 'exactly one fallback attempt after the primary failed');
    assert.equal(calls[0].url, 'http://primary.test/v1/chat/completions');
    assert.equal(calls[1].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(calls[1].auth, 'fallback-key', "the fallback call carries ITS OWN key, never the primary's OPENAI_API_KEY");
    assert.equal(calls[1].body.model, 'fallback-model', "the fallback call carries ITS OWN model, never the primary's");
    assert.equal(verdict.alert, true);
    assert.match(verdict.reason, /fallback caught it/);
    assert.match(verdict.reason, /\[fallback: anthropic]/, 'the recorded reason names the producing provider');
  } finally { globalThis.fetch = realFetch; }
});

test('llmVerdict fallback (AC4): a primary TIMEOUT triggers exactly one fallback attempt', async () => {
  const { llmVerdict } = await import('../scripts/supertrend.mjs');
  const realFetch = globalThis.fetch;
  const calls = stubPrimaryThenFallback(() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
  try {
    const verdict = await llmVerdict(fallbackFilterSettings(), { some: 'payload' }, 'system', null);
    assert.equal(calls.length, 2, 'exactly one fallback attempt after the primary timed out');
    assert.equal(verdict.alert, true);
    assert.match(verdict.reason, /\[fallback: anthropic]/);
  } finally { globalThis.fetch = realFetch; }
});

test('llmVerdict fallback (AC4): a primary EMPTY-CONTENT reply (reasoning budget exhausted) triggers exactly one fallback attempt', async () => {
  const { llmVerdict } = await import('../scripts/supertrend.mjs');
  const realFetch = globalThis.fetch;
  const calls = stubPrimaryThenFallback(() => new Response(
    JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: null } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  try {
    const verdict = await llmVerdict(fallbackFilterSettings(), { some: 'payload' }, 'system', null);
    assert.equal(calls.length, 2, 'exactly one fallback attempt after the primary returned empty content');
    assert.equal(verdict.alert, true);
    assert.match(verdict.reason, /\[fallback: anthropic]/);
  } finally { globalThis.fetch = realFetch; }
});

test('llmVerdict fallback (AC4): an UNPARSEABLE verdict — thrown by llmVerdict AFTER llmRequest already returned successfully — triggers exactly one fallback attempt (the largest measured failure bucket)', async () => {
  const { llmVerdict } = await import('../scripts/supertrend.mjs');
  const realFetch = globalThis.fetch;
  const calls = stubPrimaryThenFallback(() => new Response(
    JSON.stringify({ choices: [{ message: { content: 'sure — here is some prose with no JSON at all' } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  try {
    const verdict = await llmVerdict(fallbackFilterSettings(), { some: 'payload' }, 'system', null);
    assert.equal(calls.length, 2, 'the fallback still fires even though the primary transport call itself succeeded');
    assert.equal(verdict.alert, true);
    assert.match(verdict.reason, /\[fallback: anthropic]/);
  } finally { globalThis.fetch = realFetch; }
});

test('llmVerdict fallback (AC6): a primary that consumes the ENTIRE shared deadline skips the fallback rather than starting it', async () => {
  const { llmVerdict } = await import('../scripts/supertrend.mjs');
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let call = 0;
  // 1st Date.now() call anchors the shared deadline; the 2nd (evaluated right
  // after the primary rejects) simulates the primary having consumed the
  // full 90s budget on its own — nothing should remain for the fallback.
  Date.now = () => (call++ === 0 ? 1_000_000 : 1_000_000 + 90_000);
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('primary down'); };
  try {
    await assert.rejects(() => llmVerdict(fallbackFilterSettings(), { some: 'payload' }, 'system', null), /primary down$/);
    assert.equal(calls.length, 1, 'the fallback was never started once the shared deadline was exhausted');
  } finally { Date.now = realNow; globalThis.fetch = realFetch; }
});

test('llmVerdict fallback (AC9): unset llmFallbackProvider makes exactly one attempt — byte-identical to no fallback existing (AC1)', async () => {
  const { llmVerdict } = await import('../scripts/supertrend.mjs');
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('primary down'); };
  try {
    await assert.rejects(
      () => llmVerdict({ provider: 'openai', OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'http://primary.test', model: 'm' }, { some: 'payload' }, 'system', null),
      (err) => { assert.equal(err.message, 'primary down', 'unwrapped — no "both providers failed" framing when no fallback was ever configured'); return true; },
    );
    assert.equal(calls.length, 1, 'exactly one attempt, no fallback');
  } finally { globalThis.fetch = realFetch; }
});

test('llmVerdict fallback: a fallback equal to the resolved primary is not a fallback — treated as unset, one attempt only', async () => {
  const { llmVerdict } = await import('../scripts/supertrend.mjs');
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('primary down'); };
  try {
    await assert.rejects(
      // provider 'openai' + a base URL migrates to the resolved primary
      // 'openai-compatible' (#99) — naming that same string as the fallback
      // must resolve to no fallback, not a same-provider retry.
      () => llmVerdict({ provider: 'openai', OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'http://primary.test', model: 'm', llmFallbackProvider: 'openai-compatible' }, { some: 'payload' }, 'system', null),
      /primary down$/,
    );
    assert.equal(calls.length, 1, 'fallback === primary resolves to no fallback');
  } finally { globalThis.fetch = realFetch; }
});

test('processSignal fallback (AC7/AC8): both primary AND fallback failing still fails OPEN, and the recorded reason names both providers', async () => {
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => { res.statusCode = 500; res.end('boom'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const primaryBase = `http://127.0.0.1:${srv.address().port}`;
  const realFetch = globalThis.fetch;
  // the primary is a real (failing) HTTP server; only the fallback's fixed
  // anthropic URL is stubbed to also fail, so both channels are exercised.
  globalThis.fetch = (url, opts) => (String(url).includes('anthropic.com')
    ? Promise.reject(new Error('fallback down'))
    : realFetch(url, opts));
  try {
    const dir = mkdtempSync(join(tmpdir(), 'st-'));
    const { opts, result, candles: c } = fixture(dir, {
      settings: { provider: 'openai', OPENAI_API_KEY: 'k', OPENAI_BASE_URL: primaryBase, model: 'm', llmFallbackProvider: 'anthropic', ANTHROPIC_API_KEY: 'fk', models: { anthropic: 'fm' } },
    });
    const res = await processSignal(opts, result, c);
    assert.equal(res.sent, true, 'fails open: the alert is still sent even though BOTH providers failed');
    assert.equal(res.verdictSource, 'error');
    const [row] = signalOutcomes(opts.db, 'WTICO/USD', 'M5');
    assert.equal(row.verdict, 'alert');
    assert.match(row.reason, /filter error/);
    assert.match(row.reason, /openai-compatible/, 'names the primary provider');
    assert.match(row.reason, /anthropic/, "names the fallback provider too — the DB can answer 'both failed' by inspection");
  } finally { globalThis.fetch = realFetch; await new Promise((r) => srv.close(r)); }
});

test('recheckSignal: the recheck gate (not just the filter) also retries on the fallback provider', async () => {
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => { res.statusCode = 500; res.end('down'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => (String(url).includes('anthropic.com')
    ? Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'text', text: '{"verdict":"valid","reason":"still tracking"}' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    : realFetch(url, opts));
  try {
    const dir = mkdtempSync(join(tmpdir(), 'st-'));
    const settings = { provider: 'openai', OPENAI_API_KEY: 'k', OPENAI_BASE_URL: base, model: 'm', llmFallbackProvider: 'anthropic', ANTHROPIC_API_KEY: 'fk', models: { anthropic: 'fm' } };
    const { opts, result, candles: c } = fixture(dir, { notify: false, settings });
    await processSignal(opts, result, c); // seeds the signal row (notify:false never reaches the filter)
    const { recheckSignal } = await import('../scripts/supertrend.mjs');
    const out = await recheckSignal(opts.db, opts.settings, opts.instrument, opts.granularity, result.signal);
    assert.equal(out.verdict, 'valid');
    assert.match(out.reason, /still tracking/);
    assert.match(out.reason, /\[fallback: anthropic]/);
  } finally { globalThis.fetch = realFetch; await new Promise((r) => srv.close(r)); }
});

// --- Verdict-path token budget (AC2/AC3): a real, configurable ceiling above
// the old 8192 floor, scoped to the filter/recheck calls only ---
test('llmVerdict budget (AC2/AC3): unset filterMaxCompletionTokens defaults the verdict call WELL ABOVE the old 8192 floor', async () => {
  const { llmVerdict } = await import('../scripts/supertrend.mjs');
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"alert":true,"reason":"ok"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await llmVerdict({ provider: 'openai', OPENAI_API_KEY: 'k' }, { representative: 'filter payload' }, 'system', null);
    assert.ok(bodies[0].max_completion_tokens > 8192, `expected the verdict default above the old 8192 floor, got ${bodies[0].max_completion_tokens}`);
  } finally { globalThis.fetch = realFetch; }
});

test('llmVerdict budget (AC2): settings.filterMaxCompletionTokens overrides the verdict-path default, independent of the global maxCompletionTokens', async () => {
  const { llmVerdict } = await import('../scripts/supertrend.mjs');
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"alert":true,"reason":"ok"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await llmVerdict({ provider: 'openai', OPENAI_API_KEY: 'k', filterMaxCompletionTokens: 20000 }, { some: 'payload' }, 'system', null);
    assert.equal(bodies[0].max_completion_tokens, 20000, 'the operator-configured verdict budget is honored exactly');
  } finally { globalThis.fetch = realFetch; }
});

test('llmChat tool-loop onUsage (#93): aggregates input/output tokens across rounds, reported once', async () => {
  const { llmChat } = await import('../scripts/supertrend.mjs');
  const realFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) {
      // round 1: model asks for a tool
      return new Response(JSON.stringify({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} }],
        usage: { input_tokens: 100, output_tokens: 10 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // round 2: final text
    return new Response(JSON.stringify({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'final answer' }],
      usage: { input_tokens: 200, output_tokens: 20 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    let captured = null;
    const reply = await llmChat({ provider: 'anthropic', ANTHROPIC_API_KEY: 'k' }, 'sys', 'user', {
      toolDefs: [{ name: 'noop', description: 'no-op', input_schema: { type: 'object' } }],
      execTool: async () => 'done',
      onUsage: (info) => { captured = info; },
    });
    assert.equal(reply, 'final answer');
    assert.equal(call, 2, 'two rounds ran');
    assert.deepEqual(captured, { provider: 'anthropic', model: 'claude-opus-4-8', usage: { inputTokens: 300, outputTokens: 30 } }, 'usage summed across both rounds, reported once');
  } finally { globalThis.fetch = realFetch; }
});

test('recordRecheck rejects a bad row shape (invalid verdict / empty reason) from any caller (#70)', async () => {
  const { recordRecheck } = await import('../scripts/signal-rechecks.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'rc-'));
  const db = join(dir, 'db.sqlite');
  const base = { signalTime: '2026-07-23T10:00:00Z', instrument: 'WTICO/USD', granularity: 'M5', at: '2026-07-23T10:05:00Z' };
  assert.throws(() => recordRecheck(db, { ...base, verdict: 'maybe', reason: 'x' }), /invalid verdict/);
  assert.throws(() => recordRecheck(db, { ...base, verdict: 'valid', reason: '   ' }), /reason is required/);
  assert.throws(() => recordRecheck(db, { ...base, verdict: 'valid' }), /reason is required/);
  const ok = recordRecheck(db, { ...base, verdict: 'valid', reason: '  still holds  ' });
  assert.equal(ok.reason, 'still holds', 'reason is trimmed before persist');
});


test('llmUsageLine renders n/a for a present-but-null token field (#93)', async () => {
  const { llmUsageLine } = await import('../scripts/supertrend.mjs');
  assert.match(llmUsageLine('filter', { provider: 'openai', model: 'x', usage: { inputTokens: 12, outputTokens: null } }), /in=12 out=n\/a/);
  assert.match(llmUsageLine('bot', { provider: 'pi', model: 'x', usage: null }), /in=n\/a out=n\/a/);
});

test('reportUsage swallows a synchronous throw AND an async-callback rejection — no unhandled rejection (#93)', async () => {
  const { reportUsage } = await import('../scripts/supertrend.mjs');
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  try {
    assert.doesNotThrow(() => reportUsage(() => { throw new Error('sync boom'); }, {}));
    assert.doesNotThrow(() => reportUsage(async () => { throw new Error('async boom'); }, {}));
    // let the rejected promise settle; the .catch() in reportUsage must have caught it
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(rejections.length, 0, 'the async onUsage rejection was swallowed');
  } finally {
    process.off('unhandledRejection', onRej);
  }
});


test('openai malformed/empty-choices response throws a readable error, not a TypeError (#98)', async () => {
  const { llmRequest } = await import('../scripts/supertrend.mjs');
  const http = await import('node:http');
  const srv = http.createServer((req, res) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ choices: [] })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    await assert.rejects(
      llmRequest({ provider: 'openai', OPENAI_API_KEY: 'k', OPENAI_BASE_URL: `http://127.0.0.1:${port}`, model: 'm' }, 'sys', 'user', { timeoutMs: 10000 }),
      /no choice\/message|malformed response/,
    );
  } finally { await new Promise((r) => srv.close(r)); }
});

test('buildFilterPayload volumeContext: zero/missing volume yields avg20:null + ratio:null, not a misleading 0 (Copilot #103)', async () => {
  const { buildFilterPayload } = await import('../scripts/supertrend.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const dbPath = join(dir, 'db.sqlite');
  const zeroVol = Array.from({ length: 21 }, (_, i) => ({ time: `2026-07-23T${String(i).padStart(2, '0')}:00:00.000Z`, open: 70, high: 71, low: 69, close: 70, volume: 0 }));
  storeCandles(dbPath, 'WTICO/USD', 'M5', zeroVol);
  const sig = { time: zeroVol[20].time, signal: 'buy', price: 70, index: 20, barsAgo: 0, fresh: true };
  const result = { close: 70, trend: 'up', supertrend: 69, backtest: { winRatePct: 50, totalReturnPct: 0, trades: 0 } };
  const payload = await buildFilterPayload({ dbPath, instrument: 'WTICO/USD', granularity: 'M5', sig, result, candles: zeroVol, history: [], gateSnapshot: null, notes: '' });
  assert.equal(payload.volumeContext.avg20, null, 'zero avg volume -> null, not 0');
  assert.equal(payload.volumeContext.ratio, null, 'no meaningful ratio without avg volume');
});

test('buildFilterPayload volumeContext: a real 0-volume flip against a nonzero avg is ratio:0 (a meaningful signal), not null (Copilot #103)', async () => {
  const { buildFilterPayload } = await import('../scripts/supertrend.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const dbPath = join(dir, 'db.sqlite');
  // 20 candles with volume 100 (nonzero avg), then a flip candle with volume 0.
  const cs = Array.from({ length: 21 }, (_, i) => ({ time: `2026-07-23T${String(i).padStart(2, '0')}:00:00.000Z`, open: 70, high: 71, low: 69, close: 70, volume: i === 20 ? 0 : 100 }));
  storeCandles(dbPath, 'WTICO/USD', 'M5', cs);
  const sig = { time: cs[20].time, signal: 'buy', price: 70, index: 20, barsAgo: 0, fresh: true };
  const result = { close: 70, trend: 'up', supertrend: 69, backtest: { winRatePct: 50, totalReturnPct: 0, trades: 0 } };
  const payload = await buildFilterPayload({ dbPath, instrument: 'WTICO/USD', granularity: 'M5', sig, result, candles: cs, history: [], gateSnapshot: null, notes: '' });
  assert.ok(payload.volumeContext.avg20 > 0, 'nonzero average volume');
  assert.equal(payload.volumeContext.ratio, 0, '0-volume flip against a nonzero avg is 0×, not null');
});

// --- gap backfill: findGaps / fetchCandles `from` / repairGap ---

test('findGaps: no gap on a perfectly contiguous series', async () => {
  const { findGaps } = await import('../scripts/supertrend.mjs');
  const granMs = 60000;
  const times = Array.from({ length: 5 }, (_, i) => i * granMs);
  assert.deepEqual(findGaps(times, granMs), []);
});

test('findGaps: a single gap > 3x granularity is reported with its bounds', async () => {
  const { findGaps } = await import('../scripts/supertrend.mjs');
  const granMs = 60000;
  const times = [0, granMs, granMs * 10, granMs * 11]; // hole between index 1 and 2
  assert.deepEqual(findGaps(times, granMs), [{ start: granMs, end: granMs * 10 }]);
});

test('findGaps: multiple gaps in one series are all reported', async () => {
  const { findGaps } = await import('../scripts/supertrend.mjs');
  const granMs = 60000;
  const times = [0, granMs, granMs * 10, granMs * 11, granMs * 30];
  assert.deepEqual(findGaps(times, granMs), [
    { start: granMs, end: granMs * 10 },
    { start: granMs * 11, end: granMs * 30 },
  ]);
});

test('findGaps: a gap at the very start/end of the window is still caught (no off-by-one at the edges)', async () => {
  const { findGaps } = await import('../scripts/supertrend.mjs');
  const granMs = 60000;
  // gap between the first two points, and between the last two points
  const times = [0, granMs * 10, granMs * 11, granMs * 12, granMs * 30];
  assert.deepEqual(findGaps(times, granMs), [
    { start: 0, end: granMs * 10 },
    { start: granMs * 12, end: granMs * 30 },
  ]);
});

test('findGaps: exactly 3x granularity is not a gap (threshold is strictly greater-than, matching the client)', async () => {
  const { findGaps } = await import('../scripts/supertrend.mjs');
  const granMs = 60000;
  assert.deepEqual(findGaps([0, granMs * 3], granMs), []);
  assert.deepEqual(findGaps([0, granMs * 3 + 1], granMs), [{ start: 0, end: granMs * 3 + 1 }]);
});

test('fetchCandles: an optional `from` is forwarded as a query param (backward compatible when omitted)', async () => {
  const { fetchCandles } = await import('../scripts/supertrend.mjs');
  const { createServer } = await import('node:http');
  const hits = [];
  const srv = createServer((req, res) => {
    hits.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ candles: [] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const realFetch = globalThis.fetch;
  const base = `http://127.0.0.1:${srv.address().port}`;
  globalThis.fetch = (url, opts) => realFetch(String(url).replace('https://p.fxempire.com/oanda/candles/latest', base), opts);
  try {
    await fetchCandles({ instrument: 'WTICO/USD', granularity: 'M5', count: 3 });
    assert.doesNotMatch(hits[0], /from=/, 'no from param when omitted');
    await fetchCandles({ instrument: 'WTICO/USD', granularity: 'M5', count: 3, from: '2026-07-28T06:00:00.000Z' });
    assert.match(decodeURIComponent(hits[1]), /from=2026-07-28T06:00:00\.000Z/);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((r) => srv.close(r));
  }
});

test('gapFetchPlan: literal expected {from,count} for a plain in-range gap', async () => {
  const { gapFetchPlan } = await import('../scripts/supertrend.mjs');
  const granMs = 5 * 60000; // M5
  const gap = { start: Date.parse('2026-07-28T06:00:00.000Z'), end: Date.parse('2026-07-28T06:30:00.000Z') };
  assert.deepEqual(gapFetchPlan(gap, granMs), { from: '2026-07-28T06:00:00.000Z', count: 8 });
});

test('gapFetchPlan: count is capped at 2500 and clamped to at least 1 for a degenerate (empty/inverted) gap', async () => {
  const { gapFetchPlan } = await import('../scripts/supertrend.mjs');
  const granMs = 60000; // M1
  const huge = { start: 0, end: granMs * 100000 };
  assert.equal(gapFetchPlan(huge, granMs).count, 2500);
  const inverted = { start: 1000000000, end: 0 };
  assert.equal(gapFetchPlan(inverted, granMs).count, 1);
});

test('repairGap: fetches from the gap start with the right count and upserts the missing rows', async () => {
  const { repairGap } = await import('../scripts/supertrend.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'gap-'));
  const dbPath = join(dir, 'db.sqlite');
  const granMs = 5 * 60000; // M5
  const gap = { start: Date.parse('2026-07-28T06:00:00.000Z'), end: Date.parse('2026-07-28T06:30:00.000Z') };
  const requests = [];
  const fetcher = async (opts) => {
    requests.push(opts);
    const rows = [];
    for (let t = gap.start; t < gap.end; t += granMs) rows.push(fxempireCandleFromMs(t));
    return rows.map((r) => ({ ...r, complete: true }));
  };
  const stored = await repairGap(dbPath, 'WTICO/USD', 'M5', gap, { fetcher, attempted: new Set() });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].from, new Date(gap.start).toISOString());
  assert.equal(requests[0].count, Math.ceil((gap.end - gap.start) / granMs) + 2);
  assert.equal(stored, (gap.end - gap.start) / granMs);
  const { n } = withDb(dbPath, (db) => db.prepare('SELECT COUNT(*) AS n FROM candles').get());
  assert.equal(Number(n), stored);
});

function fxempireCandleFromMs(ms) {
  return { time: new Date(ms).toISOString(), open: 70, high: 70.1, low: 69.9, close: 70, volume: 10, complete: true };
}

test('repairGap: an already-attempted gap is never re-fetched (per dbPath+combo+gapStart, injected Set lifetime)', async () => {
  const { repairGap } = await import('../scripts/supertrend.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'gap-'));
  const dbPath = join(dir, 'db.sqlite');
  const gap = { start: Date.parse('2026-07-28T21:00:00.000Z'), end: Date.parse('2026-07-28T22:00:00.000Z') };
  let calls = 0;
  const fetcher = async () => { calls++; return []; };
  const attempted = new Set();
  await repairGap(dbPath, 'WTICO/USD', 'M5', gap, { fetcher, attempted });
  await repairGap(dbPath, 'WTICO/USD', 'M5', gap, { fetcher, attempted });
  assert.equal(calls, 1, 'second attempt at the same gap is skipped from memory, not a second fetch');
});

test('repairGap: an empty result (e.g. market-closed hole) still marks the gap attempted, and stores nothing', async () => {
  const { repairGap } = await import('../scripts/supertrend.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'gap-'));
  const dbPath = join(dir, 'db.sqlite');
  const gap = { start: Date.parse('2026-07-29T21:00:00.000Z'), end: Date.parse('2026-07-29T22:00:00.000Z') };
  const fetcher = async () => [];
  const attempted = new Set();
  const stored = await repairGap(dbPath, 'WTICO/USD', 'M5', gap, { fetcher, attempted });
  assert.equal(stored, 0);
  assert.equal(attempted.size, 1, 'a legitimately empty result still marks the gap attempted');
  const { n } = withDb(dbPath, (db) => db.prepare('SELECT COUNT(*) AS n FROM candles').get());
  assert.equal(Number(n), 0);
});

test('repairGap: a THROWING fetch does not poison the gap — a later successful call still repairs it', async () => {
  const { repairGap } = await import('../scripts/supertrend.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'gap-'));
  const dbPath = join(dir, 'db.sqlite');
  const granMs = 5 * 60000;
  const gap = { start: Date.parse('2026-07-30T06:00:00.000Z'), end: Date.parse('2026-07-30T06:30:00.000Z') };
  const attempted = new Set();
  let calls = 0;
  const fetcher = async (opts) => {
    calls++;
    if (calls === 1) throw new Error('transient network blip');
    const rows = [];
    for (let t = gap.start; t < gap.end; t += granMs) rows.push(fxempireCandleFromMs(t));
    return rows.map((r) => ({ ...r, complete: true }));
  };
  await assert.rejects(() => repairGap(dbPath, 'WTICO/USD', 'M5', gap, { fetcher, attempted }));
  assert.equal(attempted.size, 0, 'a throw removes the gap key — it must not be left marked attempted');
  const stored = await repairGap(dbPath, 'WTICO/USD', 'M5', gap, { fetcher, attempted });
  assert.equal(calls, 2);
  assert.equal(stored, (gap.end - gap.start) / granMs, 'the second, successful call repairs the gap');
});

// --- #193: single scheduled process — runWatcherCycle export + CLI single-owner guard ---
test('runWatcherCycle is exported and returns per-combo results (same shape main() used to inline)', async () => {
  const { runWatcherCycle, DEFAULT_ARGS } = await import('../scripts/supertrend.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cycle-'));
  const dbPath = join(dir, 'db.sqlite');
  withDb(dbPath, () => {});
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({}));
  // runOne has no fetcher injection point (acquireWindow always resolves the
  // real fetchCandles) — stub the one network seam it goes through, same
  // pattern the existing fetchCandles test uses for the same reason.
  const http = await import('node:http');
  const closes = [...Array(40).fill(100), ...Array.from({ length: 20 }, (_, i) => 100 - (i + 1))];
  const rows = closes.map((c, i) => ({
    time: new Date(Date.parse('2026-07-28T00:00:00Z') + i * 300000).toISOString(),
    mid: { o: c, h: c + 0.2, l: c - 0.2, c }, volume: 10, complete: true,
  }));
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ candles: rows })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const realFetch = globalThis.fetch;
  const base = `http://127.0.0.1:${srv.address().port}`;
  globalThis.fetch = (url, opts) => realFetch(String(url).replace('https://p.fxempire.com/oanda/candles/latest', base), opts);
  try {
    // An instrument with no sentinel/news config entry (unlike WTICO/USD) makes
    // the best-effort news-cache step a fast no-op instead of a real,
    // slow-to-timeout GDELT network attempt.
    const opts = { ...DEFAULT_ARGS, instrument: 'TEST/XYZ', granularity: 'M5', db: dbPath, settings: join(dir, 'settings.json'), count: 30 };
    const results = await runWatcherCycle(opts, { watchers: '' });
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 1);
    assert.equal(results[0].instrument, 'TEST/XYZ');
    assert.equal(results[0].ok, true);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((r) => srv.close(r));
  }
});

// --- volume-impulse detector (#206): continuation moves with no flip get an alert too ---
import { detectVolumeImpulse, impulseSettings, processImpulseAlert } from '../scripts/supertrend.mjs';

// Flat volume-10 history (period bars), then a qualifying/non-qualifying pair
// appended at the tail — the detector only ever looks at the last two bars.
function impulseCandles({ period = 20, pairVolume = [50, 50], pairOpenClose = [[99, 101], [99, 101]], histVolume = 10 } = {}) {
  const hist = Array.from({ length: period }, (_, i) => ({
    time: new Date(Date.parse('2026-07-28T00:00:00Z') + i * 300000).toISOString(),
    open: 100, high: 100.5, low: 99.5, close: 100, volume: histVolume,
  }));
  const pair = pairOpenClose.map(([open, close], i) => ({
    time: new Date(Date.parse('2026-07-28T00:00:00Z') + (period + i) * 300000).toISOString(),
    open, high: Math.max(open, close) + 0.2, low: Math.min(open, close) - 0.2, close, volume: pairVolume[i],
  }));
  return [...hist, ...pair];
}

test('detectVolumeImpulse: fires on two same-direction bars >= mult x the prior average', () => {
  const c = impulseCandles();
  const r = detectVolumeImpulse(c, { mult: 2, period: 20 });
  assert.ok(r);
  assert.equal(r.direction, 'up');
  assert.equal(r.time, c[c.length - 1].time);
  assert.equal(r.volRatio, 5, '50/10 = 5x');
});

test('detectVolumeImpulse: a single high-volume bar (the other stays at baseline) does not fire', () => {
  const c = impulseCandles({ pairVolume: [50, 10] });
  assert.equal(detectVolumeImpulse(c, { mult: 2, period: 20 }), null);
});

test('detectVolumeImpulse: opposite-direction bodies do not fire', () => {
  const c = impulseCandles({ pairOpenClose: [[99, 101], [101, 99]] });
  assert.equal(detectVolumeImpulse(c, { mult: 2, period: 20 }), null);
});

test('detectVolumeImpulse: insufficient history returns null', () => {
  const c = impulseCandles().slice(-10); // fewer than period+2
  assert.equal(detectVolumeImpulse(c, { mult: 2, period: 20 }), null);
});

test('impulseSettings: valid overrides win, invalid/missing values fall back per-knob (2/20/10 defaults)', () => {
  assert.deepEqual(impulseSettings({}), { mult: 2, period: 20, cooldownBars: 10 });
  assert.deepEqual(
    impulseSettings({ impulseVolMult: 3, impulseVolWindow: 30, impulseCooldownBars: 5 }),
    { mult: 3, period: 30, cooldownBars: 5 },
  );
  assert.equal(impulseSettings({ impulseVolMult: 0 }).mult, 2, 'mult below 1 falls back');
  assert.equal(impulseSettings({ impulseVolWindow: -1 }).period, 20, 'negative window falls back');
  assert.equal(impulseSettings({ impulseVolWindow: 1.5 }).period, 20, 'non-integer window falls back');
  assert.equal(impulseSettings({ impulseCooldownBars: 'x' }).cooldownBars, 10, 'non-numeric falls back');
});

test('processImpulseAlert: sends once, records a kind=volume-impulse row; re-run is already-processed; notify:false records without sending (flip parity)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-impulse-'));
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({}));
  const dbPath = join(dir, 'db.sqlite');
  const c = impulseCandles();
  const sent = [];
  const sendFn = (msg, deepLink) => sent.push({ msg, deepLink });

  // notify off records the row without a ping — same contract as the flip
  // path's 'recorded (notify off)', so bot event gating treats kinds alike.
  const offDb = join(dir, 'off.sqlite');
  const off = await processImpulseAlert({ db: offDb, instrument: 'WTICO/USD', granularity: 'M5', notify: false, settings: settingsPath }, c, { sendFn });
  assert.equal(off.reason, 'recorded (notify off)');
  assert.equal(sent.length, 0);
  const [offRow] = signalOutcomes(offDb, 'WTICO/USD', 'M5', { kinds: 'all' });
  assert.equal(offRow.kind, 'volume-impulse');
  assert.equal(offRow.notified, 0);

  const opts = { db: dbPath, instrument: 'WTICO/USD', granularity: 'M5', notify: true, settings: settingsPath };
  const first = await processImpulseAlert(opts, c, { sendFn });
  assert.equal(first.sent, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].msg, /volume impulse UP/);
  const [row] = signalOutcomes(dbPath, 'WTICO/USD', 'M5', { kinds: 'all' });
  assert.equal(row.kind, 'volume-impulse');
  assert.equal(row.verdict, 'alert');
  assert.equal(row.notified, 1);

  const again = await processImpulseAlert(opts, c, { sendFn });
  assert.equal(again.reason, 'already processed');
  assert.equal(sent.length, 1, 'no second notification for the same bar');
});

// Deliberately a NON-default cooldown (10 is impulseSettings' own fallback,
// so a wiring bug that drops the setting entirely would still pass at 10) —
// this proves settings.json actually reaches processImpulseAlert, not just
// that impulseSettings itself parses it (that's covered separately above).
const COOLDOWN_BARS = 3;

function shiftedImpulseCandles(barsLater) {
  return impulseCandles().map((c) => ({ ...c, time: new Date(Date.parse(c.time) + barsLater * 300000).toISOString() }));
}

test('processImpulseAlert: DB-backed cooldown holds across a fresh process instance (restart-safe), non-default cooldownBars actually wired', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-impulse-cooldown-'));
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ impulseCooldownBars: COOLDOWN_BARS }));
  const dbPath = join(dir, 'db.sqlite');
  const sent = [];
  const sendFn = (msg) => sent.push(msg);
  const opts = { db: dbPath, instrument: 'WTICO/USD', granularity: 'M5', notify: true, settings: settingsPath };

  const first = await processImpulseAlert(opts, impulseCandles(), { sendFn });
  assert.equal(first.sent, true);

  // One bar later, still hot: within the (non-default) 3-bar cooldown window.
  const second = await processImpulseAlert(opts, shiftedImpulseCandles(1), { sendFn });
  assert.equal(second.reason, 'impulse cooldown');
  assert.equal(sent.length, 1, 'cooldown holds even against a brand-new process/module instance');
});

test('processImpulseAlert: cooldown window expires — a qualifying pair cooldownBars+1 bars later alerts again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-impulse-cooldown-expiry-'));
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ impulseCooldownBars: COOLDOWN_BARS }));
  const dbPath = join(dir, 'db.sqlite');
  const sent = [];
  const sendFn = (msg) => sent.push(msg);
  const opts = { db: dbPath, instrument: 'WTICO/USD', granularity: 'M5', notify: true, settings: settingsPath };

  const first = await processImpulseAlert(opts, impulseCandles(), { sendFn });
  assert.equal(first.sent, true);

  // exactly cooldownBars bars later — still suppressed (the <= boundary)
  const stillCold = await processImpulseAlert(opts, shiftedImpulseCandles(COOLDOWN_BARS), { sendFn });
  assert.equal(stillCold.reason, 'impulse cooldown');

  // cooldownBars+1 bars later — the window has expired, a fresh qualifying pair alerts again
  const expired = await processImpulseAlert(opts, shiftedImpulseCandles(COOLDOWN_BARS + 1), { sendFn });
  assert.equal(expired.sent, true, JSON.stringify(expired));
  assert.equal(sent.length, 2);
});

test('processImpulseAlert: a non-default impulseVolMult actually changes detection (wiring, not just impulseSettings parsing)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-impulse-mult-'));
  const settingsPath = join(dir, 'settings.json');
  // 5x pair (volRatio 5) must NOT fire once the required multiple is raised past it.
  writeFileSync(settingsPath, JSON.stringify({ impulseVolMult: 6 }));
  const dbPath = join(dir, 'db.sqlite');
  const sent = [];
  const sendFn = (msg) => sent.push(msg);
  const opts = { db: dbPath, instrument: 'WTICO/USD', granularity: 'M5', notify: true, settings: settingsPath };

  const result = await processImpulseAlert(opts, impulseCandles(), { sendFn });
  assert.equal(result.reason, 'no impulse', 'a 5x pair does not qualify at impulseVolMult:6');
  assert.equal(sent.length, 0);
});

test('per-kind separation: signalOutcomes defaults to flips only; kinds:"all" returns both flip and impulse rows', () => {
  const dbPath = fileURLToPath(new URL('./tmp-kinds-test.db', import.meta.url));
  rmSync(dbPath, { force: true });
  storeCandles(dbPath, 'WTICO/USD', 'M5', candles);
  const flip = { time: candles[10].time, signal: 'buy', price: candles[10].close };
  const impulse = { time: candles[20].time, signal: 'sell', price: candles[20].close };
  recordSignal(dbPath, 'WTICO/USD', 'M5', flip, 50); // default kind
  recordSignal(dbPath, 'WTICO/USD', 'M5', impulse, null, 'volume-impulse');

  const flipsOnly = signalOutcomes(dbPath, 'WTICO/USD', 'M5');
  assert.deepEqual(flipsOnly.map((r) => r.time), [flip.time], 'default scope excludes the impulse row');

  const all = signalOutcomes(dbPath, 'WTICO/USD', 'M5', { kinds: 'all' });
  assert.equal(all.length, 2);
  assert.deepEqual(new Set(all.map((r) => r.kind)), new Set(['supertrend-flip', 'volume-impulse']));
  rmSync(dbPath, { force: true });
});

test('runWatcherCycle: fixture candles with a qualifying impulse pair and no flip produce result.impulse.sent === true and a db row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cycle-impulse-'));
  const dbPath = join(dir, 'db.sqlite');
  withDb(dbPath, () => {});
  const settingsPath = join(dir, 'settings.json');
  const recorderLog = join(dir, 'notify.log');
  const notifierBin = fakeBin(dir, 'notifier', `echo "$@" >> ${recorderLog}`);
  writeFileSync(settingsPath, JSON.stringify({ notifierBin }));

  // Flat trend (no flip ever fires) with a volume-impulse pair at the tail.
  const rows = impulseCandles().map((c) => ({
    time: c.time, mid: { o: c.open, h: c.high, l: c.low, c: c.close }, volume: c.volume, complete: true,
  }));
  const http = await import('node:http');
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ candles: rows })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const realFetch = globalThis.fetch;
  const base = `http://127.0.0.1:${srv.address().port}`;
  globalThis.fetch = (url, opts) => realFetch(String(url).replace('https://p.fxempire.com/oanda/candles/latest', base), opts);
  try {
    const { DEFAULT_ARGS, runWatcherCycle } = await import('../scripts/supertrend.mjs');
    const opts = { ...DEFAULT_ARGS, instrument: 'TEST/IMPULSE', granularity: 'M5', db: dbPath, settings: settingsPath, count: rows.length, notify: true };
    const results = await runWatcherCycle(opts, { watchers: '' });
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].notify.reason, 'no fresh flip');
    assert.equal(results[0].impulse.sent, true, JSON.stringify(results[0].impulse));
    const [row] = signalOutcomes(dbPath, 'TEST/IMPULSE', 'M5', { kinds: 'all' });
    assert.equal(row.kind, 'volume-impulse');
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((r) => srv.close(r));
  }
});

test('flip-alert-wins: a real runWatcherCycle where a flip AND a qualifying impulse coincide on the same bar sends only the flip; the impulse is recorded suppressed for next-cycle dedup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-flip-wins-'));
  const dbPath = join(dir, 'db.sqlite');
  withDb(dbPath, () => {});
  const settingsPath = join(dir, 'settings.json');
  const recorderLog = join(dir, 'notify.log');
  const notifierBin = fakeBin(dir, 'notifier', `echo "$@" >> ${recorderLog}`);
  writeFileSync(settingsPath, JSON.stringify({ notifierBin, provider: 'none' }));

  // Two flat-volume bars (period=20) then a 2-bar crash pair whose volume
  // qualifies as an impulse AND whose price move flips supertrend(10,3) to
  // sell on the very same tail bar — the exact coincidence the AC covers.
  const pair = impulseCandles({ pairOpenClose: [[100, 97], [97, 94]] });
  const rows = pair.map((c) => ({
    time: c.time, mid: { o: c.open, h: c.high, l: c.low, c: c.close }, volume: c.volume, complete: true,
  }));
  const http = await import('node:http');
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ candles: rows })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const realFetch = globalThis.fetch;
  const base = `http://127.0.0.1:${srv.address().port}`;
  globalThis.fetch = (url, opts) => realFetch(String(url).replace('https://p.fxempire.com/oanda/candles/latest', base), opts);
  try {
    const { DEFAULT_ARGS, runWatcherCycle } = await import('../scripts/supertrend.mjs');
    const opts = { ...DEFAULT_ARGS, instrument: 'TEST/COINCIDE', granularity: 'M5', db: dbPath, settings: settingsPath, count: rows.length, notify: true };
    const results = await runWatcherCycle(opts, { watchers: '' });
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true, results[0].error);
    assert.equal(results[0].notify.sent, true, JSON.stringify(results[0].notify));
    assert.equal(results[0].impulse.sent, false);
    assert.equal(results[0].impulse.reason, 'flip alert already sent');

    // The impulse is RECORDED suppressed (not skipped): a later cycle seeing
    // the same pair dedups against this row instead of pinging one cycle late.
    const rowsAll = signalOutcomes(dbPath, 'TEST/COINCIDE', 'M5', { kinds: 'all' });
    const imp = rowsAll.find((r) => r.kind === 'volume-impulse');
    assert.ok(rowsAll.some((r) => r.kind === 'supertrend-flip'));
    assert.equal(imp.verdict, null, 'gate vocabulary is reserved for rows a gate actually evaluated');
    assert.equal(imp.reason, 'flip alert already sent');
    assert.equal(imp.notified, 0);
    const rerun = await runWatcherCycle(opts, { watchers: '' });
    assert.equal(rerun[0].impulse.reason, 'already processed', 'the suppressed row dedups the next cycle');

    const notified = readFileSync(recorderLog, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(notified.length, 1, 'exactly one notification for the coinciding bar');
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((r) => srv.close(r));
  }
});

test('same-bar coexistence: a flip and an impulse recorded independently on the same instrument/granularity/time both persist (kind-scoped PK)', () => {
  const dbPath = fileURLToPath(new URL('./tmp-same-bar-test.db', import.meta.url));
  rmSync(dbPath, { force: true });
  storeCandles(dbPath, 'WTICO/USD', 'M5', candles);
  const t = candles[15].time;
  const flip = { time: t, signal: 'buy', price: candles[15].close };
  const impulse = { time: t, signal: 'sell', price: candles[15].close };
  assert.equal(recordSignal(dbPath, 'WTICO/USD', 'M5', flip, 50).isNew, true);
  assert.equal(recordSignal(dbPath, 'WTICO/USD', 'M5', impulse, null, 'volume-impulse').isNew, true, 'same bar, different kind — no PK collision');
  const rows = signalOutcomes(dbPath, 'WTICO/USD', 'M5', { time: t, kinds: 'all' });
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.kind)), new Set(['supertrend-flip', 'volume-impulse']));
  rmSync(dbPath, { force: true });
});

test('kind-PK migration backfills a legacy (pre-kind) DB and preserves its rows', () => {
  const dbPath = fileURLToPath(new URL('./tmp-legacy-kind-test.db', import.meta.url));
  rmSync(dbPath, { force: true });
  // Build the OLD schema by hand (no kind column, PK without kind) — what any
  // DB created before volume-impulse existed looks like on disk. Raw open
  // (never through withDb) so the migration hasn't run yet.
  {
    const raw = new DatabaseSync(dbPath);
    raw.exec(`CREATE TABLE signals (
      instrument TEXT NOT NULL, granularity TEXT NOT NULL, time TEXT NOT NULL,
      signal TEXT NOT NULL, price REAL, win_rate REAL,
      verdict TEXT, reason TEXT, notified INTEGER DEFAULT 0,
      PRIMARY KEY (instrument, granularity, time)
    )`);
    raw.prepare('INSERT INTO signals (instrument, granularity, time, signal, price, win_rate, verdict, notified) VALUES (?,?,?,?,?,?,?,?)')
      .run('WTICO/USD', 'M5', candles[5].time, 'buy', candles[5].close, 40, 'alert', 1);
    raw.close();
  }
  // Opening through withDb (any real caller) must migrate: backfill kind AND
  // rebuild the PK to include it, without losing the pre-existing row.
  const rows = signalOutcomes(dbPath, 'WTICO/USD', 'M5', { kinds: 'all' });
  assert.equal(rows.length, 1, 'the legacy row survived the rebuild');
  assert.equal(rows[0].kind, 'supertrend-flip', 'legacy rows backfill to supertrend-flip');
  assert.equal(rows[0].verdict, 'alert', 'non-kind columns preserved');
  // The PK now includes kind: a same-bar impulse must no longer collide.
  assert.equal(recordSignal(dbPath, 'WTICO/USD', 'M5', { time: candles[5].time, signal: 'sell', price: candles[5].close }, null, 'volume-impulse').isNew, true);
  rmSync(dbPath, { force: true });
});

test('impulse cooldown is kind-scoped: a flip row NEWER than the last impulse does not disable the cooldown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-impulse-kindcool-'));
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ impulseCooldownBars: COOLDOWN_BARS }));
  const dbPath = join(dir, 'db.sqlite');
  const sent = [];
  const opts = { db: dbPath, instrument: 'WTICO/USD', granularity: 'M5', notify: true, settings: settingsPath };

  const first = await processImpulseAlert(opts, impulseCandles(), { sendFn: (m) => sent.push(m) });
  assert.equal(first.sent, true);
  // A flip lands on the NEXT bar — newest row in the table is now a flip.
  // A newest-row-of-any-kind cooldown lookup would see it, find no impulse,
  // and let the bar after alert straight through the window.
  const flipTime = new Date(Date.parse(first.impulse.time) + 300000).toISOString();
  recordSignal(dbPath, 'WTICO/USD', 'M5', { time: flipTime, signal: 'sell', price: 100 }, null);
  const second = await processImpulseAlert(opts, shiftedImpulseCandles(2), { sendFn: (m) => sent.push(m) });
  assert.equal(second.reason, 'impulse cooldown', JSON.stringify(second));
  assert.equal(sent.length, 1);

  // The under-suppression direction: once the last impulse has aged OUT of
  // the window, a recent flip inside it must NOT anchor the cooldown — an
  // any-kind lookup would treat that flip as the floor and wrongly suppress.
  const lateFlipTime = new Date(Date.parse(first.impulse.time) + (COOLDOWN_BARS + 3) * 300000).toISOString();
  recordSignal(dbPath, 'WTICO/USD', 'M5', { time: lateFlipTime, signal: 'sell', price: 100 }, null);
  const expired = await processImpulseAlert(opts, shiftedImpulseCandles(COOLDOWN_BARS + 4), { sendFn: (m) => sent.push(m) });
  assert.equal(expired.sent, true, `a flip inside the window must not suppress an impulse whose own cooldown expired: ${JSON.stringify(expired)}`);
  assert.equal(sent.length, 2);
});

test('signalOutcomes adverse join ignores impulse rows: an opposite-direction impulse never closes a flip trade', () => {
  const dbPath = fileURLToPath(new URL('./tmp-adverse-kind-test.db', import.meta.url));
  rmSync(dbPath, { force: true });
  storeCandles(dbPath, 'WTICO/USD', 'M5', candles);
  const flipTime = candles[20].time;
  recordSignal(dbPath, 'WTICO/USD', 'M5', { time: flipTime, signal: 'buy', price: candles[20].close }, null);
  // Opposite-direction impulse two bars later — kind-filtered out of the
  // adverse lookup; an unfiltered lookup would close the flip trade here.
  recordSignal(dbPath, 'WTICO/USD', 'M5', { time: candles[22].time, signal: 'sell', price: candles[22].close }, null, 'volume-impulse');
  const flip = signalOutcomes(dbPath, 'WTICO/USD', 'M5').find((s) => s.time === flipTime);
  assert.ok(flip);
  assert.equal(flip.adverseOpen, true, 'no opposite FLIP exists, so the trade must still be open');
});

test('updateSignal kind scoping: an impulse alert on a bar carrying a flip row leaves the flip row untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-impulse-kindupd-'));
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({}));
  const dbPath = join(dir, 'db.sqlite');
  const opts = { db: dbPath, instrument: 'WTICO/USD', granularity: 'M5', notify: true, settings: settingsPath };
  const c = impulseCandles();
  const barTime = c[c.length - 1].time;
  recordSignal(dbPath, 'WTICO/USD', 'M5', { time: barTime, signal: 'buy', price: 101 }, null);
  const res = await processImpulseAlert(opts, c, { sendFn: () => {} });
  assert.equal(res.sent, true, JSON.stringify(res));
  const rows = signalOutcomes(dbPath, 'WTICO/USD', 'M5', { kinds: 'all' }).filter((s) => s.time === barTime);
  const flip = rows.find((s) => s.kind === 'supertrend-flip');
  const imp = rows.find((s) => s.kind === 'volume-impulse');
  assert.equal(imp.verdict, 'alert');
  assert.equal(imp.notified, 1);
  assert.equal(flip.verdict, null, 'an unscoped UPDATE would have stamped the impulse verdict onto the flip row');
  assert.equal(flip.notified, 0);
});

// The shared deadline's floor: a fallback started with a few milliseconds left
// cannot answer in time and still spends a request, so below the floor the
// primary's error stands rather than a doomed second attempt being made.
test('withVerdictFallback: a nearly-exhausted deadline skips the fallback instead of starting a doomed attempt', async () => {
  const { llmVerdict } = await import('../scripts/supertrend.mjs');
  const settings = {
    provider: 'openai-compatible', OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://primary.invalid/v1',
    ANTHROPIC_API_KEY: 'a', llmFallbackProvider: 'anthropic',
    models: { 'openai-compatible': 'm1', anthropic: 'm2' },
  };
  const realNow = Date.now;
  let calls = 0;
  global.fetch = async () => { calls++; Date.now = () => realNow() + 89_000; throw new Error('primary down'); };
  try {
    await assert.rejects(llmVerdict(settings, { x: 1 }, 'sys'), /primary down/,
      'the primary error stands — no "both providers failed" wrapper, because the fallback never ran');
    assert.equal(calls, 1, 'exactly one provider call: the fallback was skipped, not attempted');
  } finally {
    Date.now = realNow;
    delete global.fetch;
  }
});
