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

// Runs a copy of smoke.sh in a scratch tree with stand-in curl and docker first on PATH. No real service is contacted.
test('smoke.sh switches the private smoke agent off and deletes its shadow position on exit, also when a step fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-smoke-'));
  try {
    const bin = join(dir, 'bin'), scripts = join(dir, 'scripts');
    mkdirSync(bin); mkdirSync(scripts); mkdirSync(join(dir, '.dev'));
    writeFileSync(join(dir, '.dev', 'env'), 'MS_DB_PASSWORD=pw\nMS_INGEST_TOKEN=tok\n');
    writeFileSync(join(scripts, 'smoke.sh'), readFileSync('platform/scripts/smoke.sh'));
    const stub = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    // the health check passes, the agent registers, and the demo proposal comes back invalid, so the run ends through fail()
    stub('curl', 'echo "$*" | tr "\\n" " " >>"$STUB_CURL"; echo >>"$STUB_CURL"; case "$*" in *"/agents"*) ;; *"/health"*) echo \'{"ok":true,"stats":{"workers":[{"online":true}]}}\';; *"-XPOST"*"/runs"*) echo \'{"runs":[{"runId":"r1"}]}\';; *"/runs/r1"*) echo \'{"run":{"status":"succeeded","validation":{"valid":false}}}\';; esac; exit 0');
    stub('docker', 'echo "$*" >>"$STUB_DOCKER"; cat >>"$STUB_DOCKER"');
    const env = { PATH: `${bin}:${process.env.PATH}`, STUB_CURL: join(dir, 'curl.log'), STUB_DOCKER: join(dir, 'docker.log') };
    const r = spawnSync('bash', [join(scripts, 'smoke.sh')], { env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /FAIL: demo proposal invalid/);
    const curls = readFileSync(env.STUB_CURL, 'utf8').trim().split('\n');
    const posts = curls.filter((l) => l.includes('/agents'));
    assert.equal(posts.length, 2, 'registered once, switched off once');
    assert.match(posts[0], /"enabled":true/);
    assert.match(posts[1], /"id":"smoke-mock"[\s\S]*"enabled":false/);
    const docker = readFileSync(env.STUB_DOCKER, 'utf8');
    assert.match(docker, /DELETE FROM shadow_positions WHERE agent_id='smoke-mock' AND instrument='SMOKE\/TEST'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A scratch main checkout with data/, a backup root, and stand-in docker, pg_dump, pg_restore, sqlite3 and launchctl.
// The stand-in launchctl logs each call with the candles.db content at that moment, so the order of stop, copy and
// start is visible.
const backupFixture = (dir) => {
  const bin = join(dir, 'bin'), main = join(dir, 'main'), data = join(main, 'data');
  mkdirSync(bin); mkdirSync(data, { recursive: true });
  const stub = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub('docker', 'shift; [ "$1" = -i ] && shift; shift; exec "$@"');
  stub('pg_dump', 'echo dump');
  stub('pg_restore', 'exit 0');
  stub('sqlite3', `case "$2" in .backup*) cp "$1" "$(echo "$2" | sed "s/^.backup '//; s/'$//")" ;; pragma*) echo ok ;; esac`);
  stub('launchctl', 'case "$1" in print) exit 1 ;; *) echo "$1 $(cat "$DATA/candles.db")" >>"$STUB_LAUNCHCTL" ;; esac');
  writeFileSync(join(data, 'candles.db'), 'old candles');
  writeFileSync(join(data, 'signals.db'), 'old signals');
  const env = { PATH: `${bin}:${process.env.PATH}`, MAIN_DIR: main, DATA: data, HOME: dir, STUB_LAUNCHCTL: join(dir, 'launchctl.log') };
  const run = (body, extra = {}) => sh(`source platform/scripts/backup.sh; MAIN="$MAIN_DIR"; ${body}`, { ...env, ...extra });
  return { main, data, env, run };
};

test('scheduled backup writes a marked folder into backupDir and refuses an unset, in-checkout, missing or unwritable target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-scheduled-'));
  try {
    const { main, data, run } = backupFixture(dir);
    const settings = (backupDir) => writeFileSync(join(data, 'settings.json'), JSON.stringify(backupDir ? { backupDir } : { a: 1 }));
    const target = join(dir, 'target');
    mkdirSync(target);
    settings(target);
    let r = run('scheduled');
    assert.equal(r.status, 0, r.stderr);
    const [folder] = readdirSync(target);
    assert.deepEqual(readdirSync(join(target, folder)).sort(), ['.ms-backup', 'candles.db', 'console.pgdump', 'settings.json', 'signals.db']);

    const inside = join(main, 'tmp', 'backups'), readonly = join(dir, 'readonly');
    mkdirSync(inside, { recursive: true }); mkdirSync(readonly, { mode: 0o500 });
    for (const [value, reason] of [[null, /backupDir is not set/], [inside, /inside the checkout/], [join(dir, 'missing'), /does not exist/], [readonly, /not writable/]]) {
      settings(value);
      r = run('scheduled');
      assert.equal(r.status, 1, `${value}: ${r.stdout}`);
      assert.match(r.stderr, reason);
    }
    assert.deepEqual(readdirSync(inside), []);
    assert.equal(existsSync(join(dir, 'missing')), false);
    assert.deepEqual(readdirSync(readonly), []);
    assert.equal(readdirSync(target).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore-sqlite needs the marker, stops the engine for the copy, starts it again, and keeps a pre-restore copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-restore-sqlite-'));
  try {
    const { data, env, run } = backupFixture(dir);
    writeFileSync(join(data, 'settings.json'), '{"old":true}');
    writeFileSync(join(data, 'candles.db-wal'), 'wal');
    const bk = join(dir, 'bk');
    mkdirSync(bk);
    writeFileSync(join(bk, 'candles.db'), 'new candles');
    writeFileSync(join(bk, 'signals.db'), 'new signals');
    writeFileSync(join(bk, 'settings.json'), '{"new":true}');

    let r = run(`echo restore | restore_sqlite "${bk}"`);
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(env.STUB_LAUNCHCTL), false);
    assert.equal(readFileSync(join(data, 'candles.db'), 'utf8'), 'old candles');

    writeFileSync(join(bk, '.ms-backup'), '');
    r = run(`echo restore | restore_sqlite "${bk}"`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readFileSync(env.STUB_LAUNCHCTL, 'utf8').trim().split('\n'), ['bootout old candles', 'bootstrap new candles']);
    for (const f of ['candles.db', 'signals.db', 'settings.json']) assert.equal(readFileSync(join(data, f), 'utf8'), readFileSync(join(bk, f), 'utf8'));
    assert.equal(existsSync(join(data, 'candles.db-wal')), false);
    const [pre] = readdirSync(data).filter((f) => f.startsWith('.pre-restore-'));
    assert.equal(readFileSync(join(data, pre, 'candles.db'), 'utf8'), 'old candles');
    assert.equal(readFileSync(join(data, pre, 'settings.json'), 'utf8'), '{"old":true}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('switch-launchd writes a daily backup plist without KeepAlive and passes backupDir to the api job', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-plist-'));
  try {
    const r = sh('source platform/scripts/switch-launchd.sh; LA="$DIR"; BACKUP_DIR=/Volumes/b; write_backup_plist; write_plist api', { DIR: dir });
    assert.equal(r.status, 0, r.stderr);
    const plist = readFileSync(join(dir, 'com.market-signals.platform-backup.plist'), 'utf8');
    assert.match(plist, /backup\.sh<\/string>\s*<string>scheduled</);
    assert.match(plist, /<key>Hour<\/key>\s*<integer>3<\/integer>\s*<key>Minute<\/key>\s*<integer>30</);
    assert.doesNotMatch(plist, /KeepAlive/);
    assert.match(plist, /\.dev\/backup\.launchd\.log/);
    assert.match(readFileSync(join(dir, 'com.market-signals.platform-api.plist'), 'utf8'), /<key>MS_BACKUP_DIR<\/key>\s*<string>\/Volumes\/b</);
    if (spawnSync('which', ['plutil']).status === 0) {
      for (const f of readdirSync(dir)) assert.equal(spawnSync('plutil', ['-lint', join(dir, f)]).status, 0, f);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
