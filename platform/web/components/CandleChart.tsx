'use client';
import { useEffect, useRef, useState } from 'react';
import type { Decision } from '@/lib/api';

export type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number };
type Flip = { signal?: string; time?: string; price?: number } | null | undefined;

type Props = {
  candles: Candle[];
  asOf?: string;
  price?: number;
  flip?: Flip;
  agent?: Decision;
  engine?: Decision;
};

const MIN_BAR = 7; // px per candle slot: fewer bars are drawn on narrow screens

const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(1) : v.toFixed(3));

// Levels drawn for a decision: solid for the agent, dashed for the engine.
function levels(d: Decision | undefined, entry: number | undefined) {
  if (!d || d.action !== 'open') return [];
  const out: { key: string; v: number; kind: 'stop' | 'target' }[] = [];
  if (d.stop) out.push({ key: 'stop', v: d.stop, kind: 'stop' });
  if (d.target) out.push({ key: 'target', v: d.target, kind: 'target' });
  return entry ? out : out;
}

export function CandleChart({ candles: all, asOf, price, flip, agent, engine }: Props) {
  // Draw at the real pixel width so text stays 11px on a phone instead of scaling down.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(920);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = W < 560;
  const H = narrow ? 300 : 360;
  const PAD = { l: 8, r: narrow ? 104 : 150, t: 14, b: 26 };
  const fit = Math.max(10, Math.floor((W - PAD.l - PAD.r) / MIN_BAR));
  const candles = all.slice(-fit);
  if (candles.length < 2) return <div ref={box}><p className="muted">Not enough candles to draw a chart.</p></div>;
  const agentLv = levels(agent, price);
  const engineLv = levels(engine, price);
  const extra = [...agentLv, ...engineLv].map((l) => l.v).concat(price ? [price] : []);
  const lo0 = Math.min(...candles.map((c) => c.low), ...extra);
  const hi0 = Math.max(...candles.map((c) => c.high), ...extra);
  const padY = (hi0 - lo0) * 0.06 || 1;
  const lo = lo0 - padY, hi = hi0 + padY;
  const pw = W - PAD.l - PAD.r, ph = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (i + 0.5) * (pw / candles.length);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * ph;
  const bw = Math.max(2, (pw / candles.length) * 0.66);
  // Skip an axis tick when a level label sits within 18px of it, so labels never overprint.
  const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4)
    .filter((t) => ![...agentLv, ...engineLv].map((l) => l.v).concat(price ? [price] : []).some((v) => Math.abs(y(v) - y(t)) < 18));
  const idxAt = (t?: string) => {
    if (!t) return -1;
    const exact = candles.findIndex((c) => c.time === t);
    if (exact >= 0) return exact;
    return candles.findIndex((c) => c.time >= t);
  };
  const flipIdx = idxAt(flip?.time);
  const asOfIdx = idxAt(asOf);
  const labelEvery = Math.max(1, Math.ceil(candles.length / Math.max(2, Math.floor(pw / 64)))); // one label per ~64px
  const hm = (t: string) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

  const summary = `Candle chart of ${candles.length} bars from ${hm(candles[0].time)} to ${hm(candles[candles.length - 1].time)}.`
    + (agent?.action === 'open' ? ` Agent proposes ${agent.side} with stop ${agent.stop}${agent.target ? ` and target ${agent.target}` : ''}.` : agent ? ` Agent proposes ${agent.action}.` : '')
    + (engine?.action === 'open' ? ` Engine opened ${engine.side} with stop ${engine.stop}.` : engine ? ` Engine decided ${engine.action}.` : '');

  return (
    <div ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={W - PAD.r + 8} y={y(t) + 4} fontSize={11} fill="var(--muted)" className="num">{fmt(t)}</text>
          </g>
        ))}
        {candles.map((c, i) => {
          const up = c.close >= c.open;
          const col = up ? 'var(--good)' : 'var(--bad)';
          const top = y(Math.max(c.open, c.close)), bot = y(Math.min(c.open, c.close));
          return (
            <g key={c.time + i}>
              <title>{`${new Date(c.time).toLocaleString()}  O ${c.open}  H ${c.high}  L ${c.low}  C ${c.close}  V ${c.volume}`}</title>
              <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={col} strokeWidth={1} />
              <rect x={x(i) - bw / 2} y={top} width={bw} height={Math.max(1, bot - top)} fill={col} />
            </g>
          );
        })}
        {candles.map((c, i) => i % labelEvery === 0 && (
          <text key={`l${i}`} x={x(i)} y={H - 8} fontSize={11} textAnchor="middle" fill="var(--muted)">{hm(c.time)}</text>
        ))}
        {asOfIdx >= 0 && (
          <g>
            <line x1={x(asOfIdx)} x2={x(asOfIdx)} y1={PAD.t} y2={H - PAD.b} stroke="var(--accent)" strokeWidth={1} strokeDasharray="2 4" />
            <text x={x(asOfIdx)} y={PAD.t + 10} fontSize={11} fill="var(--accent)" textAnchor={asOfIdx > candles.length * 0.8 ? 'end' : 'start'} dx={asOfIdx > candles.length * 0.8 ? -4 : 4}>snapshot</text>
          </g>
        )}
        {flipIdx >= 0 && flip?.signal && (() => {
          const c = candles[flipIdx];
          const buy = flip.signal === 'buy';
          const cx = x(flipIdx), cy = buy ? y(c.low) + 12 : y(c.high) - 12;
          return (
            <polygon points={buy ? `${cx},${cy - 7} ${cx - 6},${cy + 4} ${cx + 6},${cy + 4}` : `${cx},${cy + 7} ${cx - 6},${cy - 4} ${cx + 6},${cy - 4}`}
              fill={buy ? 'var(--good)' : 'var(--bad)'} stroke="var(--surface)" strokeWidth={1}>
              <title>{`${flip.signal} flip${flip.price ? ` @ ${flip.price}` : ''}`}</title>
            </polygon>
          );
        })()}
        {price ? (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(price)} y2={y(price)} stroke="var(--text)" strokeWidth={1} strokeDasharray="1 3" opacity={0.7} />
            <text x={W - PAD.r + 8} y={y(price) + 4} fontSize={11} fill="var(--text)" fontWeight={600}>entry {fmt(price)}</text>
          </g>
        ) : null}
        {[...engineLv.map((l) => ({ ...l, who: 'engine' as const })), ...agentLv.map((l) => ({ ...l, who: 'agent' as const }))].map((l) => {
          const col = l.kind === 'stop' ? 'var(--bad)' : 'var(--good)';
          return (
            <g key={`${l.who}-${l.key}`}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(l.v)} y2={y(l.v)} stroke={col} strokeWidth={l.who === 'agent' ? 1.6 : 1.2} strokeDasharray={l.who === 'engine' ? '6 4' : undefined} />
              <text x={W - PAD.r + 8} y={y(l.v) + (l.who === 'engine' ? 13 : 4)} fontSize={11} fill={col} fontWeight={l.who === 'agent' ? 600 : 400}>{l.who} {l.kind} {fmt(l.v)}</text>
            </g>
          );
        })}
      </svg>
      <div className="legend small muted">
        <span><i className="sw solid" /> agent stop / target</span>
        <span><i className="sw dashed" /> engine stop / target</span>
        <span><i className="sw dot" /> entry price</span>
        <span>▲ buy flip · ▼ sell flip</span>
      </div>
    </div>
  );
}
