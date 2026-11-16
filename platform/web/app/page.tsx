'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, money, type DeskRow } from '@/lib/api';
import { useLive } from '@/lib/live';
import { BotBadge, useActiveBots } from '@/lib/bots';
import { Ago, Card, Loading } from '@/components/ui';
import { MiniCandles } from '@/components/MiniCandles';

const GRANS = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4'];
// Tile size: minimum tile width in the grid and candle strip height.
const SIZES: Record<string, { min: number; candles: number }> = { S: { min: 220, candles: 32 }, M: { min: 300, candles: 44 }, L: { min: 440, candles: 80 } };
const GRAN_KEY = 'ms-desk-gran', SIZE_KEY = 'ms-desk-size', FAV_KEY = 'ms-desk-favs';

// Per-browser Desk preferences. shortcut: localStorage only, so favourites do not follow you to another browser; move to settings if that matters.
const load = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };

// Near-live mid for one Desk card, polled every 5 s while the tab is visible.
// Green or red shows the direction of the last change; the first colour compares with the engine's previous different mid. A failed poll hides the price.
// ponytail: one poll per card; the engine caches 1 s per instrument, add a batch endpoint if the grid grows large.
function LivePrice({ slug }: { slug: string }) {
  const [p, setP] = useState<{ mid: number; dir: number } | null>(null);
  useEffect(() => {
    let dead = false, busy = false;
    const pull = async () => {
      // one pull at a time, so an older response never lands after a newer one
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const r = await api<{ mid: number; prevMid?: number | null }>(`/instruments/${slug}/price`);
        // the first colour comes from the engine's previous different mid; later ones from this card's own last mid
        if (!dead && Number.isFinite(r.mid)) setP((o) => ({ mid: r.mid, dir: Math.sign(r.mid - (o?.mid ?? r.prevMid ?? r.mid)) || (o?.dir ?? 0) }));
      } catch { if (!dead) setP(null); }
      finally { busy = false; }
    };
    void pull();
    const t = setInterval(pull, 5000);
    document.addEventListener('visibilitychange', pull); // a returning tab refreshes at once instead of showing the old mid
    return () => { dead = true; clearInterval(t); document.removeEventListener('visibilitychange', pull); };
  }, [slug]);
  if (!p) return null;
  return <span className={`num ${p.dir > 0 ? 'good-t' : p.dir < 0 ? 'bad-t' : ''}`} title="Live mid price">{p.mid}</span>;
}

export default function Desk() {
  const [rows, setRows] = useState<DeskRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [market, setMarket] = useState('all');
  const [active, setActive] = useState(true);
  const [gran, setGran] = useState('M5');
  const [size, setSize] = useState('M');
  const [favs, setFavs] = useState<string[]>([]);
  useEffect(() => {
    const g = load(GRAN_KEY), s = load(SIZE_KEY);
    if (g && GRANS.includes(g)) setGran(g);
    if (s && SIZES[s]) setSize(s);
    try { const f = JSON.parse(load(FAV_KEY) ?? '[]'); if (Array.isArray(f)) setFavs([...new Set(f.filter((x): x is string => typeof x === 'string'))]); } catch { /* bad value: no favourites */ }
  }, []);
  const pickGran = (g: string) => { setGran(g); save(GRAN_KEY, g); };
  const pickSize = (s: string) => { setSize(s); save(SIZE_KEY, s); };
  // Starring moves the tile to the other section and remounts it. A keyboard toggle moves focus to the star's new place;
  // a mouse toggle does not, because focusing scrolls the page away from where the user clicked.
  const refocus = useRef<string | null>(null);
  const toggleFav = (sym: string, keyboard: boolean) => { refocus.current = keyboard ? sym : null; setFavs((f) => { const n = f.includes(sym) ? f.filter((x) => x !== sym) : [...f, sym]; save(FAV_KEY, JSON.stringify(n)); return n; }); };
  useEffect(() => {
    if (refocus.current) document.querySelector<HTMLButtonElement>(`button[data-fav="${CSS.escape(refocus.current)}"]`)?.focus();
    refocus.current = null;
  }, [favs]);
  const { tick } = useLive();

  useEffect(() => {
    api<{ instruments: DeskRow[] }>('/desk').then((d) => { setRows(d.instruments); setError(null); }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [tick]);

  const markets = useMemo(() => ['all', ...Array.from(new Set((rows ?? []).map((r) => r.market)))], [rows]);
  const bots = useActiveBots();
  const isActive = (r: DeskRow) => bots?.has(r.symbol) || r.agents.some((a) => a.enabled);
  // Favourites ignore the filters and keep the order they were starred in; the filtered grid below leaves them out.
  // A favourite missing from /desk is skipped, not deleted: a partial response must not wipe stored favourites.
  const favRows = favs.map((s) => (rows ?? []).find((r) => r.symbol === s)).filter((r): r is DeskRow => !!r);
  const shown = (rows ?? []).filter((r) => !favs.includes(r.symbol) && (market === 'all' || r.market === market) && (!active || isActive(r)));
  const total = (rows ?? []).reduce((s, r) => s + r.realized, 0);
  const trades = (rows ?? []).reduce((s, r) => s + r.trades, 0);
  const wins = (rows ?? []).reduce((s, r) => s + r.wins, 0);
  const sz = SIZES[size];
  const gridStyle = { gridTemplateColumns: `repeat(auto-fill, minmax(min(${sz.min}px, 100%), 1fr))` };

  const tile = (r: DeskRow) => {
    const fav = favs.includes(r.symbol);
    return (
      <Link key={r.symbol} href={`/instruments/${r.slug}`} className="card inst">
        <div className="row"><h3>{r.name}</h3>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><BotBadge grans={bots?.get(r.symbol)} />
            {/* shortcut: a button inside the card link; preventDefault keeps the click from navigating. Split the card into link + actions if more buttons arrive. */}
            <button type="button" data-fav={r.symbol} className={`fav${fav ? ' on' : ''}`} aria-pressed={fav} aria-label={fav ? `Remove ${r.name} from favourites` : `Add ${r.name} to favourites`}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFav(r.symbol, e.detail === 0); }}>{fav ? '★' : '☆'}</button></span></div>
        <div className="row small"><span className="muted">{r.symbol}</span><LivePrice slug={r.slug} /></div>
        <MiniCandles slug={r.slug} gran={gran} height={sz.candles} />
        <div className="row small">
          <span className="muted">{r.market} · {r.granularities.join(' ')}</span>
          <span className={`num ${r.realized >= 0 ? 'good-t' : 'bad-t'}`}>{r.trades ? `${money(r.realized)} · ${r.wins}/${r.trades} won` : 'no trades yet'}</span>
        </div>
        <div className="small muted">
          {r.lastSignal ? <>Last signal <strong>{r.lastSignal}</strong> <Ago iso={r.lastSignalAt} /></> : 'No signals'}
          {r.dataThrough && <> · {r.live ? "last candle" : "imported data through"} <Ago iso={r.dataThrough} /></>}
        </div>
        <div className="tools">
          {r.agents.length === 0 && <span className="muted small">No agents</span>}
          {r.agents.map((a) => (
            <span className="tool" key={a.id} title={`${a.name}${a.strategy ? ` · ${a.strategy}` : ''}`} style={{ opacity: a.enabled ? 1 : 0.5 }}>
              {a.granularity} {a.runtime}{a.enabled ? '' : ' off'}
            </span>
          ))}
        </div>
      </Link>
    );
  };

  return (
    <main className="wrap">
      <div className="top"><div className="left"><h1>Desk</h1><span className="chip mode">Paper only · agents advise, nothing is traded</span>
        {rows && trades > 0 && <Link href="/portfolio" className="small" title="Closed paper trades, including the previous bot versions">Realized <span className={total >= 0 ? 'good-t' : 'bad-t'}>{money(total)}</span> · {wins} of {trades} trades won</Link>}</div>
        <div className="left">
          <span className="small muted">Tiles</span>
          <div className="seg" role="group" aria-label="Tile size">
            {Object.keys(SIZES).map((s) => <button key={s} aria-pressed={size === s} onClick={() => pickSize(s)}>{s}</button>)}
          </div>
          <label className="small muted">Candles <select value={gran} onChange={(e) => pickGran(e.target.value)} aria-label="Candle resolution">{GRANS.map((g) => <option key={g}>{g}</option>)}</select></label>
        </div></div>
      {error && <div className="msg err" role="alert" style={{ marginBottom: 16 }}>Cannot reach the control plane: {error}</div>}
      {!rows ? <Loading /> : <>
        <section aria-label="Favourites" style={{ marginBottom: 20 }}>
          <h2 className="small muted" style={{ margin: '0 0 8px' }}>Favourites</h2>
          {favRows.length === 0
            ? <div className="small muted">Star an instrument with ☆ to pin it here.</div>
            : <div className="inst-grid" style={gridStyle}>{favRows.map(tile)}</div>}
        </section>
        <div className="filters">
          <div className="seg" role="group" aria-label="Market">
            {markets.map((m) => <button key={m} aria-pressed={market === m} onClick={() => setMarket(m)}>{m}</button>)}
          </div>
          <label className="switch"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Only instruments with a bot or agent on ({rows.filter(isActive).length} of {rows.length})</label>
        </div>
        {shown.length === 0 ? (
          <Card><div className="empty">{rows.length === 0 ? <>No instruments yet. Run the importer to bring in the previous engine&apos;s instruments and bots.</> : 'No other instruments match these filters.'}</div></Card>
        ) : (
          <div className="inst-grid" style={gridStyle}>{shown.map(tile)}</div>
        )}
      </>}
    </main>
  );
}
