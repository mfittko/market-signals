# UI/UX redesign plan

Based on a full walkthrough of the live deployment (desktop 1440×900 + mobile 430×900, WebKit,
2026-07-27) and a code trace of `vendor/app.html`, `scripts/signal-server.mjs`,
`scripts/portfolio.mjs`, `scripts/evaluation.mjs`.

## 1. Diagnosis

The UI is confusing because it is organised around the wrong protagonist — the chart and the
portfolio — while the user's real object of interest is **each bot**: what is it doing, why, is it
working, how do I tune it. No surface owns "a bot", so bot/position state is smeared across ~12
surfaces that render it differently and, in verified cases, contradict each other.

**The headline complaint ("trades for open positions do not show") is schema-level:** `bot_trades`
is written only at close (`portfolio.mjs` `closeInDb`, ~:196–203), which also deletes the
`positions` row — the two never coexist. `openPosition` (~:176) writes only `positions` + a journal
`open` row. The trades tab iterates `pf.trades` only, so an open position's entry is invisible in
every trade list until it closes. The same closed-only assumption leaks into `/api/bots` per-bot
counts, the equity sparkline ("realized only"), and the performance scoreboard. Attribution of a
position to its bot exists only as JSON in `bot_journal.context.executed.opened` behind a
`LIMIT 5000` scan — fragile and eventually lossy.

## 2. Findings inventory

Every finding is mapped to a phase item in §7.

### Major — data truth & trust
| # | Finding |
|---|---|
| F1 | Open position's entry appears in no trade list; "trades" silently means closed-only; bot rows show "1 trades · −6.27" while the live trade is green; leaks into sparkline, /api/bots, scoreboard |
| F2 | The same open position is drawn 5 ways in 5 places (strip chip, overview card, bot-modal bullet, chart botState, topbar chips) — no canonical object or shared renderer |
| F3 | `verdict: suppress` shown beside `bot: open` for the same entry in one card/one voice; `.overruled` recolouring implies a veto relationship that doesn't exist (gates = mechanical filter, bot = LLM that may act anyway) |
| F4 | Header/day P&L and equity sparkline are client-side sums over a 50-trade truncated list — silently wrong after trade #51; server `cash` is the truth |
| F5 | `/api/bots` attribution path (journal join + orphan absorption + LIMIT 5000/200 scans) differs from `/api/portfolio`; totals disagree; old positions become permanently unattributable |
| F6 | Positions carry no granularity/strategy; chart botState matches by instrument only — cross-granularity bleed, second position invisible |
| F7 | Raw JS exception rendered as signal reason (`filter error: Cannot read properties of null…`); literal `?%` win rates; empty backfill reasons |
| F8 | No entry/stop/target markers on the chart for positions; closed trades unmarked |
| F9 | Bell click silently mutes all alerts, persists, no confirmation |
| F10 | Mobile: tables clipped mid-word with no scroll/wrap, chart hard-coded 320px, modals unusable, chat panel never appears |
| F11 | No "what is my system doing right now" surface: halted flag, feed freshness, LLM/news status, per-bot decision staleness rendered nowhere |
| F12 | No path from a bot to its own history; audit is one flat interleaved stream (`decisionAudit` has no combo filter); bot modal has zero history |

### Medium — consistency & comprehension
| # | Finding |
|---|---|
| F13 | Same entry, two timestamps (candle 07:55 vs execution 08:02) across three surfaces, unlabeled; three separate timestamp pipelines |
| F14 | Day P&L: browser-local bucketing of UTC close_time + all unrealized regardless of open date; "day" currently always equals total |
| F15 | Stale semantics: positions on never-running bots keep `stale=0` with old `last_mark`, still feed header equity |
| F16 | Trade deep-links use current view's granularity, not the trade's |
| F17 | Dead/duplicate surfaces: `/api/bot-trades` unreferenced; "details" button = portfolio button (opens audit tab, not the position); 3 restatements of equity, one unlabeled |
| F18 | Bot modal conflates per-combo and per-instrument scope in one flat form (alloc/leverage are instrument-shared); gates/memories live behind the settings gear, far from the bot |
| F19 | Dishonest statistics from n=1: `PF ∞`, `win rate 100%/0%`, `—%` placeholder, `max DD 0.1%` vs `0%`; open positions excluded without note |
| F20 | `/api/recheck` targets the latest signal, not the displayed one (race) |
| F21 | GET `/api/chart` mutates state (live upsert + backfill); concurrent viewers alter each other's history |
| F22 | "24h" stat varies with chart granularity (−8.39/−8.57/−7.71 % same minute) |
| F23 | "Signal history · current chart window" label wrong after load-more |
| F24 | No news/sentinel surface despite reasons citing news; claims unattributed; `sentinelSourceFootnotes` off by default |
| F25 | Position card/trade rows are dead ends — forensic chain (position→decision→signal→news) unlinked everywhere |
| F26 | Modal geometry jumps between tabs (re-centres mid-click) — moot once modals die, interim fix cheap |

### Minor / polish
| # | Finding |
|---|---|
| F27 | MACD checkbox does nothing (persists, never renders) |
| F28 | Bollinger bands balloon into ellipses across weekend gaps; BTC shows a bogus weekend gap; x-axis labels irregular/overlapping on mobile |
| F29 | Trades table lacks entry/exit price, units, leverage; `bot-close` code unexplained; raw floats (`999.770747139196`) ship to UI |
| F30 | Unlabeled emoji chrome (🔔🤖⚙💬💼, 4-state dot — also the biggest a11y gap: colour-only state); bot button greys out with no tooltip |
| F31 | Settings raw env-var jargon, no help text, unknown blast radius (`port`), `instrument` vs `instruments`; Memories weight/archive unexplained, undiscoverable |
| F32 | Chat blank empty state, silent no-op on empty Ask, mic gives zero feedback (missing-STT-key caveat unstated) |
| F33 | Recheck: >15s, text-only progress, cost unhinted; cryptic outcome columns ("to reversal … ×", colour logic) |
| F34 | Footer "updated" line has two phrasings; OHLC tooltip stray checkbox glyph; "1 trades" grammar; jargon ("virtual portfolio (bot-only — view)", "sized to … (risk cap, requested 13350)") |

## 3. The canonical position

> A **trade** is one position's whole life. `open` and `closed` are states of the same object, not
> two tables. The UI has no "positions" concept separate from "trades".

New read-only `GET /api/trades?instrument=&granularity=&limit=` returning one shape for both:
`{ id, state: "open"|"closed", instrument, granularity, combo, strategyName, side, notional,
units, leverage, margin, entryPrice, entryTime, mark, exitTime, stop, target, pnl, pnlPct,
stale, closeReason, openReason, ageMin }` — built by a new `tradeTimeline()` in `portfolio.mjs`
beside `portfolioView`, no migration. The duplicated journal-walk attribution
(`signal-server.mjs:925-931`, `evaluation.mjs:18`) is extracted into one exported
`positionAttribution(db)` consumed by `/api/bots`, `/api/trades`, `/api/chart` — three surfaces
that structurally cannot disagree (fixes F1, F2, F5, F6 display side). `/api/portfolio` stays;
`/api/bot-trades` (dead) is dropped. Later (Phase 3) an additive nullable `granularity` column on
`positions`/`bot_trades`, stamped at open/close and backfilled once from the journal, replaces the
scan for durability.

## 4. Gates vs bot — two lanes, never one voice

Every tape event renders two labelled lanes (`gates: ALERT|SUPPRESS` — the word "verdict" is
retired; `bot: OPENED|HELD|CLOSED + reason`) plus a computed relationship badge:
`⚑ acted against gates` / `⚑ declined an alert` (amber), `✓ agreed` (muted), `↩ exit` (neutral),
`— no bot on this view`. Signal colour always comes from buy/sell; `.overruled` recolouring is
deleted. A permanent one-liner under the tape header: *"Gates are a mechanical filter on the
signal. The bot reads them as context and may act anyway — disagreement is expected, not a bug."*
(Fixes F3.)

## 5. Information architecture

A fleet-rail workspace keeps the focused bot permanently in view, with hash-driven focus for deep
links/back button and a system-health row fed by a small `/api/health`.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ STATUS BAR  ● ACTIVE · equity 10,008.11 · today +8.11 · open 1 · +0.15     │
│             ● feed 2s · LLM ok · news auto        [ledger][settings][💬]   │
│  (halted → full-width ⛔ banner, role="alert", the only red at rest)       │
├──────────┬────────────────────────────────────────────────┬────────────────┤
│ FLEET    │ BOT WORKSPACE (focused bot, hash-addressed)    │ CHAT           │
│ RAIL     │  [tape] [trades] [tuning]                      │ (collapsible)  │
│ one row  │  chart + evidence                              │                │
│ per bot  │                                                │                │
└──────────┴────────────────────────────────────────────────┴────────────────┘
     LEDGER overlay (portfolio-wide: equity · all trades · scoreboard · audit)
```

- **Status bar** (C1): every number labelled; replaces `#pfMini`/`#pfChips`/`#pfHead`/bot-modal
  status — 5 restatements → 1 (F17). Health segment from `/api/health` (feed age per instrument,
  last LLM call, news poller, halted, per-bot decision age) — fixes F11; the alerts on/muted state
  becomes an explicit labelled toggle here (F9, F30).
- **Fleet rail** (C2, operator-corrected): one row per bot — glyph AND word (`● armed`,
  `⚠ no strategy — won't trade`, `○ off`), strategy name, live open P&L for **this combo only**,
  decision age humanized once (`last decision 25m ago`) — decision recency is informational, not a
  health warning, so there is no STALE badge. The only amber health warning is the feed itself
  falling behind (`⚠ feed 12m behind`, or one aggregate note when every combo is behind at once —
  a market-closed signal, not N independent feed problems). The `instSel`/`granSel` selects stay
  always visible (chart-without-a-bot charting is just "pick a combo with no bot configured", no
  separate ad-hoc mode/button); a `☰` toggle collapses/expands the rail sidebar itself.
- **Workspace › Tape** (C3, default): chart (with **position entry/stop/target lines and
  trade/signal markers** — F8; indicator toggles in a chart-corner popover, RSI/MACD opt-in — F27,
  F30) above a combo-scoped two-lane event tape (§4). The signal-history table is deleted *as a
  table*; outcome stats move into `[why? ▸]` with renamed plain-language labels (F33). Re-check
  attaches to the newest entry, takes an explicit signal id (F20), shows progress + cost hint.
- **Workspace › Trades** (C4): the canonical rows for this combo, **open first** — the only place
  a position is drawn as a row (headline fix, F1/F2). Open rows show entry/mark/stop/target/age/
  reason; closed rows entry/exit/prices/P&L/exit badge; expandable to signal + news links (F25,
  F29). Header: `since first trade: 1 closed −6.27 · 1 open +0.15` with honesty note `⚠ n<5`.
- **Workspace › Tuning** (C5): scope-explicit fieldsets — `this bot` / `INSTRUMENT — shared by
  every granularity` (with blast-radius note `ⓘ also applies to XAG/USD·H1`) / `global` — merging
  bot-modal setup + strategy, settings→gates, settings→memories (F18, F12 config side). Existing
  write endpoints only; no new write routes.
- **Ledger overlay** (C6): equity curve, all-bot trades, scoreboard grouped by strategy (open rows
  counted separately, excluded from win rate), global audit. Statistical honesty: `PF ∞` → `—`;
  win rate as a record `2W-1L` below n=20; `⚠ n<5 — descriptive only` (F19). Marking the curve at
  opens AND closes (killing the "realized only" caveat) is **deferred to #170** — the shipped
  sparkline still plots realized equity after each closed trade only.
- **Settings modal survives** with 3 tabs (LLM / news / advanced) + per-field one-line help text,
  placeholders, danger flags on `port` etc. (F31). Chat stays as the slide-over, gains an
  empty-state hint, empty-Ask feedback, and mic feedback incl. missing-STT-key message (F32).

**Component rules:** red/green reserved for money/direction — status uses green/amber/gray + red
banner; exit badges `target`/`stop`/`bot-close`/`manual` with a legend; money 2dp signed, prices
at instrument precision, no raw floats, leverage `10×`; **one timestamp pipeline** — server ships
trader-local + ISO, client stops reformatting, candle vs execution time explicitly labelled where
both appear (F13); every "why" truncation expands in place, every named object is a link, no
dead-end rows (F25).

**Responsive:** >1100px three columns; 900–1100 chat collapses; <900px rail becomes a horizontal
chip strip, chart `clamp(260px, 45vh, 460px)`, tables collapse to 4 key columns + expandable rows
— never horizontal-scroll a reason column (F10).

**A11y:** real `role="tablist"`/arrow keys; rail `role="list"` + `aria-current`; colour never the
only channel (sign + ▲/▼ on every P&L, words on every state); halt `role="alert"`; ticking values
`aria-live="off"`; keep existing focus ring, 26px targets, reduced-motion block.

## 6. Explicitly not proposed
No framework, no build step, no new deps, no charting-library swap, no new write routes, no
theming, no real-time push. Rail/tape/trade-row are three `innerHTML` render functions in the
existing style.

## 7. Phased delivery

Correctness first, no view moves; then the IA move; then chart layer & durability. Each phase =
PR-sized issues through the normal dev-loop; UI-review gate per §8.

### Phase 1 — correctness of what's shown (no view moves)
| # | Change | Fixes |
|---|---|---|
| 1.1 | `GET /api/trades` unified timeline + shared `positionAttribution(db)` (§3); `/api/bots` and scoreboard consume it | F1, F2, F5, F6 |
| 1.2 | Two-lane tape entry + relationship badge; drop `.overruled`; retire "verdict" | F3 |
| 1.3 | One labelled status bar; delete `#pfMini`/`#pfChips`/`#pf` strip; server-computed `realizedTotal` + `dayPnl` (trader-local day incl. unrealized delta) replace client sums | F4, F14, F17 |
| 1.4 | Combo filter on `decisionAudit` + `/api/evaluation`; drop lastDecision row caps | F12, F5 |
| 1.5 | Stats honesty: `∞`→`—`, records below n=20, `n<5` notes, open-excluded note | F19 |
| 1.6 | Fix null-`match` filter crash; honest placeholders for `?%`/backfill/error reasons | F7 |
| 1.7 | One timestamp pipeline; candle vs execution labelled | F13 |
| 1.8 | Stale marking by `last_mark` age regardless of quotes-map membership | F15 |
| 1.9 | `/api/recheck` takes explicit signal id; move chart-history mutation out of GET (background acquisition from #145) | F20, F21 |
| 1.10 | Small `/api/health`; granularity-independent 24h stat | F11 (data), F22 |
| 1.11 | `min-height` on dialogs (interim, until modals die) | F26 |

### Phase 2 — the IA move
| # | Change | Fixes |
|---|---|---|
| 2.1 | Fleet rail replaces `instSel`/`granSel`/`botBtn`/`#botList`; hash-driven focus | F12, F11, F30 |
| 2.2 | Workspace tabs; bot modal → Tuning; portfolio modal → Ledger overlay | F2, F18, F17 |
| 2.3 | Trades tab renders canonical rows; delete the other four position renderings | F1, F2, F25, F29 |
| 2.4 | Scope fieldsets + blast-radius notes; gates/memories move Settings → Tuning | F18 |
| 2.5 | Status-bar health row + labelled alerts toggle with confirmation | F9, F11, F30 |
| 2.6 | Mobile: chip-strip rail, `clamp()` chart, collapsing tables, working chat panel | F10 |
| 2.7 | `role="tablist"` + arrow keys + word-not-colour states | a11y |
| 2.8 | Signal-history table → tape with `[why? ▸]`; correct window label; granularity-true deep links | F16, F23, F33 |

### Phase 3 — chart layer & durability
| # | Change | Fixes |
|---|---|---|
| 3.1 | Additive migration: nullable `granularity` on `positions`+`bot_trades`, stamped at open/close, one-time journal backfill (`NULL` = "unattributed") | F5, F6 durable — delivered (PR #180) |
| 3.2 | Entry/stop/target lines + trade/signal markers on the chart | F8 — delivered (PR #182) |
| 3.3 | Bollinger gap-ellipse fix; x-axis regularity + mobile overlap; BTC weekend-gap explanation or 24/7 fetch | F28 — delivered (PR #182) |
| 3.4 | Indicator popover; fix or remove MACD; equity curve marked at opens | F27, F19 — delivered (PR #182) |
| 3.5 | News surface: headlines/sources on `[why? ▸]` expansion; sentinel footnotes default on | F24 — delivered (PR #183) |
| 3.6 | Per-bot "disagreed with gates 8 of last 10" rail note | tuning signal — delivered (PR #183) |
| 3.7 | Retire `/api/bot-trades`; copy pass (jargon, grammar, footer phrasing, tooltip glyph, number formatting) | F17, F34 — delivered (PR #184) |
| 3.8 | Settings help text/placeholders/danger flags; Memories explanations; chat/mic feedback; recheck progress | F31, F32, F33 — delivered (PR #184) |

## 8. Verification (per phase, all three)
1. `npm test` — extend `test/portfolio.test.mjs` (tradeTimeline open+closed union),
   `test/signal-server.test.mjs` (`/api/trades` shape, combo filters, health), `test/evaluation.test.mjs`.
2. `npm run test:e2e` — extend `test/e2e/walkthrough.e2e.mjs` for new surfaces.
3. Running-app UI review (standing rule): boot on :4123, drive WebKit manually, screenshot
   1440×900 + 430×900, read PNGs back. Must-check states: open position as a trades row; two-lane
   disagreement entry; halted banner; bot with no strategy; two bots on one instrument at
   different granularities; mobile pass. Restart the KeepAlive server after any script sync to main.
