import { execFileSync } from 'node:child_process';
import type { NextConfig } from 'next';

// The console build id is the commit at `next build` time; the Runs page compares it with the control plane's.
const commit = (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
})();

// The console only ever talks to the control plane through this same-origin
// proxy, so the browser never needs CORS and the API can stay on loopback.
const api = process.env.MS_API_URL ?? 'http://127.0.0.1:8080';

const config: NextConfig = {
  // keeps `next dev` from writing AGENTS.md / CLAUDE.md into the repo
  agentRules: false,
  env: { NEXT_PUBLIC_BUILD_COMMIT: commit },
  // The rewrite proxy drops a response that stays silent past this timeout (default 30 s).
  // A chat round can think for minutes, so match the Go proxy's 180 s header budget.
  experimental: { proxyTimeout: 180_000 },
  // Compression makes the proxy buffer the /api/v1/stream SSE response, so no
  // event reaches the browser. The console runs on loopback and gains nothing from gzip.
  compress: false,
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${api}/api/v1/:path*` }];
  },
};

export default config;
