// Feature-walkthrough e2e (#129) — codifies the manual UI review loop.
// Boots the real signal-server on an ephemeral port, drives the served page in
// headless WebKit, and asserts the dashboard + all five modals work across the
// four viewport/orientation cells, with zero console/page errors.
//
// This is NOT part of the fast `npm test` lane: it lives under test/e2e/ (not
// the `test/*.test.mjs` glob) and needs Playwright + a WebKit browser. Run with
//   npm run test:e2e            (all four viewports)
//   E2E_VIEWPORT=phone-portrait npm run test:e2e   (one cell — the CI matrix)
// Without Playwright installed it skips, so the dep-free core suite is unaffected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../../scripts/signal-server.mjs';

let webkit = null;
try { ({ webkit } = await import('playwright')); } catch { /* skips below */ }

const VIEWPORTS = {
  'desktop-landscape': [1440, 900],
  'desktop-portrait': [1024, 1366],
  'phone-portrait': [390, 844],
  'phone-landscape': [844, 390],
};
const MODALS = [['settings', 'cfgbtn'], ['memories', 'memBtn'], ['gates', 'gateBtn'], ['bot', 'botBtn'], ['portfolio', 'pfBtn']];
const selected = process.env.E2E_VIEWPORT ? [process.env.E2E_VIEWPORT] : Object.keys(VIEWPORTS);
// fail fast on a bad E2E_VIEWPORT rather than a later TypeError on destructure
for (const v of selected) {
  if (!VIEWPORTS[v]) throw new Error(`unknown E2E_VIEWPORT "${v}" — expected one of: ${Object.keys(VIEWPORTS).join(', ')}`);
}

test('feature walkthrough (dashboard + 5 modals × viewports)', { skip: webkit ? false : 'Playwright not installed (dev/e2e only)' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  const dbPath = join(dir, 'candles.db');
  const settingsPath = join(dir, 'settings.json');
  const server = buildServer({ dbPath, settingsPath, fetcher: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    // seed a filter draft so the gates modal has drafts content
    const seed = await fetch(base + '/api/gate-prompts', { method: 'POST', body: JSON.stringify({ action: 'save', gate: 'filter', prompt: 'e2e walkthrough override' }) });
    assert.equal(seed.status, 200, 'gate-draft seed request succeeded');
    browser = await webkit.launch({ headless: true });
    for (const vname of selected) {
      await t.test(vname, async () => {
        const [width, height] = VIEWPORTS[vname]; // validated up front
        const p = await browser.newPage({ viewport: { width, height } });
        const errs = [];
        p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
        p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
        await p.goto(base + '/', { waitUntil: 'networkidle' });
        await p.waitForTimeout(400);

        // base page invariants
        assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'no horizontal overflow');
        assert.ok(await p.evaluate(() => !!document.getElementById('chart')), 'chart canvas present');
        // canvases carry a text alternative (a11y)
        assert.ok(await p.evaluate(() => document.getElementById('chart').getAttribute('role') === 'img'), 'chart canvas has role=img');

        // collapsible chat (collapsed by default, toggles, persists to markup)
        assert.ok(await p.evaluate(() => document.getElementById('app').classList.contains('chat-collapsed')), 'chat collapsed by default');
        await p.evaluate(() => document.getElementById('chatToggle').click());
        await p.waitForTimeout(150);
        assert.ok(await p.evaluate(() => !document.getElementById('app').classList.contains('chat-collapsed')), 'chat toggle expands the sidebar');
        assert.equal(await p.evaluate(() => document.getElementById('chatToggle').getAttribute('aria-expanded')), 'true', 'aria-expanded flips');
        // STT mic button (#137): present with a11y wiring. It reveals itself only
        // where MediaRecorder+getUserMedia exist (a secure context) — headless
        // WebKit lacks them, so we assert the element + labels, not visibility.
        assert.ok(await p.evaluate(() => !!document.getElementById('micBtn')), 'mic button present in chat form');
        assert.equal(await p.evaluate(() => document.getElementById('micBtn').getAttribute('aria-pressed')), 'false', 'mic starts un-pressed');
        assert.ok(await p.evaluate(() => !!document.getElementById('micBtn').getAttribute('aria-label')), 'mic button is labelled');
        await p.evaluate(() => document.getElementById('chatToggle').click());

        // every modal opens with no internal horizontal overflow
        for (const [mname, btn] of MODALS) {
          await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
          await p.evaluate((id) => document.getElementById(id)?.click(), btn);
          await p.waitForTimeout(300);
          assert.ok(await p.evaluate(() => !!document.querySelector('dialog[open]')), `${mname} modal opens`);
          assert.equal(await p.evaluate(() => { const d = document.querySelector('dialog[open]'); return d.scrollWidth > d.clientWidth + 1; }), false, `${mname} modal has no horizontal overflow`);
        }
        await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));

        // functional deep-checks (one representative viewport keeps the matrix fast)
        if (vname === 'desktop-landscape') {
          // settings: the contextual provider panel swaps fields
          await p.evaluate(() => document.getElementById('cfgbtn').click());
          await p.waitForTimeout(300);
          await p.evaluate(() => { const s = document.getElementById('f-provider'); s.value = 'openai-compatible'; s.dispatchEvent(new Event('change', { bubbles: true })); });
          await p.waitForTimeout(150);
          assert.ok(await p.evaluate(() => !!document.getElementById('f-OPENAI_BASE_URL')), 'provider swap reveals the base-URL field');
          // news tab: modes are auto/shadow/off (primary dropped)
          await p.evaluate(() => { const t2 = [...document.querySelectorAll('#cfgTabs button')].find((b) => b.dataset.tab === 'news'); t2 && t2.click(); });
          await p.waitForTimeout(150);
          assert.deepEqual(await p.evaluate(() => [...document.getElementById('f-NEWSAPI_AI_MODE').options].map((o) => o.value)), ['auto', 'shadow', 'off'], 'news modes = auto/shadow/off');
          await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
          // gates: one tab per gate, panels switch
          await p.evaluate(() => document.getElementById('gateBtn').click());
          await p.waitForTimeout(300);
          assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('#gatesTabs button')].map((b) => b.dataset.tab)), ['filter', 'recheck', 'bot', 'chat'], 'one tab per gate');
          await p.evaluate(() => { const t2 = [...document.querySelectorAll('#gatesTabs button')].find((b) => b.dataset.tab === 'bot'); t2 && t2.click(); });
          await p.waitForTimeout(150);
          assert.equal(await p.evaluate(() => [...document.querySelectorAll('#gatesList .gatepanel')].filter((x) => !x.hidden).map((x) => x.dataset.panel)[0]), 'bot', 'gate tab switch shows the bot panel');
          await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
          // signal history "load 10 more": clicking must actually run (regression
          // for a call site that dropped the view arg → a TypeError on click).
          const moreShown = await p.evaluate(() => { const b = document.getElementById('histMore'); return b && !b.hidden; });
          if (moreShown) {
            const rows0 = await p.evaluate(() => document.querySelectorAll('#hist tbody tr').length);
            await p.evaluate(() => document.getElementById('histMore').click());
            await p.waitForTimeout(500);
            const rows1 = await p.evaluate(() => document.querySelectorAll('#hist tbody tr').length);
            const stillShown = await p.evaluate(() => { const b = document.getElementById('histMore'); return b && !b.hidden; });
            assert.ok(rows1 >= rows0, 'load-more never drops rows');
            assert.ok(rows1 > rows0 || !stillShown, 'load-more either appended older rows or hid itself (reached the start)');
          }
        }

        assert.deepEqual(errs, [], `no console/page errors on ${vname}`);
        await p.close();
      });
    }
  } finally {
    if (browser) await browser.close(); // may be unset if launch/seed threw
    await new Promise((r) => server.close(r)); // always close the server; await so the runner exits cleanly on CI
    rmSync(dir, { recursive: true, force: true });
  }
});
