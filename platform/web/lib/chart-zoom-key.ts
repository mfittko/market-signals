// Maps a key press on the focused chart to a zoom factor: minus shows more candles, plus or equals shows fewer.
// A Ctrl, Cmd or Alt chord returns null, so the browser keeps its page zoom shortcuts. Shift stays allowed,
// because plus needs Shift on many layouts.
export type ZoomKey = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean };

export function zoomFactor(e: ZoomKey): number | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === '-') return 1.5;
  if (e.key === '+' || e.key === '=') return 1 / 1.5;
  return null;
}
