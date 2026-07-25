import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseArgs, isMain } from '../scripts/lib/cli.mjs';

test('parseArgs: --flag value pairs, --bool flags, extra args ignored', () => {
  const a = parseArgs(['--instrument', 'WTICO/USD', '--pre', '5', '--json', '--market', 'commodities']);
  assert.equal(a.get('instrument'), 'WTICO/USD');
  assert.equal(a.get('pre'), '5');
  assert.equal(a.get('market'), 'commodities');
  assert.equal(a.get('json'), true, 'a --flag with no value is boolean true');
  assert.ok(a.has('json'));
  assert.equal(a.get('missing'), undefined);
});

test('parseArgs: --flag immediately followed by another --flag is boolean, not the flag name', () => {
  const a = parseArgs(['--verbose', '--out', 'x.json']);
  assert.equal(a.get('verbose'), true, 'consumes no value when the next token is a flag');
  assert.equal(a.get('out'), 'x.json');
});

test('parseArgs: empty argv → empty map', () => {
  assert.equal(parseArgs([]).size, 0);
});

test('isMain: true only when process.argv[1] resolves to the module url (spaces/symlinks safe)', () => {
  const here = import.meta.url;
  const savedArgv1 = process.argv[1];
  try {
    process.argv[1] = fileURLToPath(here);
    assert.equal(isMain(here), true, 'resolved path matches → main');
    process.argv[1] = '/some/other/script.mjs';
    assert.equal(isMain(here), false, 'different path → not main');
    process.argv[1] = undefined;
    assert.equal(isMain(here), false, 'no argv[1] → not main (never throws)');
  } finally {
    process.argv[1] = savedArgv1;
  }
});
