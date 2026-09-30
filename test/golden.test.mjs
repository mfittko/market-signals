// Golden-fixture replay: re-runs every recorded input through the Node engine
// and compares with the committed expected output (exact; the JSON round-trip
// of a double is lossless). Format: test/golden/README.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GOLDEN_DIR, FORMAT_VERSION, replayCase, buildFixtures, serialize } from '../scripts/golden-fixtures.mjs';

const files = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json')).sort();
const load = (f) => JSON.parse(readFileSync(join(GOLDEN_DIR, f), 'utf8'));
const GENERATOR = fileURLToPath(new URL('../scripts/golden-fixtures.mjs', import.meta.url));

test('golden: fixture files exist for indicators and portfolio', () => {
  assert.deepEqual(files, ['indicators.json', 'portfolio.json']);
});

for (const f of files) {
  const fx = load(f);
  test(`golden: ${f} declares its format version and area`, () => {
    assert.equal(fx.version, FORMAT_VERSION);
    assert.equal(typeof fx.area, 'string');
    assert.ok(fx.cases.length > 0);
  });
  for (const c of fx.cases) {
    test(`golden replay: ${fx.area} / ${c.name}`, async () => {
      assert.deepEqual(await replayCase(fx.area, c.input, fx.series), c.expected);
    });
  }
}

test('golden: committed fixtures match what the recorder produces', async () => {
  for (const [name, obj] of Object.entries(await buildFixtures())) {
    assert.equal(readFileSync(join(GOLDEN_DIR, name), 'utf8'), serialize(obj), `${name} drifted; run node scripts/golden-fixtures.mjs --write`);
  }
});

test('golden: fixtures are small, path-free and secret-free', () => {
  let total = 0;
  for (const f of files) {
    const p = join(GOLDEN_DIR, f);
    total += statSync(p).size;
    const text = readFileSync(p, 'utf8');
    assert.doesNotMatch(text, /token|secret|password|api[_-]?key|sk-[A-Za-z0-9]{10}/i, `${f} holds secret-like text`);
    // any string value that looks like a filesystem path: POSIX absolute, UNC, drive letter, home or tmp
    const pathLike = (s) => /^(\/|\\\\|[A-Za-z]:[\\/]|~|\.\.?[\\/])/.test(s) || /(^|[\\/])(tmp|Users|home)[\\/]/.test(s);
    const walk = (v) => {
      if (typeof v === 'string') assert.ok(!pathLike(v), `${f} holds a path-like string: ${v}`);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(JSON.parse(text));
  }
  assert.ok(total < 200 * 1024, `fixtures total ${total} bytes, budget 200 KB`);
});

test('golden: the recorder is idempotent and its verify mode fails on drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'golden-cli-'));
  try {
    cpSync(GOLDEN_DIR, dir, { recursive: true });
    const run = (...args) => spawnSync(process.execPath, [GENERATOR, ...args], { env: { ...process.env, GOLDEN_DIR: dir }, encoding: 'utf8' });
    assert.equal(run().status, 0, 'verify passes on a clean copy');
    const before = readFileSync(join(dir, 'portfolio.json'), 'utf8');
    assert.equal(run('--write').status, 0);
    assert.equal(readFileSync(join(dir, 'portfolio.json'), 'utf8'), before, '--write is byte-identical');
    writeFileSync(join(dir, 'portfolio.json'), before.replace('"realized": ', '"realized": 1'));
    assert.equal(run().status, 1, 'verify fails when an expected value is edited');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
