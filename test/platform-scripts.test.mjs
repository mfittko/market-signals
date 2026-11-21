import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

// dev.sh keeps the shared development database password under $XDG_CONFIG_HOME, so no test touches the real one.
// Each test that reaches dev_db_password also sets its own scratch XDG_CONFIG_HOME, so no test sees another's password.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'ms-xdg-'));
after(() => rmSync(process.env.XDG_CONFIG_HOME, { recursive: true, force: true }));
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
    // STUB_DATE pins the folder timestamp, so a second run in the same second can be staged
    stub('date', 'if [ -n "$STUB_DATE" ] && [ "$1" = +%Y%m%d-%H%M%S ]; then echo "$STUB_DATE"; else exec /bin/date "$@"; fi');
    const env = { PATH: `${bin}:${process.env.PATH}`, STUB_LOG: join(dir, 'log') };
    // the manual path creates the root first, as the dispatch does
    const backup = (extra = {}) => sh(`source platform/scripts/backup.sh; MAIN="$DIR"; mkdir -p "$DIR/dest"; backup "$DIR/dest"`, { ...env, DIR: dir, ...extra });

    let r = backup();
    assert.equal(r.status, 0, r.stderr);
    const [folder] = readdirSync(dest);
    assert.ok(existsSync(join(dest, folder, '.ms-backup')));
    assert.ok(existsSync(join(dest, folder, 'console.pgdump')));

    rmSync(dest, { recursive: true });
    r = backup({ STUB_BAD_DUMP: '1' });
    assert.notEqual(r.status, 0);
    assert.deepEqual(readdirSync(dest), []);

    // another run already writes 20260101-000000: this run fails and leaves that folder as it is
    mkdirSync(join(dest, '20260101-000000'));
    writeFileSync(join(dest, '20260101-000000', 'console.pgdump'), 'other run');
    r = backup({ STUB_DATE: '20260101-000000', STUB_BAD_DUMP: '1' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already exists/);
    assert.deepEqual(readdirSync(join(dest, '20260101-000000')), ['console.pgdump']);
    assert.equal(readFileSync(join(dest, '20260101-000000', 'console.pgdump'), 'utf8'), 'other run');
    rmSync(join(dest, '20260101-000000'), { recursive: true });

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
    mkdirSync(bin); mkdirSync(scripts); mkdirSync(join(dir, '.dev', 'dev'), { recursive: true });
    writeFileSync(join(dir, '.dev', 'dev', 'env'), 'MS_DEV_DB_PASSWORD=pw\nMS_INGEST_TOKEN=tok\nMS_DATABASE_URL=postgres://ms_dev:pw@127.0.0.1:5544/ms_dev\n');
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
    // by default the smoke run targets the development stack: its API port and its database, never the live ms
    assert.ok(curls.every((l) => !l.includes(':8080')), 'no call reaches the live API');
    assert.match(curls.find((l) => l.includes('/agents')), /127\.0\.0\.1:8081\/api\/v1\/agents/);
    assert.match(docker, /psql -q -U ms -d ms_dev\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A scratch main checkout with data/, a backup root, and stand-in docker, pg_dump, pg_restore, sqlite3, launchctl
// and lsof. The stand-in launchctl logs each call with the candles.db content at that moment, so the order of stop,
// copy and start is visible. The engine job counts as loaded while the STUB_LOADED file exists. The stand-in sqlite3
// reports the file named in STUB_CORRUPT as damaged, and the stand-in lsof reports a holder for STUB_HELD.
const backupFixture = (dir) => {
  const bin = join(dir, 'bin'), main = join(dir, 'main'), data = join(main, 'data');
  mkdirSync(bin); mkdirSync(data, { recursive: true });
  const stub = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub('docker', 'shift; [ "$1" = -i ] && shift; shift; exec "$@"');
  stub('pg_dump', 'echo dump');
  stub('pg_restore', 'exit 0');
  // STUB_BACKUP_RM: the rollback .backup also removes that folder, like a prune landing during the rollback copy
  stub('sqlite3', `case "$2" in .backup*) cp "$1" "$(echo "$2" | sed "s/^.backup '//; s/'$//")"; rm -rf "\${STUB_BACKUP_RM:-/nonexistent-ms-stub}" ;; pragma*) if [ "$1" = "$STUB_CORRUPT" ]; then echo corrupt; else echo ok; fi ;; esac`);
  // STUB_STUCK keeps the job loaded after bootout for that many print calls, like a slow engine shutdown; like
  // launchd, bootstrap fails while the job is loaded; sleep returns at once
  stub('sleep', 'exit 0');
  stub('launchctl', [
    'n=$(cat "$STUB_PRINTS" 2>/dev/null || echo 0)',
    'loaded() { [ -f "$STUB_LOADED" ] || [ "$n" -le "${STUB_STUCK:-0}" ]; }',
    'case "$1" in',
    '  print) n=$((n + 1)); echo "$n" >"$STUB_PRINTS"; loaded ;;',
    '  bootstrap) if loaded; then echo "bootstrap refused: already loaded" >>"$STUB_LAUNCHCTL"; exit 5; fi',
    '    echo "bootstrap $(cat "$DATA/candles.db")" >>"$STUB_LAUNCHCTL"; : >"$STUB_LOADED" ;;',
    // STUB_BOOTOUT_RM: bootout also removes that folder, like the scheduled prune running while the prompt waits
    '  *) echo "$1 $(cat "$DATA/candles.db")" >>"$STUB_LAUNCHCTL"; [ "$1" = bootout ] && rm -f "$STUB_LOADED" && rm -rf "${STUB_BOOTOUT_RM:-/nonexistent-ms-stub}" ;;',
    'esac',
  ].join('\n'));
  stub('lsof', 'case "$*" in *"$STUB_HELD"*) [ -n "$STUB_HELD" ] && echo 4242 && exit 0 ;; esac; exit 1');
  writeFileSync(join(data, 'candles.db'), 'old candles');
  writeFileSync(join(data, 'signals.db'), 'old signals');
  const env = { PATH: `${bin}:${process.env.PATH}`, MAIN_DIR: main, DATA: data, HOME: dir, STUB_LAUNCHCTL: join(dir, 'launchctl.log'), STUB_LOADED: join(dir, 'loaded'), STUB_PRINTS: join(dir, 'prints') };
  const run = (body, extra = {}) => sh(`source platform/scripts/backup.sh; MAIN="$MAIN_DIR"; ${body}`, { ...env, ...extra });
  return { main, data, env, run };
};

// A marked backup folder with new copies of the three files.
const backupFolder = (dir) => {
  const bk = join(dir, 'bk');
  mkdirSync(bk);
  writeFileSync(join(bk, 'candles.db'), 'new candles');
  writeFileSync(join(bk, 'signals.db'), 'new signals');
  writeFileSync(join(bk, 'settings.json'), '{"new":true}');
  writeFileSync(join(bk, '.ms-backup'), '');
  return bk;
};

test('scheduled backup writes a marked folder into backupDir and refuses an unset, relative, in-checkout, missing or unwritable target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-scheduled-'));
  try {
    const { main, data, run } = backupFixture(dir);
    const settings = (backupDir) => writeFileSync(join(data, 'settings.json'), JSON.stringify(backupDir ? { backupDir } : { a: 1 }));
    // accepted: a root on another disk (like /Volumes/Backup/ms), one whose name has a space (like /Volumes/Backup SSD/ms)
    // and a root beside the checkout (like /Users/me/Backups/ms)
    const target = join(dir, 'target'), spaced = join(dir, 'Backup SSD', 'ms'), beside = join(dir, 'Backups', 'ms');
    mkdirSync(target); mkdirSync(spaced, { recursive: true }); mkdirSync(beside, { recursive: true });
    for (const root of [target, spaced, beside]) {
      settings(root);
      const r = run('scheduled');
      assert.equal(r.status, 0, `${root}: ${r.stderr}`);
      const [folder] = readdirSync(root);
      assert.deepEqual(readdirSync(join(root, folder)).sort(), ['.ms-backup', 'candles.db', 'console.pgdump', 'settings.json', 'signals.db']);
    }

    // refused: the checkout itself (like /Users/me/github/market-signals), a folder in it (like .../tmp/backups),
    // and that folder typed in another case (like /users/me/...), which a case-insensitive disk resolves to the same folder
    const inside = join(main, 'tmp', 'backups'), readonly = join(dir, 'readonly');
    mkdirSync(inside, { recursive: true }); mkdirSync(readonly, { mode: 0o500 });
    const caseVariant = join(dir, 'MAIN', 'tmp', 'backups');
    // a single quote would end the sqlite3 .backup argument early, so it is refused before any folder is touched
    const quoted = ["/Volumes/Mike's SSD/ms", "/tmp/a'b"];
    const refused = [[null, /backupDir is not set/], ['relative/ms', /must be an absolute path/], ...quoted.map((q) => [q, /must not contain a single quote/]), [main, /inside the checkout/], [inside, /inside the checkout/], [join(dir, 'missing'), /does not exist/], [readonly, /not writable/]];
    if (existsSync(caseVariant)) refused.push([caseVariant, /inside the checkout/]); // skipped on a case-sensitive disk
    for (const [value, reason] of refused) {
      settings(value);
      const r = run('scheduled');
      assert.equal(r.status, 1, `${value}: ${r.stdout}`);
      assert.match(r.stderr, reason);
    }
    // a settings file that is not valid JSON, or no settings file, names that cause instead of an unset key
    writeFileSync(join(data, 'settings.json'), '{"backupDir": "/x",}');
    let r = run('scheduled');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not be read as JSON/);
    rmSync(join(data, 'settings.json'));
    r = run('scheduled');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /settings\.json is missing/);
    // a root that vanishes after the checks (an unmounted disk) is not created by backup() itself
    r = run(`backup "${join(dir, 'gone')}"`);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /root is missing/);
    assert.equal(existsSync(join(dir, 'gone')), false);

    for (const q of quoted) assert.equal(existsSync(q), false, q);
    assert.deepEqual(readdirSync(inside), []);
    assert.deepEqual(readdirSync(main).sort(), ['data', 'tmp']);
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
    writeFileSync(env.STUB_LOADED, '');
    const bk = backupFolder(dir);
    rmSync(join(bk, '.ms-backup'));

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

test('restore-sqlite refuses a damaged backup file and a held database with nothing changed, and starts the engine again after a failed copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-restore-fail-'));
  try {
    const live = (data) => ['candles.db', 'signals.db'].map((f) => readFileSync(join(data, f), 'utf8'));
    const preFolders = (data) => readdirSync(data).filter((f) => f.startsWith('.pre-restore-'));

    // the backup's signals.db is damaged: refused before the engine stops or a live file changes
    let case_ = join(dir, 'corrupt-backup'); mkdirSync(case_);
    let { data, env, run } = backupFixture(case_);
    writeFileSync(env.STUB_LOADED, '');
    let bk = backupFolder(case_);
    let r = run(`echo restore | restore_sqlite "${bk}"`, { STUB_CORRUPT: join(bk, 'signals.db') });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /backup file failed its integrity check/);
    assert.equal(existsSync(env.STUB_LAUNCHCTL), false);
    assert.deepEqual(live(data), ['old candles', 'old signals']);
    assert.deepEqual(preFolders(data), []);

    // the restored candles.db fails the post-copy check: exit 1, the engine job starts again, the old files are kept
    case_ = join(dir, 'corrupt-copy'); mkdirSync(case_);
    ({ data, env, run } = backupFixture(case_));
    writeFileSync(env.STUB_LOADED, '');
    bk = backupFolder(case_);
    r = run(`echo restore | restore_sqlite "${bk}"`, { STUB_CORRUPT: join(data, 'candles.db') });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /restored file failed its integrity check/);
    assert.deepEqual(readFileSync(env.STUB_LAUNCHCTL, 'utf8').trim().split('\n'), ['bootout old candles', 'bootstrap new candles']);
    const [pre] = preFolders(data);
    assert.equal(readFileSync(join(data, pre, 'candles.db'), 'utf8'), 'old candles');
    assert.equal(readFileSync(join(data, pre, 'signals.db'), 'utf8'), 'old signals');

    // an engine runs outside launchd and holds candles.db: refused, no job is stopped or started, the live files stay
    case_ = join(dir, 'held'); mkdirSync(case_);
    ({ data, env, run } = backupFixture(case_));
    bk = backupFolder(case_);
    r = run(`echo restore | restore_sqlite "${bk}"`, { STUB_HELD: join(data, 'candles.db') });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /still holds .*candles\.db/);
    assert.equal(existsSync(env.STUB_LAUNCHCTL), false);
    assert.deepEqual(live(data), ['old candles', 'old signals']);
    assert.deepEqual(preFolders(data), []); // the rollback copy is taken only after the stop and the holder check

    // the engine job unloads only after the 10 s wait (21 print calls) gives up: exit 1, nothing changes, and the
    // restart waits for the unload, so the bootstrap succeeds and the job is loaded again
    case_ = join(dir, 'stuck'); mkdirSync(case_);
    ({ data, env, run } = backupFixture(case_));
    writeFileSync(env.STUB_LOADED, '');
    bk = backupFolder(case_);
    r = run(`echo restore | restore_sqlite "${bk}"`, { STUB_STUCK: '25' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /was asked to stop but did not stop/);
    assert.doesNotMatch(r.stderr, /could not start/);
    assert.equal(existsSync(env.STUB_LOADED), true);
    assert.deepEqual(readFileSync(env.STUB_LAUNCHCTL, 'utf8').trim().split('\n'), ['bootout old candles', 'bootstrap old candles']);
    assert.deepEqual(live(data), ['old candles', 'old signals']);
    assert.deepEqual(preFolders(data), []);

    // the backup folder vanishes after the confirmation (the prune ran while the prompt waited): exit 1, nothing is
    // restored, and the engine job starts again after the bootout
    case_ = join(dir, 'vanished'); mkdirSync(case_);
    ({ data, env, run } = backupFixture(case_));
    writeFileSync(env.STUB_LOADED, '');
    bk = backupFolder(case_);
    r = run(`echo restore | restore_sqlite "${bk}"`, { STUB_BOOTOUT_RM: bk });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /backup folder changed after the check .*nothing was restored/);
    assert.doesNotMatch(r.stdout, /restored\./);
    assert.deepEqual(readFileSync(env.STUB_LAUNCHCTL, 'utf8').trim().split('\n'), ['bootout old candles', 'bootstrap old candles']);
    assert.deepEqual(live(data), ['old candles', 'old signals']);
    assert.deepEqual(preFolders(data), []);

    // the backup folder vanishes during the rollback copy, after the re-check: exit 1, no "restored.", the engine
    // job starts again, and the old files are kept in the pre-restore folder
    case_ = join(dir, 'vanished-late'); mkdirSync(case_);
    ({ data, env, run } = backupFixture(case_));
    writeFileSync(env.STUB_LOADED, '');
    bk = backupFolder(case_);
    r = run(`echo restore | restore_sqlite "${bk}"`, { STUB_BACKUP_RM: bk });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /backup folder changed during the restore .*restore incomplete/);
    assert.doesNotMatch(r.stdout, /restored\./);
    assert.deepEqual(readFileSync(env.STUB_LAUNCHCTL, 'utf8').trim().split('\n'), ['bootout old candles', 'bootstrap old candles']);
    assert.deepEqual(live(data), ['old candles', 'old signals']);
    const [late] = preFolders(data);
    assert.equal(readFileSync(join(data, late, 'candles.db'), 'utf8'), 'old candles');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('switch-launchd writes a daily backup plist without KeepAlive and passes backupDir to the api job', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-plist-'));
  try {
    // a legal absolute path with XML specials must still give a valid plist
    const r = sh('source platform/scripts/switch-launchd.sh; LA="$DIR"; BACKUP_DIR="/Volumes/Backup & Sync/<ms>"; write_backup_plist; write_rotate_plist; write_plist api', { DIR: dir });
    assert.equal(r.status, 0, r.stderr);
    const plist = readFileSync(join(dir, 'com.market-signals.platform-backup.plist'), 'utf8');
    assert.match(plist, /backup\.sh<\/string>\s*<string>scheduled</);
    assert.match(plist, /<key>Hour<\/key>\s*<integer>3<\/integer>\s*<key>Minute<\/key>\s*<integer>30</);
    assert.doesNotMatch(plist, /KeepAlive/);
    assert.match(plist, /\.dev\/backup\.launchd\.log/);
    assert.match(readFileSync(join(dir, 'com.market-signals.platform-rotate-logs.plist'), 'utf8'), /rotate-logs\.sh<\/string>\s*<\/array>[\s\S]*<key>Hour<\/key>\s*<integer>4</);
    assert.match(readFileSync(join(dir, 'com.market-signals.platform-api.plist'), 'utf8'), /<key>MS_BACKUP_DIR<\/key>\s*<string>\/Volumes\/Backup &amp; Sync\/&lt;ms&gt;<\/string>/);
    if (spawnSync('which', ['plutil']).status === 0) {
      for (const f of readdirSync(dir)) assert.equal(spawnSync('plutil', ['-lint', join(dir, f)]).status, 0, f);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Sources switch-launchd.sh with LA in a scratch dir and a stand-in launchctl that treats a job as loaded while
// its loaded-<label> file exists.
test('rollback removal unloads the backup job and deletes its plist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-remove-'));
  try {
    const bin = join(dir, 'bin'), la = join(dir, 'la');
    mkdirSync(bin); mkdirSync(la);
    writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\ncase "$1" in print) [ -f "$DIR/loaded-${2##*/}" ] ;; bootout) echo "bootout $2" >>"$DIR/launchctl.log"; rm -f "$DIR/loaded-${2##*/}" ;; esac\n', { mode: 0o755 });
    const label = 'com.market-signals.platform-backup';
    writeFileSync(join(dir, `loaded-${label}`), '');
    const r = sh(`source platform/scripts/switch-launchd.sh; LA="$DIR/la"; write_backup_plist; remove_console`, { DIR: dir, PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.status, 0, r.stderr);
    const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim();
    assert.deepEqual(readFileSync(join(dir, 'launchctl.log'), 'utf8').trim().split('\n'), [`bootout gui/${uid}/${label}`]);
    assert.deepEqual(readdirSync(la), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A scratch platform tree with an old build, and stand-in go, pnpm, launchctl, curl, git and sleep first on PATH.
// go writes the api binary before it can fail, and pnpm writes a half build before it fails, like a real broken build.
// curl serves STUB_SERVED as the console's build.commit; git reports HEAD as "want".
const deployFixture = (dir) => {
  const bin = join(dir, 'bin'), plat = join(dir, 'plat');
  for (const d of [bin, join(dir, 'la'), join(plat, 'scripts'), join(plat, '.dev', 'bin'), join(plat, 'web', '.next'), join(plat, 'web', 'node_modules')]) mkdirSync(d, { recursive: true });
  const stub = (path, body) => writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub(join(plat, 'scripts', 'dev.sh'), 'exit 0');
  for (const f of ['api', 'worker']) writeFileSync(join(plat, '.dev', 'bin', f), 'old');
  writeFileSync(join(plat, 'web', '.next', 'BUILD'), 'old');
  stub(join(bin, 'go'), 'while [ "$1" != -o ]; do shift; done; mkdir -p "$2"; echo new >"$2/api"; [ -z "$STUB_GO_FAIL" ] || exit 1; echo new >"$2/worker"');
  stub(join(bin, 'pnpm'), '[ -z "$STUB_PNPM_TERM" ] || { echo half >.next/BUILD; kill -TERM "$DEPLOY_PID"; exit 1; }; [ -z "$STUB_PNPM_FAIL" ] || { echo half >.next/BUILD; exit 1; }; echo new >.next/BUILD');
  stub(join(bin, 'launchctl'), '[ "$1" = bootstrap ] && { [ -z "$STUB_BOOTSTRAP_FAIL" ] || exit 1; echo "bootstrap ${3##*/}" >>"$DIR/launchctl.log"; }; [ "$1" != print ]');
  stub(join(bin, 'curl'), 'echo "{\\"build\\":{\\"commit\\":\\"$STUB_SERVED\\"}}"');
  stub(join(bin, 'git'), 'case "$*" in *"rev-parse HEAD") echo want ;; *) exec /usr/bin/git "$@" ;; esac');
  stub(join(bin, 'sleep'), 'exit 0');
  // STUB_CP_TERM sends TERM while restore_build copies a .prev folder back
  stub(join(bin, 'cp'), 'case "$2" in *.prev) [ -z "$STUB_CP_TERM" ] || kill -TERM "$DEPLOY_PID" ;; esac; exec /bin/cp "$@"');
  const read = (...p) => readFileSync(join(plat, ...p), 'utf8').trim();
  const deploy = (extra) => sh('export DEPLOY_PID=$$; source platform/scripts/switch-launchd.sh; PLAT="$DIR/plat"; LA="$DIR/la"; install_console', { DIR: dir, PATH: `${bin}:${process.env.PATH}`, STUB_SERVED: 'want', ...extra });
  return { read, deploy, log: () => readFileSync(join(dir, 'launchctl.log'), 'utf8') };
};

test('install_console keeps the previous build, restores it after a failed build, a served commit mismatch or a failed reload after the swap, and reloads the jobs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-deploy-'));
  try {
    const cases = [
      [{}, 0, null, 'new'],
      [{ STUB_GO_FAIL: '1' }, 1, /the Go build failed; restoring the previous build/, 'old'],
      [{ STUB_PNPM_FAIL: '1' }, 1, /the console build failed; restoring the previous build/, 'old'],
      // a TERM during next build, after it wrote into the live .next: the trap restores the previous build
      [{ STUB_PNPM_TERM: '1' }, 1, /restoring the previous build/, 'old'],
      // a second TERM during the restore copy: the restore still finishes and reloads the jobs
      [{ STUB_PNPM_FAIL: '1', STUB_CP_TERM: '1' }, 1, /the console build failed; restoring the previous build/, 'old'],
      [{ STUB_SERVED: 'other' }, 1, /serves commit other, but the build is want/, 'old'],
      [{ STUB_SERVED: '' }, 1, /did not answer on port/, 'old'],
      // launchctl bootstrap fails after the binary swap: load dies, and the exit trap restores the previous build
      [{ STUB_BOOTSTRAP_FAIL: '1' }, 1, /the deploy stopped before the new build was verified; restoring the previous build/, 'old'],
    ];
    for (const [i, [env, status, err, want]] of cases.entries()) {
      const caseDir = join(dir, String(i));
      mkdirSync(caseDir);
      const { read, deploy, log } = deployFixture(caseDir);
      const r = deploy(env);
      assert.equal(r.status, status, `${JSON.stringify(env)}: ${r.stderr}`);
      if (err) assert.match(r.stderr, err);
      for (const f of [['.dev', 'bin', 'api'], ['.dev', 'bin', 'worker'], ['web', '.next', 'BUILD']]) assert.equal(read(...f), want, `${JSON.stringify(env)} ${f.join('/')}`);
      assert.equal(read('.dev', 'bin.prev', 'api'), 'old');
      assert.equal(read('web', '.next.prev', 'BUILD'), 'old');
      if (!env.STUB_BOOTSTRAP_FAIL) for (const j of ['api', 'worker', 'web']) assert.match(log(),new RegExp(`bootstrap com\\.market-signals\\.platform-${j}\\.plist`));
      if (status === 0) assert.match(log(), /bootstrap com\.market-signals\.platform-rotate-logs\.plist/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotate-logs gzips a log over 10 MB, truncates it in place, keeps 7 copies, and an append-mode writer keeps writing to the live file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-rotate-'));
  try {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 'a');
    writeFileSync(join(dir, 'api.launchd.log'), big);
    writeFileSync(join(dir, 'worker.launchd.log'), 'small\n');
    for (let i = 1; i <= 8; i++) writeFileSync(join(dir, `api.launchd.log.20250101-00000${i}.gz`), '');
    // the open descriptor stands in for launchd, which opens StandardOutPath in append mode
    const r = sh('exec 3>>"$DIR/api.launchd.log"; bash platform/scripts/rotate-logs.sh "$DIR"; echo after >&3', { DIR: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dir, 'api.launchd.log'), 'utf8'), 'after\n');
    assert.equal(readFileSync(join(dir, 'worker.launchd.log'), 'utf8'), 'small\n');
    const kept = readdirSync(dir).filter((f) => f.startsWith('api.launchd.log.')).sort();
    assert.equal(kept.length, 7);
    assert.deepEqual(kept.slice(0, 2), ['api.launchd.log.20250101-000003.gz', 'api.launchd.log.20250101-000004.gz']);
    assert.deepEqual(gunzipSync(readFileSync(join(dir, kept[6]))), big);
    assert.equal(readdirSync(dir).some((f) => f.startsWith('worker.launchd.log.')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every line dev.sh prints for a launchd job carries a time and a level', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-devlog-'));
  try {
    writeFileSync(join(dir, 'llm.json'), '{"OPENAI_API_KEY":"k","OPENAI_BASE_URL":"http://x"}');
    writeFileSync(join(dir, 'none.json'), '{}');
    const r = sh('source platform/scripts/dev.sh; load_env; MS_SETTINGS="$DIR/llm.json" llm_env; MS_SETTINGS="$DIR/none.json" llm_env; die boom', { DIR: dir, MS_RUN_DIR: dir });
    assert.equal(r.status, 1);
    const lines = (r.stdout + r.stderr).trim().split('\n');
    assert.equal(lines.length, 4, lines.join('\n'));
    for (const l of lines) assert.match(l, /^time=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d{4} level=(INFO|WARN|ERROR) msg="/);
    assert.match(r.stderr, /level=ERROR msg="boom"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A scratch platform tree for `dev.sh up` with stand-in docker, go, pnpm and curl first on PATH. The built api and
// worker and the console record their address, API URL and database name and then stay up (at most 30 s) until
// stop() ends them, so up's post-start alive checks see them; the api also logs the real api's listening line. No
// real service is contacted. `api` replaces the built api's script, `web` the console's and `curl` the curl stub.
const devUpFixture = (dir, { api, web, curl } = {}) => {
  const bin = join(dir, 'bin'), plat = join(dir, 'plat'), out = join(dir, 'services.log');
  for (const d of [bin, join(plat, 'scripts'), join(plat, 'web', 'node_modules')]) mkdirSync(d, { recursive: true });
  for (const f of ['dev.sh', 'api-origins.sh']) writeFileSync(join(plat, 'scripts', f), readFileSync(join('platform/scripts', f)));
  writeFileSync(join(dir, 'none.json'), '{}');
  const stub = (path, body) => writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const stay = 'for _ in $(seq 1 30); do sleep 1; done';
  const svc = `echo "$(basename "$0")|$MS_API_ADDR|$MS_API_URL|\${MS_DATABASE_URL##*/}" >>"$STUB_OUT"; ${stay}`;
  stub(join(dir, 'svc'), svc);
  stub(join(dir, 'api'), api ?? `echo 'level=INFO msg="control plane listening"'; ${svc}`);
  stub(join(bin, 'go'), 'while [ "$1" != -o ]; do shift; done; mkdir -p "$2"; cp "$STUB_API" "$2/api"; cp "$STUB_SVC" "$2/worker"');
  // the last field holds every secret the console must not inherit, so it is empty for the web line
  stub(join(bin, 'pnpm'), web ?? `echo "web|$MS_API_ADDR|$MS_API_URL|\${MS_DATABASE_URL##*/}|\${MS_DEV_DB_PASSWORD:-}\${MS_WORKER_TOKEN:-}\${MS_INGEST_TOKEN:-}" >>"$STUB_OUT"; ${stay}`);
  // by default a port answers only after the stubbed service on it started, so the preflight sees free ports
  stub(join(bin, 'curl'), curl ?? 'echo "$*" >>"$STUB_CURL"; case "$*" in *:8081/*) grep -q "^api|" "$STUB_OUT" 2>/dev/null ;; *:3000/*) grep -q "^web|" "$STUB_OUT" 2>/dev/null ;; esac');
  // Postgres reports running, so `compose up` must not run; psql stdin (the role SQL) goes to the log
  stub(join(bin, 'docker'), 'echo "$*" >>"$STUB_DOCKER"; case "$*" in *"ps --status"*) echo postgres ;; *"psql -q"*) cat >>"$STUB_DOCKER" ;; esac');
  const run = join(plat, '.dev', 'dev');
  const env = { PATH: `${bin}:${process.env.PATH}`, STUB_OUT: out, STUB_SVC: join(dir, 'svc'), STUB_API: join(dir, 'api'), STUB_CURL: join(dir, 'curl.log'),
    STUB_DOCKER: join(dir, 'docker.log'), STUB_API_PID: join(run, 'api.pid'), STUB_WEB_PID: join(run, 'web.pid'),
    MS_RUN_DIR: '', MS_API_ADDR: '', MS_API_URL: '', MS_SETTINGS: join(dir, 'none.json'), MS_ENGINE_URL: 'http://engine.invalid', XDG_CONFIG_HOME: join(dir, 'xdg') };
  const up = () => spawnSync('bash', [join(plat, 'scripts', 'dev.sh'), 'up'], { env: { ...process.env, ...env }, encoding: 'utf8' });
  const stop = () => {
    for (const p of ['api', 'worker', 'web']) {
      try { process.kill(Number(readFileSync(join(run, `${p}.pid`), 'utf8'))); } catch { /* not started or already gone */ }
    }
  };
  return { plat, out, env, up, stop };
};

test('dev.sh up runs the development stack: run directory .dev/dev, role and database ms_dev, API 8081, console 3000; a rerun with that stack up does not refuse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-devstack-'));
  const { plat, out, env, up, stop } = devUpFixture(dir);
  try {
    const r = up();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Control plane: {2}http:\/\/127\.0\.0\.1:8081\/api\/v1\/health/);
    assert.match(r.stdout, /Database: {7}ms_dev\n/);
    // the services start detached; give them a moment to write their line
    for (let i = 0; i < 50 && !(existsSync(out) && readFileSync(out, 'utf8').trim().split('\n').length >= 3); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    assert.deepEqual(readFileSync(out, 'utf8').trim().split('\n').sort(), [
      'api|127.0.0.1:8081|http://127.0.0.1:8081|ms_dev',
      'web|127.0.0.1:8081|http://127.0.0.1:8081||',
      'worker|127.0.0.1:8081|http://127.0.0.1:8081|ms_dev',
    ]);
    const curls = readFileSync(env.STUB_CURL, 'utf8');
    assert.match(curls, /http:\/\/127\.0\.0\.1:8081\/api\/v1\/health/);
    assert.match(curls, /http:\/\/127\.0\.0\.1:3000\/api\/v1\/health/);
    assert.doesNotMatch(curls, /:8080|:3737/);
    const docker = readFileSync(env.STUB_DOCKER, 'utf8');
    assert.match(docker, /pg_advisory_lock[\s\S]*CREATE ROLE ms_dev LOGIN/);
    assert.match(docker, /ALTER ROLE ms_dev PASSWORD '[0-9a-f]{48}'/);
    assert.match(docker, /'CREATE DATABASE ms_dev OWNER ms_dev' WHERE NOT EXISTS .*\\gexec\n/);
    assert.match(docker, /'CREATE DATABASE ms_dev_test OWNER ms_dev' WHERE NOT EXISTS .*\\gexec\n/);
    assert.doesNotMatch(docker, /ALTER ROLE ms PASSWORD|compose up/);
    // the development build and pid files live in .dev/dev; the live run directory gets no env file or binary
    assert.ok(existsSync(join(plat, '.dev', 'dev', 'bin', 'api')));
    assert.ok(existsSync(join(plat, '.dev', 'dev', 'api.pid')));
    assert.equal(existsSync(join(plat, '.dev', 'env')), false);
    assert.deepEqual(readdirSync(join(plat, '.dev', 'bin')), []);
    // this checkout's api and console are alive and answer on 8081 and 3000: a second up passes the port checks
    const again = up();
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /Control plane: {2}http:\/\/127\.0\.0\.1:8081\/api\/v1\/health/);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Another checkout's stack already answers on a shared port: curl answers before this checkout starts anything.
test('dev.sh up refuses when another checkout serves port 8081 or 3000 and builds nothing and sets no role password', () => {
  const cases = [
    ['exit 0', /port 8081 already serves a control plane from another checkout; stop that stack with scripts\/dev\.sh down there/],
    ['case "$*" in *:3000/*) exit 0 ;; esac; exit 1', /port 3000 already serves a console from another checkout; stop that stack with scripts\/dev\.sh down there/],
  ];
  for (const [curl, message] of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'ms-devbusy-'));
    try {
      const bin = join(dir, 'bin'), plat = join(dir, 'plat'), log = join(dir, 'calls.log');
      for (const d of [bin, join(plat, 'scripts')]) mkdirSync(d, { recursive: true });
      for (const f of ['dev.sh', 'api-origins.sh']) writeFileSync(join(plat, 'scripts', f), readFileSync(join('platform/scripts', f)));
      const stub = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      stub('curl', curl);
      for (const name of ['go', 'pnpm']) stub(name, `echo "${name} $*" >>"$STUB_LOG"`);
      stub('docker', 'echo "docker $*" >>"$STUB_LOG"; cat >>"$STUB_LOG"');
      const env = { PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, MS_RUN_DIR: '', MS_API_ADDR: '', MS_API_URL: '', XDG_CONFIG_HOME: join(dir, 'xdg') };
      const r = spawnSync('bash', [join(plat, 'scripts', 'dev.sh'), 'up'], { env: { ...process.env, ...env }, encoding: 'utf8' });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, message);
      const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
      assert.doesNotMatch(calls, /go build|ALTER ROLE ms_dev/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Two concurrent ups both pass the preflight. The slower one's api exits on the bound port or the stack lock, and the
// other checkout answers its health check: either after this api exited, or at once while this api still starts and
// exits a moment later.
test('dev.sh up fails with the port 8081 message when its started api exits while another checkout answers', () => {
  const cases = [
    ['exit 1', '[ -f "$STUB_API_PID" ] || exit 1; while kill -0 "$(cat "$STUB_API_PID")" 2>/dev/null; do sleep 0.1; done'],
    ['sleep 1; exit 1', '[ -f "$STUB_API_PID" ]'],
  ];
  for (const [api, curl] of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'ms-devrace-'));
    const { out, up, stop } = devUpFixture(dir, { api, curl });
    try {
      const r = up();
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /port 8081 already serves a control plane from another checkout; stop that stack with scripts\/dev\.sh down there/);
      assert.doesNotMatch(r.stdout, /Control plane:/);
      // up stops before the worker and the console start
      assert.equal(existsSync(out), false);
    } finally {
      stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// The started api exits before it listens and nothing answers on 8081: a startup failure of its own, not a taken port.
test('dev.sh up fails pointing at api.log when its started api exits and nothing answers on 8081', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-devapifail-'));
  const { plat, out, up, stop } = devUpFixture(dir, { api: 'exit 1', curl: 'exit 1' });
  try {
    const r = up();
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(`control plane exited before it listened (see ${join(plat, '.dev', 'dev', 'api.log')})`), r.stderr);
    assert.doesNotMatch(r.stderr, /another checkout/);
    assert.equal(existsSync(out), false);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The slower up's console exits on the bound port 3000 a moment after the other checkout's console answered at once.
test('dev.sh up fails with the port 3000 message when its started console exits after another checkout answers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-devrace-web-'));
  const curl = 'case "$*" in *:8081/*) grep -q "^api|" "$STUB_OUT" 2>/dev/null ;; *:3000/*) [ -f "$STUB_WEB_PID" ] ;; esac';
  const { up, stop } = devUpFixture(dir, { web: 'sleep 1; exit 1', curl });
  try {
    const r = up();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /port 3000 already serves a console from another checkout; stop that stack with scripts\/dev\.sh down there/);
    assert.doesNotMatch(r.stdout, /Console:/);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Postgres reports stopped. The stand-in docker logs every call and the psql stdin; `ps -a -q` reports a container
// only when STUB_CONTAINER is set.
const devDbStopped = (container) => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-devdb-'));
  const bin = join(dir, 'bin'), plat = join(dir, 'plat'), log = join(dir, 'docker.log');
  for (const d of [bin, join(plat, 'scripts')]) mkdirSync(d, { recursive: true });
  for (const f of ['dev.sh', 'api-origins.sh']) writeFileSync(join(plat, 'scripts', f), readFileSync(join('platform/scripts', f)));
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "$*" >>"$STUB_DOCKER"; case "$*" in *"ps -a -q"*) echo "$STUB_CONTAINER" ;; *"psql -q"*) cat >>"$STUB_DOCKER" ;; esac\n', { mode: 0o755 });
  const r = sh('source "$PLAT/scripts/dev.sh"; use_stack dev; dev_db', { PLAT: plat, MS_RUN_DIR: '', PATH: `${bin}:${process.env.PATH}`, STUB_DOCKER: log, STUB_CONTAINER: container, XDG_CONFIG_HOME: join(dir, 'xdg') });
  return { dir, plat, r, docker: existsSync(log) ? readFileSync(log, 'utf8') : '' };
};

test('dev_db starts a stopped Postgres container as it is and never touches the live role or env file', () => {
  const { dir, plat, r, docker } = devDbStopped('abc123');
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(docker, /^compose start postgres$/m);
    assert.doesNotMatch(docker, /compose up|ALTER ROLE ms PASSWORD/);
    assert.match(docker, /ALTER ROLE ms_dev PASSWORD/);
    assert.equal(existsSync(join(plat, '.dev', 'env')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dev_db with no Postgres container refuses and names scripts/dev.sh db', () => {
  const { dir, plat, r, docker } = devDbStopped('');
  try {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /run scripts\/dev\.sh db from the live checkout/);
    assert.doesNotMatch(docker, /compose up|compose start|ALTER ROLE/);
    assert.equal(existsSync(join(plat, '.dev', 'env')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Several scratch checkouts share one scratch $XDG_CONFIG_HOME and one stand-in docker: Postgres reports running and
// the psql stdin goes to the log.
const checkouts = (n) => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-devshare-'));
  const bin = join(dir, 'bin'), xdg = join(dir, 'xdg'), log = join(dir, 'docker.log');
  mkdirSync(bin); mkdirSync(xdg);
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "$*" >>"$STUB_DOCKER"; case "$*" in *"ps --status"*) echo postgres ;; *"psql -q"*) cat >>"$STUB_DOCKER" ;; esac\n', { mode: 0o755 });
  const plats = Array.from({ length: n }, (_, i) => {
    const plat = join(dir, `plat${i}`);
    mkdirSync(join(plat, 'scripts'), { recursive: true });
    for (const f of ['dev.sh', 'api-origins.sh']) writeFileSync(join(plat, 'scripts', f), readFileSync(join('platform/scripts', f)));
    return plat;
  });
  const env = { MS_RUN_DIR: '', PATH: `${bin}:${process.env.PATH}`, STUB_DOCKER: log, XDG_CONFIG_HOME: xdg };
  const read = (plat) => Object.fromEntries(readFileSync(join(plat, '.dev', 'dev', 'env'), 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
  const passwords = () => [...readFileSync(log, 'utf8').matchAll(/ALTER ROLE ms_dev PASSWORD '(\w+)'/g)].map((m) => m[1]);
  return { dir, xdg, plats, env, read, passwords };
};

test('a second checkout running dev_db keeps the ms_dev password of the first, and an older env file gets the shared one', () => {
  const { dir, xdg, plats: [first, second, older], env, read, passwords } = checkouts(3);
  try {
    const a = 'a'.repeat(48), b = 'b'.repeat(48);
    const envFile = (pw) => `MS_WORKER_TOKEN=w\nMS_INGEST_TOKEN=i\nMS_DEV_DB_PASSWORD=${pw}\nMS_DATABASE_URL=postgres://ms_dev:${pw}@127.0.0.1:5544/ms_dev\nMS_TEST_DATABASE_URL=postgres://ms_dev:${pw}@127.0.0.1:5544/ms_dev_test\n`;
    // the first checkout was set up before the shared password existed; its password becomes the shared one
    mkdirSync(join(first, '.dev', 'dev'), { recursive: true });
    writeFileSync(join(first, '.dev', 'dev', 'env'), envFile(a), { mode: 0o600 });
    mkdirSync(join(older, '.dev', 'dev'), { recursive: true });
    writeFileSync(join(older, '.dev', 'dev', 'env'), envFile(b), { mode: 0o600 });
    for (const plat of [first, second, older]) {
      const r = sh('source "$PLAT/scripts/dev.sh"; use_stack dev; dev_db', { ...env, PLAT: plat });
      assert.equal(r.status, 0, r.stderr);
    }
    assert.deepEqual(passwords(), [a, a, a]);
    assert.equal(readFileSync(join(xdg, 'market-signals', 'dev-db-password'), 'utf8').trim(), a);
    assert.equal(statSync(join(xdg, 'market-signals', 'dev-db-password')).mode & 0o777, 0o600);
    for (const plat of [first, second, older]) {
      const e = read(plat);
      assert.equal(e.MS_DEV_DB_PASSWORD, a);
      assert.equal(e.MS_DATABASE_URL, `postgres://ms_dev:${a}@127.0.0.1:5544/ms_dev`);
      assert.equal(e.MS_TEST_DATABASE_URL, `postgres://ms_dev:${a}@127.0.0.1:5544/ms_dev_test`);
      assert.equal(statSync(join(plat, '.dev', 'dev', 'env')).mode & 0o777, 0o600);
      assert.equal(existsSync(join(plat, '.dev', 'env')), false);
    }
    // the rewritten env file keeps its own tokens and holds each database line once
    assert.equal(readFileSync(join(older, '.dev', 'dev', 'env'), 'utf8'), envFile(a));
    assert.doesNotMatch(readFileSync(env.STUB_DOCKER, 'utf8'), /ALTER ROLE ms PASSWORD|compose up/);

    writeFileSync(join(xdg, 'market-signals', 'dev-db-password'), "x'; DROP ROLE ms; --\n");
    const r = sh('source "$PLAT/scripts/dev.sh"; use_stack dev; dev_db', { ...env, PLAT: second });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not hold a development database password/);
    assert.equal(read(second).MS_DEV_DB_PASSWORD, a);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed password in an older env file does not seed the shared file', () => {
  const { dir, xdg, plats: [plat], env, read, passwords } = checkouts(1);
  try {
    mkdirSync(join(plat, '.dev', 'dev'), { recursive: true });
    writeFileSync(join(plat, '.dev', 'dev', 'env'), 'MS_WORKER_TOKEN=w\nMS_INGEST_TOKEN=i\nMS_DEV_DB_PASSWORD=short\n', { mode: 0o600 });
    const r = sh('source "$PLAT/scripts/dev.sh"; use_stack dev; dev_db', { ...env, PLAT: plat });
    assert.equal(r.status, 0, r.stderr);
    const shared = readFileSync(join(xdg, 'market-signals', 'dev-db-password'), 'utf8').trim();
    assert.match(shared, /^[0-9a-f]{48}$/);
    assert.equal(read(plat).MS_DEV_DB_PASSWORD, shared);
    assert.deepEqual(passwords(), [shared]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed password generation dies before it writes or links a shared file', () => {
  const { dir, xdg, plats: [plat], env } = checkouts(1);
  try {
    // openssl that prints nothing and succeeds; load_env calls dev_db_password in a command substitution
    writeFileSync(join(dir, 'bin', 'openssl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const r = sh('source "$PLAT/scripts/dev.sh"; use_stack dev; load_env; echo loaded', { ...env, PLAT: plat });
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /loaded/);
    assert.match(r.stderr, /could not generate a development database password/);
    assert.equal(existsSync(join(xdg, 'market-signals', 'dev-db-password')), false);
    assert.deepEqual(existsSync(join(xdg, 'market-signals')) ? readdirSync(join(xdg, 'market-signals')) : [], []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed link of the shared password file dies naming the file and leaves no shared file', () => {
  const { dir, xdg, plats: [plat], env } = checkouts(1);
  try {
    // an ln that always fails, as on a config filesystem without hard links
    writeFileSync(join(dir, 'bin', 'ln'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const r = sh('source "$PLAT/scripts/dev.sh"; use_stack dev; load_env; echo loaded', { ...env, PLAT: plat });
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /loaded/);
    assert.match(r.stderr, /cannot create .*market-signals\/dev-db-password/);
    assert.doesNotMatch(r.stderr, /delete it and run again/);
    assert.deepEqual(readdirSync(join(xdg, 'market-signals')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dev_config_home uses an absolute XDG_CONFIG_HOME and falls back to ~/.config for an unset or relative one', () => {
  const home = (xdg) => sh('source platform/scripts/dev.sh; dev_config_home', { XDG_CONFIG_HOME: xdg, HOME: '/home/h', MS_RUN_DIR: tmpdir() }).stdout.trim();
  for (const form of ['/tmp/xdg', '/Users/u/.config']) assert.equal(home(form), form);
  for (const form of ['', '.config', 'relative/dir']) assert.equal(home(form), '/home/h/.config', form);
  // a relative value would resolve inside each checkout; the password file lands under HOME instead
  const { dir, plats: [plat], env } = checkouts(1);
  try {
    const r = sh('source "$PLAT/scripts/dev.sh"; use_stack dev; dev_db', { ...env, PLAT: plat, XDG_CONFIG_HOME: '.config', HOME: join(dir, 'home') });
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(dir, 'home', '.config', 'market-signals', 'dev-db-password'), 'utf8'), /^[0-9a-f]{48}\n$/);
    assert.equal(existsSync(join(plat, '.config')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two concurrent first runs of dev_db from two checkouts both succeed with one shared password', () => {
  const { dir, xdg, plats: [one, two], env, read, passwords } = checkouts(2);
  try {
    // a stand-in ln waits until both runs reach it, so both always pass the missing-file check before either links
    const realLn = spawnSync('sh', ['-c', 'command -v ln'], { encoding: 'utf8' }).stdout.trim();
    const sync = join(dir, 'sync');
    mkdirSync(sync);
    writeFileSync(join(dir, 'bin', 'ln'), `#!/bin/sh\ntouch "$STUB_SYNC/$$"\ni=0\nwhile [ "$(ls "$STUB_SYNC" | wc -l)" -lt 2 ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done\nexec ${realLn} "$@"\n`, { mode: 0o755 });
    const run = `bash -c 'source "$PLAT/scripts/dev.sh"; use_stack dev; dev_db'`;
    const r = sh(`PLAT="$ONE" ${run} & a=$!; PLAT="$TWO" ${run} & b=$!; wait $a && wait $b`, { ...env, ONE: one, TWO: two, STUB_SYNC: sync });
    assert.equal(readdirSync(sync).length, 2);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(one).MS_DEV_DB_PASSWORD, read(two).MS_DEV_DB_PASSWORD);
    assert.deepEqual(passwords(), [read(one).MS_DEV_DB_PASSWORD, read(one).MS_DEV_DB_PASSWORD]);
    assert.deepEqual(readdirSync(join(xdg, 'market-signals')), ['dev-db-password']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the development env file has its own tokens and password, mode 600, and the live env file keeps database ms', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-devenv-'));
  try {
    const plat = join(dir, 'plat');
    mkdirSync(join(plat, 'scripts'), { recursive: true });
    for (const f of ['dev.sh', 'api-origins.sh']) writeFileSync(join(plat, 'scripts', f), readFileSync(join('platform/scripts', f)));
    const r = sh('source "$PLAT/scripts/dev.sh"; load_env; use_stack dev; load_env', { PLAT: plat, MS_RUN_DIR: '', XDG_CONFIG_HOME: join(dir, 'xdg') });
    assert.equal(r.status, 0, r.stderr);
    const read = (p) => Object.fromEntries(readFileSync(p, 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
    const devFile = join(plat, '.dev', 'dev', 'env');
    const live = read(join(plat, '.dev', 'env')), dev = read(devFile);
    assert.equal(statSync(devFile).mode & 0o777, 0o600);
    assert.match(live.MS_DATABASE_URL, /^postgres:\/\/ms:[0-9a-f]{48}@127\.0\.0\.1:5544\/ms$/);
    assert.equal(dev.MS_DATABASE_URL, `postgres://ms_dev:${dev.MS_DEV_DB_PASSWORD}@127.0.0.1:5544/ms_dev`);
    assert.equal(dev.MS_TEST_DATABASE_URL, `postgres://ms_dev:${dev.MS_DEV_DB_PASSWORD}@127.0.0.1:5544/ms_dev_test`);
    assert.equal(dev.MS_DB_PASSWORD, undefined);
    assert.notEqual(dev.MS_DEV_DB_PASSWORD, live.MS_DB_PASSWORD);
    assert.notEqual(dev.MS_WORKER_TOKEN, live.MS_WORKER_TOKEN);
    assert.notEqual(dev.MS_INGEST_TOKEN, live.MS_INGEST_TOKEN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// MS_RUN_DIR points both stacks at one scratch env file: each stack refuses the other stack's file and appends nothing.
test('load_env refuses an env file that holds the other stack database password and leaves it unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-envmix-'));
  try {
    const file = join(dir, 'env');
    for (const [stack, line, owner] of [['dev', 'MS_DB_PASSWORD=live', 'live'], ['live', 'MS_DEV_DB_PASSWORD=dev', 'development']]) {
      writeFileSync(file, `MS_WORKER_TOKEN=w\nMS_INGEST_TOKEN=i\n${line}\n`, { mode: 0o600 });
      const before = readFileSync(file, 'utf8');
      const r = sh(`source platform/scripts/dev.sh; use_stack ${stack}; load_env`, { MS_RUN_DIR: dir });
      assert.notEqual(r.status, 0, stack);
      assert.match(r.stderr, new RegExp(`belongs to the ${owner} stack`));
      assert.equal(readFileSync(file, 'utf8'), before);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('switch-launchd writes the live console port into the web plist: 3737 by default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-webplist-'));
  try {
    const r = sh('source platform/scripts/switch-launchd.sh; LA="$DIR"; write_plist web', { DIR: dir, MS_CONSOLE_PORT: '' });
    assert.equal(r.status, 0, r.stderr);
    const plist = readFileSync(join(dir, 'com.market-signals.platform-web.plist'), 'utf8');
    assert.match(plist, /dev\.sh<\/string>\s*<string>run<\/string>\s*<string>web<\/string>/);
    assert.match(plist, /<key>MS_CONSOLE_PORT<\/key>\s*<string>3737<\/string>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
