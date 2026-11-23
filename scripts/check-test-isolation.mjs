#!/usr/bin/env node
// Runs the unit suite in a fresh temporary copy of the tracked files that holds a
// sentinel data/ directory. Fails when the suite fails or when anything under
// data/ was added, removed, changed or read. Reads show up as access-time changes:
// each sentinel gets an access time earlier than its modification time, so a read
// updates it under relatime. The check refuses to run when the filesystem does not
// update access times. Only content reads of sentinel files count as reads: a
// listing or stat of data/ moves no access time and goes undetected. Nothing is
// written outside the system temp directory.
import { spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/cli.mjs';

// The environment `npm test` gives the suite (see package.json).
export function npmTestEnv(env = process.env) {
  const out = { ...env, MS_NO_NOTIFY: '1' };
  delete out.MS_CONTROL_PLANE_URL;
  delete out.MS_INGEST_TOKEN;
  return out;
}

// Map of path (relative to dir, '.' for dir itself) to stat fields. Stats only, so
// taking a snapshot reads no file content and moves no access time.
export function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    const st = lstatSync(join(dir, rel));
    const isDir = st.isDirectory();
    out[rel] = { size: isDir ? null : st.size, mtimeMs: st.mtimeMs, atimeMs: isDir ? null : st.atimeMs };
    if (isDir) for (const name of readdirSync(join(dir, rel)).sort()) walk(rel === '.' ? name : join(rel, name));
  };
  walk('.');
  return out;
}

// List of findings, empty when the two snapshots match.
export function compareSnapshots(before, after) {
  const findings = [];
  for (const p of Object.keys(after)) if (!(p in before)) findings.push(`added: ${p}`);
  for (const [p, b] of Object.entries(before)) {
    const a = after[p];
    if (!a) findings.push(`removed: ${p}`);
    else if (a.size !== b.size || a.mtimeMs !== b.mtimeMs) findings.push(`changed: ${p}`);
    else if (a.atimeMs !== b.atimeMs) findings.push(`read: ${p}`);
  }
  return findings;
}

// Access time one minute before the modification time, in whole seconds so the
// value round-trips exactly through utimes and stat.
function backdateAtime(file) {
  const mtime = statSync(file).mtime;
  utimesSync(file, Math.floor(mtime.getTime() / 1000) - 60, mtime);
}

function atimeSupported(dir) {
  const probe = join(dir, '.atime-probe');
  writeFileSync(probe, 'probe');
  backdateAtime(probe);
  const before = statSync(probe).atimeMs;
  readFileSync(probe);
  const updated = statSync(probe).atimeMs !== before;
  rmSync(probe);
  return updated;
}

const SENTINELS = ['candles.db', 'articles-cache.json', 'notes.md', 'settings.json'];

export function main(root = fileURLToPath(new URL('..', import.meta.url))) {
  const ls = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', timeout: 60000 });
  if (ls.status !== 0) throw new Error(`git ls-files failed: ${ls.stderr || ls.error?.message}`);
  const tmp = mkdtempSync(join(tmpdir(), 'ms-test-isolation-'));
  try {
    for (const rel of ls.stdout.split('\0').filter(Boolean)) {
      const src = join(root, rel);
      let st;
      try { st = lstatSync(src); } catch { continue; } // tracked but deleted in the working tree
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      if (st.isSymbolicLink()) {
        // a link that leaves the copy would let a test write outside it unseen
        const target = readlinkSync(src);
        const out = relative(tmp, resolve(dirname(join(tmp, rel)), target));
        if (isAbsolute(target) || out.startsWith('..')) throw new Error(`tracked symlink ${rel} points outside the checkout: ${target}`);
        symlinkSync(target, join(tmp, rel));
      } else copyFileSync(src, join(tmp, rel));
    }
    // The platform script tests call git in the checkout, so the copy is a one-commit repository.
    for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=isolation', '-c', 'user.email=isolation@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'isolation copy']]) {
      const r = spawnSync('git', args, { cwd: tmp, encoding: 'utf8', timeout: 120000 });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} in the temporary checkout failed: ${r.stderr || r.error?.message}`);
    }
    if (!atimeSupported(tmp)) {
      console.error(`check-test-isolation: the filesystem at ${tmpdir()} does not update access times; reads of data/ cannot be detected`);
      return 1;
    }
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    for (const name of SENTINELS) {
      writeFileSync(join(dataDir, name), `sentinel ${name}\n`);
      backdateAtime(join(dataDir, name));
    }
    const before = snapshot(dataDir);
    const testFiles = readdirSync(join(tmp, 'test')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => join('test', f));
    const run = spawnSync(process.execPath, ['--test', ...testFiles], { cwd: tmp, env: npmTestEnv(), stdio: 'inherit', timeout: 4 * 60000 }); // under the CI job's 5-minute limit, so a hang still prints this script's diagnostic
    const findings = compareSnapshots(before, snapshot(dataDir));
    for (const f of findings) console.error(`check-test-isolation: data/ ${f}`);
    if (run.status !== 0) {
      console.error(`check-test-isolation: unit suite failed (exit ${run.status}${run.error ? `, ${run.error.message}` : ''})`);
      return run.status || 1;
    }
    if (findings.length) return 1;
    console.log('check-test-isolation: the unit suite left data/ untouched');
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) process.exit(main());
