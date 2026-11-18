// Decides whether an x-axis tick shows the date instead of the time. Ticks 24 hours or more apart
// always show the date. Closer ticks show the time, except the first tick of a new local day.
// Times are epoch milliseconds; prev is null for the first tick.
const DAY = 24 * 3600 * 1000;

export function tickShowsDate(t: number, prev: number | null, step: number): boolean {
  if (step >= DAY) return true;
  return prev !== null && new Date(t).toDateString() !== new Date(prev).toDateString();
}
