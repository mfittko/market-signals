'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type C = { time: string; open: number; high: number; low: number; close: number };
const BARS = 48;
const W = 280, H = 44;

const REFRESH = 30000;
// Client cache per slug|gran for the page session: switching resolution back or returning to the Desk draws at once,
// and a fresh entry skips the request. A full reload clears it.
const cache = new Map<string, { at: number; cs: C[] }>();

// Last BARS candles of one instrument at one resolution, refreshed every 30 s while the tab is visible.
// shortcut: one /live call per card (engine caches 5 s per instrument+granularity); add a batch endpoint if the grid grows large.
export function MiniCandles({ slug, gran }: { slug: string; gran: string }) {
  const key = `${slug}|${gran}`;
  const [cs, setCs] = useState<C[] | null>(() => cache.get(key)?.cs ?? null);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    let dead = false;
    setCs(cache.get(key)?.cs ?? null);
    const pull = async () => {
      if (document.visibilityState !== 'visible') return;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < REFRESH - 1000) return; // another mount fetched it moments ago
      try {
        const r = await api<{ candles: C[] }>(`/instruments/${slug}/live?granularity=${gran}`);
        const next = r.candles.slice(-BARS);
        cache.set(key, { at: Date.now(), cs: next });
        if (!dead) setCs(next);
      } catch { if (!dead && !cache.has(key)) setCs([]); } // a failed refresh keeps the cached candles
    };
    void pull();
    const t = setInterval(pull, REFRESH);
    return () => { dead = true; clearInterval(t); };
  }, [key, slug, gran]);

  if (!cs) return <div className="mini-spin" style={{ height: H }} role="status" aria-label={`Loading ${gran} candles`}><span /></div>;
  if (cs.length < 2) return <div className="small muted" style={{ height: H }}>No {gran} candles</div>;
  const lo = Math.min(...cs.map((c) => c.low)), hi = Math.max(...cs.map((c) => c.high));
  const y = (v: number) => (hi === lo ? H / 2 : 1 + (H - 2) * (hi - v) / (hi - lo));
  const slot = W / cs.length, bw = Math.max(1, slot * 0.6);
  const first = cs[0].open, last = cs[cs.length - 1].close;
  const hv = hover !== null ? cs[hover] : null;
  const move = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(cs.length - 1, Math.floor(((e.clientX - r.left) / r.width) * cs.length))));
  };
  return (
    <div style={{ position: 'relative' }}>
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" style={{ display: 'block' }}
      onMouseMove={move} onMouseLeave={() => setHover(null)}
      aria-label={`${gran} candles, last ${cs.length}: ${last >= first ? 'up' : 'down'} from ${first} to ${last}`}>
      {hover !== null && <rect x={hover * slot} width={slot} y={0} height={H} fill="var(--surface-2)" />}
      {cs.map((c, i) => {
        const x = i * slot + slot / 2, up = c.close >= c.open;
        const col = up ? 'var(--good)' : 'var(--bad)';
        return (
          <g key={i} stroke={col} fill={col}>
            <line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <rect x={x - bw / 2} width={bw} y={Math.min(y(c.open), y(c.close))} height={Math.max(1, Math.abs(y(c.open) - y(c.close)))} stroke="none" />
          </g>
        );
      })}
    </svg>
    {hv && (
      // below the strip so it never covers a candle; it overlays the stats line only while hovering
      <div className="small num" style={{ position: 'absolute', top: '100%', left: 0, right: 0, pointerEvents: 'none', zIndex: 1,
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, padding: '2px 6px' }}>
        <span className="muted">{new Date(hv.time).toLocaleString([], gran.startsWith('H') ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' })}</span>
        {/* four items that wrap on a narrow card instead of cutting a price off */}
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: 8 }}>
          {(['open', 'high', 'low', 'close'] as const).map((k) => (
            <span key={k} style={{ whiteSpace: 'nowrap' }}><span className="muted">{k[0].toUpperCase()}</span>{' '}
              <span className={k === 'close' ? (hv.close >= hv.open ? 'good-t' : 'bad-t') : ''}>{hv[k]}</span></span>
          ))}
        </div>
      </div>
    )}
    </div>
  );
}
