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
import { withDb } from '../../scripts/supertrend.mjs';

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

    // #171: seed a decision-context news block (the default view combo,
    // WTICO/USD|M5, so the audit tab picks it up with no extra navigation)
    // plus 10 flip decisions with 3 gate disagreements on the WTICO/USD|M15
    // combo seeded above, so the rail's gray tuning note renders.
    withDb(dbPath, (db) => {
      db.exec('CREATE TABLE IF NOT EXISTS bot_journal (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, position_id INTEGER, reason TEXT, context TEXT)');
      db.prepare('INSERT INTO bot_journal (at, action, reason, context) VALUES (?,?,?,?)').run(
        new Date().toISOString(), 'decision', 'e2e seeded news decision',
        JSON.stringify({
          instrument: 'WTICO/USD', granularity: 'M5', event: 'review', decision: { action: 'hold' },
          instrumentContext: { sentinel: { escalation: false, asOf: '2026-07-27T00:00:00Z', headlines: [{ title: 'e2e seeded headline: OPEC+ signals output hike', source: 'reuters', time: '2026-07-27T00:00:00Z', url: 'https://reuters.example/e2e' }] } },
        }),
      );
      const sig = db.prepare('INSERT INTO signals (instrument, granularity, time, signal, verdict) VALUES (?,?,?,?,?)');
      const dec = db.prepare('INSERT INTO bot_journal (at, action, reason, context) VALUES (?,?,?,?)');
      const rows = [
        ['suppress', 'open'], ['suppress', 'open'], ['alert', 'hold'],
        ['suppress', 'hold'], ['alert', 'open'], ['alert', 'open'], ['alert', 'open'],
        ['suppress', 'hold'], ['alert', 'open'], ['suppress', 'hold'],
      ]; // 3 disagreements / 10 gate-bearing flip decisions ⇒ rail note fires (>=3)
      rows.forEach(([verdict, action], i) => {
        const t = `2026-07-26T00:${String(i).padStart(2, '0')}:00.000Z`;
        sig.run('WTICO/USD', 'M15', t, 'buy', verdict);
        dec.run(t, 'decision', 'e2e gate-disagreement seed', JSON.stringify({
          instrument: 'WTICO/USD', granularity: 'M15', event: 'flip', decision: { action },
          instrumentContext: { flip: { time: t } },
        }));
      });
    });
    browser = await webkit.launch({ headless: true });
    for (const vname of selected) {
      await t.test(vname, async () => {
        const [width, height] = VIEWPORTS[vname]; // validated up front
        const p = await browser.newPage({ viewport: { width, height } });
        // #170 review: dedupe the indicator-checkbox-toggle + navigation-wait
        // pattern used by both the "check ema" and the "clean up, uncheck it" steps.
        const setInd = (key, checked) => Promise.all([
          p.waitForNavigation(),
          p.evaluate(([k, c]) => {
            const cb = document.querySelector(`#indpanel input[data-ind="${k}"]`);
            cb.checked = c;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
          }, [key, checked]),
        ]);
        const errs = [];
        p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
        p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
        // #166: selects must not depend on rail data — stall /api/bots so the
        // rail hasn't loaded yet when the DOM first settles, and confirm the
        // selects render visible anyway (no render-then-hide flicker).
        let releaseBots;
        const botsGate = new Promise((r) => { releaseBots = r; });
        // continue() can race unroute/page teardown once the gate opens — a
        // route that was auto-continued in between throws "already handled".
        await p.route('**/api/bots', async (route) => { await botsGate; try { await route.continue(); } catch { /* already handled */ } });
        await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
        assert.equal(await p.evaluate(() => getComputedStyle(document.getElementById('instSel')).display !== 'none' && getComputedStyle(document.getElementById('granSel')).display !== 'none'), true, 'instrument/granularity selects visible before rail data arrives');
        releaseBots();
        await p.waitForLoadState('networkidle');
        await p.unroute('**/api/bots');
        await p.waitForTimeout(400);

        // rail '+ add bot' row (plan §5 C2): the current view combo has no bot
        // on the fresh test server (default view), so the add row must render
        // and open the bot modal for that combo.
        if (vname === 'desktop-landscape') {
          const addBtn = await p.evaluate(() => { const b = document.getElementById('railAddBot'); return b ? b.textContent : null; });
          assert.ok(addBtn && addBtn.startsWith('+ add bot for '), 'rail offers + add bot for the un-botted current combo');
          await p.evaluate(() => document.getElementById('railAddBot').click());
          await p.waitForTimeout(300);
          assert.ok(await p.evaluate(() => document.getElementById('botdlg')?.open), '+ add bot opens the bot modal');
          await p.evaluate(() => document.getElementById('botdlg').close());

          // carry-over from PR #181 (#170 item 6): #railAddBot must be ABSENT
          // when the viewed combo already has a bot — navigate to the seeded
          // WTICO/USD|M15 combo (has a bot from the seed above) and assert no
          // add-bot row renders for it.
          const pBotted = await browser.newPage({ viewport: { width, height } });
          await pBotted.goto(base + '/?instrument=WTICO%2FUSD&granularity=M15', { waitUntil: 'networkidle' });
          await pBotted.waitForFunction(() => document.querySelectorAll('#rail .railjump[data-combo]').length > 0, { timeout: 5000 });
          await pBotted.waitForTimeout(300);
          assert.equal(await pBotted.evaluate(() => document.getElementById('railAddBot')), null, 'rail offers no + add bot row when the viewed combo already has a bot');
          await pBotted.close();
        }

        // 27/07 dead-UI regression: a stale #bot hash disagreeing with explicit
        // query params must not throw (window.history shadow) or re-assert the
        // hash — the page boots alive and the QUERY combo wins.
        if (vname === 'desktop-landscape') {
          const p2 = await browser.newPage({ viewport: { width, height } });
          const errs2 = [];
          p2.on('pageerror', (e) => errs2.push(e.message));
          await p2.goto(base + '/?instrument=WTICO%2FUSD&granularity=M15#bot/' + encodeURIComponent('WTICO/USD|M5'), { waitUntil: 'networkidle' });
          await p2.waitForTimeout(500);
          assert.deepEqual(errs2, [], 'no page errors with mismatched query+hash');
          assert.ok(await p2.evaluate(() => document.getElementById('instSel').options.length > 0), 'selects populated (page alive)');
          assert.equal(await p2.evaluate(() => document.getElementById('granSel').value), 'M15', 'explicit query granularity wins over stale hash');
          assert.equal(await p2.evaluate(() => location.hash), '', 'stale hash dropped');
          await p2.close();

          // #168: a PARTIAL explicit query (instrument only, no granularity) that
          // disagrees with the hash must still win — the both-present check used
          // to let a disagreeing hash silently override a partial query.
          const p3 = await browser.newPage({ viewport: { width, height } });
          const errs3 = [];
          p3.on('pageerror', (e) => errs3.push(e.message));
          await p3.goto(base + '/?instrument=WTICO%2FUSD#bot/' + encodeURIComponent('XAUUSD|M5'), { waitUntil: 'networkidle' });
          await p3.waitForTimeout(500);
          assert.deepEqual(errs3, [], 'no page errors with mismatched partial query+hash');
          assert.equal(await p3.evaluate(() => document.getElementById('instSel').value), 'WTICO/USD', 'explicit partial query instrument wins over stale hash');
          assert.equal(await p3.evaluate(() => location.hash), '', 'stale hash dropped for a disagreeing partial query');
          await p3.close();
        }

        // base page invariants
        assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'no horizontal overflow');
        assert.ok(await p.evaluate(() => !!document.getElementById('chart')), 'chart canvas present');
        // canvases carry a text alternative (a11y)
        assert.ok(await p.evaluate(() => document.getElementById('chart').getAttribute('role') === 'img'), 'chart canvas has role=img');

        // #168 F10: phone viewports collapse the tape table to <=4 visible
        // columns (reason/gates move behind the row's expand toggle) with no
        // horizontal scroll anywhere in the table.
        if (vname.startsWith('phone')) {
          // operator decision: indicators stay always-visible (no toggle
          // button) even on phone widths — so the cost has to be paid by
          // layout instead: below <900px the panel renders as a static row,
          // never a corner overlay sitting on top of the candles.
          const indOverlap = await p.evaluate(() => {
            const panel = document.getElementById('indpanel').getBoundingClientRect();
            const canvas = document.getElementById('chart').getBoundingClientRect();
            return !(panel.right <= canvas.left || panel.left >= canvas.right || panel.bottom <= canvas.top || panel.top >= canvas.bottom);
          });
          assert.ok(!indOverlap, `indicator panel does not overlay the chart canvas on ${vname}`);
          const histCols = await p.evaluate(() => {
            const table = document.getElementById('hist');
            const visibleTh = [...table.querySelectorAll('thead th')].filter((th) => getComputedStyle(th).display !== 'none' && th.textContent.trim());
            return { visible: visibleTh.length, scrollWidth: table.scrollWidth, clientWidth: table.clientWidth };
          });
          assert.ok(histCols.visible <= 4, `tape table shows <=4 visible columns on ${vname} (got ${histCols.visible})`);
          assert.ok(histCols.scrollWidth <= histCols.clientWidth + 1, `tape table has no horizontal overflow on ${vname}`);
          const hasRows = await p.evaluate(() => document.querySelectorAll('#hist tbody tr').length > 0);
          if (hasRows) {
            const expandBtn = await p.evaluate(() => {
              const b = document.querySelector('#hist .rowExpandBtn');
              return !!b && getComputedStyle(b).display !== 'none' && b.getClientRects().length > 0;
            });
            assert.ok(expandBtn, 'collapsed tape rows carry an expand toggle for reason/gates');
            // #168: clicking the toggle must actually REVEAL detail content, not
            // just flip a class — a CSS cascade bug once kept detail rows
            // display:none at every width regardless of the click.
            const before = await p.evaluate(() => {
              const detail = document.querySelector('#hist .rowExpandBtn').closest('tr').nextElementSibling;
              return { hidden: detail.hidden, rects: detail.getClientRects().length, text: detail.textContent.trim() };
            });
            assert.equal(before.hidden, true, 'detail row starts hidden');
            assert.equal(before.rects, 0, 'collapsed detail row is truly not rendered (no client rects)');
            await p.evaluate(() => document.querySelector('#hist .rowExpandBtn').click());
            await p.waitForTimeout(100);
            const after = await p.evaluate(() => {
              const detail = document.querySelector('#hist .rowExpandBtn').closest('tr').nextElementSibling;
              return { hidden: detail.hidden, visible: getComputedStyle(detail).display !== 'none', text: detail.textContent.trim() };
            });
            assert.equal(after.hidden, false, 'clicking the expand toggle un-hides the detail row');
            assert.ok(after.visible, `expanded detail row is actually rendered (computed display != none) on ${vname}`);
            assert.ok(after.text.length > 0, 'expanded detail row shows visible text content');
          }
        }

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
          // #171: sentinelSourceFootnotes default flips to ON — an untouched
          // settings.json (this fresh e2e db) must render the 'on' option selected.
          assert.equal(await p.evaluate(() => document.getElementById('f-sentinelSourceFootnotes').value), '1', 'sentinelSourceFootnotes defaults on when never explicitly set');
          // #167: three GLOBAL-config tabs, in order (gates/memories moved into the
          // workspace tuning tab's global fieldset; bot stays per-view, not here)
          assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('#cfgTabs button')].map((b) => b.dataset.tab)), ['llm', 'news', 'adv'], 'three settings tabs in order (no gates/mem/bot)');
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
          // #168 (2.7): shared tabStrip helper — ArrowRight moves focus AND
          // activates the next tab (WAI-ARIA tabs pattern), Home returns to the first.
          await p.evaluate(() => document.querySelector('#wsTabs button[data-tab="tape"]').focus());
          await p.keyboard.press('ArrowRight');
          await p.waitForTimeout(150);
          assert.equal(await p.evaluate(() => document.activeElement.dataset.tab), 'trades', 'ArrowRight moves focus to the next tab');
          assert.ok(await p.evaluate(() => document.querySelector('#wsTabs button[data-tab="trades"]').classList.contains('on')), 'ArrowRight also activates the tab it moved to');
          await p.keyboard.press('Home');
          await p.waitForTimeout(150);
          assert.equal(await p.evaluate(() => document.activeElement.dataset.tab), 'tape', 'Home moves focus back to the first tab');
          await p.evaluate(() => document.querySelector('#wsTabs button[data-tab="trades"]').click());
          await p.waitForTimeout(300);
          assert.ok(await p.evaluate(() => !document.getElementById('ws-trades').hidden), 'trades tab switches in');
          assert.ok(await p.evaluate(() => !!document.getElementById('wsTradesRows').textContent.trim()), 'trades tab rendered content (open row or empty state)');
          await p.evaluate(() => document.querySelector('#wsTabs button[data-tab="tuning"]').click());
          await p.waitForTimeout(300);
          assert.ok(await p.evaluate(() => !!document.querySelector('#ws-tuning [data-tab="setup"]')), 'tuning tab inlines the bot setup/strategy tabs');
          // #167 (F18): scope-explicit fieldsets — this bot / instrument / global
          assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('#ws-tuning fieldset legend')].map((l) => l.textContent.split(' (')[0].split(' —')[0])), ['this bot', 'WTICO/USD', 'global'], 'tuning tab groups fields into scope-explicit fieldsets');
          // gates/memories moved here from the settings modal, reused verbatim
          assert.ok(await p.evaluate(() => !!document.getElementById('gatesTabs') && !!document.getElementById('memAddBtn')), 'gates/memories embedded in the tuning tab global fieldset');
          // #168: gatesTabs is created by renderTuningTab, AFTER boot — tabStrip
          // used to be bound at boot against a not-yet-existing element (a no-op),
          // leaving gates without arrow-key nav. Pin it here.
          await p.evaluate(() => document.querySelector('#gatesTabs button[data-tab="filter"]').focus());
          await p.keyboard.press('ArrowRight');
          await p.waitForTimeout(150);
          assert.equal(await p.evaluate(() => document.activeElement.dataset.tab), 'recheck', 'gatesTabs ArrowRight moves focus to the next gate tab');
          assert.ok(await p.evaluate(() => document.querySelector('#gatesTabs button[data-tab="recheck"]').classList.contains('on')), 'gatesTabs ArrowRight also activates the tab it moved to');
          // #167: the gates/memories mount moved OUT of renderBotSetupTab (which
          // repaints on every bot-field save()) into renderTuningTab (mounted once)
          // — a bot-field save must never wipe an in-progress gate draft or memory input.
          await p.evaluate(() => { const t = [...document.querySelectorAll('#gatesTabs button')].find((b) => b.dataset.tab === 'bot'); t && t.click(); });
          await p.evaluate(() => { const t = [...document.querySelectorAll('#gatesTabs button')].find((b) => b.dataset.tab === 'filter'); t && t.click(); });
          await p.evaluate(() => { const ta = document.querySelector('#gatesList .gaterow[data-gate="filter"] .gateEditPrompt'); ta.value = 'draft in progress — do not lose me'; });
          await p.evaluate(() => { const cb = document.getElementById('wsbmEnabled'); cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true })); });
          await p.waitForTimeout(300);
          assert.equal(await p.evaluate(() => document.querySelector('#gatesList .gaterow[data-gate="filter"] .gateEditPrompt')?.value), 'draft in progress — do not lose me', 'toggling a bot field preserves an in-progress gate draft');
          await p.evaluate(() => { const cb = document.getElementById('wsbmEnabled'); cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true })); });
          await p.waitForTimeout(300);
          await p.evaluate(() => document.querySelector('#wsTabs button[data-tab="tape"]').click());

          // #166/#168: portfolio overlay — equity/all trades/scoreboard/audit (the "ledger" rename was reverted on operator feedback: plain words win)
          await p.evaluate(() => document.getElementById('pfBtn').click());
          await p.waitForTimeout(300);
          assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('#pfTabs button')].map((b) => b.textContent)), ['equity', 'all trades', 'scoreboard', 'audit'], 'portfolio overlay opens with 4 tabs');
          await p.evaluate(() => document.querySelector('#pfTabs button[data-tab="trades"]').click());
          await p.waitForTimeout(300);
          assert.ok(await p.evaluate(() => !!document.getElementById('pfTradesRows').textContent.trim()), 'portfolio all-trades tab rendered content');
          // #171 F24: the audit tab renders the seeded decision's recorded news
          // (real headline/source/link — see news.mjs#newsContextFor), not an
          // invented summary.
          await p.evaluate(() => document.querySelector('#pfTabs button[data-tab="audit"]').click());
          await p.waitForTimeout(300);
          const auditHtml = await p.evaluate(() => document.getElementById('tab-audit').innerHTML);
          assert.ok(auditHtml.includes('news used:'), 'audit tab renders the "news used:" section for the seeded decision');
          assert.ok(auditHtml.includes('e2e seeded headline: OPEC+ signals output hike'), 'seeded headline title renders');
          assert.ok(/href="https:\/\/reuters\.example\/e2e"[^>]*target="_blank"[^>]*rel="noopener"/.test(auditHtml), 'headline link opens in a new tab with rel=noopener');
          await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));

          // #171 review item 1/6: the SAME newsHtml() render helper the audit
          // tab uses is shared by the tape row detail + verdict banner's bot
          // lane — pinned via synthetic input (a full tape-row round trip
          // would need a decision timestamp inside a real signal's candle
          // window, which the "now"-stamped seed above can't guarantee).
          const newsHeadlineHtml = await p.evaluate(() => window.newsHtml({
            news: { headlines: [{ title: 'synthetic tape headline', source: 'reuters', time: '2026-01-01T00:00:00Z', url: 'https://reuters.example/x' }] },
          }));
          assert.ok(newsHeadlineHtml.includes('news used:') && newsHeadlineHtml.includes('synthetic tape headline'), 'newsHtml renders recorded headlines for the tape/verdict-banner surfaces too');
          const newsFallbackHtml = await p.evaluate(() => window.newsHtml({ news: null, toolTrace: [{ name: 'sentinel_news', ok: true }] }));
          assert.ok(newsFallbackHtml.includes('news consulted (1) — headlines not recorded'), 'newsHtml falls back to the honest "consulted, not recorded" line');
          // #171 review item 5: https-only guard on headline hrefs.
          assert.equal(await p.evaluate(() => window.safeUrl('javascript:alert(1)')), null, 'safeUrl rejects a non-https scheme');
          assert.equal(await p.evaluate(() => window.safeUrl('https://reuters.example/x')), 'https://reuters.example/x', 'safeUrl passes through an https url');

          // operator 27/07: the popover toggle was a dead control (author display
          // beat [hidden]) — checkboxes are now ALWAYS visible, no button.
          assert.equal(await p.evaluate(() => !!document.getElementById('indbtn')), false, 'dead indicators toggle removed');
          assert.ok(await p.evaluate(() => document.querySelectorAll('#indpanel input[data-ind]').length > 0), 'indicator checkboxes always visible');
          assert.ok(await p.evaluate(() => !!document.querySelector('#wrap #indpanel')), '#indpanel lives inside #wrap (no #indpop wrapper)');
          await setInd('ema', true);
          await p.waitForTimeout(300);
          assert.equal(await p.evaluate(() => new URL(location.href).searchParams.get('ind')), 'ema', 'toggling an indicator updates the ?ind= URL');
          // fresh navigation with NO ?ind= param — the global setting (not just
          // the URL) must carry the selection through
          await p.goto(base + '/', { waitUntil: 'networkidle' });
          await p.waitForTimeout(300);
          assert.equal(await p.evaluate(() => document.querySelector('#indpanel input[data-ind="ema"]')?.checked), true, 'indicator selection persists via the global setting, not just the URL');
          // clean up: un-check it so later assertions in this test aren't affected
          await setInd('ema', false);
          await p.waitForTimeout(300);

          // NaN-age fix pin: humanAge on a non-finite input renders the
          // honest unknown marker, never the literal string "NaN" — and a
          // quoteStrip render with a NUMERIC fetchedAt (the real shape, since
          // #145) must not leak "NaN" into the DOM either.
          assert.equal(await p.evaluate(() => window.humanAge(NaN)), '—', 'humanAge(NaN) renders the unknown marker, not NaN text');
          const quoteHtml = await p.evaluate(() => {
            window.quoteStrip({ time: new Date().toISOString(), last: 71.2, fetchedAt: Date.now() - 5000 });
            return document.getElementById('quote').innerHTML;
          });
          assert.ok(!quoteHtml.includes('NaN'), 'quoteStrip with a numeric fetchedAt renders no NaN');

          // #170 review (item 8): pure page-embedded helpers pinned via
          // page.evaluate — they aren't module-exported, so a synthetic-input
          // assertion in the live page is the only reachable unit check.
          assert.deepEqual(
            await p.evaluate(() => window.gapBreakData([1000, 2000, 20000], [1, 2, 3], 1000)),
            [{ x: 1000, y: 1 }, { x: 2000, y: 2 }, { x: 20000, y: null }],
            'gapBreakData breaks the line at an EXISTING timestamp (no synthetic x added to the shared timeseries index)'
          );
          // roundAxisTicks now takes the actual candle timestamps (not a
          // continuous min/max range) and snaps every tick to one of them —
          // a synthetic H4 series with no gaps here.
          const h4Times = await p.evaluate(
            ({ start, end, step }) => { const out = []; for (let t = start; t <= end; t += step) out.push(t); return out; },
            { start: Date.UTC(2026, 0, 1, 3, 0), end: Date.UTC(2026, 0, 3, 3, 0), step: 4 * 3600 * 1000 }
          );
          const ticks = await p.evaluate((times) => window.roundAxisTicks(times, 240, 4 * 3600 * 1000), h4Times);
          assert.ok(Array.isArray(ticks) && ticks.length > 0, 'roundAxisTicks returns tick boundaries for an H4 window');
          assert.ok(ticks.every((v) => h4Times.includes(v)), 'every tick lands exactly on a real data timestamp, never a value the series lacks');

          // narrow-width tick-collision check: roundAxisTicks itself doesn't
          // know about pixel width (autoSkipPadding handles that at render
          // time) — pin that a dense H1/M1 window still yields a bounded,
          // non-per-candle tick count regardless of viewport.
          const m1Times = await p.evaluate(
            ({ start, end, step }) => { const out = []; for (let t = start; t <= end; t += step) out.push(t); return out; },
            { start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 0, 1) + 6 * 3600 * 1000, step: 60 * 1000 }
          );
          const denseTicks = await p.evaluate((times) => window.roundAxisTicks(times, 1, 60 * 1000), m1Times);
          assert.ok(denseTicks.length < 60, `roundAxisTicks (${denseTicks.length}) stays bounded for a dense M1 6h window, not one per candle`);

          // #185 regression: a quiet overnight market fragments an M5 series
          // into many small runs (each hole >3×granularity so it really does
          // split a run). The ACTUAL root cause was Chart.js's own autoSkip:
          // it anchors its thinning to `major` (date-boundary) ticks and fits
          // each inter-major segment off that segment's own pixel width —
          // once the first segment used up its budget, autoSkip dropped every
          // tick in every later segment outright instead of resampling the
          // whole axis, so labels rendered for only the first slice of a long
          // window then stopped dead (roundAxisTicks/contiguousRuns/dedupe
          // themselves were already fine — verified against this fixture).
          // Fix: autoSkip disabled, decimateTicksForWidth (index-uniform,
          // major-preserving) owns narrow-viewport thinning instead. Assert
          // both layers: roundAxisTicks spans the full window, and
          // decimateTicksForWidth at a narrow width doesn't reintroduce a void.
          const fragTimes = await p.evaluate((step) => {
            const out = [];
            let t = Date.UTC(2026, 0, 1, 20, 0);
            const end = Date.UTC(2026, 0, 2, 8, 0); // 12h overnight window
            while (t <= end) {
              // a short ~20min run of M5 candles...
              for (let k = 0; k < 4 && t <= end; k++, t += step) out.push(t);
              t += 20 * 60 * 1000; // ...then a ~20min hole (a real gap: >3×granMs)
            }
            return out;
          }, 5 * 60 * 1000);
          const fragTicks = await p.evaluate((times) => window.roundAxisTicks(times, 5, 5 * 60 * 1000), fragTimes);
          const fragMaxTick = Math.max(...fragTicks);
          const fragMinTick = Math.min(...fragTicks);
          assert.ok(fragTicks.length > 4, `fragmented-runs fixture yields more than a handful of ticks (got ${fragTicks.length})`);
          assert.ok(fragTimes[fragTimes.length - 1] - fragMaxTick < 60 * 60 * 1000, 'last tick lands within an hour of the fixture end (ticks do not die out partway across a fragmented window)');
          assert.ok(fragMinTick - fragTimes[0] < 60 * 60 * 1000, 'first tick lands within an hour of the fixture start');
          const fragStepMs = 30 * 60 * 1000; // TICK_STEP_TABLE: M5 -> 30-minute ticks
          const sortedFragTicks = [...fragTicks].sort((a, b) => a - b);
          let fragMaxVoid = 0;
          for (let i = 1; i < sortedFragTicks.length; i++) fragMaxVoid = Math.max(fragMaxVoid, sortedFragTicks[i] - sortedFragTicks[i - 1]);
          assert.ok(fragMaxVoid <= 2 * fragStepMs, `no >2x tick-step void in the fragmented-runs tick set (max gap ${fragMaxVoid}ms, limit ${2 * fragStepMs}ms)`);
          // narrow-width decimation (index-uniform, evenly thinning the FULL
          // set) must still reach both edges of the window — no longer a
          // "died after the first segment" truncation, whatever the stride.
          const fragDecimated = await p.evaluate((times) => window.decimateTicksForWidth(times, 390, 56), sortedFragTicks);
          assert.ok(fragDecimated.length <= sortedFragTicks.length, 'narrow-width decimation never adds ticks');
          assert.equal(fragDecimated[0], sortedFragTicks[0], 'decimation keeps the first tick');
          assert.equal(fragDecimated[fragDecimated.length - 1], sortedFragTicks[sortedFragTicks.length - 1], 'decimation keeps the last tick (reaches the end of the window, not truncated)');

          // Gapped-chart regression (#170 follow-up): a synthetic two-day M5
          // series with a multi-day gap in the middle must (a) never emit a
          // tick inside the gap (every tick sits on a real timestamp, so none
          // can land in the dead zone and crush together on the rank-based
          // timeseries scale), and (b) label the first tick of each calendar
          // day with a date, so the SAME wall-clock time on two different
          // days never renders as a bare, undated duplicate.
          const gapMs = 5 * 60 * 1000;
          const gapTimes = await p.evaluate((step) => {
            const out = [];
            const day1Start = Date.UTC(2026, 0, 1, 13, 25);
            for (let t = day1Start; t <= Date.UTC(2026, 0, 1, 20, 40); t += step) out.push(t);
            const day3Start = Date.UTC(2026, 0, 3, 15, 10); // >1 day later — a real weekend-style gap
            for (let t = day3Start; t <= Date.UTC(2026, 0, 3, 19, 35); t += step) out.push(t);
            return out;
          }, gapMs);
          const gapTicks = await p.evaluate(({ times, gm }) => window.roundAxisTicks(times, 5, gm), { times: gapTimes, gm: gapMs });
          // locate the REAL >3×granularity break by scanning deltas — a
          // midpoint guess can sit inside the first run and assert nothing
          let gapStart = null; let gapEnd = null;
          for (let i = 1; i < gapTimes.length; i++) {
            if (gapTimes[i] - gapTimes[i - 1] > 3 * gapMs) { gapStart = gapTimes[i - 1]; gapEnd = gapTimes[i]; break; }
          }
          assert.ok(gapStart !== null, 'fixture really contains a >3×granularity gap');
          assert.ok(gapTicks.every((v) => v <= gapStart || v >= gapEnd), 'no tick lands inside the gap between the two runs');
          const timeSet = new Set(gapTimes);
          assert.ok(gapTicks.every((v) => timeSet.has(v)), 'every tick is a real timestamp from the input series');
          // day-boundary labels must survive autoSkip (Chart.js prunes AFTER
          // tick generation but always keeps `major: true` ticks) — assert the
          // major flags mark exactly the first tick of each local day, not
          // neighbour adjacency.
          const majorTicks = await p.evaluate((vals) => window.markMajorTicks(vals), gapTicks);
          const localDay = (v) => { const d = new Date(v); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
          let lastDay = null;
          const expectedMajor = gapTicks.map((v) => { const day = localDay(v); const isNew = day !== lastDay; lastDay = day; return isNew; });
          assert.deepEqual(majorTicks.map((t) => t.major), expectedMajor, 'major flag marks exactly the first tick of each local calendar day');
          assert.ok(expectedMajor.filter(Boolean).length > 1, 'the tick set spans multiple local calendar days, so the day-change label logic has a boundary to mark');

          // #170 review (item 8, soc seam pin): this fixture's default
          // fetcher:null combo never has candles, so draw() never runs and
          // chart.$priceLines is unreachable here — tradeOverlay() itself
          // (the actual priceLines-painting logic) is a plain function and
          // reachable directly with synthetic input.
          assert.deepEqual(
            await p.evaluate(() => window.tradeOverlay(
              [{ state: 'open', side: 'long', entryTime: new Date(1000).toISOString(), entryPrice: 10, stop: 9, target: 12 }],
              [500, 1500], 500
            ).priceLines.map((pl) => pl.label)),
            ['entry 10', 'stop 9', 'target 12'],
            'tradeOverlay paints entry/stop/target priceLines for an open position inside the window'
          );

          // #165/#166: fleet rail — one row for the seeded bot combo, and navigating
          // to its hash focuses the chart on that combo (instSel value flips).
          await p.waitForFunction(() => document.querySelectorAll('#rail .railjump[data-combo]').length > 0, { timeout: 5000 });
          const railCombos = await p.evaluate(() => [...document.querySelectorAll('#rail .railjump[data-combo]')].map((b) => b.dataset.combo));
          assert.ok(railCombos.includes('WTICO/USD|M15'), 'rail shows a row for the seeded bot combo');
          // #171 3.6: the seeded WTICO/USD|M15 combo has 3/10 gate-bearing flip
          // decisions disagreeing with the gate — a gray (never amber) tuning
          // note renders on its rail row.
          // #171 review item 4: .railnote is a SIBLING of the .railjump button
          // inside .railrow, not nested inside it (nesting would pollute the
          // button's accessible name) — look it up via the row, not the button.
          const gateNoteRow = await p.evaluate(() => {
            const jump = [...document.querySelectorAll('#rail .railjump[data-combo="WTICO/USD|M15"]')][0];
            const row = jump ? jump.closest('.railrow') : null;
            return row ? row.querySelector('.railnote')?.textContent ?? null : null;
          });
          assert.equal(gateNoteRow, 'disagreed with gates 3 of last 10', 'rail note renders for a seeded ≥3-of-10 disagreement combo');
          const [chartReq] = await Promise.all([
            p.waitForResponse((r) => r.url().includes('/api/chart') && r.url().includes('granularity=M15')),
            p.evaluate(() => { location.hash = '#bot/' + encodeURIComponent('WTICO/USD|M15'); }),
          ]);
          assert.equal(chartReq.ok(), true, 'hash navigation triggers a chart fetch for the new combo');
          await p.waitForTimeout(300);
          assert.equal(await p.evaluate(() => document.getElementById('granSel').value), 'M15', '#bot/<combo> hash route changed the chart granularity');
          assert.equal(await p.evaluate(() => document.getElementById('instSel').value), 'WTICO/USD', '#bot/<combo> hash route changed the chart instrument');
          // #185 regression + operator 28/07: the desktop overlay is a slim
          // horizontal row along the chart TOP (not a corner box over candles),
          // whose right edge stops short of the y-axis price-label column
          // (measured up to ~51px across real instruments; fetcher:null here
          // means no live Chart.js scale to read, so the CSS offset is pinned).
          const indpanelRight = await p.evaluate(() => parseFloat(getComputedStyle(document.getElementById('indpanel')).right));
          assert.ok(indpanelRight >= 60, `indicator panel's right offset (${indpanelRight}px) clears the measured y-axis label width on ${vname}`);
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
