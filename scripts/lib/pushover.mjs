// Pushover: an opt-in push target, additive to the local desktop
// notification. Kept as its own leaf lib (no heavy deps) so a future sibling
// target (e.g. ntfy) is a parallel file, not surgery on this one — payload
// construction (buildPushoverPayload) and transport (sendPushover) are
// deliberately separate functions for the same reason.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSettingOn } from './settings-util.mjs';

export const PUSHOVER_SETTING_KEYS = ['PUSHOVER_ENABLED', 'PUSHOVER_TOKEN', 'PUSHOVER_USER'];

// Settings-first, env fallback (data/settings.json is what the LaunchAgent
// loads; .env is the CLI/test convenience only) — resolve all three keys
// together so a half-migrated config can't mix a settings.json toggle with an
// .env key or vice versa.
export function resolvePushoverConfig(settings = {}, env = process.env) {
  const enabled = isSettingOn(settings.PUSHOVER_ENABLED ?? env?.PUSHOVER_ENABLED);
  const token = settings.PUSHOVER_TOKEN || env?.PUSHOVER_TOKEN || '';
  const user = settings.PUSHOVER_USER || env?.PUSHOVER_USER || '';
  return { enabled, token, user };
}

// Pushover's documented per-field caps; a long LLM verdict reason (or a
// message concatenated some other way in the future) must never turn into a
// rejected 4xx instead of a delivered, slightly-shortened push.
const CAPS = { message: 1024, title: 250, url: 512 };
const truncate = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) : s);

// Pure: no network, no secrets — safe to unit-test directly. deepLink is
// optional (the bot kill-switch halt has none).
export function buildPushoverPayload(msg, deepLink) {
  const payload = { title: truncate('market-signals', CAPS.title), message: truncate(String(msg), CAPS.message) };
  if (deepLink) {
    payload.url = truncate(String(deepLink), CAPS.url);
    payload.url_title = truncate('open chart', CAPS.url); // well under the url cap; truncated on principle, not need
  }
  return payload;
}

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

// Thin transport: one bounded curl POST. Throws on any failure (non-2xx via
// --fail, timeout, curl missing) — the caller (supertrend.mjs's
// sendNotification) is the one place that must never let a Pushover failure
// propagate, so swallowing lives there, not here.
//
// token/user are written to a scratch dir and referenced as `field@path`
// rather than `field=value` in argv: argv is visible to any `ps` snapshot on a
// shared machine, a file this process just wrote and deletes is not. Message/
// title/url are not secret and pass as plain argv values (execFileSync never
// goes through a shell, so no quoting/injection risk either way).
export function sendPushover(payload, { token, user }, { timeoutMs = 5000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ms-po-'));
  try {
    const tokenFile = join(dir, 't');
    const userFile = join(dir, 'u');
    writeFileSync(tokenFile, token, { mode: 0o600 });
    writeFileSync(userFile, user, { mode: 0o600 });
    const args = [
      '-sS', '-f', '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      PUSHOVER_URL,
      '--data-urlencode', `token@${tokenFile}`,
      '--data-urlencode', `user@${userFile}`,
      '--data-urlencode', `message=${payload.message}`,
      '--data-urlencode', `title=${payload.title}`,
    ];
    if (payload.url) args.push('--data-urlencode', `url=${payload.url}`);
    if (payload.url_title) args.push('--data-urlencode', `url_title=${payload.url_title}`);
    execFileSync('curl', args, { timeout: timeoutMs, stdio: 'pipe' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
