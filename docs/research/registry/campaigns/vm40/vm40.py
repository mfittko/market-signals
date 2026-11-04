"""vm40: volatility-managed long-only index exposure (Moreira and Muir 2017) vs buy-and-hold, 8 index CFDs, daily mid.
Data: audit/tsmom36/daily.db (read-only).

  python vm40.py check      synthetic fixtures (no lookahead in RV and causal c, cap, scaling, bootstrap, alpha)
  python vm40.py describe   day counts per window and instrument (no strategy returns)
  python vm40.py register   write prereg.json (refuses to overwrite)
  python vm40.py run        all cells -> out/results.json, trials.jsonl rows
"""
import os, sys, json, time, hashlib, sqlite3
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out")
DB = os.path.join(ENG, "audit", "tsmom36", "daily.db")
TRIALS = os.path.join(ENG, "trials.jsonl")
EXP = "vm40"
INDICES = ("SPX500_USD", "NAS100_USD", "US30_USD", "DE30_EUR", "UK100_GBP", "JP225_USD", "AU200_AUD", "HK33_HKD")
PRIMARY = "SPX500_USD"
RV_NS = (21, 10, 63)
CAPS = (2.0, 1.0)
CMODES = ("causal", "full")
MIN_HIST = 250              # causal c needs >= 250 known inverse-variance values
COST_BPS = 1.0              # per unit of turnover |w_t - w_{t-1}|
BLOCK, NBOOT, SEED = 20, 1000, 40
ANN = 252
WINDOWS = {"dev": ("2005-01-01", "2022-12-31"), "w2023": ("2023-01-01", "2100-01-01")}
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()


def load():
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    q = "SELECT instrument, time, c FROM daily WHERE instrument IN (%s)" % ",".join("?" * len(INDICES))
    d = pd.read_sql(q, db, params=INDICES)
    # same calendar as tsmom36: OANDA time = bar open 17:00 NY, trading date = close date; drop weekend stubs
    d["date"] = (pd.to_datetime(d["time"]) + pd.Timedelta(days=1)).dt.normalize()
    d = d[d["date"].dt.dayofweek < 5]
    return {i: g.set_index("date")["c"].sort_index() for i, g in d.groupby("instrument")}


def inv_var(r, n):
    """iv[t] = 1 / RV over r[t-n..t-1] (mean of squared returns, excludes r[t]); known at the close of t-1."""
    rv = (r ** 2).shift(1).rolling(n, min_periods=n).mean()
    return 1.0 / rv


def solve_c(iv, cap):
    """c with mean(min(c*iv, cap)) = 1 (bisection; iv > 0)."""
    lo, hi = 0.0, 1.0 / iv.mean() * 10 + cap / iv.min()
    for _ in range(60):
        m = 0.5 * (lo + hi)
        lo, hi = (m, hi) if np.minimum(m * iv, cap).mean() < 1 else (lo, m)
    return 0.5 * (lo + hi)


def weights(iv, cap, mode, full_mask=None):
    """Managed weight per day. causal: c_t from iv[first..t] (all known by t-1 close), after MIN_HIST values.
    full: one c from the days in full_mask (uses future data)."""
    v = iv.to_numpy()
    w = np.full(len(v), np.nan)
    ok = np.flatnonzero(np.isfinite(v))
    if mode == "full":
        c = solve_c(v[full_mask & np.isfinite(v)], cap)
        w[ok] = np.minimum(c * v[ok], cap)
    else:
        for j in range(MIN_HIST - 1, len(ok)):
            c = solve_c(v[ok[:j + 1]], cap)
            w[ok[j]] = min(c * v[ok[j]], cap)
    return pd.Series(w, iv.index)


def sharpe(x):
    return x.mean() / x.std(ddof=1) * np.sqrt(ANN) if x.std() > 0 else np.nan


def alpha(m, b):
    bb = np.cov(m, b, ddof=1)[0, 1] / b.var(ddof=1)
    return (m.mean() - bb * b.mean()) * ANN, bb


def maxdd(x):
    eq = np.cumprod(1 + x)
    return float((eq / np.maximum.accumulate(eq) - 1).min())


def block_idx(n, rng):
    k = int(np.ceil(n / BLOCK))
    s = rng.integers(0, n - BLOCK + 1, k)
    return (s[:, None] + np.arange(BLOCK)).ravel()[:n]


def stats(m, b, w_turn, boot=True):
    """m, b: aligned daily return arrays (managed, buy-and-hold). w_turn: |dw| per day."""
    a, beta = alpha(m, b)
    out = {"days": int(len(m)), "bh_ret": float(b.mean() * ANN), "bh_vol": float(b.std(ddof=1) * np.sqrt(ANN)),
           "bh_sharpe": float(sharpe(b)), "m_ret": float(m.mean() * ANN), "m_vol": float(m.std(ddof=1) * np.sqrt(ANN)),
           "m_sharpe": float(sharpe(m)), "diff": float(sharpe(m) - sharpe(b)), "alpha": float(a), "beta": float(beta),
           "bh_mdd": maxdd(b), "m_mdd": maxdd(m), "turnover_ann": float(np.nanmean(w_turn) * ANN)}
    if boot:
        rng = np.random.default_rng(SEED)
        D, A = np.empty(NBOOT), np.empty(NBOOT)
        for i in range(NBOOT):
            ix = block_idx(len(m), rng)
            D[i] = sharpe(m[ix]) - sharpe(b[ix]); A[i] = alpha(m[ix], b[ix])[0]
        out["diff_ci"] = [float(np.percentile(D, 2.5)), float(np.percentile(D, 97.5))]
        out["alpha_ci"] = [float(np.percentile(A, 2.5)), float(np.percentile(A, 97.5))]
        out["diff_se"] = float(D.std(ddof=1)); out["mde80"] = 2.8 * out["diff_se"]
    return out


def frame(c, n, cap, mode):
    """Per-day frame on the instrument's own bars: r, w (managed weight known at t-1 close), gross/net managed return."""
    r = c.pct_change()
    iv = inv_var(r, n)
    full_mask = np.asarray(iv.index >= WINDOWS["dev"][0])
    w = weights(iv, cap, mode, full_mask)
    f = pd.DataFrame({"r": r, "w": w})
    f["dw"] = f["w"].diff().abs()
    f["m"] = f["w"] * f["r"]
    f["m_net"] = f["m"] - COST_BPS * 1e-4 * f["dw"].fillna(0)
    return f.dropna(subset=["r", "w"])


def window(f, wn):
    a, b = WINDOWS[wn]
    return f[(f.index >= a) & (f.index <= b)]


def check():
    rng = np.random.default_rng(0)
    idx = pd.bdate_range("2003-01-01", periods=1500)
    # 1) RV excludes r_t: changing r at day k must not change iv[k]
    r = pd.Series(rng.normal(0, 0.01, 1500), idx)
    iv = inv_var(r, 21); r2 = r.copy(); r2.iloc[700] = 0.5
    iv2 = inv_var(r2, 21)
    assert np.isclose(iv.iloc[700], iv2.iloc[700]) and not np.isclose(iv.iloc[701], iv2.iloc[701])
    # 2) causal weights unchanged by future data
    w1 = weights(iv, 2.0, "causal"); r3 = r.copy(); r3.iloc[1000:] *= 5
    w3 = weights(inv_var(r3, 21), 2.0, "causal")
    assert np.allclose(w1.iloc[:1001].dropna(), w3.iloc[:1001].dropna()) and not np.allclose(w1.iloc[1100:], w3.iloc[1100:])
    assert w1.iloc[:21 + MIN_HIST - 1].isna().all() and np.isfinite(w1.iloc[21 + MIN_HIST - 1])
    # 3) cap and full-sample mean weight
    wf = weights(iv, 1.0, "full", np.ones(1500, bool))
    assert wf.max() <= 1.0 + 1e-12 and abs(wf.mean() - 1) < 1e-6
    wf2 = weights(iv, 2.0, "full", np.ones(1500, bool))
    assert wf2.max() <= 2.0 + 1e-12 and abs(wf2.mean() - 1) < 1e-6
    # 4) heteroskedastic series with constant mean (the paper premise): managed Sharpe must beat buy-and-hold
    vol = np.where((np.arange(1500) // 100) % 2 == 0, 0.005, 0.03)
    rr = pd.Series(rng.normal(0, 1, 1500) * vol + 0.001, idx)
    f = pd.DataFrame({"r": rr, "w": weights(inv_var(rr, 21), 2.0, "full", np.ones(1500, bool))}).dropna()
    s = stats((f.w * f.r).to_numpy(), f.r.to_numpy(), np.zeros(len(f)), boot=False)
    assert s["diff"] > 0.3, s
    # 5) identical series -> diff 0 and CI [0, 0]; alpha of b on itself 0, beta 1
    x = rng.normal(0.0004, 0.01, 800)
    s = stats(x, x, np.zeros(800))
    assert abs(s["diff"]) < 1e-12 and s["diff_ci"] == [0.0, 0.0] and abs(s["alpha"]) < 1e-12 and abs(s["beta"] - 1) < 1e-12
    # 6) block bootstrap indices: contiguous runs of BLOCK
    ix = block_idx(100, np.random.default_rng(1))
    assert len(ix) == 100 and all(np.all(np.diff(ix[i:i + BLOCK]) == 1) for i in range(0, 100, BLOCK))
    print("check ok")


def describe():
    S = load()
    for i in INDICES:
        c = S[i]; r = c.pct_change()
        f = frame(c, 21, 2.0, "causal")  # only to count usable days; no returns printed
        print(i, c.index[0].date(), c.index[-1].date(), {wn: len(window(f, wn)) for wn in WINDOWS},
              "abs r > 10%:", [(d.date().isoformat(), round(v, 3)) for d, v in r[r.abs() > 0.10].items()])


def register():
    p = os.path.join(HERE, "prereg.json")
    if os.path.exists(p):
        sys.exit("prereg.json exists")
    body = json.load(open(os.path.join(HERE, "prereg_body.json")))
    pre = {"created": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "code_sha256": {"vm40.py": sha(__file__)}, **body}
    json.dump(pre, open(p, "w"), indent=1)
    print(p, sha(p))


def run():
    S = load()
    ts = time.strftime("%Y-%m-%dT%H:%M:%S")
    res, trials = {"cells": {}, "yearly": {}}, []
    frames = {}
    for i in INDICES:
        for n in RV_NS:
            for cap in CAPS:
                for mode in CMODES:
                    frames[(i, n, cap, mode)] = frame(S[i], n, cap, mode)
    units = list(INDICES) + ["POOL8"]
    for n in RV_NS:
        for cap in CAPS:
            for mode in CMODES:
                for wn in WINDOWS:
                    for net in (False, True):
                        for u in units:
                            if u == "POOL8":
                                fs = [window(frames[(i, n, cap, mode)], wn) for i in INDICES]
                                col = "m_net" if net else "m"
                                m = pd.concat([f[col] for f in fs], axis=1).mean(axis=1)
                                b = pd.concat([f["r"] for f in fs], axis=1).mean(axis=1)
                                dw = pd.concat([f["dw"] for f in fs], axis=1).mean(axis=1)
                                m, b, dw = m.to_numpy(), b.to_numpy(), dw.to_numpy()
                            else:
                                f = window(frames[(u, n, cap, mode)], wn)
                                m, b, dw = f["m_net" if net else "m"].to_numpy(), f["r"].to_numpy(), f["dw"].to_numpy()
                            cell = f"rv{n}_cap{cap:g}_{mode}_{'net' if net else 'gross'}"
                            s = stats(m, b, dw)
                            prim = u == PRIMARY and cell == "rv21_cap2_causal_gross"
                            res["cells"].setdefault(u, {}).setdefault(cell, {})[wn] = s
                            trials.append({"ts": ts, "exp": EXP, "unit": u, "tf": "D", "cell": cell, "window": wn,
                                           "primary": prim, **s})
    f = frames[(PRIMARY, 21, 2.0, "causal")]
    for y, g in f.groupby(f.index.year):
        if y >= 2005 and len(g) > 20:
            res["yearly"][int(y)] = {"days": len(g), "bh_sharpe": float(sharpe(g.r)), "m_sharpe": float(sharpe(g.m)),
                                     "diff": float(sharpe(g.m) - sharpe(g.r)), "bh_ret": float(g.r.sum()),
                                     "m_ret": float(g.m.sum()), "mean_w": float(g.w.mean())}
    res["mean_weight"] = {f"{i}_rv{n}_cap{cap:g}_{mode}": {wn: float(window(frames[(i, n, cap, mode)], wn).w.mean()) for wn in WINDOWS}
                          for (i, n, cap, mode) in frames}
    P = res["cells"][PRIMARY]["rv21_cap2_causal_gross"]
    res["verdict"] = "PASS" if all(P[wn]["diff_ci"][0] > 0 for wn in WINDOWS) else "FAIL"
    res["code_sha256"] = sha(__file__)
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1)
    with open(TRIALS, "a") as fh:
        for t in trials:
            fh.write(json.dumps(t) + "\n")
    print(res["verdict"], json.dumps(P), f"{len(trials)} trial rows")


if __name__ == "__main__":
    {"check": check, "describe": describe, "register": register, "run": run}[sys.argv[1]]()
