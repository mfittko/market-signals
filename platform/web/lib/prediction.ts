// Shared by the Prediction card and the chart tooltip: the chosen horizon x target cell,
// its label, and which instruments have a meaningful long-minus-short difference.

// pprofit20 (M5, 2023+) regressed the observed long-minus-short outcome on the predicted
// P(long) - P(short). The 95% interval of the slope contains 1 only for EUR/USD (0.91) and
// SPX500 (0.63); WTI is 0.04, NATGAS -0.08, XAU 0.40 and XAG 0.36. Elsewhere each side's P is
// calibrated on its own, but their difference carries no reliable information.
export const SIDE_DIFF_CALIBRATED = new Set(['EUR/USD', 'SPX500/USD']);
export const SIDE_DIFF_NOTE = 'Difference between sides not meaningful for this instrument.';

// The card's cell choice, remembered in this browser for every pair; the chart follows it.
const CELL_KEY = 'predictionCell';
const CELL_EVENT = 'prediction-cell';
export const loadCell = () => { try { return localStorage.getItem(CELL_KEY); } catch { return null; } };
export function saveCell(key: string) {
  try { localStorage.setItem(CELL_KEY, key); } catch { /* private window */ }
  window.dispatchEvent(new Event(CELL_EVENT));
}
export function onCellChange(fn: () => void) {
  window.addEventListener(CELL_EVENT, fn);
  return () => window.removeEventListener(CELL_EVENT, fn);
}

const granMs = (g: string) => Number(g.slice(1)) * (g[0] === 'H' ? 3600000 : 60000);
const dur = (bars: number, g: string) => { const m = (bars * granMs(g)) / 60000; return m < 60 ? `${m} min` : `${+(m / 60).toFixed(1)} h`; };
export const targetLabel = (target: string) => (target === 'up' ? 'price better' : 'trade plan');
// "12 candles (1 h) · price better"
export const cellLabel = (c: { horizon: number; target: string }, g: string) => `${c.horizon} candles (${dur(c.horizon, g)}) · ${targetLabel(c.target)}`;

// One closed candle of GET /engine/predictions/series (scripts/predictions.mjs predictionSeries).
export type SeriesCell = { key: string; horizon: number; target: 'up' | 'plan'; pLong: number; pShort: number; expectedRLong: number | null; expectedRShort: number | null; headline: string; reason: string | null; inSample: boolean | null };
export type SeriesEntry = { candleTime: string; source: 'live' | 'computed'; computedAt: string; spreadR: number | null; reasons: { code: string; text: string }[]; available: boolean; text: string | null; cells: SeriesCell[] };
