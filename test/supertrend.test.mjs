import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
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
  assert.equal(result.promptVersion, draft.version);

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

test('openaiEndpoint + explicit provider resolution (#42)', async () => {
  const { openaiEndpoint, resolveProvider } = await import('../scripts/supertrend.mjs');
  assert.equal(openaiEndpoint({}), 'https://api.openai.com/v1/chat/completions', 'default unchanged when unset');
  assert.equal(openaiEndpoint({ OPENAI_BASE_URL: 'http://localhost:8080/' }), 'http://localhost:8080/v1/chat/completions', 'trailing slash normalized');
  assert.equal(openaiEndpoint({ OPENAI_BASE_URL: 'http://localhost:8080/v1' }), 'http://localhost:8080/v1/chat/completions', 'base URLs already ending in /v1 do not double the segment');
  assert.equal(openaiEndpoint({ OPENAI_BASE_URL: 'http://localhost:8080/v1/' }), 'http://localhost:8080/v1/chat/completions');
  assert.equal(resolveProvider({ provider: 'openai', ANTHROPIC_API_KEY: 'x' }), 'openai', 'explicit choice beats key-derived resolution');
  assert.equal(resolveProvider({ provider: 'anthropic' }), 'anthropic');
  assert.equal(resolveProvider({ ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y' }), 'anthropic', 'legacy empty provider keeps key-derived behavior');
  assert.equal(resolveProvider({}), 'none');
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
