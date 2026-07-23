#!/usr/bin/env node
// Opt-in LLM judge layers (issue #40, decisions 3-5): STRICTLY outer-loop.
// The mechanical replay is already done when this runs; judges rank and
// critique, they never promote (the promotion gate is mechanical). Everything
// a judge sees is anonymized; responses are cached by content hash so repeat
// runs are free and deterministic-in-practice.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { llmRequest, readSettings } from './supertrend.mjs';
import { anonymized } from './axis-snapshot.mjs';
import { reportHash, canonical } from './spec-backtest.mjs';
import { createHash } from 'node:crypto';

// Judge prompts are versioned IN-REPO (decision: judge prompts versioned);
// bump the version when the wording changes so cached responses never mix.
export const JUDGE_PROMPTS = {
  meta: {
    version: 'meta-v1',
    system: 'You are a quantitative strategy judge. You receive anonymized walk-forward backtest reports for several candidate strategies (no symbols, no dates — only relative metrics). Rank the candidates pairwise by robustness (validation expectancy and drawdown weighted over train performance; penalize train-validation divergence as overfitting), then write a short critique of each. You NEVER decide promotion — a mechanical gate owns that. Reply JSON: {"ranking": ["name", ...], "critiques": {"name": "<max 200 chars>"}}.',
  },
  perSignal: {
    version: 'per-signal-v1',
    system: 'You are a signal-quality judge. You receive one anonymized signal snapshot (axis verdicts and normalized values only) plus the news-headline digest RECORDED at signal time. Score how favorable the recorded context was for the signal direction, -2 (strongly against) to +2 (strongly for), using ONLY the provided data. Reply JSON: {"score": <int -2..2>, "rationale": "<max 120 chars>"}.',
  },
};

const CACHE_DIR = 'reports/backtests/cache';

// Decision 5 applies to judges without exception: scrub instrument symbols and
// dates from headline text before it reaches a payload (sentiment words stay).
const SCRUB_SYMBOL_RE = /[A-Z]{3,6}\/[A-Z]{3,6}|WTICO|WTI|SPX500|SPX|XAU|BTC|Brent/gi;
const SCRUB_DATE_RE = /\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4}/g;
export const scrubHeadline = (text) => String(text).replace(SCRUB_SYMBOL_RE, '[instrument]').replace(SCRUB_DATE_RE, '[date]');

function cached(key, compute) {
  const path = `${CACHE_DIR}/${key}.json`;
  if (existsSync(path)) {
    try { return { ...JSON.parse(readFileSync(path, 'utf8')), cached: true }; } catch { /* recompute */ }
  }
  return compute().then((value) => {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    return { ...value, cached: false };
  });
}

// Strip everything a meta judge must not see: instrument/window/timestamps.
export function anonymizedReport(report) {
  return {
    candidatesTried: report.candidatesTried,
    results: (report.results || []).filter((r) => r.ok).map((r) => ({
      name: r.name,
      train: r.train,
      validation: r.validation,
      vetoAttribution: r.vetoAttribution,
    })),
  };
}

async function judgeMeta(report, settings) {
  const anon = anonymizedReport(report);
  if (!anon.results.length) return { mode: 'meta', skipped: 'no successful candidates' };
  const key = `meta-${JUDGE_PROMPTS.meta.version}-${reportHash(anon)}`;
  return cached(key, async () => {
    const out = await llmRequest(settings, JUDGE_PROMPTS.meta.system, JSON.stringify(anon), {
      schema: {
        type: 'object',
        properties: { ranking: { type: 'array', items: { type: 'string' } }, critiques: { type: 'object' } },
        required: ['ranking', 'critiques'],
      },
      temperature: 0,
      timeoutMs: 60000,
    });
    const parsed = JSON.parse(String(out).match(/\{[\s\S]*\}/)?.[0] ?? '{}');
    // a malformed reply must THROW so cached() never freezes an empty verdict
    if (!Array.isArray(parsed.ranking) || typeof parsed.critiques !== 'object') throw new Error('malformed meta-judge reply (not cached)');
    return { mode: 'meta', promptVersion: JUDGE_PROMPTS.meta.version, ...parsed };
  });
}

const snapHash = (obj) => createHash('sha256').update(canonical(obj)).digest('hex').slice(0, 16);

async function judgePerSignal(snapshots, settings) {
  // ONLY snapshots carrying a recorded context block qualify (no-lookahead,
  // decision 4); fetching anything at backtest time is forbidden.
  const eligible = snapshots.filter((s) => s.context?.headlines?.length);
  if (!eligible.length) return { mode: 'per-signal', skipped: 'no snapshots carry a recorded context block; nothing to score (judge degrades gracefully)' };
  const scores = [];
  for (const s of eligible.slice(0, 50)) {
    const payload = { snapshot: anonymized(s.snapshot), headlines: s.context.headlines.map(scrubHeadline) };
    const key = `sig-${JUDGE_PROMPTS.perSignal.version}-${snapHash(payload)}`;
    const scored = await cached(key, async () => {
      const out = await llmRequest(settings, JUDGE_PROMPTS.perSignal.system, JSON.stringify(payload), {
        schema: {
          type: 'object',
          properties: { score: { type: 'integer' }, rationale: { type: 'string' } },
          required: ['score', 'rationale'],
        },
        temperature: 0,
        timeoutMs: 45000,
      });
      const parsed = JSON.parse(String(out).match(/\{[\s\S]*\}/)?.[0] ?? '{}');
      if (!Number.isInteger(parsed.score) || typeof parsed.rationale !== 'string') throw new Error('malformed per-signal judge reply (not cached)');
      return { promptVersion: JUDGE_PROMPTS.perSignal.version, ...parsed };
    });
    scores.push({ time: s.time, ...scored });
  }
  return { mode: 'per-signal', scored: scores.length, eligible: eligible.length, scores };
}

export async function runJudge(mode, report, { dbPath, snapshots = [] } = {}) {
  if (!['meta', 'per-signal'].includes(mode)) throw new Error(`unknown judge mode ${mode} (off|meta|per-signal)`);
  const settings = readSettings('data/settings.json');
  try {
    if (mode === 'meta') return await judgeMeta(report, settings);
    return await judgePerSignal(snapshots, settings);
  } catch (err) {
    // judge failure never invalidates the mechanical report
    return { mode, error: String(err.message || err).slice(0, 200) };
  }
}
