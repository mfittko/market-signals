"""swing43: short pullback in a long-term uptrend (Connors-style RSI(2)), held for days, 33 daily markets.
Data: audit/tsmom36/daily.db (read-only) via ext39.load(); spreads audit/tsmom36/out/spreads.json.

  python swing43.py check      synthetic fixtures (RSI, SMA, setup, exit rule, one trade at a time, drift, bootstrap)
  python swing43.py describe   trade counts per window / group (no outcomes)
  python swing43.py register   write prereg.json (refuses to overwrite)
  python swing43.py run        all cells -> out/results.json, trials.jsonl rows
"""
import os, sys, json, time, hashlib
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ENG, "audit", "ext39"))
import ext39  # noqa: E402  load(), week_boot(), WINDOWS, FIN_BPS_NIGHT, FLAT_SIDE_BPS, SPREADS

OUT = os.path.join(HERE, "out")
TRIALS = os.path.join(ENG, "trials.jsonl")
EXP = "swing43"
NBOOT, SEED = 1000, 43
WINDOWS = ext39.WINDOWS
INDICES = ("SPX500_USD", "NAS100_USD", "US30_USD", "DE30_EUR", "UK100_GBP", "JP225_USD", "HK33_HKD", "AU200_AUD")
TRADING6 = ("WTICO_USD", "XAU_USD", "XAG_USD", "NATGAS_USD", "SPX500_USD", "EUR_USD")
GROUPS = ("index", "commodity", "fx", "bond", "trading6", "all")
# variant: (side, setup kind, setup threshold, exit kind)
VARIANTS = {
    "primary": ("long", "rsi", 10, "sma5"),
    "rsi5": ("long", "rsi", 5, "sma5"),
    "rsi25": ("long", "rsi", 25, "sma5"),
    "down2": ("long", "down", 2, "sma5"),
    "down3": ("long", "down", 3, "sma5"),
    "fixed5": ("long", "rsi", 10, "fixed5"),
    "short": ("short", "rsi", 90, "sma5"),
}
MAX_HOLD = 10
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()


def rsi_wilder(c, n=2):
    """Wilder RSI on closes: seed = simple mean of the first n gains/losses, then avg = (avg*(n-1) + x)/n."""
    d = np.diff(np.asarray(c, float))
    out = np.full(len(c), np.nan)
    if len(d) < n:
        return out
    g, l = np.clip(d, 0, None), np.clip(-d, 0, None)
    ag, al = g[:n].mean(), l[:n].mean()
    for i in range(n, len(d) + 1):
        if i > n:
            ag = (ag * (n - 1) + g[i - 1]) / n
            al = (al * (n - 1) + l[i - 1]) / n
        out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def setup_mask(c, side, kind, thr):
    """Boolean setup at the close of each bar t, using closes up to t only."""
    v = c.to_numpy(float)
    sma200 = c.rolling(200, min_periods=200).mean().to_numpy()
    trend = (v > sma200) if side == "long" else (v < sma200)
    if kind == "rsi":
        r = rsi_wilder(v)
        sig = (r < thr) if side == "long" else (r > thr)
    else:  # thr consecutive down closes
        dn = pd.Series(np.r_[False, v[1:] < v[:-1]])
        sig = dn.rolling(thr, min_periods=thr).sum().to_numpy() == thr
    return np.nan_to_num(trend & sig, nan=0).astype(bool) & ~np.isnan(sma200)


def trades(c, side, kind, thr, exit_kind):
    """Entry at close t; exit at first close j > t with close > SMA5 (short: < SMA5) or at t+10 (fixed5: t+5).
    One open trade per instrument: the next entry needs t > previous exit bar. Trades without an exit bar are dropped."""
    v = c.to_numpy(float)
    sma5 = c.rolling(5, min_periods=5).mean().to_numpy()
    m = setup_mask(c, side, kind, thr)
    out, free = [], 0
    for t in np.flatnonzero(m):
        if t < free:
            continue
        x = None
        if exit_kind == "fixed5":
            x = t + 5 if t + 5 < len(v) else None
        else:
            for j in range(t + 1, min(t + MAX_HOLD, len(v) - 1) + 1):
                if (v[j] > sma5[j]) if side == "long" else (v[j] < sma5[j]):
                    x = j; break
                if j == t + MAX_HOLD:
                    x = j
        if x is None:
            break
        out.append((t, x)); free = x + 1
    return out


def drift(c, side):
    """Daily log returns r_d = ln(c_d/c_{d-1}) on days whose prior close is in the trend state (long: > SMA200, short: <)."""
    v = c.to_numpy(float)
    sma200 = c.rolling(200, min_periods=200).mean().to_numpy()
    st = (v > sma200) if side == "long" else (v < sma200)
    st = st & ~np.isnan(sma200)
    r = np.r_[np.nan, np.diff(np.log(v))]
    keep = np.r_[False, st[:-1]]
    return pd.Series(r[keep], index=c.index[keep])


def build(data, variant, spreads):
    side, kind, thr, ex = VARIANTS[variant]
    sgn = 1 if side == "long" else -1
    rows = []
    for inst, (cls, c) in data.items():
        tr = trades(c, side, kind, thr, ex)
        if not tr:
            continue
        dr = drift(c, side)
        mu = {w: dr[(dr.index >= a) & (dr.index <= b)].mean() for w, (a, b) in WINDOWS.items()}
        half = spreads.get(inst, {}).get("median_spread_bps")
        half = half / 2 if half is not None else ext39.FLAT_SIDE_BPS
        t, x = np.array(tr).T
        dt, dx = c.index[t], c.index[x]
        lr = sgn * np.log(c.to_numpy()[x] / c.to_numpy()[t]) * 1e4
        days = x - t
        w = np.where(dt <= pd.Timestamp(WINDOWS["dev"][1]), "dev", "w2023")
        md = np.array([sgn * mu[k] * 1e4 for k in w]) * days
        nights = (dx - dt).days.to_numpy()
        rows.append(pd.DataFrame({"inst": inst, "cls": cls, "date": dt, "exit": dx, "days": days, "nights": nights,
                                  "gross": lr, "drift": md, "excess": lr - md,
                                  "fut": lr - 2 * half, "cfd": lr - 2 * half - ext39.FIN_BPS_NIGHT * nights}))
    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame()


def group(df, g):
    if g == "all":
        return df
    if g == "trading6":
        return df[df.inst.isin(TRADING6)]
    if g == "index":
        return df[df.inst.isin(INDICES)]
    return df[df.cls == g]


def window(df, w):
    a, b = WINDOWS[w]
    return df[(df["date"] >= a) & (df["date"] <= b)]


def ci(x, wk):
    b = ext39.week_boot(x, wk, NBOOT, SEED)
    return [float(np.percentile(b, 2.5)), float(np.percentile(b, 97.5))], float(2.8 * b.std())


def stats(df, w):
    n = len(df)
    if n < 5:
        return {"n": int(n)}
    iso = df["date"].dt.isocalendar()
    wk = (iso.year * 100 + iso.week).to_numpy()
    a, b = WINDOWS[w]
    yrs = (min(pd.Timestamp(b), df["exit"].max()) - pd.Timestamp(a)).days / 365.25
    out = {"n": int(n), "weeks": int(len(np.unique(wk))), "insts": int(df.inst.nunique()),
           "trades_per_year": n / yrs, "trades_per_year_per_inst": n / yrs / df.inst.nunique(),
           "days_held": float(df.days.mean()), "nights_held": float(df.nights.mean()),
           "hit_gross": float((df.gross > 0).mean()), "hit_excess": float((df.excess > 0).mean())}
    for k in ("gross", "drift", "excess", "fut", "cfd"):
        c95, mde = ci(df[k].to_numpy(), wk)
        out[k] = float(df[k].mean()); out["ci_" + k] = c95
        if k == "excess":
            out["mde80_excess"] = mde
    return out


# ------------------------------------------------------------------ fixtures
def check():
    # RSI: strictly rising closes -> 100; strictly falling -> 0; Wilder recursion by hand
    assert np.allclose(rsi_wilder(np.arange(1, 11.0))[2:], 100)
    assert np.allclose(rsi_wilder(np.arange(10, 0, -1.0))[2:], 0)
    r = rsi_wilder(np.array([10, 11, 10.5, 10.0]))
    ag, al = 0.5, 0.25                      # seed over diffs (+1, -0.5)
    assert np.isclose(r[2], 100 - 100 / (1 + ag / al))
    ag, al = (ag + 0) / 2, (al + 0.5) / 2   # next diff -0.5
    assert np.isclose(r[3], 100 - 100 / (1 + ag / al))
    assert np.isnan(r[:2]).all()
    # planted series: long uptrend, then a 2-bar pullback, then recovery
    idx = pd.bdate_range("2010-01-01", periods=260)
    v = np.linspace(100, 150, 260)
    v[230], v[231] = 143, 141               # pullback (still > SMA200 ~ 125)
    v[232:] = np.linspace(149.5, 151, 28)
    c = pd.Series(v, index=idx)
    m = setup_mask(c, "long", "rsi", 10)
    assert m[231] and not m[229] and not m[:200].any(), np.flatnonzero(m)
    tr = trades(c, "long", "rsi", 10, "sma5")
    assert tr[0] == (231, 232), tr          # exits on the first close above SMA5
    assert trades(c, "long", "rsi", 10, "fixed5")[0] == (231, 236)
    # no lookahead: changing closes after t leaves the setup at t unchanged
    c2 = c.copy(); c2.iloc[232:] = 10
    assert setup_mask(c2, "long", "rsi", 10)[231]
    # time exit at t+10 when the close never recovers above SMA5; one trade at a time
    v3 = np.r_[np.linspace(100, 200, 250), 200 - np.arange(1, 30) * 0.5]
    c3 = pd.Series(v3, index=pd.bdate_range("2010-01-01", periods=len(v3)))
    tr3 = trades(c3, "long", "rsi", 10, "sma5")
    assert tr3[0][1] - tr3[0][0] == MAX_HOLD, tr3
    assert all(b[0] > a[1] for a, b in zip(tr3, tr3[1:])), tr3
    # down closes setup
    assert setup_mask(c, "long", "down", 2)[231] and not setup_mask(c, "long", "down", 3)[231]
    # drift: uses returns whose prior close is above SMA200
    d = drift(c, "long")
    assert d.index[0] == idx[200] and np.isclose(d.iloc[0], np.log(v[200] / v[199]))
    # excess removes a pure drift: geometric series with constant log return -> excess 0 on every trade
    g = pd.Series(100 * np.exp(0.001 * np.arange(400)), index=pd.bdate_range("2010-01-01", periods=400))
    g.iloc[300:302] *= 0.99                 # dip, a setup at 301
    df = build({"x": ("index", g)}, "primary", {})
    assert len(df) >= 1 and (df.days > 0).all() and (df.fut == df.gross - 2 * ext39.FLAT_SIDE_BPS).all()
    assert np.allclose(df.cfd, df.fut - ext39.FIN_BPS_NIGHT * df.nights)
    assert np.allclose(df.excess, df.gross - df.drift)
    # short mirror sign: falling series with a bounce -> setup in downtrend, positive gross when price falls after
    s = pd.Series(np.r_[np.linspace(200, 100, 260)], index=pd.bdate_range("2010-01-01", periods=260))
    s.iloc[230:232] = [s.iloc[229] + 3, s.iloc[229] + 6]
    ds = build({"y": ("index", s)}, "short", {})
    assert len(ds) and ds.gross.iloc[0] > 0
    # bootstrap reuse: planted +50 bps per trade excess gives CI > 0
    rng = np.random.default_rng(0)
    x = 50 + rng.normal(0, 100, 600)
    c95, _ = ci(x, np.repeat(np.arange(200), 3))
    assert c95[0] > 0, c95
    print("check ok")


def describe():
    data = ext39.load()
    res = {}
    for v in VARIANTS:
        df = build(data, v, {})
        for w in WINDOWS:
            x = window(df, w)
            res[f"{v}_{w}"] = {g: int(len(group(x, g))) for g in GROUPS}
            if v == "primary":
                res[f"{v}_{w}"]["per_index"] = x[x.inst.isin(INDICES)].groupby("inst").size().astype(int).to_dict()
                res[f"{v}_{w}"]["index_weeks"] = int(group(x, "index").date.dt.to_period("W").nunique())
    os.makedirs(OUT, exist_ok=True)
    json.dump(res, open(os.path.join(OUT, "describe.json"), "w"), indent=1)
    print(json.dumps(res, indent=1))


def register():
    f = os.path.join(HERE, "prereg.json")
    if os.path.exists(f):
        sys.exit("prereg.json exists")
    body = json.load(open(os.path.join(HERE, "prereg_body.json")))
    body = {"created": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "code_sha256": {"swing43.py": sha(os.path.join(HERE, "swing43.py")),
            "ext39.py": sha(os.path.join(ENG, "audit", "ext39", "ext39.py"))}, **body}
    json.dump(body, open(f, "w"), indent=1)
    print("registered", f)


def run():
    if not os.path.exists(os.path.join(HERE, "prereg.json")):
        sys.exit("register first")
    data = ext39.load()
    spreads = json.load(open(ext39.SPREADS))
    res, trials, ts = {"cells": {}}, [], time.strftime("%Y-%m-%dT%H:%M:%S")
    code = sha(os.path.join(HERE, "swing43.py"))

    def log(key, st, unit, cell, w, prim):
        res["cells"][key] = st
        trials.append({"ts": ts, "exp": EXP, "unit": unit, "tf": "D", "cell": cell, "window": w, "primary": prim,
                       "role": "primary" if prim else "secondary", **st, "swing43_sha256": code})

    for v in VARIANTS:
        df = build(data, v, spreads)
        df.to_csv(os.path.join(OUT, f"trades_{v}.csv"), index=False)
        for g in GROUPS:
            for w in WINDOWS:
                log(f"{v}_{g}_{w}", stats(window(group(df, g), w), w), g, v, w, v == "primary" and g == "index")
        for inst in sorted(df.inst.unique()):
            for w in WINDOWS:
                log(f"{v}_inst_{inst}_{w}", stats(window(df[df.inst == inst], w), w), inst, v, w, False)
        if v == "primary":
            ix = group(df, "index")
            res["per_year_index"] = {int(y): {"n": int(len(g)), "gross": float(g.gross.mean()), "excess": float(g.excess.mean()),
                                              "hit": float((g.gross > 0).mean())} for y, g in ix.groupby(ix.date.dt.year)}
    a, b = res["cells"]["primary_index_dev"], res["cells"]["primary_index_w2023"]
    ok = lambda s: s["excess"] > 0 and s["ci_excess"][0] > 0
    res["verdict"] = "PASS" if ok(a) and ok(b) else "FAIL"
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1)
    with open(TRIALS, "a") as f:
        for t in trials:
            f.write(json.dumps(t) + "\n")
    print(res["verdict"], json.dumps(a), json.dumps(b), f"{len(trials)} trial rows")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    {"check": check, "describe": describe, "register": register, "run": run}[sys.argv[1]]()
