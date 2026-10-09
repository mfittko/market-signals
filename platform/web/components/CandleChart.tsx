'use client';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Decision } from '@/lib/api';
import { isAlerted } from '@/lib/signal-class';

export type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number; complete?: boolean };
export type STPoint = { time: string; value: number; trend: string };
export type SignalMark = { time: string; signal: string; verdict?: string | null; reason?: string | null; price?: number | null; kind?: string; granularity?: string };
export type TradeMark = { side: 'long' | 'short'; entryTime: string; entryPrice: number; closeTime: string; closePrice: number; realized: number; closeReason: string };
export type NewsMark = { time: string; title: string; source: string; escalation?: boolean; impact?: string | null };
type Flip = { signal?: string; time?: string; price?: number } | null | undefined;

type Props = {
  candles: Candle[];
  asOf?: string;
  price?: number; // entry price line (run page)
  lastPrice?: number; // live price line
  flip?: Flip;
  agent?: Decision;
  engine?: Decision;
  supertrend?: STPoint[];
  signals?: SignalMark[];
  trades?: TradeMark[];
  news?: NewsMark[];
};

const MIN_BAR = 7; // px per candle slot: fewer bars are drawn on narrow screens
const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(1) : v.toFixed(3));

// The engine writes nanosecond timestamps. Keep three fractional digits so every browser parses them.
const cache = new Map<string, number>();
const ms = (t: string) => {
  let v = cache.get(t);
  if (v === undefined) { v = Date.parse(t.replace(/(\.\d{3})\d+/, '$1')); cache.set(t, v); }
  return v;
};
const stamp = (t: string) => new Date(ms(t)).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const hm = (t: string) => new Date(ms(t)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

function levels(d: Decision | undefined) {
  if (!d || d.action !== 'open') return [];
  const out: { key: string; v: number; kind: 'stop' | 'target' }[] = [];
  if (d.stop) out.push({ key: 'stop', v: d.stop, kind: 'stop' });
  if (d.target) out.push({ key: 'target', v: d.target, kind: 'target' });
  return out;
}

export function CandleChart({ candles: all, asOf, price, lastPrice, flip, agent, engine, supertrend, signals, trades, news }: Props) {
  // Draw at the real pixel width so text stays 11px on a phone instead of scaling down.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0); // 0 until measured, so the first paint is already at the real width
  const [hover, setHover] = useState<{ i: number; py: number } | null>(null);
  const [span, setSpan] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el) setW(Math.max(280, Math.round(el.clientWidth)));
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = W < 560;
  const H = narrow ? 300 : 380;
  // The right margin holds the price labels. Long labels ("agent stop 91.234", "entry 91.344") only exist on
  // run pages, so other charts use a narrow margin and give the plot the space.
  const longLabels = price != null || !!agent || !!engine;
  const PAD = { l: 8, r: longLabels ? (narrow ? 104 : 150) : (narrow ? 80 : 88), t: 14, b: 32 };
  const fitW = Math.max(10, Math.floor((W - PAD.l - PAD.r) / MIN_BAR));
  // x-axis zoom: null fits the width at MIN_BAR px per candle; a number shows that many candles (at most the loaded ones)
  const fit = Math.min(all.length, span ?? fitW);
  const zoom = (f: number) => { setHover(null); setSpan(Math.max(20, Math.min(all.length, Math.round(fit * f)))); };
  const candles = useMemo(() => all.slice(-fit), [all, fit]);

  // The bar a moment falls into: the last bar starting at or before it, within one bar length of the end.
  const barMs = useMemo(() => {
    if (candles.length < 2) return 60000;
    const d: number[] = [];
    for (let i = 1; i < candles.length; i++) d.push(ms(candles[i].time) - ms(candles[i - 1].time));
    return d.sort((a, b) => a - b)[Math.floor(d.length / 2)] || 60000;
  }, [candles]);
  const barAt = (t?: string | null) => {
    if (!t || candles.length === 0) return -1;
    const m = ms(t);
    if (!(m >= ms(candles[0].time))) return -1;
    let lo = 0, hi = candles.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ms(candles[mid].time) <= m) lo = mid; else hi = mid - 1; }
    return m < ms(candles[lo].time) + barMs ? lo : -1;
  };

  const marks = useMemo(() => {
    const byBar = new Map<number, { signals: SignalMark[]; entries: TradeMark[]; exits: TradeMark[]; news: NewsMark[] }>();
    const slot = (i: number) => { let s = byBar.get(i); if (!s) { s = { signals: [], entries: [], exits: [], news: [] }; byBar.set(i, s); } return s; };
    for (const g of signals ?? []) { const i = barAt(g.time); if (i >= 0) slot(i).signals.push(g); }
    for (const t of trades ?? []) {
      const a = barAt(t.entryTime), b = barAt(t.closeTime);
      if (a >= 0) slot(a).entries.push(t);
      if (b >= 0) slot(b).exits.push(t);
    }
    for (const n of news ?? []) { const i = barAt(n.time); if (i >= 0) slot(i).news.push(n); }
    return byBar;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signals, trades, news, candles, barMs]);

  if (candles.length < 2) return <div ref={box}><p className="muted">Not enough candles to draw a chart.</p></div>;

  const agentLv = levels(agent);
  const engineLv = levels(engine);
  const stByBar = new Map<number, STPoint>();
  for (const p of supertrend ?? []) { const i = barAt(p.time); if (i >= 0 && ms(p.time) === ms(candles[i].time)) stByBar.set(i, p); }
  const tradeLines = (trades ?? []).filter((t) => barAt(t.entryTime) >= 0 || barAt(t.closeTime) >= 0);

  const extra = [...agentLv, ...engineLv].map((l) => l.v).concat(price ? [price] : [], lastPrice ? [lastPrice] : []);
  const lo0 = Math.min(...candles.map((c) => c.low), ...extra);
  const hi0 = Math.max(...candles.map((c) => c.high), ...extra);
  const padY = (hi0 - lo0) * 0.06 || 1;
  const lo = lo0 - padY, hi = hi0 + padY;
  const pw = W - PAD.l - PAD.r, ph = H - PAD.t - PAD.b;
  const slotW = pw / candles.length;
  const maxVol = Math.max(0, ...candles.map((c) => c.volume || 0));
  const x = (i: number) => PAD.l + (i + 0.5) * slotW;
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * ph;
  const priceAtY = (py: number) => lo + (1 - (py - PAD.t) / ph) * (hi - lo);
  const bw = Math.max(2, slotW * 0.66);
  const labelled = [...agentLv, ...engineLv].map((l) => l.v).concat(price ? [price] : [], lastPrice ? [lastPrice] : []);
  // Skip an axis tick when a level label sits within 18px of it, so labels never overprint.
  const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4).filter((t) => !labelled.some((v) => Math.abs(y(v) - y(t)) < 18));
  const flipIdx = barAt(flip?.time);
  const asOfIdx = barAt(asOf);
  const labelEvery = Math.max(1, Math.ceil(candles.length / Math.max(2, Math.floor(pw / 64)))); // one label per ~64px

  // Supertrend as line segments, coloured by trend and broken where the trend flips.
  const stSegs: { d: string; up: boolean }[] = [];
  {
    let cur: { pts: string[]; up: boolean } | null = null;
    for (let i = 0; i < candles.length; i++) {
      const p = stByBar.get(i);
      if (!p) { if (cur) { stSegs.push({ d: cur.pts.join(' '), up: cur.up }); cur = null; } continue; }
      const up = p.trend === 'up';
      if (!cur || cur.up !== up) { if (cur) stSegs.push({ d: cur.pts.join(' '), up: cur.up }); cur = { pts: [], up }; }
      cur.pts.push(`${cur.pts.length ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
    }
    if (cur) stSegs.push({ d: cur.pts.join(' '), up: cur.up });
  }

  const setFromEvent = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const scale = W / r.width;
    const px = (e.clientX - r.left) * scale, py = (e.clientY - r.top) * scale;
    const i = Math.max(0, Math.min(candles.length - 1, Math.floor((px - PAD.l) / slotW)));
    setHover({ i, py: Math.max(PAD.t, Math.min(H - PAD.b, py)) });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setHover(null); return; }
    if (e.key === '-' || e.key === '+' || e.key === '=') { e.preventDefault(); zoom(e.key === '-' ? 1.5 : 1 / 1.5); return; }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = hover?.i ?? candles.length - 1;
    const i = Math.max(0, Math.min(candles.length - 1, cur + (e.key === 'ArrowLeft' ? -1 : 1)));
    setHover({ i, py: y(candles[i].close) });
  };

  const hv = hover ? candles[hover.i] : null;
  const hvMarks = hover ? marks.get(hover.i) : undefined;
  const hvSt = hover ? stByBar.get(hover.i) : undefined;
  const last = candles[candles.length - 1];

  const summary = `Candle chart of ${candles.length} bars from ${hm(candles[0].time)} to ${hm(last.time)}.`
    + (agent?.action === 'open' ? ` Agent proposes ${agent.side} with stop ${agent.stop}${agent.target ? ` and target ${agent.target}` : ''}.` : agent ? ` Agent proposes ${agent.action}.` : '')
    + (engine?.action === 'open' ? ` Engine opened ${engine.side} with stop ${engine.stop}.` : engine ? ` Engine decided ${engine.action}.` : '')
    + ' Use the arrow keys to read single bars, minus and plus to show more or fewer bars.';
  const hvText = hv ? `${stamp(hv.time)}: open ${hv.open}, high ${hv.high}, low ${hv.low}, close ${hv.close}, volume ${hv.volume}${hv.complete === false ? ', still forming' : ''}` : '';

  if (!W) return <div ref={box} style={{ minHeight: 300 }} />; // reserves the space until the width is measured
  return (
    <div ref={box} style={{ position: 'relative' }}>
      {/* bottom-right corner: the price-label margin is free below the last tick */}
      <div className="seg" style={{ position: 'absolute', right: 4, bottom: 4, zIndex: 1 }}>
        <button type="button" onClick={() => zoom(1.5)} disabled={fit >= all.length} aria-label="Show more candles" title="Show more candles (−)">−</button>
        <button type="button" onClick={() => zoom(1 / 1.5)} disabled={fit <= 20} aria-label="Show fewer candles" title="Show fewer candles (+)">+</button>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} tabIndex={0}
        style={{ width: '100%', height: 'auto', display: 'block', touchAction: 'pan-y', outline: 'none' }}
        onPointerMove={setFromEvent} onPointerDown={setFromEvent}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover(null); }}
        onKeyDown={onKey} onBlur={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={W - PAD.r + 8} y={y(t) + 4} fontSize={11} fill="var(--muted)" className="num">{fmt(t)}</text>
          </g>
        ))}
        {candles.map((c, i) => {
          // Volume underlay: bars share the bottom 18% of the plot, scaled to the largest bar in view.
          const h = maxVol > 0 ? Math.max(1, (c.volume / maxVol) * ph * 0.18) : 0;
          return <rect key={`v${i}`} x={x(i) - bw / 2} y={PAD.t + ph - h} width={bw} height={h} fill={c.close >= c.open ? 'var(--good)' : 'var(--bad)'} opacity={0.22} />;
        })}
        {stSegs.map((s, k) => <path key={k} d={s.d} fill="none" stroke={s.up ? 'var(--good)' : 'var(--bad)'} strokeWidth={1.5} opacity={0.75} />)}
        {tradeLines.map((t, k) => {
          const a = barAt(t.entryTime), b = barAt(t.closeTime);
          const x1 = a >= 0 ? x(a) : PAD.l, x2 = b >= 0 ? x(b) : W - PAD.r;
          return <line key={k} x1={x1} y1={y(t.entryPrice)} x2={x2} y2={y(t.closePrice)} stroke={t.realized >= 0 ? 'var(--good)' : 'var(--bad)'} strokeWidth={1.4} strokeDasharray="4 3" opacity={0.85} />;
        })}
        {candles.map((c, i) => {
          const up = c.close >= c.open;
          const col = up ? 'var(--good)' : 'var(--bad)';
          const top = y(Math.max(c.open, c.close)), bot = y(Math.min(c.open, c.close));
          const forming = c.complete === false;
          return (
            <g key={c.time + i} opacity={hover && hover.i !== i ? 0.9 : 1}>
              <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={col} strokeWidth={1} />
              <rect x={x(i) - bw / 2} y={top} width={bw} height={Math.max(1, bot - top)} fill={forming ? 'var(--surface)' : col} stroke={col} strokeWidth={forming ? 1.4 : 0} strokeDasharray={forming ? '2 2' : undefined} />
            </g>
          );
        })}
        {candles.map((c, i) => i % labelEvery === 0 && (
          <text key={`l${i}`} x={x(i)} y={H - 16} fontSize={11} textAnchor="middle" fill="var(--muted)">{hm(c.time)}</text>
        ))}
        {[...marks.entries()].map(([i, m]) => (
          <g key={`m${i}`}>
            {m.signals.slice(0, 1).map((g) => {
              const buy = g.signal === 'buy', c = candles[i];
              const cx = x(i), cy = buy ? y(c.low) + 12 : y(c.high) - 12;
              const dim = !!g.verdict && !isAlerted(g);
              return <polygon key="s" points={buy ? `${cx},${cy - 7} ${cx - 6},${cy + 4} ${cx + 6},${cy + 4}` : `${cx},${cy + 7} ${cx - 6},${cy - 4} ${cx + 6},${cy - 4}`}
                fill={dim ? 'none' : buy ? 'var(--good)' : 'var(--bad)'} stroke={buy ? 'var(--good)' : 'var(--bad)'} strokeWidth={dim ? 1.2 : 1} opacity={dim ? 0.7 : 1} />;
            })}
            {m.entries.slice(0, 1).map((t) => <circle key="e" cx={x(i)} cy={y(t.entryPrice)} r={4} fill={t.side === 'long' ? 'var(--good)' : 'var(--bad)'} stroke="var(--surface)" strokeWidth={1.5} />)}
            {m.exits.slice(0, 1).map((t) => <rect key="x" x={x(i) - 3.5} y={y(t.closePrice) - 3.5} width={7} height={7} fill={t.realized >= 0 ? 'var(--good)' : 'var(--bad)'} stroke="var(--surface)" strokeWidth={1.5} />)}
            {m.news.length > 0 && <path d={`M${x(i)},${H - PAD.b - 9} l4,4.5 l-4,4.5 l-4,-4.5 z`} fill={m.news.some((n) => n.escalation) ? 'var(--bad)' : 'var(--warn)'} stroke="var(--surface)" strokeWidth={1} />}
          </g>
        ))}
        {asOfIdx >= 0 && (
          <g>
            <line x1={x(asOfIdx)} x2={x(asOfIdx)} y1={PAD.t} y2={H - PAD.b} stroke="var(--accent)" strokeWidth={1} strokeDasharray="2 4" />
            <text x={x(asOfIdx)} y={PAD.t + 10} fontSize={11} fill="var(--accent)" textAnchor={asOfIdx > candles.length * 0.8 ? 'end' : 'start'} dx={asOfIdx > candles.length * 0.8 ? -4 : 4}>snapshot</text>
          </g>
        )}
        {flipIdx >= 0 && flip?.signal && !signals?.length && (() => {
          const c = candles[flipIdx];
          const buy = flip.signal === 'buy';
          const cx = x(flipIdx), cy = buy ? y(c.low) + 12 : y(c.high) - 12;
          return <polygon points={buy ? `${cx},${cy - 7} ${cx - 6},${cy + 4} ${cx + 6},${cy + 4}` : `${cx},${cy + 7} ${cx - 6},${cy - 4} ${cx + 6},${cy - 4}`} fill={buy ? 'var(--good)' : 'var(--bad)'} stroke="var(--surface)" strokeWidth={1} />;
        })()}
        {price ? (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(price)} y2={y(price)} stroke="var(--text)" strokeWidth={1} strokeDasharray="1 3" opacity={0.7} />
            <text x={W - PAD.r + 8} y={y(price) + 4} fontSize={11} fill="var(--text)" fontWeight={600}>entry {fmt(price)}</text>
          </g>
        ) : null}
        {lastPrice ? (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(lastPrice)} y2={y(lastPrice)} stroke="var(--accent)" strokeWidth={1} strokeDasharray="3 3" />
            <rect x={W - PAD.r + 4} y={y(lastPrice) - 9} width={narrow ? 66 : 74} height={18} rx={4} fill="var(--accent)" />
            <text x={W - PAD.r + 9} y={y(lastPrice) + 4} fontSize={11} fill="#fff" fontWeight={700} className="num">{fmt(lastPrice)}</text>
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
        {hover && hv && (
          <g pointerEvents="none">
            <line x1={x(hover.i)} x2={x(hover.i)} y1={PAD.t} y2={H - PAD.b} stroke="var(--muted)" strokeWidth={1} strokeDasharray="3 3" />
            <line x1={PAD.l} x2={W - PAD.r} y1={hover.py} y2={hover.py} stroke="var(--muted)" strokeWidth={1} strokeDasharray="3 3" />
            <rect x={W - PAD.r + 4} y={hover.py - 9} width={narrow ? 66 : 74} height={18} rx={4} fill="var(--text)" />
            <text x={W - PAD.r + 9} y={hover.py + 4} fontSize={11} fill="var(--bg)" fontWeight={700} className="num">{fmt(priceAtY(hover.py))}</text>
          </g>
        )}
      </svg>

      {hover && hv && (
        <div className="chart-tip" role="status" style={{ left: Math.min(Math.max(x(hover.i), 0), W), transform: `translateX(${x(hover.i) > W * 0.55 ? 'calc(-100% - 14px)' : '14px'})` }}>
          <div className="tip-h">{stamp(hv.time)}{hv.complete === false && <span className="tip-live">forming</span>}</div>
          <div className="tip-grid num">
            <span>O</span><span>{hv.open}</span><span>H</span><span>{hv.high}</span>
            <span>L</span><span>{hv.low}</span><span>C</span><span className={hv.close >= hv.open ? 'good-t' : 'bad-t'}>{hv.close}</span>
          </div>
          <div className="small muted num">
            {(((hv.close - hv.open) / hv.open) * 100).toFixed(2)}% · range {(hv.high - hv.low).toFixed(3)} · vol {hv.volume}
          </div>
          {hvSt && <div className="small">Supertrend <span className="num">{fmt(hvSt.value)}</span> <span className={hvSt.trend === 'up' ? 'good-t' : 'bad-t'}>{hvSt.trend}</span></div>}
          {hvMarks?.signals.map((g, k) => (
            <div key={`g${k}`} className="tip-sec"><strong className={g.signal === 'buy' ? 'good-t' : 'bad-t'}>{g.signal} flip</strong>{g.kind && g.kind !== 'supertrend-flip' ? ` · ${g.kind.replace('supertrend-', '')}` : ''}{g.verdict ? ` · ${g.verdict}` : ''}{g.price ? ` @ ${g.price}` : ''}{g.reason && <div className="small">{g.reason.length > 160 ? `${g.reason.slice(0, 160)}…` : g.reason}</div>}</div>
          ))}
          {hvMarks?.entries.map((t, k) => <div key={`e${k}`} className="tip-sec">Paper trade opened: <strong>{t.side}</strong> @ {t.entryPrice}</div>)}
          {hvMarks?.exits.map((t, k) => <div key={`x${k}`} className="tip-sec">Closed ({t.closeReason}) @ {t.closePrice}: <strong className={t.realized >= 0 ? 'good-t' : 'bad-t'}>{t.realized >= 0 ? '+' : '−'}{Math.abs(t.realized).toFixed(2)}</strong></div>)}
          {hvMarks?.news.slice(0, 3).map((n, k) => <div key={`n${k}`} className="tip-sec small"><span className={n.escalation ? 'bad-t' : 'muted'}>{n.source}{n.escalation ? ' · escalation' : ''}{n.impact ? ` · ${n.impact}` : ''}</span><br />{n.title.length > 110 ? `${n.title.slice(0, 110)}…` : n.title}</div>)}
        </div>
      )}
      <span className="sr-only" aria-live="polite">{hvText}</span>

      <div className="legend small muted">
        {(agentLv.length > 0 || engineLv.length > 0) && <><span><i className="sw solid" /> agent stop / target</span><span><i className="sw dashed" /> engine stop / target</span></>}
        {price ? <span><i className="sw dot" /> entry price</span> : null}
        {stSegs.length > 0 && <span><i className="sw solid" style={{ borderTopColor: 'var(--good)' }} /> Supertrend</span>}
        {((signals?.length ?? 0) > 0 || flip) && <span>▲ buy flip · ▼ sell flip (hollow: suppressed)</span>}
        {tradeLines.length > 0 && <span>● entry · ■ exit</span>}
        {(news?.length ?? 0) > 0 && <span><span style={{ color: 'var(--warn)' }}>◆</span> news</span>}
        {maxVol > 0 && <span>shaded bars: volume</span>}
        {last.complete === false && <span>dashed candle: still forming</span>}
      </div>
    </div>
  );
}
