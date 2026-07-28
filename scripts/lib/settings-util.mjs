// Shared settings-toggle parsing, in its own tiny standalone lib (no heavy
// deps) so both leaf libs (e.g. newsapi-ai-source) and scripts (keep-fresh)
// can read a boolean setting without pulling in supertrend.mjs.

// The settings modal writes ''/'1' for its off/on toggles, but a manual edit
// could leave any string — so an on-check must match the intended values, not
// "any non-empty string" (which would treat "0" as on). Accepts the modal's
// '1' plus a real boolean/number for programmatic callers.
export function isSettingOn(v) {
  return v === '1' || v === true || v === 1;
}
