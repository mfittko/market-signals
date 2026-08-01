// Pushover: an opt-in push target, additive to the local desktop
// notification. Kept as its own leaf lib (no heavy deps) so a future sibling
// target (e.g. ntfy) is a parallel file, not surgery on this one — payload
// construction (buildPushoverPayload) and transport (sendPushover) are
// deliberately separate functions for the same reason.
import { execFileSync } from 'node:child_process';
import { isSettingOn } from './settings-util.mjs';

export const PUSHOVER_SETTING_KEYS = ['PUSHOVER_ENABLED', 'PUSHOVER_TOKEN', 'PUSHOVER_USER'];

// Settings-first, env fallback, PER FIELD: data/settings.json is what the
// long-lived server reads (the LaunchAgent never loads .env), and .env is the
// CLI/test convenience. Mixing is allowed on purpose — a toggle in settings.json
// with the key still in .env is a normal state while migrating one into the UI,
// and matches how the news providers resolve.
export function resolvePushoverConfig(settings = {}, env = process.env) {
  const enabled = isSettingOn(settings.PUSHOVER_ENABLED ?? env?.PUSHOVER_ENABLED);
  const token = settings.PUSHOVER_TOKEN || env?.PUSHOVER_TOKEN || '';
  const user = settings.PUSHOVER_USER || env?.PUSHOVER_USER || '';
  return { enabled, token, user };
}

// Pushover's documented per-field caps; a long LLM verdict reason (or a
// message concatenated some other way in the future) must never turn into a
// rejected 4xx instead of a delivered, slightly-shortened push.
const CAPS = { message: 1024, title: 250, url: 512, url_title: 100 };
// Cut on code points, not UTF-16 code units: Pushover counts characters, and
// slicing by units can sever a surrogate pair and ship a lone surrogate.
const truncate = (s, n) => (typeof s === 'string' && s.length > n ? [...s].slice(0, n).join('') : s);

// Pure: no network, no secrets — safe to unit-test directly. deepLink is
// optional (the bot kill-switch halt has none).
export function buildPushoverPayload(msg, deepLink) {
  const payload = { title: truncate('market-signals', CAPS.title), message: truncate(String(msg), CAPS.message) };
  if (deepLink) {
    payload.url = truncate(String(deepLink), CAPS.url);
    payload.url_title = truncate('open chart', CAPS.url_title); // its own cap is 100, not the url's 512
  }
  return payload;
}

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

// Thin transport: one bounded curl POST. Throws on any failure (non-2xx via
// --fail, timeout, curl missing) — the caller (supertrend.mjs's
// sendNotification) is the one place that must never let a Pushover failure
// propagate, so swallowing lives there, not here.
//
// The whole body goes in on stdin (`-d @-`), so NOTHING sensitive reaches argv:
// argv is visible to any `ps` snapshot on a shared machine, and that covers the
// token and user key as well as the alert text itself. Passing secrets via files
// would work too but is strictly worse — it leaves 0600 files to clean up, and the
// cleanup cannot run when the process is SIGKILLed, which under a LaunchAgent is a
// normal way to die. URLSearchParams gives exactly the form encoding curl's
// --data-urlencode produced (spaces as `+`, everything else percent-encoded).
export function sendPushover(payload, { token, user }, { timeoutMs = 5000 } = {}) {
  const body = new URLSearchParams({ token, user, ...payload }).toString();
  const args = ['-sS', '-f', '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))), PUSHOVER_URL, '-d', '@-'];
  execFileSync('curl', args, { input: body, timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] });
}
