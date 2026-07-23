#!/usr/bin/env node
/**
 * smoke-skills — live smoke tests for the market-signals skills.
 *
 * Runs the network-testable skills and asserts they return real data.
 * Credential-gated skills (truthsocial CDP, hormuz aisstream) are exercised
 * only for their fail-loud / arg-validation guarantees, which need no creds.
 *
 * Exits 1 if any check fails; prints "SMOKE OK" and exits 0 otherwise.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const S = (rel) => path.join(REPO_ROOT, rel);

const FXEMPIRE_LIVE = S('skills/fxempire-live-data/scripts/fxempire_live_data.mjs');
const FXEMPIRE_ENRICH = S('skills/fxempire-analysis/scripts/fxempire_enrich.mjs');
const TRUTHSOCIAL = S('skills/truthsocial-trump-watch/scripts/truthsocial_watch.mjs');
const HORMUZ = S('skills/hormuz-ais-watch/scripts/hormuz_watch.mjs');
const SENTINEL_NEWS = S('skills/market-sentinel/scripts/sentinel_news.mjs');
const SENTINEL_BRIEFING = S('skills/market-sentinel/scripts/sentinel_briefing.mjs');
const SENTINEL_BRIEFING_FIXTURE = S('test/fixtures/sentinel_briefing_digest.json');
const PUBLISH_BRIEFING = S('skills/briefing-publisher/scripts/publish_briefing.mjs');
const FETCH_POSTS = S('scripts/fetch-trump-posts.mjs');
const EVENT_STUDY = S('scripts/event-study.mjs');

const failures = [];

function run(scriptPath, args, { env = {}, timeout = 60000 } = {}) {
  return spawnSync('node', [scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout,
  });
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ms-smoke-'));
}

// Retry network-dependent checks so transient flake doesn't turn the job red.
async function check(name, fn, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await fn();
      process.stdout.write(`ok - ${name}\n`);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
  }
  const msg = `${name}: ${String(lastErr?.message ?? lastErr)}`;
  process.stdout.write(`FAIL - ${msg}\n`);
  failures.push(msg);
}

function parseJson(res, name) {
  assert.equal(res.status, 0, `${name} exited ${res.status}: ${res.stderr}`);
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error(`${name} stdout was not JSON: ${res.stdout.slice(0, 300)}`);
  }
  return parsed;
}

function assertCandles(res, name) {
  const out = parseJson(res, name);
  assert.equal(out.ok, true, `${name} ok!==true`);
  assert.ok(Array.isArray(out.candles), `${name} candles not array`);
  assert.ok(out.candles.length > 0, `${name} zero candles`);
  const c = out.candles[0];
  for (const k of ['open', 'high', 'low', 'close']) {
    assert.ok(Number.isFinite(Number(c[k])), `${name} candle.${k} not finite`);
  }
}

async function main() {
  // 1. fxempire candles via oanda
  await check('fxempire candles (oanda)', () => {
    const res = run(FXEMPIRE_LIVE, [
      '--mode', 'candles', '--provider', 'oanda', '--instrument', 'NAS100/USD',
      '--granularity', 'M5', '--count', '50', '--pretty', 'false',
    ]);
    assertCandles(res, 'fxempire candles (oanda)');
  });

  // 2. fxempire candles via fxempire provider
  await check('fxempire candles (fxempire)', () => {
    const res = run(FXEMPIRE_LIVE, [
      '--mode', 'candles', '--provider', 'fxempire', '--market', 'indices',
      '--instrument', 'NAS100/USD', '--granularity', 'M5', '--count', '50', '--pretty', 'false',
    ]);
    const out = parseJson(res, 'fxempire candles (fxempire)');
    assert.ok(Array.isArray(out.candles) && out.candles.length > 0, 'fxempire provider zero candles');
  });

  // 3. fxempire rates
  await check('fxempire rates', () => {
    const res = run(FXEMPIRE_LIVE, [
      '--mode', 'rates', '--market', 'indices', '--slugs', 'spx,tech100-usd', '--pretty', 'false',
    ]);
    const out = parseJson(res, 'fxempire rates');
    assert.equal(out.ok, true, 'rates ok!==true');
    assert.ok(out.count > 0, 'rates count not > 0');
    const rates = out.rates || out.data || [];
    const hasLast = Array.isArray(rates) && rates.some((r) => r && r.last != null);
    assert.ok(hasLast, 'no rate had a non-null last');
  });

  // 4. fxempire_enrich markdown non-trivial
  await check('fxempire_enrich markdown', () => {
    const res = run(FXEMPIRE_ENRICH, [
      '--commodities', 'brent-crude-oil', '--no-full-text', '--max-items', '1',
    ]);
    assert.equal(res.status, 0, `enrich exited ${res.status}: ${res.stderr}`);
    assert.ok(res.stdout.includes('# Commodity Market Analysis'), 'enrich missing heading');
    // Structural, not length-based: a valid rates/snapshot report can be short when
    // the upstream news feed is dry (articles are best-effort enrichment — see #11).
    // Assert the core pipeline rendered: the snapshot table + the focus commodity's rate.
    assert.ok(res.stdout.includes('## Market Snapshot'), 'enrich missing market snapshot');
    assert.ok(/Brent Oil/.test(res.stdout), 'enrich missing focus commodity rate');
  });

  // 4b. CNN Trump archive ingestion (issue #7 component 1) pulls a real window.
  await check('fetch-trump-posts CNN archive', () => {
    const res = run(FETCH_POSTS, ['--since', '2026-06-01T00:00:00Z', '--until', '2026-07-01T00:00:00Z'], { timeout: 90000 });
    const out = parseJson(res, 'fetch-trump-posts');
    assert.ok(Array.isArray(out) && out.length > 0, 'archive returned zero posts in window');
    const p = out[0];
    for (const k of ['id', 'createdAtISO', 'text']) assert.ok(p[k], `post missing ${k}`);
    assert.ok(!/[<>]/.test(p.text), 'text still contains HTML tags');
  });

  // 4c. Event study runs single-feed (F2) and returns a status without throwing.
  await check('event-study single-feed', () => {
    const res = run(EVENT_STUDY, ['--at', '2026-07-08T14:35:00Z', '--instrument', 'NAS100/USD', '--market', 'indices', '--pre', '5', '--post', '15'], { timeout: 60000 });
    const out = parseJson(res, 'event-study');
    assert.ok(typeof out.status === 'string', 'event-study missing status');
    assert.equal(out.symbol, 'NAS100/USD');
  });

  // 5. truthsocial FAIL-LOUD (A1) — dead CDP endpoint, no creds needed.
  await check('truthsocial fail-loud (dead CDP)', () => {
    const tmp = mkTmp();
    const res = run(TRUTHSOCIAL, [], {
      env: {
        TRUTHSOCIAL_SOURCE_MODE: 'cdp',
        CDP_BASE_URL: 'http://127.0.0.1:1',
        WORKSPACE_DIR: tmp,
      },
    });
    assert.notEqual(res.status, 0, 'truthsocial did not exit non-zero on dead CDP');
    assert.ok(res.stderr.includes('TRUTHSOCIAL_WATCH_ERROR'), 'missing TRUTHSOCIAL_WATCH_ERROR');
  }, { retries: 1 });

  // 6. truthsocial arg-validation (--help, hermetic).
  await check('truthsocial --help', () => {
    const res = run(TRUTHSOCIAL, ['--help']);
    assert.equal(res.status, 0, `--help exited ${res.status}`);
    assert.ok(res.stdout.includes('truthsocial-trump-watch'), 'help missing usage marker');
    // Help text mentions HEARTBEAT_OK in prose; ensure no bare heartbeat line.
    assert.ok(!res.stdout.split('\n').includes('HEARTBEAT_OK'), 'help unexpectedly printed HEARTBEAT_OK');
  }, { retries: 1 });

  // 7. hormuz arg-validation (missing API key, hermetic).
  await check('hormuz missing API key', () => {
    const env = { ...process.env };
    delete env.AISSTREAM_API_KEY;
    const res = spawnSync('node', [HORMUZ], { encoding: 'utf8', env, timeout: 20000 });
    assert.notEqual(res.status, 0, 'hormuz did not exit non-zero without API key');
    assert.ok(res.stderr.includes('hormuz-ais-watch error:'), 'missing hormuz error prefix');
  }, { retries: 1 });

  // 8. sentinel_news (issue #86): --help + --json shape, both hermetic/offline.
  await check('sentinel_news --help', () => {
    const res = run(SENTINEL_NEWS, ['--help']);
    assert.equal(res.status, 0, `--help exited ${res.status}: ${res.stderr}`);
    assert.ok(res.stdout.includes('market-sentinel'), 'help missing usage marker');
  }, { retries: 1 });

  await check('sentinel_news --json shape (offline)', () => {
    const res = run(SENTINEL_NEWS, ['--instrument', 'WTICO/USD', '--json'], { env: { SENTINEL_NEWS_OFFLINE: '1' } });
    const out = parseJson(res, 'sentinel_news --json');
    assert.ok(Array.isArray(out.items), 'items not an array');
    assert.equal(typeof out.escalation, 'boolean', 'escalation not boolean');
    assert.ok(typeof out.asOf === 'string' && out.asOf.length > 0, 'asOf missing');
    assert.equal(out.meta?.instrument, 'WTICO/USD', 'meta.instrument missing/wrong');
  }, { retries: 1 });

  await check('sentinel_news unconfigured instrument fails loud (never guesses a query)', () => {
    const res = run(SENTINEL_NEWS, ['--instrument', 'ZZZ/USD', '--json']);
    assert.notEqual(res.status, 0, 'did not exit non-zero for an unconfigured instrument');
    assert.match(res.stderr, /no sentinel query configured/);
  }, { retries: 1 });

  // 9. sentinel_briefing (issue #91): the briefing-publisher input that
  // replaces the dried-up FXEmpire market-analysis report (#11/#28). Both
  // checks are offline (fixture-driven), no network.
  await check('sentinel_briefing --help', () => {
    const res = run(SENTINEL_BRIEFING, ['--help']);
    assert.equal(res.status, 0, `--help exited ${res.status}: ${res.stderr}`);
    assert.ok(res.stdout.includes('sentinel_briefing'), 'help missing usage marker');
  }, { retries: 1 });

  await check('sentinel_briefing --fixture renders a valid digest, feeds publish_briefing.mjs --series sentinel', () => {
    const res = run(SENTINEL_BRIEFING, ['--fixture', SENTINEL_BRIEFING_FIXTURE]);
    assert.equal(res.status, 0, `sentinel_briefing exited ${res.status}: ${res.stderr}`);
    assert.ok(res.stdout.includes('# Market Sentinel Briefing'), 'briefing missing title');
    assert.ok(res.stdout.includes('## Escalation summary'), 'briefing missing escalation summary');
    assert.ok(res.stdout.includes('## Headlines by instrument'), 'briefing missing grouped headlines');

    const tmp = mkTmp();
    const inputFile = path.join(tmp, 'sentinel-briefing.md');
    fs.writeFileSync(inputFile, res.stdout);
    const publishRes = run(PUBLISH_BRIEFING, ['--input-file', inputFile, '--series', 'sentinel', '--dry-run']);
    const out = parseJson(publishRes, 'publish_briefing --dry-run');
    assert.equal(out.dryRun, true, 'publish_briefing did not report dryRun');
    assert.equal(out.series, 'sentinel', 'publish_briefing did not accept --series sentinel');
  }, { retries: 1 });

  if (failures.length) {
    process.stderr.write(`\n${failures.length} smoke check(s) failed:\n`);
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }
  process.stdout.write('SMOKE OK\n');
}

main().catch((e) => {
  process.stderr.write(`smoke-skills error: ${e.message}\n`);
  process.exit(1);
});
