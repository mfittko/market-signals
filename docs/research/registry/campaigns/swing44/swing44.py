"""swing44: out-of-sample replication of swing43 (RSI(2) pullback in a long-term uptrend) on equity indices not in swing43.
Rule, statistic, costs and bootstrap come from audit/swing43/swing43.py (imported unchanged, sha checked); seed 44.
Data: audit/swing44/daily.db (fetch.py) read through ext39.load(); swing43 data audit/tsmom36/daily.db read-only.

  python swing44.py check      swing43 fixtures, sha pin, universe rule fixtures
  python swing44.py describe   history, correlation with the swing43 indices, universe, trade counts (no outcomes)
  python swing44.py register   write prereg.json (refuses to overwrite)
  python swing44.py run        all cells -> out/results.json, trials.jsonl rows
"""
import os, sys, json, time, hashlib
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ENG, "audit", "swing43"))
import swing43 as s43  # noqa: E402
import ext39  # noqa: E402  (on sys.path through swing43)

OUT = os.path.join(HERE, "out")
TRIALS = os.path.join(ENG, "trials.jsonl")
DB = os.path.join(HERE, "daily.db")
OLD_DB = ext39.DB
EXP = "swing44"
SEED = 44
SWING43_SHA = "52be7a2df33fe8d3b0fcaa45c8cea5b7c04c31bfd85ba770843cf59325148e75"
CANDIDATES = ("FR40_EUR", "EU50_EUR", "NL25_EUR", "CH20_CHF", "ESPIX_EUR", "SG30_SGD", "CN50_USD", "IN50_USD",
              "TWIX_USD", "US2000_USD", "CHINAH_HKD", "JP225Y_JPY")
MAX_START = pd.Timestamp("2010-12-31")   # history from 2010 or earlier
MAX_CORR = 0.95                          # near copy of a swing43 index
CORR_FROM = "2005-01-01"
VARIANTS = ("primary", "down3", "rsi5")
FULL = ("2005-01-01", "2100-01-01")
WINS = ("full", "dev", "w2023")
CRASH = (2008, 2011, 2015, 2018, 2020, 2022)
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()


def load_new():
    ext39.DB = DB
    try:
        return ext39.load()
    finally:
        ext39.DB = OLD_DB


def load_old():
    d = ext39.load()
    return {i: d[i] for i in s43.INDICES}


def max_corr(new_c, old):
    """Highest daily simple-return correlation of one series with any swing43 index, on common dates from 2005."""
    r = pd.DataFrame({k: v[1] for k, v in old.items()}).pct_change(fill_method=None)
    x = new_c.pct_change(fill_method=None)
    r, x = r[r.index >= CORR_FROM], x[x.index >= CORR_FROM]
    c = r.corrwith(x)
    return str(c.idxmax()), float(c.max())


def universe(new, old):
    """Keep candidates with first close <= 2010-12-31 and max correlation <= 0.95 with every swing43 index."""
    info = {}
    for i in CANDIDATES:
        if i not in new:
            info[i] = {"status": "not served"}
            continue
        c = new[i][1]
        peer, rho = max_corr(c, old)
        ok_hist = c.index[0] <= MAX_START
        info[i] = {"first": str(c.index[0].date()), "last": str(c.index[-1].date()), "bars": int(len(c)),
                   "max_corr_with": peer, "max_corr": rho,
                   "status": "kept" if ok_hist and rho <= MAX_CORR else
                   ("dropped: history starts after 2010" if not ok_hist else "dropped: near copy (corr > 0.95)")}
    return info, tuple(i for i in CANDIDATES if info[i]["status"] == "kept")


def window(df, w):
    a, b = FULL if w == "full" else ext39.WINDOWS[w]
    return df[(df["date"] >= a) & (df["date"] <= b)]


def stats(df, w):
    """swing43.stats unchanged (seed 44 through s43.SEED); trades-per-year recomputed for the full window."""
    st = s43.stats(df, "dev" if w == "full" else w)
    if w == "full" and st.get("n", 0) >= 5:
        yrs = (df["exit"].max() - pd.Timestamp(FULL[0])).days / 365.25
        st["trades_per_year"] = st["n"] / yrs
        st["trades_per_year_per_inst"] = st["n"] / yrs / st["insts"]
    return st


# ------------------------------------------------------------------ fixtures
def check():
    assert sha(os.path.join(ENG, "audit", "swing43", "swing43.py")) == SWING43_SHA, "swing43.py changed"
    s43.check()
    assert s43.VARIANTS["primary"] == ("long", "rsi", 10, "sma5") and s43.MAX_HOLD == 10 and s43.NBOOT == 1000
    # universe rule: a near copy is dropped, a late start is dropped, an independent series is kept
    idx = pd.bdate_range("2005-01-03", periods=2500)
    rng = np.random.default_rng(1)
    base = pd.Series(100 * np.exp(np.cumsum(rng.normal(0, 0.01, 2500))), index=idx)
    other = pd.Series(100 * np.exp(np.cumsum(rng.normal(0, 0.01, 2500))), index=idx)
    old = {"A": ("index", base)}
    copy = pd.Series(base.to_numpy() * np.exp(rng.normal(0, 0.001, 2500)), index=idx)
    late = other[other.index >= "2012-01-01"]
    global CANDIDATES
    keep = CANDIDATES
    CANDIDATES = ("copy", "late", "ind", "missing")
    try:
        info, uni = universe({"copy": ("index", copy), "late": ("index", late), "ind": ("index", other)}, old)
    finally:
        CANDIDATES = keep
    assert uni == ("ind",), info
    assert info["copy"]["max_corr"] > 0.95 and info["missing"]["status"] == "not served"
    # full window = dev + w2023 trades
    df = pd.DataFrame({"date": pd.to_datetime(["2004-12-31", "2005-01-03", "2022-12-30", "2023-01-02"])})
    assert len(window(df, "full")) == 3 == len(window(df, "dev")) + len(window(df, "w2023"))
    s43.SEED = SEED
    assert s43.SEED == 44
    print("swing44 check ok")


def describe():
    new, old = load_new(), load_old()
    info, uni = universe(new, old)
    res = {"instruments": info, "universe": uni, "counts": {}}
    for v in VARIANTS:
        side, kind, thr, ex = s43.VARIANTS[v]
        for i in uni:
            c = new[i][1]
            d = pd.Series(c.index[[t for t, _ in s43.trades(c, side, kind, thr, ex)]])
            for w in WINS:
                a, b = FULL if w == "full" else ext39.WINDOWS[w]
                res["counts"].setdefault(f"{v}_{w}", {})[i] = int(((d >= a) & (d <= b)).sum())
        for w in WINS:
            res["counts"][f"{v}_{w}"]["pooled"] = int(sum(res["counts"][f"{v}_{w}"].values()))
    os.makedirs(OUT, exist_ok=True)
    json.dump(res, open(os.path.join(OUT, "describe.json"), "w"), indent=1)
    print(json.dumps(res, indent=1))


def register():
    f = os.path.join(HERE, "prereg.json")
    if os.path.exists(f):
        sys.exit("prereg.json exists")
    body = json.load(open(os.path.join(HERE, "prereg_body.json")))
    body = {"created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "code_sha256": {n: sha(os.path.join(ENG, "audit", d, n)) for d, n in
                            (("swing44", "swing44.py"), ("swing44", "fetch.py"), ("swing43", "swing43.py"), ("ext39", "ext39.py"))},
            "data_sha256": {"daily.db": sha(DB)}, **body}
    json.dump(body, open(f, "w"), indent=1)
    print("registered", f)


def run():
    if not os.path.exists(os.path.join(HERE, "prereg.json")):
        sys.exit("register first")
    assert sha(os.path.join(ENG, "audit", "swing43", "swing43.py")) == SWING43_SHA
    s43.SEED = SEED
    new, old = load_new(), load_old()
    info, uni = universe(new, old)
    spreads = json.load(open(ext39.SPREADS))
    data = {i: new[i] for i in uni}
    res, trials, ts = {"universe": uni, "instruments": info, "cells": {}}, [], time.strftime("%Y-%m-%dT%H:%M:%S")
    code = sha(os.path.abspath(__file__))
    res["spread_half_bps"] = {i: (spreads[i]["median_spread_bps"] / 2 if i in spreads else ext39.FLAT_SIDE_BPS) for i in uni}

    def log(key, st, unit, cell, w, prim):
        res["cells"][key] = st
        trials.append({"ts": ts, "exp": EXP, "unit": unit, "tf": "D", "cell": cell, "window": w, "primary": prim,
                       "role": "primary" if prim else "secondary", **st, "swing44_sha256": code})

    for v in VARIANTS:
        df = s43.build(data, v, spreads)
        both = pd.concat([df, s43.build(old, v, spreads)], ignore_index=True)
        df.to_csv(os.path.join(OUT, f"trades_{v}.csv"), index=False)
        for w in WINS:
            log(f"{v}_new_{w}", stats(window(df, w), w), "new_indices", v, w, v == "primary" and w == "full")
            log(f"{v}_pooled8new_{w}", stats(window(both, w), w), "swing43_8_plus_new_not_independent", v, w, False)
            for i in uni:
                log(f"{v}_inst_{i}_{w}", stats(window(df[df.inst == i], w), w), i, v, w, False)
        res[f"per_year_{v}"] = {int(y): {"n": int(len(g)), "gross": float(g.gross.mean()), "excess": float(g.excess.mean()),
                                         "hit": float((g.gross > 0).mean())} for y, g in df.groupby(df.date.dt.year)}
        if v == "primary":
            w10 = df.nsmallest(10, "gross")
            res["worst_trades"] = [{"inst": r.inst, "date": str(r.date.date()), "exit": str(r.exit.date()), "days": int(r.days),
                                    "gross": float(r.gross), "excess": float(r.excess)} for r in w10.itertuples()]
            res["crash_years"] = {y: res["per_year_primary"].get(y) for y in CRASH}
    p = res["cells"]["primary_new_full"]
    d, w2 = res["cells"]["primary_new_dev"], res["cells"]["primary_new_w2023"]
    res["verdict"] = "PASS" if p["excess"] > 0 and p["ci_excess"][0] > 0 and d["excess"] > 0 and w2["excess"] > 0 else "FAIL"
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1)
    with open(TRIALS, "a") as f:
        for t in trials:
            f.write(json.dumps(t) + "\n")
    print(res["verdict"], json.dumps(p), json.dumps(d), json.dumps(w2), f"{len(trials)} trial rows")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    {"check": check, "describe": describe, "register": register, "run": run}[sys.argv[1]]()
