// Move-triggered NewsAPI.ai confirmation window (#106 phase-1 MVP).
//
// A per-instrument state machine, SQLite-authoritative (timers in the KeepAlive
// process are disposable/restart-safe). When an *extraordinary* directional move
// with abnormal volume opens a window, we spend a BOUNDED amount of NewsAPI.ai
// budget answering "is this move linked to a credible catalyst, still developing?"
//
// EVERYTHING here is advisory: no evidence creates a trade, changes Supertrend,
// or sets direction — direction comes exclusively from price. This module owns the
// window lifecycle + the confirmation burst; the move TRIGGER and the polling LOOP
// are injected seams (PR-B wires the real trigger off #145's observation feed and
// hosts the loop in signal-server). Reuses #104's adapter, budget, circuit, and
// observations table — it never adds a second market-data poller or provider.
import { withDb } from './supertrend.mjs';
import { NEWSAPI_AI_PROVIDER, providerRequestsUsed, providerCircuitOpen, recordProviderCall, recordProviderObservations } from './news.mjs';
import { fetchNewsApiAiArticles } from '../skills/market-sentinel/scripts/sentinel_news.mjs';

export const CORRELATION_STATES = ['watching_news', 'confirmed', 'expired', 'mean_reverted', 'budget_blocked', 'cancelled'];

const CORRELATION_DDL = `CREATE TABLE IF NOT EXISTS correlation_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument TEXT NOT NULL,
  direction TEXT NOT NULL,
  state TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  closed_at TEXT,
  trigger_range_atr REAL, trigger_vol_ratio REAL, trigger_price REAL,
  poll_count INTEGER NOT NULL DEFAULT 0,
  last_poll_at TEXT,
  evidence_json TEXT,
  stop_reason TEXT)`;
// at most ONE active (watching_news) window per instrument — enforced in SQLite,
// so a concurrent opener can't race in a second overlapping window
const CORRELATION_IDX = `CREATE UNIQUE INDEX IF NOT EXISTS correlation_active_one
  ON correlation_windows(instrument) WHERE state='watching_news'`;

function corrDb(dbPath, fn) {
  return withDb(dbPath, (db) => { db.exec(CORRELATION_DDL); db.exec(CORRELATION_IDX); return fn(db); });
}

// Conservative defaults (per the budget-sensitivity call): windows stay rare and
// bounded. Opt-in is explicit (`enabled`); everything is tunable per instrument.
export const CORRELATION_DEFAULTS = {
  enabled: false,
  moveAtr: 1.5,          // directional displacement ≥ this × ATR (with volume)
  extremeMoveAtr: 2.5,   // price-only fallback when volume is unavailable
  relativeVolume: 2.0,   // last-bar volume ≥ this × recent average
  windowMinutes: 15,
  meanRevertAtr: 0.5,    // move falls back below this × ATR ⇒ mean_reverted
  maxRequestsPerWindow: 15,
  maxWindowsPerDay: 8,   // rolling 24h, per instrument
};
export function correlationConfig(instrument, settings = {}) {
  const c = settings.correlation || {};
  const per = (c.instruments && c.instruments[instrument]) || {};
  return { ...CORRELATION_DEFAULTS, ...c.defaults, ...per };
}

// Pure trigger predicate. Direction is the caller's (price-derived) sign; here we
// only decide whether the magnitude qualifies. volumeRatio null ⇒ volume
// unavailable, so require the stronger price-only threshold rather than
// fabricating volume confirmation.
export function qualifiesAsMove({ rangeAtr, volumeRatio }, cfg = CORRELATION_DEFAULTS) {
  if (!cfg.enabled) return { trigger: false, reason: 'disabled' };
  if (!Number.isFinite(rangeAtr)) return { trigger: false, reason: 'no-atr' };
  if (Number.isFinite(volumeRatio)) {
    if (rangeAtr >= cfg.moveAtr && volumeRatio >= cfg.relativeVolume) return { trigger: true, reason: 'move+volume' };
    return { trigger: false, reason: 'below-threshold' };
  }
  // volume unavailable → price-only, stricter
  if (rangeAtr >= cfg.extremeMoveAtr) return { trigger: true, reason: 'price-only-extreme' };
  return { trigger: false, reason: 'below-price-only-threshold' };
}

export function getActiveWindow(dbPath, instrument) {
  return corrDb(dbPath, (db) => db.prepare(
    "SELECT * FROM correlation_windows WHERE instrument=? AND state='watching_news'").get(instrument) ?? null);
}

// Open a window, or STRENGTHEN the existing active one (a fresh qualifying move
// never starts an overlapping window). Returns { id, state, action }.
export function openOrExtendWindow(dbPath, { instrument, direction, trigger = {}, cfg = CORRELATION_DEFAULTS, now = Date.now() }) {
  return corrDb(dbPath, (db) => {
    const active = db.prepare("SELECT * FROM correlation_windows WHERE instrument=? AND state='watching_news'").get(instrument);
    if (active) {
      // strengthen: keep the earlier deadline, record the stronger displacement
      if (Number.isFinite(trigger.rangeAtr) && trigger.rangeAtr > (active.trigger_range_atr ?? -Infinity)) {
        // COALESCE so a stronger move that omits volume/price keeps the recorded context
        db.prepare('UPDATE correlation_windows SET trigger_range_atr=?, trigger_vol_ratio=COALESCE(?, trigger_vol_ratio), trigger_price=COALESCE(?, trigger_price) WHERE id=?')
          .run(trigger.rangeAtr, trigger.volumeRatio ?? null, trigger.price ?? null, active.id);
      }
      return { id: active.id, state: 'watching_news', action: 'strengthened' };
    }
    // rolling-24h per-instrument window cap
    const since = new Date(now - 24 * 3600000).toISOString();
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM correlation_windows WHERE instrument=? AND opened_at>=?').get(instrument, since);
    if (n >= cfg.maxWindowsPerDay) return { id: null, state: null, action: 'day_cap_reached' };
    const at = new Date(now).toISOString();
    const deadline = new Date(now + cfg.windowMinutes * 60000).toISOString();
    try {
      const info = db.prepare(`INSERT INTO correlation_windows
        (instrument, direction, state, opened_at, deadline_at, trigger_range_atr, trigger_vol_ratio, trigger_price)
        VALUES (?,?,'watching_news',?,?,?,?,?)`)
        .run(instrument, direction, at, deadline, trigger.rangeAtr ?? null, trigger.volumeRatio ?? null, trigger.price ?? null);
      return { id: Number(info.lastInsertRowid), state: 'watching_news', action: 'opened' };
    } catch (e) {
      // lost the race to a concurrent opener (partial-unique index) — return the
      // window that won rather than throwing out of the polling loop
      const won = db.prepare("SELECT id FROM correlation_windows WHERE instrument=? AND state='watching_news'").get(instrument);
      if (won) return { id: won.id, state: 'watching_news', action: 'strengthened' };
      throw e;
    }
  });
}

function close(db, id, state, stopReason, now, evidence) {
  db.prepare('UPDATE correlation_windows SET state=?, stop_reason=?, closed_at=?, evidence_json=COALESCE(?, evidence_json) WHERE id=?')
    .run(state, stopReason, new Date(now).toISOString(), evidence ? JSON.stringify(evidence) : null, id);
  return { state, stopReason };
}

// Operator cancel — closes any active window for the instrument.
export function cancelWindow(dbPath, instrument, { now = Date.now() } = {}) {
  return corrDb(dbPath, (db) => {
    const active = db.prepare("SELECT id FROM correlation_windows WHERE instrument=? AND state='watching_news'").get(instrument);
    if (!active) return { state: null, stopReason: 'no-active-window' };
    return close(db, active.id, 'cancelled', 'operator_cancelled', now, null);
  });
}

// Precision-first default classifier: a credible confirmation needs escalation/
// incident language (not routine commentary) AND a FINITE publication time inside
// the window (undated items are never credible — no confirming on missing/garbled
// dates). The lower bound is the SAME lookback pollWindow fetches with
// (`lookbackMs`), so the accepted range never rejects an article the poll actually
// retrieved. Injectable so thresholds can be tuned/replaced without touching state.
export function defaultClassify(item, { openedAtMs, now, lookbackMs = 15 * 60000 }) {
  const t = item.timeIso ? Date.parse(item.timeIso) : NaN;
  const inWindow = Number.isFinite(t) && t >= openedAtMs - lookbackMs && t <= now + 60000;
  const incident = Boolean(item.escalation);
  return { credible: inWindow && incident, reasons: { inWindow, incident } };
}

// One confirmation-burst step for the active window. Runs stop-condition checks
// that need no call first (deadline / budget / circuit / per-window cap / mean
// reversion), then a single query-filtered getArticles: a ~windowMinutes lookback
// on the first poll (the report may predate the threshold crossing), a short
// lookback + dedup (via news_provider_observations) afterwards. Novel + credible
// evidence ⇒ confirmed. Every call is budget-charged and circuit-aware.
//
// Injected seams: `fetcher` (HTTP), `now` (clock), `classify`, `currentRangeAtr`
// (the live move magnitude for mean-revert; from #145's observer in PR-B).
export async function pollWindow(dbPath, {
  instrument, query, apiKey, cfg = CORRELATION_DEFAULTS, now = Date.now(),
  fetcher, classify = defaultClassify, currentRangeAtr = null, budgetTotal = 1800,
  shortLookbackMin = 3,
} = {}) {
  const active = getActiveWindow(dbPath, instrument);
  if (!active) return { action: 'no-active-window' };
  const openedAtMs = Date.parse(active.opened_at);

  // --- callless stop conditions ---
  if (now >= Date.parse(active.deadline_at)) {
    return corrDb(dbPath, (db) => ({ action: 'stopped', ...close(db, active.id, 'expired', 'expired/unexplained', now, null) }));
  }
  if (Number.isFinite(currentRangeAtr) && currentRangeAtr < cfg.meanRevertAtr) {
    return corrDb(dbPath, (db) => ({ action: 'stopped', ...close(db, active.id, 'mean_reverted', 'mean_reverted', now, null) }));
  }
  if (active.poll_count >= cfg.maxRequestsPerWindow) {
    return corrDb(dbPath, (db) => ({ action: 'stopped', ...close(db, active.id, 'expired', 'window_request_cap', now, null) }));
  }
  if (providerRequestsUsed(dbPath) >= budgetTotal) {
    return corrDb(dbPath, (db) => ({ action: 'stopped', ...close(db, active.id, 'budget_blocked', 'global_budget_exhausted', now, null) }));
  }
  if (providerCircuitOpen(dbPath, NEWSAPI_AI_PROVIDER, instrument, now)) {
    return corrDb(dbPath, (db) => ({ action: 'stopped', ...close(db, active.id, 'budget_blocked', 'circuit_open', now, null) }));
  }
  if (!apiKey || !query) return { action: 'no-provider' }; // nothing to call; leave the window open

  // --- one chargeable getArticles ---
  const hours = active.poll_count === 0 ? Math.max(cfg.windowMinutes, 15) / 60 : shortLookbackMin / 60;
  let fetched;
  try {
    fetched = await fetchNewsApiAiArticles({ query, hours, maxItems: 50, apiKey, fetcher, now });
    recordProviderCall(dbPath, NEWSAPI_AI_PROVIDER, instrument, { ok: true, now });
  } catch (e) {
    recordProviderCall(dbPath, NEWSAPI_AI_PROVIDER, instrument, { ok: false, status: e?.status, now });
    return corrDb(dbPath, (db) => {
      db.prepare('UPDATE correlation_windows SET poll_count=poll_count+1, last_poll_at=? WHERE id=?').run(new Date(now).toISOString(), active.id);
      return { action: 'poll-error', error: String(e?.message ?? e) };
    });
  }

  // novelty: only items THIS instrument hasn't seen count as fresh evidence. Query
  // just the fetched batch's ids (not the whole append-only history) so a large
  // observations table doesn't slow each poll.
  const items = fetched.items || [];
  const fetchedIds = items.map((it) => it.providerItemId).filter(Boolean);
  const seen = new Set(fetchedIds.length ? corrDb(dbPath, (db) =>
    db.prepare(`SELECT provider_item_id FROM news_provider_observations
      WHERE instrument=? AND provider=? AND provider_item_id IN (${fetchedIds.map(() => '?').join(',')})`)
      .all(instrument, NEWSAPI_AI_PROVIDER, ...fetchedIds).map((r) => r.provider_item_id)) : []);
  recordProviderObservations(dbPath, instrument, items, now);
  const fresh = items.filter((it) => it.providerItemId && !seen.has(it.providerItemId));
  const lookbackMs = Math.max(cfg.windowMinutes, 15) * 60000; // same span pollWindow's first fetch uses
  const credible = fresh.map((it) => ({ it, verdict: classify(it, { openedAtMs, now, direction: active.direction, lookbackMs }) }))
    .filter((x) => x.verdict.credible)
    .map((x) => ({ title: x.it.title, url: x.it.url, source: x.it.source, timeIso: x.it.timeIso, providerItemId: x.it.providerItemId }));

  return corrDb(dbPath, (db) => {
    db.prepare('UPDATE correlation_windows SET poll_count=poll_count+1, last_poll_at=? WHERE id=?').run(new Date(now).toISOString(), active.id);
    if (credible.length) {
      const prior = active.evidence_json ? JSON.parse(active.evidence_json) : [];
      return { action: 'confirmed', evidence: credible, ...close(db, active.id, 'confirmed', 'catalyst_confirmed', now, [...prior, ...credible]) };
    }
    return { action: 'polled', freshCount: fresh.length, pollCount: active.poll_count + 1 };
  });
}
