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
import { computeSupertrend, detectFlips, signalOutcomes, withDb } from './supertrend.mjs';

const USAGE = `signal-server — local chart + watcher config UI over the alert db.

Options:
  --port <n>          listen port on 127.0.0.1 (default: 8787, or settings.port)
  --db <path>         sqlite db (default: data/candles.db)
  --settings <path>   settings file the config page edits (default: data/settings.json)
  -h, --help
`;

const DEFAULT_INSTRUMENT = 'WTICO/USD';

// Keys the config page may read/write; API keys are write-only (masked on read).
const SETTINGS_KEYS = ['provider', 'model', 'notesFile', 'piBin', 'notifierBin', 'port', 'instrument', 'granularity', 'freshBars', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
const SECRET_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
const MASK = '•••';

export function readSettings(settingsPath) {
  try { return JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { return {}; }
}

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

export function chartData(dbPath, instrument, { t = null, count = 120, granularity = 'M5' } = {}) {
  const candles = withDb(dbPath, (db) => {
    if (t) {
      // Window around the signal: bars up to and past t.
      const before = db.prepare('SELECT * FROM candles WHERE instrument=? AND granularity=? AND time <= ? ORDER BY time DESC LIMIT ?')
        .all(instrument, granularity, t, Math.ceil(count * 0.7)).reverse();
      const after = db.prepare('SELECT * FROM candles WHERE instrument=? AND granularity=? AND time > ? ORDER BY time LIMIT ?')
        .all(instrument, granularity, t, Math.floor(count * 0.3));
      return [...before, ...after];
    }
    return db.prepare('SELECT * FROM candles WHERE instrument=? AND granularity=? ORDER BY time DESC LIMIT ?')
      .all(instrument, granularity, count).reverse();
  });
  let supertrend = [];
  let flips = [];
  if (candles.length >= 15) {
    const st = computeSupertrend(candles, {});
    supertrend = st.map((s, i) => s && { time: candles[i].time, value: Number(s.supertrend.toFixed(4)), trend: s.trend }).filter(Boolean);
    flips = detectFlips(candles, st);
  }
  const signals = signalOutcomes(dbPath, instrument, granularity, { limit: 50 });
  // Deep-linked signals older than the history window are looked up directly.
  const signal = t
    ? signals.find((s) => s.time === t) ?? signalOutcomes(dbPath, instrument, granularity, { time: t })[0] ?? null
    : signals[0] ?? null;
  return { instrument, granularity, candles, supertrend, flips, signal, signals };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function buildServer({ dbPath, settingsPath }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/chart') {
        const instrument = url.searchParams.get('instrument') || readSettings(settingsPath).instrument || DEFAULT_INSTRUMENT;
        const t = url.searchParams.get('t');
        const granularity = url.searchParams.get('granularity') || readSettings(settingsPath).granularity || 'M5';
        return json(res, 200, chartData(dbPath, instrument, { t, granularity }));
      }
      if (url.pathname === '/api/settings' && req.method === 'GET') {
        return json(res, 200, maskedSettings(settingsPath));
      }
      if (url.pathname === '/api/settings' && req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 64 * 1024) return json(res, 413, { ok: false, error: 'body too large' });
        }
        let patch;
        try { patch = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
        try { return json(res, 200, { ok: true, settings: writeSettings(settingsPath, patch) }); }
        catch (err) { return json(res, 400, { ok: false, error: err.message }); }
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
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0d1117; color: #e6edf3; font: 14px/1.5 -apple-system, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 16px; } h2 { font-size: 14px; margin: 20px 0 8px; }
  canvas { width: 100%; background: #010409; border: 1px solid #30363d; border-radius: 6px; }
  .verdict { padding: 10px 12px; border: 1px solid #30363d; border-radius: 6px; margin: 10px 0; }
  .buy { color: #3fb950; } .sell { color: #f85149; }
  table { border-collapse: collapse; width: 100%; } td, th { padding: 4px 8px; text-align: left; border-bottom: 1px solid #21262d; }
  tr { cursor: pointer; } tr:hover { background: #161b22; }
  form { display: grid; grid-template-columns: 140px 1fr; gap: 6px 10px; max-width: 520px; }
  input, select { background: #010409; color: #e6edf3; border: 1px solid #30363d; border-radius: 4px; padding: 4px 6px; }
  button { grid-column: 2; justify-self: start; padding: 5px 14px; background: #238636; color: #fff; border: 0; border-radius: 4px; cursor: pointer; }
  #saved { color: #3fb950; margin-left: 8px; }
</style></head><body><main>
<h1>market-signals — <span id="inst"></span></h1>
<canvas id="chart" width="1100" height="420"></canvas>
<div class="verdict" id="verdict">loading…</div>
<h2>Watcher &amp; filter settings</h2>
<form id="cfg"></form>
<h2>Signal history (30-min outcomes)</h2>
<table id="hist"><thead><tr><th>time (UTC)</th><th>signal</th><th>price</th><th>verdict</th><th>reason</th><th>outcome</th></tr></thead><tbody></tbody></table>
<script>
const qs = new URLSearchParams(location.search);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function load() {
  const p = new URLSearchParams();
  if (qs.get('instrument')) p.set('instrument', qs.get('instrument'));
  if (qs.get('t')) p.set('t', qs.get('t'));
  if (qs.get('granularity')) p.set('granularity', qs.get('granularity'));
  const d = await (await fetch('/api/chart?' + p)).json();
  document.getElementById('inst').textContent = d.instrument + ' ' + d.granularity;
  draw(d); verdict(d.signal); history(d.signals);
}
function draw(d) {
  const c = document.getElementById('chart'), x = c.getContext('2d');
  const cs = d.candles; if (!cs.length) return;
  const stByTime = Object.fromEntries(d.supertrend.map(s => [s.time, s]));
  const lo = Math.min(...cs.map(k => k.low), ...d.supertrend.map(s => s.value));
  const hi = Math.max(...cs.map(k => k.high), ...d.supertrend.map(s => s.value));
  const px = v => 8 + (1 - (v - lo) / (hi - lo || 1)) * (c.height - 16);
  const w = c.width / cs.length;
  x.clearRect(0, 0, c.width, c.height);
  cs.forEach((k, i) => {
    const cx = i * w + w / 2;
    x.strokeStyle = x.fillStyle = k.close >= k.open ? '#3fb950' : '#f85149';
    x.beginPath(); x.moveTo(cx, px(k.high)); x.lineTo(cx, px(k.low)); x.stroke();
    const [a, b] = [px(k.open), px(k.close)].sort((m, n) => m - n);
    x.fillRect(cx - w * 0.3, a, w * 0.6, Math.max(1, b - a));
  });
  let prev = null;
  cs.forEach((k, i) => {
    const s = stByTime[k.time]; if (!s) return;
    x.strokeStyle = s.trend === 'up' ? '#3fb950' : '#f85149';
    if (prev) { x.beginPath(); x.moveTo((i - 1) * w + w / 2, px(prev.value)); x.lineTo(i * w + w / 2, px(s.value)); x.stroke(); }
    prev = s;
  });
  const t = qs.get('t') || (d.signal && d.signal.time);
  const si = cs.findIndex(k => k.time === t);
  if (si >= 0) {
    x.fillStyle = '#d29922'; x.beginPath();
    x.arc(si * w + w / 2, px(cs[si].close), 6, 0, 7); x.fill();
  }
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
const FIELDS = [['instrument', 'text'], ['granularity', 'text'], ['freshBars', 'number'], ['provider', 'select', ['', 'pi', 'none']], ['model', 'text'], ['notesFile', 'text'], ['piBin', 'text'], ['notifierBin', 'text'], ['port', 'number'], ['OPENAI_API_KEY', 'password'], ['ANTHROPIC_API_KEY', 'password']];
async function cfg() {
  const s = await (await fetch('/api/settings')).json();
  const f = document.getElementById('cfg');
  f.innerHTML = FIELDS.map(([k, kind, opts]) => '<label>' + k + '</label>' + (kind === 'select'
    ? '<select name="' + k + '">' + (opts.includes(s[k] ?? '') ? opts : [...opts, s[k]]).map(o => '<option' + ((s[k] ?? '') === o ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>'
    : '<input name="' + k + '" type="' + kind + '" value="' + esc(s[k] ?? '') + '">')).join('') +
    '<button>Save</button><span id="saved"></span>';
  f.onsubmit = async (e) => {
    e.preventDefault();
    const patch = {};
    for (const [k, kind] of FIELDS) {
      const v = f.elements[k].value;
      patch[k] = kind === 'number' && v !== '' ? Number(v) : v;
    }
    const r = await (await fetch('/api/settings', { method: 'POST', body: JSON.stringify(patch) })).json();
    document.getElementById('saved').textContent = r.ok ? 'saved' : r.error;
    if (r.ok) cfg();
  };
}
load(); cfg();
</script></main></body></html>
`;

function parseArgs(argv) {
  const out = { port: null, db: 'data/candles.db', settings: 'data/settings.json' };
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (!(m[1] in out)) throw new Error(`unknown flag --${m[1]} (run --help)`);
    const value = m[2] ?? argv[++i];
    if (value === undefined) throw new Error(`--${m[1]} requires a value`);
    out[m[1]] = m[1] === 'port' ? Number.parseInt(value, 10) : value;
    if (m[1] === 'port' && Number.isNaN(out.port)) throw new Error(`invalid --port "${value}"`);
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) return process.stdout.write(USAGE);
  const opts = parseArgs(argv);
  const port = opts.port ?? readSettings(opts.settings).port ?? 8787;
  const server = buildServer({ dbPath: opts.db, settingsPath: opts.settings });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`signal-server listening on http://127.0.0.1:${port}\n`);
  });
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main();
