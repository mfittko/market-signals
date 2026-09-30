#!/usr/bin/env node
// Golden-fixture recorder + replayer. Records what the Node engine computes
// for fixed synthetic inputs (indicators, fills, sizing, halts, attribution)
// so a later port or refactor can be tested differentially. Format and rules:
// test/golden/README.md. Usage:
//   node scripts/golden-fixtures.mjs           verify committed fixtures (exit 1 on drift)
//   node scripts/golden-fixtures.mjs --write   regenerate test/golden/*.json
// Inputs live in this file; expected values are always produced by the engine.
process.env.MS_NO_NOTIFY ??= '1'; // the recorder must never notify
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSupertrend, detectFlips, withDb } from './supertrend.mjs';
import {
  ema, rsi, macd, bollinger, vwap, atr, adx, volumeRatio, resampleCandles, htfSupertrend,
} from './indicators.mjs';
import { axisSnapshot } from './axis-snapshot.mjs';
import {
  botConfig, openPosition, closePosition, markToMarket, portfolioView,
} from './portfolio.mjs';
import { runBot, simulateFills, performHaltReset } from './bot.mjs';
import { positionAttribution, granularityOf, comboOf, strategyScoreboard } from './evaluation.mjs';

export const FORMAT_VERSION = 1;
export const GOLDEN_DIR = process.env.GOLDEN_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'golden');
const INSTR = 'SYNTH/USD';

// --- deterministic synthetic candles ----------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (v) => Math.round(v * 100) / 100;

// Regime-switching random walk: drift flips sign every 25 bars so flips occur.
export function walk({ seed, bars, start = 80, stepMs = 5 * 60 * 1000, t0 = Date.parse('2026-01-05T00:00:00Z') }) {
  const rnd = mulberry32(seed);
  const out = [];
  let price = start;
  for (let i = 0; i < bars; i++) {
    const drift = (Math.floor(i / 25) % 2 === 0 ? 1 : -1) * 0.05;
    const open = price;
    const close = open + drift + (rnd() - 0.5) * 0.8;
    const high = Math.max(open, close) + rnd() * 0.3;
    const low = Math.min(open, close) - rnd() * 0.3;
    out.push({
      time: new Date(t0 + i * stepMs).toISOString(),
      open: r2(open), high: r2(high), low: r2(low), close: r2(close),
      volume: 100 + Math.floor(rnd() * 900), complete: true,
    });
    price = close;
  }
  return out;
}

const flat = (bars) => Array.from({ length: bars }, (_, i) => ({
  time: new Date(Date.parse('2026-01-05T00:00:00Z') + i * 300000).toISOString(),
  open: 50, high: 50, low: 50, close: 50, volume: 100, complete: true,
}));

const SERIES = {
  walk100: walk({ seed: 1, bars: 100 }),
  walk240: walk({ seed: 7, bars: 240 }),
  flat40: flat(40),
  short5: walk({ seed: 3, bars: 5 }),
};

// --- indicator replay ---------------------------------------------------------

const safe = (fn) => { try { return fn(); } catch (err) { return { error: String(err.message) }; } };
const round = (o) => JSON.parse(JSON.stringify(o)); // NaN/Infinity -> null, like the file

function replayIndicators(input, series) {
  const candles = series[input.series];
  const closes = candles.map((c) => c.close);
  const st = safe(() => computeSupertrend(candles, { period: 10, multiplier: 3 }));
  return round({
    supertrend: st,
    flips: Array.isArray(st) ? detectFlips(candles, st) : null,
    atr14: atr(candles, 14),
    adx14: adx(candles, 14),
    rsi14: rsi(closes, 14),
    ema20: ema(closes, 20),
    macd: macd(closes),
    bollinger: bollinger(closes),
    vwap: vwap(candles),
    volumeRatio20: volumeRatio(candles, 20),
    resampleM15: resampleCandles(candles, 'M5', 'M15'),
    htfM15: htfSupertrend(candles, 'M5', 'M15'),
  });
}

function replaySnapshot(input, series) {
  return round(axisSnapshot(series[input.series], {
    instrument: INSTR, granularity: 'M5', flip: input.flip ? { signal: input.flip } : null,
  }));
}

// --- portfolio scenarios ------------------------------------------------------

const candle = (o, h, l, c, time) => ({ time, open: o, high: h, low: l, close: c, volume: 100, complete: true });
const T = (n) => new Date(Date.parse('2026-01-05T00:00:00Z') + n * 300000).toISOString();

const SCENARIOS = {
  'sizing-risk-cap': {
    config: { bot: { riskPct: 1, leverage: { [INSTR]: 10 } }, spreads: { [INSTR]: 0.06 } },
    steps: [
      { op: 'open', instrument: INSTR, side: 'long', notional: 5000, price: 87 },
      { op: 'open', instrument: INSTR, side: 'short', notional: 500, price: 87 },
      { op: 'open', instrument: INSTR, side: 'long', notional: 0, price: 87 },
    ],
  },
  'sizing-allocation-cap-and-exhausted-skip': {
    config: { bot: { riskPct: 5, leverage: { [INSTR]: 10 } }, spreads: {}, allocationPct: 2 },
    steps: [
      { op: 'open', instrument: INSTR, side: 'long', notional: 5000, price: 100 },
      { op: 'open', instrument: INSTR, side: 'long', notional: 5000, price: 100 },
    ],
  },
  'caps-max-positions': {
    config: { bot: { riskPct: 100, maxPositions: 1, leverage: { [INSTR]: 10 } }, spreads: {} },
    steps: [
      { op: 'open', instrument: INSTR, side: 'long', notional: 1000, price: 100 },
      { op: 'open', instrument: 'OTHER/USD', side: 'long', notional: 1000, price: 100 },
    ],
  },
  'spread-and-manual-close': {
    config: { bot: { riskPct: 10, leverage: { [INSTR]: 10 } }, spreads: { [INSTR]: 0.06 } },
    steps: [
      { op: 'open', instrument: INSTR, side: 'long', notional: 1000, price: 87 },
      { op: 'open', instrument: INSTR, side: 'short', notional: 1000, price: 87 },
      { op: 'close', positionId: 1, price: 88, reason: 'bot-close' },
      { op: 'close', positionId: 2, price: 86, reason: 'bot-close' },
      { op: 'close', positionId: 99, price: 86, reason: 'bot-close' },
    ],
  },
  'fills-stop-target-gap': {
    config: { bot: { riskPct: 50, maxPositions: 5, leverage: { [INSTR]: 10 } }, spreads: {} },
    steps: [
      // long, both levels touched, no gap: stop wins (pessimistic)
      { op: 'open', instrument: INSTR, side: 'long', notional: 1000, price: 87, stop: 85, target: 90 },
      { op: 'fills', instrument: INSTR, candle: candle(86, 91, 84, 88, T(1)) },
      // long, gap through the stop at the open: fills at the open
      { op: 'open', instrument: INSTR, side: 'long', notional: 1000, price: 87, stop: 85, target: 90 },
      { op: 'fills', instrument: INSTR, candle: candle(84, 91, 83, 88, T(2)) },
      // long, gap through the target at the open
      { op: 'open', instrument: INSTR, side: 'long', notional: 1000, price: 87, stop: 85, target: 90 },
      { op: 'fills', instrument: INSTR, candle: candle(91, 92, 84, 88, T(3)) },
      // long, target touched intrabar only
      { op: 'open', instrument: INSTR, side: 'long', notional: 1000, price: 87, stop: 85, target: 90 },
      { op: 'fills', instrument: INSTR, candle: candle(88, 91, 86, 89, T(4)) },
      // short, both touched, no gap: stop wins
      { op: 'open', instrument: INSTR, side: 'short', notional: 1000, price: 87, stop: 89, target: 84 },
      { op: 'fills', instrument: INSTR, candle: candle(87, 90, 83, 86, T(5)) },
      // short, gap through the target at the open
      { op: 'open', instrument: INSTR, side: 'short', notional: 1000, price: 87, stop: 89, target: 84 },
      { op: 'fills', instrument: INSTR, candle: candle(83, 88, 82, 85, T(6)) },
      // untouched candle and a candle for another instrument change nothing
      { op: 'open', instrument: INSTR, side: 'long', notional: 1000, price: 87, stop: 85, target: 90 },
      { op: 'fills', instrument: INSTR, candle: candle(87, 88, 86, 87, T(7)) },
      { op: 'fills', instrument: 'OTHER/USD', candle: candle(50, 200, 1, 60, T(8)) },
    ],
  },
  'mark-to-market-exits-and-stale': {
    config: { bot: { riskPct: 50, maxPositions: 5, leverage: { [INSTR]: 10, 'B/USD': 10, 'C/USD': 10, 'D/USD': 10 } }, spreads: {} },
    steps: [
      { op: 'open', instrument: INSTR, side: 'long', notional: 1000, price: 87 },
      { op: 'open', instrument: 'B/USD', side: 'long', notional: 1000, price: 100, stop: 95 },
      { op: 'open', instrument: 'C/USD', side: 'short', notional: 1000, price: 100, target: 90 },
      { op: 'open', instrument: 'D/USD', side: 'long', notional: 1000, price: 100 },
      { op: 'mark', quotes: { 'B/USD': 94, 'C/USD': 89, 'D/USD': 0 } },
      { op: 'mark', quotes: { [INSTR]: 78 } },
    ],
  },
  'halt-equity-zero-closes-the-rest': {
    config: { bot: { riskPct: 100, maxPositions: 5, leverage: { [INSTR]: 10, 'B/USD': 10 } }, spreads: {} },
    steps: [
      { op: 'open', instrument: INSTR, side: 'long', notional: 80000, price: 100 },
      { op: 'open', instrument: 'B/USD', side: 'long', notional: 20000, price: 100 },
      { op: 'mark', quotes: { [INSTR]: 80 } },
      { op: 'open', instrument: INSTR, side: 'long', notional: 1000, price: 100 },
      { op: 'mark', quotes: { 'B/USD': 100 } },
    ],
  },
  'killswitch-and-halt-reset': {
    config: { bot: { riskPct: 100, leverage: { [INSTR]: 10 } }, spreads: {} },
    settings: { bot: { killSwitchDrawdownPct: 20, bots: { [`${INSTR}|M5`]: { enabled: true, strategyName: 'golden-none' } } } },
    steps: [
      { op: 'runBot', instrument: INSTR, granularity: 'M5', candle: candle(100, 100, 100, 100, T(1)) },
      { op: 'open', instrument: INSTR, side: 'long', notional: 50000, price: 100 },
      { op: 'runBot', instrument: INSTR, granularity: 'M5', candle: candle(96, 97, 94, 95, T(2)) },
      { op: 'runBot', instrument: INSTR, granularity: 'M5', candle: candle(95, 96, 94, 95, T(3)) },
      { op: 'resetHalt' },
      { op: 'resetHalt' },
      { op: 'runBot', instrument: INSTR, granularity: 'M5', candle: candle(95, 96, 94, 95, T(4)) },
    ],
  },
  'attribution-and-scoreboard': {
    config: { bot: { riskPct: 10, maxPositions: 6, leverage: { [INSTR]: 10 } }, spreads: {} },
    steps: [
      { op: 'open', instrument: INSTR, side: 'long', notional: 1000, price: 100, granularity: 'M5' },
      { op: 'open', instrument: INSTR, side: 'long', notional: 1000, price: 100 },
      { op: 'open', instrument: INSTR, side: 'short', notional: 1000, price: 100 },
      { op: 'open', instrument: INSTR, side: 'long', notional: 1000, price: 100, granularity: 'H1' },
      { op: 'open', instrument: INSTR, side: 'long', notional: 1000, price: 100, granularity: 'M5' },
      { op: 'journal', action: 'decision', context: { instrument: INSTR, granularity: 'M5', strategyId: 1, strategyName: 'trend-follow', strategyDbVersion: 1, strategyVersion: 'aaaa1111', executed: { opened: 1 } } },
      { op: 'journal', action: 'decision', context: { instrument: INSTR, strategyId: 1, strategyName: 'trend-follow', strategyDbVersion: 1, strategyVersion: 'aaaa1111', executed: { opened: 2 } } },
      { op: 'journal', action: 'decision', context: { instrument: INSTR, granularity: 'M5', strategyId: 2, strategyName: 'breakout', strategyDbVersion: 3, strategyVersion: 'bbbb2222', executed: { opened: 4 } } },
      { op: 'journal', action: 'decision', context: { instrument: INSTR, granularity: 'M5', strategyVersion: 'cccc3333', executed: { opened: 5 } } },
      { op: 'journal', action: 'decision', context: { instrument: INSTR, granularity: 'M5', strategyId: 1, executed: {} } },
      { op: 'journalRaw', action: 'decision', context: 'not json' },
      { op: 'close', positionId: 1, price: 102, reason: 'target' },
      { op: 'close', positionId: 2, price: 99, reason: 'stop' },
      { op: 'close', positionId: 3, price: 98, reason: 'bot-close' },
      { op: 'close', positionId: 4, price: 105, reason: 'target' },
      { op: 'close', positionId: 5, price: 99, reason: 'stop' },
      { op: 'attribution' },
    ],
  },
};

const errMsg = (fn) => { try { return fn(); } catch (err) { return { error: String(err.message) }; } };
const tryJson = (s) => { try { return JSON.parse(s); } catch { return s; } };

function stateOf(dbPath, cfg) {
  const v = portfolioView(dbPath, cfg);
  return {
    cash: v.cash, marginLocked: v.marginLocked, unrealized: v.unrealized, equity: v.equity, halted: v.halted,
    realizedTotal: v.realizedTotal,
    positions: v.positions.map((p) => ({
      id: p.id, instrument: p.instrument, side: p.side, notional: p.notional, units: p.units, entry_price: p.entry_price,
      leverage: p.leverage, margin: p.margin, stop: p.stop, target: p.target, last_mark: p.last_mark, stale: p.stale, granularity: p.granularity,
    })),
    trades: [...v.trades].reverse().map((t) => ({
      position_id: t.position_id, instrument: t.instrument, side: t.side, notional: t.notional, units: t.units, entry_price: t.entry_price,
      close_price: t.close_price, leverage: t.leverage, realized: t.realized, close_reason: t.close_reason, granularity: t.granularity,
    })),
    journal: [...v.journal].reverse().map((j) => ({ action: j.action, position_id: j.position_id, reason: j.reason, context: j.context ? tryJson(j.context) : null })),
  };
}

function insertJournal(dbPath, action, context) {
  withDb(dbPath, (db) => {
    db.prepare('INSERT INTO bot_journal (at, action, position_id, reason, context) VALUES (?,?,NULL,NULL,?)')
      .run('2026-01-05T00:00:00.000Z', action, context);
  });
}

async function replayScenario(input) {
  const dir = mkdtempSync(join(tmpdir(), 'golden-'));
  const dbPath = join(dir, 'golden.sqlite');
  try {
    const cfg = botConfig({ bot: input.config.bot }, 'golden/no-such-spreads.json');
    cfg.spreads = input.config.spreads ?? {};
    if (input.config.allocationPct) cfg.allocationPct = input.config.allocationPct;
    portfolioView(dbPath, cfg); // seeds the portfolio and schema
    const results = [];
    for (const s of input.steps) {
      switch (s.op) {
        case 'open': {
          const { op, ...args } = s;
          results.push(errMsg(() => ({ positionId: openPosition(dbPath, cfg, args) })));
          break;
        }
        case 'close':
          results.push(errMsg(() => closePosition(dbPath, cfg, s.positionId, s.price, s.reason)));
          break;
        case 'fills':
          results.push(simulateFills(dbPath, cfg, s.instrument, s.candle));
          break;
        case 'mark': {
          const m = markToMarket(dbPath, cfg, s.quotes);
          results.push({ closed: m.closed, cash: m.cash, marginLocked: m.marginLocked, unrealized: m.unrealized, equity: m.equity, halted: m.halted });
          break;
        }
        case 'journal':
          insertJournal(dbPath, s.action, JSON.stringify(s.context));
          results.push(null);
          break;
        case 'journalRaw':
          insertJournal(dbPath, s.action, s.context);
          results.push(null);
          break;
        case 'runBot':
          results.push(await runBot(dbPath, input.settings, { instrument: s.instrument, granularity: s.granularity, candle: s.candle }));
          break;
        case 'resetHalt':
          results.push(performHaltReset(dbPath, input.settings));
          break;
        case 'attribution': {
          const attribution = positionAttribution(dbPath);
          const trades = stateOf(dbPath, cfg).trades;
          results.push({
            positions: [...attribution.entries()].sort((a, b) => a[0] - b[0]),
            trades: trades.map((t) => ({ position_id: t.position_id, granularity: granularityOf(t, attribution), combo: comboOf(t, attribution) })),
            scoreboard: strategyScoreboard(dbPath, cfg.startingBalance).map(({ firstTrade, lastTrade, ...rest }) => rest),
          });
          break;
        }
        default: throw new Error(`unknown step op: ${s.op}`);
      }
    }
    return round({ steps: results, final: stateOf(dbPath, cfg) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- public replay + build ----------------------------------------------------

export async function replayCase(area, input, series) {
  if (area === 'indicators') return input.kind === 'axis-snapshot' ? replaySnapshot(input, series) : replayIndicators(input, series);
  if (area === 'portfolio') return replayScenario(input);
  throw new Error(`unknown area: ${area}`);
}

const INDICATOR_CASES = [
  { name: 'walk100-all-indicators', input: { kind: 'indicators', series: 'walk100' } },
  { name: 'flat40-neutral-rsi-and-zero-range', input: { kind: 'indicators', series: 'flat40' } },
  { name: 'short5-warmup-and-supertrend-error', input: { kind: 'indicators', series: 'short5' } },
  { name: 'axis-snapshot-no-flip', input: { kind: 'axis-snapshot', series: 'walk240', flip: null } },
  { name: 'axis-snapshot-buy-flip', input: { kind: 'axis-snapshot', series: 'walk240', flip: 'buy' } },
  { name: 'axis-snapshot-sell-flip', input: { kind: 'axis-snapshot', series: 'walk240', flip: 'sell' } },
  { name: 'axis-snapshot-too-few-candles', input: { kind: 'axis-snapshot', series: 'short5', flip: 'buy' } },
];

export async function buildFixtures() {
  const usedSeries = (names) => Object.fromEntries(names.map((n) => [n, SERIES[n]]));
  const indicators = {
    version: FORMAT_VERSION, area: 'indicators',
    series: usedSeries([...new Set(INDICATOR_CASES.map((c) => c.input.series))]),
    cases: [],
  };
  for (const c of INDICATOR_CASES) {
    indicators.cases.push({ ...c, expected: await replayCase('indicators', c.input, indicators.series) });
  }
  const portfolio = { version: FORMAT_VERSION, area: 'portfolio', cases: [] };
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    const input = { kind: 'scenario', ...scenario };
    portfolio.cases.push({ name, input, expected: await replayCase('portfolio', input) });
  }
  return { 'indicators.json': indicators, 'portfolio.json': portfolio };
}

// Indented, but arrays of scalars stay on one line to keep the files small.
export const serialize = (obj) => `${JSON.stringify(obj, null, 1).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_, body) => `[${body.replace(/\s*\n\s*/g, ' ')}]`)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = await buildFixtures();
  const write = process.argv.includes('--write');
  let drift = 0;
  for (const [name, obj] of Object.entries(files)) {
    const path = join(GOLDEN_DIR, name);
    const text = serialize(obj);
    if (write) { writeFileSync(path, text); process.stdout.write(`wrote ${name} (${text.length} bytes)\n`); continue; }
    let onDisk = null;
    try { onDisk = readFileSync(path, 'utf8'); } catch { /* missing counts as drift */ }
    if (onDisk !== text) { drift++; process.stderr.write(`drift: ${name} differs from the engine output (run with --write to re-record)\n`); }
  }
  process.exit(drift ? 1 : 0);
}
