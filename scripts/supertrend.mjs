#!/usr/bin/env node
/**
 * Supertrend signal + inline backtest over Oanda M5 candles (fxempire proxy).
 *
 * Computes Supertrend(period, multiplier) on complete candles, reports the
 * current trend, the last flip (buy/sell signal), and a naive flip-following
 * backtest over the fetched window so every alert carries its own track record.
 *
 * Usage:
 *   node scripts/supertrend.mjs --instrument BCO/USD [--granularity M5]
 *     [--count 500] [--period 10] [--multiplier 3] [--freshBars 2] [--pretty true]
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

const dbg = (msg) => process.stderr.write(`[supertrend] ${msg}\n`);
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const USAGE = `supertrend — Supertrend flip signals + inline backtest.

Options:
  --instrument <sym>    candle symbol, see config/candle-symbols.json (default: BCO/USD)
  --granularity <g>     M1|M5|M15|H1|... (default: M5)
  --count <n>           candles to fetch (default: 500)
  --period <n>          ATR period (default: 10)
  --multiplier <x>      ATR multiplier (default: 3)
  --freshBars <n>       flip within last n complete bars counts as fresh (default: 2)
  --db <path>           sqlite file to upsert fetched candles into (default: data/candles.db, "" to skip)
  --notify true|false   send a macOS notification on a fresh, not-yet-alerted flip (default: false)
  --settings <path>     opt-in LLM filter config, JSON with OPENAI_API_KEY or
                        ANTHROPIC_API_KEY, or {"provider": "pi"} to use the pi
                        coding agent CLI [, model, notesFile, piBin]
                        (default: data/settings.json; no file = no filter, alerts pass through)
  --pretty true|false   (default: true)
  -h, --help
`;

const SIGNALS_DDL = `CREATE TABLE IF NOT EXISTS signals (
  instrument TEXT NOT NULL, granularity TEXT NOT NULL, time TEXT NOT NULL,
  signal TEXT NOT NULL, price REAL, win_rate REAL,
  verdict TEXT, reason TEXT, notified INTEGER DEFAULT 0,
  PRIMARY KEY (instrument, granularity, time)
)`;

const CANDLES_DDL = `CREATE TABLE IF NOT EXISTS candles (
  instrument TEXT NOT NULL, granularity TEXT NOT NULL, time TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  PRIMARY KEY (instrument, granularity, time)
)`;

// Every DB access goes through here: schema ensured on open, handle always closed.
export function withDb(dbPath, fn) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    // cross-process writers (bot loop + server share this file) wait up to 5s
    // for the lock instead of throwing SQLITE_BUSY immediately; a writer can
    // still see SQLITE_BUSY if the lock outlives the timeout
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(CANDLES_DDL);
    db.exec(SIGNALS_DDL);
    return fn(db);
  } finally {
    db.close();
  }
}

// Signal memory: every fresh flip is recorded once (PK doubles as alert dedup).
export function recordSignal(dbPath, instrument, granularity, sig, winRatePct) {
  return withDb(dbPath, (db) => {
    const r = db.prepare('INSERT OR IGNORE INTO signals (instrument, granularity, time, signal, price, win_rate) VALUES (?,?,?,?,?,?)')
      .run(instrument, granularity, sig.time, sig.signal, sig.price, winRatePct);
    return { isNew: r.changes > 0 };
  });
}

function updateSignal(dbPath, instrument, granularity, time, verdict, reason, notified) {
  withDb(dbPath, (db) => db.prepare('UPDATE signals SET verdict=?, reason=?, notified=? WHERE instrument=? AND granularity=? AND time=?')
    .run(verdict, reason, notified, instrument, granularity, time));
}

// Past signals with their realized direction-adjusted move `horizonBars` later,
// joined from the accumulated candles table — the filter's track record.
export function signalOutcomes(dbPath, instrument, granularity, { horizonBars = 6, limit = 20, time = null } = {}) {
  return withDb(dbPath, (db) => {
    const sigs = time
      ? db.prepare('SELECT * FROM signals WHERE instrument=? AND granularity=? AND time=?').all(instrument, granularity, time)
      : db.prepare('SELECT * FROM signals WHERE instrument=? AND granularity=? ORDER BY time DESC LIMIT ?').all(instrument, granularity, limit);
    const after = db.prepare('SELECT close FROM candles WHERE instrument=? AND granularity=? AND time > ? ORDER BY time LIMIT 1 OFFSET ?');
    return sigs.map((s) => {
      const c = after.get(instrument, granularity, s.time, horizonBars - 1);
      const dir = s.signal === 'buy' ? 1 : -1;
      const outcomePct = c && s.price ? Number((dir * (c.close - s.price) / s.price * 100).toFixed(3)) : null;
      return { ...s, outcomePct };
    });
  });
}

// Split so a chat-drafted override (issue #58) can only ever replace the
// advisory RULES text — the JSON verdict instruction stays code-owned and is
// always appended server-side, so a draft can never break parsing.
export const FILTER_RULES = 'You filter intraday supertrend flip alerts for a leveraged oil/index CFD trader. Given the current flip, recent candles, the fetched-window backtest, past signals with realized 30-minute outcomes, and the trader\'s notes, decide if this alert deserves attention. Timestamps are in the trader\'s local timezone (current.timezone) — quote them as-is. Suppress likely chop: rapidly alternating recent flips with negative outcomes, price mid-range, weak impulse. Use volumeContext: a flip on volume well above the recent average is conviction; a flip on thin volume is suspect. When present, traderMemories lists the trader\'s standing rules — advisory context, never a substitute for the chop/volume checks above. When present, a sentinel block carries cached breaking-news headlines and an escalation flag from free geopolitical/macro sources — advisory context to weigh, never a reason to bypass the chop/volume checks above.';
export const FILTER_SCHEMA_SUFFIX = ' Reply JSON: {"alert": boolean, "reason": "<max 90 chars>"}.';
const FILTER_SYSTEM = FILTER_RULES + FILTER_SCHEMA_SUFFIX;

// Resolves the filter's effective system prompt: an active gate-prompt
// override when present (advisory rules text only — the schema suffix is
// ALWAYS appended here, outside the override, so a draft can never change the
// verdict contract), else the shipped FILTER_SYSTEM constant. promptVersion
// ('builtin' or the override's version) rides into filter provenance so
// verdicts are attributable to the exact text that produced them.
export async function resolveFilterSystem(dbPath) {
  if (dbPath) {
    try {
      // lazy import: avoids a static cycle (gate-prompts.mjs imports withDb from here)
      const { activeGatePrompt } = await import('./gate-prompts.mjs');
      const override = activeGatePrompt(dbPath, 'filter');
      if (override) return { system: override.prompt + FILTER_SCHEMA_SUFFIX, promptVersion: override.version };
    } catch {
      // prompt resolution is part of the filter surface: a locked/corrupt DB must
      // fall back to the builtin prompt, never break the alert path (fail-open)
    }
  }
  return { system: FILTER_SYSTEM, promptVersion: 'builtin' };
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: { alert: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['alert', 'reason'],
  additionalProperties: false,
};

// Dedicated re-check gate (issue #70): NOT the filter prompt — the filter
// judges a fresh flip, this judges a flip already alerted on, well after the
// fact, against everything that has happened since. Same split as FILTER_*:
// the advisory rules text is chat/settings-overridable, the JSON schema
// instruction is code-owned and always appended server-side.
export const RECHECK_RULES = 'You re-check a supertrend flip alert some time after it fired, for a leveraged oil/index CFD trader. Given the original flip (time, side, entry price), the axis-gate snapshot recorded at flip time, the candles and price path since the flip, and the realized excursion (current, best, and worst direction-adjusted move since entry, as a percent of entry price), decide whether the setup is: valid (the original thesis still holds, no clear invalidation yet), played-out (the anticipated move already happened — entering or holding now is chasing a stale edge), or invalidated (price action broke the thesis, e.g. it reversed back through the flip level or the trend rolled over). Timestamps are already in the trader\'s local timezone — quote them as-is.';
export const RECHECK_SCHEMA_SUFFIX = ' Reply JSON: {"verdict": "valid" | "played-out" | "invalidated", "reason": "<max 90 chars>"}.';
const RECHECK_SYSTEM = RECHECK_RULES + RECHECK_SCHEMA_SUFFIX;

// Mirrors resolveFilterSystem exactly, for the 'recheck' gate.
export async function resolveRecheckSystem(dbPath) {
  if (dbPath) {
    try {
      const { activeGatePrompt } = await import('./gate-prompts.mjs');
      const override = activeGatePrompt(dbPath, 'recheck');
      if (override) return { system: override.prompt + RECHECK_SCHEMA_SUFFIX, promptVersion: override.version };
    } catch {
      // fail-open: a locked/corrupt db must never block an operator-initiated re-check
    }
  }
  return { system: RECHECK_SYSTEM, promptVersion: 'builtin' };
}

const RECHECK_SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['valid', 'played-out', 'invalidated'] }, reason: { type: 'string' } },
  required: ['verdict', 'reason'],
  additionalProperties: false,
};
const RECHECK_VERDICTS = ['valid', 'played-out', 'invalidated'];

// Provider picked by settings: {"provider": "pi"} shells out to the pi coding
// agent (its own provider/key config applies); else by which API key is present
// (ANTHROPIC wins if both).
// Single source of provider precedence: explicit pi/none, else key-based.
// The one allow-list: resolution here and the settings write-validation in
// signal-server.mjs both consume this (drift between them would let a stored
// provider bypass explicit resolution).
export const PROVIDERS = ['pi', 'none', 'anthropic', 'openai'];

export function resolveProvider(settings) {
  // explicit-first (#42): the provider is a deliberate choice; the key-derived
  // fallback exists only for legacy settings written before providers were
  // explicit (the UI pre-selects the resolved value and persists it on save)
  if (PROVIDERS.includes(settings.provider)) return settings.provider;
  if (settings.ANTHROPIC_API_KEY) return 'anthropic';
  if (settings.OPENAI_API_KEY) return 'openai';
  return 'none';
}

// The ONE OpenAI-compatible endpoint resolution (#42): a configured base URL
// points every OpenAI-path request (chat, filter, bot, judge, tool loop) at an
// API-compatible server; the model id passes through unchanged.
export function openaiEndpoint(settings) {
  // tolerate the common SDK convention of a base URL already ending in /v1
  const base = (settings.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${base}/v1/chat/completions`;
}

// The one "effective model id" resolution (#93): mirrors the per-provider
// defaults baked into the request bodies below, so the MS_DEBUG_LLM
// header/log surface can never drift from what was actually sent.
export function effectiveModel(settings, provider) {
  if (provider === 'anthropic') return settings.model || 'claude-opus-4-8';
  if (provider === 'openai') return settings.model || 'gpt-5.4-mini';
  return settings.model || null;
}

// #93: usage capture is purely additive debug telemetry — a bad onUsage
// callback (or a provider omitting usage) must never break the actual
// request/response path.
export function reportUsage(onUsage, info) {
  if (typeof onUsage !== 'function') return;
  // debug callback errors never break the request — cover BOTH a synchronous
  // throw and an async callback whose returned promise rejects later
  try {
    const r = onUsage(info);
    if (r && typeof r.then === 'function') r.catch(() => {});
  } catch { /* swallow */ }
}

// provider=openai without a key would send "Bearer undefined" and die with an
// opaque upstream error — fail fast with a message that names the fix
function requireAnthropicKey(settings) {
  if (!settings.ANTHROPIC_API_KEY) throw new Error('provider "anthropic" selected but ANTHROPIC_API_KEY is not set');
  return settings.ANTHROPIC_API_KEY;
}

function requireOpenAiKey(settings) {
  if (!settings.OPENAI_API_KEY) throw new Error('provider "openai" selected but OPENAI_API_KEY is not set');
  return settings.OPENAI_API_KEY;
}

// Streaming SSE reader shared by both API providers: calls extract(json) per
// `data:` event, invokes onDelta with each text piece, returns the full text.
async function readSse(res, extract, onDelta) {
  let full = '';
  let buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let piece = null;
      try { piece = extract(JSON.parse(data)); } catch { /* keepalive/partial */ }
      if (piece) {
        full += piece;
        if (onDelta) onDelta(piece);
      }
    }
  }
  // Flush the decoder and any final line without a trailing newline.
  buf += dec.decode();
  const tail = buf.trim();
  if (tail.startsWith('data:')) {
    try {
      const piece = extract(JSON.parse(tail.slice(5).trim()));
      if (piece) {
        full += piece;
        if (onDelta) onDelta(piece);
      }
    } catch { /* not a data event */ }
  }
  return full;
}

// #98: OpenAI-compatible reasoning models (e.g. GLM) spend max_completion_tokens
// on internal reasoning before emitting content — on large filter/bot prompts a
// small call-site budget (e.g. 1024) is exhausted by reasoning alone, returning
// finish_reason:'length' with content:null. This floor is generous enough for
// reasoning overhead on top of a small JSON reply; operators can raise it
// further via settings.maxCompletionTokens for heavier-reasoning models.
export const OPENAI_REASONING_FLOOR = 8192;

// The openai-compatible path's completion budget: call-site maxTokens is a
// per-request minimum, but reasoning models need real headroom beyond that —
// never below the (settings-configurable) reasoning floor. Anthropic/pi keep
// their own call-site maxTokens unchanged; reasoning-budget exhaustion is an
// openai-compatible-model concern only.
function openaiCompletionBudget(settings, maxTokens) {
  const floor = settings.maxCompletionTokens > 0 ? settings.maxCompletionTokens : OPENAI_REASONING_FLOOR;
  return Math.max(maxTokens, floor);
}

// Single provider dispatch. schema => JSON-constrained (non-streaming);
// onDelta => streamed tokens for the API providers (pi replies whole).
// Always tool-less: the chat's tool surface lives in the dedicated tool loops.
export async function llmRequest(settings, system, user, { schema = null, maxTokens = 1024, timeoutMs = 90000, onDelta = null, temperature = null, onUsage = null } = {}) {
  const provider = resolveProvider(settings);
  if (provider === 'none') throw new Error('no provider configured');
  if (provider === 'pi') {
    // ponytail: absolute default path because launchd's PATH lacks /opt/homebrew/bin
    const args = ['-p', '--no-session', '--no-tools', '--system-prompt', system];
    if (settings.model) args.push('--model', settings.model);
    args.push(user);
    let out;
    try {
      out = execFileSync(settings.piBin || '/opt/homebrew/bin/pi', args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        // launchd's PATH lacks the brew prefixes; pi's shebang needs node on PATH.
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
      }).trim();
    } catch (err) {
      // execFileSync errors embed the full command (incl. the prompt) — never propagate that.
      const stderr = (err.stderr ? String(err.stderr) : '').trim().split('\n').pop() || '';
      throw new Error(`pi failed: ${stderr || err.code || `exit ${err.status}`}`.slice(0, 200));
    }
    if (onDelta) onDelta(out); // pi cannot stream: one whole delta
    // pi has no structured usage to report — provider/model still surfaced,
    // usage is always null here, never faked (#93).
    reportUsage(onUsage, { provider: 'pi', model: settings.model || null, usage: null });
    return out;
  }
  if (provider === 'anthropic') {
    const stream = Boolean(onDelta) && !schema;
    const model = effectiveModel(settings, 'anthropic');
    const body = {
      model,
      max_tokens: maxTokens,
      ...(temperature != null ? { temperature } : {}),
      system,
      messages: [{ role: 'user', content: user }],
    };
    if (schema) body.output_config = { format: { type: 'json_schema', schema } };
    if (stream) body.stream = true;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': requireAnthropicKey(settings), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    if (stream) {
      // ponytail: real token-level SSE usage (message_start/message_delta) isn't
      // parsed here — this streamed path only ever runs tool-less/schema-less,
      // which nothing in this codebase currently exercises for anthropic/openai
      // (chat's tool loop covers the real streaming UI case); onUsage is simply
      // not called rather than faking a count.
      return readSse(res, (j) => (j.type === 'content_block_delta' && j.delta?.type === 'text_delta' ? j.delta.text : null), onDelta);
    }
    const data = await res.json();
    if (data.stop_reason === 'refusal') throw new Error('anthropic refusal');
    reportUsage(onUsage, { provider: 'anthropic', model, usage: data.usage ? { inputTokens: data.usage.input_tokens ?? null, outputTokens: data.usage.output_tokens ?? null } : null });
    const textBlock = Array.isArray(data.content) ? data.content.find((b) => b.type === 'text') : null;
    if (!textBlock) throw new Error(`anthropic returned no text block (stop_reason=${data.stop_reason})`);
    return textBlock.text;
  }
  {
    const stream = Boolean(onDelta) && !schema;
    const model = effectiveModel(settings, 'openai');
    const budget = openaiCompletionBudget(settings, maxTokens);
    const body = {
      model,
      max_completion_tokens: budget,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    if (temperature != null) body.temperature = temperature;
    if (schema) body.response_format = { type: 'json_object' };
    if (stream) body.stream = true;
    const res = await fetch(openaiEndpoint(settings), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${requireOpenAiKey(settings)}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`openai HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    if (stream) {
      // see the anthropic branch's ponytail note above: same asymmetry, same reason.
      const streamed = await readSse(res, (j) => j.choices?.[0]?.delta?.content ?? null, onDelta);
      // a reasoning model can burn the whole (now floored) budget on reasoning and
      // stream zero content — surface that instead of a silent empty reply
      if (!streamed) throw new Error(`openai provider streamed no content (a reasoning model likely exhausted max_completion_tokens=${budget} — raise maxCompletionTokens)`);
      return streamed;
    }
    const data = await res.json();
    reportUsage(onUsage, { provider: 'openai', model, usage: data.usage ? { inputTokens: data.usage.prompt_tokens ?? null, outputTokens: data.usage.completion_tokens ?? null } : null });
    const choice = data.choices?.[0];
    if (!choice?.message) throw new Error(`openai provider returned no choice/message (malformed response${data.error ? ': ' + JSON.stringify(data.error).slice(0, 100) : ''})`);
    const content = choice.message.content;
    if (content == null || content === '') {
      const finishReason = choice.finish_reason;
      throw new Error(`openai provider returned no content (finish_reason=${finishReason}; a reasoning model likely exhausted max_completion_tokens=${budget} — raise maxCompletionTokens)`);
    }
    return content;
  }
}

// Tool-use loop for the API providers: runs custom tools via execTool until the
// model stops asking. Non-streaming rounds; emits status deltas so the UI shows
// progress, then the final text as one delta.
async function anthropicToolLoop(settings, system, user, { maxTokens, timeoutMs, onDelta, toolDefs, execTool, onUsage }) {
  const tools = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
    ...toolDefs.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
  ];
  const model = effectiveModel(settings, 'anthropic');
  const messages = [{ role: 'user', content: user }];
  // #93: usage isn't known until the loop's final round, so rounds accumulate
  // into these and report once, at the end, instead of per-round.
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  for (let round = 0; round < 8; round++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': requireAnthropicKey(settings), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, tools, messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const data = await res.json();
    if (data.usage) {
      sawUsage = true;
      inputTokens += data.usage.input_tokens ?? 0;
      outputTokens += data.usage.output_tokens ?? 0;
    }
    if (data.stop_reason === 'refusal') throw new Error('anthropic refusal');
    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: data.content });
      continue;
    }
    if (!Array.isArray(data.content)) throw new Error(`anthropic returned no content array (stop_reason=${data.stop_reason})`);
    if (data.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: data.content });
      const results = [];
      for (const block of data.content.filter((b) => b.type === 'tool_use')) {
        if (onDelta) onDelta(`[${block.name}…]\n`);
        let out;
        let isError = false;
        try { out = await execTool(block.name, block.input); } catch (err) { out = err.message; isError = true; }
        results.push({ type: 'tool_result', tool_use_id: block.id, content: String(out).slice(0, 8000), is_error: isError });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (onDelta) onDelta(text);
    reportUsage(onUsage, { provider: 'anthropic', model, usage: sawUsage ? { inputTokens, outputTokens } : null });
    return text;
  }
  throw new Error('tool loop exceeded 8 rounds');
}

async function openaiToolLoop(settings, system, user, { maxTokens, timeoutMs, onDelta, toolDefs, execTool, onUsage }) {
  const tools = toolDefs.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const model = effectiveModel(settings, 'openai');
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  // #93: same round-aggregation as anthropicToolLoop above.
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  const budget = openaiCompletionBudget(settings, maxTokens);
  for (let round = 0; round < 8; round++) {
    const res = await fetch(openaiEndpoint(settings), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${requireOpenAiKey(settings)}` },
      body: JSON.stringify({ model, max_completion_tokens: budget, tools, messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`openai HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const data = await res.json();
    if (data.usage) {
      sawUsage = true;
      inputTokens += data.usage.prompt_tokens ?? 0;
      outputTokens += data.usage.completion_tokens ?? 0;
    }
    const msg = data.choices[0].message;
    if (msg.tool_calls?.length) {
      messages.push(msg);
      for (const call of msg.tool_calls) {
        if (onDelta) onDelta(`[${call.function.name}…]\n`);
        let out;
        try { out = await execTool(call.function.name, JSON.parse(call.function.arguments || '{}')); } catch (err) { out = `error: ${err.message}`; }
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(out).slice(0, 8000) });
      }
      continue;
    }
    if (msg.content == null || msg.content === '') {
      const finishReason = data.choices[0].finish_reason;
      throw new Error(`openai provider returned no content (finish_reason=${finishReason}; a reasoning model likely exhausted max_completion_tokens=${budget} — raise maxCompletionTokens)`);
    }
    if (onDelta) onDelta(msg.content);
    reportUsage(onUsage, { provider: 'openai', model, usage: sawUsage ? { inputTokens, outputTokens } : null });
    return msg.content;
  }
  throw new Error('tool loop exceeded 8 rounds');
}

// Free-form ask against the configured provider (used by the chat sidebar).
export async function llmChat(settings, system, user, { onDelta = null, toolDefs = null, execTool = null, onUsage = null } = {}) {
  const provider = resolveProvider(settings);
  const opts = { maxTokens: 2048, timeoutMs: 180000, onDelta, toolDefs, execTool, onUsage };
  if (toolDefs && execTool && provider === 'anthropic') return anthropicToolLoop(settings, system, user, opts);
  if (toolDefs && execTool && provider === 'openai') return openaiToolLoop(settings, system, user, opts);
  // pi (and tool-less fallbacks): context only — the sole tool surface is the
  // clamped skill registry via the API providers' native tool-calling.
  return llmRequest(settings, system, user, { maxTokens: 2048, timeoutMs: 180000, onDelta, onUsage });
}

// Watcher runs on the trader's machine: state times in the machine's local
// zone so filter reasons and notifications match the chart axis (#34).
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
// The one encoding of "trader-local time" for LLM transmission (#34): HH:MM for
// candles, DD/MM HH:MM for signals. Server passes the browser tz; watcher the
// machine tz. Invalid tz falls back to UTC.
export function localTimeFormatters(tz) {
  try {
    const hmF = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const fullF = new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    return { tz, hm: (iso) => hmF.format(new Date(iso)), full: (iso) => fullF.format(new Date(iso)).replace(/,\s*/, ' ') };
  } catch {
    return localTimeFormatters('UTC');
  }
}
const LOCAL_FMT = localTimeFormatters(LOCAL_TZ);
export const localHm = LOCAL_FMT.hm;
export const localFull = LOCAL_FMT.full;

// #93: `[llm] <tag> <provider> <model> in=<n> out=<n>` — shared by processSignal's
// filter (below) and bot.mjs's deliberate() so the MS_DEBUG_LLM one-liner
// never drifts between the two background-completion call sites.
export function llmUsageLine(tag, info) {
  if (!info) return `[llm] ${tag} usage unavailable`;
  const { provider, model, usage } = info;
  const tok = (v) => (v == null ? 'n/a' : v);
  return `[llm] ${tag} ${provider} ${model ?? 'default'} in=${usage ? tok(usage.inputTokens) : 'n/a'} out=${usage ? tok(usage.outputTokens) : 'n/a'}`;
}

async function llmVerdict(settings, payload, system, onUsage) {
  const out = await llmRequest(settings, system, JSON.stringify(payload), { schema: VERDICT_SCHEMA, timeoutMs: settings.provider === 'pi' ? 90000 : 30000, onUsage });
  // API providers return pure JSON under schema mode; regex is the pi fallback
  // (its output may wrap the JSON in prose) and can't handle braces in reason.
  try {
    const whole = JSON.parse(out);
    if (typeof whole.alert === 'boolean') return whole;
  } catch { /* fall through */ }
  const m = String(out).match(/\{[^{}]*"alert"[^{}]*\}/);
  if (!m) throw new Error('no verdict JSON in provider output');
  return JSON.parse(m[0]);
}

// Schema mode constrains type shape, not content — a provider can still return
// a non-string/empty reason. Normalize (never persist null/undefined as the
// UI's re-check reason line) and reject anything that isn't a valid verdict,
// same "trust nothing past the wire" stance as the pi regex fallback below.
function normalizeRecheckVerdict(v) {
  if (!RECHECK_VERDICTS.includes(v?.verdict)) return null;
  const reason = typeof v.reason === 'string' ? v.reason.trim().slice(0, 90) : '';
  if (!reason) return null;
  return { verdict: v.verdict, reason };
}

async function llmRecheckVerdict(settings, payload, system, onUsage) {
  const out = await llmRequest(settings, system, JSON.stringify(payload), { schema: RECHECK_SCHEMA, timeoutMs: settings.provider === 'pi' ? 90000 : 30000, onUsage });
  try {
    const whole = JSON.parse(out);
    const norm = normalizeRecheckVerdict(whole);
    if (norm) return norm;
  } catch { /* fall through to the pi regex fallback */ }
  const m = String(out).match(/\{[^{}]*"verdict"[^{}]*\}/);
  if (!m) throw new Error('no recheck verdict JSON in provider output');
  const parsed = JSON.parse(m[0]);
  const norm = normalizeRecheckVerdict(parsed);
  if (!norm) throw new Error(`invalid recheck verdict "${parsed.verdict}"${parsed.reason == null ? ' (missing reason)' : ''}`);
  return norm;
}

export function readSettings(settingsPath) {
  try { return JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { return {}; }
}

// Delivery: terminal-notifier when installed (the notification itself opens the
// deep link), else osascript (not clickable). Both bounded by a 10s timeout.
export function sendNotification(msg, deepLink, settings = {}) {
  const clean = msg.replace(/[\\"]/g, '').replace(/\s+/g, ' ');
  // An EXPLICITLY configured notifierBin is authoritative: if it does not
  // exist, notifications are deliberately suppressed (tests pin a missing path
  // for exactly this) — the osascript fallback applies only when nothing was
  // configured. Without this, every test run pops phantom AppleScript
  // notifications with fixture numbers.
  if (settings.notifierBin && !existsSync(settings.notifierBin)) {
    dbg(`notifierBin ${settings.notifierBin} missing — notification suppressed`);
    return;
  }
  // Test-suite guard: MS_NO_NOTIFY (set by `npm test`) suppresses only the
  // FALLBACK candidates (unconfigured terminal-notifier/osascript paths) —
  // prod is unaffected since the env var is never set outside tests, and an
  // explicitly-configured, EXISTING notifierBin (tests that assert delivery
  // args pin a real recorder-script fixture) still proceeds normally. This
  // makes it structural: no test can ever reach a real notifier, because the
  // fallbacks are dead under MS_NO_NOTIFY and any configured bin is a fixture.
  if (!settings.notifierBin && process.env.MS_NO_NOTIFY) {
    dbg('MS_NO_NOTIFY set — notification suppressed (no notifierBin configured)');
    return;
  }
  const candidates = settings.notifierBin
    ? [settings.notifierBin]
    : ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier'];
  const notifier = candidates.find((p) => existsSync(p));
  if (notifier) {
    try {
      execFileSync(notifier, ['-title', 'market-signals', '-message', clean, '-open', deepLink, '-sound', 'Glass'], { timeout: 10000 });
      return;
    } catch (err) {
      // A present-but-broken notifier install must not cost the alert.
      dbg(`terminal-notifier failed (${err.message.split('\n')[0]}); falling back to osascript`);
    }
  }
  execFileSync('osascript', ['-e', `display notification "${clean}" with title "market-signals" sound name "Glass"`], { timeout: 10000 });
}

// Default: pi coding agent if installed, else env API keys, else no filter.
// Shared by the watcher's alert filter (processSignal) and the operator's
// recheckSignal button — both fall back the same way when settings.json
// leaves the provider unset (mutates and returns settings for convenience).
export function applyProviderDefault(settings) {
  if (!settings.provider && !settings.OPENAI_API_KEY && !settings.ANTHROPIC_API_KEY) {
    if (existsSync(settings.piBin || '/opt/homebrew/bin/pi')) settings.provider = 'pi';
    else {
      settings.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      settings.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }
  }
  return settings;
}

export async function processSignal(opts, result, candles) {
  const sig = result.signal;
  if (!sig?.fresh) return { sent: false, reason: 'no fresh flip' };
  if (!opts.db) return { sent: false, reason: 'signal persistence requires --db' };
  const granMs = granularityMs(opts.granularity);
  const sigMs = Date.parse(sig.time);
  const nearby = signalOutcomes(opts.db, opts.instrument, opts.granularity, { limit: 10 })
    .find((s) => s.time !== sig.time && Math.abs(Date.parse(s.time) - sigMs) <= 3 * granMs);
  const { isNew } = recordSignal(opts.db, opts.instrument, opts.granularity, sig, result.backtest.winRatePct);
  if (!isNew) return { sent: false, reason: 'already processed' };
  if (nearby) {
    // Same flip re-detected on a shifted candle window: lock in the original,
    // record this row for audit, never notify twice.
    updateSignal(opts.db, opts.instrument, opts.granularity, sig.time, 'duplicate', `re-detection of ${nearby.time}`, 0);
    dbg(`suppressed duplicate of ${nearby.time} (flip re-detected at ${sig.time})`);
    return { sent: false, reason: `duplicate of ${nearby.time}`, verdictSource: 'cooldown' };
  }
  if (!opts.notify) return { sent: false, reason: 'recorded (notify off)' };

  const settings = applyProviderDefault(readSettings(opts.settings));
  const hasFilter = resolveProvider(settings) !== 'none';
  dbg(`fresh ${sig.signal} flip at ${sig.time} (barsAgo ${sig.barsAgo}); filter=${hasFilter ? (settings.provider === 'pi' ? 'pi' : settings.ANTHROPIC_API_KEY ? 'anthropic' : 'openai') : 'off'}`);

  // Axis-grouped gate snapshot (#32): computed once per fresh signal, fed to
  // the filter, and recorded for backtesting; lazy import avoids a load cycle.
  let gateSnapshot = null;
  try {
    const { axisSnapshot } = await import('./axis-snapshot.mjs');
    // signal-time truth: freshBars admits flips up to N bars old — the snapshot
    // must judge the FLIP bar (and share its timestamp for the outcome join),
    // never bars that closed afterwards
    const flipCandles = Number.isInteger(sig.index) ? candles.slice(0, sig.index + 1) : candles;
    gateSnapshot = axisSnapshot(flipCandles, { instrument: opts.instrument, granularity: opts.granularity, flip: { signal: sig.signal } });
  } catch (err) { dbg(`axis snapshot failed: ${err.message}`); }

  let verdict = null;
  let verdictSource = 'none';
  let promptVersion = null;
  let promptSystemText = null;
  if (hasFilter) {
    let notes = '';
    try { notes = readFileSync(settings.notesFile || 'data/notes.md', 'utf8').slice(-1500); } catch { /* optional */ }
    const history = signalOutcomes(opts.db, opts.instrument, opts.granularity).filter((s) => s.time !== sig.time);
    dbg(`filter context: ${history.length} past signals, ${notes.length} chars of notes`);
    // lazy import: avoids a static cycle (memories.mjs imports withDb from here)
    const { memoriesContext } = await import('./memories.mjs');
    // lazy import: avoids a static cycle (news.mjs imports withDb from here)
    const { newsContextFor } = await import('./news.mjs');
    // Resolved once, before the network/pi call, so promptVersion lands in
    // provenance ('builtin' or the active override's version) whether or not
    // the filter call itself succeeds.
    const filterSystem = await resolveFilterSystem(opts.db);
    promptVersion = filterSystem.promptVersion;
    promptSystemText = filterSystem.system;
    // MS_DEBUG_LLM (#93): a local dev flag, not a persisted setting — off is a
    // zero-cost, zero-behavior-change no-op (no log line, no callback at all).
    const onUsage = process.env.MS_DEBUG_LLM ? (info) => dbg(llmUsageLine('filter', info)) : null;
    try {
      verdict = await llmVerdict(settings, {
        current: { ...sig, time: localHm(sig.time), timezone: LOCAL_TZ, close: result.close, trend: result.trend, supertrend: result.supertrend, granularity: opts.granularity },
        backtestWindow: { winRatePct: result.backtest.winRatePct, totalReturnPct: result.backtest.totalReturnPct, trades: result.backtest.trades },
        recentCandles: candles.slice(-12).map((c) => ({ t: localHm(c.time), o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume ?? null })),
        volumeContext: (() => {
          const flip = candles[sig.index] ?? candles[candles.length - 1];
          const win = candles.slice(-21, -1).map((c) => c.volume || 0);
          const avg20 = win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
          return { flipVolume: flip?.volume ?? null, avg20: avg20 && Number(avg20.toFixed(1)), ratio: avg20 && flip?.volume ? Number((flip.volume / avg20).toFixed(2)) : null };
        })(),
        pastSignals30mOutcomes: history.map((s) => ({ time: localFull(s.time), signal: s.signal, price: s.price, verdict: s.verdict, outcomePct: s.outcomePct })),
        axisGate: gateSnapshot?.axes ?? null,
        traderNotes: notes,
        traderMemories: memoriesContext(opts.db) || undefined,
        sentinel: newsContextFor(opts.db, opts.instrument) || undefined,
      }, filterSystem.system, onUsage);
      verdictSource = 'llm';
    } catch (err) {
      // ponytail: fail open — a missed alert costs more than a noisy one
      verdict = { alert: true, reason: `filter error: ${err.message}`.slice(0, 90) };
      verdictSource = 'error';
    }
    dbg(`verdict (${verdictSource}): ${JSON.stringify(verdict)}`);
  }

  // Snapshot recording (schema shared with #26/#40) runs AFTER the alert
  // decision/notification — backtest-capture I/O (incl. the up-to-20s headline
  // fetch behind snapshotContext) must never delay a real-time notification.
  const recordGate = async () => {
    try {
      const { recordSnapshot, promptHash } = await import('./axis-snapshot.mjs');
      let context = null;
      if (settings.snapshotContext === true) {
        // #40 decision 4: headline digest recorded AT signal time; sentiment is
        // scored by the replay judge from this block, never fetched at backtest.
        try {
          const raw = execFileSync(process.execPath, ['skills/fxempire-analysis/scripts/fxempire_articles.mjs', '--hours', '6', '--max-items', '3', '--json'], { encoding: 'utf8', timeout: 20000 });
          const parsed = JSON.parse(raw);
          context = { headlines: (parsed.articles || []).slice(0, 3).map((a) => a.title), capturedAt: sig.time };
        } catch { /* context capture is best-effort */ }
      }
      recordSnapshot(opts.db, gateSnapshot, {
        filterVerdict: verdict ? (verdict.alert === false ? 'suppress' : 'alert') : 'unfiltered',
        filterModel: hasFilter ? (settings.provider === 'pi' ? 'pi' : settings.model || (settings.ANTHROPIC_API_KEY ? 'anthropic-default' : 'openai-default')) : null,
        filterPromptHash: hasFilter ? promptHash(promptSystemText) : null,
        filterPromptVersion: promptVersion,
        context,
      });
    } catch (err) { dbg(`snapshot record failed: ${err.message}`); }
  };

  if (verdict && verdict.alert === false) {
    updateSignal(opts.db, opts.instrument, opts.granularity, sig.time, 'suppress', verdict.reason ?? null, 0);
    dbg('suppressed — no notification');
    await recordGate();
    return { sent: false, reason: `suppressed by filter: ${verdict.reason}`, verdictSource, gateSnapshot };
  }

  const wr = result.backtest.winRatePct;
  const lowConf = !verdict && wr !== null && wr < 30 ? ' [low-confidence]' : '';
  const extra = verdictSource === 'llm' && verdict?.reason ? ` — ${verdict.reason}` : '';
  const msg = `${opts.instrument} ${sig.signal.toUpperCase()} @ ${result.close} — flip ${localHm(sig.time)}, win rate ${wr ?? '?'}%${lowConf}${extra}`;
  const portNum = Number(settings.port);
  const port = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535 ? portNum : 8787;
  const deepLink = `http://127.0.0.1:${port}/?instrument=${encodeURIComponent(opts.instrument)}&granularity=${encodeURIComponent(opts.granularity)}&t=${encodeURIComponent(sig.time)}`;
  try {
    sendNotification(msg, deepLink, settings);
  } catch (err) {
    // Non-macOS or osascript failure: still record the verdict so the signal isn't lost.
    updateSignal(opts.db, opts.instrument, opts.granularity, sig.time, verdict ? 'alert' : 'unfiltered', verdict?.reason ?? null, 0);
    dbg(`notification failed: ${err.message}`);
    await recordGate();
    return { sent: false, reason: `notification failed: ${err.message}`, verdictSource, gateSnapshot };
  }
  updateSignal(opts.db, opts.instrument, opts.granularity, sig.time, verdict ? 'alert' : 'unfiltered', verdict?.reason ?? null, 1);
  dbg(`notification sent: ${msg}`);
  await recordGate();
  return { sent: true, message: msg, verdictSource, gateSnapshot };
}

// Direction-adjusted excursion since a signal, from the candles path itself
// (not a fixed 30-min horizon like signalOutcomes): current/best/worst move
// since entry, as a percent of entry price — the "everything since" half of
// the re-check's context.
// Single pass (not Math.max/min(...array)): a long-lived signal can have tens
// of thousands of candles since, and spreading that many args into Math.max
// throws "Maximum call stack size exceeded".
export function excursionSince(dir, entryPrice, candlesSince) {
  if (!entryPrice || !candlesSince.length) return null;
  let current = NaN;
  let maxFavorable = -Infinity;
  let maxAdverse = Infinity;
  for (const c of candlesSince) {
    current = (dir * (c.close - entryPrice)) / entryPrice * 100;
    if (current > maxFavorable) maxFavorable = current;
    if (current < maxAdverse) maxAdverse = current;
  }
  return {
    currentPct: round4(current),
    maxFavorablePct: round4(maxFavorable),
    maxAdversePct: round4(maxAdverse),
  };
}
const round4 = (v) => Number(v.toFixed(4));

// Operator-initiated re-check (issue #70) of an already-recorded signal:
// NEVER touches the signals/signal_snapshots rows — the flip, its axis
// snapshot, and the price path/excursion since are read-only context fed to
// the dedicated 'recheck' gate; the verdict is a NEW row in signal_rechecks.
export async function recheckSignal(dbPath, settingsPath, instrument, granularity, signal, onUsage = null) {
  const settings = applyProviderDefault(readSettings(settingsPath));
  if (resolveProvider(settings) === 'none') throw new Error('no LLM provider configured');
  // the candles table only ever holds complete bars (storeCandles filters
  // partial ticks before upserting) — no completeness filter needed here
  const candlesSince = withDb(dbPath, (db) => db.prepare(
    'SELECT * FROM candles WHERE instrument=? AND granularity=? AND time>=? ORDER BY time')
    .all(instrument, granularity, signal.time));
  const dir = signal.signal === 'buy' ? 1 : -1;
  const excursion = excursionSince(dir, signal.price, candlesSince);

  let axes = null;
  try {
    const { getSnapshot } = await import('./axis-snapshot.mjs');
    axes = getSnapshot(dbPath, instrument, granularity, signal.time)?.axes ?? null;
  } catch { /* best-effort: a recheck without a recorded snapshot still runs */ }

  const recheckSystem = await resolveRecheckSystem(dbPath);
  const payload = {
    flip: { time: localFull(signal.time), timezone: LOCAL_TZ, side: signal.signal, price: signal.price },
    axisSnapshotAtFlip: axes,
    priceSince: candlesSince.slice(-60).map((c) => ({ t: localHm(c.time), o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume ?? null })),
    excursion,
  };
  const out = await llmRecheckVerdict(settings, payload, recheckSystem.system, onUsage);

  const at = new Date().toISOString();
  const { recordRecheck } = await import('./signal-rechecks.mjs');
  recordRecheck(dbPath, { signalTime: signal.time, instrument, granularity, at, verdict: out.verdict, reason: out.reason, promptVersion: recheckSystem.promptVersion });
  // promptVersion as a string here matches /api/chart's persisted TEXT column,
  // so both endpoints return the same type to the client
  return { verdict: out.verdict, reason: out.reason, at, promptVersion: String(recheckSystem.promptVersion) };
}

// Upsert complete candles so history accumulates with every run — future
// backtests can read from here instead of re-fetching a capped live window.
export function storeCandles(dbPath, instrument, granularity, candles) {
  return withDb(dbPath, (db) => {
    const stmt = db.prepare(`INSERT INTO candles VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(instrument, granularity, time) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume`);
    try {
      db.exec('BEGIN');
      for (const c of candles) stmt.run(instrument, granularity, c.time, c.open, c.high, c.low, c.close, c.volume ?? null);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM candles WHERE instrument = ? AND granularity = ?').get(instrument, granularity);
    return { stored: candles.length, totalRows: Number(n) };
  });
}

// The one granularity→duration rule (M=minutes, H=hours; unknown → 5min).
export const granularityMs = (g) => {
  const m = /^([MH])(\d+)$/.exec(g);
  return m ? Number(m[2]) * (m[1] === 'M' ? 60000 : 3600000) : 300000;
};

export function computeSupertrend(candles, { period = 10, multiplier = 3 } = {}) {
  const n = candles.length;
  if (n < period + 2) throw new Error(`need at least ${period + 2} candles, got ${n}`);

  const tr = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }

  // Wilder's ATR: SMA seed over the first `period` TRs, then RMA.
  const atr = new Array(n).fill(NaN);
  let seed = 0;
  for (let i = 1; i <= period; i++) seed += tr[i];
  atr[period] = seed / period;
  for (let i = period + 1; i < n; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;

  const out = new Array(n).fill(null);
  let prevUpper = Infinity;
  let prevLower = -Infinity;
  let trend = 'up';
  for (let i = period; i < n; i++) {
    const { high, low, close } = candles[i];
    const mid = (high + low) / 2;
    const basicUpper = mid + multiplier * atr[i];
    const basicLower = mid - multiplier * atr[i];
    const prevClose = candles[i - 1].close;

    const upper = (basicUpper < prevUpper || prevClose > prevUpper) ? basicUpper : prevUpper;
    const lower = (basicLower > prevLower || prevClose < prevLower) ? basicLower : prevLower;

    if (close > upper) trend = 'up';
    else if (close < lower) trend = 'down';

    out[i] = { trend, supertrend: trend === 'up' ? lower : upper, atr: atr[i] };
    prevUpper = upper;
    prevLower = lower;
  }
  return out;
}

export function detectFlips(candles, st) {
  const flips = [];
  for (let i = 1; i < st.length; i++) {
    if (!st[i] || !st[i - 1]) continue;
    if (st[i].trend !== st[i - 1].trend) {
      flips.push({
        index: i,
        time: candles[i].time,
        signal: st[i].trend === 'up' ? 'buy' : 'sell',
        price: candles[i].close,
      });
    }
  }
  return flips;
}

// Naive flip-following backtest: enter long on buy flip / short on sell flip at
// the flip candle's close, exit on the next flip (or the last candle).
export function backtestFlips(candles, flips) {
  const trades = [];
  for (let i = 0; i < flips.length; i++) {
    const entry = flips[i];
    const exitPrice = i + 1 < flips.length
      ? flips[i + 1].price
      : candles[candles.length - 1].close;
    const dir = entry.signal === 'buy' ? 1 : -1;
    const returnPct = (dir * (exitPrice - entry.price)) / entry.price * 100;
    trades.push({
      signal: entry.signal,
      entryTime: entry.time,
      entryPrice: entry.price,
      exitPrice,
      open: i === flips.length - 1,
      returnPct: Number(returnPct.toFixed(3)),
    });
  }
  const closed = trades.filter((t) => !t.open);
  const wins = closed.filter((t) => t.returnPct > 0).length;
  return {
    trades: trades.length,
    closed: closed.length,
    winRatePct: closed.length ? Number((wins / closed.length * 100).toFixed(1)) : null,
    totalReturnPct: Number(closed.reduce((s, t) => s + t.returnPct, 0).toFixed(3)),
    perTrade: trades,
  };
}

export async function fetchCandles({ instrument, granularity, count }) {
  const url = new URL('https://p.fxempire.com/oanda/candles/latest');
  url.searchParams.set('instrument', instrument);
  url.searchParams.set('granularity', granularity);
  url.searchParams.set('count', String(count));
  url.searchParams.set('alignmentTimezone', 'UTC');
  const res = await fetch(url, {
    headers: { accept: 'application/json,*/*', 'user-agent': 'Mozilla/5.0 (market-signals; supertrend)' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const payload = await res.json();
  const rows = Array.isArray(payload?.candles) ? payload.candles : [];
  return rows
    .map((r) => ({
      time: r?.time || null,
      open: Number(r?.mid?.o),
      high: Number(r?.mid?.h),
      low: Number(r?.mid?.l),
      close: Number(r?.mid?.c),
      volume: Number(r?.volume ?? 0),
      complete: Boolean(r?.complete),
    }))
    .filter((c) => c.time && [c.open, c.high, c.low, c.close].every(Number.isFinite));
}

function parseArgs(argv) {
  const out = { instrument: 'BCO/USD', granularity: 'M5', count: 500, period: 10, multiplier: 3, freshBars: 2, db: 'data/candles.db', notify: false, settings: 'data/settings.json', pretty: true };
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1];
    if (!(key in out)) throw new Error(`unknown flag --${key} (run --help)`);
    const bareOk = ['pretty', 'notify'].includes(key);
    const value = m[2] ?? ((argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) ? argv[++i] : (bareOk ? 'true' : undefined));
    if (value === undefined) throw new Error(`--${key} requires a value`);
    out[key] = ['count', 'period', 'freshBars'].includes(key) ? Number.parseInt(value, 10)
      : key === 'multiplier' ? Number(value)
      : ['pretty', 'notify'].includes(key) ? value !== 'false'
      : value;
    if (['count', 'period', 'freshBars', 'multiplier'].includes(key) && Number.isNaN(out[key])) {
      throw new Error(`invalid --${key} "${value}": expected a number`);
    }
  }
  return out;
}

// settings.watchers CSV ("WTICO/USD|M5, XAU/USD|M15") → combo list; falls back
// to the single flag/settings-configured instrument+granularity.
export function parseWatchers(cfg, fallback) {
  const raw = (cfg.watchers ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const combos = raw.map((entry) => {
    const [instrument, granularity = 'M5'] = entry.split('|').map((x) => x.trim());
    return { instrument, granularity };
  }).filter((c) => c.instrument);
  return combos.length ? combos : [fallback];
}

// HTF cache grounding (issue #81): the watcher only ever fetches its own
// watched combos, so higher timeframes for the same instruments (used by the
// axis gate and future H1 strategies) went stale between watched ticks. Every
// tick, walk a fixed ladder per tracked instrument and top up only what's
// actually stale — cache-only, no signal evaluation, no notifications.
const HTF_LADDER = ['M15', 'M30', 'H1', 'H4'];
// candle `time` is the bar OPEN (see resampleCandles), so the next COMPLETED bar
// only exists 2 durations after the current newest open — refetch then, not at 1.5
// (which would fetch every tick for half a bar with nothing new to store)
const HTF_STALE_GRACE = 2;
const HTF_FETCH_CAP = 6; // bound fan-out after a long downtime instead of catching up unboundedly in one tick

// Tracked = watched combos ∪ configured bot combos, regardless of enabled
// status (issue #81 decision 1: the operator wants data grounded even for
// unarmed bots). `combos` is whatever parseWatchers already resolved for this
// tick — reused so single-watcher fallback mode is covered too.
export function trackedInstruments(combos, cfg) {
  const fromWatchers = combos.map((c) => c.instrument).filter(Boolean);
  const botKeys = cfg?.bot?.bots && typeof cfg.bot.bots === 'object' ? Object.keys(cfg.bot.bots) : [];
  const fromBots = botKeys.map((k) => String(k).split('|')[0].trim()).filter(Boolean);
  return [...new Set([...fromWatchers, ...fromBots])];
}

export async function refreshHtfCache(dbPath, combos, cfg, { fetcher = fetchCandles, cap = HTF_FETCH_CAP, count = 100, now = Date.now(), log = dbg } = {}) {
  const instruments = trackedInstruments(combos, cfg);
  if (!instruments.length) return { refreshed: [], skipped: [] };

  // One DB open to read every ladder rung's newest bar instead of one per combo.
  const newest = withDb(dbPath, (db) => {
    const stmt = db.prepare('SELECT MAX(time) AS t FROM candles WHERE instrument=? AND granularity=?');
    const out = {};
    for (const instrument of instruments) {
      for (const granularity of HTF_LADDER) out[`${instrument}|${granularity}`] = stmt.get(instrument, granularity)?.t ?? null;
    }
    return out;
  });

  const due = [];
  for (const instrument of instruments) {
    for (const granularity of HTF_LADDER) {
      const t = newest[`${instrument}|${granularity}`];
      // a missing OR unparseable timestamp is treated as maximally stale so a bad
      // row self-heals on the next fetch instead of freezing this rung forever
      const parsed = t ? Date.parse(t) : NaN;
      const ageMs = Number.isNaN(parsed) ? Infinity : now - parsed;
      if (ageMs > granularityMs(granularity) * HTF_STALE_GRACE) due.push({ instrument, granularity });
    }
  }

  const toFetch = due.slice(0, cap);
  const skipped = due.slice(cap);
  if (skipped.length) {
    log(`HTF cache: per-tick cap (${cap}) reached, skipped ${skipped.map((c) => `${c.instrument}|${c.granularity}`).join(', ')}`);
  }

  const refreshed = [];
  for (const combo of toFetch) {
    try {
      const candles = await fetcher({ instrument: combo.instrument, granularity: combo.granularity, count });
      const complete = candles.filter((c) => c.complete);
      if (complete.length) storeCandles(dbPath, combo.instrument, combo.granularity, complete);
      refreshed.push(combo);
    } catch (err) {
      log(`HTF cache refresh failed for ${combo.instrument}|${combo.granularity}: ${err.message}`);
    }
  }
  return { refreshed, skipped };
}

// Bot deliberation context (issue #86): extracted so it's testable without the
// network-heavy runOne() pipeline it's assembled inside of. traderMemories and
// sentinel are both advisory-only blocks, present only when their source has
// something to say (memoriesContext/newsContextFor return null when empty).
// Lazy imports avoid a static cycle (memories.mjs/news.mjs import withDb from here).
export async function buildBotContext(dbPath, instrument, { supertrend, trend, backtest, axisGate } = {}) {
  const { memoriesContext } = await import('./memories.mjs');
  const { newsContextFor } = await import('./news.mjs');
  return {
    supertrend, trend, backtest, axisGate,
    traderMemories: memoriesContext(dbPath) || undefined,
    sentinel: newsContextFor(dbPath, instrument) || undefined,
  };
}

async function runOne(opts) {
  const all = await fetchCandles(opts);
  const candles = all.filter((c) => c.complete);
  const store = opts.db ? storeCandles(opts.db, opts.instrument, opts.granularity, candles) : null;
  const st = computeSupertrend(candles, opts);
  const flips = detectFlips(candles, st);
  const backtest = backtestFlips(candles, flips);

  const last = candles[candles.length - 1];
  const lastSt = st[st.length - 1];
  const lastFlip = flips[flips.length - 1] || null;
  const barsAgo = lastFlip ? candles.length - 1 - lastFlip.index : null;

  const result = {
    ok: true,
    instrument: opts.instrument,
    granularity: opts.granularity,
    params: { period: opts.period, multiplier: opts.multiplier },
    asOf: last.time,
    close: last.close,
    trend: lastSt.trend,
    supertrend: Number(lastSt.supertrend.toFixed(4)),
    signal: lastFlip && {
      ...lastFlip,
      barsAgo,
      fresh: barsAgo <= opts.freshBars,
    },
    backtest,
    store,
  };
  result.notify = await processSignal(opts, result, candles);

  // Trading bot (issue #23): deterministic fills every run, LLM only on events.
  // Lazy imports avoid a static cycle (bot/server both import from this module).
  if (opts.db) {
    try {
      const settings = readSettings(opts.settings);
      if (settings.bot && (settings.bot.enabled === true || (settings.bot.bots && typeof settings.bot.bots === 'object'))) {
        const { runBot } = await import('./bot.mjs');
        const { botToolDefs, execChatTool } = await import('./signal-server.mjs');
        // A flip is a bot event only the run that records it: alert sent, filter
        // suppression, notify-off recording, or notification failure — never on
        // 'already processed' / 'duplicate' re-sightings of the same flip.
        const newThisRun = result.notify?.sent === true
          || /^(suppressed by filter|recorded \(notify off\)|notification failed)/.test(result.notify?.reason || '');
        const freshFlip = result.signal?.fresh && newThisRun ? result.signal : null;
        let botAxes = result.notify?.gateSnapshot?.axes ?? null; // flip events reuse the signal-time snapshot
        if (!botAxes) {
          try {
            const { axisSnapshot } = await import('./axis-snapshot.mjs');
            botAxes = axisSnapshot(candles, { instrument: opts.instrument, granularity: opts.granularity })?.axes ?? null;
          } catch { /* axes optional */ }
        }
        result.bot = await runBot(opts.db, settings, {
          instrument: opts.instrument, granularity: opts.granularity,
          candle: last, quote: { last: last.close }, freshFlip,
          ctx: await buildBotContext(opts.db, opts.instrument, { supertrend: result.supertrend, trend: result.trend, backtest: result.backtest, axisGate: botAxes }),
          // read-only tools for the trading loop: the bot must never write
          // strategy drafts, memories, or anything else as a side effect of
          // deciding — memory saves are trader-initiated, chat-only (#44)
          toolDefs: botToolDefs().map(({ name, description, input_schema }) => ({ name, description, input_schema })),
          execTool: (n, i) => execChatTool(n, i, { dbPath: opts.db }),
        });
      }
    } catch (err) {
      dbg(`bot run failed (alerts unaffected): ${err.message}`);
      result.bot = { error: err.message };
    }
  }
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) return process.stdout.write(USAGE);
  const opts = parseArgs(argv);

  // Watcher fields set on the config page win over baked defaults but lose to
  // explicit CLI flags (the LaunchAgent may pin flags; the UI edits settings).
  const cfg = readSettings(opts.settings);
  for (const k of ['instrument', 'granularity', 'freshBars']) {
    const flagGiven = argv.some((a) => a === `--${k}` || a.startsWith(`--${k}=`));
    if (cfg[k] !== undefined && !flagGiven) opts[k] = cfg[k];
  }

  const combos = parseWatchers(cfg, { instrument: opts.instrument, granularity: opts.granularity });
  const results = [];
  for (const combo of combos) {
    try {
      results.push(await runOne({ ...opts, ...combo }));
    } catch (err) {
      dbg(`watcher ${combo.instrument} ${combo.granularity} failed: ${err.message}`);
      results.push({ ok: false, ...combo, error: err.message });
    }
  }

  // HTF cache grounding runs AFTER the watched combos: the signal path is
  // latency/freshness-sensitive (barsAgo is measured from now), while this is
  // best-effort with its own staleness grace, so it never delays a real alert.
  if (opts.db) {
    try {
      await refreshHtfCache(opts.db, combos, cfg);
    } catch (err) {
      dbg(`HTF cache refresh failed: ${err.message}`);
    }
    // Sentinel news cache grounding (issue #86): same after-the-signal-path,
    // best-effort placement as the HTF cache above — cache-only, never delays
    // a real alert.
    try {
      const { refreshNewsCache } = await import('./news.mjs');
      await refreshNewsCache(opts.db, combos, cfg);
    } catch (err) {
      dbg(`news cache refresh failed: ${err.message}`);
    }
  }

  const out = results.length === 1 ? results[0] : results;
  process.stdout.write(`${JSON.stringify(out, null, opts.pretty ? 2 : 0)}\n`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`supertrend error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
