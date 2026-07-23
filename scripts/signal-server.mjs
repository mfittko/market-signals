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
import { computeSupertrend, detectFlips, fetchCandles, granularityMs, llmChat, localTimeFormatters, readSettings, recordSignal, resolveProvider, signalOutcomes, storeCandles, withDb } from './supertrend.mjs';
import { botConfig, botTrades, instrumentLeverage, portfolioView } from './portfolio.mjs';
import { activateStrategy, activeStrategy, ensureSeedStrategy, listStrategies, saveStrategy, strategyById } from './strategies.mjs';
import { normCombo, performHaltReset, resolveBotFor } from './bot.mjs';
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
const SETTINGS_KEYS = ['provider', 'model', 'notesFile', 'piBin', 'notifierBin', 'port', 'instrument', 'instruments', 'granularity', 'watchers', 'freshBars', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'bot', 'snapshotContext', 'ind'];
const BOT_SETTING_KEYS = ['enabled', 'riskPct', 'maxPositions', 'reviewTriggerPct', 'killSwitchDrawdownPct', 'resetHalt', 'watchers', 'leverage', 'bots'];
const PER_BOT_KEYS = ['enabled', 'strategyId', 'riskPct', 'killSwitchDrawdownPct', 'allocationPct'];
const SECRET_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
const MASK = '•••';

export function maskedSettings(settingsPath) {
  const s = readSettings(settingsPath);
  const out = { activeProvider: resolveProvider(s) };
  for (const k of SETTINGS_KEYS) {
    if (s[k] === undefined) continue;
    out[k] = SECRET_KEYS.includes(k) ? MASK : s[k];
  }
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
    } else next[k] = v;
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
    description: 'Save a DRAFT trading strategy (new version each save; append-only). Drafts NEVER trade: activation is a human act in the settings UI. Use when the trader asks to draft or iterate a bot strategy conversationally.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'kebab-case identifier' }, prompt: { type: 'string', description: 'the strategy prompt text (20-4000 chars)' }, instruments: { type: 'string', description: 'optional combo CSV, e.g. "WTICO/USD|M5"' } }, required: ['name', 'prompt'], additionalProperties: false },
    run: (a, ctx) => {
      if (!ctx?.dbPath) throw new Error('save_strategy needs a db context');
      const saved = saveStrategy(ctx.dbPath, { name: a?.name, prompt: a?.prompt, instruments: a?.instruments ?? null, createdBy: 'chat' });
      return JSON.stringify({ ...saved, note: 'draft saved — NOT active; the trader activates strategies in settings' });
    },
  },
];
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

const CHAT_SYSTEM = `You are the trading copilot embedded in the market-signals local dashboard of a leveraged CFD trader. Each question carries a JSON context block: the currently viewed instrument/granularity, its quote, recent candles, the latest signal with verdict and realized outcomes, recent signal history, the trader's notes, and (once the bot has traded) a botPerformance summary per strategy — use it to answer "why is the bot up/down" questions; an axisGate block groups indicator evidence into five independent axes (trend-strength ADX, direction/regime, impulse, VWAP location, RSI exhaustion) — cite axis verdicts rather than re-deriving indicators; prior thread messages may precede the question. All timestamps in the context are ALREADY in the trader's local timezone (view.traderTimezone), matching the chart axis — quote them as-is, never convert, never mention UTC. Be brief: default to 2-5 sentences or a few tight bullets with concrete levels — no headers, no recap of the question, no closing offers unless something genuinely warrants a follow-up. Expand only when explicitly asked. You provide analysis, never order execution. When tools are available, use them to expand context before speculating: fxempire_articles for recent market news, truthsocial_posts for market-moving Trump posts, live_rates for current cross-instrument rates, and web search for anything else time-sensitive. Prefer the provided context; fetch only what is missing. End EVERY reply with a final line of exactly: <!--title: <max 48 chars summarizing this whole thread>--> — it is stripped before display and keeps the thread list meaningful.`;

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

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
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
        // per-combo bot state for the header icon (#49 design: dot=combo, ring=global halt)
        const botFor = resolveBotFor(cfg, instrument, granularity, dbPath);
        const pfB = portfolioView(dbPath, botConfig(cfg));
        const strat = botFor.strategyId != null ? strategyById(dbPath, botFor.strategyId) : null;
        const pos = pfB.positions.find((pp) => pp.instrument === instrument) ?? null;
        data.botState = {
          configured: botFor.configured === true,
          enabled: botFor.enabled,
          strategyName: strat ? `${strat.name} v${strat.version}` : null,
          halted: pfB.halted,
          openPosition: pos ? { side: pos.side, unrealized: Math.round(pos.unrealized * 100) / 100 } : null,
        };
        const configured = (cfg.instruments ?? '').split(',').map((x) => x.trim()).filter(Boolean);
        data.instruments = configured.length ? configured : DEFAULT_INSTRUMENTS;
        if (!data.instruments.includes(instrument)) data.instruments = [instrument, ...data.instruments];
        data.watchers = (cfg.watchers ?? '').split(',').map((x) => x.trim()).filter(Boolean);
        data.watched = data.watchers.includes(`${instrument}|${granularity}`);
        return json(res, 200, data);
      }
      if (url.pathname === '/api/settings' && req.method === 'GET') {
        return json(res, 200, maskedSettings(settingsPath));
      }
      if (url.pathname === '/api/settings' && req.method === 'POST') {
        const raw = await readBody(req, res);
        if (raw === null) return;
        let patch;
        try { patch = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
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
          const strat = Number.isInteger(b.strategyId) ? strategyById(dbPath, b.strategyId) : null;
          const attributed = comboAgg.get(`${inst}|${gran}`) ?? { c: 0, r: 0 };
          const orphan = botsPerInstrument.get(inst) === 1 ? (soloUnattributed.get(inst) ?? { c: 0, r: 0 }) : { c: 0, r: 0 };
          const agg = { c: attributed.c + orphan.c, r: attributed.r + orphan.r };
          const lastDecision = audit.find((a) => a.instrument === inst && (a.granularity == null || a.granularity === gran));
          return {
            combo: `${inst}|${gran}`, instrument: inst, granularity: gran,
            enabled: b.enabled === true,
            strategyId: b.strategyId ?? null,
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
        return json(res, 200, { ok: true, strategies: listStrategies(dbPath), activeId: activeStrategy(dbPath)?.id ?? null });
      }
      if (url.pathname === '/api/strategies/activate' && req.method === 'POST') {
        const raw = await readBody(req, res);
        if (raw === null) return;
        let body;
        try { body = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
        const id = Number(body.id);
        if (!Number.isInteger(id) || id < 1) return json(res, 400, { ok: false, error: 'id required' });
        try { activateStrategy(dbPath, id); } catch (err) { return json(res, 400, { ok: false, error: err.message }); }
        return json(res, 200, { ok: true, activeId: id });
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
        const raw = await readBody(req, res);
        if (raw === null) return;
        let body;
        try { body = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message || message.length > 4000) return json(res, 400, { ok: false, error: 'message required (max 4000 chars)' });
        const cfg = readSettings(settingsPath);
        if (resolveProvider(cfg) === 'none') {
          return json(res, 400, { ok: false, error: 'no chat provider: set provider to "pi", or leave it on auto and add an ANTHROPIC/OPENAI API key ("none" disables chat)' });
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

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        if (createdThread) send({ type: 'thread', ...createdThread });
        try {
          const reply = await llmChat(cfg, CHAT_SYSTEM, user, { onDelta: (text) => send({ type: 'delta', text }), toolDefs: CHAT_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })), execTool: (n, i) => execChatTool(n, i, { dbPath }) });
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
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(PAGE);
      }
      return json(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  });
}

// Single self-contained page: canvas candle chart + supertrend + signal marker,
// verdict panel, signal history, and the settings form. No external assets.
const PAGE = /* html */ `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>market-signals</title>
<script src="/vendor/chart.umd.js"></script>
<script src="/vendor/chartjs-adapter-date-fns.bundle.min.js"></script>
<script src="/vendor/chartjs-chart-financial.min.js"></script>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0d1117; color: #e6edf3; font: 14px/1.5 -apple-system, sans-serif; }
  #app { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 0; min-height: 100vh; }
  main { padding: 16px; min-width: 0; }
  aside { border-left: 1px solid #30363d; display: flex; flex-direction: column; height: 100vh; position: sticky; top: 0; }
  #threadBar { display: flex; gap: 6px; align-items: center; padding: 8px; border-bottom: 1px solid #21262d; flex-wrap: wrap; }
  #threadBar button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 5px; padding: 3px 9px; cursor: pointer; font-size: 12px; }
  #threadBar select { flex: 1; min-width: 0; background: #010409; color: #e6edf3; border: 1px solid #30363d; border-radius: 5px; padding: 4px 6px; font-size: 12px; }
  #threadBar button:disabled { opacity: 0.4; cursor: default; }
  #msgs { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .msg { border-radius: 8px; padding: 7px 10px; font-size: 13px; white-space: pre-wrap; word-break: break-word; max-width: 95%; }
  .msg.user { background: #1f6feb22; border: 1px solid #1f6feb55; align-self: flex-end; }
  .msg.assistant { background: #161b22; border: 1px solid #30363d; align-self: flex-start; }
  .msg.error { background: #f8514922; border: 1px solid #f8514955; align-self: flex-start; }
  .msg code { background: #010409; border: 1px solid #21262d; border-radius: 3px; padding: 0 4px; font-size: 12px; }
  .msg pre { background: #010409; border: 1px solid #21262d; border-radius: 5px; padding: 8px; overflow-x: auto; margin: 6px 0; }
  .msg table { margin: 6px 0; font-size: 12px; } .msg td { padding: 2px 8px; border-bottom: 1px solid #21262d; }
  #chatForm { display: flex; gap: 6px; padding: 10px; border-top: 1px solid #21262d; }
  #chatForm input { flex: 1; }
  #chatForm button { background: #238636; color: #fff; border: 0; border-radius: 5px; padding: 6px 14px; cursor: pointer; }
  @media (max-width: 900px) {
    #app { grid-template-columns: 1fr; }
    aside { position: static; height: auto; border-left: 0; border-top: 1px solid #30363d; }
    #msgs { max-height: 45vh; min-height: 120px; }
    #wrap { height: 320px !important; }
    #cfgbtn { float: none; display: inline-block; margin-top: 6px; }
    table { display: block; overflow-x: auto; white-space: nowrap; }
  }
  h1 { font-size: 16px; } h2 { font-size: 14px; margin: 20px 0 8px; }
  #pf { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 6px 10px; margin: 10px 0; }
  #pf summary { cursor: pointer; display: flex; gap: 14px; align-items: center; flex-wrap: wrap; font-size: 13px; }
  #pf summary button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 5px; padding: 2px 8px; cursor: pointer; font-size: 12px; }
  #pfChips b, #pfChips span { margin-right: 12px; }
  #pfSpark { max-width: 100%; height: 46px; display: block; }
  .pfcard { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 8px 10px; margin: 6px 0; font-size: 13px; }
  .pfcard .why { color: #8b949e; font-size: 12px; margin-top: 4px; }
  #pfdlg { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px; min-width: min(640px, 92vw); max-height: 85vh; overflow-y: auto; }
  .halted { color: #f85149; font-weight: 600; } .active { color: #3fb950; font-weight: 600; }
  #pfTabs { display: flex; gap: 6px; margin: 10px 0; }
  #pfTabs button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 5px; padding: 4px 12px; cursor: pointer; font-size: 12px; }
  #pfTabs button.on { background: #1f6feb33; border-color: #1f6feb; }
  #botBtn { position: relative; }
  #botBtn.nobot { opacity: 0.45; }
  #botBtn::after { content: ''; position: absolute; right: 1px; top: 1px; width: 8px; height: 8px; border-radius: 50%; display: none; }
  #botBtn.dot-grey::after { display: block; background: #8b949e; }
  #botBtn.dot-green::after { display: block; background: #3fb950; }
  #botBtn.dot-amber::after { display: block; background: #d29922; }
  #botBtn.ring-halt { box-shadow: 0 0 0 2px #f85149; border-radius: 6px; }
  #haltBanner { background: #f8514922; border: 1px solid #f85149; border-radius: 6px; padding: 8px 12px; margin-bottom: 10px; color: #f85149; font-weight: 600; }
  #botdlg { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px; width: min(360px, 92vw); }
  #botdlg label { display: block; margin: 8px 0 2px; color: #8b949e; font-size: 12px; }
  #botdlg select, #botdlg input[type=number] { width: 100%; }
  .botwarn { color: #d29922; font-size: 12px; }
  .botrow { display: flex; justify-content: space-between; align-items: center; gap: 10px; border: 1px solid #30363d; border-radius: 6px; padding: 7px 10px; margin: 6px 0; font-size: 13px; flex-wrap: wrap; }
  .botrow .jump { cursor: pointer; background: #21262d; border: 1px solid #30363d; border-radius: 5px; color: #e6edf3; padding: 2px 10px; }
  .audit-entry { border-left: 2px solid #30363d; padding: 4px 10px; margin: 6px 0; font-size: 12px; }
  .audit-entry .meta { color: #8b949e; }
  #indbar { display: flex; gap: 12px; margin: 6px 0; font-size: 12px; color: #8b949e; flex-wrap: wrap; }
  #indbar label { cursor: pointer; }
  #oscwrap { background: #010409; border: 1px solid #30363d; border-radius: 6px; padding: 4px; margin-top: 6px; }
  #wrap { background: #010409; border: 1px solid #30363d; border-radius: 6px; padding: 6px; }
  .verdict { padding: 10px 12px; border: 1px solid #30363d; border-radius: 6px; margin: 10px 0; }
  .buy { color: #3fb950; } .sell { color: #f85149; }
  table { border-collapse: collapse; width: 100%; } td, th { padding: 4px 8px; text-align: left; border-bottom: 1px solid #21262d; }
  tr { cursor: pointer; } tr:hover { background: #161b22; }
  form { display: grid; grid-template-columns: 140px 1fr; gap: 6px 10px; max-width: 520px; }
  input, select { background: #010409; color: #e6edf3; border: 1px solid #30363d; border-radius: 4px; padding: 4px 6px; }
  button { grid-column: 2; justify-self: start; padding: 5px 14px; background: #238636; color: #fff; border: 0; border-radius: 4px; cursor: pointer; }
  #saved { color: #3fb950; margin-left: 8px; }
  #watchBtn { background: none; border: 1px solid #30363d; border-radius: 6px; padding: 3px 9px; cursor: pointer; font-size: 15px; }
  #cfgbtn { float: right; background: #21262d; color: #e6edf3; border: 1px solid #30363d;
            border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 13px; }
  dialog { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px;
           padding: 18px 20px; min-width: 420px; }
  dialog::backdrop { background: rgba(1, 4, 9, 0.7); }
  dialog h2 { margin-top: 0; }
  .dlg-close { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 4px;
               padding: 5px 14px; cursor: pointer; }
  #wrap { position: relative; }
  .quote { display: flex; gap: 22px; flex-wrap: wrap; padding: 8px 14px; border: 1px solid #30363d;
           border-radius: 6px; margin: 10px 0 0; }
  .quote small { display: block; color: #8b949e; font-size: 11px; }
  .quote b { font-size: 15px; }
  #tip { position: absolute; display: none; background: #161b22; border: 1px solid #30363d;
         border-radius: 6px; padding: 6px 9px; font-size: 12px; line-height: 1.45;
         pointer-events: none; white-space: nowrap; z-index: 2; }
</style></head><body><div id="app"><main>
<h1>market-signals — <select id="instSel"></select> <select id="granSel"></select> <button id="watchBtn" type="button" title="toggle alerts for this instrument/granularity">🔕</button> <button id="botBtn" type="button" title="bot for this view">🤖</button> <button id="pfBtn" type="button">💼 portfolio</button> <button id="cfgbtn" type="button">⚙ settings</button></h1>
<div id="indbar"></div>
<div id="wrap" style="height:460px"><canvas id="chart"></canvas></div>
<div id="oscwrap" hidden style="height: 110px"><canvas id="osc"></canvas></div>
<div class="quote" id="quote" hidden></div>
<div id="axischips" class="quote" hidden></div>
<details id="pf" hidden>
  <summary><span id="pfChips">portfolio</span> <button id="pfOpen" type="button">details</button></summary>
  <canvas id="pfSpark" width="560" height="46"></canvas>
</details>
<dialog id="pfdlg">
  <h2>virtual portfolio <small>(bot-only — view)</small></h2>
  <div id="pfHead"></div>
  <div id="haltBanner" hidden></div>
  <div id="pfTabs">
    <button data-tab="overview" class="on">overview</button><button data-tab="trades">trades</button><button data-tab="performance">performance</button><button data-tab="audit">audit</button>
  </div>
  <div id="tab-overview">
    <div id="pfPositions"></div>
    <h2>activated bots</h2>
    <div id="botList"></div>
  </div>
  <div id="tab-trades" hidden>
    <table id="pfTrades"><thead><tr><th>closed</th><th>instrument</th><th>side</th><th>P&amp;L</th><th>reason</th></tr></thead><tbody></tbody></table>
  </div>
  <div id="tab-performance" hidden></div>
  <div id="tab-audit" hidden></div>
  <form method="dialog"><button>close</button></form>
</dialog>
<dialog id="botdlg">
  <h2 id="botTitle">🤖 bot</h2>
  <div id="botBody"></div>
</dialog>
<div class="verdict" id="verdict">loading…</div>
<dialog id="cfgdlg">
<h2>Watcher &amp; filter settings</h2>
<form id="cfg"></form>
<p><button type="button" class="dlg-close" onclick="document.getElementById('cfgdlg').close()">Close</button></p>
</dialog>
<h2>Signal history (30-min outcomes)</h2>
<table id="hist"><thead><tr><th>time</th><th>signal</th><th>price</th><th>verdict</th><th>reason</th><th>outcome</th></tr></thead><tbody></tbody></table>
</main>
<aside>
  <div id="threadBar"><button id="newThread">+ new</button></div>
  <div id="msgs"></div>
  <form id="chatForm"><input id="chatMsg" placeholder="quick check about the current view…" autocomplete="off"><button>Ask</button></form>
</aside>
</div>
<script>
const qs = new URLSearchParams(location.search);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const INDICATORS = [['ema', 'EMA 20/50/200'], ['bb', 'Bollinger'], ['vwap', 'VWAP'], ['rsi', 'RSI'], ['macd', 'MACD']];
function indBar(d) {
  const on = new Set(d.activeInd || []);
  document.getElementById('indbar').innerHTML = 'indicators: ' + INDICATORS.map(([k, label]) =>
    '<label><input type="checkbox" data-ind="' + k + '"' + (on.has(k) ? ' checked' : '') + '> ' + esc(label) + '</label>').join('');
  document.getElementById('indbar').onchange = async () => {
    const next = [...document.querySelectorAll('#indbar input:checked')].map(el => el.dataset.ind);
    // persisted globally (#49): every view opens with this selection
    await fetch('/api/settings', { method: 'POST', body: JSON.stringify({ ind: next.join(',') || null }) });
    if (next.length) qs.set('ind', next.join(',')); else qs.delete('ind');
    location.search = '?' + qs.toString();
  };
}
async function load() {
  const p = new URLSearchParams();
  if (qs.get('instrument')) p.set('instrument', qs.get('instrument'));
  if (qs.get('t')) p.set('t', qs.get('t'));
  if (qs.get('granularity')) p.set('granularity', qs.get('granularity'));
  if (qs.get('ind')) p.set('ind', qs.get('ind'));
  const d = await (await fetch('/api/chart?' + p)).json();
  selectors(d);
  draw(d); quoteStrip(d.quote); verdict(d.signal); history(d.signals);
  indBar(d); axisChips(d.axisGate); oscPanel(d); botIcon(d.botState);
  portfolio().catch(() => { document.getElementById('pf').hidden = true; });
}
const money = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
const pnlCls = (v) => v >= 0 ? 'buy' : 'sell';
async function portfolio() {
  const r = await (await fetch('/api/portfolio')).json();
  if (!r.ok) return;
  const pf = r.portfolio;
  const el = document.getElementById('pf');
  const hasActivity = pf.positions.length || pf.trades.length || pf.equity !== pf.startingBalance;
  el.hidden = !hasActivity; // chips are noise on a fresh portfolio; the MODAL is always reachable via the header button
  if (hasActivity) {
  const realized = pf.trades.reduce((a, t) => a + t.realized, 0);
  const today = new Date().toDateString();
  const dayPnl = pf.trades.filter(t => new Date(t.close_time).toDateString() === today).reduce((a, t) => a + t.realized, 0) + pf.unrealized;
  const status = pf.halted ? '<span class="halted">halted</span>' : '<span class="active">active</span>';
  document.getElementById('pfChips').innerHTML =
    '<b>equity ' + esc(pf.equity.toFixed(2)) + '</b>' +
    '<span>cash ' + esc(pf.cash.toFixed(2)) + '</span>' +
    '<span class="' + pnlCls(realized + pf.unrealized) + '">P&L ' + esc(money(realized + pf.unrealized)) + '</span>' +
    '<span class="' + pnlCls(dayPnl) + '">day ' + esc(money(dayPnl)) + '</span>' +
    '<span>' + pf.positions.length + ' pos</span>' + status;
  sparkline(pf);
  }
  document.getElementById('pfHead').innerHTML =
    '<b>equity ' + esc(pf.equity.toFixed(2)) + '</b> · cash ' + esc(pf.cash.toFixed(2)) +
    ' · margin ' + esc(pf.marginLocked.toFixed(2)) +
    ' · unrealized <span class="' + pnlCls(pf.unrealized) + '">' + esc(money(pf.unrealized)) + '</span> · ' + status;
  document.getElementById('pfPositions').innerHTML = pf.positions.map(p => {
    const age = Math.round((Date.now() - Date.parse(p.entry_time)) / 60000);
    const stopD = p.stop != null ? ' · stop ' + esc(p.stop) + ' (' + esc((Math.abs(p.last_mark - p.stop) / p.last_mark * 100).toFixed(2)) + '%)' : '';
    const tgtD = p.target != null ? ' · target ' + esc(p.target) + ' (' + esc((Math.abs(p.target - p.last_mark) / p.last_mark * 100).toFixed(2)) + '%)' : '';
    return '<div class="pfcard"><b>' + esc(p.instrument) + '</b> <span class="' + (p.side === 'long' ? 'buy' : 'sell') + '">' + esc(p.side) + '</span>' +
      ' ' + esc(p.notional) + ' @ ' + esc(p.entry_price.toFixed(3)) + ' → mark ' + esc(p.last_mark) + (p.stale ? ' (stale)' : '') +
      ' <span class="' + pnlCls(p.unrealized) + '">' + esc(money(p.unrealized)) + '</span>' + stopD + tgtD + ' · ' + age + 'm' +
      (p.reason ? '<div class="why">' + md(p.reason) + '</div>' : '') +
      '</div>';
  }).join('') || '<div class="pfcard">' + (hasActivity ? 'no open positions' : 'no bot activity yet — click \ud83e\udd16 in the header to configure a bot for a view and assign a strategy') + '</div>';
  const tb = document.querySelector('#pfTrades tbody');
  tb.innerHTML = '';
  for (const t of pf.trades) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.onclick = () => { location.search = '?' + new URLSearchParams({ instrument: t.instrument, granularity: qs.get('granularity') || 'M5', t: t.entry_time }); };
    tr.innerHTML = '<td>' + esc(localFull(t.close_time)) + '</td><td>' + esc(t.instrument) + '</td><td class="' + (t.side === 'long' ? 'buy' : 'sell') + '">' + esc(t.side) +
      '</td><td class="' + pnlCls(t.realized) + '">' + esc(money(t.realized)) + '</td><td>' + esc(t.close_reason) + '</td>';
    tb.appendChild(tr);
  }
}
function sparkline(pf) {
  const c = document.getElementById('pfSpark');
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  // trades arrive newest-first; the curve runs oldest → newest realized equity
  const pts = pf.trades.slice().reverse().reduce((acc, t) => { acc.push(acc[acc.length - 1] + t.realized); return acc; }, [pf.startingBalance]);
  if (pts.length < 2) pts.push(pts[0]);
  const min = Math.min(...pts), max = Math.max(...pts), span = (max - min) || 1;
  g.strokeStyle = pts[pts.length - 1] >= pts[0] ? '#3fb950' : '#f85149';
  g.lineWidth = 1.5;
  g.beginPath();
  pts.forEach((v, i) => {
    const x = (i / (pts.length - 1)) * (c.width - 8) + 4;
    const y = c.height - 6 - ((v - min) / span) * (c.height - 12);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.stroke();
}
document.getElementById('pfOpen').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); document.getElementById('pfdlg').showModal(); renderOverviewBots(); });
document.getElementById('pfBtn').addEventListener('click', () => { document.getElementById('pfdlg').showModal(); renderOverviewBots(); });
// Contextual per-combo bot modal + read-only overview (#49 design grill).
let botStateCache = null;
function botIcon(bs) {
  botStateCache = bs;
  const el = document.getElementById('botBtn');
  el.className = '';
  const combo = (qs.get('instrument') || '') + '·' + (qs.get('granularity') || 'M5');
  if (!bs || !bs.configured) { el.classList.add('nobot'); el.title = 'no bot for ' + combo + ' — click to configure'; }
  else if (bs.enabled && !bs.strategyName) { el.classList.add('dot-amber'); el.title = 'bot enabled — no strategy, will not trade'; }
  else if (bs.enabled) { el.classList.add('dot-green'); el.title = 'armed — ' + bs.strategyName + (bs.openPosition ? ' · ' + bs.openPosition.side + ' ' + money(bs.openPosition.unrealized) : ''); }
  else { el.classList.add('dot-grey'); el.title = 'bot configured (off)'; }
  if (bs && bs.halted) { el.classList.add('ring-halt'); el.title += ' · PORTFOLIO halted — all bots paused'; }
}
async function openBotModal() {
  const inst = qs.get('instrument') || document.getElementById('instSel').value;
  const gran = qs.get('granularity') || document.getElementById('granSel').value || 'M5';
  const combo = inst + '|' + gran;
  const [settings, strat] = await Promise.all([
    (await fetch('/api/settings')).json(),
    (await fetch('/api/strategies')).json(),
  ]);
  const entry = ((settings.bot || {}).bots || {})[combo] || {};
  document.getElementById('botTitle').textContent = '🤖 bot — ' + inst + ' · ' + gran;
  const noStrat = !strat.strategies.length;
  document.getElementById('botBody').innerHTML =
    '<label for="bmStrat">strategy</label><select id="bmStrat"><option value="">— none —</option>' +
    strat.strategies.map(st => '<option value="' + st.id + '"' + (st.id === entry.strategyId ? ' selected' : '') + '>' + esc(st.name) + ' v' + st.version + '</option>').join('') + '</select>' +
    (noStrat ? '<div class="botwarn">No strategies yet — draft one with the copilot, then assign it here.</div>' : '') +
    '<label for="bmEnabled">enabled</label><input type="checkbox" id="bmEnabled"' + (entry.enabled ? ' checked' : '') + '>' +
    '<span id="bmWarn" class="botwarn"' + (entry.enabled && !entry.strategyId ? '' : ' hidden') + '> won\u2019t trade until a strategy is assigned</span>' +
    '<label for="bmRisk">risk % / trade (margin per trade as % of equity)</label><input type="number" step="0.1" id="bmRisk" value="' + esc(entry.riskPct ?? '') + '" placeholder="default">' +
    '<label for="bmAlloc">allocation % of equity (max total margin locked in ' + esc(inst) + ' — shared by all granularities, like leverage)</label><input type="number" step="1" id="bmAlloc" value="' + esc(entry.allocationPct ?? '') + '" placeholder="uncapped">' +
    '<label for="bmLev">leverage (per instrument — shared by all granularities of ' + esc(inst) + ')</label><input type="number" step="1" id="bmLev" value="' + esc((settings.bot && settings.bot.leverage && settings.bot.leverage[inst]) ?? '') + '" placeholder="default 10×, cap 20×">' +
    '<details><summary>advanced</summary><label for="bmKill">kill-switch DD % (threshold feeding the single GLOBAL portfolio halt — bots cannot halt individually)</label>' +
    '<input type="number" step="1" id="bmKill" value="' + esc(entry.killSwitchDrawdownPct ?? '') + '" placeholder="global default"></details>' +
    '<div id="bmStatus"><small>' + (botStateCache?.halted ? '<span class="halted">portfolio halted — bot paused (reset in portfolio)</span>' : botStateCache?.openPosition ? '\u25CF ' + esc(botStateCache.openPosition.side) + ' open ' + esc(money(botStateCache.openPosition.unrealized)) : '') + '</small></div>' +
    '<p><button type="button" id="bmToPf">View in portfolio \u2192</button> <span id="bmSaved"></span> <button type="button" id="bmRemove" style="float:right;color:#f85149;background:none;border:none;cursor:pointer">remove bot</button></p>' +
    '<form method="dialog"><button>close</button></form>';
  const save = async (patch) => {
    const r = await (await fetch('/api/settings', { method: 'POST', body: JSON.stringify({ bot: { bots: { [combo]: patch } } }) })).json();
    document.getElementById('bmSaved').textContent = r.error ? r.error : 'saved';
    const d2 = await (await fetch('/api/chart?' + new URLSearchParams({ instrument: inst, granularity: gran }))).json();
    botIcon(d2.botState);
    document.getElementById('bmWarn').hidden = !(document.getElementById('bmEnabled').checked && !document.getElementById('bmStrat').value);
  };
  document.getElementById('bmStrat').onchange = (e) => save({ strategyId: e.target.value ? Number(e.target.value) : null });
  document.getElementById('bmEnabled').onchange = (e) => save({ enabled: e.target.checked });
  document.getElementById('bmRisk').onchange = (e) => save({ riskPct: Number(e.target.value) > 0 ? Number(e.target.value) : null });
  document.getElementById('bmAlloc').onchange = (e) => save({ allocationPct: Number(e.target.value) > 0 ? Number(e.target.value) : null });
  document.getElementById('bmLev').onchange = async (e) => {
    const v = Number(e.target.value) > 0 ? Number(e.target.value) : null;
    const r = await (await fetch('/api/settings', { method: 'POST', body: JSON.stringify({ bot: { leverage: { [inst]: v } } }) })).json();
    document.getElementById('bmSaved').textContent = r.error ? r.error : 'saved';
  };
  document.getElementById('bmKill').onchange = (e) => save({ killSwitchDrawdownPct: Number(e.target.value) > 0 ? Number(e.target.value) : null });
  document.getElementById('bmToPf').onclick = () => { document.getElementById('botdlg').close(); document.getElementById('pfdlg').showModal(); renderOverviewBots(); };
  document.getElementById('bmRemove').onclick = async () => { await save(null); document.getElementById('botdlg').close(); };
  document.getElementById('botdlg').showModal();
}
document.getElementById('botBtn').addEventListener('click', openBotModal);
// Read-only activated-bots list + halt banner in the portfolio overview.
async function renderOverviewBots() {
  const r = await (await fetch('/api/bots')).json();
  if (!r.ok) return;
  const banner = document.getElementById('haltBanner');
  banner.hidden = !r.halted;
  if (r.halted) {
    banner.innerHTML = 'PORTFOLIO HALTED — kill-switch drawdown tripped; all bots paused. <button id="haltReset" type="button">reset halt</button>';
    banner.querySelector('#haltReset').onclick = async () => {
      await fetch('/api/settings', { method: 'POST', body: JSON.stringify({ bot: { resetHalt: true } }) });
      renderOverviewBots(); portfolio();
    };
  }
  const list = document.getElementById('botList');
  const active = r.bots.filter(b => b.enabled);
  const off = r.bots.filter(b => !b.enabled);
  const row = (b) => '<div class="botrow"><span><b>' + esc(b.combo) + '</b> · ' +
    (b.strategyName ? esc(b.strategyName) : '<span class="botwarn">— none — won\u2019t trade</span>') + '</span>' +
    '<span>' + (b.enabled ? '<span class="active">on</span>' : 'off') + ' · ' + b.trades + ' trades · <span class="' + pnlCls(b.realized) + '">' + esc(money(b.realized)) + '</span>' +
    (b.lastDecisionAt ? ' · last ' + esc(localFull(b.lastDecisionAt)) : '') + '</span>' +
    '<button class="jump" data-combo="' + esc(b.combo) + '">\u2192</button></div>';
  list.innerHTML = (active.map(row).join('') || '<div class="pfcard">No bots yet. Open a chart for an instrument, then click \ud83e\udd16 in the header to configure a bot for that view.</div>') +
    (off.length ? '<details><summary><small>configured (off): ' + off.length + '</small></summary>' + off.map(row).join('') + '</details>' : '');
  list.onclick = (e) => {
    const combo = e.target.dataset?.combo;
    if (!combo) return;
    const [i2, g2] = combo.split('|');
    location.search = '?' + new URLSearchParams({ instrument: i2, granularity: g2, bot: '1' });
  };
}
document.getElementById('pfTabs').addEventListener('click', async (e) => {
  const tab = e.target.dataset?.tab;
  if (!tab) return;
  for (const b of document.querySelectorAll('#pfTabs button')) b.classList.toggle('on', b === e.target);
  for (const name of ['overview', 'trades', 'performance', 'audit']) document.getElementById('tab-' + name).hidden = name !== tab;
  if (tab === 'overview') renderOverviewBots();
  if (tab === 'performance' || tab === 'audit') renderEvaluation().catch(() => { document.getElementById('tab-' + tab).innerHTML = '<p><small>evaluation unavailable</small></p>'; });
});
async function renderEvaluation() {
  const evalParams = new URLSearchParams({ instrument: qs.get('instrument') || '', granularity: qs.get('granularity') || '' });
  if (qs.get('strategy')) evalParams.set('strategy', qs.get('strategy'));
  const r = await (await fetch('/api/evaluation?' + evalParams)).json();
  if (!r.ok) return;
  const perf = document.getElementById('tab-performance');
  const rowsHtml = r.scoreboard.map(s =>
    '<tr><td>' + esc(s.strategyName ?? (s.strategyVersion ? 'hash ' + s.strategyVersion : 'unattributed')) + (s.strategyDbVersion ? ' v' + esc(s.strategyDbVersion) : '') + '</td><td>' + s.trades +
    '</td><td>' + esc(s.winRatePct ?? '—') + '%</td><td class="' + pnlCls(s.totalRealized) + '">' + esc(money(s.totalRealized)) +
    '</td><td>' + esc(s.profitFactor == null ? '—' : (s.profitFactor === 'inf' ? '∞' : Number(s.profitFactor).toFixed(2))) + '</td><td>' + esc(s.maxDrawdownPct) + '%</td></tr>').join('');
  const b = r.baselines;
  perf.innerHTML = '<table><thead><tr><th>strategy</th><th>trades</th><th>win rate</th><th>realized</th><th>PF</th><th>max DD</th></tr></thead><tbody>' + (rowsHtml || '<tr><td colspan="6">no attributed trades yet</td></tr>') + '</tbody></table>' +
    (b ? '<p><small>baselines over ' + esc(b.window.candles) + ' candles: flip-following ' + esc(b.flipFollowing.winRatePct ?? '—') + '% win / ' + esc(b.flipFollowing.totalReturnPct ?? '—') + '% return (' + esc(b.flipFollowing.trades ?? 0) + ' trades) · buy&hold ' + esc(b.buyAndHold.totalReturnPct) + '%</small></p>' : '');
  document.getElementById('tab-audit').innerHTML = r.audit.map(a =>
    '<div class="audit-entry"><div class="meta">' + esc(localFull(a.at)) + ' · ' + esc(a.action) + (a.event ? ' · ' + esc(a.event) : '') + (a.instrument ? ' · ' + esc(a.instrument) : '') +
    (a.strategyName ? ' · ' + esc(a.strategyName) + (a.strategyDbVersion ? ' v' + esc(a.strategyDbVersion) : '') : '') + '</div>' +
    (a.decision ? '<div><b>' + esc(a.decision.action) + '</b>' + (a.decision.side ? ' ' + esc(a.decision.side) + ' ' + esc(a.decision.notional ?? '') : '') + (a.error ? ' <span class="sell">' + esc(a.error) + '</span>' : '') + '</div>' : '') +
    (a.reason ? '<div>' + esc(a.reason) + '</div>' : '') +
    (a.toolTrace && a.toolTrace.length ? '<div class="meta">tools: ' + esc(a.toolTrace.map(t => t.name + (t.ok === false ? '!' : '')).join(', ')) + '</div>' : '') +
    '</div>').join('') || '<p><small>no decisions journaled yet</small></p>';
}
let chart = null;
function draw(d) {
  const cs = d.candles; if (!cs.length) return;
  const stByTime = Object.fromEntries(d.supertrend.map(s => [s.time, s]));
  const P = (t) => Date.parse(t);
  const candleData = cs.map(k => ({ x: P(k.time), o: k.open, h: k.high, l: k.low, c: k.close, k }));
  const stData = d.supertrend.map(s => ({ x: P(s.time), y: s.value, trend: s.trend }));
  const maxVol = Math.max(1, ...cs.map(k => k.volume || 0));
  const volData = cs.map(k => ({ x: P(k.time), y: k.volume || 0 }));
  const volColor = cs.map(k => k.close >= k.open ? 'rgba(63,185,80,0.35)' : 'rgba(248,81,73,0.35)');
  const buys = (d.flips || []).filter(f => f.signal === 'buy').map(f => ({ x: P(f.time), y: cs[f.index] ? cs[f.index].low - (cs[f.index].high - cs[f.index].low) : f.price }));
  const sells = (d.flips || []).filter(f => f.signal === 'sell').map(f => ({ x: P(f.time), y: cs[f.index] ? cs[f.index].high + (cs[f.index].high - cs[f.index].low) : f.price }));
  const t = (d.signal && d.signal.time) || qs.get('t');
  const sigCandle = cs.find(k => k.time === t);
  const marker = sigCandle ? [{ x: P(sigCandle.time), y: sigCandle.close }] : [];

  const overlays = [];
  if (d.indicators) {
    const ind = d.indicators;
    const line = (series, color, dash) => overlays.push({
      type: 'line', yAxisID: 'y', pointRadius: 0, borderWidth: 1, borderColor: color,
      borderDash: dash || [], data: cs.map((k, i) => ({ x: P(k.time), y: series[i] ?? null })), spanGaps: false,
    });
    if (ind.ema) { line(ind.ema.ema20, '#d2a8ff'); line(ind.ema.ema50, '#79c0ff'); line(ind.ema.ema200, '#ffa657'); }
    if (ind.bb) { line(ind.bb.upper, '#8b949e', [4, 4]); line(ind.bb.lower, '#8b949e', [4, 4]); }
    if (ind.vwap) line(ind.vwap, '#f2cc60', [2, 2]);
  }

  if (chart) chart.destroy();
  chart = new Chart(document.getElementById('chart'), {
    data: {
      datasets: [
        { type: 'candlestick', data: candleData, yAxisID: 'y',
          color: { up: '#3fb950', down: '#f85149', unchanged: '#8b949e' },
          borderColor: { up: '#3fb950', down: '#f85149', unchanged: '#8b949e' } },
        { type: 'line', data: stData, yAxisID: 'y', pointRadius: 0, borderWidth: 1.5, tension: 0,
          segment: { borderColor: (c) => (stData[c.p1DataIndex] || {}).trend === 'up' ? '#3fb950' : '#f85149' } },
        { type: 'bar', data: volData, yAxisID: 'vol', backgroundColor: volColor, barPercentage: 0.6 },
        { type: 'scatter', data: buys, yAxisID: 'y', pointStyle: 'triangle', radius: 7, backgroundColor: '#3fb950', borderWidth: 0 },
        { type: 'scatter', data: sells, yAxisID: 'y', pointStyle: 'triangle', rotation: 180, radius: 7, backgroundColor: '#f85149', borderWidth: 0 },
        { type: 'scatter', data: marker, yAxisID: 'y', pointStyle: 'circle', radius: 7, backgroundColor: '#d29922', borderWidth: 0 },
        ...overlays,
      ],
    },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false, parsing: false, normalized: true,
      events: [], // hover is fully owned by fullColumnTooltip (nearest-by-x, full chart height)
      scales: {
        x: { type: 'timeseries', ticks: { color: '#8b949e', maxRotation: 0, autoSkipPadding: 18 },
             grid: { color: 'rgba(48,54,61,0.5)' }, time: { tooltipFormat: 'yyyy-MM-dd HH:mm', displayFormats: { minute: 'HH:mm', hour: 'HH:mm' } } },
        y: { position: 'right', ticks: { color: '#8b949e' }, grid: { color: 'rgba(48,54,61,0.5)' } },
        vol: { position: 'left', display: false, max: maxVol * 5, min: 0 },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          animation: false,
          backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1, titleColor: '#e6edf3', bodyColor: '#e6edf3',
          filter: (item) => item.datasetIndex === 0,
          callbacks: {
            label: (ctx) => {
              const k = ctx.raw.k; if (!k) return '';
              const chg = k.open ? ((k.close - k.open) / k.open * 100).toFixed(2) : '0.00';
              const st = stByTime[k.time];
              const lines = [
                'O ' + k.open + '  H ' + k.high + '  L ' + k.low + '  C ' + k.close + '  (' + (chg >= 0 ? '+' : '') + chg + '%)',
                'volume ' + (k.volume ?? '—') + (k.partial ? '  (forming)' : ''),
              ];
              if (st) lines.push('supertrend ' + st.value + ' ' + st.trend);
              return lines;
            },
          },
        },
      },
    },
  });
  fullColumnTooltip(chart);
}

// Full-column tooltip target (operator UX request): hovering anywhere at an x
// snaps the tooltip to that candle — no need to hit the body. Implemented as a
// manual nearest-by-x lookup activating ONLY the candle dataset (axis-x
// interaction modes crash the vendored bundle's hover-style resolution on the
// segment/scatter datasets).
function fullColumnTooltip(c) {
  const canvas = c.canvas;
  // draw() rebuilds the chart every refresh on the same canvas: attach once,
  // always act on the live module-level chart binding.
  if (canvas.dataset.fullColTooltip) return;
  canvas.dataset.fullColTooltip = '1';
  canvas.addEventListener('mousemove', (e) => {
    const c2 = chart;
    if (!c2) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const a = c2.chartArea;
    const clear = () => { if (c2.tooltip.getActiveElements().length) { c2.tooltip.setActiveElements([], { x: 0, y: 0 }); c2.tooltip.update(true); c2.draw(); } };
    if (!a || x < a.left || x > a.right || y < a.top || y > a.bottom) return clear();
    const data = c2.data.datasets[0].data;
    if (!data.length) return clear();
    const xVal = c2.scales.x.getValueForPixel(x);
    // candles are time-sorted: binary-search the insertion point, compare neighbors
    let lo = 0, hi = data.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (data[mid].x < xVal) lo = mid + 1; else hi = mid; }
    const best = lo > 0 && Math.abs(data[lo - 1].x - xVal) <= Math.abs(data[lo].x - xVal) ? lo - 1 : lo;
    const cur = c2.tooltip.getActiveElements();
    if (cur.length === 1 && cur[0].index === best) return;
    c2.tooltip.setActiveElements([{ datasetIndex: 0, index: best }], { x, y });
    c2.tooltip.update(true);
    c2.draw();
  });
  canvas.addEventListener('mouseleave', () => { const c2 = chart; if (!c2) return; c2.tooltip.setActiveElements([], { x: 0, y: 0 }); c2.tooltip.update(true); c2.draw(); });
}

let oscChart = null;
// One oscillator sub-panel: RSI when toggled (with 30/70 bands), else MACD hist.
function oscPanel(d) {
  const wrapEl = document.getElementById('oscwrap');
  const ind = d.indicators || {};
  const mode = ind.rsi ? 'rsi' : ind.macd ? 'macd' : null;
  wrapEl.hidden = !mode;
  if (oscChart) { oscChart.destroy(); oscChart = null; }
  if (!mode) return;
  const P = (t) => Date.parse(t);
  const xs = d.candles.map(k => P(k.time));
  const datasets = mode === 'rsi'
    ? [{ type: 'line', pointRadius: 0, borderWidth: 1, borderColor: '#d2a8ff', data: d.candles.map((k, i) => ({ x: xs[i], y: ind.rsi[i] ?? null })) }]
    : [{ type: 'bar', backgroundColor: d.candles.map((k, i) => (ind.macd.hist[i] ?? 0) >= 0 ? 'rgba(63,185,80,0.6)' : 'rgba(248,81,73,0.6)'), data: d.candles.map((k, i) => ({ x: xs[i], y: ind.macd.hist[i] ?? null })) }];
  oscChart = new Chart(document.getElementById('osc'), {
    data: { datasets },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false, parsing: false, normalized: true, events: [],
      scales: {
        x: { type: 'timeseries', display: false },
        y: mode === 'rsi'
          ? { position: 'right', min: 0, max: 100, ticks: { color: '#8b949e', stepSize: 35 }, grid: { color: (c) => (c.tick.value === 30 || c.tick.value === 70) ? 'rgba(139,148,158,0.6)' : 'rgba(48,54,61,0.4)' } }
          : { position: 'right', ticks: { color: '#8b949e' }, grid: { color: 'rgba(48,54,61,0.4)' } },
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
    },
  });
}
// Axis-gate chips in the quote strip area (state-only view of the five axes).
function axisChips(gate) {
  const el = document.getElementById('axischips');
  if (!gate || !gate.axes) { el.hidden = true; return; }
  const a = gate.axes;
  el.hidden = false;
  const chip = (label, val, extra) => '<div><small>' + esc(label) + '</small><b>' + esc(val ?? '—') + (extra ? ' <span>' + esc(extra) + '</span>' : '') + '</b></div>';
  el.innerHTML =
    chip('ADX', a.trendStrength.adx, a.trendStrength.verdict) +
    chip('regime', a.direction.emaRegime, (a.direction.htfM15 || '—') + '/' + (a.direction.htfH1 || '—')) +
    chip('impulse', a.impulse.rangeAtr != null ? a.impulse.rangeAtr + '×ATR' : null, 'vol ' + (a.impulse.volumeRatio ?? '—') + '×') +
    chip('VWAP dist', a.location.vwapDistAtr != null ? a.location.vwapDistAtr + '×ATR' : null) +
    chip('RSI', a.exhaustion.rsi);
}
const GRANULARITIES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4'];
function selectors(d) {
  const inst = document.getElementById('instSel');
  const gran = document.getElementById('granSel');
  inst.innerHTML = d.instruments.map(i => '<option' + (i === d.instrument ? ' selected' : '') + '>' + esc(i) + '</option>').join('');
  const grans = GRANULARITIES.includes(d.granularity) ? GRANULARITIES : [d.granularity, ...GRANULARITIES];
  gran.innerHTML = grans.map(g => '<option' + (g === d.granularity ? ' selected' : '') + '>' + esc(g) + '</option>').join('');
  const go = () => { location.search = '?' + new URLSearchParams({ instrument: inst.value, granularity: gran.value }); };
  inst.onchange = go; gran.onchange = go;
  const btn = document.getElementById('watchBtn');
  btn.textContent = d.watched ? '🔔' : '🔕';
  btn.onclick = async () => {
    const combo = d.instrument + '|' + d.granularity;
    const next = d.watched ? d.watchers.filter(w => w !== combo) : [...d.watchers, combo];
    await fetch('/api/settings', { method: 'POST', body: JSON.stringify({ watchers: next.join(', ') }) });
    load();
  };
}

const localHm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const localFull = (iso) => new Date(iso).toLocaleString('en-GB', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(/[,\\s]+/, ' ');
function quoteStrip(q) {
  const el = document.getElementById('quote');
  if (!q) { el.hidden = true; return; }
  el.hidden = false;
  const pc = (v) => v == null ? '—' : (v >= 0 ? '+' : '') + v + '%';
  const cls = (v) => v == null || v >= 0 ? 'buy' : 'sell';
  const ageMin = Math.max(0, Math.round((Date.now() - Date.parse(q.time)) / 60000));
  const st = q.supertrend;
  const box = (label, html) => '<div><small>' + label + '</small><b>' + html + '</b></div>';
  el.innerHTML =
    box('last', '<span class="' + cls(q.change1hPct) + '">' + esc(q.last) + '</span>') +
    box('1h', '<span class="' + cls(q.change1hPct) + '">' + esc(pc(q.change1hPct)) + '</span>') +
    box('24h', '<span class="' + cls(q.change24hPct) + '">' + esc(pc(q.change24hPct)) + '</span>') +
    box('day range', esc(q.dayLow) + ' – ' + esc(q.dayHigh)) +
    (st ? box('supertrend', esc(st.value) + ' <span class="' + (st.trend === 'up' ? 'buy' : 'sell') + '">' + esc(st.trend) + ' ' + esc(pc(st.distPct)) + '</span>') : '') +
    box('updated', q.partial ? '<span class="buy">live</span> · ' + esc(localHm(q.time)) + ' candle forming' : esc(localHm(q.time)) + ' (' + ageMin + 'm ago)');
}

function verdict(s) {
  const el = document.getElementById('verdict');
  if (!s) { el.textContent = 'No recorded signal yet.'; return; }
  const out = s.outcomePct == null ? 'pending' : (s.outcomePct >= 0 ? '+' : '') + s.outcomePct + '%';
  el.innerHTML = '<b class="' + (s.signal === 'buy' ? 'buy' : 'sell') + '">' + esc(s.signal.toUpperCase()) + '</b> @ ' + esc(s.price) +
    ' — ' + esc(localFull(s.time)) + ' · verdict: <b>' + esc(s.verdict || 'unfiltered') + '</b>' +
    (s.reason ? ' — ' + esc(s.reason) : '') + ' · 30-min outcome: <b>' + esc(out) + '</b>' +
    ' · window win rate at signal: ' + esc(s.win_rate ?? '?') + '%';
}
function history(list) {
  const tb = document.querySelector('#hist tbody');
  tb.innerHTML = '';
  for (const s of list) {
    const tr = document.createElement('tr');
    tr.onclick = () => { qs.set('t', s.time); location.search = '?' + qs.toString(); };
    const out = s.outcomePct == null ? '—' : (s.outcomePct >= 0 ? '+' : '') + s.outcomePct + '%';
    tr.innerHTML = '<td>' + esc(localFull(s.time)) + '</td><td class="' + (s.signal === 'buy' ? 'buy' : 'sell') + '">' + esc(s.signal) + '</td><td>' + esc(s.price) +
      '</td><td>' + esc(s.verdict || '—') + '</td><td>' + esc(s.reason || '') + '</td><td>' + esc(out) + '</td>';
    tb.appendChild(tr);
  }
}
const FIELDS = [['instrument', 'text'], ['instruments', 'text'], ['granularity', 'text'], ['watchers', 'text'], ['freshBars', 'number'], ['provider', 'select', [['', 'auto (use API keys)'], ['pi', 'pi'], ['none', 'disabled']]], ['model', 'text'], ['notesFile', 'text'], ['piBin', 'text'], ['notifierBin', 'text'], ['port', 'number'], ['OPENAI_API_KEY', 'password'], ['ANTHROPIC_API_KEY', 'password']];
async function cfg() {
  const s = await (await fetch('/api/settings')).json();
  const f = document.getElementById('cfg');
  f.innerHTML = '<label>active</label><b id="activeProv">' + esc(s.activeProvider || 'none') + '</b>' +
    FIELDS.map(([k, kind, opts]) => '<label for="f-' + k + '">' + k + '</label>' + (kind === 'select'
    ? '<select id="f-' + k + '" name="' + k + '">' + (opts.some(([v]) => v === (s[k] ?? '')) ? opts : [...opts, [s[k], s[k]]]).map(([v, lab]) => '<option value="' + esc(v) + '"' + ((s[k] ?? '') === v ? ' selected' : '') + '>' + esc(lab) + '</option>').join('') + '</select>'
    : '<input id="f-' + k + '" name="' + k + '" type="' + kind + '" value="' + esc(s[k] ?? '') + '">')).join('') +
    '<button>Save</button><span id="saved"></span>';
  f.onsubmit = async (e) => {
    e.preventDefault();
    const patch = {};
    for (const [k, kind] of FIELDS) {
      const v = f.elements[k].value;
      patch[k] = kind === 'number' && v !== '' ? Number(v) : v;
    }
    const r = await (await fetch('/api/settings', { method: 'POST', body: JSON.stringify(patch) })).json();
    if (r.ok) await cfg();
    document.getElementById('saved').textContent = r.ok ? 'saved' : r.error;
  };
}
const chat = { threadId: null, pending: false };
async function loadThreads() {
  const scope = new URLSearchParams();
  if (qs.get('instrument')) scope.set('instrument', qs.get('instrument'));
  if (qs.get('granularity')) scope.set('granularity', qs.get('granularity'));
  const { threads } = await (await fetch('/api/threads?' + scope)).json();
  const bar = document.getElementById('threadBar');
  const opt = (t) => '<option value="' + t.id + '"' + (t.id === chat.threadId ? ' selected' : '') + '>' +
    esc((t.created_at || '').slice(5, 16).replace('T', ' ')) + ' · ' + esc(t.title.slice(0, 34)) + '</option>';
  bar.innerHTML = '<button id="newThread">+ new</button>' +
    '<select id="threadSel"><option value=""' + (chat.threadId == null ? ' selected' : '') + '>— new thread —</option>' +
    threads.map(opt).join('') + '</select>' +
    '<button id="delThread" title="delete selected thread"' + (chat.threadId == null ? ' disabled' : '') + '>🗑</button>';
  bar.querySelector('#newThread').onclick = () => { chat.threadId = null; renderMsgs([]); loadThreads(); };
  bar.querySelector('#threadSel').onchange = (e) => {
    if (e.target.value === '') { chat.threadId = null; renderMsgs([]); loadThreads(); }
    else selectThread(Number(e.target.value));
  };
  bar.querySelector('#delThread').onclick = async () => {
    if (chat.threadId == null) return;
    await fetch('/api/threads?id=' + chat.threadId, { method: 'DELETE' });
    chat.threadId = null;
    renderMsgs([]);
    loadThreads();
  };
}
async function selectThread(id) {
  chat.threadId = id;
  const { messages } = await (await fetch('/api/messages?thread=' + id)).json();
  renderMsgs(messages);
  loadThreads();
}
function md(t) {
  let h = esc(t);
  h = h.replace(/\\x60\\x60\\x60[a-z]*\\n?([\\s\\S]*?)\\x60\\x60\\x60/g, '<pre><code>$1</code></pre>');
  h = h.replace(/\\x60([^\\x60\\n]+)\\x60/g, '<code>$1</code>');
  h = h.replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<b>$1</b>');
  h = h.replace(/(^|\\s)\\*([^*\\n]+)\\*(?=\\s|$|[.,:;!?])/gm, '$1<i>$2</i>');
  h = h.replace(/^#{1,4} (.*)$/gm, '<b>$1</b>');
  h = h.replace(/^[-*] /gm, '\u2022 ');
  const lines = h.split('\\n');
  const out = [];
  let rows = [];
  const flush = () => {
    if (!rows.length) return;
    out.push('<table>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</table>');
    rows = [];
  };
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('|') && t.endsWith('|')) {
      if (/^\\|[\\s:|-]+\\|$/.test(t)) continue; // header separator row
      rows.push(t.slice(1, -1).split('|').map((c) => c.trim()));
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join('\\n');
}

function renderMsgs(list) {
  const el = document.getElementById('msgs');
  el.innerHTML = list.map(m => '<div class="msg ' + (m.role === 'user' ? 'user' : m.role === 'error' ? 'error' : 'assistant') + '">' + (m.role === 'assistant' ? md(m.content) : esc(m.content)) + '</div>').join('');
  el.scrollTop = el.scrollHeight;
}
function appendMsg(role, text) {
  const el = document.getElementById('msgs');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  return div;
}
// A complete, still-streaming, or partially-arrived trailing TITLE annotation
// must never flash in the bubble — but legit HTML comments (even trailing ones,
// even mid-text title mentions followed by more prose) render. Only the LAST
// comment-start is considered, and only when it is a title annotation that
// runs to the end; the fallback strips bare prefixes of "<!--title:".
const stripTitleTail = (t) => {
  const i = t.lastIndexOf('<!--');
  if (i !== -1) {
    const tail = t.slice(i);
    if (/^<!--\\s*title:/.test(tail) && (!tail.includes('-->') || /-->\\s*$/.test(tail))) return t.slice(0, i).replace(/\\n$/, '');
  }
  return t.replace(/\\n?<(?:!(?:-(?:-(?:\\s*(?:t(?:i(?:t(?:l(?:e(?::)?)?)?)?)?)?)?)?)?)?$/, '');
};
document.getElementById('chatForm').onsubmit = async (e) => {
  e.preventDefault();
  if (chat.pending) return;
  const input = document.getElementById('chatMsg');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  chat.pending = true;
  appendMsg('user', message);
  const bubble = appendMsg('assistant', '…');
  try {
    const res = await fetch('/api/chat', { method: 'POST', body: JSON.stringify({
      threadId: chat.threadId, message, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      instrument: qs.get('instrument') || undefined, granularity: qs.get('granularity') || undefined,
    }) });
    if (!res.ok) { bubble.className = 'msg error'; bubble.textContent = (await res.json()).error; chat.pending = false; return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let acc = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\\n\\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (!line.startsWith('data:')) continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.type === 'thread') chat.threadId = ev.id;
        if (ev.type === 'delta') { acc += ev.text; bubble.innerHTML = md(stripTitleTail(acc)); document.getElementById('msgs').scrollTop = 1e9; }
        if (ev.type === 'title') loadThreads();
        if (ev.type === 'done') { bubble.innerHTML = md(ev.reply); chat.threadId = ev.threadId; }
        if (ev.type === 'error') { bubble.className = 'msg error'; bubble.textContent = ev.error; chat.threadId = ev.threadId ?? chat.threadId; }
      }
    }
  } catch (err) {
    bubble.className = 'msg error';
    bubble.textContent = String(err);
  }
  chat.pending = false;
  loadThreads();
};
loadThreads();
load().then(() => { if (qs.get('bot') === '1') openBotModal(); });
setInterval(load, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
document.getElementById('cfgbtn').addEventListener('click', async () => {
  await cfg();
  document.getElementById('cfgdlg').showModal();
});
</script></body></html>
`;

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
