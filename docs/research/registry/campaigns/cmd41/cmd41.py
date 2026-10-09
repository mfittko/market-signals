"""cmd41: out-of-sample check of the ext39 commodity continuation lead on 10 CME commodities not in ext39.
Data: raw/ohlcv1d_10.dbn.zst (Databento GLBX.MDP3 ohlcv-1d, volume-ranked front month .v.0, bars are UTC-day
aggregates; instrument_id per bar gives the contract, so rolls are known). Definitions copied from ext39.py
(event, declustering, outcome, week bootstrap and stats are imported from it) plus roll handling.

  python cmd41.py check      synthetic fixtures (roll exclusion, weekend drop, roll-spanning outcomes dropped, planted effect)
  python cmd41.py describe   event and roll-drop counts per window / market / group (no outcomes)
  python cmd41.py register   write prereg.json (refuses to overwrite)
  python cmd41.py run        all cells -> out/results.json, trials.jsonl rows
"""
import os, sys, json, time, hashlib
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ENG, "audit", "ext39"))
import ext39  # noqa: E402  (week_boot, stats, load/build for the combined view)

OUT = os.path.join(HERE, "out")
RAW = os.path.join(HERE, "raw", "ohlcv1d_10.dbn.zst")
TRIALS = os.path.join(ENG, "trials.jsonl")
EXP = "cmd41"
SIG_N, GAP = ext39.SIG_N, ext39.GAP
THRESHOLDS = (2.0, 2.5, 3.0)
PRIMARY_K, PRIMARY_H = 2.5, 5
HS = (1, 3, 5, 10)
SIDE_BPS = 2.0
FIN_BPS_NIGHT = ext39.FIN_BPS_NIGHT
WINDOWS = {"dev": ("2010-06-06", "2022-12-31"), "w2023": ("2023-01-01", "2100-01-01")}
GROUPS = {"energy": ("HO", "RB"), "grains": ("ZL", "ZM", "KE", "ZO"), "livestock": ("LE", "HE", "GF"), "metal": ("PA",)}
GROUP_OF = {m: g for g, ms in GROUPS.items() for m in ms}
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()


def load():
    import databento as db
    d = db.DBNStore.from_file(RAW).to_df()
    d["mkt"] = d["symbol"].str.split(".").str[0]
    d["date"] = d.index.tz_localize(None).normalize()     # bar = UTC day starting at ts_event 00:00
    d = d[d["date"].dt.dayofweek < 5]                       # drop thin Saturday/Sunday UTC stubs, as ext39 drops weekend stubs
    return {m: g.set_index("date")[["close", "instrument_id"]].sort_index() for m, g in d.groupby("mkt")}


def series(f):
    """r_t with roll returns (instrument_id change t-1 -> t) set to NaN; sigma_t = std of the last 60 non-roll returns before t."""
    c, iid = f["close"], f["instrument_id"].to_numpy()
    roll = np.r_[True, iid[1:] != iid[:-1]]
    r = c.pct_change().where(~roll)
    v = r.dropna()
    sig = v.rolling(SIG_N, min_periods=SIG_N).std().shift(1).reindex(r.index)   # NaN on roll bars -> never an event
    return r, sig, iid


def events(f, k):
    r, sig, iid = series(f)
    z = (r / sig).to_numpy()
    out, nxt = [], 0
    for t in np.flatnonzero(np.abs(np.nan_to_num(z)) >= k):
        if t < nxt:
            continue
        out.append(t); nxt = t + GAP
    return np.array(out, int), r.to_numpy(), sig.to_numpy(), iid


def outcomes(f, t, d, sig, iid, h, lag):
    """ext39 outcome, plus: drop when any roll lies in bars a..b (contract must be the same from entry to exit)."""
    v, idx = f["close"].to_numpy(), f.index
    a, b = t + lag, t + lag + h
    exists = b < len(v)
    a, b, t2, d2 = a[exists], b[exists], t[exists], d[exists]
    same = np.array([(iid[x:y + 1] == iid[x]).all() and iid[x] == iid[t_] for x, y, t_ in zip(a, b, t2)], bool)
    g = d2[same] * (v[b[same]] / v[a[same]] - 1)
    nights = (idx[b[same]] - idx[a[same]]).days.to_numpy()
    return t2[same], g / sig[t2[same]], g * 1e4, nights, int((~same).sum())


def build(data, k):
    rows, drops = [], []
    for m, f in data.items():
        t, r, sig, iid = events(f, k)
        if not len(t):
            continue
        d = np.sign(r[t])
        for lag, entry in ((0, "close"), (1, "next")):
            for h in HS:
                te, s, bps, nights, nd = outcomes(f, t, d, sig, iid, h, lag)
                drops.append({"mkt": m, "k": k, "h": h, "entry": entry, "events": len(t), "kept": len(te), "roll_drop": nd})
                net = bps - 2 * SIDE_BPS - FIN_BPS_NIGHT * nights
                rows.append(pd.DataFrame({"inst": m, "grp": GROUP_OF[m], "date": f.index[te], "d": np.sign(r[te]), "h": h,
                                          "entry": entry, "sig": s, "bps": bps, "net": net, "fut": bps - 2 * SIDE_BPS}))
    return pd.concat(rows, ignore_index=True), pd.DataFrame(drops)


def window(df, w):
    a, b = WINDOWS[w]
    return df[(df["date"] >= a) & (df["date"] <= b)]


def stats(df):
    st = ext39.stats(df)   # mean_sig/ci_sig, bps, net (CFD), hit, mde80; week bootstrap 1000 reps seed 39
    if len(df) >= 5:
        wk = (df["date"].dt.isocalendar().year * 100 + df["date"].dt.isocalendar().week).to_numpy()
        bf = ext39.week_boot(df["fut"].to_numpy(), wk)
        st.update(fut_bps=float(df["fut"].mean()), ci_fut=[float(np.percentile(bf, 2.5)), float(np.percentile(bf, 97.5))])
    return st


# ------------------------------------------------------------------ fixtures
def check():
    rng = np.random.default_rng(0)
    idx = pd.bdate_range("2012-01-02", periods=400)
    r = rng.normal(0, 0.01, 400)
    r[150] = 0.10                       # a huge roll return: excluded from sigma and never an event
    r[200] = 0.10; r[202] = 0.10; r[206] = -0.10
    iid = np.where(np.arange(400) < 150, 1, 2); iid[300:] = 3
    f = pd.DataFrame({"close": 100 * np.cumprod(1 + r), "instrument_id": iid}, index=idx)
    t, rr, sig, ii = events(f, 2.5)
    assert 150 not in t and 200 in t and 202 not in t and 206 in t, t
    assert np.isnan(rr[150]) and np.isnan(sig[150])
    # sigma at 200 equals std of the 60 non-roll returns before 200 (150 skipped -> window starts at 139)
    v = pd.Series(rr).dropna()
    assert np.isclose(sig[200], v.loc[:199].iloc[-60:].std())
    # outcome windows: 296 + 5 spans the roll at 300 -> dropped; 200 + 5 kept; lag-1 from 295 + 5 spans -> dropped
    te, s, bps, n, nd = outcomes(f, np.array([200, 296]), np.array([1.0, 1.0]), sig, ii, 5, 0)
    assert list(te) == [200] and nd == 1
    cl = f["close"].to_numpy()
    assert np.isclose(bps[0], (cl[205] / cl[200] - 1) * 1e4)
    te, s, bps, n, nd = outcomes(f, np.array([294, 295]), np.array([-1.0, -1.0]), sig, ii, 4, 1)
    assert list(te) == [294] and np.isclose(bps[0], -(cl[299] / cl[295] - 1) * 1e4), (te, bps)
    # a roll exactly at the next-close entry bar is dropped (entry contract must equal the event contract)
    te, *_ , nd = outcomes(f, np.array([299]), np.array([1.0]), sig, ii, 3, 1)
    assert len(te) == 0 and nd == 1
    # planted continuation -> positive mean; pooled stats run
    data = {}
    for j, m in enumerate(("HO", "ZL", "LE", "PA")):
        rr2 = rng.normal(0, 0.01, 1500)
        for e in range(100, 1490, 30):
            rr2[e] = 0.05 * rng.choice([-1, 1]); rr2[e + 1:e + 6] = 0.01 * np.sign(rr2[e])
        data[m] = pd.DataFrame({"close": 100 * np.cumprod(1 + rr2), "instrument_id": 7},
                               index=pd.bdate_range("2011-01-03", periods=1500))
    df, dr = build(data, 2.5)
    st = stats(df[(df.h == 5) & (df.entry == "close")])
    assert st["ci_sig"][0] > 0.5 and st["fut_bps"] > st["net_bps"], st
    print("check ok")


def describe():
    data = load()
    res = {"bars": {m: {"n": len(f), "first": str(f.index[0].date()), "last": str(f.index[-1].date()),
                        "contracts": int(f.instrument_id.nunique()),
                        "rolls": int((f.instrument_id.to_numpy()[1:] != f.instrument_id.to_numpy()[:-1]).sum())} for m, f in data.items()}}
    for k in THRESHOLDS:
        evs = []
        for m, f in data.items():
            t, r, sig, iid = events(f, k)
            evs.append(pd.DataFrame({"mkt": m, "grp": GROUP_OF[m], "date": f.index[t], "d": np.sign(r[t])}))
        e = pd.concat(evs)
        _, drops = build(data, k)    # counts only; outcome columns are not read here
        for w in WINDOWS:
            x = window(e, w)
            res[f"k{k}_{w}"] = {"all": int(len(x)), "weeks": int(x.date.dt.to_period("W").nunique()),
                                "up": int((x.d > 0).sum()), "down": int((x.d < 0).sum()),
                                "per_market": x.groupby("mkt").size().astype(int).to_dict(),
                                "per_group": x.groupby("grp").size().astype(int).to_dict()}
        res[f"k{k}_roll_drops_all_windows"] = drops.groupby(["h", "entry"])[["events", "kept", "roll_drop"]].sum().reset_index().to_dict("records")
        if k == PRIMARY_K:
            res["k2.5_roll_drops_per_market_h5_close"] = drops[(drops.h == 5) & (drops.entry == "close")].set_index("mkt")[["events", "kept", "roll_drop"]].to_dict("index")
    os.makedirs(OUT, exist_ok=True)
    json.dump(res, open(os.path.join(OUT, "describe.json"), "w"), indent=1, default=str)
    print(json.dumps(res, indent=1, default=str))


def register():
    f = os.path.join(HERE, "prereg.json")
    if os.path.exists(f):
        sys.exit("prereg.json exists")
    body = json.load(open(os.path.join(HERE, "prereg_body.json")))
    body = {"created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "code_sha256": {"cmd41.py": sha(os.path.join(HERE, "cmd41.py")), "ext39.py": sha(ext39.__file__),
                            "raw/ohlcv1d_10.dbn.zst": sha(RAW)}, **body}
    json.dump(body, open(f, "w"), indent=1)
    print("registered", f)


def run():
    if not os.path.exists(os.path.join(HERE, "prereg.json")):
        sys.exit("register first")
    data = load()
    res, trials, ts = {"cells": {}}, [], time.strftime("%Y-%m-%dT%H:%M:%S")
    units = ["all", *GROUPS, *sorted(data)]
    for k in THRESHOLDS:
        df, drops = build(data, k)
        res[f"roll_drops_k{k}"] = drops.groupby(["h", "entry"])[["events", "kept", "roll_drop"]].sum().reset_index().to_dict("records")
        for (h, entry), g in df.groupby(["h", "entry"]):
            for u in units:
                gu = g if u == "all" else g[g.grp == u] if u in GROUPS else g[g.inst == u]
                for dr in ("all", "up", "down"):
                    gd = gu if dr == "all" else gu[gu.d == (1 if dr == "up" else -1)]
                    for w in WINDOWS:
                        st = stats(window(gd, w))
                        key = f"k{k}_h{h}_{entry}_{u}_{dr}_{w}"
                        prim = k == PRIMARY_K and h == PRIMARY_H and entry == "close" and u == "all" and dr == "all"
                        res["cells"][key] = st
                        trials.append({"ts": ts, "exp": EXP, "unit": u, "tf": "D", "cell": f"k{k}_h{h}_{entry}_{dr}",
                                       "window": w, "primary": prim, **st})
    # combined view with ext39's 11 commodities (NOT independent: ext39 selected this cell post hoc)
    e39 = ext39.build(ext39.load(), PRIMARY_K, json.load(open(ext39.SPREADS)))
    e39 = e39[(e39.cls == "commodity") & (e39.h == PRIMARY_H) & (e39.entry == "close")]
    df, _ = build(data, PRIMARY_K)
    mine = df[(df.h == PRIMARY_H) & (df.entry == "close")]
    comb = pd.concat([e39[["inst", "date", "sig", "bps", "net"]], mine[["inst", "date", "sig", "bps", "net"]]], ignore_index=True)
    res["combined_ext39_commodities_not_independent"] = {w: ext39.stats(window(comb, w)) for w in WINDOWS}
    res["ext39_commodities_alone"] = {w: ext39.stats(window(e39, w)) for w in WINDOWS}
    res["per_market_primary"] = {w: window(mine, w).groupby("inst")["sig"].agg(["size", "mean"]).round(4).to_dict("index") for w in WINDOWS}
    a, b = res["cells"][f"k{PRIMARY_K}_h{PRIMARY_H}_close_all_all_dev"], res["cells"][f"k{PRIMARY_K}_h{PRIMARY_H}_close_all_all_w2023"]
    res["verdict"] = "PASS continuation" if a["ci_sig"][0] > 0 and b["ci_sig"][0] > 0 else "FAIL"
    os.makedirs(OUT, exist_ok=True)
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=str)
    with open(TRIALS, "a") as f:
        for t in trials:
            f.write(json.dumps(t) + "\n")
    print(res["verdict"], json.dumps(a), json.dumps(b), f"{len(trials)} trial rows")


if __name__ == "__main__":
    {"check": check, "describe": describe, "register": register, "run": run}[sys.argv[1]]()
