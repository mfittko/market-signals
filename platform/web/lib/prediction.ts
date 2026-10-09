// Shared by the Prediction card and the chart tooltip: the cost shield and the Now line.

// The shield (shieldState in scripts/local-predict.mjs): a guard against clearly wrong moments, not
// trading advice. Red "Don't trade now" with the first measured no-trade reason, otherwise grey "No warning".
export type Shield = { state: 'red' | 'grey'; label: string; why: string | null; reason: { code: string; why: string } | null };
export const STATE_COLOR: Record<string, string> = { red: 'var(--bad)', grey: 'var(--muted)' };
// runs stored before this shape (per-side states) have no top-level state: they read as no warning
export const isWarning = (s: Partial<Shield> | null | undefined) => s?.state === 'red';
export const stateText = (s: Partial<Shield> | null | undefined) => (isWarning(s) ? [s!.label, s!.why].filter(Boolean).join(' · ') : 'No warning');
// "Now: falling fast · −2.1 ATR in 4 bars · volume 1.8× normal": closed bars only, no forecast.
// continuationRate is a hook for a later historical rate and is not shown.
export type NowMotion = { bars: number; moveAtr: number; pace: 'fast' | 'steady' | 'flat'; direction: 'rising' | 'falling' | null; volumeRatio: number | null; volumeBase: string | null; continuationRate: number | null; text: string };

// One closed candle of GET /engine/predictions/series (scripts/predictions.mjs predictionSeries).
export type SeriesEntry = { candleTime: string; source: 'live' | 'computed'; computedAt: string; spreadR: number | null; reasons: { code: string; text: string }[]; shield: Shield; now: NowMotion | null };
