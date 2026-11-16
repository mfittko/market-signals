// Moves the forming (last, incomplete) candle to the near-live mid. Finished candles stay as the engine sent them.
// Only a quote inside the forming bar moves it. A quote from before the bar's start belongs to the previous bar, and one
// from after its end belongs to the next bar, which the live candle data has not delivered yet: both are left out, so every
// bar keeps its own high, low and close. The bar length comes from the granularity (gaps between bars vary).
// Shared by the instrument chart and the Desk candle strips.
export type Price = { mid: number; time: string | null };
export type Bar = { time: string; high: number; low: number; close: number; complete?: boolean };

const UNIT_MS: Record<string, number> = { S: 1e3, M: 60e3, H: 3600e3, D: 86400e3, W: 7 * 86400e3 };
export function barMs(granularity?: string): number | null {
  const m = /^([SMHDW])(\d*)$/.exec(granularity ?? '');
  if (!m || (m[1] === 'M' && !m[2])) return null; // a bare M is a month, which has no fixed length
  return UNIT_MS[m[1]] * Number(m[2] || 1);
}
// The engine writes nanosecond timestamps. Keep three fractional digits so every browser parses them.
const ts = (t: string) => Date.parse(t.replace(/(\.\d{3})\d+/, '$1'));

// The running high and low and the last of the mids applied to one forming bar, keyed by granularity and bar
// time. A poll's extreme stays on the bar after later polls move the mid back, and the last in-bar mid stays its
// close after a quote falls past the bar end, until the live candle data starts a new bar.
export type PollRange = { key: string; high: number; low: number; close: number };

export function withPrice<C extends Bar>(candles: C[], price: Price | null, granularity: string | undefined, range: { current: PollRange | null }): C[] {
  const last = candles[candles.length - 1];
  if (!last || !price || last.complete !== false) return candles;
  const key = `${granularity}|${last.time}`;
  if (range.current?.key !== key) range.current = null; // a new forming bar starts without poll extremes
  // A quote without a usable timestamp cannot be placed in a bar, so it never moves one (NaN fails both comparisons).
  const at = price.time ? ts(price.time) : NaN, start = ts(last.time), len = barMs(granularity);
  const inBar = at >= start && (len === null || at < start + len);
  if (inBar) {
    const mid = price.mid, r = range.current;
    range.current = { key, high: Math.max(r?.high ?? mid, mid), low: Math.min(r?.low ?? mid, mid), close: mid };
  }
  const r = range.current;
  if (!inBar && !r) return candles;
  const close = inBar ? price.mid : r?.close ?? last.close;
  return [...candles.slice(0, -1), { ...last, close, high: Math.max(last.high, close, r?.high ?? close), low: Math.min(last.low, close, r?.low ?? close) }];
}
