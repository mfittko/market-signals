import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../platform/web/next.config.ts';

// The rewrite source compiles like path-to-regexp does it: the custom :path(...) pattern becomes one group,
// matched case-insensitively.
test('the console proxy forwards the API but never the worker runtime protocol', async () => {
  const rules = await config.rewrites();
  assert.equal(rules.length, 1);
  const m = /^\/api\/v1\/:path\((.*)\)$/.exec(rules[0].source);
  assert.ok(m, `unexpected rewrite source ${rules[0].source}`);
  assert.match(rules[0].destination, /\/api\/v1\/:path$/);
  const re = new RegExp(`^/api/v1/(${m[1]})$`, 'i');
  for (const p of ['/api/v1/settings', '/api/v1/runs/1', '/api/v1/stream', '/api/v1/runtimes', '/api/v1/strategies/grill']) {
    assert.ok(re.test(p), `${p} must be proxied`);
  }
  for (const p of ['/api/v1/runtime', '/api/v1/runtime/', '/api/v1/runtime/llm-config', '/api/v1/runtime/claim', '/api/v1/RUNTIME/llm-config']) {
    assert.ok(!re.test(p), `${p} must not be proxied`);
  }
});
