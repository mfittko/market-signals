// Shared CLI helpers (#128). Several small scripts hand-rolled the same argv
// parser and an entrypoint guard; this centralizes both. Leaf module (no deps
// beyond node stdlib) so any script can import it without pulling in the core.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';

// Minimal `--flag value` / `--bool` parser → Map. A `--flag` becomes boolean
// `true` when the next token is another flag OR the end of argv; otherwise it
// consumes the next token as its value. (The copy-pasted parsers this replaces
// had a bug here — a trailing `--flag` stored `undefined` instead of `true`.)
// Scripts needing stricter known-flag validation (refilter-signals,
// news-provider-report) keep their own parser on purpose — that's a trust boundary.
export function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    args.set(argv[i].slice(2), next === undefined || next.startsWith('--') ? true : argv[++i]);
  }
  return args;
}

// "Was this module run directly?" — compares real (symlink-resolved) paths, so
// it survives spaces, path-normalization differences, and symlinked entrypoints
// (the `file://${process.argv[1]}` string-concat form did not). Falls back to a
// plain resolve() if realpath can't stat a path. Pass `import.meta.url`.
export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(importMetaUrl);
  try {
    return realpathSync(process.argv[1]) === realpathSync(self);
  } catch {
    return resolve(process.argv[1]) === self;
  }
}
