"""Load M1 bid candles, build trading-day grids, day stats and checkpoint features.

Trading day: 22:00 UTC rollover for every instrument (day key = date of t + 2h).
Checkpoints: every 30 min after 22:00 UTC; a checkpoint at minute m uses bars with
offset < m only (the bar starting at m-1 closes at m).
"""
import os, sqlite3
import numpy as np

DB = "file:/Users/mfittko/github/market-signals/data/research/history.db?mode=ro"
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
CPS = np.arange(30, 1441, 30)  # 30 .. 1440 minutes after the 22:00 rollover
NCP = len(CPS)


def load(inst):
    os.makedirs(CACHE, exist_ok=True)
    f = os.path.join(CACHE, inst.replace("/", "_") + ".npz")
    con = sqlite3.connect(DB, uri=True)
    n = con.execute("select count(*) from candles where instrument=? and granularity='M1'", (inst,)).fetchone()[0]
    if os.path.exists(f):
        z = np.load(f)
        if len(z["t"]) == n:
            return {k: z[k] for k in z.files}
    rows = con.execute(
        "select cast(strftime('%s', substr(time,1,19)) as integer)/60, open, high, low, close "
        "from candles where instrument=? and granularity='M1' order by time", (inst,)).fetchall()
    a = np.array(rows, dtype=np.float64)
    d = dict(t=a[:, 0].astype(np.int64), o=a[:, 1], h=a[:, 2], l=a[:, 3], c=a[:, 4])
    np.savez(f, **d)
    return d


def build_days(raw):
    t = raw["t"] + 120  # shift so 22:00 UTC -> 00:00
    dk = t // 1440
    off = (t % 1440).astype(np.int64)
    days, first, cnt = np.unique(dk, return_index=True, return_counts=True)
    wd = (days + 3) % 7  # Mon=0
    ok = (cnt >= 0.5 * np.median(cnt[wd < 5])) & (wd < 5)
    keep = days[ok]
    pos = np.searchsorted(keep, dk)
    pos = np.clip(pos, 0, len(keep) - 1)
    m = keep[pos] == dk
    nd = len(keep)
    Hg = np.full((nd, 1440), np.nan); Lg = Hg.copy(); Cg = Hg.copy()
    Hg[pos[m], off[m]] = raw["h"][m]; Lg[pos[m], off[m]] = raw["l"][m]; Cg[pos[m], off[m]] = raw["c"][m]
    O = raw["o"][first[ok]]  # open of first bar of the day (t sorted)
    return dict(day=keep, O=O, Hg=Hg, Lg=Lg, Cg=Cg)


def ffill_row(x, fill):
    idx = np.where(~np.isnan(x), np.arange(len(x)), -1)
    idx = np.maximum.accumulate(idx)
    out = np.where(idx >= 0, x[np.maximum(idx, 0)], fill)
    return out


def feats_at(hg, lg, cg, O, m):
    """Raw intraday state using bars with offset < m only. Returns up, dn, exc, rng, mv, rv, close."""
    h = hg[:m]; l = lg[:m]; c = cg[:m]
    if np.all(np.isnan(h)):
        return np.array([0, 0, 0, 0, 0, 0, O], dtype=float)
    hi = np.nanmax(h); lo = np.nanmin(l)
    cf = ffill_row(c, O)
    last = cf[-1]
    c5 = np.concatenate([[O], cf[4::5]])
    r = np.diff(np.log(c5))
    rv = np.sqrt(np.sum(r * r))
    up = (hi - O) / O; dn = (O - lo) / O
    return np.array([up, dn, max(up, dn), up + dn, (last - O) / O, rv, last])


def day_stats(D):
    nd = len(D["day"])
    O = D["O"]
    H = np.nanmax(D["Hg"], 1); L = np.nanmin(D["Lg"], 1)
    C = np.array([ffill_row(D["Cg"][i], O[i])[-1] for i in range(nd)])
    exc = np.maximum(H - O, O - L) / O
    rng = (H - L) / O
    rv = np.array([feats_at(D["Hg"][i], D["Lg"][i], D["Cg"][i], O[i], 1440)[5] for i in range(nd)])
    return dict(H=H, L=L, C=C, exc=exc, rng=rng, rv=rv)


def thresholds(exc, win=252, minn=126, q=0.9):
    thr = np.full(len(exc), np.nan)
    for d in range(minn, len(exc)):
        thr[d] = np.quantile(exc[max(0, d - win):d], q)  # prior days only
    return thr


def day_features(D, S, thr):
    """Features known at the day open (22:00 UTC). All use days < d, plus the open itself."""
    nd = len(D["day"])
    rv, rng, exc, C, O = S["rv"], S["rng"], S["exc"], S["C"], D["O"]
    F = np.full((nd, 14), np.nan)
    atr = np.full(nd, np.nan)
    wd = (D["day"] + 3) % 7
    dom = (D["day"].astype("datetime64[D]") - D["day"].astype("datetime64[D]").astype("datetime64[M]")).astype(int) + 1
    for d in range(22, nd):
        th = thr[d]
        atr[d] = rng[d - 14:d].mean()
        if np.isnan(th):
            continue
        F[d, 0] = np.log(rv[d - 1] / th)
        F[d, 1] = np.log(rv[d - 5:d].mean() / th)
        F[d, 2] = np.log(rv[d - 22:d].mean() / th)
        F[d, 3] = np.log(rng[d - 1] / th)
        F[d, 4] = exc[d - 1] / th
        F[d, 5] = abs(np.log(O[d] / C[d - 1])) / th
        F[d, 6:11] = np.eye(5)[wd[d]]
        F[d, 11] = float(wd[d] == 4 and dom[d] <= 7)  # approx NFP: first Friday
        F[d, 12] = float(wd[d] == 2)                  # approx EIA crude: Wednesday
        F[d, 13] = float(exc[d - 1] >= thr[d - 1]) if not np.isnan(thr[d - 1]) else 0.0
    names = ["rv1", "rv5", "rv22", "rng1", "exc1", "gap", "mon", "tue", "wed", "thu", "fri", "nfp", "eia", "big1"]
    return F, names, atr


def checkpoint_raw(D):
    nd = len(D["day"])
    R = np.zeros((nd, NCP, 7))
    for i in range(nd):
        for k, m in enumerate(CPS):
            R[i, k] = feats_at(D["Hg"][i], D["Lg"][i], D["Cg"][i], D["O"][i], m)
    return R


def checkpoint_norms(R, n=20):
    """Trailing median (prior n days) of range-so-far and rv-so-far at each checkpoint."""
    nd = R.shape[0]
    nr = np.full((nd, NCP), np.nan); nv = nr.copy()
    for d in range(n, nd):
        nr[d] = np.median(R[d - n:d, :, 3], 0)  # days < d only
        nv[d] = np.median(R[d - n:d, :, 5], 0)
    return nr, nv


def assert_no_lookahead(D, R, nsample=300, seed=0):
    rng = np.random.default_rng(seed)
    nd = len(D["day"])
    for _ in range(nsample):
        i = rng.integers(0, nd); k = rng.integers(0, NCP - 1); m = CPS[k]
        hg, lg, cg = D["Hg"][i].copy(), D["Lg"][i].copy(), D["Cg"][i].copy()
        noise = rng.normal(1, 0.05, 1440 - m) * D["O"][i]
        hg[m:] = noise * 1.01; lg[m:] = noise * 0.99; cg[m:] = noise
        f2 = feats_at(hg, lg, cg, D["O"][i], m)
        assert np.allclose(f2, R[i, k]), (i, k)
    return True


def prepare(inst):
    raw = load(inst)
    D = build_days(raw)
    S = day_stats(D)
    thr = thresholds(S["exc"])
    F, names, atr = day_features(D, S, thr)
    R = checkpoint_raw(D)
    assert_no_lookahead(D, R)
    nr, nv = checkpoint_norms(R)
    year = D["day"].astype("datetime64[D]").astype("datetime64[Y]").astype(int) + 1970
    return dict(D=D, S=S, thr=thr, F=F, names=names, atr=atr, R=R, nr=nr, nv=nv, year=year, FUT=future_extremes(D),
                big=(S["exc"] >= thr), nrows=len(raw["t"]))


def future_extremes(D):
    """Labels only: highest high and lowest low at offsets >= m (after checkpoint m)."""
    Hs = np.flip(np.fmax.accumulate(np.flip(D["Hg"], 1), 1), 1)
    Ls = np.flip(np.fmin.accumulate(np.flip(D["Lg"], 1), 1), 1)
    k = CPS[:-1]
    return np.stack([Hs[:, k], Ls[:, k]], -1)
