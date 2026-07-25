#!/usr/bin/env node
/**
 * Local signal web app (issue #18): chart deep-link target for alert
 * notifications + watcher/filter configuration over data/settings.json.
 *
 * Stdlib only. Binds 127.0.0.1. Reads the candles/signals tables that
 * scripts/supertrend.mjs accumulates; supertrend series is computed
 * server-side with the same exported function the alerts use.
 *
 * Usage:
 *   node scripts/signal-server.mjs [--port 8787] [--db data/candles.db] [--settings data/settings.json]
 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, computeSupertrend, detectFlips, effectiveModel, fetchCandles, granularityMs, llmChat, localTimeFormatters, readSettings, recheckSignal, recordSignal, resolveFilterSystem, resolveProvider, resolveRecheckSystem, signalOutcomes, storeCandles, withDb } from './supertrend.mjs';
import { botConfig, botTrades, instrumentLeverage, portfolioView } from './portfolio.mjs';
import { resolveNewsApiAiSource, isSettingOn } from './lib/newsapi-ai-source.mjs';
import { activateStrategy, activeStrategy, ensureSeedStrategy, listStrategies, saveStrategy, strategyById } from './strategies.mjs';
import { archiveMemory, editMemory, listMemories, memoriesContext, reweightMemory, saveMemory } from './memories.mjs';
import { GATES, activateGatePrompt, deactivateGatePrompt, listGatePrompts, saveGatePrompt } from './gate-prompts.mjs';
import { latestRecheck } from './signal-rechecks.mjs';
import { normCombo, performHaltReset, resolveBotFor, resolvedStrategy } from './bot.mjs';
import { baselines, botPerformanceSummary, decisionAudit, earliestAttributedEntry, strategyScoreboard, transportScoreboard } from './evaluation.mjs';
import { axisSnapshot, axisExpectancy } from './axis-snapshot.mjs';
import { ema, rsi, macd, bollinger, vwap } from './indicators.mjs';
export { resolveProvider };

const USAGE = `signal-server — local chart + watcher config UI over the alert db.

Options:
  --port <n>          listen port on 127.0.0.1 (default: 8787, or settings.port)
  --db <path>         sqlite db (default: data/candles.db)
  --settings <path>   settings file the config page edits (default: data/settings.json)
  -h, --help
`;

const DEFAULT_INSTRUMENT = 'WTICO/USD';
// Fallback instrument set: the repo's validated candle symbols.
let DEFAULT_INSTRUMENTS = [DEFAULT_INSTRUMENT];
try {
  const cat = JSON.parse(readFileSync('config/candle-symbols.json', 'utf8'));
  DEFAULT_INSTRUMENTS = Object.values(cat.markets).flat().map((m) => m.symbol);
} catch { /* no catalog in cwd: single-instrument fallback */ }

// Keys the config page may read/write; API keys are write-only (masked on read).
const SETTINGS_KEYS = ['provider', 'model', 'models', 'notesFile', 'piBin', 'notifierBin', 'port', 'instrument', 'instruments', 'granularity', 'watchers', 'freshBars', 'maxCompletionTokens', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'bot', 'snapshotContext', 'ind', 'info', 'NEWSAPI_AI_KEY', 'NEWSAPI_AI_MODE', 'NEWSAPI_AI_INSTRUMENTS', 'NEWSAPI_AI_REQUEST_BUDGET', 'NEWSAPI_AI_BACKGROUND', 'sentinelSourceFootnotes'];
// #99: per-provider model binding lives in the `models` map, keyed by provider
// (never 'none'). The flat `model` stays as the active provider's fallback.
const MODEL_PROVIDER_KEYS = PROVIDERS.filter((p) => p !== 'none');
const BOT_SETTING_KEYS = ['enabled', 'riskPct', 'maxPositions', 'reviewTriggerPct', 'killSwitchDrawdownPct', 'resetHalt', 'watchers', 'leverage', 'bots'];
const PER_BOT_KEYS = ['enabled', 'strategyId', 'strategyName', 'riskPct', 'killSwitchDrawdownPct', 'allocationPct'];
const SECRET_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NEWSAPI_AI_KEY'];
const MASK = '•••';

export function maskedSettings(settingsPath) {
  const s = readSettings(settingsPath);
  const activeProvider = resolveProvider(s); // migrates pre-#99 openai+base-url ⇒ openai-compatible
  const out = { activeProvider };
  for (const k of SETTINGS_KEYS) {
    if (s[k] === undefined) continue;
    out[k] = SECRET_KEYS.includes(k) ? MASK : s[k];
  }
  // #99 read-time seed: expose a models map so the contextual provider panel can
  // show each provider's bound model. Seed the active provider's slot from the
  // flat `model` ONLY for a pristine legacy config (no models map yet) — once a
  // models map exists (first save persists it + retires the flat key, see
  // writeSettings), respect it verbatim so clearing a binding actually sticks.
  // allow-listed provider keys only (ignore array/junk/__proto__ shapes), same
  // guard as writeSettings — never leak unexpected settings.json keys to the UI.
  const models = {};
  const stored = out.models && typeof out.models === 'object' && !Array.isArray(out.models) ? out.models : {};
  for (const mp of MODEL_PROVIDER_KEYS) if (stored[mp] != null) models[mp] = stored[mp];
  if (s.models === undefined && activeProvider !== 'none' && s.model) models[activeProvider] = s.model;
  out.models = models;
  return out;
}

// Merge-write: unknown keys rejected, masked secrets keep their stored value,
// atomic tmp+rename so a crash can't corrupt the file the LaunchAgent reads.
export function writeSettings(settingsPath, patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new Error('settings must be a JSON object');
  const unknown = Object.keys(patch).filter((k) => !SETTINGS_KEYS.includes(k));
  if (unknown.length) throw new Error(`unknown settings key(s): ${unknown.join(', ')}`);
  if (patch.port !== undefined && patch.port !== '' && patch.port !== null && (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535)) {
    throw new Error('port must be an integer 1-65535');
  }
  if (patch.freshBars !== undefined && patch.freshBars !== '' && patch.freshBars !== null && (!Number.isInteger(patch.freshBars) || patch.freshBars < 0)) {
    throw new Error('freshBars must be a non-negative integer');
  }
  // #98: openai-compatible reasoning-model completion budget (floor default
  // lives in supertrend.mjs's OPENAI_REASONING_FLOOR); operator-tunable here.
  if (patch.maxCompletionTokens !== undefined && patch.maxCompletionTokens !== '' && patch.maxCompletionTokens !== null && (!Number.isInteger(patch.maxCompletionTokens) || patch.maxCompletionTokens <= 0)) {
    throw new Error('maxCompletionTokens must be a positive integer');
  }
  if (patch.bot !== undefined && patch.bot !== '' && patch.bot !== null) {
    if (typeof patch.bot !== 'object' || Array.isArray(patch.bot)) throw new Error('bot must be an object');
    const unknownBot = Object.keys(patch.bot).filter((k) => !BOT_SETTING_KEYS.includes(k));
    if (unknownBot.length) throw new Error(`unknown bot key(s): ${unknownBot.join(', ')}`);
    if (patch.bot.leverage !== undefined && patch.bot.leverage !== null) {
      if (typeof patch.bot.leverage !== 'object' || Array.isArray(patch.bot.leverage)) throw new Error('bot.leverage must be an object keyed by instrument');
      for (const [li, lv] of Object.entries(patch.bot.leverage)) {
        if (['__proto__', 'constructor', 'prototype'].includes(li) || !/^[A-Za-z0-9/]{3,20}$/.test(li)) throw new Error(`bot.leverage key '${li}' must be an instrument symbol (same rule as resolveView)`);
        if (lv !== null && (!Number.isFinite(lv) || lv <= 0)) throw new Error(`bot.leverage['${li}'] must be a positive number`);
      }
    }
    if (patch.bot.bots !== undefined && patch.bot.bots !== null) {
      if (typeof patch.bot.bots !== 'object' || Array.isArray(patch.bot.bots)) throw new Error('bot.bots must be an object keyed by "INSTRUMENT|GRANULARITY"');
      for (const [combo, entry] of Object.entries(patch.bot.bots)) {
        if (!/^[A-Za-z0-9/ ]{3,20}\|\s*[MH]\d{1,2}$/.test(combo)) throw new Error(`bot.bots key '${combo}' must be "INSTRUMENT|GRANULARITY"`);
        if (entry === null) continue; // null deletes the bot entry on merge
        if (typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`bot.bots['${combo}'] must be an object`);
        const unknown2 = Object.keys(entry).filter((k) => !PER_BOT_KEYS.includes(k));
        if (unknown2.length) throw new Error(`bot.bots['${combo}']: unknown key(s) ${unknown2.join(', ')}`);
        if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error(`bot.bots['${combo}'].enabled must be boolean`);
        if (entry.strategyId !== undefined && entry.strategyId !== null && !Number.isInteger(entry.strategyId)) throw new Error(`bot.bots['${combo}'].strategyId must be an integer id`);
        // #75: strategyName is the preferred bot→strategy binding — the bot
        // follows whatever version of this name is active, not a frozen row.
        if (entry.strategyName !== undefined && entry.strategyName !== null && (typeof entry.strategyName !== 'string' || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(entry.strategyName))) throw new Error(`bot.bots['${combo}'].strategyName must be a kebab-case strategy name`);
        if (entry.allocationPct !== undefined && entry.allocationPct !== null && (!Number.isFinite(entry.allocationPct) || entry.allocationPct <= 0 || entry.allocationPct > 100)) throw new Error(`bot.bots['${combo}'].allocationPct must be in (0,100]`);
        for (const nk of ['riskPct', 'killSwitchDrawdownPct']) {
          if (entry[nk] !== undefined && entry[nk] !== null && (!Number.isFinite(entry[nk]) || entry[nk] <= 0)) throw new Error(`bot.bots['${combo}'].${nk} must be a positive number`);
        }
      }
    }
  }
  if (patch.ind !== undefined && patch.ind !== '' && patch.ind !== null && !/^[a-z,]{1,40}$/.test(patch.ind)) {
    throw new Error('ind must be a csv of indicator keys');
  }
  if (patch.info !== undefined && patch.info !== null && patch.info !== '' && typeof patch.info !== 'boolean') {
    throw new Error('info must be a boolean');
  }
  if (patch.provider !== undefined && patch.provider !== '' && patch.provider !== null && !PROVIDERS.includes(patch.provider)) {
    throw new Error(`provider must be one of ${PROVIDERS.join(', ')}`);
  }
  if (patch.models !== undefined && patch.models !== '' && patch.models !== null) {
    if (typeof patch.models !== 'object' || Array.isArray(patch.models)) throw new Error('models must be an object keyed by provider');
    for (const [mp, mv] of Object.entries(patch.models)) {
      if (!MODEL_PROVIDER_KEYS.includes(mp)) throw new Error(`models key '${mp}' must be a provider (${MODEL_PROVIDER_KEYS.join(', ')})`);
      if (mv !== null && typeof mv !== 'string') throw new Error(`models['${mp}'] must be a model-id string or null`);
    }
  }
  if (patch.OPENAI_BASE_URL !== undefined && patch.OPENAI_BASE_URL !== '' && patch.OPENAI_BASE_URL !== null) {
    let u;
    try { u = new URL(patch.OPENAI_BASE_URL); } catch { throw new Error('OPENAI_BASE_URL must be a valid URL'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('OPENAI_BASE_URL must be http(s)');
    if (u.search || u.hash) throw new Error('OPENAI_BASE_URL must not carry a query string or fragment');
    if (u.username || u.password) throw new Error('OPENAI_BASE_URL must not embed credentials (it is stored and displayed unmasked)');
  }
  const current = readSettings(settingsPath);
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (SECRET_KEYS.includes(k) && v === MASK) continue; // masked = unchanged
    if (v === '' || v === null) delete next[k];
    else if (k === 'bot') {
      // deep-merge: a partial bot patch must not drop stored keys the UI form
      // doesn't carry; bot.bots merges PER COMBO (null deletes one bot entry)
      const merged = { ...(typeof current.bot === 'object' && current.bot ? current.bot : {}) };
      for (const [bk, bv] of Object.entries(v)) {
        if (bv === '' || bv === null) delete merged[bk];
        else if (bk === 'leverage') {
          // per-instrument merge (null deletes one override); own-keys only —
          // __proto__/constructor and friends can never pollute the shape
          const lev = { ...(typeof merged.leverage === 'object' && merged.leverage ? merged.leverage : {}) };
          for (const [li, lv] of Object.entries(bv)) {
            if (['__proto__', 'constructor', 'prototype'].includes(li)) continue;
            if (lv === null) delete lev[li]; else lev[li] = lv;
          }
          merged.leverage = lev;
        } else if (bk === 'bots') {
          // combo keys are normalized at write time (spaces around the pipe
          // stripped) so "A | M5" and "A|M5" can never coexist as duplicates
          const normKey = normCombo;
          const bots = {};
          for (const [combo, entry] of Object.entries(typeof merged.bots === 'object' && merged.bots ? merged.bots : {})) {
            bots[normKey(combo)] = entry; // re-key any stored unnormalized entries
          }
          for (const [combo, entry] of Object.entries(bv)) {
            const k2 = normKey(combo);
            if (entry === null) delete bots[k2];
            else bots[k2] = { ...(bots[k2] ?? {}), ...entry };
          }
          merged.bots = bots;
        } else merged[bk] = bv;
      }
      next.bot = merged;
    } else if (k === 'models') {
      // per-provider merge (#99): a partial patch (the panel saves one provider
      // at a time) must not drop other providers' bound models; ''/null deletes
      // one. Carry only allow-listed provider keys so junk / __proto__-style keys
      // already in settings.json can never propagate (same guard as bot.leverage).
      const merged = {};
      const prev = typeof current.models === 'object' && current.models ? current.models : {};
      for (const mp of MODEL_PROVIDER_KEYS) if (prev[mp] != null) merged[mp] = prev[mp];
      // one-time migration: fold a legacy flat `model` into the (pre-patch) active
      // provider's slot so it's preserved, then retire the flat key below. Without
      // this, the flat model would keep shadowing a cleared per-provider binding.
      if (current.models === undefined) {
        const legacyActive = resolveProvider(current);
        if (current.model && legacyActive !== 'none' && merged[legacyActive] === undefined) merged[legacyActive] = current.model;
      }
      for (const [mp, mv] of Object.entries(v)) {
        if (!MODEL_PROVIDER_KEYS.includes(mp)) continue;
        // trim: a whitespace-only model id is a clear, not a (broken) configured
        // value that would fool requireModel while the upstream rejects it.
        const trimmed = mv === null ? '' : String(mv).trim();
        if (trimmed === '') delete merged[mp];
        else merged[mp] = trimmed;
      }
      next.models = merged;
      // retire the legacy flat model: per-provider bindings supersede it, and
      // leaving it would re-shadow a cleared binding via effectiveModel's fallback.
      delete next.model;
    } else next[k] = v;
  }
  // #99: reject a state that would always fail at request time — an explicit
  // openai-compatible provider with no base URL (openaiEndpoint requires one).
  // Validated on the MERGED result so a partial patch can't sneak into it.
  if (next.provider === 'openai-compatible' && !(next.OPENAI_BASE_URL || '').trim()) {
    throw new Error('openai-compatible provider requires OPENAI_BASE_URL');
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, settingsPath);
  return maskedSettings(settingsPath);
}

const lastLiveFetch = new Map(); // key -> { at, tail }: one upstream fetch per ~minute, forming candle cached in between

export async function chartData(dbPath, instrument, { t = null, count = 120, granularity = 'M5', fetcher = fetchCandles, indicators = null } = {}) {
  // Freshness on load: when the stored data is older than one candle period,
  // pull live candles and upsert before serving (shared db gets richer too).
  // Serve stale data if the live fetch fails — availability over freshness.
  let liveTail = null;
  const fetchKey = `${dbPath}|${instrument}|${granularity}`;
  const gate = lastLiveFetch.get(fetchKey);
  if (fetcher && (!gate || Date.now() - gate.at > 55000)) {
    try {
      const live = await fetcher({ instrument, granularity, count: 60 });
      const complete = live.filter((c) => c.complete);
      if (complete.length) storeCandles(dbPath, instrument, granularity, complete);
      liveTail = live.find((c) => !c.complete) ?? null;
      lastLiveFetch.set(fetchKey, { at: Date.now(), tail: liveTail });
    } catch {
      lastLiveFetch.set(fetchKey, { at: Date.now(), tail: null }); // failed: back off, stale view beats none
    }
  } else if (fetcher && gate) {
    liveTail = gate.tail; // gate closed: reuse the forming candle from the last fetch
  }
  const { candles, recent } = withDb(dbPath, (db) => {
    let windowed;
    if (t) {
      // Deep-link window: context before the signal, then everything through
      // the present (capped) so an open view is never frozen at signal+36 bars.
      const before = db.prepare('SELECT * FROM candles WHERE instrument=? AND granularity=? AND time <= ? ORDER BY time DESC LIMIT ?')
        .all(instrument, granularity, t, Math.ceil(count * 0.7)).reverse();
      const after = db.prepare('SELECT * FROM candles WHERE instrument=? AND granularity=? AND time > ? ORDER BY time LIMIT 320')
        .all(instrument, granularity, t);
      windowed = [...before, ...after];
    } else {
      windowed = db.prepare('SELECT * FROM candles WHERE instrument=? AND granularity=? ORDER BY time DESC LIMIT ?')
        .all(instrument, granularity, count).reverse();
    }
    // Latest ~24h regardless of any deep-linked window: the quote is about now.
    const dayBars = Math.ceil(86400000 / granularityMs(granularity));
    const recent = db.prepare('SELECT * FROM candles WHERE instrument=? AND granularity=? ORDER BY time DESC LIMIT ?')
      .all(instrument, granularity, dayBars).reverse();
    return { candles: windowed, recent };
  });
  let supertrend = [];
  let flips = [];
  if (candles.length >= 15) {
    const st = computeSupertrend(candles, {});
    supertrend = st.map((s, i) => s && { time: candles[i].time, value: Number(s.supertrend.toFixed(4)), trend: s.trend }).filter(Boolean);
    flips = detectFlips(candles, st);
  }
  if (liveTail) {
    const tail = { ...liveTail, partial: true };
    const lastMs = candles.length ? Date.parse(candles[candles.length - 1].time) : 0;
    const tailMs = Date.parse(tail.time);
    const reachesPresent = tailMs > lastMs && tailMs - lastMs <= 2 * granularityMs(granularity);
    if ((!t && (!candles.length || tailMs > lastMs)) || (t && reachesPresent)) candles.push(tail);
    if (!recent.length || Date.parse(tail.time) > Date.parse(recent[recent.length - 1].time)) recent.push(tail);
  }
  // Lazy backfill: persist historical flips for whatever combo is being viewed
  // so history/outcomes populate beyond the watcher's own instrument. Flips
  // newer than the watcher's fresh+cooldown horizon are left to the watcher —
  // backfilling them would make its dedup swallow the live notification.
  const horizonMs = 6 * granularityMs(granularity);
  for (const f of flips.slice(-20)) {
    if (Date.now() - Date.parse(f.time) <= horizonMs) continue;
    const { isNew } = recordSignal(dbPath, instrument, granularity, { time: f.time, signal: f.signal, price: f.price }, null);
    if (isNew) {
      withDb(dbPath, (db) => db.prepare('UPDATE signals SET verdict=? WHERE instrument=? AND granularity=? AND time=?')
        .run('backfill', instrument, granularity, f.time));
    }
  }
  const signals = signalOutcomes(dbPath, instrument, granularity, { limit: 50 });
  // Deep-linked signals older than the history window are looked up directly.
  let signal = null;
  if (t) {
    const variants = /\.\d+Z$/.test(t) ? [t] : [t, `${t.slice(0, -1)}.000000000Z`, `${t.slice(0, -1)}.000Z`];
    for (const v of variants) {
      signal = signals.find((s) => s.time === v) ?? signalOutcomes(dbPath, instrument, granularity, { time: v })[0] ?? null;
      if (signal) break;
    }
  } else {
    signal = signals[0] ?? null;
  }
  const quote = buildQuote(recent);
  if (quote && liveTail) quote.partial = true;
  const out = { instrument, granularity, candles, supertrend, flips, signal, signals, quote };
  // #70 follow-up: the re-check button re-checks the LATEST signal server-side
  // (see /api/recheck), so the client must only render it when the shown
  // signal IS that latest one — never on a deep-linked historical view (?t=),
  // where a click would silently re-check a different signal than displayed.
  out.isLatestSignal = signal ? signals[0]?.time === signal.time : true;
  // #70: the last re-check for the shown signal rides with the chart so a
  // reload shows it without a POST — the verdict/history rows it read stay untouched.
  if (signal) {
    const rc = latestRecheck(dbPath, instrument, granularity, signal.time);
    if (rc) out.recheck = { verdict: rc.verdict, reason: rc.reason, at: rc.at, promptVersion: rc.prompt_version };
  }
  if (indicators?.length) {
    const closes = candles.map((k) => k.close);
    const ind = {};
    for (const name of indicators) {
      if (name === 'ema') ind.ema = { ema20: ema(closes, 20), ema50: ema(closes, 50), ema200: ema(closes, 200) };
      else if (name === 'rsi') ind.rsi = rsi(closes, 14);
      else if (name === 'macd') ind.macd = macd(closes);
      else if (name === 'bb') ind.bb = bollinger(closes, 20, 2);
      else if (name === 'vwap') ind.vwap = vwap(candles);
    }
    out.indicators = ind;
  }
  // the axis-gate chips are core context, independent of display toggles
  out.axisGate = axisSnapshot(candles, { instrument, granularity }) ?? null;
  return out;
}

// Bot decisions for the chart's inline annotation (#73): journal 'decision'
// rows carry {instrument,granularity,decision:{action,reasoning}} in context
// and an `at` timestamp shortly AFTER the triggering signal's candle. Matched
// by combo + at falling within [signal time, signal time + 2x candle] — no
// client-side joins, bounded to the last ~50 decisions for this combo.
function recentBotDecisions(dbPath, instrument, granularity) {
  const rows = withDb(dbPath, (db) => {
    try {
      // both keys in the LIKE prefilter so the LIMIT counts rows of THIS combo —
      // limiting before the granularity filter could starve M5 under M1 noise
      return db.prepare("SELECT at, context FROM bot_journal WHERE action='decision' AND context LIKE ? AND context LIKE ? ORDER BY id DESC LIMIT 50")
        .all(`%"instrument":"${instrument}"%`, `%"granularity":"${granularity}"%`);
    } catch (err) {
      if (/no such table/i.test(String(err.message))) return [];
      throw err;
    }
  });
  const out = [];
  for (const r of rows) {
    let ctx;
    try { ctx = JSON.parse(r.context); } catch { continue; }
    // exact-match BOTH keys — the LIKE prefilter is an index hint, not the contract
    if (ctx?.instrument !== instrument || ctx?.granularity !== granularity || !ctx?.decision?.action) continue;
    // full reasoning travels (it backs the hover title); the client truncates the inline fragment
    out.push({ at: r.at, action: ctx.decision.action, reasoning: String(ctx.decision.reasoning ?? '') });
  }
  return out;
}

// Newest decision (rows are id-DESC, so the first match wins) whose `at`
// lands in the signal's candle window.
function matchBotDecision(decisions, signalTime, candleMs) {
  const sigMs = Date.parse(signalTime);
  const d = decisions.find((x) => { const at = Date.parse(x.at); return at >= sigMs && at <= sigMs + 2 * candleMs; });
  return d ? { action: d.action, reasoning: d.reasoning, at: d.at } : null;
}

const CHAT_DDL = `CREATE TABLE IF NOT EXISTS chat_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  instrument TEXT,
  granularity TEXT
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  context TEXT,
  created_at TEXT NOT NULL
)`;

function chatDb(dbPath, fn) {
  return withDb(dbPath, (db) => {
    db.exec(CHAT_DDL);
    // Pre-#30 dbs lack the view columns. Another process (watcher CLI) can win
    // the same ALTER between our PRAGMA check and exec; only that loss is benign.
    const addColumn = (ddl) => {
      try { db.exec(ddl); } catch (err) {
        if (!/duplicate column/i.test(String(err?.message))) throw err;
      }
    };
    const cols = new Set(db.prepare('PRAGMA table_info(chat_threads)').all().map((c) => c.name));
    if (!cols.has('instrument')) addColumn('ALTER TABLE chat_threads ADD COLUMN instrument TEXT');
    if (!cols.has('granularity')) addColumn('ALTER TABLE chat_threads ADD COLUMN granularity TEXT');
    return fn(db);
  });
}

// The one validator for a requested view, shared by every chat surface:
// untrusted input falls back to the settings-default view.
export function resolveView(cfg, inst, gran) {
  return {
    instrument: typeof inst === 'string' && /^[A-Za-z0-9/]{3,20}$/.test(inst) ? inst : (cfg.instrument || DEFAULT_INSTRUMENT),
    granularity: typeof gran === 'string' && /^[MH]\d{1,2}$/.test(gran) ? gran : (cfg.granularity || 'M5'),
  };
}

// Threads are view-bound (issue #30). The scope filters to that view plus legacy
// NULL-scoped threads (pre-migration history stays reachable from every view).
export function listThreads(dbPath, scope) {
  return chatDb(dbPath, (db) => db.prepare(
    'SELECT t.*, COUNT(m.id) AS messages FROM chat_threads t LEFT JOIN chat_messages m ON m.thread_id = t.id WHERE t.instrument IS NULL OR (t.instrument = ? AND t.granularity = ?) GROUP BY t.id ORDER BY t.id DESC')
    .all(scope.instrument, scope.granularity));
}

export function deleteThread(dbPath, id) {
  chatDb(dbPath, (db) => {
    db.prepare('DELETE FROM chat_messages WHERE thread_id=?').run(id);
    db.prepare('DELETE FROM chat_threads WHERE id=?').run(id);
  });
}

export function listMessages(dbPath, threadId) {
  return chatDb(dbPath, (db) => db.prepare('SELECT * FROM chat_messages WHERE thread_id=? ORDER BY id').all(threadId));
}

function addMessage(dbPath, threadId, role, content, context = null) {
  return chatDb(dbPath, (db) => db.prepare('INSERT INTO chat_messages (thread_id, role, content, context, created_at) VALUES (?,?,?,?,?)')
    .run(threadId, role, content, context, new Date().toISOString()).lastInsertRowid);
}

// Repo skills exposed to the chat as tools. Executors shell out to the skill
// scripts with clamped args and bounded output — the entire tool surface for
// the API providers' native tool-calling (pi chat is tool-less).
const clampInt = (v, lo, hi, dflt) => (Number.isInteger(v) && v >= lo && v <= hi ? v : dflt);
// Validated rate slugs per market from config/instruments.yaml (never guess slugs).
function loadRateSlugs() {
  try {
    const yml = readFileSync('config/instruments.yaml', 'utf8');
    const out = {};
    let market = null;
    for (const line of yml.split('\n')) {
      const m = line.match(/^  (\w[\w-]*):/);
      if (m) { market = m[1]; out[market] = []; continue; }
      const sm = line.match(/- slug: (\S+)/);
      if (sm && market) out[market].push(sm[1]);
    }
    return out;
  } catch { return {}; }
}
const RATE_SLUGS = loadRateSlugs();
const RATE_SLUGS_HINT = Object.entries(RATE_SLUGS).map(([m, sl]) => `${m}: ${sl.join(', ')}`).join(' | ');
export const CHAT_TOOLS = [
  {
    name: 'fxempire_articles',
    description: 'Fetch recent FXEmpire news articles for tracked instruments (live SSR source since #28). If it returns none for the window, fall back to web search rather than retrying with wider windows.',
    input_schema: { type: 'object', properties: { hours: { type: 'integer', description: 'lookback hours (1-72, default 12)' }, maxItems: { type: 'integer', description: 'max articles (1-20, default 6)' } }, additionalProperties: false },
    run: (a) => {
      const out = execFileSync(process.execPath, ['skills/fxempire-analysis/scripts/fxempire_articles.mjs', '--hours', String(clampInt(a?.hours, 1, 72, 12)), '--max-items', String(clampInt(a?.maxItems, 1, 20, 6)), '--json'], { encoding: 'utf8', timeout: 45000 });
      try {
        const parsed = JSON.parse(out);
        if (!parsed.articles?.length) {
          return JSON.stringify({ ...parsed, note: 'No articles in the window from either the live SSR source or the legacy hub. Use web search for current market news instead of retrying.' });
        }
      } catch { /* pass raw through */ }
      return out;
    },
  },
  {
    name: 'sentinel_news',
    description: 'Fetch breaking geopolitical/macro news for an instrument. When NEWSAPI_AI_KEY is configured it queries NewsAPI.ai (preferred, richer/fresher) merged with the free query-driven sources (Google News, GDELT, Al Jazeera, OilPrice.com, a per-instrument Yahoo Finance feed); without a key it uses the free sources only. Carries an escalation flag (keyword hit or negative GDELT tone). Defaults to the currently viewed instrument. Only instruments with a committed sentinel query in config/instruments.yaml resolve.',
    input_schema: { type: 'object', properties: { instrument: { type: 'string', description: 'candle symbol, e.g. WTICO/USD; defaults to the current view' }, hours: { type: 'integer', description: 'lookback hours (1-72, default 12)' }, maxItems: { type: 'integer', description: 'max headlines after dedup (1-30, default 15)' } }, additionalProperties: false },
    run: (a, ctx) => {
      // Validate BOTH the explicit arg and the view fallback with the same
      // guard resolveView uses — never pass ctx.view.instrument through to
      // the CLI on trust alone (it should already be validated upstream, but
      // this tool must not depend on every future caller getting that right).
      const validInstrument = (v) => typeof v === 'string' && /^[A-Za-z0-9/]{3,20}$/.test(v);
      const instrument = validInstrument(a?.instrument) ? a.instrument
        : validInstrument(ctx?.view?.instrument) ? ctx.view.instrument
        : DEFAULT_INSTRUMENT;
      // Inject the NewsAPI.ai config from settings.json into the subprocess env
      // (issue #114): the CLI resolves the provider from process.env, but the key
      // lives in settings (the LaunchAgent never loads .env), so without this the
      // chat/bot sentinel tool silently falls back to the free stack only.
      const env = { ...process.env, ...resolveNewsApiAiSource(ctx?.settings || {}) };
      return execFileSync(process.execPath, ['skills/market-sentinel/scripts/sentinel_news.mjs', '--instrument', instrument, '--hours', String(clampInt(a?.hours, 1, 72, 12)), '--max-items', String(clampInt(a?.maxItems, 1, 30, 15)), '--json'], { encoding: 'utf8', timeout: 45000, env });
    },
  },
  {
    name: 'truthsocial_posts',
    description: 'Fetch recent Trump Truth Social posts from the archive (market-moving statements). Use for "did Trump post anything?" questions.',
    input_schema: { type: 'object', properties: { hours: { type: 'integer', description: 'lookback hours (1-336, default 24)' } }, additionalProperties: false },
    run: (a) => {
      const since = new Date(Date.now() - clampInt(a?.hours, 1, 336, 24) * 3600000).toISOString();
      return execFileSync(process.execPath, ['scripts/fetch-trump-posts.mjs', '--since', since], { encoding: 'utf8', timeout: 45000 });
    },
  },
  {
    name: 'live_rates',
    description: `Live last/change/percent rates for instrument slugs via FXEmpire. Use ONLY these validated slugs (others 404; no DXY available) — ${RATE_SLUGS_HINT || 'wti-crude-oil, gold'}. market must match the slug group.`,
    input_schema: { type: 'object', properties: { market: { type: 'string', enum: ['commodities', 'indices', 'currencies', 'crypto-coin'] }, slugs: { type: 'string', description: 'csv of rate slugs' } }, required: ['market', 'slugs'], additionalProperties: false },
    run: (a) => {
      if (!/^[a-z0-9,-]{2,120}$/.test(a?.slugs ?? '')) throw new Error('invalid slugs');
      if (!['commodities', 'indices', 'currencies', 'crypto-coin'].includes(a?.market)) throw new Error('invalid market');
      return execFileSync(process.execPath, ['skills/fxempire-live-data/scripts/fxempire_live_data.mjs', '--mode', 'rates', '--market', a.market, '--slugs', a.slugs, '--pretty', 'false'], { encoding: 'utf8', timeout: 30000 });
    },
  },
  {
    name: 'save_strategy',
    description: 'Save a DRAFT trading strategy (new version each save; append-only). Drafts NEVER trade: activation is a human act in the bot modal (or settings). Set dedicated:true for a strategy meant for exactly one instrument/granularity combo — instrument/granularity then default to the trader\'s current view when omitted. Use when the trader asks to draft or iterate a bot strategy conversationally.',
    input_schema: { type: 'object', properties: {
      name: { type: 'string', description: 'kebab-case identifier' },
      prompt: { type: 'string', description: 'the strategy prompt text (20-4000 chars)' },
      instruments: { type: 'string', description: 'optional combo CSV, e.g. "WTICO/USD|M5" (deliberation guardrail, independent of scope)' },
      dedicated: { type: 'boolean', description: 'true when this strategy is meant for exactly one combo' },
      instrument: { type: 'string', description: 'scope instrument; defaults to the current view when dedicated is true and this is omitted' },
      granularity: { type: 'string', description: 'scope granularity; defaults to the current view when dedicated is true and this is omitted' },
    }, required: ['name', 'prompt'], additionalProperties: false },
    run: (a, ctx) => {
      if (!ctx?.dbPath) throw new Error('save_strategy needs a db context');
      // #75: dedicated drafts default their scope from the combo the trader is
      // currently looking at — asking for "a strategy for this view" needs no
      // instrument/granularity spelled out.
      const dedicated = a?.dedicated === true;
      const instrument = a?.instrument ?? (dedicated ? ctx?.view?.instrument ?? null : null);
      const granularity = a?.granularity ?? (dedicated ? ctx?.view?.granularity ?? null : null);
      const saved = saveStrategy(ctx.dbPath, {
        name: a?.name, prompt: a?.prompt, instruments: a?.instruments ?? null, instrument, granularity, dedicated, createdBy: 'chat',
      });
      return JSON.stringify({ ...saved, note: 'draft saved — NOT active; activate + assign it in the bot modal for its combo (or settings)' });
    },
  },
  {
    name: 'save_memory',
    description: 'Save a durable trader memory: a standing rule or preference to keep in view across future chat, filter, and bot-deliberation prompts (advisory only — never overrides fail-safe clamps). Use when the trader states a lasting instruction, not a one-off fact.',
    input_schema: { type: 'object', properties: { content: { type: 'string', description: 'the memory text (max 500 chars)' }, weight: { type: 'integer', description: 'importance 1-5, default 3' } }, required: ['content'], additionalProperties: false },
    run: (a, ctx) => {
      if (!ctx?.dbPath) throw new Error('save_memory needs a db context');
      // coerce numeric strings, then let saveMemory's 1-5 integer validation throw on garbage
      const saved = saveMemory(ctx.dbPath, { content: a?.content, weight: a?.weight === undefined || a?.weight === null ? 3 : Number(a.weight), source: 'chat' });
      return `saved memory (weight ${saved.weight}): ${saved.content}`;
    },
  },
  {
    name: 'save_gate_prompt',
    description: 'Save a DRAFT revision of a gate\'s advisory rules text (new version each save; append-only). Drafts NEVER take effect: activation is a human act in the settings gates section. The filter and recheck gates are overridable — the bot prompt is strategy-owned and the chat prompt is constant. Use when the trader asks to draft or iterate the filter\'s or re-check\'s rules conversationally.',
    input_schema: { type: 'object', properties: { gate: { type: 'string', enum: GATES }, prompt: { type: 'string', description: 'the gate rules text (max 4000 chars) — advisory only; it can never grant tools or change the JSON verdict schema, which is always appended server-side' } }, required: ['gate', 'prompt'], additionalProperties: false },
    run: (a, ctx) => {
      if (!ctx?.dbPath) throw new Error('save_gate_prompt needs a db context');
      const saved = saveGatePrompt(ctx.dbPath, { gate: a?.gate, prompt: a?.prompt, createdBy: 'chat' });
      return JSON.stringify({ ...saved, note: 'draft saved — NOT active; the trader activates gate prompts in settings' });
    },
  },
];
// Tools available to the bot's deliberation loop: full CHAT_TOOLS minus the
// trader-initiated writes (memory saves, strategy drafts, and gate-prompt
// drafts are chat-only, never a side effect of a trade decision — real
// source of truth for both the runtime call site and its test).
export function botToolDefs() {
  return CHAT_TOOLS.filter((t) => t.name !== 'save_strategy' && t.name !== 'save_memory' && t.name !== 'save_gate_prompt');
}
export function execChatTool(name, input, ctx = {}) {
  const tool = CHAT_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool ${name}`);
  return String(tool.run(input ?? {}, ctx)).slice(0, 8000);
}

// The model annotates each reply with an evolving thread title (issue #38);
// stripped before persistence/display, applied when it changed.
export function extractThreadTitle(reply) {
  const text = String(reply);
  const m = text.match(/\r?\n?<!--\s*title:\s*(.{1,120}?)\s*-->\s*$/);
  if (!m || /[\r\n]/.test(m[1])) return { text, title: null };
  // Only the annotation (and its single leading newline) is removed — trailing
  // whitespace in the reply (markdown hard breaks) is content, not noise.
  return { text: text.slice(0, m.index), title: m[1].slice(0, 48).trim() || null };
}

const CHAT_SYSTEM = `You are the trading copilot embedded in the market-signals local dashboard of a leveraged CFD trader. Each question carries a JSON context block: the currently viewed instrument/granularity, its quote, recent candles, the latest signal with verdict and realized outcomes, recent signal history, the trader's notes, and (once the bot has traded) a botPerformance summary per strategy — use it to answer "why is the bot up/down" questions; an axisGate block groups indicator evidence into five independent axes (trend-strength ADX, direction/regime, impulse, VWAP location, RSI exhaustion) — cite axis verdicts rather than re-deriving indicators; when the trader has saved any, a traderMemories block lists their standing rules/preferences — advisory context to weigh, never a substitute for the fail-safe clamps; a gatePrompts block carries the alert filter's current effective rules text (its note explains the bot/chat prompts) — use it if the trader wants to discuss or draft a revision (save_gate_prompt saves a draft; activation is a human act in settings); prior thread messages may precede the question. All timestamps in the context are ALREADY in the trader's local timezone (view.traderTimezone), matching the chart axis — quote them as-is, never convert, never mention UTC. Be brief: default to 2-5 sentences or a few tight bullets with concrete levels — no headers, no recap of the question, no closing offers unless something genuinely warrants a follow-up. Expand only when explicitly asked. You provide analysis, never order execution. When tools are available, use them to expand context before speculating: fxempire_articles for recent market news, sentinel_news for breaking geopolitical/macro news with an escalation flag, truthsocial_posts for market-moving Trump posts, live_rates for current cross-instrument rates, and web search for anything else time-sensitive. Prefer the provided context; fetch only what is missing. End EVERY reply with a final line of exactly: <!--title: <max 48 chars summarizing this whole thread>--> — it is stripped before display and keeps the thread list meaningful.`;

// Opt-in provider footnotes (#116): when the trader enables the toggle, tell the
// copilot to name which feed (e.g. newsapi-ai vs google-news) each headline came
// from — the sentinel_news tool output already carries a per-item `provider`.
// Off by default ⇒ base CHAT_SYSTEM unchanged.
const CHAT_SOURCE_FOOTNOTE_RULE = ` When you cite headlines from sentinel_news, add a brief footnote naming each item's fetch source (its \`provider\` field, e.g. newsapi-ai or google-news) — this is separate from the publisher's own link.`;
export function chatSystemFor(cfg) {
  return isSettingOn(cfg?.sentinelSourceFootnotes) ? CHAT_SYSTEM + CHAT_SOURCE_FOOTNOTE_RULE : CHAT_SYSTEM;
}

// Gate transparency (#58): server-built (no secrets) so the settings gates
// section and the chat context both read the SAME effective prompt/toolset
// per gate — one source of truth, never re-derived client-side.
async function gatesInfo(dbPath) {
  const filterEff = await resolveFilterSystem(dbPath);
  const recheckEff = await resolveRecheckSystem(dbPath);
  const strat = activeStrategy(dbPath);
  return {
    filter: {
      toolset: [],
      prompt: filterEff.system,
      promptVersion: filterEff.promptVersion,
      drafts: listGatePrompts(dbPath, { gate: 'filter' }),
    },
    // #70: operator-initiated only — never in the bot/chat toolsets.
    recheck: {
      toolset: [],
      prompt: recheckEff.system,
      promptVersion: recheckEff.promptVersion,
      drafts: listGatePrompts(dbPath, { gate: 'recheck' }),
    },
    bot: {
      toolset: [...botToolDefs().map((t) => t.name), 'web_search'],
      strategyName: strat ? `${strat.name} v${strat.version}` : null,
      prompt: strat ? strat.prompt : null,
    },
    chat: {
      toolset: CHAT_TOOLS.map((t) => t.name),
      prompt: CHAT_SYSTEM,
    },
  };
}

// Current course info from the latest stored candles (at most one candle stale).
function buildQuote(recent) {
  if (!recent.length) return null;
  const last = recent[recent.length - 1];
  const lastMs = Date.parse(last.time);
  const at = (minsBack) => recent.find((c) => Date.parse(c.time) >= lastMs - minsBack * 60000) ?? recent[0];
  const pct = (ref) => ref?.close ? Number(((last.close - ref.close) / ref.close * 100).toFixed(2)) : null;
  const dayKey = last.time.slice(0, 10);
  const day = recent.filter((c) => c.time.startsWith(dayKey));
  let st = null;
  if (recent.length >= 15) {
    const series = computeSupertrend(recent, {});
    const cur = series[series.length - 1];
    if (cur) st = { value: Number(cur.supertrend.toFixed(4)), trend: cur.trend, distPct: Number(((last.close - cur.supertrend) / last.close * 100).toFixed(2)) };
  }
  return {
    last: last.close,
    time: last.time,
    change1hPct: pct(at(60)),
    change24hPct: pct(recent[0]),
    dayHigh: Math.max(...day.map((c) => c.high)),
    dayLow: Math.min(...day.map((c) => c.low)),
    supertrend: st,
  };
}

const VENDOR_TYPES = {
  'chart.umd.js': 'application/javascript',
  'chartjs-adapter-date-fns.bundle.min.js': 'application/javascript',
  'chartjs-chart-financial.min.js': 'application/javascript',
};
const vendorCache = new Map();
function serveVendor(res, name) {
  if (!VENDOR_TYPES[name]) return false;
  if (!vendorCache.has(name)) {
    vendorCache.set(name, readFileSync(fileURLToPath(new URL(`../vendor/${name}`, import.meta.url))));
  }
  res.writeHead(200, { 'content-type': VENDOR_TYPES[name], 'cache-control': 'max-age=86400' });
  res.end(vendorCache.get(name));
  return true;
}

// #128: the dashboard page (was a ~1390-line constant template literal inline
// here) lives in vendor/app.html — a self-contained static asset, read once and
// cached. Moving it out of the template literal removes the backtick/`${}`
// escaping hazard: the file is plain HTML/CSS/JS you can edit without escaping.
let pageCache = null;
function servePage(res) {
  if (pageCache === null) pageCache = readFileSync(fileURLToPath(new URL('../vendor/app.html', import.meta.url)), 'utf8');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pageCache);
}

// CSRF guard for the localhost API: browsers attach an Origin header to
// cross-site requests; anything not from this host is rejected. Non-browser
// clients (curl, scripts) send no Origin and pass.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

// Multibyte-safe request body accumulation with the shared 64KB cap.
async function readBody(req, res) {
  const dec = new TextDecoder();
  let raw = '';
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) {
      json(res, 413, { ok: false, error: 'body too large' });
      return null;
    }
    raw += dec.decode(chunk, { stream: true });
  }
  return raw + dec.decode();
}

// extraHeaders (#93): additive — every existing caller omits it and gets the
// exact same two headers as before (byte-identical when MS_DEBUG_LLM is off).
function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

// #128: shared POST-body read+parse (was copy-pasted across 7 handlers). Returns
// the parsed JSON, or `undefined` AFTER already sending the response — a 413 from
// readBody's size cap, or a 400 on invalid JSON. Callers do
// `if (body === undefined) return;`. A literal JSON `null` body still round-trips;
// only `undefined` signals "already handled".
async function readJson(req, res) {
  const raw = await readBody(req, res);
  if (raw === null) return undefined; // readBody already sent 413
  try { return JSON.parse(raw); } catch { json(res, 400, { ok: false, error: 'invalid JSON' }); return undefined; }
}

export function buildServer({ dbPath, settingsPath, fetcher = fetchCandles }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method !== 'GET' && !sameOrigin(req)) {
        return json(res, 403, { ok: false, error: 'cross-origin requests are not allowed' });
      }
      if (url.pathname === '/api/chart') {
        const cfg = readSettings(settingsPath);
        const instrument = url.searchParams.get('instrument') || cfg.instrument || DEFAULT_INSTRUMENT;
        const t = url.searchParams.get('t');
        const granularity = url.searchParams.get('granularity') || cfg.granularity || 'M5';
        const parseInd = (v) => (v || '').split(',').map((x) => x.trim()).filter((x) => ['ema', 'rsi', 'macd', 'bb', 'vwap'].includes(x));
        const indParam = parseInd(url.searchParams.get('ind'));
        // no URL selection → the globally-stored selection applies (#49)
        const effectiveInd = indParam.length ? indParam : parseInd(cfg.ind);
        const data = await chartData(dbPath, instrument, { t, granularity, fetcher, indicators: effectiveInd.length ? effectiveInd : null });
        data.activeInd = effectiveInd;
        data.info = cfg.info === true; // #57: persisted globally, same pattern as ind
        // per-combo bot state for the header icon (#49 design: dot=combo, ring=global halt)
        const botFor = resolveBotFor(cfg, instrument, granularity, dbPath);
        const pfB = portfolioView(dbPath, botConfig(cfg));
        // #75: the ACTIVE version of the bot's strategy name — not a frozen row.
        const strat = resolvedStrategy(dbPath, botFor);
        const pos = pfB.positions.find((pp) => pp.instrument === instrument) ?? null;
        data.botState = {
          configured: botFor.configured === true,
          enabled: botFor.enabled,
          strategyName: strat ? `${strat.name} v${strat.version}` : null,
          halted: pfB.halted,
          openPosition: pos ? { side: pos.side, unrealized: Math.round(pos.unrealized * 100) / 100 } : null,
        };
        if (botFor.configured) {
          const decisions = recentBotDecisions(dbPath, instrument, granularity);
          const candleMs = granularityMs(granularity);
          if (data.signal) {
            const m = matchBotDecision(decisions, data.signal.time, candleMs);
            if (m) data.botDecision = m;
          }
          const botDecisions = {};
          for (const s of data.signals) {
            const m = matchBotDecision(decisions, s.time, candleMs);
            if (m) botDecisions[s.time] = m;
          }
          if (Object.keys(botDecisions).length) data.botDecisions = botDecisions;
        }
        const configured = (cfg.instruments ?? '').split(',').map((x) => x.trim()).filter(Boolean);
        data.instruments = configured.length ? configured : DEFAULT_INSTRUMENTS;
        if (!data.instruments.includes(instrument)) data.instruments = [instrument, ...data.instruments];
        data.watchers = (cfg.watchers ?? '').split(',').map((x) => x.trim()).filter(Boolean);
        data.watched = data.watchers.includes(`${instrument}|${granularity}`);
        return json(res, 200, data);
      }
      // #70: operator-initiated re-check of the LATEST signal of the current
      // view (never a deep-linked/historical one). Same-origin guarded above
      // like every other non-GET route. Never touches the signals/
      // signal_snapshots rows it reads — persists a NEW signal_rechecks row.
      if (url.pathname === '/api/recheck' && req.method === 'POST') {
        const body = await readJson(req, res);
        if (body === undefined) return;
        const cfg = readSettings(settingsPath);
        const instrument = body?.instrument || cfg.instrument || DEFAULT_INSTRUMENT;
        const granularity = body?.granularity || cfg.granularity || 'M5';
        const [signal] = signalOutcomes(dbPath, instrument, granularity, { limit: 1 });
        if (!signal) return json(res, 404, { ok: false, error: 'no signal recorded for this view yet' });
        try {
          // MS_DEBUG_LLM (#93): recheck is non-streamed, so all four X-LLM-*
          // headers are available together, unlike chat's SSE split below.
          const debugLlm = Boolean(process.env.MS_DEBUG_LLM);
          let llmInfo = null;
          const result = await recheckSignal(dbPath, settingsPath, instrument, granularity, signal, debugLlm ? (info) => { llmInfo = info; } : undefined);
          const headers = {};
          if (debugLlm && llmInfo) {
            headers['X-LLM-Provider'] = llmInfo.provider;
            headers['X-LLM-Model'] = llmInfo.model ?? 'n/a';
            const tok = (v) => (v == null ? 'n/a' : String(v));
            headers['X-LLM-Usage-Input'] = llmInfo.usage ? tok(llmInfo.usage.inputTokens) : 'n/a';
            headers['X-LLM-Usage-Output'] = llmInfo.usage ? tok(llmInfo.usage.outputTokens) : 'n/a';
          }
          return json(res, 200, { ok: true, ...result }, headers);
        } catch (err) {
          // fail-open UX: never crash the server — a visible error line beats a 500 page
          return json(res, 502, { ok: false, error: err.message });
        }
      }
      if (url.pathname === '/api/settings' && req.method === 'GET') {
        return json(res, 200, maskedSettings(settingsPath));
      }
      if (url.pathname === '/api/settings' && req.method === 'POST') {
        const patch = await readJson(req, res);
        if (patch === undefined) return;
        try {
          // resetHalt is EPHEMERAL and runs ONLY after the rest of the patch
          // validated+persisted — an invalid patch must never half-apply a
          // safety-path mutation
          const wantsReset = patch?.bot?.resetHalt === true;
          if (wantsReset) {
            delete patch.bot.resetHalt;
            if (!Object.keys(patch.bot).length) delete patch.bot;
          }
          const settingsOut = writeSettings(settingsPath, patch);
          if (wantsReset) performHaltReset(dbPath, readSettings(settingsPath));
          return json(res, 200, { ok: true, settings: settingsOut });
        }
        catch (err) { return json(res, 400, { ok: false, error: err.message }); }
      }
      if (url.pathname === '/api/bots' && req.method === 'GET') {
        // read-only activated-bots list for the portfolio overview (#49 design)
        const cfgB = readSettings(settingsPath);
        const bots = (cfgB.bot && typeof cfgB.bot.bots === 'object' && cfgB.bot.bots) || {};
        const pf = portfolioView(dbPath, botConfig(cfgB));
        const audit = decisionAudit(dbPath, { limit: 200 });
        // complete aggregates straight from the tables — attributed PER COMBO via
        // the decision journal (position → combo); a bot that is the sole bot on
        // its instrument also absorbs unattributed trades for that instrument
        const { comboAgg, soloUnattributed } = withDb(dbPath, (db) => {
          const safe = (sql) => { try { return db.prepare(sql).all(); } catch (err) { if (/no such table/i.test(String(err.message))) return []; throw err; } };
          const posCombo = new Map();
          for (const jrow of safe("SELECT context FROM bot_journal WHERE action='decision' ORDER BY id DESC LIMIT 5000")) {
            try {
              const c = JSON.parse(jrow.context);
              if (c?.executed?.opened && c.instrument && c.granularity) posCombo.set(c.executed.opened, `${c.instrument}|${c.granularity}`);
            } catch { /* skip */ }
          }
          const comboAgg2 = new Map();
          const solo = new Map();
          for (const t of safe('SELECT position_id, instrument, realized FROM bot_trades')) {
            const combo = posCombo.get(t.position_id);
            const bump = (map, key) => { const cur = map.get(key) ?? { c: 0, r: 0 }; cur.c += 1; cur.r += t.realized; map.set(key, cur); };
            if (combo) bump(comboAgg2, combo); else bump(solo, t.instrument);
          }
          return { comboAgg: comboAgg2, soloUnattributed: solo };
        });
        const engineCfg = botConfig(cfgB); // once per request, not per row
        const botsPerInstrument = new Map();
        for (const k of Object.keys(bots)) {
          const inst0 = k.split('|')[0].trim();
          botsPerInstrument.set(inst0, (botsPerInstrument.get(inst0) ?? 0) + 1);
        }
        const rows = Object.entries(bots).map(([combo, b]) => {
          const [inst, gran] = combo.split('|').map((x) => x.trim());
          // #75: resolve through the SAME name→active-version path runBot uses,
          // so this list always reflects the version the bot will actually
          // trade next — never a frozen row.
          const botFor = resolveBotFor(cfgB, inst, gran, dbPath);
          const strat = resolvedStrategy(dbPath, botFor);
          const attributed = comboAgg.get(`${inst}|${gran}`) ?? { c: 0, r: 0 };
          const orphan = botsPerInstrument.get(inst) === 1 ? (soloUnattributed.get(inst) ?? { c: 0, r: 0 }) : { c: 0, r: 0 };
          const agg = { c: attributed.c + orphan.c, r: attributed.r + orphan.r };
          const lastDecision = audit.find((a) => a.instrument === inst && (a.granularity == null || a.granularity === gran));
          return {
            combo: `${inst}|${gran}`, instrument: inst, granularity: gran,
            enabled: b.enabled === true,
            strategyId: strat?.id ?? null,
            strategyName: strat ? `${strat.name} v${strat.version}` : null,
            riskPct: b.riskPct ?? null,
            allocationPct: b.allocationPct ?? null,
            leverage: instrumentLeverage(engineCfg, inst), // the engine's own resolution — no drift
            trades: agg.c,
            realized: Math.round(agg.r * 100) / 100,
            lastDecisionAt: lastDecision?.at ?? null,
            lastDecisionReason: lastDecision?.reason ?? null,
          };
        });
        return json(res, 200, { ok: true, bots: rows, halted: pf.halted, equity: pf.equity });
      }
      if (url.pathname === '/api/strategies' && req.method === 'GET') {
        ensureSeedStrategy(dbPath);
        // ?id=NN: one version's FULL prompt/spec (the list below only carries a
        // 120-char preview) — feeds the bot modal's strategy-tab inline editor.
        const idParam = url.searchParams.get('id');
        if (idParam !== null) {
          const id = Number(idParam);
          if (!Number.isInteger(id) || id < 1) return json(res, 400, { ok: false, error: 'id must be a positive integer' });
          const row = strategyById(dbPath, id);
          if (!row) return json(res, 404, { ok: false, error: 'unknown strategy' });
          // review fix: a non-JSON stored spec (older db, manual edit) must
          // never throw and crash the handler — surface it as a structured
          // null-spec + specError flag instead of a 500.
          let spec = null; let specError = null;
          if (row.spec) {
            try { spec = JSON.parse(row.spec); } catch { specError = 'stored spec is not valid JSON'; }
          }
          return json(res, 200, { ok: true, strategy: { ...row, spec, specError } });
        }
        return json(res, 200, { ok: true, strategies: listStrategies(dbPath), activeId: activeStrategy(dbPath)?.id ?? null });
      }
      // #75: manual draft save (bot-modal inline edit) — new INACTIVE version,
      // same append-only rule as the chat tool; activation stays a separate act.
      if (url.pathname === '/api/strategies' && req.method === 'POST') {
        const body = await readJson(req, res);
        if (body === undefined) return;
        try {
          const saved = saveStrategy(dbPath, {
            name: body.name, prompt: body.prompt, spec: body.spec ?? null, instruments: body.instruments ?? null,
            instrument: body.instrument ?? null, granularity: body.granularity ?? null, dedicated: body.dedicated === true,
            createdBy: 'manual',
          });
          return json(res, 200, { ok: true, strategy: saved });
        } catch (err) { return json(res, 400, { ok: false, error: err.message }); }
      }
      if (url.pathname === '/api/strategies/activate' && req.method === 'POST') {
        const body = await readJson(req, res);
        if (body === undefined) return;
        const id = Number(body.id);
        if (!Number.isInteger(id) || id < 1) return json(res, 400, { ok: false, error: 'id required' });
        try { activateStrategy(dbPath, id); } catch (err) { return json(res, 400, { ok: false, error: err.message }); }
        return json(res, 200, { ok: true, activeId: id });
      }
      if (url.pathname === '/api/memories' && req.method === 'GET') {
        const all = listMemories(dbPath, { includeArchived: true });
        return json(res, 200, { ok: true, memories: all.filter((m) => !m.archived), archivedCount: all.filter((m) => m.archived).length });
      }
      if (url.pathname === '/api/memories' && req.method === 'POST') {
        const body = await readJson(req, res);
        if (body === undefined) return;
        const id = Number(body.id);
        try {
          if (body.action === 'save') return json(res, 200, { ok: true, memory: saveMemory(dbPath, { content: body.content, weight: body.weight === undefined || body.weight === null ? undefined : Number(body.weight), source: 'manual' }) });
          if (!Number.isInteger(id) || id < 1) return json(res, 400, { ok: false, error: 'id required' });
          if (body.action === 'reweight') return json(res, 200, { ok: true, ...reweightMemory(dbPath, id, Number(body.weight)) });
          if (body.action === 'edit') return json(res, 200, { ok: true, ...editMemory(dbPath, id, body.content) });
          if (body.action === 'archive') return json(res, 200, { ok: true, ...archiveMemory(dbPath, id) });
          return json(res, 400, { ok: false, error: 'unknown action' });
        } catch (err) { return json(res, 400, { ok: false, error: err.message }); }
      }
      if (url.pathname === '/api/gate-prompts' && req.method === 'GET') {
        return json(res, 200, { ok: true, gates: await gatesInfo(dbPath) });
      }
      if (url.pathname === '/api/gate-prompts' && req.method === 'POST') {
        const body = await readJson(req, res);
        if (body === undefined) return;
        try {
          // #90: inline drafting from the dedicated gates modal — same writer
          // (saveGatePrompt) as the chat tool, same gate-enum validation
          // (filter|recheck only), always stored INACTIVE. Activation stays a
          // separate action below, same human-only guardrail as before.
          if (body.action === 'save') return json(res, 200, { ok: true, draft: saveGatePrompt(dbPath, { gate: body.gate, prompt: body.prompt, createdBy: 'manual' }) });
          const id = Number(body.id);
          if (!Number.isInteger(id) || id < 1) return json(res, 400, { ok: false, error: 'id required' });
          if (body.action === 'activate') return json(res, 200, { ok: true, ...activateGatePrompt(dbPath, id) });
          if (body.action === 'deactivate') return json(res, 200, { ok: true, ...deactivateGatePrompt(dbPath, id) });
          return json(res, 400, { ok: false, error: 'unknown action' });
        } catch (err) { return json(res, 400, { ok: false, error: err.message }); }
      }
      if (url.pathname === '/api/evaluation') {
        // Read-only like every portfolio surface (#22 guarantee).
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'evaluation is read-only over HTTP' });
        const cfgS = readSettings(settingsPath);
        const bcfg = botConfig(cfgS);
        const inst = url.searchParams.get('instrument') || cfgS.instrument || DEFAULT_INSTRUMENT;
        const gran = url.searchParams.get('granularity') || cfgS.granularity || 'M5';
        const sid = Number(url.searchParams.get('strategy'));
        const board = strategyScoreboard(dbPath, bcfg.startingBalance);
        const strategyId = Number.isInteger(sid) && sid > 0 ? sid : null;
        // baseline window = earliest ATTRIBUTED entry for THIS instrument (and
        // strategy when filtered) — other instruments and unattributed trades
        // never shift the window
        const fromTime = earliestAttributedEntry(dbPath, { instrument: inst, strategyId });
        return json(res, 200, {
          ok: true,
          scoreboard: transportScoreboard(board),
          baselines: baselines(dbPath, inst, gran, { fromTime }),
          audit: decisionAudit(dbPath, { strategyId, limit: 50 }),
          axisExpectancy: axisExpectancy(dbPath, { instrument: inst, granularity: gran }),
        });
      }
      if (url.pathname === '/api/portfolio' || url.pathname === '/api/bot-trades') {
        // Bot-only mutations: these surfaces are strictly read-only (#22/#24).
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: `${url.pathname.slice(5)} is read-only over HTTP (bot-only trades)` });
        if (url.pathname === '/api/bot-trades') {
          const raw = Number(url.searchParams.get('limit'));
          const limit = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 500) : 50;
          return json(res, 200, { ok: true, trades: botTrades(dbPath, botConfig(readSettings(settingsPath)), limit) });
        }
        return json(res, 200, { ok: true, portfolio: portfolioView(dbPath, botConfig(readSettings(settingsPath))) });
      }
      if (url.pathname === '/api/threads' && req.method === 'GET') {
        const cfg = readSettings(settingsPath);
        const scope = resolveView(cfg, url.searchParams.get('instrument'), url.searchParams.get('granularity'));
        return json(res, 200, { ok: true, threads: listThreads(dbPath, scope) });
      }
      if (url.pathname === '/api/threads' && req.method === 'DELETE') {
        const id = Number(url.searchParams.get('id'));
        if (!Number.isInteger(id) || id < 1) return json(res, 400, { ok: false, error: 'id required' });
        deleteThread(dbPath, id);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/messages' && req.method === 'GET') {
        const id = Number(url.searchParams.get('thread'));
        if (!Number.isInteger(id) || id < 1) return json(res, 400, { ok: false, error: 'thread required' });
        return json(res, 200, { ok: true, messages: listMessages(dbPath, id) });
      }
      if (url.pathname === '/api/chat' && req.method === 'POST') {
        const body = await readJson(req, res);
        if (body === undefined) return;
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message || message.length > 4000) return json(res, 400, { ok: false, error: 'message required (max 4000 chars)' });
        const cfg = readSettings(settingsPath);
        if (resolveProvider(cfg) === 'none') {
          return json(res, 400, { ok: false, error: 'no chat provider: select a provider in settings (pi, anthropic, or openai) and add its API key ("none" disables chat)' });
        }

        const { instrument, granularity } = resolveView(cfg, body.instrument, body.granularity);
        const view = await chartData(dbPath, instrument, { granularity, fetcher: null });
        let notes = '';
        try { notes = readFileSync(cfg.notesFile || 'data/notes.md', 'utf8').slice(-1500); } catch { /* optional */ }
        const tz = typeof body.tz === 'string' && /^[A-Za-z0-9_/+-]{2,40}$/.test(body.tz) ? body.tz : 'UTC';
        const fmts = localTimeFormatters(tz);
        const localHm = fmts.hm;
        const localFull = fmts.full;
        const context = {
          view: { instrument, granularity, traderTimezone: fmts.tz, candleTimesAreLocal: true },
          quote: view.quote,
          viewCandles: view.candles.map((k) => ({ t: localHm(k.time), o: k.open, h: k.high, l: k.low, c: k.close, v: k.volume ?? null, partial: k.partial || undefined })),
          signal: view.signal ? { ...view.signal, time: localFull(view.signal.time) } : view.signal,
          signalHistory: view.signals.slice(0, 10).map((x) => ({ time: localFull(x.time), signal: x.signal, verdict: x.verdict, outcomePct: x.outcomePct })),
          traderNotes: notes,
          botPerformance: botPerformanceSummary(dbPath, botConfig(cfg).startingBalance),
          axisGate: axisSnapshot(view.candles, { instrument, granularity })?.axes ?? null,
          traderMemories: memoriesContext(dbPath) || undefined,
          // #58: the filter's effective rules text only (the gate the operator
          // tunes most, and the only one with a chat-draftable override) — kept
          // cheap; bot/chat prompts are surfaced in the settings gates section
          // instead of duplicated here in full.
          gatePrompts: { filter: (await resolveFilterSystem(dbPath)).system, note: 'the bot prompt is strategy-owned and the chat prompt is a constant — see settings > gates for both; only the filter is overridable here' },
        };

        let threadId = Number.isInteger(body.threadId) ? body.threadId : null;
        if (threadId != null) {
          const thread = chatDb(dbPath, (db) => db.prepare('SELECT id, instrument, granularity FROM chat_threads WHERE id=?').get(threadId));
          if (!thread) return json(res, 404, { ok: false, error: 'unknown thread' });
          // Legacy NULL-scoped threads continue from any view; stamped threads only from their own.
          if (thread.instrument != null && (thread.instrument !== instrument || thread.granularity !== granularity)) {
            return json(res, 409, { ok: false, error: `thread belongs to ${thread.instrument} ${thread.granularity}` });
          }
        }
        let createdThread = null;
        if (threadId == null) {
          threadId = chatDb(dbPath, (db) => db.prepare('INSERT INTO chat_threads (title, created_at, instrument, granularity) VALUES (?,?,?,?)')
            .run(message.slice(0, 60), new Date().toISOString(), instrument, granularity).lastInsertRowid);
          createdThread = { id: Number(threadId), title: message.slice(0, 60) };
        }
        addMessage(dbPath, threadId, 'user', message, JSON.stringify(context));

        const history = listMessages(dbPath, threadId).slice(-13, -1)
          .map((m) => `${m.role}: ${m.content}`).join('\n');
        const user = `context:\n${JSON.stringify(context)}\n\n${history ? `thread so far:\n${history}\n\n` : ''}question: ${message}`;

        // MS_DEBUG_LLM (#93): provider+model are known up front, so they ride as
        // headers before the stream starts; usage is only known once the
        // completion finishes, well after headers have flushed — the SSE
        // equivalent is a trailing {type:'usage'} event instead (asymmetric
        // with /api/recheck's four headers together, but SSE can't un-send
        // headers once written).
        const debugLlm = Boolean(process.env.MS_DEBUG_LLM);
        const chatProvider = resolveProvider(cfg);
        const sseHeaders = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' };
        if (debugLlm) {
          sseHeaders['X-LLM-Provider'] = chatProvider;
          sseHeaders['X-LLM-Model'] = effectiveModel(cfg, chatProvider) ?? 'n/a';
        }
        res.writeHead(200, sseHeaders);
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        if (createdThread) send({ type: 'thread', ...createdThread });
        try {
          const reply = await llmChat(cfg, chatSystemFor(cfg), user, {
            onDelta: (text) => send({ type: 'delta', text }),
            toolDefs: CHAT_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
            execTool: (n, i) => execChatTool(n, i, { dbPath, view: { instrument, granularity }, settings: cfg }),
            onUsage: debugLlm ? (info) => send({ type: 'usage', provider: info.provider, model: info.model, inputTokens: info.usage?.inputTokens ?? null, outputTokens: info.usage?.outputTokens ?? null }) : undefined,
          });
          const { text: cleanReply, title } = extractThreadTitle(reply);
          addMessage(dbPath, threadId, 'assistant', cleanReply);
          if (title) {
            const changed = chatDb(dbPath, (db) => db.prepare('UPDATE chat_threads SET title=? WHERE id=? AND title<>?').run(title, threadId, title).changes);
            if (changed > 0) send({ type: 'title', threadId: Number(threadId), title });
          }
          send({ type: 'done', threadId: Number(threadId), reply: cleanReply });
        } catch (err) {
          addMessage(dbPath, threadId, 'error', err.message);
          send({ type: 'error', threadId: Number(threadId), error: err.message });
        }
        return res.end();
      }
      if (url.pathname.startsWith('/vendor/')) {
        if (serveVendor(res, url.pathname.slice('/vendor/'.length))) return;
        return json(res, 404, { ok: false, error: 'unknown vendor asset' });
      }
      if (url.pathname === '/') {
        return servePage(res);
      }
      return json(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  });
}

// The dashboard page (canvas chart + supertrend/marker, verdict panel, signal
// history, settings/modals, chat) lives in vendor/app.html and is served by
// servePage() above. It loads only same-origin vendored assets (Chart.js under
// /vendor/), no CDN. (#128: moved out of an inline template literal here.)

function parseArgs(argv) {
  const out = { port: null, db: 'data/candles.db', settings: 'data/settings.json' };
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (!(m[1] in out)) throw new Error(`unknown flag --${m[1]} (run --help)`);
    const value = m[2] ?? argv[++i];
    if (value === undefined) throw new Error(`--${m[1]} requires a value`);
    if (m[1] === 'port' && !/^\d+$/.test(value)) throw new Error(`invalid --port "${value}"`);
    out[m[1]] = m[1] === 'port' ? Number.parseInt(value, 10) : value;
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) return process.stdout.write(USAGE);
  const opts = parseArgs(argv);
  const settingsPort = Number(readSettings(opts.settings).port);
  const port = opts.port ?? (Number.isInteger(settingsPort) && settingsPort > 0 ? settingsPort : 8787);
  const server = buildServer({ dbPath: opts.db, settingsPath: opts.settings });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`signal-server listening on http://127.0.0.1:${port}\n`);
  });
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`signal-server error: ${err.message}\n`);
    process.exitCode = 1;
  }
}
