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
// #108: memories/gates are now TABS inside the settings modal (global config).
// Per-combo bot config is instrument-specific, so it stays its own per-view modal.
// (Gates/Memories are reached via the settings modal's tabs — no header buttons.)
// #166: the ad-hoc bot button is gone — per-view bot config now opens from a
// rail row's ⚙ (railcfg), so the bot modal needs a seeded combo (below) to
// reach through the rail rather than a header button.
const MODALS = [['settings', 'cfgbtn'], ['portfolio', 'pfBtn']];
const selected = process.env.E2E_VIEWPORT ? [process.env.E2E_VIEWPORT] : Object.keys(VIEWPORTS);
// fail fast on a bad E2E_VIEWPORT rather than a later TypeError on destructure
for (const v of selected) {
  if (!VIEWPORTS[v]) throw new Error(`unknown E2E_VIEWPORT "${v}" — expected one of: ${Object.keys(VIEWPORTS).join(', ')}`);
}

test('feature walkthrough (dashboard + tabbed settings + modals × viewports)', { skip: webkit ? false : 'Playwright not installed (dev/e2e only)' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  const dbPath = join(dir, 'candles.db');
  const settingsPath = join(dir, 'settings.json');
  const server = buildServer({ dbPath, settingsPath, fetcher: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    // #163: DoD — the two read-only server-truth surfaces respond over HTTP.
    const health = await (await fetch(base + '/api/health')).json();
    assert.equal(health.ok, true);
    assert.equal(health.halted, false);
    assert.ok(Array.isArray(health.feed));
    const trades = await (await fetch(base + '/api/trades')).json();
    assert.equal(trades.ok, true);
    assert.ok(Array.isArray(trades.trades));

    // #164: DoD — the two-lane explainer ships in the served page, "verdict" retired
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('Gates are a mechanical filter on the signal'), 'plan §4 explainer present');
    assert.ok(html.includes('gatesBotBadge'), 'two-lane badge renderer shipped');
    // #165: fleet rail nav container ships in the served page
    assert.ok(html.includes('id="rail"') && html.includes('role="list"'), 'fleet rail container present');

    // seed a second bot combo so the rail has a real row to navigate to
    const seedBot = await fetch(base + '/api/settings', {
      method: 'POST',
      body: JSON.stringify({ bot: { bots: { 'WTICO/USD|M15': { enabled: true } } } }),
    });
    assert.equal(seedBot.status, 200, 'bot combo seed request succeeded');

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
        // #166: selects must not depend on rail data — stall /api/bots so the
        // rail hasn't loaded yet when the DOM first settles, and confirm the
        // selects render visible anyway (no render-then-hide flicker).
        let releaseBots;
        const botsGate = new Promise((r) => { releaseBots = r; });
        await p.route('**/api/bots', async (route) => { await botsGate; await route.continue(); });
        await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
        assert.equal(await p.evaluate(() => getComputedStyle(document.getElementById('instSel')).display !== 'none' && getComputedStyle(document.getElementById('granSel')).display !== 'none'), true, 'instrument/granularity selects visible before rail data arrives');
        releaseBots();
        await p.unroute('**/api/bots');
        await p.waitForLoadState('networkidle');
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
          // #108: five GLOBAL-config tabs, in order (bot is per-view, not here)
          assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('#cfgTabs button')].map((b) => b.dataset.tab)), ['llm', 'news', 'gates', 'mem', 'adv'], 'five settings tabs in order (no bot)');
          // Gates tab: embeds the per-gate sub-tabs (filter/recheck/bot/chat)
          await p.evaluate(() => [...document.querySelectorAll('#cfgTabs button')].find((b) => b.dataset.tab === 'gates').click());
          await p.waitForTimeout(200);
          assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('#gatesTabs button')].map((b) => b.dataset.tab)), ['filter', 'recheck', 'bot', 'chat'], 'gates tab embeds one sub-tab per gate');
          // Save footer hides on a management tab — check COMPUTED display, since a
          // stray author `display:flex` can defeat the [hidden] attribute
          assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector('#cfg .cfgfoot')).display), 'none', 'Save footer visually hidden on management tab');
          // Memories tab: embeds the add-row
          await p.evaluate(() => [...document.querySelectorAll('#cfgTabs button')].find((b) => b.dataset.tab === 'mem').click());
          await p.waitForTimeout(200);
          assert.ok(await p.evaluate(() => !!document.getElementById('memAddBtn')), 'memories tab embeds the add control');
          // the redundant header memories/gates buttons are gone (reached via tabs)
          assert.equal(await p.evaluate(() => !!document.getElementById('memBtn') || !!document.getElementById('gateBtn')), false, 'no redundant header gates/memories buttons');
          await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
          // per-view bot modal opens from a rail row's ⚙ (railcfg) and carries its tabs
          await p.waitForFunction(() => document.querySelectorAll('#rail .railcfg').length > 0, { timeout: 5000 });
          await p.evaluate(() => document.querySelector('#rail .railcfg').click());
          await p.waitForTimeout(300);
          assert.ok(await p.evaluate(() => !!document.querySelector('#botdlg[open]') && !!document.getElementById('bmTabs')), 'per-view bot modal opens with its config tabs');
          await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));

          // #166: workspace tabs ([tape][trades][tuning]) under the chart, scoped
          // to the focused combo — tape is the default, trades/tuning switch in.
          assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('#wsTabs button')].map((b) => b.dataset.tab)), ['tape', 'trades', 'tuning'], 'workspace tab strip present, tape default');
          assert.ok(await p.evaluate(() => !document.getElementById('ws-tape').hidden && document.getElementById('ws-trades').hidden), 'tape panel visible by default');
          await p.evaluate(() => document.querySelector('#wsTabs button[data-tab="trades"]').click());
          await p.waitForTimeout(300);
          assert.ok(await p.evaluate(() => !document.getElementById('ws-trades').hidden), 'trades tab switches in');
          assert.ok(await p.evaluate(() => !!document.getElementById('wsTradesRows').textContent.trim()), 'trades tab rendered content (open row or empty state)');
          await p.evaluate(() => document.querySelector('#wsTabs button[data-tab="tuning"]').click());
          await p.waitForTimeout(300);
          assert.ok(await p.evaluate(() => !!document.querySelector('#ws-tuning [data-tab="setup"]')), 'tuning tab inlines the bot setup/strategy tabs');
          await p.evaluate(() => document.querySelector('#wsTabs button[data-tab="tape"]').click());

          // #166: ledger overlay (renamed from "portfolio") — equity/all trades/scoreboard/audit
          await p.evaluate(() => document.getElementById('pfBtn').click());
          await p.waitForTimeout(300);
          assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('#pfTabs button')].map((b) => b.textContent)), ['equity', 'all trades', 'scoreboard', 'audit'], 'ledger opens with 4 tabs');
          await p.evaluate(() => document.querySelector('#pfTabs button[data-tab="trades"]').click());
          await p.waitForTimeout(300);
          assert.ok(await p.evaluate(() => !!document.getElementById('pfTradesRows').textContent.trim()), 'ledger all-trades tab rendered content');
          await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));

          // #165/#166: fleet rail — one row for the seeded bot combo, and navigating
          // to its hash focuses the chart on that combo (instSel value flips).
          await p.waitForFunction(() => document.querySelectorAll('#rail .railjump[data-combo]').length > 0, { timeout: 5000 });
          const railCombos = await p.evaluate(() => [...document.querySelectorAll('#rail .railjump[data-combo]')].map((b) => b.dataset.combo));
          assert.ok(railCombos.includes('WTICO/USD|M15'), 'rail shows a row for the seeded bot combo');
          const [chartReq] = await Promise.all([
            p.waitForResponse((r) => r.url().includes('/api/chart') && r.url().includes('granularity=M15')),
            p.evaluate(() => { location.hash = '#bot/' + encodeURIComponent('WTICO/USD|M15'); }),
          ]);
          assert.equal(chartReq.ok(), true, 'hash navigation triggers a chart fetch for the new combo');
          await p.waitForTimeout(300);
          assert.equal(await p.evaluate(() => document.getElementById('granSel').value), 'M15', '#bot/<combo> hash route changed the chart granularity');
          assert.equal(await p.evaluate(() => document.getElementById('instSel').value), 'WTICO/USD', '#bot/<combo> hash route changed the chart instrument');
          // #165 review: a hash missing the '|' separator (no granularity) must not
          // crash or navigate — the route is ignored (state stays on the prior combo).
          await p.evaluate(() => { location.hash = '#bot/' + encodeURIComponent('WTICO/USD'); });
          await p.waitForTimeout(300);
          assert.equal(await p.evaluate(() => document.getElementById('granSel').value), 'M15', 'invalid hash route (missing granularity) is ignored, chart state unchanged');
          assert.equal(await p.evaluate(() => document.getElementById('instSel').value), 'WTICO/USD', 'invalid hash route (missing granularity) is ignored, chart state unchanged');
          // #166: selects always drive the chart directly (location.search reload),
          // no hash, no bot row required.
          await Promise.all([
            p.waitForNavigation(),
            p.evaluate(() => { document.getElementById('granSel').value = 'M5'; document.getElementById('granSel').dispatchEvent(new Event('change')); }),
          ]);
          await p.waitForTimeout(300);
          assert.equal(await p.evaluate(() => document.getElementById('granSel').value), 'M5', 'select change updated the chart granularity');
          assert.equal(await p.evaluate(() => new URL(location.href).searchParams.get('granularity')), 'M5', 'select change updated the URL search params');
          // #166: the rail toggle collapses/expands the sidebar and persists
          assert.equal(await p.evaluate(() => document.getElementById('railToggle').getAttribute('aria-expanded')), 'true', 'rail toggle starts expanded');
          assert.ok(await p.evaluate(() => getComputedStyle(document.getElementById('rail')).display !== 'none'), 'rail visible before toggling');
          await p.evaluate(() => document.getElementById('railToggle').click());
          await p.waitForTimeout(150);
          assert.equal(await p.evaluate(() => document.getElementById('railToggle').getAttribute('aria-expanded')), 'false', 'rail toggle collapses (aria-expanded flips)');
          assert.equal(await p.evaluate(() => getComputedStyle(document.getElementById('rail')).display), 'none', 'rail hidden after collapsing');
          await p.evaluate(() => document.getElementById('railToggle').click()); // restore expanded for the rest of the run
          await p.waitForTimeout(150);
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
