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
    assert.ok(res.stdout.length > 500, 'enrich output too short');
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
