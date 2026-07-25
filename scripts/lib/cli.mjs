// Shared CLI helpers (#128). Several small scripts hand-rolled the same argv
// parser and an entrypoint guard; this centralizes both. Leaf module (no deps
// beyond node stdlib) so any script can import it without pulling in the core.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Minimal `--flag value` / `--bool` parser → Map. A `--flag` with no following
// value (or followed by another `--flag`) becomes boolean `true`. This is the
// exact behavior the copy-pasted parsers had; scripts needing stricter,
// known-flag validation (refilter-signals, news-provider-report) keep their own
// specialized parser on purpose — that validation is a trust boundary.
export function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i]);
  }
  return args;
}

// "Was this module run directly?" — resolve-based, so it survives paths with
// spaces and symlinks (the `file://${process.argv[1]}` string-concat form did
// not). Pass `import.meta.url` from the calling module.
export function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(importMetaUrl);
}
