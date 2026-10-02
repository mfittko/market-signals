import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs the launcher's start, alive and stop_one helpers against a sleeping script standing in for the api binary.
test('start records the program pid, alive trusts it, stop_one stops it, and an unrelated pid is not trusted', () => {
  const run = mkdtempSync(join(tmpdir(), 'ms-dev-'));
  try {
    mkdirSync(join(run, 'bin'));
    writeFileSync(join(run, 'bin', 'api'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const script = `
      source platform/scripts/dev.sh
      start api "$RUN" "$RUN/bin/api" 30
      sleep 0.3
      pid="$(cat "$RUN/api.pid")"
      alive api && echo alive-ok
      stop_one api
      sleep 0.3
      kill -0 "$pid" 2>/dev/null && echo still-running || echo stopped
      [ -f "$RUN/api.pid" ] || echo pidfile-removed
      sleep 30 & other=$!
      echo "$other" >"$RUN/api.pid"
      alive api && echo trusted-other || echo other-not-trusted
      kill "$other"
    `;
    const r = spawnSync('bash', ['-c', script], { env: { ...process.env, MS_RUN_DIR: run }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), ['alive-ok', 'stopped', 'pidfile-removed', 'other-not-trusted']);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
