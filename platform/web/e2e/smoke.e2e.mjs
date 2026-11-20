// Route-family smoke of the built console. It drives every page under app/ in WebKit at a
// desktop and a phone width, in light and dark, against a running console (next start) that
// proxies /api/v1 to an isolated Go API. Engine-backed routes are answered from
// fixtures/engine.json inside the browser, so no engine process runs.
//   E2E_BASE_URL  console origin (default http://127.0.0.1:13000)
//   E2E_OUT       failure artifacts: one screenshot per failing page and failures.jsonl
// Exits non-zero on any failure. A missing browser is a failure, never a skip.
import { mkdirSync, readFileSync, readdirSync, appendFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:13000';
const OUT = process.env.E2E_OUT ?? join(tmpdir(), 'console-e2e');
const SETTLE_MS = 1500; // time for a page's first client fetches to answer before the checks run
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const THEMES = ['light', 'dark'];
const fixture = JSON.parse(readFileSync(join(here, 'fixtures/engine.json'), 'utf8'));

const getJSON = async (path) => {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
  return res.json();
};

// Every route family under app/ with a page.tsx, mapped to a concrete URL from the seeded data.
const ROUTES = {
  '/': async () => '/',
  '/alerts': async () => '/alerts',
  '/instruments/[slug]': async () => '/instruments/smoke-test',
  '/portfolio': async () => '/portfolio',
  '/positions/[id]': async () => {
    const { positions } = await getJSON('/api/v1/positions?limit=50');
    const p = positions.find((x) => x.instrument === 'SMOKE/TEST');
    if (!p) throw new Error('no seeded SMOKE/TEST position; run e2e/seed.sh first');
    return `/positions/${p.id}`;
  },
  '/runs': async () => '/runs',
  '/runs/[id]': async () => {
    const { runs } = await getJSON('/api/v1/runs?limit=50');
    const r = runs.find((x) => x.agentId === 'smoke-mock' && x.event === 'flip');
    if (!r) throw new Error('no seeded smoke-mock flip run; run e2e/seed.sh first');
    return `/runs/${r.id}`;
  },
  '/settings': async () => '/settings',
  '/strategies': async () => '/strategies',
};

const appRoutes = readdirSync(join(here, '../app'), { recursive: true })
  .filter((f) => f === 'page.tsx' || f.endsWith('/page.tsx'))
  .map((f) => '/' + dirname(f).replace(/^\.$/, ''))
  .sort();
const missing = appRoutes.filter((r) => !(r in ROUTES));
const stale = Object.keys(ROUTES).filter((r) => !appRoutes.includes(r));
if (missing.length || stale.length) {
  throw new Error(`route list out of date: add ${JSON.stringify(missing)}, remove ${JSON.stringify(stale)}`);
}

// Preconditions: the built console answers and its proxy reaches the API with an online worker.
const home = await fetch(BASE + '/');
if (home.status !== 200) throw new Error(`console ${BASE}/ answered ${home.status}`);
const health = await getJSON('/api/v1/health');
if (!health.stats?.workers?.some((w) => w.online)) throw new Error('no online worker via the console proxy');
console.log(`console ${BASE} answered 200; /api/v1/health reports an online worker`);

const targets = Object.fromEntries(await Promise.all(Object.entries(ROUTES).map(async ([k, f]) => [k, await f()])));

// engine-backed paths below /api/v1: the engine proxy and the instrument routes the API forwards to the engine
const ENGINE = /^https?:\/\/[^/]+\/api\/v1\/(?:engine\/|instruments\/[^/]+\/(?:live|price|news)(?:\?|$))/;
const stubKey = (method, path) => `${method} ${path.replace(/^\/instruments\/[^/]+\//, '/instruments/*/')}`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await webkit.launch();
let failed = 0;
try {
  for (const [vp, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of THEMES) {
      const context = await browser.newContext({ viewport, colorScheme: theme });
      let note = () => {}; // records against the page under check; set per page below
      await context.route(ENGINE, (route) => {
        const req = route.request();
        const path = new URL(req.url()).pathname.slice('/api/v1'.length);
        const key = stubKey(req.method(), path);
        if (!(key in fixture)) {
          note(`unstubbed engine route ${key}`);
          return route.fulfill({ status: 501, json: { error: `no fixture for ${key}` } });
        }
        return route.fulfill({ status: 200, json: fixture[key] });
      });
      for (const [route, path] of Object.entries(targets)) {
        const problems = [];
        const page = await context.newPage();
        let open = true;
        note = (msg) => { if (open) problems.push(msg); };
        page.on('pageerror', (e) => note(`page error: ${e.message}`));
        page.on('console', (m) => { if (m.type() === 'error') note(`console error: ${m.text()}`); });
        page.on('requestfailed', (r) => {
          if (new URL(r.url()).pathname.startsWith('/api/v1/')) note(`request failed: ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`);
        });
        page.on('response', (r) => {
          if (r.status() >= 400 && new URL(r.url()).pathname.startsWith('/api/v1/')) note(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`);
        });
        try {
          const res = await page.goto(BASE + path, { waitUntil: 'load' });
          if (!res || res.status() !== 200) note(`navigation answered ${res?.status()}`);
          await page.waitForTimeout(SETTLE_MS);
          const found = await page.evaluate(() => {
            const t = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
            // shortcut: a name heuristic (aria-label, labelledby, label, title, text, alt), not the full accname algorithm; switch to an axe run if it misses real cases
            const named = (el) => {
              if (t(el.getAttribute('aria-label')) || t(el.getAttribute('title'))) return true;
              const by = el.getAttribute('aria-labelledby');
              if (by && by.split(/\s+/).some((id) => t(document.getElementById(id)?.textContent))) return true;
              if (el.labels && [...el.labels].some((l) => t(l.textContent))) return true;
              if (el.tagName === 'INPUT') return ['submit', 'button', 'reset'].includes(el.type) ? t(el.value) !== '' : t(el.placeholder) !== '';
              if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return t(el.placeholder) !== '';
              return t(el.textContent) !== '' || [...el.querySelectorAll('img[alt]')].some((i) => t(i.alt));
            };
            const unnamed = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link]')]
              .filter((el) => el.checkVisibility() && !named(el))
              .map((el) => el.outerHTML.slice(0, 120));
            return { unnamed, scrollWidth: document.documentElement.scrollWidth, innerWidth };
          });
          if (found.scrollWidth > found.innerWidth) note(`horizontal overflow: scrollWidth ${found.scrollWidth} > ${found.innerWidth}`);
          for (const u of found.unnamed) note(`control without an accessible name: ${u}`);
        } catch (e) {
          note(`check aborted: ${e.message}`);
        }
        open = false;
        const label = `${route} ${vp} ${theme}`;
        if (problems.length) {
          failed++;
          const shot = join(OUT, `${route.replace(/[^a-z0-9]+/gi, '_')}-${vp}-${theme}.png`);
          await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
          appendFileSync(join(OUT, 'failures.jsonl'), JSON.stringify({ route, path, theme, viewport: vp, width: viewport.width, problems, screenshot: shot }) + '\n');
          console.log(`FAIL ${label} (${path})`);
          for (const p of problems) console.log(`     ${p}`);
        } else {
          console.log(`ok   ${label} (${path})`);
        }
        await page.close();
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
const total = appRoutes.length * Object.keys(VIEWPORTS).length * THEMES.length;
console.log(failed ? `${failed} of ${total} page checks failed; artifacts in ${OUT}` : `all ${total} page checks passed`);
if (failed) process.exitCode = 1;
