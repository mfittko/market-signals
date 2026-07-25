// The NEWSAPI_AI_* config keys, read from settings.json first, then the process
// env. Kept in this tiny standalone lib (no heavy deps) so the signal-server and
// the decision path can resolve the key without a hard startup dependency on the
// market-sentinel skill CLI module (issue #114 review) — a broken/missing skill
// must not stop the server from booting, only fail the tool when invoked.
export const NEWSAPI_AI_SETTING_KEYS = ['NEWSAPI_AI_KEY', 'NEWSAPI_AI_MODE', 'NEWSAPI_AI_INSTRUMENTS', 'NEWSAPI_AI_REQUEST_BUDGET', 'NEWSAPI_AI_BACKGROUND'];

// Merge settings over env into a flat { NEWSAPI_AI_*: string } object, omitting
// empty/absent keys. This app keeps API keys in data/settings.json (the
// LaunchAgent never loads .env), so settings wins; env is the dev/CLI fallback.
export function resolveNewsApiAiSource(settings = {}, env = process.env) {
  const out = {};
  for (const k of NEWSAPI_AI_SETTING_KEYS) {
    const v = settings?.[k] ?? env?.[k];
    if (v !== undefined && v !== null && v !== '') out[k] = String(v);
  }
  return out;
}

// The settings modal writes ''/‘1’ for its off/on toggles, but a manual edit
// could leave any string — so an on-check must match the intended values, not
// "any non-empty string" (which would treat "0" as on). Accepts the modal's '1'
// plus a real boolean/number for programmatic callers.
export function isSettingOn(v) {
  return v === '1' || v === true || v === 1;
}
