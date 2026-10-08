// Shared by the Prediction card and the chart tooltip: the chosen horizon (3, 6 or 12 candles) of the
// up/down lookup, and the cost shield. Which instruments have a meaningful long-minus-short difference
// is decided in one place, SIDE_DIFF_CALIBRATED in scripts/local-predict.mjs (sent as shield.shared).
export const SHARED_NOTE = 'applies to both sides; direction not measurable for this instrument';

// The card's horizon choice, remembered in this browser for every pair; the chart follows it.
export const HORIZONS = [3, 6, 12] as const;
const HORIZON_KEY = 'predictionHorizon';
const HORIZON_EVENT = 'prediction-horizon';
export const loadHorizon = (): number => { try { const v = Number(localStorage.getItem(HORIZON_KEY)); return (HORIZONS as readonly number[]).includes(v) ? v : 6; } catch { return 6; } };
export function saveHorizon(n: number) {
  try { localStorage.setItem(HORIZON_KEY, String(n)); } catch { /* private window */ }
  window.dispatchEvent(new Event(HORIZON_EVENT));
}
export function onHorizonChange(fn: () => void) {
  window.addEventListener(HORIZON_EVENT, fn);
  return () => window.removeEventListener(HORIZON_EVENT, fn);
}
const granMs = (g: string) => Number(g.slice(1)) * (g[0] === 'H' ? 3600000 : 60000);
const dur = (bars: number, g: string) => { const m = (bars * granMs(g)) / 60000; return m < 60 ? `${m} min` : `${+(m / 60).toFixed(1)} h`; };
// "6 candles (30 min)"
export const horizonLabel = (n: number, g: string) => `${n} candles (${dur(n, g)})`;

// The up/down lookup per horizon (updown in scripts/local-predict.mjs): an empirical frequency table, not an edge.
// bars: whole percentages Long / Neutral / Short summing to 100.
export type UpDownH = { level: string; key: string; n: number; pL: number; pN: number; pS: number; bars: [number, number, number]; label: string; d: number; ci: [number, number]; words: string };
export type UpDown = { horizons: Record<string, UpDownH>; period: string } | null;
export const LEAN_COLOR = (label: string) => (label.startsWith('Long') ? 'var(--good)' : label.startsWith('Short') ? 'var(--bad)' : 'var(--muted)');

// The state (shieldState in scripts/local-predict.mjs): a shield against clearly wrong moments, not
// trading advice. red "Don't trade now", orange "Costly now", otherwise grey "No warning"; no green.
// `why` belongs in the headline (red and orange only); `conditions` and avgR belong in Details.
export type SideState = { state: 'red' | 'orange' | 'grey'; label: string; why: string | null; conditions?: string | null; code: string; decile: number | null; avgR: number | null };
// shared: one state for both sides (`both`), for instruments whose side difference is not meaningful
export type Shield = { reason: { code: string; why: string } | null; shared?: boolean; long: SideState; short: SideState; both?: SideState };
export const STATE_COLOR: Record<SideState['state'], string> = { red: 'var(--bad)', orange: 'var(--warn)', grey: 'var(--muted)' };
// a warning (red or orange) gets a dot; runs stored before the green state was removed read as no warning
export const isWarning = (s: SideState) => s.state === 'red' || s.state === 'orange';
export const avgRText = (r: number | null) => (r == null ? 'avg R n/a' : `avg ${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)} R`);
// headline: "Don't trade now · bottom 10% of conditions for WTI M5"; `why` is left out when the reason is shown above
export const stateText = (s: SideState, withWhy = true) => (isWarning(s) ? [s.label, withWhy ? s.why : null].filter(Boolean).join(' · ') : s.label.replace(/^Low-cost moment|^Normal/, 'No warning'));
// Details: "decile 9 of 10, top 20% of conditions for WTI M5 · avg −0.14 R"
export const conditionsText = (s: SideState) => `${s.decile == null ? 'no calibrated estimate' : `decile ${s.decile} of 10${s.conditions ? `, ${s.conditions}` : ''}`} · ${avgRText(s.avgR)}`;
// "Now: falling fast · −2.1 ATR in 4 bars · volume 1.8× normal": closed bars only, no forecast.
// continuationRate is a hook for a later historical rate and is not shown.
export type NowMotion = { bars: number; moveAtr: number; pace: 'fast' | 'steady' | 'flat'; direction: 'rising' | 'falling' | null; volumeRatio: number | null; volumeBase: string | null; continuationRate: number | null; text: string };

// One closed candle of GET /engine/predictions/series (scripts/predictions.mjs predictionSeries).
export type SeriesCell = { key: string; horizon: number; target: 'up' | 'plan'; pLong: number; pShort: number; expectedRLong: number | null; expectedRShort: number | null; decileLong: number; decileShort: number; headline: string; reason: string | null; inSample: boolean | null; shield: Shield };
export type SeriesEntry = { candleTime: string; source: 'live' | 'computed'; computedAt: string; spreadR: number | null; reasons: { code: string; text: string }[]; available: boolean; text: string | null; cells: SeriesCell[]; shield: Shield; now: NowMotion | null; updown: UpDown };
