"""abs11: ABSOLUTE (% of price) big-move attention alert. Attention only: no entries, no direction, no ledger.

Targets (thresholds fixed per instrument from 2018-2022 only, declared in prereg.json before any model is fit):
  A1 day level: big day = max |excursion| from the session open (22:00 UTC roll) >= T1 = max(floor, q90 2018-22).
  A2 intraday: max |excursion| over the next 6 h from the 30-min bar close >= T2 = q90 2018-22.
Evaluation: day open (A1 open model), every 30-min bar close (A1 "becoming a big day" while not yet crossed; A2).

  python abs11.py thresholds      -> out/thresholds.json (2018-2022 excursion quantiles only; no features, no models)
  python abs11.py register        -> prereg.json (refuses to overwrite)
  python abs11.py amend "reason"  append an amendment with new code hashes
  python abs11.py check           synthetic self-checks
  python abs11.py run INST        -> out/<TAG>.json (+ artifact/parity when the instrument passes)
"""
import os, sys, json, time, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
sys.path.insert(0, ENG)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import bars as BR  # noqa: E402
import de_v2 as de  # noqa: E402
from validate import year_start_day  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.ensemble import HistGradientBoostingClassifier  # noqa: E402

EXP = "abs11"
INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "NATGAS/USD", "SPX500/USD", "EUR/USD"]
FLOOR = {"WTICO/USD": 3.0, "XAG/USD": 3.0, "NATGAS/USD": 5.0, "XAU/USD": 1.5, "SPX500/USD": 1.5, "EUR/USD": 0.8}
Q = 0.90
H_FWD = 360                 # minutes, A2 horizon
STEP = 30                   # minutes, evaluation cadence and bar size
MIN_BARS = 8                # sessions with fewer 30-min bars (holiday / Sunday stubs) are not valid days
NORM_N, NORM_MIN = 60, 20   # trailing sessions for the time-of-day range norm
STRESS_N, STRESS_MIN, STRESS_Q = 252, 60, 0.80
Q_FIRST = 2019
EMB = 5                     # purge days before each quarter start
TRAIL = 365                 # days of trailing scores (no labels) that set each quarter's alert thresholds
RATES_M = (1, 2, 4)         # A1: alerts per instrument per month (at most one per session)
RATES_W = (1, 2, 4)         # A2: alerts per instrument per week, 6 h cooldown
COOL = H_FWD
GAP = 60
NBOOT = 200
DEV = (2019, 2023)          # dev walk-forward window [2019, 2023)
CRISES = {"2020H1": ("2020-01-01", "2020-07-01"), "2022H1": ("2022-01-01", "2022-07-01"),
          "2025Q4_26Q1": ("2025-10-01", "2026-04-01")}
F_OPEN = ["rv1", "rv5", "rv22", "gap", "dow_s", "dow_c", "stress"]
F_ALL = ["rv1", "rv5", "rv22", "rv_so", "rv6h", "exc_so", "share", "move_so", "rng_norm",
         "tod_s", "tod_c", "tod_s2", "tod_c2", "dow_s", "dow_c", "gap", "stress"]
BASE = {"rv": ["rv1", "rv5", "rv22", "rv_so", "rv6h"], "tod": ["tod_s", "tod_c", "tod_s2", "tod_c2", "dow_s", "dow_c"]}
BASE_OPEN = {"rv": ["rv1", "rv5", "rv22"], "tod": ["dow_s", "dow_c"]}
TAG = lambda inst: inst.replace("/", "_")
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"abs11.py": sha(os.path.join(HERE, "abs11.py")), "bars.py": sha(os.path.join(ENG, "bars.py")), "evaluator": de.CODE_SHA}
dstr = lambda d: str(np.datetime64(int(d), "D"))
dnum = lambda s: int((np.datetime64(s, "m").astype(np.int64) + 120) // 1440)


# ------------------------------------------------------------------ pure helpers (covered by `check`)
def fire(t, p, thr, cool=COOL):
    """Cooldown alerts: p >= thr (thr scalar or per-row) and no alert in the previous `cool` minutes."""
    out = np.zeros(len(p), bool); last = -np.inf
    for k in np.flatnonzero(p >= thr):
        if t[k] - last >= cool:
            out[k] = True; last = t[k]
    return out


def pick_thr(t, p, n_target):
    """Cooldown-alert threshold whose alert count over the rows is closest to n_target (bisection on quantiles)."""
    cand = np.unique(np.quantile(p, np.linspace(0.30, 0.99995, 300)))
    cnt = lambda c: int(fire(t, p, c).sum())
    lo, hi = 0, len(cand) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if cnt(cand[mid]) <= n_target:
            hi = mid
        else:
            lo = mid + 1
    best = min(((abs(cnt(c) - n_target), -c) for c in cand[max(0, lo - 4):lo + 5]))
    return float(-best[1])


def day_thr(day, p, n_target):
    """Session-level threshold: the n_target-th largest per-session max score (one alert per session)."""
    mx = pd.Series(p).groupby(day).max().sort_values(ascending=False).to_numpy()
    return float(mx[min(max(int(n_target), 1), len(mx)) - 1])


def first_per_day(day, p, thr):
    """First row of each session with p >= thr (rows sorted by time)."""
    hit = p >= thr
    out = np.zeros(len(p), bool)
    idx = np.flatnonzero(hit)
    if len(idx):
        _, f = np.unique(day[idx], return_index=True)
        out[idx[f]] = True
    return out


def episodes(t, y, gap=GAP):
    one = y == 1
    cont = np.r_[False, one[:-1]] & (np.r_[np.inf, np.diff(t)] <= gap)
    return np.where(one, np.cumsum(one & ~cont) - 1, -1)


def ahead_share(fwd, back):
    tot = fwd + back
    return np.where(tot > 0, fwd / np.where(tot > 0, tot, 1), np.nan)


def wilson(k, n, z=1.96):
    if n == 0:
        return [None, None]
    ph = k / n; den = 1 + z * z / n; cen = (ph + z * z / (2 * n)) / den
    hw = z * np.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / den
    return [float(cen - hw), float(cen + hw)]


def fwd_back(t, h, l, c, horizon=H_FWD, maxk=None):
    """Per 30-min bar i (evaluated at its close): forward max high / min low over bars opening in (t_i, t_i+horizon],
    first-passage step needs the threshold so the per-step running extremes are returned; backward extremes over
    bars opening in (t_i - horizon, t_i] (includes bar i)."""
    n = len(t); maxk = maxk or horizon // STEP
    fh = np.full(n, -np.inf); fl = np.full(n, np.inf); steps = []
    for j in range(1, maxk + 1):
        b = np.minimum(np.arange(n) + j, n - 1)
        ok = (np.arange(n) + j < n) & (t[b] - t <= horizon)
        fh = np.where(ok, np.maximum(fh, h[b]), fh); fl = np.where(ok, np.minimum(fl, l[b]), fl)
        steps.append((fh.copy(), fl.copy(), ok))
    bh = h.copy(); bl = l.copy()
    for j in range(1, maxk):
        b = np.maximum(np.arange(n) - j, 0)
        ok = (np.arange(n) - j >= 0) & (t - t[b] < horizon)
        bh = np.where(ok, np.maximum(bh, h[b]), bh); bl = np.where(ok, np.minimum(bl, l[b]), bl)
    return fh, fl, bh, bl, steps


def check():
    t = np.arange(0, 30 * 40, 30.0); p = np.zeros(40); p[[3, 4, 5, 20, 21, 35]] = 0.9
    assert list(np.flatnonzero(fire(t, p, 0.5))) == [3, 20, 35]
    assert fire(t, p, pick_thr(t, p, 3)).sum() == 3
    day = np.array([1, 1, 1, 2, 2, 3, 3, 3]); pp = np.array([.1, .5, .9, .2, .3, .8, .1, .95])
    assert day_thr(day, pp, 2) == 0.9 and list(np.flatnonzero(first_per_day(day, pp, 0.9))) == [2, 7]
    y = np.array([0, 1, 1, 0, 1, 1, 1, 0, 1]); tt = np.array([0, 30, 60, 90, 120, 150, 300, 330, 360.0])
    assert list(episodes(tt, y)) == [-1, 0, 0, -1, 1, 1, 2, -1, 3]
    a = ahead_share(np.array([3.0, 0, 2]), np.array([1.0, 0, 6])); assert a[0] == 0.75 and np.isnan(a[1])
    # forward/backward window: bars at 0,30,60 then a gap to 600; horizon 60 min
    tb = np.array([0, 30, 60, 600.0]); hb = np.array([1, 2, 3, 9.0]); lb = np.array([1, 0.5, 1, 1.0])
    fh, fl, bh, bl, _ = fwd_back(tb, hb, lb, hb, horizon=60, maxk=2)
    assert list(fh[:3]) == [3, 3, -np.inf] and fl[0] == 0.5 and bh[2] == 3 and bl[2] == 0.5 and bh[3] == 9 and bl[1] == 0.5
    rng = np.random.default_rng(0); X = rng.normal(size=(500, 3)); yy = (X[:, 0] + rng.normal(size=500) > 0).astype(int)
    M = de.e2_lr_fit(X, yy, np.ones(500))
    z = sum(M["coef"][j] * (X[:, j] - M["mean"][j]) / M["scale"][j] for j in range(3)) + M["b"]
    assert np.allclose(z, de.e2_lr_raw(M, X), atol=1e-12)
    print("abs11 self-check OK: cooldown, thresholds, first-per-session, episodes, ahead share, fwd/back windows, LR parity")


# ------------------------------------------------------------------ data
def bars30(inst):
    f = os.path.join(OUT, f"bars_{TAG(inst)}.npz")
    if os.path.exists(f):
        z = np.load(f); return {k: z[k] for k in z.files}
    BR.MIN["M30"] = STEP
    m1 = BR.load_m1(inst)
    b = BR.resample(m1, "M30")
    d = {"t": b["t"].astype(np.int64), "o": b["mid_o"], "h": b["mid_h"], "l": b["mid_l"], "c": b["mid_c"], "n": b["n"]}
    np.savez(f, **d)
    return d


def session(B):
    """Per-bar so-far quantities and the per-session table."""
    t, o, h, l, c = B["t"], B["o"], B["h"], B["l"], B["c"]
    day = (t + 120) // 1440
    first = np.r_[True, day[1:] != day[:-1]]
    df = pd.DataFrame({"day": day, "h": h, "l": l})
    O = pd.Series(np.where(first, o, np.nan)).ffill().to_numpy()
    Hso = df.groupby("day")["h"].cummax().to_numpy(); Lso = df.groupby("day")["l"].cummin().to_numpy()
    exc_so = 100 * np.maximum(Hso - O, O - Lso) / O
    r = np.log(c / np.r_[np.nan, c[:-1]]); r[first] = np.log(c[first] / o[first])
    r2 = r * r
    rv_so = 100 * np.sqrt(pd.Series(r2).groupby(day).cumsum().to_numpy())
    rv6h = 100 * np.sqrt(pd.Series(r2, index=pd.to_datetime(t, unit="m")).rolling(f"{H_FWD}min").sum().to_numpy())
    g = pd.DataFrame({"day": day, "o": o, "h": h, "l": l, "c": c, "r2": r2}).groupby("day")
    D = pd.DataFrame({"n": g.size(), "O": g["o"].first(), "H": g["h"].max(), "L": g["l"].min(), "C": g["c"].last(),
                      "RV": 100 * np.sqrt(g["r2"].sum())})
    D["exc"] = 100 * np.maximum(D.H - D.O, D.O - D.L) / D.O
    D["valid"] = D.n >= MIN_BARS
    S = dict(t=t, day=day, first=first, O=O, Hso=Hso, Lso=Lso, exc_so=exc_so, move_so=100 * np.abs(c - O) / O,
             rng_so=100 * (Hso - Lso) / O, rv_so=rv_so, rv6h=rv6h, slot=((t + 120) % 1440) // STEP)
    return S, D


def har(D):
    V = D[D.valid].copy()
    V["rv1"] = V.RV.shift(1); V["rv5"] = V.RV.rolling(5).mean().shift(1); V["rv22"] = V.RV.rolling(22).mean().shift(1)
    V["gap"] = 100 * np.abs(V.O - V.C.shift(1)) / V.C.shift(1)
    V["hot"] = (V.rv5 > V.rv5.rolling(STRESS_N, min_periods=STRESS_MIN).quantile(STRESS_Q).shift(1)).astype(float)
    V.loc[V.rv5.rolling(STRESS_N, min_periods=STRESS_MIN).quantile(STRESS_Q).shift(1).isna(), "hot"] = np.nan
    return V


def stress_table():
    """Share of the six instruments whose 5-day RV (as of the session open) is above its trailing-year 80th pct."""
    f = os.path.join(OUT, "stress.json")
    if os.path.exists(f):
        return pd.Series({int(k): v for k, v in json.load(open(f)).items()})
    cols = {}
    for inst in INSTS:
        _, D = session(bars30(inst)); cols[inst] = har(D)["hot"]
    M = pd.DataFrame(cols).sort_index().ffill(limit=3)
    s = M.mean(axis=1, skipna=True)[M.notna().sum(axis=1) >= 4]
    json.dump({str(k): float(v) for k, v in s.items()}, open(f, "w"))
    return s


def thresholds():
    res = {}
    for inst in INSTS:
        B = bars30(inst); S, D = session(B)
        lo, hi = year_start_day(2018), year_start_day(2023)
        V = D[D.valid & (D.index >= lo) & (D.index < hi)]
        q1 = float(np.quantile(V.exc, Q))
        fh, fl, _, _, _ = fwd_back(B["t"], B["h"], B["l"], B["c"])
        fwd = 100 * np.maximum(fh - B["c"], B["c"] - fl) / B["c"]
        vd = D.valid.reindex(S["day"]).to_numpy()
        m = vd & (S["day"] >= lo) & (S["day"] < hi) & np.isfinite(fwd) & (B["t"] <= B["t"][-1] - H_FWD)
        q2 = float(np.quantile(fwd[m], Q))
        res[inst] = dict(A1_q90_2018_22=q1, A1_floor=FLOOR[inst], T1=max(FLOOR[inst], q1), A1_floor_binding=FLOOR[inst] >= q1,
                         A2_q90_2018_22=q2, T2=q2, n_days_2018_22=int(len(V)), n_rows_2018_22=int(m.sum()),
                         data_first=dstr(D.index[0]), data_last=dstr(D.index[-1]))
        print(inst, res[inst], flush=True)
    json.dump(res, open(os.path.join(OUT, "thresholds.json"), "w"), indent=1)


def build(inst, T1, T2, stress):
    B = bars30(inst); S, D = session(B)
    V = har(D)
    day = S["day"]; n = len(day)
    look = lambda col: V[col].reindex(day).to_numpy()
    valid = D.valid.reindex(day).to_numpy().astype(bool)
    # time-of-day range norm: trailing median of range-so-far at the same slot over the previous sessions
    piv = pd.DataFrame({"day": day, "slot": S["slot"], "r": S["rng_so"]})[valid].pivot_table(index="day", columns="slot", values="r")
    norm = piv.rolling(NORM_N, min_periods=NORM_MIN).median().shift(1)
    nv = norm.stack().reindex(pd.MultiIndex.from_arrays([day, S["slot"]])).to_numpy()
    fr = (S["slot"] + 1) / (1440 / STEP)
    dw = ((day + 3) % 7) / 7
    eps = 1e-4
    X = {"rv1": np.log(look("rv1") + eps), "rv5": np.log(look("rv5") + eps), "rv22": np.log(look("rv22") + eps),
         "rv_so": np.log(S["rv_so"] + eps), "rv6h": np.log(S["rv6h"] + eps), "exc_so": S["exc_so"], "share": S["exc_so"] / T1,
         "move_so": S["move_so"], "rng_norm": np.log((S["rng_so"] + eps) / (nv + eps)),
         "tod_s": np.sin(2 * np.pi * fr), "tod_c": np.cos(2 * np.pi * fr), "tod_s2": np.sin(4 * np.pi * fr), "tod_c2": np.cos(4 * np.pi * fr),
         "dow_s": np.sin(2 * np.pi * dw), "dow_c": np.cos(2 * np.pi * dw), "gap": look("gap"),
         "stress": stress.reindex(day).to_numpy()}
    # labels
    exc_final = D.exc.reindex(day).to_numpy()
    yday = (exc_final >= T1).astype(int)
    crossed = S["exc_so"] >= T1
    tcross_d = pd.Series(np.where(crossed, B["t"] + STEP, np.nan)).groupby(day).transform("min").to_numpy()
    fh, fl, bh, bl, steps = fwd_back(B["t"], B["h"], B["l"], B["c"])
    c = B["c"]
    up, dn = fh - c, c - fl
    fwd = 100 * np.maximum(up, dn) / c
    dirn = np.where(up >= dn, 1, -1)
    back = 100 * np.maximum(np.where(dirn > 0, c - bl, bh - c), 0) / c
    brange = 100 * (bh - bl) / c
    pas = np.zeros(n)
    for j, (sh, sl, ok) in enumerate(steps, 1):
        hit = (pas == 0) & ok & (100 * np.maximum(sh - c, c - sl) / c >= T2)
        pas[hit] = j
    y2 = (fwd >= T2).astype(int)
    unc = B["t"] <= B["t"][-1] - H_FWD
    Xa = np.column_stack([X[k] for k in F_ALL])
    fin = np.isfinite(Xa).all(1)
    R = dict(t=B["t"].astype(float), tc=B["t"].astype(float) + STEP, day=day, X=Xa, valid=valid, fin=fin,
             yday=yday, exc_final=exc_final, exc_so=S["exc_so"], tcross=tcross_d, y2=y2, fwd=fwd, back=back,
             brange=brange, pas=pas, unc=unc, hour=((B["t"] + STEP) % 1440) // 60)
    # day-open rows (one per valid session; features known at 22:00 UTC)
    Vo = V.copy(); Vo["stress"] = stress.reindex(V.index).to_numpy()
    dwo = ((V.index.to_numpy() + 3) % 7) / 7
    Vo["dow_s"], Vo["dow_c"] = np.sin(2 * np.pi * dwo), np.cos(2 * np.pi * dwo)
    for k in ("rv1", "rv5", "rv22"):
        Vo[k] = np.log(Vo[k] + eps)
    Vo["y"] = (Vo.exc >= T1).astype(int)
    Vo = Vo[np.isfinite(Vo[F_OPEN].to_numpy()).all(1)]
    # calm weeks: session-week range in % of the week's first open
    wk = (D.index.to_numpy() + 3) // 7
    Dv = D[D.valid].assign(wk=wk[D.valid.to_numpy()])
    W = Dv.groupby("wk").agg(H=("H", "max"), L=("L", "min"), O=("O", "first"))
    W["rng"] = 100 * (W.H - W.L) / W.O
    return R, Vo, W, D


# ------------------------------------------------------------------ models
def lr_fit(X, y, w):
    return de.e2_lr_fit(X, y, w)


def lr_p(M, X):
    return 1 / (1 + np.exp(-de.e2_lr_raw(M, X)))


def hgb_fit(X, y, w):
    return HistGradientBoostingClassifier(max_iter=150, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=200,
                                          l2_regularization=1.0, random_state=0).fit(X, y, sample_weight=w)


def quarters(last_day):
    out = []
    for yr in range(Q_FIRST, 2100):
        for mo in (1, 4, 7, 10):
            d = dnum(f"{yr}-{mo:02d}-01")
            if d > last_day:
                return out
            out.append((f"{yr}-{mo:02d}-01", d))


def walk(day, X, y, w, cols_all, groups, hgb=True, extra=None):
    """Quarterly expanding refit; returns OOS scores per model and the per-quarter LR models."""
    n = len(y); P = {k: np.full(n, np.nan) for k in ["lr"] + (["hgb"] if hgb else []) + [f"base_{g}" for g in groups]}
    Qs = quarters(int(day.max())); Ms = []
    for qi, (qs, qd) in enumerate(Qs):
        qe = Qs[qi + 1][1] if qi + 1 < len(Qs) else int(day.max()) + 1
        tr = day < qd - EMB; te = (day >= qd) & (day < qe)
        if tr.sum() < 200 or y[tr].sum() < 10:
            continue
        M = lr_fit(X[tr], y[tr], w[tr]); M.update(cut=dstr(qd - EMB), n=int(tr.sum()), base=float(y[tr].mean()), applies_from=qs)
        Ms.append((qd, qe, M))
        if te.any():
            P["lr"][te] = lr_p(M, X[te])
            if hgb:
                P["hgb"][te] = hgb_fit(X[tr], y[tr], w[tr]).predict_proba(X[te])[:, 1]
            for g, cols in groups.items():
                ix = [cols_all.index(k) for k in cols]
                P[f"base_{g}"][te] = lr_p(lr_fit(X[tr][:, ix], y[tr], w[tr]), X[te][:, ix])
    return P, Ms


def auc(y, s):
    return float(roc_auc_score(y, s)) if 0 < y.sum() < len(y) else np.nan


def auc_ci(y, s, day, rng, nb=NBOOT):
    ud, inv = np.unique(day, return_inverse=True)
    order = np.argsort(inv, kind="stable"); cuts = np.r_[0, np.cumsum(np.bincount(inv))]
    rows = [order[cuts[k]:cuts[k + 1]] for k in range(len(ud))]
    bs = []
    for _ in range(nb):
        ix = np.concatenate([rows[k] for k in rng.integers(0, len(ud), len(ud))])
        bs.append(auc(y[ix], s[ix]))
    return [auc(y, s), float(np.nanpercentile(bs, 2.5)), float(np.nanpercentile(bs, 97.5))]


def windows(last_day):
    w = {str(y): (year_start_day(y), year_start_day(y + 1)) for y in range(2019, 2027)}
    w.update(dev=(year_start_day(DEV[0]), year_start_day(DEV[1])), w2023=(year_start_day(2023), last_day + 1))
    return w


def evaluate_scores(P, y, day, W, rng, tag, inst, extra_scores=None):
    """AUC (CIs on dev / w2023) and calibration by year for every model / baseline."""
    out = {"auc": {}, "cal": {}}
    allsc = {**P, **(extra_scores or {})}
    for w, (lo, hi) in W.items():
        m = (day >= lo) & (day < hi) & np.isfinite(P["lr"])
        if m.sum() < 100 or y[m].sum() < 5:
            continue
        a = {}
        for k, s in allsc.items():
            mm = m & np.isfinite(s)
            if mm.sum() != m.sum():
                continue
            a[k] = auc_ci(y[m], s[m], day[m], rng) if w in ("dev", "w2023") else [auc(y[m], s[m])]
            de.log_trial({"exp": EXP, "target": tag, "inst": inst, "window": w, "model": k, "auc": a[k][0],
                          "mode": "dev" if w in ("dev", "2019", "2020", "2021", "2022") else "devwindow2023", "abs11_sha256": CODE["abs11.py"]})
        out["auc"][w] = a
        out["cal"][w] = {k: dict(n=int(m.sum()), pos=int(y[m].sum()), base=float(y[m].mean()), mean_p=float(P[k][m].mean()),
                                 citl=float(P[k][m].mean() - y[m].mean()), brier=float(np.mean((P[k][m] - y[m]) ** 2)),
                                 brier_base=float(y[m].mean() * (1 - y[m].mean())))
                         for k in ("lr", "hgb") if k in P}
    return out


def run(inst):
    t0 = time.time()
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    cur = reg["amendments"][-1]["code_sha256"] if reg.get("amendments") else reg["code_sha256"]
    assert cur["abs11.py"] == CODE["abs11.py"], "abs11.py changed after registration (amend first)"
    T1, T2 = reg["thresholds"][inst]["T1"], reg["thresholds"][inst]["T2"]
    stress = stress_table()
    R, Vo, Wk, D = build(inst, T1, T2, stress)
    rng = np.random.default_rng(11)
    last_day = int(R["day"].max()); W = windows(last_day)
    res = dict(inst=inst, T1_pct=T1, T2_pct=T2, data_first=dstr(R["day"].min()), data_last=dstr(last_day), code=CODE,
               note="development evidence; 2023+ is a development window, not a holdout; attention only, no direction")

    # ---------------- A1 open model
    yo = Vo["y"].to_numpy(); do = Vo.index.to_numpy(); Xo = Vo[F_OPEN].to_numpy()
    Po, Mo = walk(do, Xo, yo, np.ones(len(yo)), F_OPEN, BASE_OPEN)
    res["A1_open"] = evaluate_scores(Po, yo, do, W, rng, "A1_open", inst)
    res["A1_open"]["base_rate_by_year"] = {w: float(yo[(do >= lo) & (do < hi)].mean()) for w, (lo, hi) in W.items() if ((do >= lo) & (do < hi)).any()}

    # ---------------- A1 intraday (rows before the day crosses T1)
    m1 = R["valid"] & R["fin"] & (R["exc_so"] < T1)
    i1 = np.flatnonzero(m1)
    d1 = R["day"][i1]; y1 = R["yday"][i1]; X1 = R["X"][i1]
    w1 = 1.0 / np.bincount(np.unique(d1, return_inverse=True)[1])[np.unique(d1, return_inverse=True)[1]]
    P1, M1 = walk(d1, X1, y1, w1, F_ALL, BASE)
    naive1 = X1[:, F_ALL.index("share")]
    res["A1"] = evaluate_scores(P1, y1, d1, W, rng, "A1", inst, {"naive_share": naive1})

    # ---------------- A2 intraday (all rows, uncensored)
    m2 = R["valid"] & R["fin"] & R["unc"]
    i2 = np.flatnonzero(m2)
    d2 = R["day"][i2]; y2 = R["y2"][i2]; X2 = R["X"][i2]
    inv2 = np.unique(d2, return_inverse=True)[1]; w2 = 1.0 / np.bincount(inv2)[inv2]
    P2, M2 = walk(d2, X2, y2, w2, F_ALL, BASE)
    naive2 = R["brange"][i2] / T2
    res["A2"] = evaluate_scores(P2, y2, d2, W, rng, "A2", inst, {"naive_back6h": naive2})

    # ---------------- thresholds per quarter from trailing scores (no labels)
    Qs = quarters(last_day)

    def thr_rows(day, t, X, Ms, score_fn, rates, kind):
        out = {r: np.full(len(day), np.nan) for r in rates}
        for qd, qe, M in Ms:
            te = (day >= qd) & (day < qe); tr = (day >= qd - TRAIL) & (day < qd)
            if not te.any() or tr.sum() < 100:
                continue
            s = score_fn(M, X[tr], tr)
            for r in rates:
                out[r][te] = day_thr(day[tr], s, r * 12 * (min(TRAIL, qd - day.min()) / 365)) if kind == "day" else \
                    pick_thr(t[tr], s, r * (min(TRAIL, qd - day.min()) / 7))
        return out

    lrs = lambda M, X, tr: lr_p(M, X)
    TH1 = thr_rows(d1, R["tc"][i1], X1, M1, lrs, RATES_M, "day")
    TH1n = thr_rows(d1, R["tc"][i1], X1, M1, lambda M, X, tr: naive1[tr], RATES_M, "day")
    TH2 = thr_rows(d2, R["tc"][i2], X2, M2, lrs, RATES_W, "week")
    TH2n = thr_rows(d2, R["tc"][i2], X2, M2, lambda M, X, tr: naive2[tr], RATES_W, "week")

    # session table for A1 recall: all valid sessions (incl. days that crossed before any row)
    Dv = D[D.valid]; days_all = Dv.index.to_numpy(); big_all = (Dv.exc >= T1).to_numpy()
    wk_calm_cut = float(Wk.rng[(Wk.index * 7 - 3 >= year_start_day(2018)) & (Wk.index * 7 - 3 < year_start_day(2023))].median())
    res["calm_week_cut_pct"] = wk_calm_cut

    def calm_in(lo, hi):
        wd = Wk.index.to_numpy() * 7 - 3
        sel = (wd >= lo) & (wd + 7 <= hi)
        return Wk.index.to_numpy()[sel & (Wk.rng.to_numpy() < wk_calm_cut)]

    def a1_stats(alert, lo, hi):
        a = alert & (d1 >= lo) & (d1 < hi)
        ad = d1[a]; ka = np.flatnonzero(a)
        dm = (days_all >= lo) & (days_all < hi)
        nbig = int(big_all[dm].sum()); months = (hi - lo) / 30.44
        hits = y1[a] == 1
        lead = (R["tcross"][i1][a][hits] - R["tc"][i1][a][hits]) / 60
        ahead = 1 - R["exc_so"][i1][a] / R["exc_final"][i1][a]
        calm = calm_in(lo, hi); fa_w = (ad[~hits] + 3) // 7
        return dict(alerts=int(a.sum()), per_month=float(a.sum() / months), sessions=int(dm.sum()), big_days=nbig,
                    base_rate=float(big_all[dm].mean()) if dm.any() else None,
                    precision=float(hits.mean()) if a.any() else None, precision_ci=wilson(int(hits.sum()), int(a.sum())),
                    recall=float(hits.sum() / nbig) if nbig else None,
                    lead_h_median=float(np.median(lead)) if hits.any() else None,
                    ahead_median_hits=float(np.median(ahead[hits])) if hits.any() else None,
                    ahead_median_all=float(np.median(ahead)) if a.any() else None,
                    alert_hour_utc_median=float(np.median(R["hour"][i1][a])) if a.any() else None,
                    calm_weeks=int(len(calm)), calm_false_per_week=float(np.isin(fa_w, calm).sum() / len(calm)) if len(calm) else None,
                    calm_weeks_with_false_share=float(np.isin(calm, fa_w).mean()) if len(calm) else None,
                    first_alert_lag_days=float((R["tc"][i1][ka[0]] - (lo * 1440 - 120)) / 1440) if len(ka) else None)

    ep2 = episodes(R["tc"][i2], y2); ne2 = int(ep2.max() + 1)
    e_first = np.flatnonzero(ep2 >= 0)[np.unique(ep2[ep2 >= 0], return_index=True)[1]]
    e_day = d2[e_first]

    def a2_stats(alert, lo, hi):
        mm = (d2 >= lo) & (d2 < hi); a = alert & mm; ka = np.flatnonzero(a)
        hits = y2[a] == 1; weeks = (hi - lo) / 7
        rec = np.zeros(ne2, bool); rec[np.unique(ep2[a & (ep2 >= 0)])] = True
        em = (e_day >= lo) & (e_day < hi)
        calm = calm_in(lo, hi); fa_w = (d2[a][~hits] + 3) // 7
        return dict(alerts=int(a.sum()), per_week=float(a.sum() / weeks), base_rate=float(y2[mm].mean()) if mm.any() else None,
                    precision=float(hits.mean()) if a.any() else None, precision_ci=wilson(int(hits.sum()), int(a.sum())),
                    episodes=int(em.sum()), recall_ep=float(rec[em].mean()) if em.any() else None,
                    lead_min_median=float(np.median(30 * R["pas"][i2][a][hits])) if hits.any() else None,
                    ahead_median_hits=float(np.nanmedian(ahead_share(R["fwd"][i2][a][hits], R["back"][i2][a][hits]))) if hits.any() else None,
                    ahead_median_all=float(np.nanmedian(ahead_share(R["fwd"][i2][a], R["back"][i2][a]))) if a.any() else None,
                    fwd_pct_median_alerts=float(np.median(R["fwd"][i2][a])) if a.any() else None,
                    fwd_pct_median_all=float(np.median(R["fwd"][i2][mm])) if mm.any() else None,
                    calm_weeks=int(len(calm)), calm_false_per_week=float(np.isin(fa_w, calm).sum() / len(calm)) if len(calm) else None,
                    calm_weeks_with_false_share=float(np.isin(calm, fa_w).mean()) if len(calm) else None,
                    first_alert_lag_days=float((R["tc"][i2][ka[0]] - (lo * 1440 - 120)) / 1440) if len(ka) else None)

    AL1 = {r: first_per_day(d1, np.where(np.isfinite(TH1[r]) & np.isfinite(P1["lr"]), P1["lr"], -1), np.nan_to_num(TH1[r], nan=9)) for r in RATES_M}
    AL1n = {r: first_per_day(d1, np.where(np.isfinite(TH1n[r]) & np.isfinite(P1["lr"]), naive1, -1), np.nan_to_num(TH1n[r], nan=99)) for r in RATES_M}
    AL1x = {x: first_per_day(d1, np.where(np.isfinite(P1["lr"]), naive1, -1), x) for x in (0.5, 0.8)}
    AL2 = {r: fire(R["tc"][i2], np.where(np.isfinite(TH2[r]) & np.isfinite(P2["lr"]), P2["lr"], -1), np.nan_to_num(TH2[r], nan=9)) for r in RATES_W}
    AL2n = {r: fire(R["tc"][i2], np.where(np.isfinite(TH2n[r]) & np.isfinite(P2["lr"]), naive2, -1), np.nan_to_num(TH2n[r], nan=99)) for r in RATES_W}
    WW = {k: v for k, v in W.items() if k in ("dev", "w2023")}
    WW.update({c: (dnum(a), min(dnum(b), last_day + 1)) for c, (a, b) in CRISES.items()})
    res["ops_A1"] = {w: {**{f"model_{r}pm": a1_stats(AL1[r], lo, hi) for r in RATES_M},
                         **{f"naive_{r}pm": a1_stats(AL1n[r], lo, hi) for r in RATES_M},
                         **{f"naive_fixed_{x}": a1_stats(AL1x[x], lo, hi) for x in AL1x}} for w, (lo, hi) in WW.items()}
    res["ops_A2"] = {w: {**{f"model_{r}pw": a2_stats(AL2[r], lo, hi) for r in RATES_W},
                         **{f"naive_{r}pw": a2_stats(AL2n[r], lo, hi) for r in RATES_W}} for w, (lo, hi) in WW.items()}
    for w in res["ops_A1"]:
        for k, o in res["ops_A1"][w].items():
            de.log_trial({"exp": EXP, "target": "A1", "inst": inst, "window": w, "op": k, "precision": o["precision"], "recall": o["recall"],
                          "per_month": o["per_month"], "abs11_sha256": CODE["abs11.py"]})
        for k, o in res["ops_A2"][w].items():
            de.log_trial({"exp": EXP, "target": "A2", "inst": inst, "window": w, "op": k, "precision": o["precision"], "recall_ep": o["recall_ep"],
                          "per_week": o["per_week"], "abs11_sha256": CODE["abs11.py"]})

    # ---------------- session-clock check (all OOS alerts 2019+)
    hist = lambda hrs: {str(h): int(c) for h, c in zip(*np.unique(hrs, return_counts=True))}
    ok1 = np.isfinite(P1["lr"]); ok2 = np.isfinite(P2["lr"])
    xing = (R["tcross"][i1][ok1 & (y1 == 1)] % 1440) // 60
    res["clock"] = dict(A1_alert_hours_2pm=hist(R["hour"][i1][AL1[2]]), A1_naive_alert_hours_2pm=hist(R["hour"][i1][AL1n[2]]),
                        A1_crossing_hours=hist(pd.Series(xing).groupby(d1[ok1 & (y1 == 1)]).first().to_numpy()),
                        A1_remaining_exc_median_alerts=float(np.median((R["exc_final"] - R["exc_so"])[i1][AL1[2]])),
                        A1_remaining_exc_median_all=float(np.median((R["exc_final"] - R["exc_so"])[i1][ok1])),
                        A2_alert_hours_2pw=hist(R["hour"][i2][AL2[2]]), A2_positive_hours=hist(R["hour"][i2][ok2 & (y2 == 1)]),
                        A2_fwd_median_alerts=float(np.median(R["fwd"][i2][AL2[2]])), A2_fwd_median_all=float(np.median(R["fwd"][i2][ok2])),
                        A2_fwd_median_by_hour={str(h): float(np.median(R["fwd"][i2][ok2 & (R["hour"][i2] == h)])) for h in range(24)
                                               if (ok2 & (R["hour"][i2] == h)).any()})

    # ---------------- decision rule
    def decide(ev, ops, opkey, rate_unit):
        dec = {}
        for w in ("dev", "w2023"):
            a = ev["auc"].get(w, {})
            bases = {k: v[0] for k, v in a.items() if k.startswith(("base_", "naive"))}
            bb = max(bases, key=bases.get)
            dec[f"auc_{w}"] = dict(lr=a["lr"], best_baseline=bb, best_baseline_auc=bases[bb], ok=a["lr"][1] > bases[bb])
            o = ops[w][opkey]
            base = o["base_rate"]
            rec = o["recall"] if "recall" in o else o["recall_ep"]
            dec[f"op_{w}"] = dict(recall=rec, precision=o["precision"], base=base,
                                  ok=bool(rec is not None and o["precision"] is not None and rec >= 0.5 and o["precision"] >= 2 * base))
        citl = {y: ev["cal"][str(y)]["lr"]["citl"] for y in range(2019, 2023) if str(y) in ev["cal"]}
        dec["citl_dev_years"] = citl
        dec["citl_ok"] = sum(abs(v) <= 0.05 for v in citl.values()) >= 3
        dec["PASS"] = bool(all(dec[f"auc_{w}"]["ok"] and dec[f"op_{w}"]["ok"] for w in ("dev", "w2023")) and dec["citl_ok"])
        return dec
    res["decision"] = {"A1": decide(res["A1"], res["ops_A1"], "model_2pm", "month"),
                       "A2": decide(res["A2"], res["ops_A2"], "model_2pw", "week")}

    # ---------------- drift monitor proposal (rolling CITL by session, band from 2019-2022 OOS)
    def drift(p, y, day):
        ok = np.isfinite(p); ud = np.unique(day[ok]); ix = np.searchsorted(ud, day[ok])
        sp = np.bincount(ix, p[ok] - y[ok], len(ud)); cnt = np.bincount(ix, minlength=len(ud)).astype(float)
        o = {}
        for wn in (20, 60):
            v = pd.Series(sp).rolling(wn).sum().to_numpy() / pd.Series(cnt).rolling(wn).sum().to_numpy()
            dv = ud < year_start_day(2023)
            band = [float(np.nanquantile(v[dv], 0.025)), float(np.nanquantile(v[dv], 0.975))]
            out = (v < band[0]) | (v > band[1])
            o[f"citl_{wn}"] = dict(band=band, outside_share={str(y): float(out[(ud >= year_start_day(y)) & (ud < year_start_day(y + 1))].mean())
                                                              for y in range(2019, 2027) if ((ud >= year_start_day(y)) & (ud < year_start_day(y + 1))).any()},
                                   latest=float(v[-1]))
        return o
    res["drift"] = {"A1": drift(P1["lr"], y1, d1), "A2": drift(P2["lr"], y2, d2)}

    # ---------------- artifacts for passing targets
    res["artifacts"] = {}
    for tgt, (Ms, ii, TH, Xs, ylab) in {"A1": (M1, i1, TH1, X1, "A1 big day"), "A2": (M2, i2, TH2, X2, "A2 next-6h big move")}.items():
        if not res["decision"][tgt]["PASS"]:
            continue
        qd, qe, M = Ms[-1]
        thr = {r: float(TH[r][-1]) for r in TH}
        art = dict(model=f"abs11 {ylab} LR (attention only, no direction)", instrument=inst,
                   status="research artifact; NOT qualified; silent shadow under issue 313 decides",
                   target=dict(A1=f"session max |excursion| from the 22:00 UTC open >= {T1:.4f}% of the open",
                               A2=f"max |excursion| from the 30-min bar close over the next {H_FWD} min >= {T2:.4f}% of that close")[tgt],
                   population=dict(A1="valid sessions (>= 8 30-min bars), 30-min bar closes before the session excursion reaches T1",
                                   A2="valid sessions, every 30-min bar close")[tgt],
                   features=F_ALL, feature_definitions=FEATDEF, scaler=dict(mean=M["mean"], scale=M["scale"]), coefficients=M["coef"],
                   intercept=M["b"], formula="z = intercept + sum_j coef[j]*(x[j]-mean[j])/scale[j]; p = 1/(1+exp(-z))",
                   calibrator="identity (LR sigmoid is the probability)", training_cutoff=M["cut"], applies_from=M["applies_from"],
                   training_rows=M["n"], training_base_rate=M["base"], T1_pct=T1, T2_pct=T2,
                   alert_thresholds={f"{r}_per_{'month' if tgt == 'A1' else 'week'}": thr[r] for r in thr},
                   alert_rule=dict(A1="first 30-min close in the session with p >= threshold (one alert per session)",
                                   A2=f"p >= threshold and no alert in the previous {COOL} min")[tgt],
                   threshold_rule=f"each quarter, from the trailing {TRAIL} days of the current model's scores (no labels)",
                   refit="quarterly expanding, rows with session day < quarter start - 5 days", drift_monitor=res["drift"][tgt], code_sha256=CODE)
        if tgt == "A1":
            _, _, Mo_ = Mo[-1]
            art["open_model"] = dict(features=F_OPEN, scaler=dict(mean=Mo_["mean"], scale=Mo_["scale"]), coefficients=Mo_["coef"], intercept=Mo_["b"])
        fa = os.path.join(OUT, f"artifact_{TAG(inst)}_{tgt}.json"); json.dump(art, open(fa, "w"), indent=1, default=float)
        L = np.flatnonzero(R["valid"] & R["fin"])[-40:]
        zl = de.e2_lr_raw(M, R["X"][L])
        zg = np.array([M["b"] + sum(M["coef"][j] * (x[j] - M["mean"][j]) / M["scale"][j] for j in range(len(F_ALL))) for x in R["X"][L]])
        assert np.allclose(zl, zg, atol=1e-10)
        fx = dict(instrument=inst, artifact=os.path.basename(fa), features=F_ALL, tolerance=1e-9,
                  cases=[dict(bar_close_utc=str(np.datetime64(int(R["tc"][b]), "m")), x=[float(v) for v in R["X"][b]], z=float(zl[k]),
                              p=float(1 / (1 + np.exp(-zl[k])))) for k, b in enumerate(L)])
        fp = os.path.join(OUT, f"parity_{TAG(inst)}_{tgt}.json"); json.dump(fx, open(fp, "w"), indent=1)
        res["artifacts"][tgt] = [fa, fp]
    res["secs"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(OUT, f"{TAG(inst)}.json"), "w"), indent=1, default=float)
    print("done", inst, "secs", res["secs"], json.dumps({k: v["PASS"] for k, v in res["decision"].items()}), flush=True)


FEATDEF = {
    "session": "day key = floor((t_min + 120) / 1440): sessions roll at 22:00 UTC; 30-min mid bars ((bid+ask)/2 per field) from M1; valid session >= 8 bars",
    "rv1/rv5/rv22": "log(mean over the previous 1/5/22 valid sessions of RV_d + 1e-4), RV_d = 100*sqrt(sum of squared 30-min log returns in session d; first bar uses log(c/o))",
    "rv_so": "log(100*sqrt(sum of squared 30-min log returns so far in the session) + 1e-4)",
    "rv6h": "log(100*sqrt(sum of squared 30-min log returns of bars opening in the last 360 min) + 1e-4)",
    "exc_so": "100*max(high_so - open, open - low_so)/open, session so far",
    "share": "exc_so / T1",
    "move_so": "100*|close - open|/open",
    "rng_norm": "log((range_so% + 1e-4)/(median range_so% at the same 30-min slot over the previous 60 valid sessions (min 20) + 1e-4))",
    "tod_*": "sin/cos(2*pi*k*f), k=1,2, f = (slot+1)/48, slot = ((t_open+120) mod 1440)//30",
    "dow_*": "sin/cos(2*pi*((day+3) mod 7)/7)",
    "gap": "100*|session open - previous valid session close| / previous close",
    "stress": "share of WTI, XAU, XAG, NATGAS, SPX500, EUR/USD whose rv5 (as of the session open) exceeds the 80th percentile of its own previous 252 sessions (min 60); instrument last value carried <= 3 sessions; needs >= 4 instruments",
}


def register(amend=None):
    f = os.path.join(HERE, "prereg.json")
    if amend:
        reg = json.load(open(f))
        reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=amend, code_sha256=CODE))
        json.dump(reg, open(f, "w"), indent=1); print("amended"); return
    assert not os.path.exists(f), "prereg.json exists (use amend)"
    th = json.load(open(os.path.join(OUT, "thresholds.json")))
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="abs11: absolute (% of price) big-move attention alert, day level (A1) and next-6h (A2); issue 310, epic 307",
        before_registration=("Computed before this file: only the 2018-2022 distributions of daily max |excursion| from the 22:00 UTC open "
                             "and of next-6h max |excursion| (out/thresholds.json), to fix T1/T2 as instructed. No feature, model, score, "
                             "alert or post-2022 outcome was computed. Prior knowledge: alert7 (ATR-relative T2) results and spike 4 summary."),
        declared="Attention only. No entries, no direction, no test ledger, nothing qualified (silent shadow under issue 313 decides). "
                 "2023+ is a development window (inspected data), not a holdout.",
        instruments=INSTS,
        thresholds={k: dict(T1=v["T1"], T2=v["T2"], A1_floor=v["A1_floor"], A1_q90_2018_22=v["A1_q90_2018_22"],
                            A2_q90_2018_22=v["A2_q90_2018_22"]) for k, v in th.items()},
        threshold_rule="T1 = max(declared floor, q90 of 2018-2022 valid-session max |excursion| % from the 22:00 UTC open); T2 = q90 of 2018-2022 next-6h max |excursion| % from 30-min closes (uncensored rows on valid sessions). Fixed for all years.",
        targets=dict(A1="session is big: max |excursion| from open >= T1 (evaluated at the open and at every 30-min close while the session excursion so far < T1)",
                     A2="max(high - close, close - low) over bars opening within the next 360 min >= T2 % of the close"),
        features=dict(open=F_OPEN, intraday=F_ALL, definitions=FEATDEF),
        models=dict(lr="de_v2.e2_lr_fit: standardized L2 LR C=0.1, weights 1/rows-per-session (open model: weight 1); identity calibrator; exported model",
                    hgb="HistGradientBoosting comparator (max_iter 150, lr 0.05, 15 leaves, min leaf 200, l2 1.0), same weights",
                    baselines=dict(rv="LR on rv1, rv5, rv22, rv_so, rv6h (open: rv1, rv5, rv22)", tod="LR on time of day + day of week (open: day of week)",
                                   naive_A1="score = exc_so / T1 (move so far as share of threshold)", naive_A2="score = trailing-6h range % / T2"),
                    refit="quarterly expanding from 2019-01-01, training rows with session day < quarter start - 5 days, from data start (2018)"),
        metrics=dict(auc=f"per year 2019-2026; pooled dev 2019-2022 and 2023+ with day-cluster bootstrap 95% CI ({NBOOT} reps)",
                     calibration="calibration-in-the-large (mean p - observed) and Brier vs base, per year"),
        alerts=dict(A1=f"one alert per session: first 30-min close with p >= threshold; per quarter the threshold is the (rate*12*years)-th largest per-session max score over the trailing {TRAIL} days (no labels); rates {RATES_M}/month",
                    A2=f"p >= threshold and no alert in the previous {COOL} min; per quarter the threshold whose trailing {TRAIL}-day alert count is closest to rate*weeks; rates {RATES_W}/week",
                    naive="the same threshold procedure applied to the naive score (matched rate), plus fixed A1 naive rules share >= 0.5 and >= 0.8",
                    metrics="precision (vs base rate, Wilson CI), recall of big days (A1, all valid sessions incl. days that crossed before any evaluation) / of big-move episodes (A2, runs of positive rows <= 60 min apart), median lead time to the threshold crossing, median share of the move still ahead (A1: 1 - exc_so/final excursion; A2: fwd/(fwd+back 6h)), false alarms per calm week (session-week range % below the 2018-2022 median)"),
        crisis=dict(windows=CRISES, metrics="first-alert lag (days from window start), recall of big days / episodes, alerts per week / month, precision"),
        clock_check="alert hour (UTC) histograms vs crossing / positive hours; median forward % move at alerts vs all rows; A1 remaining excursion at alerts vs all rows",
        decision_rule=("Per instrument and target, the LR model PASSES for silent shadow logging if, in BOTH dev 2019-2022 and 2023+: AUC day-bootstrap CI lower bound > "
                       "the best baseline's point AUC (rv, tod, naive); calibration-in-the-large within +/-0.05 in >= 3 of 4 dev years; and at the 2/month (A1) or "
                       "2/week (A2) operating point recall >= 0.5 and precision >= 2 x base rate (A1 base = share of valid sessions that are big; A2 base = share of positive rows). "
                       "A1 is the primary product target (as specified); A2 uses the same rule at 2/week as a declared extension. Otherwise FAIL. Six instruments, no multiplicity correction."),
        artifact="for PASS targets only: latest quarterly LR (feature order, scaler, coefficients, intercept, identity calibrator, cutoff, latest thresholds, drift band, code hashes) + parity fixture of the 40 latest scoreable rows",
        drift="proposal: rolling 20/60-session calibration-in-the-large; band = 2.5/97.5% of the 2019-2022 OOS values; report share outside per year",
        budget=dict(instruments=6, targets=3, models=2, baselines=3, alert_rates=3, tuned_hyperparameters=0),
        code_sha256=CODE)
    json.dump(reg, open(f, "w"), indent=1)
    print("registered", reg["created"])


if __name__ == "__main__":
    MODE = sys.argv[1] if len(sys.argv) > 1 else ""
    if MODE == "thresholds":
        thresholds()
    elif MODE == "register":
        register()
    elif MODE == "amend":
        register(amend=sys.argv[2])
    elif MODE == "check":
        check()
    elif MODE == "run":
        run(sys.argv[2])
