#!/usr/bin/env node
// truthbrush ingestion (issue #8, Phase 2). First-party pull of Trump Truth
// Social posts, so history isn't tied to the CNN mirror (#7).
//
// Two parts:
//   1. Live pull  — shells out to the `truthbrush` Python CLI (credential-gated,
//      best-effort; fails loud if the tool or creds are missing).
//   2. Idempotent persistence — upsert by post `id` into a durable JSON store.
//      Re-ingesting any window is a no-op / clean upsert; late edits update in
//      place. Records are normalized to the #7 schema
//      { id, createdAtISO, text, url, engagement }, so the store file IS a valid
//      `backtest --posts <file>` input: the backtest consumes CNN or truthbrush
//      behind the one existing interface, unchanged.
//
// ponytail: durable store is a JSON array keyed-by-id via a Map (O(n) rewrite,
// held in memory). Swap to node:sqlite (stdlib in Node 26) if post history ever
// outgrows memory — the upsert/normalize seam stays identical.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizePost } from './fetch-trump-posts.mjs';

export const DEFAULT_STORE = 'data/truth-posts.json';
export const DEFAULT_ACCOUNT = 'realDonaldTrump';

// --- Persistence (the load-bearing, tested part) -------------------------

// Load the durable store as a Map keyed by post id (empty if absent).
export function loadStore(file) {
  if (!existsSync(file)) return new Map();
  const arr = JSON.parse(readFileSync(file, 'utf8'));
  return new Map((Array.isArray(arr) ? arr : []).map((p) => [String(p.id), p]));
}

// Upsert raw posts (any source shape normalizePost understands) into the store.
// Idempotent by construction: id is the key, so re-ingesting a window never
// duplicates and a late edit overwrites in place.
export function upsert(store, rawPosts) {
  let inserted = 0;
  let updated = 0;
  for (const raw of Array.isArray(rawPosts) ? rawPosts : []) {
    const p = normalizePost(raw);
    if (!p.id || !p.createdAtISO) continue; // require a stable id + timestamp
    if (store.has(p.id)) updated++;
    else inserted++;
    store.set(p.id, p);
  }
  return { inserted, updated, total: store.size };
}

// Deterministic, newest-first serialization (independent of insertion order),
// so re-ingesting the same set yields byte-identical output.
export function serializeStore(store) {
  const arr = [...store.values()].sort(
    (a, b) => Date.parse(b.createdAtISO) - Date.parse(a.createdAtISO),
  );
  return `${JSON.stringify(arr, null, 2)}\n`;
}

export function saveStore(file, store) {
  mkdirSync(dirname(file) || '.', { recursive: true });
  writeFileSync(file, serializeStore(store));
}

// Latest stored post time (for the incremental tail), minus an overlap so the
// boundary post is re-pulled and upsert-deduped rather than skipped.
export function tailSince(store, overlapMs = 60 * 60 * 1000) {
  let max = 0;
  for (const p of store.values()) {
    const ms = Date.parse(p.createdAtISO);
    if (Number.isFinite(ms) && ms > max) max = ms;
  }
  return max ? new Date(max - overlapMs).toISOString() : null;
}

// --- Live pull (credential-gated, fail-loud) -----------------------------

// truthbrush prints statuses as NDJSON (one JSON object per line); some builds
// emit a single JSON array. Accept both; skip unparseable lines.
export function parseTruthbrushOutput(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    return Array.isArray(j) ? j : [j];
  } catch {
    /* not a single JSON doc — fall through to line mode */
  }
  const out = [];
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const j = JSON.parse(t);
      if (Array.isArray(j)) out.push(...j);
      else out.push(j);
    } catch {
      /* skip progress/log lines truthbrush may interleave */
    }
  }
  return out;
}

export function hasCredentials(env = process.env) {
  return Boolean(env.TRUTHSOCIAL_TOKEN || (env.TRUTHSOCIAL_USERNAME && env.TRUTHSOCIAL_PASSWORD));
}

// Shell out to truthbrush. Fail loud (throw) if creds/tool are missing or the
// pull errors — never return an empty batch as if it were a healthy pull.
export function runTruthbrush({
  account = DEFAULT_ACCOUNT,
  since,
  until,
  noAuth = false,
  bin = process.env.TRUTHBRUSH_BIN || 'truthbrush',
  env = process.env,
} = {}) {
  if (!noAuth && !hasCredentials(env)) {
    throw new Error(
      'missing Truth Social credentials: set TRUTHSOCIAL_TOKEN or ' +
        'TRUTHSOCIAL_USERNAME + TRUTHSOCIAL_PASSWORD, or pass --no-auth for a prominent account',
    );
  }
  const args = ['statuses'];
  if (since) args.push('--created-after', since);
  if (until) args.push('--created-before', until);
  if (noAuth) args.push('--no-auth');
  args.push(account);

  const res = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      throw new Error(
        `truthbrush not found on PATH ('${bin}'). Install it (\`pipx install truthbrush\`) — ` +
          'the live pull requires the truthbrush CLI.',
      );
    }
    throw new Error(`failed to run truthbrush: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`truthbrush exited ${res.status}: ${(res.stderr || '').trim().slice(0, 400)}`);
  }
  return parseTruthbrushOutput(res.stdout);
}

// --- CLI -----------------------------------------------------------------

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args.set(argv[i].slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i]);
    }
  }
  return args;
}

const HELP = `ingest-truthbrush — first-party Trump Truth Social pull with idempotent persistence.

  --account <handle>   account to pull (default: ${DEFAULT_ACCOUNT})
  --since <ISO>        window start (created-after)
  --until <ISO>        window end (created-before)
  --tail               incremental: pull from the newest stored post onward
  --store <file>       durable JSON store (default: ${DEFAULT_STORE})
  --no-auth            pull without credentials (works for prominent accounts)
  --bin <path>         truthbrush executable (default: truthbrush, or $TRUTHBRUSH_BIN)
  --interval <sec>     run as a scheduled worker: --tail every <sec> seconds
  --help

Credentials (env, never committed): TRUTHSOCIAL_TOKEN, or
TRUTHSOCIAL_USERNAME + TRUTHSOCIAL_PASSWORD. Fails loud if missing (unless --no-auth).

The store file is a normalized post array — feed it straight to the backtest:
  node scripts/backtest.mjs --posts ${DEFAULT_STORE} --since <ISO> --until <ISO>
`;

async function main(argv) {
  const args = parseArgs(argv);
  if (args.has('help')) {
    process.stdout.write(HELP);
    return;
  }
  const storeFile = String(args.get('store') || DEFAULT_STORE);
  const account = String(args.get('account') || DEFAULT_ACCOUNT);
  const noAuth = args.has('no-auth');
  const bin = args.has('bin') ? String(args.get('bin')) : undefined;
  const until = args.has('until') ? String(args.get('until')) : undefined;
  const tail = args.has('tail');

  const runTick = () => {
    const store = loadStore(storeFile);
    const since = args.has('since')
      ? String(args.get('since'))
      : tail
        ? tailSince(store) || undefined
        : undefined;
    const raw = runTruthbrush({ account, since, until, noAuth, bin });
    const stats = upsert(store, raw);
    saveStore(storeFile, store);
    process.stderr.write(
      `ingested ${account}: pulled ${raw.length}, +${stats.inserted} new, ` +
        `~${stats.updated} updated, ${stats.total} total -> ${storeFile}\n`,
    );
  };

  const intervalSec = args.has('interval') ? Number(args.get('interval')) : 0;
  if (intervalSec > 0) {
    // Scheduled-worker entrypoint. A transient pull failure logs loud but does
    // not kill the worker; it never records a failed pull as healthy.
    // ponytail: in-process loop; a cron/systemd-timer running `--tail` is the
    // deployment path — no daemon/health-endpoint infra (out of scope).
    process.stderr.write(`worker: --tail every ${intervalSec}s (Ctrl-C to stop)\n`);
    const loop = () => {
      try {
        runTick();
      } catch (e) {
        process.stderr.write(`worker tick failed (will retry): ${e.message}\n`);
      }
      setTimeout(loop, intervalSec * 1000);
    };
    loop();
    return;
  }

  runTick();
}


if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`ingest-truthbrush error: ${e.message}\n`);
    process.exit(1);
  });
}
