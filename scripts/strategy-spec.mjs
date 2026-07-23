#!/usr/bin/env node
// Declarative strategy specs (issue #40, epic #27): the backtestable contract
// beside #25's prompt. Entry = conditions over #32 axis verdicts/values; exits
// are ATR-multiples; risk caps are relative. Schema-level anonymization: specs
// naming raw dates or instrument symbols are rejected outright (decision 5).

export const SPEC_SCHEMA_VERSION = 1;

const AXES = ['trendStrength', 'direction', 'impulse', 'location', 'exhaustion'];
const AXIS_VERDICTS = {
  trendStrength: ['trending', 'ranging', 'neutral'],
  direction: ['aligned', 'counter', 'mixed'],
  impulse: ['impulsive', 'thin', 'neutral'],
  location: ['aligned', 'counter'],
  exhaustion: ['veto', 'clear'],
};

const DATE_RE = /\d{4}-\d{2}-\d{2}|\d{2}[./]\d{2}[./]\d{2,4}/;
const SYMBOL_RE = /[A-Z]{3,6}\/[A-Z]{3,6}|WTICO|SPX500|XAU|BTC/i;

function scanStrings(value, path, errors) {
  if (typeof value === 'string') {
    if (DATE_RE.test(value)) errors.push(`${path}: raw dates are forbidden in specs (anonymization)`);
    if (SYMBOL_RE.test(value)) errors.push(`${path}: instrument symbols are forbidden in specs (anonymization)`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scanStrings(v, `${path}[${i}]`, errors));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      scanStrings(k, `${path}.<key>`, errors); // keys can smuggle symbols/dates too
      scanStrings(v, `${path}.${k}`, errors);
    }
  }
}

// Returns { ok, errors } — never throws; callers decide.
export function validateSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, errors: ['spec must be an object'] };
  if (spec.schema_version !== SPEC_SCHEMA_VERSION) errors.push(`schema_version must be ${SPEC_SCHEMA_VERSION}`);

  const entry = spec.entry;
  if (!entry || typeof entry !== 'object') errors.push('entry required');
  else {
    if (!Number.isInteger(entry.minAxesAligned) || entry.minAxesAligned < 1 || entry.minAxesAligned > AXES.length) {
      errors.push('entry.minAxesAligned must be an integer 1-5 (N-of-axes voting)');
    }
    const req = entry.require ?? {};
    if (typeof req !== 'object' || Array.isArray(req)) errors.push('entry.require must be an object');
    else {
      for (const [axis, verdicts] of Object.entries(req)) {
        if (!AXES.includes(axis)) { errors.push(`entry.require.${axis}: unknown axis`); continue; }
        const list = Array.isArray(verdicts) ? verdicts : [verdicts];
        for (const v of list) {
          if (!AXIS_VERDICTS[axis].includes(v)) errors.push(`entry.require.${axis}: '${v}' is not a valid ${axis} verdict`);
        }
      }
    }
    if (entry.forbidExhaustionVeto !== undefined && typeof entry.forbidExhaustionVeto !== 'boolean') {
      errors.push('entry.forbidExhaustionVeto must be boolean');
    }
  }

  const exit = spec.exit;
  if (!exit || typeof exit !== 'object') errors.push('exit required');
  else {
    if (!(exit.stopAtr > 0) || !Number.isFinite(exit.stopAtr)) errors.push('exit.stopAtr must be a positive number (ATR multiple)');
    if (exit.targetAtr != null && (!(exit.targetAtr > 0) || !Number.isFinite(exit.targetAtr))) errors.push('exit.targetAtr must be a positive number when set');
    if (exit.timeStopBars != null && (!Number.isInteger(exit.timeStopBars) || exit.timeStopBars < 1)) errors.push('exit.timeStopBars must be a positive integer when set');
  }

  const risk = spec.risk ?? {};
  if (risk.riskPct != null && (!Number.isFinite(risk.riskPct) || risk.riskPct <= 0 || risk.riskPct > 100)) errors.push('risk.riskPct must be a number in (0,100]');

  scanStrings(spec, 'spec', errors);
  return { ok: errors.length === 0, errors };
}

// Does a recorded snapshot satisfy the spec's entry conditions?
// Returns { enter, vetoedBy } — vetoedBy names the axis that blocked (for
// per-axis veto attribution in reports).
export function entryDecision(spec, snapshot) {
  const axes = snapshot?.axes;
  if (!axes || !snapshot.flip) return { enter: false, vetoedBy: 'no-flip' };
  if (spec.entry.forbidExhaustionVeto !== false && axes.exhaustion?.verdict === 'veto') {
    return { enter: false, vetoedBy: 'exhaustion' };
  }
  for (const [axis, verdicts] of Object.entries(spec.entry.require ?? {})) {
    const list = Array.isArray(verdicts) ? verdicts : [verdicts];
    if (!list.includes(axes[axis]?.verdict)) return { enter: false, vetoedBy: axis };
  }
  // N-of-axes: count axes voting FOR the entry (positive verdicts only)
  const positive = {
    trendStrength: axes.trendStrength?.verdict === 'trending',
    direction: axes.direction?.verdict === 'aligned',
    impulse: axes.impulse?.verdict === 'impulsive',
    location: axes.location?.verdict === 'aligned',
    exhaustion: axes.exhaustion?.verdict === 'clear',
  };
  const aligned = Object.values(positive).filter(Boolean).length;
  if (aligned < spec.entry.minAxesAligned) {
    // attribute to the strongest missing axis for the report
    const missing = Object.entries(positive).find(([, ok]) => !ok);
    return { enter: false, vetoedBy: missing ? missing[0] : 'insufficient-axes' };
  }
  return { enter: true, vetoedBy: null };
}

export const EXAMPLE_SPECS = {
  'conservative-trend': {
    schema_version: 1,
    entry: { minAxesAligned: 3, require: { trendStrength: ['trending'], direction: ['aligned'] }, forbidExhaustionVeto: true },
    exit: { stopAtr: 1.5, targetAtr: 3, timeStopBars: 36 },
    risk: { riskPct: 1 },
  },
  'impulse-scalp': {
    schema_version: 1,
    entry: { minAxesAligned: 2, require: { impulse: ['impulsive'] }, forbidExhaustionVeto: true },
    exit: { stopAtr: 1, targetAtr: 1.5, timeStopBars: 12 },
    risk: { riskPct: 0.5 },
  },
};
