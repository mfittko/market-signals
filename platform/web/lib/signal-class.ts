// The engine records a verdict on every signal row. Only 'alert' means the engine notified on it.
// Other values: 'suppress' (filter said no), 'duplicate' (re-detected flip), 'backfill' (history loaded at start-up),
// and null (not judged yet, or an impulse the notify rules held back).
export const isAlerted = (s: { verdict?: string | null }) => s.verdict === 'alert';

export const signalTitle = (s: { kind?: string; signal: string; instrument: string; granularity: string; price: number }) =>
  `${s.kind === 'volume-impulse' ? 'Volume impulse' : `${s.signal === 'buy' ? 'Buy' : 'Sell'} flip`} ${s.instrument} ${s.granularity} at ${s.price}`;
