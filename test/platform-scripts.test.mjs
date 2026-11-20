import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

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
  stub(join(bin, 'pnpm'), '[ -z "$STUB_PNPM_FAIL" ] || { echo half >.next/BUILD; exit 1; }; echo new >.next/BUILD');
  stub(join(bin, 'launchctl'), '[ "$1" = bootstrap ] && echo "bootstrap ${3##*/}" >>"$DIR/launchctl.log"; [ "$1" != print ]');
  stub(join(bin, 'curl'), 'echo "{\\"build\\":{\\"commit\\":\\"$STUB_SERVED\\"}}"');
  stub(join(bin, 'git'), 'case "$*" in *"rev-parse HEAD") echo want ;; *) exec /usr/bin/git "$@" ;; esac');
  stub(join(bin, 'sleep'), 'exit 0');
  const read = (...p) => readFileSync(join(plat, ...p), 'utf8').trim();
  const deploy = (extra) => sh('source platform/scripts/switch-launchd.sh; PLAT="$DIR/plat"; LA="$DIR/la"; install_console', { DIR: dir, PATH: `${bin}:${process.env.PATH}`, STUB_SERVED: 'want', ...extra });
  return { read, deploy, log: () => readFileSync(join(dir, 'launchctl.log'), 'utf8') };
};

test('install_console keeps the previous build, restores it after a failed build or a served commit mismatch, and reloads the jobs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-deploy-'));
  try {
    const cases = [
      [{}, 0, null, 'new'],
      [{ STUB_GO_FAIL: '1' }, 1, /the Go build failed; restoring the previous build/, 'old'],
      [{ STUB_PNPM_FAIL: '1' }, 1, /the console build failed; restoring the previous build/, 'old'],
      [{ STUB_SERVED: 'other' }, 1, /serves commit other, but the build is want/, 'old'],
      [{ STUB_SERVED: '' }, 1, /did not answer on port/, 'old'],
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
      for (const j of ['api', 'worker', 'web']) assert.match(log(), new RegExp(`bootstrap com\\.market-signals\\.platform-${j}\\.plist`));
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
