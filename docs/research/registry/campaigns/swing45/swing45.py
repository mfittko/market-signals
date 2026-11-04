"""swing45: the swing43 index pullback rule on intraday resolutions (M1..H4) with variable dip triggers.
Rule pieces, statistic, CI and MDE come from audit/swing43/swing43.py (imported unchanged, sha pinned); seed 45.
Data: data/research/history.db candles_ba M1 bid/ask (read-only), cached as out/cache/*.npz; daily regime from
audit/tsmom36/daily.db and audit/swing44/daily.db through ext39.load() (read-only).

  python swing45.py check      swing43 fixtures, sha pin, resampling / regime / trade / spread / Holm fixtures
  python swing45.py describe   instruments, bars, trade counts per cell (no returns)
  python swing45.py register   write prereg.json (refuses to overwrite)
  python swing45.py run        all cells -> out/results.json, trials.jsonl rows
"""
import os, sys, json, time, hashlib, sqlite3
import numpy as np
import pandas as pd
from scipy.stats import norm

HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ENG, "audit", "swing43"))
import swing43 as s43  # noqa: E402
import ext39  # noqa: E402

OUT = os.path.join(HERE, "out")
CACHE = os.path.join(OUT, "cache")
TRIALS = os.path.join(ENG, "trials.jsonl")
HIST = os.path.join(os.path.dirname(ENG), "history.db")
D44 = os.path.join(ENG, "audit", "swing44", "daily.db")
EXP = "swing45"
SEED = 45
SWING43_SHA = "52be7a2df33fe8d3b0fcaa45c8cea5b7c04c31bfd85ba770843cf59325148e75"
NY = "America/New_York"
WINS = {"dev": ("2018-01-01", "2022-12-31 23:59"), "w2023": ("2023-01-01", "2026-10-08 21:00")}
CUT = pd.Timestamp("2026-10-08 21:00")   # last daily close in the daily dbs (2026-10-08 17:00 NY), UTC naive
INDICES = ("SPX500/USD", "NAS100/USD", "US30/USD", "DE30/EUR", "UK100/GBP", "JP225/USD", "AU200/AUD", "EU50/EUR")
TRADING6 = ("WTICO/USD", "XAU/USD", "XAG/USD", "NATGAS/USD", "SPX500/USD", "EUR/USD")
RES = {"M1": 1, "M5": 5, "M15": 15, "M30": 30, "H1": 60, "H4": "H4"}
TRIGGERS = {"down2": ("down", 2), "down3": ("down", 3), "down4": ("down", 4), "down5": ("down", 5),
            "rsi5": ("rsi", 5), "rsi10": ("rsi", 10), "rsi25": ("rsi", 25)}
FILTERS = ("bar", "daily")
ALPHA = 0.05
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
dname = lambda i: i.replace("/", "_")


# ------------------------------------------------------------------ data
def load_m1(inst):
    """M1 close-bid/close-ask from history.db (read-only), cached. Returns UTC epoch minutes of bar start, bid, ask."""
    f = os.path.join(CACHE, dname(inst) + ".npz")
    if not os.path.exists(f):
        con = sqlite3.connect(f"file:{HIST}?mode=ro", uri=True)
        rows = con.execute("select time, bid_c, ask_c from candles_ba where instrument=? and granularity='M1' order by time",
                           (inst,)).fetchall()
        con.close()
        t = np.array([r[0][:16] for r in rows], "datetime64[m]").astype(np.int64)
        np.savez(f, t=t, bid=np.array([r[1] for r in rows], float), ask=np.array([r[2] for r in rows], float))
    z = np.load(f)
    return z["t"], z["bid"], z["ask"]


def bucket(t, res):
    """Bar key per M1 start minute. Minute resolutions: UTC floor. H4: New York wall clock, bars start 17:00/21:00/01:00/..."""
    if res != "H4":
        return t // res
    loc = pd.DatetimeIndex(t.astype("datetime64[m]")).tz_localize("UTC").tz_convert(NY).tz_localize(None)
    m = loc.to_numpy().astype("datetime64[m]").astype(np.int64)
    return (m - 17 * 60) // 240


def resample(t, bid, ask, res):
    """Bars from M1: close = last M1 in the bar (mid), spread = that M1's ask - bid, bar time = last M1 start + 1 min (UTC)."""
    ok = np.isfinite(bid) & np.isfinite(ask) & (ask >= bid) & (bid > 0)
    t, bid, ask = t[ok], bid[ok], ask[ok]
    k = bucket(t, res)
    last = np.r_[k[1:] != k[:-1], True]
    tt, b, a = t[last], bid[last], ask[last]
    mid = (b + a) / 2
    idx = pd.DatetimeIndex((tt + 1).astype("datetime64[m]"))
    return pd.DataFrame({"c": mid, "spr": (a - b) / mid * 1e4}, index=idx)


def daily_regime():
    """{inst: Series(bool, index = UTC close time of each daily bar)}: daily close > daily SMA200 (from 2003-2006 history)."""
    d = ext39.load()
    old = ext39.DB
    ext39.DB = D44
    try:
        d.update({k: v for k, v in ext39.load().items() if k not in d})
    finally:
        ext39.DB = old
    out = {}
    for i in set(INDICES) | set(TRADING6):
        c = d[dname(i)][1]
        sma = c.rolling(200, min_periods=200).mean()
        close_utc = (c.index + pd.Timedelta(hours=17)).tz_localize(NY).tz_convert("UTC").tz_localize(None)
        out[i] = (pd.Series(((c > sma) & sma.notna()).to_numpy(), index=close_utc),
                  pd.Series(((c < sma) & sma.notna()).to_numpy(), index=close_utc))
    return out


def asof(state, idx):
    """Daily state known at each bar time: the last daily close at or before the bar time (False before the first)."""
    j = np.searchsorted(state.index.to_numpy(), idx.to_numpy(), side="right") - 1
    return np.where(j >= 0, state.to_numpy()[np.clip(j, 0, None)], False)


# ------------------------------------------------------------------ rule
def signal(v, side, kind, thr):
    """Dip trigger at the close of bar t (closes up to t). Long: RSI(2) < thr or thr consecutive lower closes.
    Short mirror: RSI(2) > 100 - thr or thr consecutive higher closes."""
    if kind == "rsi":
        r = s43.rsi_wilder(v)
        return np.nan_to_num((r < thr) if side == "long" else (r > 100 - thr), nan=0).astype(bool)
    step = np.r_[False, (v[1:] < v[:-1]) if side == "long" else (v[1:] > v[:-1])]
    return pd.Series(step).rolling(thr, min_periods=thr).sum().to_numpy() == thr


def trend(v, side, filt, reg_idx=None, dreg=None):
    """Trend state at each bar close: bar filter close vs SMA200 of that resolution; daily filter = daily regime as of the bar."""
    if filt == "bar":
        sma = pd.Series(v).rolling(200, min_periods=200).mean().to_numpy()
        st = (v > sma) if side == "long" else (v < sma)
        return st & ~np.isnan(sma)
    return asof(dreg[0] if side == "long" else dreg[1], reg_idx)


def trades_from(v, m, side):
    """swing43.trades exit logic on a given setup mask: entry close t, exit at first close above SMA5 (short: below)
    or at t + 10 bars; one open trade; trades without an exit bar dropped."""
    sma5 = pd.Series(v).rolling(5, min_periods=5).mean().to_numpy()
    out, free, n = [], 0, len(v)
    for t in np.flatnonzero(m):
        if t < free:
            continue
        x = None
        for j in range(t + 1, min(t + s43.MAX_HOLD, n - 1) + 1):
            if ((v[j] > sma5[j]) if side == "long" else (v[j] < sma5[j])) or j == t + s43.MAX_HOLD:
                x = j; break
        if x is None:
            break
        out.append((t, x)); free = x + 1
    return out


def tdate(idx):
    """Trading date of a UTC bar time: New York time + 7 h (the 17:00 NY roll starts the next date).
    Stray Friday bars after 17:00 NY (OANDA prints a few) stay on Friday."""
    d = (idx.tz_localize("UTC").tz_convert(NY).tz_localize(None) + pd.Timedelta(hours=7)).normalize()
    return d - pd.to_timedelta(np.clip(d.dayofweek - 4, 0, None), unit="D")


def build(bars, inst, side, kind, thr, filt, dreg):
    """Trade rows for one instrument / resolution / trigger / filter. Excess = log return - window drift per bar x bars held,
    drift = mean bar log return over bars whose prior bar is in the trend state (as swing43.drift, per resolution)."""
    v, idx = bars["c"].to_numpy(float), bars.index
    st = trend(v, side, filt, idx, dreg)
    m = st & signal(v, side, kind, thr)
    tr = trades_from(v, m, side)
    if not tr:
        return pd.DataFrame()
    sgn = 1 if side == "long" else -1
    r = np.r_[np.nan, np.diff(np.log(v))]
    keep = np.r_[False, st[:-1]]
    mu = {}
    for w, (a, b) in WINS.items():
        sel = keep & (idx >= a) & (idx <= b)
        mu[w] = np.nanmean(r[sel]) if sel.any() else np.nan
    t, x = np.array(tr).T
    dt, dx = idx[t], idx[x]
    w = np.where(dt <= pd.Timestamp(WINS["dev"][1]), "dev", "w2023")
    lr = sgn * np.log(v[x] / v[t]) * 1e4
    held = x - t
    md = np.array([sgn * mu[k] * 1e4 for k in w]) * held
    cost = (bars["spr"].to_numpy()[t] + bars["spr"].to_numpy()[x]) / 2
    nights = (tdate(dx) - tdate(dt)).days.to_numpy()
    df = pd.DataFrame({"inst": inst, "date": dt, "exit": dx, "days": held, "nights": nights, "gross": lr, "drift": md,
                       "excess": lr - md, "cost": cost, "net": lr - cost, "cfd": lr - cost - ext39.FIN_BPS_NIGHT * nights})
    return df[(df.date >= WINS["dev"][0]) & (df.exit <= CUT)]


# ------------------------------------------------------------------ stats
def win(df, w):
    a, b = WINS[w]
    return df[(df["date"] >= a) & (df["date"] <= b)]


def stats(df, tdays):
    """swing43.ci (ext39 week bootstrap, ISO week of entry, 1000 reps, seed 45) on gross, drift, excess, net, cfd.
    tdays = trading days with bars, summed over the instruments in df. One-sided p for excess > 0 from the bootstrap SE."""
    n = len(df)
    if n < 5:
        return {"n": int(n)}
    iso = df["date"].dt.isocalendar()
    wk = (iso.year * 100 + iso.week).to_numpy()
    out = {"n": int(n), "weeks": int(len(np.unique(wk))), "insts": int(df.inst.nunique()),
           "trades_per_day_per_inst": n / max(tdays, 1), "bars_held": float(df.days.mean()),
           "nights_held": float(df.nights.mean()), "hit_gross": float((df.gross > 0).mean()),
           "hit_excess": float((df.excess > 0).mean()), "hit_net": float((df.net > 0).mean()),
           "abs_gross": float(df.gross.abs().mean()), "spread_cost": float(df.cost.mean())}
    out["spread_share"] = out["spread_cost"] / out["abs_gross"] if out["abs_gross"] > 0 else None
    for k in ("gross", "drift", "excess", "net", "cfd"):
        c95, mde = s43.ci(df[k].to_numpy(), wk)
        out[k] = float(df[k].mean()); out["ci_" + k] = c95
        if k == "excess":
            out["mde80_excess"] = mde
            se = mde / 2.8
            out["se_excess"] = se
            out["p_one_sided"] = float(norm.sf(out["excess"] / se)) if se > 0 else (0.0 if out["excess"] > 0 else 1.0)
    return out


def holm(cells):
    """Holm step-down over a dict {key: stats}; adds holm_p, holm_lb (excess - z(1 - alpha_k) x SE) and holm_pass.
    Cells with n < 5 count in the family with p = 1."""
    keys = sorted(cells, key=lambda k: cells[k].get("p_one_sided", 1.0))
    m, run, stop = len(keys), 0.0, False
    for r, k in enumerate(keys):
        p = cells[k].get("p_one_sided", 1.0)
        run = max(run, min(1.0, (m - r) * p))
        a_k = ALPHA / (m - r)
        lb = cells[k]["excess"] - norm.isf(a_k) * cells[k]["se_excess"] if "se_excess" in cells[k] else None
        ok = (not stop) and p <= a_k
        stop = stop or not ok
        cells[k].update({"holm_p": run, "holm_alpha": a_k, "holm_lb": lb, "holm_pass": bool(ok)})
    return cells


# ------------------------------------------------------------------ fixtures
def check():
    assert sha(os.path.join(ENG, "audit", "swing43", "swing43.py")) == SWING43_SHA, "swing43.py changed"
    s43.check()
    assert s43.MAX_HOLD == 10 and s43.NBOOT == 1000
    # resampling: M5 close = last M1 of the bucket, spread from that M1, bar time = last start + 1 min
    t = np.array(["2024-01-02T14:00", "2024-01-02T14:01", "2024-01-02T14:04", "2024-01-02T14:05"], "datetime64[m]").astype(np.int64)
    b, a = np.array([100, 101, 102, 103.0]), np.array([100.2, 101.2, 102.4, 103.2])
    r5 = resample(t, b, a, 5)
    assert len(r5) == 2 and np.isclose(r5.c.iloc[0], 102.2) and str(r5.index[0]) == "2024-01-02 14:05:00"
    assert np.isclose(r5.spr.iloc[0], 0.4 / 102.2 * 1e4)
    # H4 aligned to 17:00 New York in winter (22:00 UTC) and summer (21:00 UTC)
    tw = np.array(["2024-01-02T21:59", "2024-01-02T22:00", "2024-07-02T20:59", "2024-07-02T21:00"], "datetime64[m]").astype(np.int64)
    k = bucket(tw, "H4")
    assert k[0] != k[1] and k[2] != k[3]
    tw2 = np.array(["2024-01-02T22:00", "2024-01-03T01:59", "2024-01-03T02:00"], "datetime64[m]").astype(np.int64)
    k2 = bucket(tw2, "H4")
    assert k2[0] == k2[1] != k2[2]
    # trigger + bar filter + exit parity with swing43 (setup_mask, trades) on its own planted series
    idx = pd.bdate_range("2010-01-01", periods=260)
    v = np.linspace(100, 150, 260); v[230], v[231] = 143, 141; v[232:] = np.linspace(149.5, 151, 28)
    c = pd.Series(v, index=idx)
    for kind, thr in (("rsi", 10), ("rsi", 25), ("down", 2), ("down", 3)):
        m = trend(v, "long", "bar") & signal(v, "long", kind, thr)
        assert (m == s43.setup_mask(c, "long", kind, thr)).all(), (kind, thr)
        assert trades_from(v, m, "long") == s43.trades(c, "long", kind, thr, "sma5")
    rng = np.random.default_rng(3)
    vr = 100 * np.exp(np.cumsum(rng.normal(0.0002, 0.01, 3000)))
    cr = pd.Series(vr, index=pd.bdate_range("2000-01-03", periods=3000))
    for kind, thr in (("rsi", 5), ("rsi", 10), ("down", 3)):
        m = trend(vr, "long", "bar") & signal(vr, "long", kind, thr)
        assert trades_from(vr, m, "long") == s43.trades(cr, "long", kind, thr, "sma5")
    ms = trend(vr, "short", "bar") & signal(vr, "short", "rsi", 10)
    assert (ms == s43.setup_mask(cr, "short", "rsi", 90)).all()
    assert trades_from(vr, ms, "short") == s43.trades(cr, "short", "rsi", 90, "sma5")
    # short mirror of the down trigger uses higher closes
    assert signal(np.array([1, 2, 3, 4.0]), "short", "down", 3)[3] and not signal(np.array([1, 2, 3, 4.0]), "long", "down", 3)[3]
    # daily regime as of: known at its close time, not before
    st = pd.Series([True, False], index=pd.to_datetime(["2024-01-02 22:00", "2024-01-03 22:00"]))
    q = asof(st, pd.DatetimeIndex(["2024-01-02 21:59", "2024-01-02 22:00", "2024-01-03 21:59", "2024-01-03 22:01"]))
    assert list(q) == [False, True, True, False]
    # build: geometric drift -> excess ~ 0; costs from per-bar spreads; nights by NY trading date
    n = 600
    bi = pd.date_range("2024-01-02 14:00", periods=n, freq="5min")
    g = 100 * np.exp(0.0001 * np.arange(n)); g[400:402] *= 0.995
    bars = pd.DataFrame({"c": g, "spr": np.linspace(1, 2, n)}, index=bi)
    df = build(bars, "x", "long", "rsi", 10, "bar", None)
    assert len(df) >= 1
    t0 = np.searchsorted(bi, df.date.iloc[0]); x0 = np.searchsorted(bi, df.exit.iloc[0])
    assert np.isclose(df.cost.iloc[0], (bars.spr.iloc[t0] + bars.spr.iloc[x0]) / 2)
    assert np.allclose(df.net, df.gross - df.cost) and np.allclose(df.excess, df.gross - df.drift)
    assert tdate(pd.DatetimeIndex(["2024-01-02 21:59"]))[0] != tdate(pd.DatetimeIndex(["2024-01-02 22:00"]))[0]
    assert str(tdate(pd.DatetimeIndex(["2024-07-05 21:30"]))[0].date()) == "2024-07-05"   # Friday after 17:00 NY
    assert str(tdate(pd.DatetimeIndex(["2024-07-07 22:00"]))[0].date()) == "2024-07-08"   # Sunday open -> Monday
    # Holm: one strong cell passes, a null family does not
    cells = {"a": {"excess": 10.0, "se_excess": 1.0, "p_one_sided": float(norm.sf(10))}}
    cells.update({f"z{i}": {"excess": 0.1, "se_excess": 1.0, "p_one_sided": float(norm.sf(0.1))} for i in range(83)})
    h = holm(cells)
    assert h["a"]["holm_pass"] and h["a"]["holm_lb"] > 0 and not any(h[f"z{i}"]["holm_pass"] for i in range(83))
    s43.SEED = SEED
    print("swing45 check ok")


# ------------------------------------------------------------------ runs
def instruments():
    con = sqlite3.connect(f"file:{HIST}?mode=ro", uri=True)
    rows = con.execute("select instrument, count(*), min(time), max(time) from candles_ba where granularity='M1' "
                       "and instrument in (%s) group by 1" % ",".join("?" * len(set(INDICES) | set(TRADING6))),
                       tuple(sorted(set(INDICES) | set(TRADING6)))).fetchall()
    con.close()
    return {r[0]: {"m1_rows": r[1], "first": r[2][:16], "last": r[3][:16]} for r in rows}


def bars_for(inst, res):
    t, b, a = load_m1(inst)
    return resample(t, b, a, RES[res])


def trading_days(bars):
    td = pd.Series(tdate(bars.index))
    return {w: int(td[(bars.index >= a) & (bars.index <= b)].nunique()) for w, (a, b) in WINS.items()}


def describe():
    os.makedirs(CACHE, exist_ok=True)
    dreg = daily_regime()
    res = {"instruments": instruments(), "counts": {}, "bars": {}}
    for inst in INDICES:
        for rs in RES:
            bars = bars_for(inst, rs)
            res["bars"][f"{inst}_{rs}"] = {"bars": int(len(bars)), **trading_days(bars)}
            v, idx = bars["c"].to_numpy(float), bars.index
            for tg, (kind, thr) in TRIGGERS.items():
                sig = signal(v, "long", kind, thr)
                for f in FILTERS:
                    m = trend(v, "long", f, idx, dreg[inst]) & sig
                    tr = trades_from(v, m, "long")
                    d = pd.DatetimeIndex(idx[[t for t, _ in tr]])
                    for w, (a, b) in WINS.items():
                        key = f"{rs}_{tg}_{f}_{w}"
                        res["counts"].setdefault(key, 0)
                        res["counts"][key] += int(((d >= a) & (d <= b)).sum())
        print(inst, "done", flush=True)
    json.dump(res, open(os.path.join(OUT, "describe.json"), "w"), indent=1)
    print(json.dumps(res["instruments"], indent=1))


def register():
    f = os.path.join(HERE, "prereg.json")
    if os.path.exists(f):
        sys.exit("prereg.json exists")
    body = json.load(open(os.path.join(HERE, "prereg_body.json")))
    body = {"created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "code_sha256": {n: sha(os.path.join(ENG, "audit", d, n)) for d, n in
                            (("swing45", "swing45.py"), ("swing43", "swing43.py"), ("ext39", "ext39.py"))}, **body}
    json.dump(body, open(f, "w"), indent=1)
    print("registered", f)


def run():
    if not os.path.exists(os.path.join(HERE, "prereg.json")):
        sys.exit("register first")
    assert sha(os.path.join(ENG, "audit", "swing43", "swing43.py")) == SWING43_SHA
    s43.SEED = SEED
    dreg = daily_regime()
    insts = list(dict.fromkeys(INDICES + TRADING6))
    res, trials, ts = {"cells": {}}, [], time.strftime("%Y-%m-%dT%H:%M:%S")
    code = sha(os.path.abspath(__file__))
    alltr = []
    tdays = {}
    for inst in insts:
        for rs in RES:
            bars = bars_for(inst, rs)
            tdays[(inst, rs)] = trading_days(bars)
            v_sig = {}
            for side in ("long", "short"):
                if side == "short" and inst not in INDICES:
                    continue
                for tg, (kind, thr) in TRIGGERS.items():
                    for f in FILTERS:
                        df = build(bars, inst, side, kind, thr, f, dreg[inst])
                        if len(df):
                            df["res"], df["trig"], df["filt"], df["side"] = rs, tg, f, side
                            alltr.append(df)
        print(inst, "done", flush=True)
    T = pd.concat(alltr, ignore_index=True)
    T.to_parquet(os.path.join(OUT, "trades.parquet"))

    def td(sel_insts, rs, w):
        return sum(tdays[(i, rs)][w] for i in sel_insts)

    def log(key, st, unit, cell, w, prim, extra):
        res["cells"][key] = st
        trials.append({"ts": ts, "exp": EXP, "unit": unit, "tf": extra.get("res"), "cell": cell, "window": w, "primary": prim,
                       "role": "primary" if prim else "secondary", **extra, **st, "swing45_sha256": code})

    G = {k: g for k, g in T.groupby(["res", "trig", "filt", "side"])}
    empty = T.iloc[:0]
    for rs in RES:
        for tg in TRIGGERS:
            for f in FILTERS:
                for side in ("long", "short"):
                    g = G.get((rs, tg, f, side), empty)
                    ex = {"res": rs, "trigger": tg, "filter": f, "side": side}
                    units = [("indices", INDICES, g[g.inst.isin(INDICES)])]
                    if side == "long":
                        units += [("trading6", TRADING6, g[g.inst.isin(TRADING6)])]
                        units += [(i, (i,), g[g.inst == i]) for i in insts]
                    for unit, ui, gg in units:
                        for w in WINS:
                            prim = unit == "indices" and side == "long"
                            log(f"{unit}_{rs}_{tg}_{f}_{side}_{w}", stats(win(gg, w), td(ui, rs, w)), unit,
                                f"{rs}_{tg}_{f}_{side}", w, prim, ex)
        print(rs, "stats done", flush=True)
    # Holm per window over the 84 primary cells
    verdict_cells = []
    for w in WINS:
        fam = {f"{rs}_{tg}_{f}": res["cells"][f"indices_{rs}_{tg}_{f}_long_{w}"] for rs in RES for tg in TRIGGERS for f in FILTERS}
        holm(fam)
    for rs in RES:
        for tg in TRIGGERS:
            for f in FILTERS:
                a, b = res["cells"][f"indices_{rs}_{tg}_{f}_long_dev"], res["cells"][f"indices_{rs}_{tg}_{f}_long_w2023"]
                if a.get("holm_pass") and b.get("holm_pass") and a["net"] > 0 and b["net"] > 0:
                    verdict_cells.append(f"{rs}_{tg}_{f}")
    res["passing_cells"] = verdict_cells
    res["verdict"] = "PASS" if verdict_cells else "FAIL"
    # daily swing43 reference on the same 8 indices, 2018-01-01..2026-10-08 (swing43.build, drift from these windows)
    s43.WINDOWS = {"dev": WINS["dev"], "w2023": WINS["w2023"]}
    s43.VARIANTS.update({"down4": ("long", "down", 4, "sma5"), "down5": ("long", "down", 5, "sma5"), "rsi10": s43.VARIANTS["primary"]})
    d = ext39.load()
    old = ext39.DB; ext39.DB = D44
    try:
        d.update({k: v for k, v in ext39.load().items() if k not in d})
    finally:
        ext39.DB = old
    data = {dname(i): d[dname(i)] for i in INDICES}
    spreads = json.load(open(ext39.SPREADS))
    for tg in TRIGGERS:
        df = s43.build(data, tg, spreads)
        df = df[(df.date >= WINS["dev"][0]) & (df.date <= "2026-10-08")]
        df = df.rename(columns={"fut": "net"}).assign(cost=lambda x: x.gross - x.net)
        for w in WINS:
            nd = sum(int(((data[i][1].index >= a) & (data[i][1].index <= b)).sum()) for i in data for a, b in [WINS[w]])
            log(f"indices_D_{tg}_daily_long_{w}", stats(win(df, w), nd), "indices", f"D_{tg}_daily_long", w, False,
                {"res": "D", "trigger": tg, "filter": "daily(swing43)", "side": "long"})
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    with open(TRIALS, "a") as fh:
        for t in trials:
            fh.write(json.dumps(t, default=float) + "\n")
    print(res["verdict"], verdict_cells, f"{len(trials)} trial rows")


if __name__ == "__main__":
    os.makedirs(CACHE, exist_ok=True)
    {"check": check, "describe": describe, "register": register, "run": run}[sys.argv[1]]()
