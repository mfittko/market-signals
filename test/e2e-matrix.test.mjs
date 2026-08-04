import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// CI shards the walkthrough by E2E_VIEWPORT, one matrix entry per viewport. A
// local run sets no E2E_VIEWPORT and iterates every viewport in the map, so a
// viewport added to the map but not to the workflow passes locally and never
// runs in CI at all — the guard looks present and is not exercised. That is how
// the two breakpoint cells, added specifically to pin a 1px regression, shipped
// with no CI coverage. This fails the moment the two lists diverge again.
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('e2e CI matrix lists every viewport the walkthrough defines', () => {
  const spec = read('./e2e/walkthrough.e2e.mjs');
  const block = spec.match(/const VIEWPORTS\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(block, 'could not locate the VIEWPORTS map — update this guard if it was renamed');
  const defined = [...block[1].matchAll(/^\s*'([\w-]+)'\s*:/gm)].map((m) => m[1]);
  assert.ok(defined.length >= 4, `parsed too few viewports (${defined.length}) — the guard is not reading the map`);

  const wf = read('../.github/workflows/e2e.yml');
  const matrix = wf.match(/viewport:\n((?:\s*-\s*[\w-]+\n)+)/);
  assert.ok(matrix, 'could not locate the viewport matrix in .github/workflows/e2e.yml');
  const shipped = [...matrix[1].matchAll(/-\s*([\w-]+)/g)].map((m) => m[1]);

  assert.deepEqual(
    [...defined].sort(),
    [...shipped].sort(),
    `viewports defined in the walkthrough and listed in the CI matrix must match exactly.\n  defined: ${defined.join(', ')}\n  in CI:   ${shipped.join(', ')}`,
  );
});
