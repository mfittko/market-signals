'use client';
import { useEffect, useMemo, useRef, useState } from 'react';

export type EquityPoint = { t: number; v: number; label?: string };

const fmt = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// Round tick values (1, 2, 5 x 10^n) so the axis reads cleanly.
function niceTicks(lo: number, hi: number, n: number) {
  const span = Math.max(hi - lo, 1e-9);
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

export function EquityChart({ points, baseline }: { points: EquityPoint[]; baseline: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(280, el.clientWidth)));
    ro.observe(el);
    setW(Math.max(280, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const H = w < 480 ? 220 : 280;
  const m = { l: w < 480 ? 52 : 64, r: 12, t: 12, b: 26 };
  const g = useMemo(() => {
    const t0 = points[0].t;
    const t1 = Math.max(points[points.length - 1].t, t0 + 1);
    const vs = points.map((p) => p.v).concat(baseline);
    const pad = (Math.max(...vs) - Math.min(...vs)) * 0.08 || 1;
    const lo = Math.min(...vs) - pad, hi = Math.max(...vs) + pad;
    const x = (t: number) => m.l + (w - m.l - m.r) * ((t - t0) / (t1 - t0));
    const y = (v: number) => m.t + (H - m.t - m.b) * (1 - (v - lo) / (hi - lo));
    const yt = niceTicks(lo, hi, 4);
    const nx = w < 480 ? 3 : 6;
    const xt = Array.from({ length: nx }, (_, i) => t0 + ((t1 - t0) * i) / (nx - 1));
    return { x, y, yt, xt };
  }, [points, baseline, w, H, m.l, m.r, m.t, m.b]);

  const last = points[points.length - 1];
  const up = last.v >= baseline;
  const color = up ? 'var(--good)' : 'var(--bad)';
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${g.x(p.t).toFixed(1)},${g.y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L${g.x(last.t).toFixed(1)},${H - m.b} L${g.x(points[0].t).toFixed(1)},${H - m.b} Z`;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    let best = 0, d = Infinity;
    points.forEach((p, i) => { const dx = Math.abs(g.x(p.t) - px); if (dx < d) { d = dx; best = i; } });
    setHover(best);
  };
  const hp = hover == null ? null : points[hover];
  const tipLeft = hp ? Math.min(Math.max(g.x(hp.t), 90), w - 90) : 0;

  return (
    <div ref={box} style={{ position: 'relative', width: '100%' }}>
      <svg width={w} height={H} role="img" aria-label={`Equity from ${fmt(baseline)} to ${fmt(last.v)}`}
        onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} style={{ display: 'block', touchAction: 'pan-y' }}>
        {g.yt.map((v) => (
          <g key={v}>
            <line x1={m.l} x2={w - m.r} y1={g.y(v)} y2={g.y(v)} stroke="currentColor" strokeOpacity=".1" />
            <text x={m.l - 8} y={g.y(v) + 4} textAnchor="end" fontSize="12" fill="currentColor" opacity=".65">{v.toLocaleString(undefined, { maximumFractionDigits: 0 })}</text>
          </g>
        ))}
        {g.xt.map((t, i) => (
          <text key={i} x={g.x(t)} y={H - 6} textAnchor={i === 0 ? 'start' : i === g.xt.length - 1 ? 'end' : 'middle'} fontSize="12" fill="currentColor" opacity=".65">{day(t)}</text>
        ))}
        <line x1={m.l} x2={w - m.r} y1={g.y(baseline)} y2={g.y(baseline)} stroke="currentColor" strokeOpacity=".4" strokeDasharray="4 4" />
        <text x={w - m.r} y={g.y(baseline) - 5} textAnchor="end" fontSize="11" fill="currentColor" opacity=".65">start {fmt(baseline)}</text>
        <path d={area} fill={color} opacity=".12" />
        <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        <circle cx={g.x(last.t)} cy={g.y(last.v)} r="4" fill={color} />
        {hp && (
          <g>
            <line x1={g.x(hp.t)} x2={g.x(hp.t)} y1={m.t} y2={H - m.b} stroke="currentColor" strokeOpacity=".35" />
            <circle cx={g.x(hp.t)} cy={g.y(hp.v)} r="5" fill={color} stroke="var(--bg, #fff)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {hp && (
        <div className="card" style={{ position: 'absolute', top: 4, left: tipLeft, transform: 'translateX(-50%)', padding: '4px 10px', fontSize: 12, pointerEvents: 'none', whiteSpace: 'nowrap' }}>
          <strong>{fmt(hp.v)}</strong> · {when(hp.t)}{hp.label ? ` · ${hp.label}` : ''}
        </div>
      )}
    </div>
  );
}
