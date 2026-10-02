// A settings form holds the values it read at page load. Saving them all would revert an edit made elsewhere in between.
// This keeps only the keys the operator changed against the loaded values, and merges edited model entries into the fresh map.
type Bag = Record<string, unknown>;

const norm = (v: unknown) => (v == null ? '' : v === true || v === 'true' || v === 'on' ? '1' : v === false || v === 'false' || v === 'off' ? '0' : String(v));
// An absent flag and a form-sent '0' mean the same default.
const same = (a: unknown, b: unknown) => norm(a) === norm(b) || (a == null && b === '0') || (b == null && a === '0');

export function changedPatch(loaded: Bag, fresh: Bag, patch: Bag): Bag {
  const out: Bag = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'models') {
      const lm = (loaded.models ?? {}) as Record<string, string>;
      const edits = Object.entries(v as Record<string, string>).filter(([p, m]) => !same(lm[p], m));
      if (edits.length) out.models = { ...((fresh.models ?? {}) as Record<string, string>), ...Object.fromEntries(edits) };
    } else if (!same(loaded[k], v)) out[k] = v;
  }
  return out;
}
