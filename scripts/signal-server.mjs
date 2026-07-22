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
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSupertrend, detectFlips, fetchCandles, llmChat, readSettings, recordSignal, signalOutcomes, storeCandles, withDb } from './supertrend.mjs';

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
const SETTINGS_KEYS = ['provider', 'model', 'notesFile', 'piBin', 'notifierBin', 'port', 'instrument', 'instruments', 'granularity', 'watchers', 'freshBars', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
const SECRET_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
const MASK = '•••';

export function maskedSettings(settingsPath) {
  const s = readSettings(settingsPath);
  const out = {};
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
  const current = readSettings(settingsPath);
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (SECRET_KEYS.includes(k) && v === MASK) continue; // masked = unchanged
    if (v === '' || v === null) delete next[k];
    else next[k] = v;
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, settingsPath);
  return maskedSettings(settingsPath);
}

const granularityMs = (g) => {
  const m = /^([MH])(\d+)$/.exec(g);
  return m ? Number(m[2]) * (m[1] === 'M' ? 60000 : 3600000) : 300000;
};

const lastLiveFetch = new Map(); // key -> { at, tail }: one upstream fetch per ~minute, forming candle cached in between

export async function chartData(dbPath, instrument, { t = null, count = 120, granularity = 'M5', fetcher = fetchCandles } = {}) {
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
  return { instrument, granularity, candles, supertrend, flips, signal, signals, quote };
}

const CHAT_DDL = `CREATE TABLE IF NOT EXISTS chat_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
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
    return fn(db);
  });
}

export function listThreads(dbPath) {
  return chatDb(dbPath, (db) => db.prepare(
    'SELECT t.*, COUNT(m.id) AS messages FROM chat_threads t LEFT JOIN chat_messages m ON m.thread_id = t.id GROUP BY t.id ORDER BY t.id DESC').all());
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

const CHAT_SYSTEM = `You are the trading copilot embedded in the market-signals local dashboard of a leveraged CFD trader. Each question carries a JSON context block: the currently viewed instrument/granularity, its quote, recent candles, the latest signal with verdict and realized outcomes, recent signal history, and the trader's notes; prior thread messages may precede the question. Answer concisely with concrete levels; you provide analysis, never order execution. If you have agent tools, you run in the repo root and may expand your context: run \`node skills/fxempire-live-data/scripts/fxempire_live_data.mjs --mode rates --market <commodities|indices|currencies|crypto-coin> --slugs <csv>\` for live rates, query \`sqlite3 data/candles.db\` (tables: candles, signals), read \`data/notes.md\`, or web-search for market-moving news. Prefer the provided context; fetch only what is missing.`;

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

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function buildServer({ dbPath, settingsPath, fetcher = fetchCandles }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/chart') {
        const cfg = readSettings(settingsPath);
        const instrument = url.searchParams.get('instrument') || cfg.instrument || DEFAULT_INSTRUMENT;
        const t = url.searchParams.get('t');
        const granularity = url.searchParams.get('granularity') || cfg.granularity || 'M5';
        const data = await chartData(dbPath, instrument, { t, granularity, fetcher });
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
        let raw = '';
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 64 * 1024) return json(res, 413, { ok: false, error: 'body too large' });
          raw += chunk;
        }
        let patch;
        try { patch = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
        try { return json(res, 200, { ok: true, settings: writeSettings(settingsPath, patch) }); }
        catch (err) { return json(res, 400, { ok: false, error: err.message }); }
      }
      if (url.pathname === '/api/threads' && req.method === 'GET') {
        return json(res, 200, { ok: true, threads: listThreads(dbPath) });
      }
      if (url.pathname === '/api/threads' && req.method === 'DELETE') {
        const id = Number(url.searchParams.get('id'));
        if (!Number.isInteger(id)) return json(res, 400, { ok: false, error: 'id required' });
        deleteThread(dbPath, id);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/messages' && req.method === 'GET') {
        const id = Number(url.searchParams.get('thread'));
        if (!Number.isInteger(id)) return json(res, 400, { ok: false, error: 'thread required' });
        return json(res, 200, { ok: true, messages: listMessages(dbPath, id) });
      }
      if (url.pathname === '/api/chat' && req.method === 'POST') {
        let raw = '';
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 64 * 1024) return json(res, 413, { ok: false, error: 'body too large' });
          raw += chunk;
        }
        let body;
        try { body = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message || message.length > 4000) return json(res, 400, { ok: false, error: 'message required (max 4000 chars)' });
        const cfg = readSettings(settingsPath);
        const hasProvider = cfg.provider === 'pi' || (cfg.provider !== 'none' && (cfg.OPENAI_API_KEY || cfg.ANTHROPIC_API_KEY));
        if (!hasProvider) return json(res, 400, { ok: false, error: 'no chat provider configured (settings: provider/API keys)' });

        const instrument = body.instrument || cfg.instrument || DEFAULT_INSTRUMENT;
        const granularity = body.granularity || cfg.granularity || 'M5';
        const view = await chartData(dbPath, instrument, { granularity, fetcher: null });
        const context = {
          view: { instrument, granularity },
          quote: view.quote,
          recentCandles: view.candles.slice(-24).map((k) => ({ t: k.time.slice(11, 16), o: k.open, h: k.high, l: k.low, c: k.close, v: k.volume ?? null })),
          signal: view.signal,
          signalHistory: view.signals.slice(0, 10).map((x) => ({ time: x.time, signal: x.signal, verdict: x.verdict, outcomePct: x.outcomePct })),
        };

        let threadId = Number.isInteger(body.threadId) ? body.threadId : null;
        if (threadId != null && !chatDb(dbPath, (db) => db.prepare('SELECT id FROM chat_threads WHERE id=?').get(threadId))) {
          return json(res, 404, { ok: false, error: 'unknown thread' });
        }
        let createdThread = null;
        if (threadId == null) {
          threadId = chatDb(dbPath, (db) => db.prepare('INSERT INTO chat_threads (title, created_at) VALUES (?,?)')
            .run(message.slice(0, 60), new Date().toISOString()).lastInsertRowid);
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
          const reply = await llmChat(cfg, CHAT_SYSTEM, user, { onDelta: (text) => send({ type: 'delta', text }) });
          addMessage(dbPath, threadId, 'assistant', reply);
          send({ type: 'done', threadId: Number(threadId), reply });
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
  #threadBar button.active { background: #1f6feb; border-color: #1f6feb; }
  #threadBar .del { padding: 3px 6px; color: #8b949e; }
  #msgs { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .msg { border-radius: 8px; padding: 7px 10px; font-size: 13px; white-space: pre-wrap; word-break: break-word; max-width: 95%; }
  .msg.user { background: #1f6feb22; border: 1px solid #1f6feb55; align-self: flex-end; }
  .msg.assistant { background: #161b22; border: 1px solid #30363d; align-self: flex-start; }
  .msg.error { background: #f8514922; border: 1px solid #f8514955; align-self: flex-start; }
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
<h1>market-signals — <select id="instSel"></select> <select id="granSel"></select> <button id="watchBtn" type="button" title="toggle alerts for this instrument/granularity">🔕</button> <button id="cfgbtn" type="button">⚙ settings</button></h1>
<div id="wrap" style="height:460px"><canvas id="chart"></canvas></div>
<div class="quote" id="quote" hidden></div>
<div class="verdict" id="verdict">loading…</div>
<dialog id="cfgdlg">
<h2>Watcher &amp; filter settings</h2>
<form id="cfg"></form>
<p><button type="button" class="dlg-close" onclick="document.getElementById('cfgdlg').close()">Close</button></p>
</dialog>
<h2>Signal history (30-min outcomes)</h2>
<table id="hist"><thead><tr><th>time (UTC)</th><th>signal</th><th>price</th><th>verdict</th><th>reason</th><th>outcome</th></tr></thead><tbody></tbody></table>
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
async function load() {
  const p = new URLSearchParams();
  if (qs.get('instrument')) p.set('instrument', qs.get('instrument'));
  if (qs.get('t')) p.set('t', qs.get('t'));
  if (qs.get('granularity')) p.set('granularity', qs.get('granularity'));
  const d = await (await fetch('/api/chart?' + p)).json();
  selectors(d);
  draw(d); quoteStrip(d.quote); verdict(d.signal); history(d.signals);
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
      ],
    },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false, parsing: false, normalized: true,
      scales: {
        x: { type: 'timeseries', ticks: { color: '#8b949e', maxRotation: 0, autoSkipPadding: 18 },
             grid: { color: 'rgba(48,54,61,0.5)' }, time: { tooltipFormat: 'yyyy-MM-dd HH:mm', displayFormats: { minute: 'HH:mm', hour: 'HH:mm' } } },
        y: { position: 'right', ticks: { color: '#8b949e' }, grid: { color: 'rgba(48,54,61,0.5)' } },
        vol: { position: 'left', display: false, max: maxVol * 5, min: 0 },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
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
    box('updated', q.partial ? '<span class="buy">live</span> · ' + esc(q.time.slice(11, 16)) + ' candle forming' : esc(q.time.slice(11, 16)) + ' UTC (' + ageMin + 'm ago)');
}

function verdict(s) {
  const el = document.getElementById('verdict');
  if (!s) { el.textContent = 'No recorded signal yet.'; return; }
  const out = s.outcomePct == null ? 'pending' : (s.outcomePct >= 0 ? '+' : '') + s.outcomePct + '%';
  el.innerHTML = '<b class="' + (s.signal === 'buy' ? 'buy' : 'sell') + '">' + esc(s.signal.toUpperCase()) + '</b> @ ' + esc(s.price) +
    ' — ' + esc(s.time) + ' · verdict: <b>' + esc(s.verdict || 'unfiltered') + '</b>' +
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
    tr.innerHTML = '<td>' + esc(s.time) + '</td><td class="' + (s.signal === 'buy' ? 'buy' : 'sell') + '">' + esc(s.signal) + '</td><td>' + esc(s.price) +
      '</td><td>' + esc(s.verdict || '—') + '</td><td>' + esc(s.reason || '') + '</td><td>' + esc(out) + '</td>';
    tb.appendChild(tr);
  }
}
const FIELDS = [['instrument', 'text'], ['instruments', 'text'], ['granularity', 'text'], ['watchers', 'text'], ['freshBars', 'number'], ['provider', 'select', ['', 'pi', 'none']], ['model', 'text'], ['notesFile', 'text'], ['piBin', 'text'], ['notifierBin', 'text'], ['port', 'number'], ['OPENAI_API_KEY', 'password'], ['ANTHROPIC_API_KEY', 'password']];
async function cfg() {
  const s = await (await fetch('/api/settings')).json();
  const f = document.getElementById('cfg');
  f.innerHTML = FIELDS.map(([k, kind, opts]) => '<label for="f-' + k + '">' + k + '</label>' + (kind === 'select'
    ? '<select id="f-' + k + '" name="' + k + '">' + (opts.includes(s[k] ?? '') ? opts : [...opts, s[k]]).map(o => '<option' + ((s[k] ?? '') === o ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>'
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
  const { threads } = await (await fetch('/api/threads')).json();
  const bar = document.getElementById('threadBar');
  bar.innerHTML = '<button id="newThread">+ new</button>' + threads.map(t =>
    '<button data-id="' + t.id + '" class="' + (t.id === chat.threadId ? 'active' : '') + '">' + esc(t.title.slice(0, 22)) + '</button>' +
    '<button class="del" data-del="' + t.id + '" title="delete thread">✕</button>').join('');
  bar.querySelector('#newThread').onclick = () => { chat.threadId = null; renderMsgs([]); loadThreads(); };
  for (const b of bar.querySelectorAll('button[data-id]')) b.onclick = () => selectThread(Number(b.dataset.id));
  for (const b of bar.querySelectorAll('button[data-del]')) b.onclick = async () => {
    await fetch('/api/threads?id=' + b.dataset.del, { method: 'DELETE' });
    if (chat.threadId === Number(b.dataset.del)) { chat.threadId = null; renderMsgs([]); }
    loadThreads();
  };
}
async function selectThread(id) {
  chat.threadId = id;
  const { messages } = await (await fetch('/api/messages?thread=' + id)).json();
  renderMsgs(messages);
  loadThreads();
}
function renderMsgs(list) {
  const el = document.getElementById('msgs');
  el.innerHTML = list.map(m => '<div class="msg ' + (m.role === 'user' ? 'user' : m.role === 'error' ? 'error' : 'assistant') + '">' + esc(m.content) + '</div>').join('');
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
      threadId: chat.threadId, message,
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
        if (ev.type === 'delta') { acc += ev.text; bubble.textContent = acc; document.getElementById('msgs').scrollTop = 1e9; }
        if (ev.type === 'done') { bubble.textContent = ev.reply; chat.threadId = ev.threadId; }
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
load();
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
