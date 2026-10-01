import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sh = (script, env) => spawnSync('bash', ['-c', script], { env: { ...process.env, ...env }, encoding: 'utf8' });

// Sources switch-launchd.sh (its dispatch only runs when executed directly) and calls edit_settings on a scratch file.
test('edit_settings replaces the file atomically, and a jq failure leaves the original and no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-settings-'));
  try {
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{"a":1}');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'mv'), "#!/bin/sh\necho \"mv:$*\" >&2\nexec /bin/mv \"$@\"\n", { mode: 0o755 });
    const run = (body) => sh(`source platform/scripts/switch-launchd.sh; SETTINGS="$DIR/settings.json"; ${body}`, { DIR: dir, PATH: `${bin}:${process.env.PATH}` });

    let r = run(`
      edit_settings --arg u http://x '.consoleUrl = $u'`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`mv:-f ${dir}/settings\\.json\\.\\w+ ${dir}/settings\\.json`));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 1, consoleUrl: 'http://x' });
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('settings')), ['settings.json']);

    writeFileSync(file, '{not json');
    r = run(`edit_settings '.b = 2'`);
    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(file, 'utf8'), '{not json');
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('settings')), ['settings.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Runs backup.sh against a scratch dir with stand-in docker, pg_dump, pg_restore and sqlite3 first on PATH.
test('backup marks a folder only after the dump verifies, a failing run leaves no folder, and restore needs the marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-backup-'));
  try {
    const bin = join(dir, 'bin'), dest = join(dir, 'dest');
    mkdirSync(bin);
    const stub = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    // docker exec [-i] <container> <cmd...> runs the stand-in command
    stub('docker', 'shift; [ "$1" = -i ] && shift; shift; exec "$@"');
    stub('pg_dump', 'echo dump');
    stub('pg_restore', 'if [ "$1" = --list ]; then [ -z "$STUB_BAD_DUMP" ]; else echo "$@" >>"$STUB_LOG"; fi');
    stub('sqlite3', 'exit 0');
    const env = { PATH: `${bin}:${process.env.PATH}`, STUB_LOG: join(dir, 'log') };
    const backup = (extra = {}) => sh(`source platform/scripts/backup.sh; MAIN="$DIR"; backup "$DIR/dest"`, { ...env, DIR: dir, ...extra });

    let r = backup();
    assert.equal(r.status, 0, r.stderr);
    const [folder] = readdirSync(dest);
    assert.ok(existsSync(join(dest, folder, '.ms-backup')));
    assert.ok(existsSync(join(dest, folder, 'console.pgdump')));

    rmSync(dest, { recursive: true });
    r = backup({ STUB_BAD_DUMP: '1' });
    assert.notEqual(r.status, 0);
    assert.deepEqual(readdirSync(dest), []);

    const restore = (d) => sh(`source platform/scripts/backup.sh; echo restore | restore "${d}"`, env);
    const unmarked = join(dir, 'unmarked');
    mkdirSync(unmarked);
    writeFileSync(join(unmarked, 'console.pgdump'), 'x');
    r = restore(unmarked);
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(env.STUB_LOG), false);

    writeFileSync(join(unmarked, '.ms-backup'), '');
    r = restore(unmarked);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(env.STUB_LOG, 'utf8'), /--single-transaction/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
