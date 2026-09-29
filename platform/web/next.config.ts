import type { NextConfig } from 'next';

// The console only ever talks to the control plane through this same-origin
// proxy, so the browser never needs CORS and the API can stay on loopback.
const api = process.env.MS_API_URL ?? 'http://127.0.0.1:8080';

const config: NextConfig = {
  // keeps `next dev` from writing AGENTS.md / CLAUDE.md into the repo
  agentRules: false,
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${api}/api/v1/:path*` }];
  },
};

export default config;
