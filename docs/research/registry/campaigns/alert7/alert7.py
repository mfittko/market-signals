"""alert7 (queue item 7, retargeted): declared replication of the side-free big-move (T2) alert model lr_todvol on
XAG/USD, NATGAS/USD, SPX500/USD, EUR/USD, with WTI and XAU rerun through the same frozen pipeline for reference.

Frozen from ablate4 / fm2 / risk8 (nothing is tuned here): T2 label (72 M5 bars, KX by the ablate4 2018 base-rate
rule), 12 time-of-day + volatility features (bench1 eng_bars), de_v2.e2_lr_fit (standardized L2 LR, C=0.1, day
weights), all-hours 30-minute cadence fit population with spread rule (risk8 load), quarterly expanding refit.
Attention layer only: no entries, no R, no ledger.

  python alert7.py register        write prereg.json (refuses to overwrite)
  python alert7.py amend "reason"  append an amendment with new code hashes
  python alert7.py check           synthetic self-checks of alert, threshold, episode and ahead-share helpers
  python alert7.py run INST        -> out/<TAG>.json, out/artifact_<TAG>.json, out/parity_<TAG>.json
"""
import os, sys, json, time, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
ABL = os.path.join(os.path.dirname(HERE), "ablate4")
sys.path.insert(0, ABL)
MODE = sys.argv[1] if len(sys.argv) > 1 else ""
ARG = sys.argv[2] if len(sys.argv) > 2 else ""
NOSPREAD = len(sys.argv) > 3 and sys.argv[3] == "nospread"   # amendment A1: population without the entry spread rule
sys.argv = [sys.argv[0], "x", ARG]  # ablate4/run.py rewrites argv for bench.py
import run as A  # noqa: E402
from run import bm, de, np, year_start_day  # noqa: E402
from validate import day_of  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402

EXP = "alert7"
INSTS = ["XAG/USD", "NATGAS/USD", "SPX500/USD", "EUR/USD", "WTICO/USD", "XAU/USD"]
GROUPS = {"tod": ["tod_s", "tod_c", "dow_s", "dow_c", "nday"],
          "vol": ["rv12_288", "rv48_288", "rv288", "atr_px", "atr_ratio", "range", "range3"]}
GROUPS["todvol"] = GROUPS["tod"] + GROUPS["vol"]
N_FWD = A.N_FWD                     # 72 M5 bars
CADENCE = 30
YEARS = list(range(2020, 2027))
Q_FIRST = 2019                      # first quarterly refit (OOS from 2019-01-01; 2019-22 feed the drift thresholds)
RATES = (1, 2, 4)                   # target alerts per instrument per week
COOL = N_FWD * 5                    # minutes: no new alert within one horizon (6 h) of the previous alert
TRAIL = 365                         # days of trailing scores that set each quarter's alert threshold (no labels)
GAP = 60                            # minutes: consecutive T2=1 cadence rows closer than this form one episode
MAJOR_Q = 0.90                      # major episode: peak forward excursion (% of price) >= 2018-22 90th pct of episode peaks
CRISES = {"2020H1": ("2020-01-01", "2020-07-01"), "2022H1": ("2022-01-01", "2022-07-01"),
          "2025Q4_26Q1": ("2025-10-01", "2026-04-01")}
DRIFT_WIN = (20, 60)                # sessions
DRIFT_Q = (0.025, 0.975)
NBOOT = 300
TAG = ARG.replace("/", "_") + ("_ns" if NOSPREAD else "")
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"alert7.py": sha(os.path.join(HERE, "alert7.py")), "bench.py": bm.CODE["bench.py"], "ablate4/run.py": A.CODE["run.py"],
        "evaluator": de.CODE_SHA}
dstr = lambda d: str(np.datetime64(int(d), "D"))
dnum = lambda s: int(day_of(np.datetime64(s, "m").astype(np.int64)))


# ------------------------------------------------------------------ pure helpers (covered by `check`)
def fire(t, p, thr, cool=COOL):
    """Alert rows: p >= thr and no alert in the previous `cool` minutes (rows sorted by time)."""
    out = np.zeros(len(p), bool); last = -np.inf
    for k in np.flatnonzero(p >= thr):
        if t[k] - last >= cool:
            out[k] = True; last = t[k]
    return out


def pick_thr(t, p, per_week, weeks):
    """Threshold whose alert count over the trailing rows is closest to per_week * weeks (ties: higher threshold)."""
    target = per_week * weeks
    cand = np.unique(np.quantile(p, np.linspace(0.30, 0.9999, 300)))
    cnt = lambda c: int(fire(t, p, c).sum())
    lo, hi = 0, len(cand) - 1                      # count falls (almost) monotonically with the threshold: bisect,
    while lo < hi:                                 # then check the neighbourhood for the closest count
        mid = (lo + hi) // 2
        if cnt(cand[mid]) <= target:
            hi = mid
        else:
            lo = mid + 1
    best = None
    for c in cand[max(0, lo - 4):lo + 5][::-1]:
        d = abs(cnt(c) - target)
        if best is None or d < best[0]:
            best = (d, c)
    return float(best[1])


def episodes(t, y, gap=GAP):
    """Episode id per row: runs of y == 1 whose consecutive rows are <= gap minutes apart; -1 where y == 0."""
    one = y == 1
    cont = np.r_[False, one[:-1]] & (np.r_[np.inf, np.diff(t)] <= gap)
    start = one & ~cont
    return np.where(one, np.cumsum(start) - 1, -1)


def ahead_share(fwd, back):
    """Share of the (prior-6h + next-6h) move in the eventual direction that is still ahead at the alert."""
    tot = fwd + back
    return np.where(tot > 0, fwd / np.where(tot > 0, tot, 1), np.nan)


def wilson(k, n, z=1.96):
    if n == 0:
        return [np.nan, np.nan]
    ph = k / n; den = 1 + z * z / n; cen = (ph + z * z / (2 * n)) / den
    hw = z * np.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / den
    return [float(cen - hw), float(cen + hw)]


def check():
    t = np.arange(0, 30 * 40, 30.0); p = np.zeros(40); p[[3, 4, 5, 20, 21, 35]] = 0.9
    f = fire(t, p, 0.5)
    assert list(np.flatnonzero(f)) == [3, 20, 35], np.flatnonzero(f)  # 4,5 within 6 h of 3; 21 of 20
    assert fire(t, p, pick_thr(t, p, 3, 1.0)).sum() == 3 and fire(t, p, pick_thr(t, p, 4, 1.0)).sum() == 4
    y = np.array([0, 1, 1, 0, 1, 1, 1, 0, 1]); tt = np.array([0, 30, 60, 90, 120, 150, 300, 330, 360.0])
    assert list(episodes(tt, y)) == [-1, 0, 0, -1, 1, 1, 2, -1, 3]  # 150 -> 300 gap 150 min breaks the run
    a = ahead_share(np.array([3.0, 0, 2]), np.array([1.0, 0, 6]))
    assert a[0] == 0.75 and np.isnan(a[1]) and a[2] == 0.25
    lo, hi = wilson(5, 10); assert 0.23 < lo < 0.24 and 0.76 < hi < 0.77
    # dot product + sigmoid equals de_v2's standardized LR path (what the Go port implements)
    rng = np.random.default_rng(0); X = rng.normal(size=(500, 3)); yy = (X[:, 0] + rng.normal(size=500) > 0).astype(int)
    M = de.e2_lr_fit(X, yy, np.ones(500))
    z = sum(M["coef"][j] * (X[:, j] - M["mean"][j]) / M["scale"][j] for j in range(3)) + M["b"]
    assert np.allclose(z, de.e2_lr_raw(M, X), atol=1e-12)
    print("alert7 self-check OK: alert cooldown, threshold pick, episodes, ahead share, Wilson, LR dot-product parity")


# ------------------------------------------------------------------ data
def path_stats(B, kx):
    """Per bar: first-passage bar offset of the KX x ATR band (0 = none in 72), forward excursion in the eventual
    direction (ATR units and % of price), and the prior-6h move already done in that direction (ATR units)."""
    n = len(B["t"]); c, h, l, a = B["mid_c"], B["mid_h"], B["mid_l"], B["atr"]
    up, dn = c + kx * a, c - kx * a
    hit = np.zeros(n, np.int16); fh = np.full(n, -np.inf); fl = np.full(n, np.inf)
    for j in range(1, N_FWD + 1):
        b = np.clip(np.arange(n) + j, 0, n - 1)
        new = (hit == 0) & ((h[b] >= up) | (l[b] <= dn)); hit[new] = j
        fh = np.maximum(fh, h[b]); fl = np.minimum(fl, l[b])
    bh = pd.Series(h).rolling(N_FWD, min_periods=1).max().to_numpy(); bl = pd.Series(l).rolling(N_FWD, min_periods=1).min().to_numpy()
    upx, dnx = fh - c, c - fl
    dirn = np.where(upx >= dnx, 1, -1)
    fwd = np.maximum(upx, dnx)
    back = np.maximum(np.where(dirn > 0, c - bl, bh - c), 0)
    with np.errstate(invalid="ignore", divide="ignore"):
        return dict(hit=hit, fwd_atr=fwd / a, back_atr=back / a, fwd_pct=100 * fwd / np.maximum(np.abs(c), 1.0))


def load(inst):
    m1, B, O, L = de.prep(inst, None)
    Eb = bm.eng_bars(B)
    X = np.column_stack([Eb[k] for k in GROUPS["todvol"]])
    kx, rates = A.choose_kx(B)
    big, _, _ = A.big_move(B, kx)
    u = A.utc_close(B)
    m = (u % CADENCE == 0) & de.base_active(B, O) & ((B["spr"] <= de.SPR_MAX) | NOSPREAD) & np.isfinite(X).all(1) & np.isfinite(big)
    i = np.flatnonzero(m)
    day = B["day"][i]
    inv = np.unique(day, return_inverse=True)[1]
    S = dict(i=i, day=day, t=B["t"][i].astype(float), w=1.0 / np.bincount(inv)[inv], y=big[i].astype(int),
             p3=(u[i] >= A.LIQ[0]) & (u[i] <= A.LIQ[1]))
    PS = path_stats(B, kx)
    for k, v in PS.items():
        S[k] = v[i]
    # latest scoreable rows (features finite, label may be censored): for the parity fixture
    mf = (u % CADENCE == 0) & np.isfinite(X).all(1) & np.isfinite(B["atr"])
    S["latest"] = np.flatnonzero(mf)[-40:]
    # weekly range (% of mean price) by session week, for calm weeks
    wk = (B["day"] + 3) // 7
    g = pd.DataFrame({"wk": wk, "h": B["mid_h"], "l": B["mid_l"], "c": np.abs(B["mid_c"])}).groupby("wk")
    W = pd.DataFrame({"rng": 100 * (g["h"].max() - g["l"].min()) / np.maximum(g["c"].mean(), 1.0), "first": g.size()})
    return B, X, S, kx, rates, W


def fit(Xr, S, cut_day):
    m = S["day"] < cut_day - de.EMB
    M = de.e2_lr_fit(Xr[m], S["y"][m], S["w"][m])
    M.update(cut=dstr(cut_day - de.EMB), n=int(m.sum()), base=float(S["y"][m].mean()))
    return M


def sig(M, Xr):
    return 1 / (1 + np.exp(-de.e2_lr_raw(M, Xr)))


def quarter_starts(first_year, last_day):
    out = []
    for y in range(first_year, 2100):
        for mo in (1, 4, 7, 10):
            d = dnum(f"{y}-{mo:02d}-01")
            if d > last_day:
                return out
            out.append((f"{y}-{mo:02d}-01", d))


def cal_slope(p, y):
    z = np.log(np.clip(p, 1e-6, 1 - 1e-6) / np.clip(1 - p, 1e-6, 1))
    lr = LogisticRegression(C=1e6, max_iter=1000).fit(z[:, None], y)
    return float(lr.coef_[0][0]), float(lr.intercept_[0])


def paired(y, sa, sb, day, rng, nb=NBOOT):
    ud, inv = np.unique(day, return_inverse=True)
    rows = [np.flatnonzero(inv == k) for k in range(len(ud))]
    d0 = bm.auc(y, sa) - bm.auc(y, sb); bs = []
    for _ in range(nb):
        ix = np.concatenate([rows[k] for k in rng.integers(0, len(ud), len(ud))])
        bs.append(bm.auc(y[ix], sa[ix]) - bm.auc(y[ix], sb[ix]))
    return [float(d0), float(np.nanpercentile(bs, 2.5)), float(np.nanpercentile(bs, 97.5))]


def calib(p, y, base_train):
    sl, ic = cal_slope(p, y)
    return dict(n=int(len(y)), base=float(y.mean()), mean_p=float(p.mean()), citl=float(p.mean() - y.mean()),
                brier=float(np.mean((p - y) ** 2)), brier_base_oracle=float(y.mean() * (1 - y.mean())),
                brier_base_train=float(np.mean((base_train - y) ** 2)), cal_slope=sl, cal_intercept=ic)


# ------------------------------------------------------------------ run
def run(inst):
    t0 = time.time()
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    cur = reg["amendments"][-1]["code_sha256"] if reg.get("amendments") else reg["code_sha256"]
    assert cur["alert7.py"] == CODE["alert7.py"], "alert7.py changed after registration (amend first)"
    assert cur["evaluator"] == de.CODE_SHA and cur["bench.py"] == bm.CODE["bench.py"]
    B, X, S, kx, rates, W = load(inst)
    n = len(S["i"]); Xr = {g: X[S["i"]][:, [GROUPS["todvol"].index(k) for k in cols]] for g, cols in GROUPS.items()}
    last_day = int(B["day"][-1]); rng = np.random.default_rng(7)
    Q = quarter_starts(Q_FIRST, last_day)
    P = {k: np.full(n, np.nan) for k in ("q_todvol", "q_tod", "q_vol", "fixed2020", "fixed2023")}
    TB = np.full(n, np.nan)                    # training base rate of the active quarterly model (drift monitor)
    THR = {r: np.full(n, np.nan) for r in RATES}
    arts = []
    for qi, (qs, qd) in enumerate(Q):
        qe = Q[qi + 1][1] if qi + 1 < len(Q) else last_day + 1
        mm = (S["day"] >= qd) & (S["day"] < qe)
        M = {g: fit(Xr[g], S, qd) for g in GROUPS}
        for g in GROUPS:
            P[f"q_{g}"][mm] = sig(M[g], Xr[g][mm])
        TB[mm] = M["todvol"]["base"]
        tr = (S["day"] >= qd - TRAIL) & (S["day"] < qd)   # thresholds: score distribution only, no labels
        pt = sig(M["todvol"], Xr["todvol"][tr])
        thr = {r: pick_thr(S["t"][tr], pt, r, TRAIL / 7) for r in RATES}
        for r in RATES:
            THR[r][mm] = thr[r]
        arts.append(dict(applies_from=qs, train_cutoff=M["todvol"]["cut"], rows=M["todvol"]["n"], base=M["todvol"]["base"],
                         coef=M["todvol"]["coef"], b=M["todvol"]["b"], thr={str(r): thr[r] for r in RATES}))
        last_model, last_thr, last_qs = M["todvol"], thr, qs
    for name, cy in (("fixed2020", 2020), ("fixed2023", 2023)):
        M = fit(Xr["todvol"], S, year_start_day(cy)); mm = S["day"] >= year_start_day(cy)
        P[name][mm] = sig(M, Xr["todvol"][mm])
    res = dict(inst=inst, kx=kx, kx_rates_2018=rates, data_first=dstr(B["day"][0]), data_last=dstr(last_day), rows=n,
               rows_by_year={str(y): int(((S["day"] >= year_start_day(y)) & (S["day"] < year_start_day(y + 1))).sum()) for y in range(2018, 2027)},
               base_by_year={str(y): float(S["y"][(S["day"] >= year_start_day(y)) & (S["day"] < year_start_day(y + 1))].mean()) for y in range(2018, 2027)},
               code=CODE, note="development evidence; 2023+ is a development window, not a holdout; attention layer only",
               auc={}, paired={}, cal={}, rel={}, ops={}, crisis={}, drift={}, artifacts_q=arts)
    # ---------------- 1. AUC and calibration
    wins = {str(y): (year_start_day(y), year_start_day(y + 1)) for y in YEARS}
    wins.update(dev2020_22=(year_start_day(2020), year_start_day(2023)), w2023=(year_start_day(2023), last_day + 1))
    for pop in ("all", "p3"):
        for w, (lo, hi) in wins.items():
            mm = (S["day"] >= lo) & (S["day"] < hi) & (S["p3"] if pop == "p3" else True)
            if mm.sum() < 200:
                continue
            y, d = S["y"][mm], S["day"][mm]
            res["auc"][f"{pop}/{w}"] = {k: A.auc_ci(y, v[mm], d, rng) for k, v in P.items() if np.isfinite(v[mm]).all()}
            for k, a in res["auc"][f"{pop}/{w}"].items():
                de.log_trial({"exp": EXP, "mode": "dev" if w in ("2020", "2021", "2022", "dev2020_22") else "devwindow2023",
                              "inst": inst, "nospread": NOSPREAD, "pop": pop, "window": w, "model": k, "kx": kx, "auc_test": a[0], "alert7_sha256": CODE["alert7.py"]})
            if w in ("dev2020_22", "w2023"):
                res["paired"][f"{pop}/{w}"] = {f"q_todvol - {b}": paired(y, P["q_todvol"][mm], P[b][mm], d, rng) for b in ("q_tod", "q_vol")}
            for k in ("q_todvol", "fixed2020", "fixed2023"):
                if np.isfinite(P[k][mm]).all() and pop == "all":
                    tb = TB[mm] if k == "q_todvol" else np.full(mm.sum(), float(S["y"][S["day"] < (year_start_day(2020 if k == "fixed2020" else 2023) - de.EMB)].mean()))
                    res["cal"].setdefault(w, {})[k] = calib(P[k][mm], y, tb)
                    if w in ("dev2020_22", "w2023"):
                        res["rel"].setdefault(w, {})[k] = de.reliability(P[k][mm], y, tuple(np.r_[np.arange(0, 1.0, 0.1), 1.01]))
    # ---------------- 2. alert operating curves (quarterly model, trailing-rank thresholds)
    eid = episodes(S["t"], S["y"])
    ne = eid.max() + 1
    e_peak = np.zeros(ne)
    e_first = np.flatnonzero(eid >= 0)[np.unique(eid[eid >= 0], return_index=True)[1]]
    e_start = S["day"][e_first]; e_t0 = S["t"][e_first]
    np.maximum.at(e_peak, eid[eid >= 0], np.nan_to_num(S["fwd_pct"][eid >= 0]))
    major_cut = float(np.quantile(e_peak[e_start < year_start_day(2023)], MAJOR_Q))
    major = e_peak >= major_cut
    res["episodes"] = dict(n=int(ne), major_cut_pct=major_cut, n_major=int(major.sum()))
    oos = np.isfinite(P["q_todvol"])
    ALR = {}
    for r in RATES:
        al = np.zeros(n, bool)
        last = -np.inf
        for k in np.flatnonzero(oos & (P["q_todvol"] >= THR[r])):
            if S["t"][k] - last >= COOL:
                al[k] = True; last = S["t"][k]
        ALR[r] = al

    def opstats(al, mm, lo, hi):
        a = al & mm; k = int(a.sum()); weeks = (hi - lo) / 7
        hits = a & (S["y"] == 1)
        em = (e_start >= lo) & (e_start < hi)
        rec = np.zeros(ne, bool); rec[np.unique(eid[a & (eid >= 0)])] = True
        o = dict(alerts=k, per_week=k / weeks, base=float(S["y"][mm].mean()) if mm.any() else None,
                 precision=float(hits.sum() / k) if k else None, precision_ci=wilson(int(hits.sum()), k),
                 recall_ep=float(rec[em].mean()) if em.any() else None, n_ep=int(em.sum()),
                 recall_major=float(rec[em & major].mean()) if (em & major).any() else None, n_major=int((em & major).sum()),
                 lead_min_median=float(np.median(5 * S["hit"][hits])) if hits.any() else None,
                 ahead_share_median_hits=float(np.nanmedian(ahead_share(S["fwd_atr"][hits], S["back_atr"][hits]))) if hits.any() else None,
                 ahead_share_median_all=float(np.nanmedian(ahead_share(S["fwd_atr"][a], S["back_atr"][a]))) if k else None,
                 fwd_atr_median_alerts=float(np.nanmedian(S["fwd_atr"][a])) if k else None,
                 fwd_atr_median_all=float(np.nanmedian(S["fwd_atr"][mm])) if mm.any() else None)
        return o
    for r in RATES:
        for w, (lo, hi) in wins.items():
            mm = (S["day"] >= lo) & (S["day"] < hi)
            o = opstats(ALR[r], mm, lo, hi)
            res["ops"][f"{r}/{w}"] = o
            de.log_trial({"exp": EXP, "mode": "dev" if w in ("2020", "2021", "2022", "dev2020_22") else "devwindow2023", "inst": inst, "nospread": NOSPREAD,
                          "op": f"{r}/week", "window": w, "precision": o["precision"], "recall_ep": o["recall_ep"],
                          "alerts_per_week": o["per_week"], "alert7_sha256": CODE["alert7.py"]})
    # ---------------- 3. crisis windows
    wd = (W.index.to_numpy() * 7 - 3)     # first day key of each session week
    calm_cut = float(W["rng"][wd < year_start_day(2023)].median())
    res["calm_week_cut_pct"] = calm_cut
    swk = (S["day"] + 3) // 7
    for cname, (a, b) in {**CRISES, "dev2020_22": ("2020-01-01", "2023-01-01"), "w2023": ("2023-01-01", "2100-01-01")}.items():
        lo, hi = dnum(a), min(dnum(b), last_day + 1)
        mm = (S["day"] >= lo) & (S["day"] < hi)
        wks = W.index[(wd >= lo) & (wd + 7 <= hi)].to_numpy()
        calm = wks[W.loc[wks, "rng"].to_numpy() < calm_cut]
        em = (e_start >= lo) & (e_start < hi) & major
        cres = {}
        for r in RATES:
            al = ALR[r] & mm; o = opstats(ALR[r], mm, lo, hi)
            ka = np.flatnonzero(al)
            o["first_alert_lag_days"] = float((S["t"][ka[0]] - (lo * 1440 - 120)) / 1440) if len(ka) else None
            # first major episode in window: hours from its start to the first alert inside it (None = missed)
            if em.any():
                e0 = int(np.flatnonzero(em)[0]); ina = np.flatnonzero(ALR[r] & (eid == e0))
                o["first_major_start"] = str(np.datetime64(int(e_t0[e0]), "m"))
                o["first_major_lag_h"] = float((S["t"][ina[0]] - e_t0[e0]) / 60) if len(ina) else None
            fa = al & (S["y"] == 0)
            o["calm_weeks"] = int(len(calm))
            o["calm_false_per_week"] = float(np.isin(swk[fa], calm).sum() / len(calm)) if len(calm) else None
            o["calm_weeks_with_false_share"] = float(np.isin(calm, swk[fa]).mean()) if len(calm) else None
            cres[str(r)] = o
        res["crisis"][cname] = cres
    # ---------------- 4. drift monitor: thresholds from 2019-2022 OOS quarterly predictions only
    ud = np.unique(S["day"][oos]); idx = np.searchsorted(ud, S["day"][oos])
    sp = np.bincount(idx, P["q_todvol"][oos] - S["y"][oos], len(ud)); sb = np.bincount(idx, S["y"][oos] - TB[oos], len(ud))
    cnt = np.bincount(idx, minlength=len(ud)).astype(float)
    stats = {}
    for wn in DRIFT_WIN:
        roll = lambda v: pd.Series(v).rolling(wn).sum().to_numpy()
        stats[f"citl_{wn}"] = roll(sp) / roll(cnt)
        stats[f"base_dev_{wn}"] = roll(sb) / roll(cnt)
    devm = ud < year_start_day(2023)
    band = {k: [float(np.nanquantile(v[devm], DRIFT_Q[0])), float(np.nanquantile(v[devm], DRIFT_Q[1]))] for k, v in stats.items()}
    trig = {}
    for k, v in stats.items():
        out = (v < band[k][0]) | (v > band[k][1])
        trig[k] = {str(y): float(out[(ud >= year_start_day(y)) & (ud < year_start_day(y + 1)) & np.isfinite(v)].mean())
                   for y in range(2019, 2027) if ((ud >= year_start_day(y)) & (ud < year_start_day(y + 1))).any()}
        fz = np.flatnonzero(out & (ud >= year_start_day(2023)))
        trig[k]["first_trigger_2023plus"] = dstr(ud[fz[0]]) if len(fz) else None
        trig[k]["latest"] = float(v[-1])
    res["drift"] = dict(band_from_2019_22=band, trigger_share_by_year=trig)
    # ---------------- 5. artifact + parity fixture (latest quarterly model)
    feats = GROUPS["todvol"]
    art = dict(model="lr_todvol T2 big-move alert (attention only, no direction)", instrument=inst, status="research artifact; NOT qualified; shadow under issue 313 decides",
               target=dict(name="T2", horizon_bars=N_FWD, granularity="M5", kx_atr=kx, definition="mid high/low over bars i+1..i+72 reaches mid_close_i +/- kx*ATR_i (production supertrend ATR)"),
               features=feats, feature_definitions={
                   "tod_s/tod_c": "sin/cos(2*pi*(tod+5)/1440), tod = minutes since 22:00 UTC of the bar OPEN; M5 bar",
                   "dow_s/dow_c": "sin/cos(2*pi*((day+3) mod 7)/7), day = floor((t_min+120)/1440) since 1970-01-01 (session key, 22:00 UTC roll)",
                   "nday": "log1p(number of M5 bars of this session before this one)",
                   "rv12_288/rv48_288": "log((std(diff(mid_c), n)+0.01*ATR)/(std(diff(mid_c), 288)+0.01*ATR)), pandas rolling std (ddof=1)",
                   "rv288": "log((std(diff(mid_c), 288)+0.01*ATR)/ATR)",
                   "atr_px": "log(ATR) - log(max(|mid_c|, 1))",
                   "atr_ratio": "ATR / rolling median of ATR over 2880 bars (min 576)",
                   "range/range3": "(mid_h-mid_l)/ATR; rolling mean of 3"},
               scaler=dict(mean=last_model["mean"], scale=last_model["scale"]), coefficients=last_model["coef"], intercept=last_model["b"],
               formula="z = intercept + sum_j coef[j]*(x[j]-mean[j])/scale[j]; p = 1/(1+exp(-z))",
               calibrator="identity (the LR sigmoid is the probability; no Platt/isotonic stage)",
               training_cutoff=last_model["cut"], applies_from=last_qs, training_rows=last_model["n"], training_base_rate=last_model["base"],
               refit="quarterly, expanding from data start; rows with session day < quarter start - 5 days; 30-min cadence, all hours, spread <= 0.2 R",
               alert_thresholds={f"{r}_per_week": last_thr[r] for r in RATES}, alert_rule=f"alert when p >= threshold and no alert in the previous {COOL} minutes; thresholds reset each quarter from the trailing {TRAIL} days of scores",
               drift_monitor=res["drift"]["band_from_2019_22"], code_sha256=CODE)
    json.dump(art, open(os.path.join(OUT, f"artifact_{TAG}.json"), "w"), indent=1, default=float)
    L = S["latest"]; Xl = X[L]
    zl = de.e2_lr_raw(last_model, Xl)
    zg = np.array([art["intercept"] + sum(art["coefficients"][j] * (x[j] - art["scaler"]["mean"][j]) / art["scaler"]["scale"][j] for j in range(12)) for x in Xl])
    assert np.allclose(zl, zg, atol=1e-10)
    fx = dict(instrument=inst, artifact=f"artifact_{TAG}.json", features=feats, tolerance=1e-9,
              cases=[dict(bar_open_utc=str(np.datetime64(int(B["t"][b]), "m")), x=[float(v) for v in Xl[k]], z=float(zl[k]), p=float(1 / (1 + np.exp(-zl[k]))))
                     for k, b in enumerate(L)])
    json.dump(fx, open(os.path.join(OUT, f"parity_{TAG}.json"), "w"), indent=1)
    res["secs"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(OUT, f"{TAG}.json"), "w"), indent=1, default=float)
    print("done", inst, "kx", kx, "rows", n, "secs", res["secs"], flush=True)


def register(amend=None):
    f = os.path.join(HERE, "prereg.json")
    if amend:
        reg = json.load(open(f))
        reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=amend, code_sha256=CODE))
        json.dump(reg, open(f, "w"), indent=1); print("amended"); return
    assert not os.path.exists(f), "prereg.json exists (use amend)"
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="alert7: declared replication of the T2 big-move alert model (lr_todvol) on XAG, NATGAS, SPX500, EUR/USD; WTI and XAU rerun as reference (queue item 7, retargeted)",
        before_registration="Read only: mw6/out/coverage.json (M1 coverage of all six instruments, 2018-01..2026-10-07/08) and the existing ablate4/fm2/risk8 results for WTI and XAU. No T2 label, feature, score or alert was computed on XAG, NATGAS, SPX500 or EUR/USD before this file.",
        declared="These are replication ATTEMPTS. Model, features, target, KX rule, population, learner and refit schedule are frozen from WTI/XAU work; nothing is tuned on the new instruments. Development evidence only; nothing is qualified (shadow under issue 313 decides). No entries, no R, no test ledger.",
        instruments=INSTS,
        target=f"T2: mid high/low over bars i+1..i+{N_FWD} reaches close_i +/- KX*ATR_i. KX chosen per instrument by the registered ablate4 rule (grid 3.0/4.5/6.0, 2018 07:00-20:30 UTC cadence base rate closest to 1/3), not fixed at 6; KX=6 is what the rule gave for WTI and XAU.",
        features=GROUPS["todvol"], learner="de_v2.e2_lr_fit: standardized L2 LR C=0.1, day weights 1/rows-per-session; p = sigmoid(raw), no separate calibrator",
        population="risk8 fit population: every M5 bar closing on :00/:30 UTC (all hours), base_active, spread <= 0.2 R, finite features and uncensored label. Primary evaluation on this all-hours set; secondary on the P3 subset (07:00-20:30 UTC).",
        schedules=dict(q="quarterly expanding refit from 2019-01-01 (fit rows: session day < quarter start - 5 days, from data start); used for AUC, calibration, alerts, drift, artifact",
                       q_tod="same schedule, time-of-day group only (5 features)", q_vol="same schedule, volatility group only (7 features)",
                       fixed2020="one fit, cutoff 2020-01-01 (2018-2019 data), applied 2020+", fixed2023="one fit, cutoff 2023-01-01 (= risk8 'fixed'), applied 2023+"),
        metrics=dict(auc="per calendar year 2020-2026, pooled dev 2020-22 and 2023+ (development window), day-cluster bootstrap 95% CI (300 reps); paired q_todvol - q_tod and - q_vol",
                     calibration="Brier vs base (oracle base of the window and training base), calibration-in-the-large (mean p - observed) by year, calibration slope/intercept, reliability by 0.1 bands with Wilson CIs and support (pooled windows)"),
        alerts=dict(rule=f"alert at a cadence row when p >= threshold and no alert in the previous {COOL} min (one horizon); cooldown carries across quarters",
                    thresholds=f"per quarter, from the current quarterly model's scores over the trailing {TRAIL} days (no labels): the threshold whose alert count is closest to {RATES} alerts/week",
                    precision="share of alerts with T2 = 1 at the alert row; compared with the window base rate",
                    recall="episodes = runs of T2 = 1 cadence rows <= 60 min apart; recalled if any alert falls on an episode row; also for MAJOR episodes (peak forward excursion in % of price >= the 90th percentile of 2018-2022 episode peaks)",
                    lead="minutes from alert to the first KX*ATR passage (alerts with T2 = 1), median",
                    ahead="fwd/(fwd+back): fwd = max excursion over the next 72 bars in its direction, back = move already made in that direction over the prior 72 bars (mid highs/lows); median over hit alerts and over all alerts"),
        crisis=dict(windows=CRISES, metrics="per alert rate: alerts, precision, recall (all/major), first-alert lag (days from window start), first major episode start and hours to the first alert inside it (None = missed), calm weeks (session-week range in % of price below the 2018-2022 median weekly range) false alerts per calm week and share of calm weeks with a false alert"),
        drift=dict(stats="rolling 20 and 60 sessions: calibration-in-the-large (mean p - y) and base-rate deviation (mean y - active model's training base)",
                   thresholds=f"{DRIFT_Q} quantiles of the daily rolling statistics over 2019-2022 OOS quarterly predictions (training data 2018-2022 only)",
                   report="share of sessions outside the band by year, first trigger in 2023+"),
        artifact="latest quarterly model per instrument: feature order, scaler, coefficients, intercept, identity calibrator, cutoff, thresholds, drift band, code hashes; parity fixture of the 40 latest scoreable cadence rows (x -> z, p), asserted against an explicit dot product",
        decision_rule="Replication on an instrument = pooled AUC CI lower bound > 0.60 in dev 2020-22 AND in 2023+, q_todvol >= q_tod (paired CI not below 0) in both windows, Brier below the training-base Brier in both windows, and |calibration-in-the-large| <= 0.05 in each year 2020-2026 for the quarterly model. Shadow recommendation also needs 2/week precision above the window base rate (Wilson lower bound) in both windows. Six instruments, no multiplicity correction; misses are reported.",
        budget=dict(instruments=6, models=5, populations=2, alert_rates=3, kx_rule=1, tuned_hyperparameters=0),
        code_sha256=CODE)
    json.dump(reg, open(f, "w"), indent=1)
    print("registered", reg["created"])


if __name__ == "__main__":
    if MODE == "register":
        register()
    elif MODE == "amend":
        register(amend=ARG)
    elif MODE == "check":
        check()
    elif MODE == "run":
        run(ARG)
