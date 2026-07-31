// The GNEWS_* config keys (issue #212), read from settings.json first, then the
// process env. Mirrors scripts/lib/newsapi-ai-source.mjs: a tiny standalone lib
// (no heavy deps) so the signal-server can resolve the key without a hard
// startup dependency on the market-sentinel skill CLI module.
export const GNEWS_SETTING_KEYS = ['GNEWS_KEY', 'GNEWS_MODE', 'GNEWS_INSTRUMENTS', 'GNEWS_REQUEST_BUDGET'];

// Merge settings over env into a flat { GNEWS_*: string } object, omitting
// empty/absent keys. Settings.json wins (the LaunchAgent never loads .env);
// env is the dev/CLI fallback — same precedence as NewsAPI.ai.
export function resolveGnewsSource(settings = {}, env = process.env) {
  const out = {};
  for (const k of GNEWS_SETTING_KEYS) {
    const v = settings?.[k] ?? env?.[k];
    if (v !== undefined && v !== null && v !== '') out[k] = String(v);
  }
  return out;
}

// GNews is opt-in and costs money/quota, unlike the free stack — 'off' is the
// only safe default. `shadow` fetches + records but never merges into a
// prompt; `auto` merges once an operator has opted in with a real key.
export const GNEWS_MODES = ['off', 'shadow', 'auto'];
