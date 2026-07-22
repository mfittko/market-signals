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
import { computeSupertrend, detectFlips, fetchCandles, readSettings, signalOutcomes, storeCandles, withDb } from './supertrend.mjs';

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
const SETTINGS_KEYS = ['provider', 'model', 'notesFile', 'piBin', 'notifierBin', 'port', 'instrument', 'instruments', 'granularity', 'freshBars', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
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
</style></head><body><main>
<h1>market-signals — <select id="instSel"></select> <select id="granSel"></select> <button id="cfgbtn" type="button">⚙ settings</button></h1>
<div id="wrap"><canvas id="chart" width="1100" height="420"></canvas><div id="tip"></div></div>
<div class="quote" id="quote" hidden></div>
<div class="verdict" id="verdict">loading…</div>
<dialog id="cfgdlg">
<h2>Watcher &amp; filter settings</h2>
<form id="cfg"></form>
<p><button type="button" class="dlg-close" onclick="document.getElementById('cfgdlg').close()">Close</button></p>
</dialog>
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
  selectors(d);
  draw(d); quoteStrip(d.quote); verdict(d.signal); history(d.signals);
}
function draw(d) {
  const c = document.getElementById('chart'), x = c.getContext('2d');
  const cs = d.candles; if (!cs.length) return;
  const stByTime = Object.fromEntries(d.supertrend.map(s => [s.time, s]));
  const lo = Math.min(...cs.map(k => k.low), ...d.supertrend.map(s => s.value));
  const hi = Math.max(...cs.map(k => k.high), ...d.supertrend.map(s => s.value));
  const priceH = c.height - 88; // bottom band is the volume underlay
  const px = v => 8 + (1 - (v - lo) / (hi - lo || 1)) * (priceH - 16);
  const w = c.width / cs.length;
  x.clearRect(0, 0, c.width, c.height);
  const maxVol = Math.max(1, ...cs.map(k => k.volume || 0));
  cs.forEach((k, i) => {
    const h = (k.volume || 0) / maxVol * 80;
    x.fillStyle = k.close >= k.open ? 'rgba(63,185,80,0.35)' : 'rgba(248,81,73,0.35)';
    x.fillRect(i * w + w * 0.2, c.height - h, w * 0.6, h);
  });
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
  // Supertrend flip markers: where the indicator actually fired.
  for (const f of d.flips || []) {
    const k = cs[f.index]; if (!k) continue;
    const cx = f.index * w + w / 2;
    x.fillStyle = f.signal === 'buy' ? '#3fb950' : '#f85149';
    x.beginPath();
    if (f.signal === 'buy') {
      const y = px(k.low) + 14;
      x.moveTo(cx, y - 8); x.lineTo(cx - 5, y); x.lineTo(cx + 5, y);
    } else {
      const y = px(k.high) - 14;
      x.moveTo(cx, y + 8); x.lineTo(cx - 5, y); x.lineTo(cx + 5, y);
    }
    x.fill();
  }
  const t = qs.get('t') || (d.signal && d.signal.time);
  const si = cs.findIndex(k => k.time === t);
  if (si >= 0) {
    x.fillStyle = '#d29922'; x.beginPath();
    x.arc(si * w + w / 2, px(cs[si].close), 6, 0, 7); x.fill();
  }
  hover = { cs, stByTime, w };
}

let hover = null;
const tip = document.getElementById('tip');
const cv = document.getElementById('chart');
cv.addEventListener('mousemove', (e) => {
  if (!hover) return;
  const r = cv.getBoundingClientRect();
  const i = Math.max(0, Math.min(hover.cs.length - 1, Math.floor((e.clientX - r.left) * (cv.width / r.width) / hover.w)));
  const k = hover.cs[i], s = hover.stByTime[k.time];
  const chg = k.open ? ((k.close - k.open) / k.open * 100).toFixed(2) : '0.00';
  tip.innerHTML = '<b>' + esc(k.time) + '</b><br>' +
    'O ' + esc(k.open) + ' · H ' + esc(k.high) + ' · L ' + esc(k.low) + ' · C ' + esc(k.close) +
    ' <span class="' + (k.close >= k.open ? 'buy' : 'sell') + '">(' + (chg >= 0 ? '+' : '') + esc(chg) + '%)</span><br>' +
    'volume ' + esc(k.volume ?? '—') +
    (s ? '<br>supertrend ' + esc(s.value) + ' <span class="' + (s.trend === 'up' ? 'buy' : 'sell') + '">' + esc(s.trend) + '</span>' : '');
  tip.style.display = 'block';
  tip.style.left = Math.min(e.clientX - r.left + 14, r.width - 240) + 'px';
  tip.style.top = Math.min(e.clientY - r.top + 14, r.height - 90) + 'px';
});
cv.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
const GRANULARITIES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4'];
function selectors(d) {
  const inst = document.getElementById('instSel');
  const gran = document.getElementById('granSel');
  inst.innerHTML = d.instruments.map(i => '<option' + (i === d.instrument ? ' selected' : '') + '>' + esc(i) + '</option>').join('');
  const grans = GRANULARITIES.includes(d.granularity) ? GRANULARITIES : [d.granularity, ...GRANULARITIES];
  gran.innerHTML = grans.map(g => '<option' + (g === d.granularity ? ' selected' : '') + '>' + esc(g) + '</option>').join('');
  const go = () => { location.search = '?' + new URLSearchParams({ instrument: inst.value, granularity: gran.value }); };
  inst.onchange = go; gran.onchange = go;
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
    box('updated', esc(q.time.slice(11, 16)) + ' UTC (' + ageMin + 'm ago)');
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
const FIELDS = [['instrument', 'text'], ['instruments', 'text'], ['granularity', 'text'], ['freshBars', 'number'], ['provider', 'select', ['', 'pi', 'none']], ['model', 'text'], ['notesFile', 'text'], ['piBin', 'text'], ['notifierBin', 'text'], ['port', 'number'], ['OPENAI_API_KEY', 'password'], ['ANTHROPIC_API_KEY', 'password']];
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
load();
setInterval(load, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
document.getElementById('cfgbtn').addEventListener('click', async () => {
  await cfg();
  document.getElementById('cfgdlg').showModal();
});
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
