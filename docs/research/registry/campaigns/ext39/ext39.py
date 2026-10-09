"""ext39: continuation or reversal after an extreme daily move, pooled over the 33 tsmom36 daily markets.
Data: audit/tsmom36/daily.db (read-only), spreads from audit/tsmom36/out/spreads.json (history.db candles_ba M1 medians).

  python ext39.py check      synthetic fixtures (event rule, declustering, no lookahead in sigma, outcome sign, bootstrap)
  python ext39.py describe   event counts per window / class / threshold (no outcomes)
  python ext39.py register   write prereg.json (refuses to overwrite)
  python ext39.py run        all cells -> out/results.json, trials.jsonl rows
"""
import os, sys, json, time, hashlib, sqlite3
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out")
DB = os.path.join(ENG, "audit", "tsmom36", "daily.db")
SPREADS = os.path.join(ENG, "audit", "tsmom36", "out", "spreads.json")
TRIALS = os.path.join(ENG, "trials.jsonl")
EXP = "ext39"
SIG_N = 60
GAP = 5                     # one event per market per 5 trading days
THRESHOLDS = (2.0, 2.5, 3.0)
PRIMARY_K, PRIMARY_H = 2.5, 3
HS = (1, 3, 5, 10)
NBOOT, SEED = 1000, 39
FLAT_SIDE_BPS = 2.0
FIN_BPS_NIGHT = 0.03 / 365 * 1e4   # 0.822 bps per calendar night on the notional
WINDOWS = {"dev": ("2005-01-01", "2022-12-31"), "w2023": ("2023-01-01", "2100-01-01")}
CLASSES = ("all", "fx", "index", "commodity", "bond")
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()


def load():
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    d = pd.read_sql("SELECT instrument, cls, time, c FROM daily", db)
    # same calendar as tsmom36: OANDA time = bar open 17:00 NY, trading date = close date; drop weekend stubs
    d["date"] = (pd.to_datetime(d["time"]) + pd.Timedelta(days=1)).dt.normalize()
    d = d[d["date"].dt.dayofweek < 5]
    return {i: (g["cls"].iat[0], g.set_index("date")["c"].sort_index()) for i, g in d.groupby("instrument")}


def events(c, k):
    """Event rows of one close series on its own bars. sigma_t = std(r[t-60..t-1]); |r_t/sigma_t| >= k; then skip GAP-1 bars."""
    r = c.pct_change()
    sig = r.shift(1).rolling(SIG_N, min_periods=SIG_N).std()
    z = (r / sig).to_numpy()
    out, nxt = [], 0
    for t in np.flatnonzero(np.abs(np.nan_to_num(z)) >= k):
        if t < nxt:
            continue
        out.append(t); nxt = t + GAP
    return np.array(out, int), r.to_numpy(), sig.to_numpy()


def outcomes(c, t, d, sig, h, lag):
    """Signed forward return from close[t+lag] to close[t+lag+h], in sigma_t units and bps; NaN when the exit bar is missing."""
    v, idx = c.to_numpy(), c.index
    a, b = t + lag, t + lag + h
    ok = b < len(v)
    a, b = a[ok], b[ok]
    g = d[ok] * (v[b] / v[a] - 1)
    nights = (idx[b] - idx[a]).days.to_numpy()
    return ok, g / sig[t[ok]], g * 1e4, nights


def build(data, k, spreads):
    rows = []
    for inst, (cls, c) in data.items():
        t, r, sig = events(c, k)
        if not len(t):
            continue
        d = np.sign(r[t])
        side = spreads.get(inst, {}).get("median_spread_bps")
        side = side / 2 if side is not None else FLAT_SIDE_BPS
        for lag, entry in ((0, "close"), (1, "next")):
            for h in HS:
                ok, s, bps, nights = outcomes(c, t, d, sig, h, lag)
                net = bps - 2 * side - FIN_BPS_NIGHT * nights
                rows.append(pd.DataFrame({"inst": inst, "cls": cls, "date": c.index[t[ok]], "d": d[ok], "h": h, "entry": entry,
                                          "sig": s, "bps": bps, "net": net, "z": r[t[ok]] / sig[t[ok]]}))
    return pd.concat(rows, ignore_index=True)


def week_boot(x, week, reps=NBOOT, seed=SEED):
    """Cluster bootstrap: resample calendar weeks with replacement, mean over all events in the drawn weeks."""
    codes, inv = np.unique(week, return_inverse=True)
    s = np.bincount(inv, weights=x); n = np.bincount(inv)
    rng = np.random.default_rng(seed)
    draw = rng.integers(0, len(codes), (reps, len(codes)))
    return s[draw].sum(1) / n[draw].sum(1)


def stats(df):
    if len(df) < 5:
        return {"n": int(len(df))}
    wk = (df["date"].dt.isocalendar().year * 100 + df["date"].dt.isocalendar().week).to_numpy()
    b = week_boot(df["sig"].to_numpy(), wk)
    bb = week_boot(df["bps"].to_numpy(), wk)
    bn = week_boot(df["net"].to_numpy(), wk)
    return {"n": int(len(df)), "weeks": int(len(np.unique(wk))),
            "mean_sig": float(df["sig"].mean()), "ci_sig": [float(np.percentile(b, 2.5)), float(np.percentile(b, 97.5))],
            "mean_bps": float(df["bps"].mean()), "ci_bps": [float(np.percentile(bb, 2.5)), float(np.percentile(bb, 97.5))],
            "net_bps": float(df["net"].mean()), "ci_net": [float(np.percentile(bn, 2.5)), float(np.percentile(bn, 97.5))],
            "hit": float((df["sig"] > 0).mean()), "mde80_sig": float(2.8 * b.std())}


def window(df, w):
    a, b = WINDOWS[w]
    return df[(df["date"] >= a) & (df["date"] <= b)]


# ------------------------------------------------------------------ fixtures
def check():
    idx = pd.bdate_range("2010-01-01", periods=400)
    rng = np.random.default_rng(0)
    r = rng.normal(0, 0.01, 400)
    r[200] = 0.10; r[202] = 0.10; r[206] = -0.10       # 202 inside the 5-bar window of 200; 206 outside
    c = pd.Series(100 * np.cumprod(1 + r), index=idx)
    t, rr, sig = events(c, 2.5)
    assert 200 in t and 202 not in t and 206 in t, t
    # sigma uses returns up to t-1 only: changing r[t] leaves sigma_t unchanged
    c2 = c.copy(); c2.iloc[200:] *= 1.5
    assert np.isclose(events(c2, 2.5)[2][200], sig[200])
    # first 60 returns give no sigma -> no event before bar 61
    assert t.min() > SIG_N
    # outcome sign: d * forward return, so a further move in the event direction is positive
    v = c.to_numpy()
    ok, s, bps, n = outcomes(c, np.array([200, 206]), np.array([1.0, -1.0]), sig, 3, 0)
    assert np.isclose(bps[0], (v[203] / v[200] - 1) * 1e4) and np.isclose(bps[1], -(v[209] / v[206] - 1) * 1e4)
    ok, s, bps, n = outcomes(c, np.array([200]), np.array([1.0]), sig, 3, 1)
    assert np.isclose(bps[0], (v[204] / v[201] - 1) * 1e4)
    # exit past the end is dropped
    assert not outcomes(c, np.array([398]), np.array([1.0]), sig, 3, 0)[0][0]
    # bootstrap: identical events give a zero-width CI; week clustering keeps same-week rows together
    b = week_boot(np.ones(50), np.repeat(np.arange(10), 5))
    assert np.allclose(b, 1)
    x = np.r_[np.full(25, 1.0), np.full(25, -1.0)]
    assert week_boot(x, np.repeat([0, 1], 25)).std() > week_boot(x, np.arange(50)).std()
    # planted continuation -> positive mean in sigma
    rows = []
    for j in range(5):
        rr2 = rng.normal(0, 0.01, 1500)
        for e in range(100, 1490, 30):
            rr2[e] = 0.05 * rng.choice([-1, 1]); rr2[e + 1:e + 4] = 0.01 * np.sign(rr2[e])
        rows.append(pd.Series(100 * np.cumprod(1 + rr2), index=pd.bdate_range("2010-01-01", periods=1500)))
    df = build({f"s{j}": ("fx", s_) for j, s_ in enumerate(rows)}, 2.5, {})
    p = df[(df.h == 3) & (df.entry == "close")]
    st = stats(p)
    assert st["ci_sig"][0] > 0.5, st
    print("check ok")


def describe():
    data = load()
    res = {}
    for k in THRESHOLDS:
        df = build(data, k, {})
        p = df[(df.h == 1) & (df.entry == "close")]
        for w in WINDOWS:
            x = window(p, w)
            res[f"k{k}_{w}"] = {"all": int(len(x)), **x.groupby("cls").size().astype(int).to_dict(),
                                "up": int((x.d > 0).sum()), "down": int((x.d < 0).sum()), "weeks": int(x.date.dt.to_period("W").nunique())}
    os.makedirs(OUT, exist_ok=True)
    json.dump(res, open(os.path.join(OUT, "describe.json"), "w"), indent=1)
    print(json.dumps(res, indent=1))


def register():
    f = os.path.join(HERE, "prereg.json")
    if os.path.exists(f):
        sys.exit("prereg.json exists")
    body = json.load(open(os.path.join(HERE, "prereg_body.json")))
    body = {"created": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "code_sha256": {"ext39.py": sha(os.path.join(HERE, "ext39.py"))}, **body}
    json.dump(body, open(f, "w"), indent=1)
    print("registered", f)


def run():
    if not os.path.exists(os.path.join(HERE, "prereg.json")):
        sys.exit("register first")
    data = load()
    spreads = json.load(open(SPREADS))
    res, trials, ts = {"cells": {}}, [], time.strftime("%Y-%m-%dT%H:%M:%S")
    for k in THRESHOLDS:
        df = build(data, k, spreads)
        for (h, entry), g in df.groupby(["h", "entry"]):
            for cl in CLASSES:
                gc = g if cl == "all" else g[g.cls == cl]
                for dr in ("all", "up", "down"):
                    gd = gc if dr == "all" else gc[gc.d == (1 if dr == "up" else -1)]
                    for w in WINDOWS:
                        st = stats(window(gd, w))
                        key = f"k{k}_h{h}_{entry}_{cl}_{dr}_{w}"
                        prim = k == PRIMARY_K and h == PRIMARY_H and entry == "close" and cl == "all" and dr == "all"
                        res["cells"][key] = st
                        trials.append({"ts": ts, "exp": EXP, "unit": cl, "tf": "D", "cell": f"k{k}_h{h}_{entry}_{dr}",
                                       "window": w, "primary": prim, **st})
        if k == PRIMARY_K:
            # per-instrument primary-cell means (diagnostic)
            p = df[(df.h == PRIMARY_H) & (df.entry == "close")]
            res["per_instrument"] = {w: window(p, w).groupby("inst")["sig"].agg(["size", "mean"]).round(4).to_dict("index") for w in WINDOWS}
    a, b = res["cells"][f"k{PRIMARY_K}_h{PRIMARY_H}_close_all_all_dev"], res["cells"][f"k{PRIMARY_K}_h{PRIMARY_H}_close_all_all_w2023"]
    sgn = lambda s: 1 if s["ci_sig"][0] > 0 else (-1 if s["ci_sig"][1] < 0 else 0)
    res["verdict"] = ("PASS continuation" if sgn(a) == sgn(b) == 1 else "PASS reversal" if sgn(a) == sgn(b) == -1 else "FAIL")
    os.makedirs(OUT, exist_ok=True)
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1)
    with open(TRIALS, "a") as f:
        for t in trials:
            f.write(json.dumps(t) + "\n")
    print(res["verdict"], json.dumps(a), json.dumps(b), f"{len(trials)} trial rows")


if __name__ == "__main__":
    {"check": check, "describe": describe, "register": register, "run": run}[sys.argv[1]]()
