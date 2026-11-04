"""lead35: short-horizon lead-lag. A leader makes a sharp move, a related follower has not moved yet; does the follower catch up?

Data: engine M1 bid/ask cache (history.db candles_ba snapshot), cut 2026-10-07 18:30 UTC, mid = (bid + ask) / 2 per OHLC field.
Dense minute grid per instrument (NaN where OANDA has no bar). M5 bars are built from M1 per instrument (5-minute floor).
ATR(10): Wilder ATR on each instrument's own bars (mid OHLC, previous own close), as of bar t-k (the bar before the
return window, so the leader's move does not inflate its own denominator).
Signal at the close of bar t (k in {1, 3}):
  zL = (cL[t] - cL[t-k]) / ATR_L[t-k], zF = (cF[t] - cF[t-k]) / ATR_F[t-k]
  |zL| >= 2.0 and s * zF < 0.5, s = sign(zL); bars t-k..t present for BOTH instruments.
  One signal per 10 minutes per pair (M5: per 2 bars), greedy in time.
Trade the follower in direction s: entry at the open of bar t+1 (must exist), exit at the close of the last follower bar
in [t+1, t+h], h in {2, 5, 10} (h = 5 primary). Gross = s * (exit - entry) on mid, in follower ATR units and bps.
Net: long buys ask_o[t+1], sells bid_c[exit]; short sells bid_o[t+1], buys ask_c[exit].
Secondary control "nolag": the same signal without the follower condition.

  python lead35.py check | counts | register | amend "<reason>" | run
"""
import os, sys, json, time, glob, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out"); os.makedirs(OUT, exist_ok=True)
sys.path.insert(0, ENG)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from validate import day_of, day_boot, ci, log_trial  # noqa: E402

EXP = "lead35"
CACHE = os.path.join(ENG, "cache")
CUT = "2026-10-07T18:30"
PAIRS = [("XAU/USD", "XAG/USD"), ("XAG/USD", "XAU/USD"), ("SPX500/USD", "WTICO/USD"), ("WTICO/USD", "SPX500/USD"),
         ("EUR/USD", "XAU/USD"), ("WTICO/USD", "NATGAS/USD")]
PRIMARY = dict(pair=PAIRS[0], tf="M1", k=1, h=5, cond="lag")
KS, HS, TFS = (1, 3), (2, 5, 10), ("M1", "M5")
ATR_N, ZL, ZF = 10, 2.0, 0.5
COOL_MIN = 10
LAGS = range(6)
WINS = {"dev": ("2018-01-01", "2022-12-31T23:59"), "w2023": ("2023-01-01", CUT)}
TOD = {"asia": (22 * 60, 7 * 60), "london": (7 * 60, 13 * 60), "ny": (13 * 60, 21 * 60)}   # UTC minute of the signal bar close
REPS, BLOCK, SEED = 1000, 5, 35
TAG = lambda s: s.replace("/", "_")
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
F = ("o", "h", "l", "c")


def load_m1(inst):
    f = sorted(glob.glob(os.path.join(CACHE, TAG(inst) + "_*.npz")), key=lambda p: int(p.split("_")[-2]))[-1]
    z = np.load(f); m = z["t"] < np.datetime64(CUT, "m").astype(np.int64)
    d = {k: z[k][m].astype(np.float64) for k in z.files if k not in ("t", "volume")}
    d["t"] = z["t"][m].astype(np.int64)
    return d, os.path.basename(f)


def to_m5(b):
    """M5 bars from M1 rows: open of the first, high max, low min, close of the last M1 bar in each 5-minute bucket."""
    g = b["t"] // 5 * 5
    st = np.r_[0, np.flatnonzero(np.diff(g)) + 1]; en = np.r_[st[1:], len(g)] - 1
    out = {"t": g[st]}
    for side in ("bid", "ask"):
        out[side + "_o"] = b[side + "_o"][st]; out[side + "_c"] = b[side + "_c"][en]
        out[side + "_h"] = np.maximum.reduceat(b[side + "_h"], st); out[side + "_l"] = np.minimum.reduceat(b[side + "_l"], st)
    return out


def wilder_atr(h, l, c, n=ATR_N):
    pc = np.r_[np.nan, c[:-1]]
    tr = np.nanmax(np.c_[h - l, np.abs(h - pc), np.abs(l - pc)], axis=1)
    return pd.Series(tr).ewm(alpha=1 / n, adjust=False, min_periods=n).mean().to_numpy()


def dense(b, step, g0, g1):
    """Bars on a dense grid index (t - g0) // step over [g0, g1); NaN where missing. Adds mid fields and ATR."""
    n = (g1 - g0) // step
    idx = (b["t"] - g0) // step
    keep = (idx >= 0) & (idx < n)
    D = {"present": np.zeros(n, bool)}
    D["present"][idx[keep]] = True
    mid = {f: (b["bid_" + f] + b["ask_" + f]) / 2 for f in F}
    atr = wilder_atr(mid["h"], mid["l"], mid["c"])
    for name, arr in [*(("m" + f, mid[f]) for f in F), ("atr", atr), ("ask_o", b["ask_o"]), ("bid_o", b["bid_o"]),
                      ("ask_c", b["ask_c"]), ("bid_c", b["bid_c"])]:
        x = np.full(n, np.nan); x[idx[keep]] = arr[keep]; D[name] = x
    # last present index at or before each grid point (for time exits)
    D["last"] = np.maximum.accumulate(np.where(D["present"], np.arange(n), -1))
    return D


def run_present(p, k):
    """True at t when bars t-k..t are all present."""
    ok = p.copy()
    for j in range(1, k + 1):
        ok[j:] &= p[:-j]; ok[:j] = False
    return ok


def signals(L, Fo, k, cool, cond):
    """Indices t of signals (greedy cooldown) and their direction s."""
    n = len(L["mc"])
    both = run_present(L["present"] & Fo["present"], k)
    zl = np.full(n, np.nan); zf = np.full(n, np.nan)
    zl[k:] = (L["mc"][k:] - L["mc"][:-k]) / L["atr"][:-k]
    zf[k:] = (Fo["mc"][k:] - Fo["mc"][:-k]) / Fo["atr"][:-k]
    s = np.sign(zl)
    with np.errstate(invalid="ignore"):
        m = both & (np.abs(zl) >= ZL) & np.isfinite(zf) & (Fo["atr"][np.maximum(np.arange(n) - k, 0)] > 0)
        if cond == "lag":
            m &= s * zf < ZF
    cand = np.flatnonzero(m)
    keep, last = [], -10 ** 12
    for t in cand:
        if t - last >= cool:
            keep.append(t); last = t
    keep = np.array(keep, np.int64)
    return keep, s[keep], zl[keep], zf[keep]


def outcomes(Fo, t, s, k, h):
    """Follower trade from open of t+1 to close of the last bar in [t+1, t+h]. Rows without bar t+1 are dropped."""
    n = len(Fo["mc"])
    ok = (t + h < n)
    t, s = t[ok], s[ok]
    ok = Fo["present"][t + 1]
    t, s = t[ok], s[ok]
    ex = Fo["last"][t + h]
    A = Fo["atr"][t - k]
    e = Fo["mo"][t + 1]; x = Fo["mc"][ex]
    g = s * (x - e)
    net = np.where(s > 0, Fo["bid_c"][ex] - Fo["ask_o"][t + 1], Fo["bid_o"][t + 1] - Fo["ask_c"][ex])
    return t, dict(g_atr=g / A, g_bps=g / e * 1e4, n_atr=net / A, n_bps=net / e * 1e4)


def xcorr(L, Fo, lags=LAGS):
    """corr(rL[m - lag], rF[m]) on M1 log mid-close returns, both returns from consecutive present bars."""
    def ret(D):
        r = np.full(len(D["mc"]), np.nan); r[1:] = np.log(D["mc"][1:] / D["mc"][:-1]); return r
    rl, rf = ret(L), ret(Fo)
    out = {}
    for lag in lags:
        a = rl[:len(rl) - lag]; b = rf[lag:]
        m = np.isfinite(a) & np.isfinite(b)
        out[lag] = dict(n=int(m.sum()), rho=float(np.corrcoef(a[m], b[m])[0, 1]) if m.sum() > 10 else np.nan)
    return out


def grid(lead, foll, tf, cache={}):
    key = (lead, foll, tf)
    if key not in cache:
        cache.clear()
        bl, fl = load_m1(lead)[0], load_m1(foll)[0]
        step = 1
        if tf == "M5":
            bl, fl, step = to_m5(bl), to_m5(fl), 5
        g0 = (min(bl["t"][0], fl["t"][0]) // 5) * 5
        g1 = max(bl["t"][-1], fl["t"][-1]) + step
        cache[key] = (dense(bl, step, g0, g1), dense(fl, step, g0, g1), g0, step)
    return cache[key]


def win_mask(tmin, w):
    a, b = (np.datetime64(x, "m").astype(np.int64) for x in WINS[w])
    return (tmin >= a) & (tmin <= b)


def tod_mask(tmin, name):
    a, b = TOD[name]; m = tmin % 1440
    return ((m >= a) | (m < b)) if a > b else ((m >= a) & (m < b))


def boot(rows, day, all_days):
    """Mean of gross/net in ATR and bps plus hit, day-block bootstrap."""
    g, gb, n, nb = rows["g_atr"], rows["g_bps"], rows["n_atr"], rows["n_bps"]
    if len(g) < 5:
        return dict(n=int(len(g)))
    est = lambda i: [g[i].mean(), gb[i].mean(), n[i].mean(), nb[i].mean(), (g[i] > 0).mean()]
    B = day_boot(day, all_days, est, reps=REPS, block=BLOCK, seed=SEED)
    res = dict(n=int(len(g)))
    for j, nm in enumerate(("gross_atr", "gross_bps", "net_atr", "net_bps", "hit")):
        sd = float(np.std(B[:, j]))
        res[nm] = dict(mean=float(est(np.arange(len(g)))[j]), ci=ci(B[:, j]), mde80=2.8 * sd)
    return res


def evaluate_pair(lead, foll, tf, with_outcomes=True):
    L, Fo, g0, step = grid(lead, foll, tf)
    tmin_grid = lambda i: g0 + i * step
    out = dict(pair=f"{lead}->{foll}", tf=tf)
    allt = np.flatnonzero(L["present"] | Fo["present"])
    for w in WINS:
        r = {}
        days_w = np.unique(day_of(tmin_grid(allt)[win_mask(tmin_grid(allt), w)]))
        if tf == "M1" and with_outcomes:
            m = win_mask(tmin_grid(np.arange(len(L["mc"]))), w)
            Lw = {kk: v[m] for kk, v in L.items() if kk in ("mc",)}; Fw = {kk: v[m] for kk, v in Fo.items() if kk in ("mc",)}
            r["xcorr"] = xcorr(Lw, Fw)
        for k in KS:
            for cond in ("lag", "nolag"):
                t, s, zl, zf = signals(L, Fo, k, max(1, COOL_MIN // step), cond)
                tw = t[win_mask(tmin_grid(t) + step, w)]
                sw = s[win_mask(tmin_grid(t) + step, w)]
                cell = dict(signals=int(len(tw)), longs=int((sw > 0).sum()))
                if with_outcomes:
                    for h in HS:
                        te, rows = outcomes(Fo, tw, sw, k, h)
                        tclose = tmin_grid(te) + step
                        day = day_of(tclose)
                        cell[f"h{h}"] = boot(rows, day, days_w)
                        if h == 5:
                            for nm in TOD:
                                mm = tod_mask(tclose, nm)
                                cell[f"h5|{nm}"] = boot({a: b[mm] for a, b in rows.items()}, day[mm], days_w)
                r[f"k{k}|{cond}"] = cell
        out[w] = r
    return out


def is_primary(pair, tf, k, h, cond):
    return (pair == "%s->%s" % PRIMARY["pair"] and tf == PRIMARY["tf"] and k == PRIMARY["k"] and h == PRIMARY["h"]
            and cond == PRIMARY["cond"])


def run():
    res = []
    for tf in TFS:
        for lead, foll in PAIRS:
            r = evaluate_pair(lead, foll, tf); res.append(r)
            for w in WINS:
                for key, cell in r[w].items():
                    if key == "xcorr":
                        continue
                    k, cond = int(key[1]), key.split("|")[1]
                    for hk, x in cell.items():
                        if not hk.startswith("h") or "gross_atr" not in x:
                            continue
                        h = int(hk.split("|")[0][1:])
                        log_trial(dict(exp=EXP, unit=r["pair"], tf=tf, cell=f"{key}|{hk}", window=w,
                                       primary=is_primary(r["pair"], tf, k, h, cond) and "|" not in hk,
                                       n=x["n"], gross_atr=x["gross_atr"]["mean"], gross_ci=x["gross_atr"]["ci"],
                                       gross_bps=x["gross_bps"]["mean"], net_atr=x["net_atr"]["mean"],
                                       hit=x["hit"]["mean"], mde80=x["gross_atr"]["mde80"]))
                c = r[w]["k1|lag"]["h5"]
                print(tf, r["pair"], w, c.get("n"), round(c.get("gross_atr", {}).get("mean", np.nan), 4),
                      c.get("gross_atr", {}).get("ci"), flush=True)
    p = next(x for x in res if x["pair"] == "%s->%s" % PRIMARY["pair"] and x["tf"] == "M1")
    lbs = {w: p[w]["k1|lag"]["h5"]["gross_atr"]["ci"][0] for w in WINS}
    v = "PASS" if all(x > 0 for x in lbs.values()) else "FAIL"
    json.dump(dict(verdict=v, primary_lb=lbs, results=res), open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    print("VERDICT", v, lbs)


def counts():
    """Pre-outcome: signal counts only (follower path after t is not read)."""
    rows = {}
    for tf in TFS:
        for lead, foll in PAIRS:
            r = evaluate_pair(lead, foll, tf, with_outcomes=False)
            rows[f"{tf} {r['pair']}"] = {w: {kk: v["signals"] for kk, v in r[w].items() if kk != "xcorr"} for w in WINS}
            print(tf, r["pair"], rows[f"{tf} {r['pair']}"], flush=True)
    json.dump(rows, open(os.path.join(OUT, "counts.json"), "w"), indent=1)


def check():
    """Synthetic: follower copies the leader with a 2-minute delay -> xcorr peaks at lag 2, catch-up trades win."""
    rng = np.random.default_rng(0)
    n = 20000; t = np.arange(n, dtype=np.int64) + 10 ** 6
    rl = rng.normal(0, 1e-4, n); rl[rng.random(n) < 0.01] *= 20
    pl = 100 * np.exp(np.cumsum(rl))
    rf = np.r_[0, 0, rl[:-2]] + rng.normal(0, 3e-5, n)
    pf = 50 * np.exp(np.cumsum(rf))

    def bars(p):
        o = np.r_[p[0], p[:-1]]; h = np.maximum(o, p) * (1 + 2e-5); lo = np.minimum(o, p) * (1 - 2e-5)
        d = {"t": t}
        for side, sg in (("bid", -1), ("ask", 1)):
            for f, a in zip(F, (o, h, lo, p)):
                d[f"{side}_{f}"] = a + sg * 1e-4 * p
        return d
    bl, bf = bars(pl), bars(pf)
    L, Fo = dense(bl, 1, t[0], t[-1] + 1), dense(bf, 1, t[0], t[-1] + 1)
    xc = xcorr(L, Fo)
    assert max(xc, key=lambda j: xc[j]["rho"]) == 2, xc
    ts, s, zl, zf = signals(L, Fo, 1, COOL_MIN, "lag")
    assert len(ts) > 20 and np.all(np.diff(ts) >= COOL_MIN) and np.all(np.abs(zl) >= ZL) and np.all(s * zf < ZF)
    te, rows = outcomes(Fo, ts, s, 1, 5)
    assert rows["g_atr"].mean() > 1, rows["g_atr"].mean()
    assert np.all(rows["n_atr"] < rows["g_atr"])
    # follower that never moves: gross 0
    Fz = dict(Fo); Fz["mo"] = np.full(len(Fo["mo"]), 50.0); Fz["mc"] = Fz["mo"].copy()
    assert np.allclose(outcomes(Fz, ts, s, 1, 5)[1]["g_atr"], 0)
    # contiguity: remove bar t-1 of the first signal -> it disappears
    L2 = dict(L); L2["present"] = L["present"].copy(); L2["present"][ts[0] - 1] = False
    assert ts[0] not in signals(L2, Fo, 1, COOL_MIN, "lag")[0]
    # M5 aggregation
    m5 = to_m5(bl)
    assert m5["t"][1] - m5["t"][0] == 5 and np.all(m5["t"] % 5 == 0)
    assert m5["ask_h"][0] == bl["ask_h"][:5 - t[0] % 5].max()
    assert tod_mask(np.array([23 * 60, 3 * 60, 8 * 60, 14 * 60]), "asia").tolist() == [True, True, False, False]
    print("check ok")


def codeshas():
    return {"lead35.py": sha(os.path.join(HERE, "lead35.py")), "validate.py": sha(os.path.join(ENG, "validate.py"))}


def register(amend=None):
    f = os.path.join(HERE, "prereg.json")
    if amend:
        reg = json.load(open(f))
        reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=amend, code_sha256=codeshas()))
        json.dump(reg, open(f, "w"), indent=1); print("amended"); return
    assert not os.path.exists(f), "prereg.json exists (use amend)"
    reg = json.load(open(os.path.join(HERE, "prereg_body.json")))
    reg = dict(created=time.strftime("%Y-%m-%dT%H:%M:%S%z"), code_sha256=codeshas(), **reg)
    json.dump(reg, open(f, "w"), indent=1); print("registered", sha(f))


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "amend":
        register(sys.argv[2])
    else:
        {"check": check, "counts": counts, "register": register, "run": run}[cmd]()
