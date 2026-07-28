// #195: uiRefreshDelayMs is a small pure helper embedded in vendor/app.html
// (no build step separates client JS into an importable module) — extracted
// verbatim here (source-of-truth stays app.html) and eval'd in isolation so
// the cadence math has a real, runnable unit check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const appHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../vendor/app.html'), 'utf8');

function extract(name) {
  const start = appHtml.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in vendor/app.html`);
  let depth = 0;
  let end = start;
  for (let i = appHtml.indexOf('{', start); i < appHtml.length; i++) {
    if (appHtml[i] === '{') depth++;
    else if (appHtml[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return appHtml.slice(start, end);
}

function extractConst(name) {
  const start = appHtml.indexOf(`const ${name} =`);
  if (start === -1) throw new Error(`${name} not found in vendor/app.html`);
  const end = appHtml.indexOf(';', start) + 1;
  return appHtml.slice(start, end);
}

// eslint-disable-next-line no-new-func
const UI_REFRESH_DEFAULT_MS = new Function(`${extractConst('UI_REFRESH_DEFAULT_MS')}; return UI_REFRESH_DEFAULT_MS;`)();
// eslint-disable-next-line no-new-func
const uiRefreshDelayMs = new Function('UI_REFRESH_DEFAULT_MS', `${extract('uiRefreshDelayMs')}; return uiRefreshDelayMs;`)(UI_REFRESH_DEFAULT_MS);
// eslint-disable-next-line no-new-func
const resolvePollGran = new Function(`${extract('resolvePollGran')}; return resolvePollGran;`)();

test('resolvePollGran: an explicit ?granularity= query param always wins', () => {
  assert.equal(resolvePollGran('M1', 'M5'), 'M1');
});

test('resolvePollGran: falls back to the server-served granularity when no query param is present', () => {
  assert.equal(resolvePollGran(null, 'M1'), 'M1');
  assert.equal(resolvePollGran('', 'M15'), 'M15');
});

test('resolvePollGran: falls back to M5 when neither is set', () => {
  assert.equal(resolvePollGran(null, null), 'M5');
});

test('uiRefreshDelayMs: granularity-scaled defaults when the map is unset', () => {
  assert.equal(uiRefreshDelayMs('M1', null), 3000);
  assert.equal(uiRefreshDelayMs('M5', null), 10000);
  assert.equal(uiRefreshDelayMs('M15', null), 30000);
  assert.equal(uiRefreshDelayMs('M30', null), 60000);
  assert.equal(uiRefreshDelayMs('H1', null), 60000);
  assert.equal(uiRefreshDelayMs('H4', null), 60000);
});

test('uiRefreshDelayMs: a map entry overrides its granularity default', () => {
  assert.equal(uiRefreshDelayMs('M1', { M1: 2 }), 2000);
  assert.equal(uiRefreshDelayMs('M5', { M1: 2 }), 10000, 'unset key in the map still falls back to its own default');
});

test('uiRefreshDelayMs: an invalid override (< 2s, non-integer, missing) falls back to the default', () => {
  assert.equal(uiRefreshDelayMs('M1', { M1: 1 }), 3000, 'below the 2s floor: default wins');
  assert.equal(uiRefreshDelayMs('M1', { M1: 2.5 }), 3000, 'non-integer: default wins');
  assert.equal(uiRefreshDelayMs('M1', {}), 3000);
});
