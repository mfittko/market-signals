// Shared by the Prediction card and the chart tooltip: the chosen horizon x target cell, its label,
// and the shield state. Which instruments have a meaningful long-minus-short difference is decided
// in one place, SIDE_DIFF_CALIBRATED in scripts/local-predict.mjs; the engine sends it as shield.shared.
export const SIDE_DIFF_NOTE = 'Difference between sides not meaningful for this instrument.';
export const SHARED_NOTE = 'applies to both sides; direction not measurable for this instrument';

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

// The per-side state (shieldState in scripts/local-predict.mjs): a shield against clearly wrong
// moments, not trading advice.
export type SideState = { state: 'red' | 'orange' | 'grey' | 'green'; label: string; why: string | null; code: string; decile: number | null; avgR: number | null };
// shared: one state for both sides (`both`), for instruments whose side difference is not meaningful
export type Shield = { reason: { code: string; why: string } | null; shared?: boolean; long: SideState; short: SideState; both?: SideState };
export const STATE_COLOR: Record<SideState['state'], string> = { red: 'var(--bad)', orange: 'var(--warn)', grey: 'var(--muted)', green: 'var(--good)' };
export const avgRText = (r: number | null) => (r == null ? 'avg R n/a' : `avg ${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)} R`);
// "Don't trade now · bottom 10% of conditions for WTI M5 · avg −0.91 R"; `why` is left out when the reason is shown above
export const stateText = (s: SideState, withWhy = true) => [s.label, withWhy ? s.why : null, avgRText(s.avgR)].filter(Boolean).join(' · ');

// One closed candle of GET /engine/predictions/series (scripts/predictions.mjs predictionSeries).
export type SeriesCell = { key: string; horizon: number; target: 'up' | 'plan'; pLong: number; pShort: number; expectedRLong: number | null; expectedRShort: number | null; decileLong: number; decileShort: number; headline: string; reason: string | null; inSample: boolean | null; shield: Shield };
export type SeriesEntry = { candleTime: string; source: 'live' | 'computed'; computedAt: string; spreadR: number | null; reasons: { code: string; text: string }[]; available: boolean; text: string | null; cells: SeriesCell[]; shield: Shield };
