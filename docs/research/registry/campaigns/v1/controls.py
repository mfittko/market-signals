"""Evaluator audit v1, item 1: end-to-end positive controls and power study (development diagnostic, synthetic data).

Base paths: real WTICO/USD M1 bid/ask, 2018-01-01..2022-12-30 only (no 2023+ data is read). A planted drift is added to
bid and ask together (spread unchanged), then the unmodified D-E pipeline of de.py runs on the planted bars:
production supertrend (flips.mjs), gate model, D replay (candidate generation), E features, 308 labels, L2 logistic fit,
Platt calibration on a later window, threshold p* on a later window, bid/ask fills, Bonferroni qualification rule.

Control calendar (mirrors the frozen procedure, shifted 3 years back):
  fit  2018-01..2019-06 (purged), calibrate 2019 Q3, threshold 2019 Q4, "test" 2020-01-01..2022-12-30 (3 years).
Planted mechanism (hourly blocks, causal): each clock hour h has observables c1_h, c2_h ~ N(0,1) and a hidden u_h.
  They are revealed at the close of the hour's first M5 bar; the drift acts on the hour's remaining 11 M5 bars at a rate
  of  mu * ATR(original M5) * trend(original M5) * g_h  per bar, spread evenly over each bar's M1 minutes.
  linear       g = c1                      (observable, additive)
  interaction  g = sign(c1) * sign(c2)     (no individual linear effect of c1 or c2)
  subset       g = 1[c1 > 1.2816]          (10% of hours, observable)
  null_hidden  g = u (unobserved), c1/c2 are pure noise (paths vary by seed, no observable information)
  null         mu = 0 (real path), c1/c2 pure noise
E sees BASEF + VOLF + [c1, c2] (the observables are exposed as ordinary as-of features).
Learners: the frozen E (de.e_fit: standardized L2 LR, C=0.1, episode weights, Platt on the cal window) and an
HistGradientBoostingClassifier comparator (chronological early stopping inside the fit window, same Platt step).

  python controls.py probe              timing and economic value of a few strengths (control-development seeds)
  python controls.py run dev|final N    run the registered grid with N worker processes
"""
import os, sys, json, time, tempfile, subprocess, shutil
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
os.environ["ENGINE_TRIALS"] = os.path.join(OUT, "controls_trials.jsonl")  # never the campaign trials.jsonl
ENGINE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ENGINE)
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
import de
from bars import load_m1
from labels import simulate, POLICY
from validate import day_of, year_start_day, trial_count

INST = "WTICO/USD"
UNTIL = "2023-01-01"
TEST0, Q3, Q4 = "2020-01-01", "2019-07-01", "2019-10-01"
K_BONF = 5  # the campaign's Bonferroni family per instrument (5 frozen variants)
CFG_X = (("none", None), "h1", 12)    # the XAU frozen D, applied to WTI paths: a realistic E population
CFG_W = (("fired", 0.9), "brk", 48)   # the WTI frozen D: support check only
REGISTRY = os.path.join(HERE, "controls_registry_{}.json")
GRID = {"null": [0.0], "null_hidden": [0.16], "linear": [0.02, 0.04, 0.065, 0.1, 0.16, 0.25],
        "interaction": [0.02, 0.04, 0.065, 0.1, 0.16, 0.25],
        "subset": [0.04, 0.065, 0.1, 0.16, 0.25]}
SEEDS = {"dev": list(range(1001, 1004)), "final": list(range(2001, 2041))}
ORACLE = {"linear": lambda c1, c2: c1 > 0.5, "interaction": lambda c1, c2: c1 * c2 > 0, "subset": lambda c1, c2: c1 > 1.2816,
          "null": lambda c1, c2: c1 > 0.5, "null_hidden": lambda c1, c2: c1 > 0.5}
TMP = os.path.join(tempfile.gettempdir(), "ms_audit_st")


def supertrend_nocache(inst, G):
    """Same production supertrend as de.supertrend, but in a private temp dir without the cache (thousands of variants)."""
    os.makedirs(TMP, exist_ok=True)
    d = tempfile.mkdtemp(dir=TMP)
    try:
        pi, po = os.path.join(d, "in.csv"), os.path.join(d, "out.csv")
        pd.DataFrame({"time": G["t"], "open": G["mid_o"], "high": G["mid_h"], "low": G["mid_l"], "close": G["mid_c"]}).to_csv(pi, index=False)
        subprocess.run(["node", os.path.join(ENGINE, "flips.mjs"), pi, po], check=True, capture_output=True)
        fl = pd.read_csv(po)
        return {k: fl[k].to_numpy(float) for k in ("trend", "flip", "atr", "st")}
    finally:
        shutil.rmtree(d, ignore_errors=True)


de.supertrend = supertrend_nocache


def outcomes_lite(B):
    """de/ladder outcomes() without the optimistic pass (not used by the verdict); O[True] aliases O[False]."""
    n = len(B["t"]); idx = np.arange(n)
    o = {s: simulate(B, idx, np.full(n, s), B["atr"], B["flip"], POLICY) for s in (1, -1)}
    return {False: o, True: o}


_BASE = {}


def base():
    if not _BASE:
        m1 = load_m1(INST, UNTIL)
        B0 = de.build(INST, m1)
        b5 = m1["t"] // 5
        _, first = np.unique(b5, return_index=True)
        hour = B0["t"] // 60
        _, hfirst, hinv = np.unique(hour, return_index=True, return_inverse=True)
        _BASE.update(m1=m1, B0=B0, first=first, hinv=hinv, hfirst=hfirst, nh=len(hfirst),
                     first_in_hour=np.isin(np.arange(len(B0["t"])), hfirst))
    return _BASE


def plant(kind, mu, seed):
    """Planted M1 bid/ask copy plus per-M5-bar observables (c1, c2) and the true g per bar."""
    S = base(); m1, B0 = S["m1"], S["B0"]
    rng = np.random.default_rng(seed)
    c1h, c2h, uh = rng.standard_normal(S["nh"]), rng.standard_normal(S["nh"]), rng.standard_normal(S["nh"])
    g = {"linear": c1h, "interaction": np.sign(c1h) * np.sign(c2h), "subset": (c1h > 1.2816).astype(float),
         "null_hidden": uh, "null": np.zeros(S["nh"])}[kind]
    gb = g[S["hinv"]]
    atr0 = np.nan_to_num(B0["atr"]); tr0 = B0["trend"].astype(float)
    rate5 = mu * atr0 * tr0 * gb * (~S["first_in_hour"])  # drift during bar k (0 on the hour's first bar: not yet revealed)
    cnt = np.diff(np.r_[S["first"], len(m1["t"])])
    per_min = np.repeat(rate5 / cnt, cnt)  # spread evenly over the bar's M1 rows
    off_end = np.cumsum(per_min); off_start = off_end - per_min
    m1p = dict(m1)
    for s in ("bid", "ask"):
        m1p[s + "_o"] = m1[s + "_o"] + off_start
        m1p[s + "_c"] = m1[s + "_c"] + off_end
        m1p[s + "_h"] = m1[s + "_h"] + np.maximum(off_start, off_end)
        m1p[s + "_l"] = m1[s + "_l"] + np.minimum(off_start, off_end)
    obs = dict(c1=c1h[S["hinv"]], c2=c2h[S["hinv"]], g=gb)
    return m1p, obs


# ------------------------------------------------------------------ learners
def lr_fit(X, y, w, Xc, yc):
    return dict(kind="lr", **de.e_fit(X, y, w, Xc, yc))


def lr_raw(M, X):
    return (X - np.array(M["mean"])) / np.array(M["scale"]) @ np.array(M["coef"]) + M["b"]


def hgb_fit(X, y, w, Xc, yc, day):
    """HistGradientBoosting with chronological early stopping: train on the earlier 80% of fit days, choose the
    iteration count on the later 20% (5-day embargo), refit on the whole fit window; Platt on the cal window."""
    cut = np.quantile(day, 0.8)
    tr, va = day < cut - 5, day >= cut
    kw = dict(learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=100, l2_regularization=1.0, early_stopping=False, random_state=0)
    h = HistGradientBoostingClassifier(max_iter=300, **kw).fit(X[tr], y[tr], sample_weight=w[tr])
    pv = np.clip(np.array([p[:, 1] for p in h.staged_predict_proba(X[va])]), 1e-6, 1 - 1e-6)
    ll = -(y[va] * np.log(pv) + (1 - y[va]) * np.log(1 - pv)) @ w[va]
    nit = int(np.argmin(ll)) + 1
    h = HistGradientBoostingClassifier(max_iter=nit, **kw).fit(X, y, sample_weight=w)
    assert list(h.classes_) == [0, 1]
    z = h.decision_function(Xc)
    pl = LogisticRegression(C=1e6, max_iter=1000).fit(z[:, None], yc)
    return dict(kind="hgb", model=h, n_iter=nit, platt=[float(pl.coef_[0][0]), float(pl.intercept_[0])])


def raw_score(M, X):
    return lr_raw(M, X) if M["kind"] == "lr" else M["model"].decision_function(X)


def cal_score(M, X):
    return 1 / (1 + np.exp(-(M["platt"][0] * raw_score(M, X) + M["platt"][1])))


def auc(y, s):
    return float(roc_auc_score(y, s)) if 0 < y.sum() < len(y) else float("nan")


# ------------------------------------------------------------------ one realization
def realize(kind, mu, seed, learners=("lr", "hgb", "oracle")):
    t0 = time.time()
    m1p, obs = plant(kind, mu, seed)
    B = de.build(INST, m1p)
    O = outcomes_lite(B)
    L = de.gate_layer(m1p)
    ys = year_start_day(int(TEST0[:4]))
    GM = de.fit_gate(L, ys - de.EMB)
    GS = de.gate_states(B, L, GM)
    q3, q4 = (int(day_of(np.datetime64(d, "m").astype(np.int64))) for d in (Q3, Q4))
    hi_day = int(B["day"][-1]) + 1
    lo_i, hi_i, all_days = de.window_bars(B, ys, hi_day)
    years = (hi_day - ys) / 365.25
    te = lambda T: de.sel(T, T["day"] >= ys)
    out = dict(kind=kind, mu=mu, seed=seed, years=round(years, 3))
    # support of the WTI frozen D configuration (E available only with >= 200 fit and >= 100 cal rows)
    RW = de.run_d(B, O, GS, CFG_W)
    CW = de.candidates(B, O, RW, CFG_W[2])
    fW, cW, tW = de.e_windows(CW, int(B["day"][0]), q3, q4, ys)
    out["cfgW"] = dict(fit=int(fW.sum()), cal=int(cW.sum()), thr=int(tW.sum()), test_trades=int((te(de.trades(B, O, RW["entries"]))["i"]).size),
                       e_available=bool(fW.sum() >= 200 and cW.sum() >= 100))
    cfg = CFG_X
    RD = de.run_d(B, O, GS, cfg)
    TD = te(de.trades(B, O, RD["entries"]))
    F = de.e_features(B, GS, RD["ep"]); F["c1"] = obs["c1"]; F["c2"] = obs["c2"]
    cols = de.BASEF + de.VOLF + ["c1", "c2"]
    C = de.candidates(B, O, RD, cfg[2])
    fit, cal, thr = de.e_windows(C, int(B["day"][0]), q3, q4, ys)
    Xc = de.e_matrix(F, cols, C["i"]); ok = np.isfinite(Xc).all(1)
    tst = (C["day"] >= ys) & ok
    out.update(rows=dict(fit=int((fit & ok).sum()), cal=int((cal & ok).sum()), thr=int((thr & ok).sum()), test=int(tst.sum()),
                         test_episodes=int(len(np.unique(C["ep"][tst])))),
               D=dict(trades=int(len(TD["i"])), meanR=float(TD["net"].mean()), p_runner=float(TD["runner"].sum() / max(1, TD["arm"].sum()))))
    # economic value of the planted effect under the same policy, costs and window: D restricted to oracle-flagged bars
    orc = ORACLE[kind](obs["c1"], obs["c2"])
    TO = te(de.trades(B, O, de.run_d(B, O, GS, cfg, extra=orc)["entries"]))
    out["econ"] = dict(trades=int(len(TO["i"])), meanR=float(TO["net"].mean()) if len(TO["i"]) else float("nan"),
                         dR_vs_D=float(TO["net"].mean() - TD["net"].mean()) if len(TO["i"]) else float("nan"))
    # label-level planted effect on the E population (test rows): arm rate when g > 0 vs g <= 0
    gC = obs["g"][C["i"][tst]] * 1.0
    yC = C["y"][tst]
    out["label_gap"] = float(yC[gC > 0].mean() - yC[gC <= 0].mean()) if (gC > 0).any() and (gC <= 0).any() else float("nan")
    Xa = np.column_stack([F[c] for c in cols]); fin = np.isfinite(Xa).all(1)
    for name in learners:
        r = dict()
        try:
            if name == "lr":
                M = lr_fit(Xc[fit & ok], C["y"][fit & ok], C["w"][fit & ok], Xc[cal & ok], C["y"][cal & ok])
            elif name == "hgb":
                M = hgb_fit(Xc[fit & ok], C["y"][fit & ok], C["w"][fit & ok], Xc[cal & ok], C["y"][cal & ok], C["day"][fit & ok])
                r["n_iter"] = M["n_iter"]
            if name == "oracle":  # the true planted driver g as the raw score; same Platt, threshold and qualification
                rawbar = obs["g"].astype(float)
                pl = LogisticRegression(C=1e6, max_iter=1000).fit(rawbar[C["i"][cal & ok]][:, None], C["y"][cal & ok])
                M = dict(kind="oracle", platt=[float(pl.coef_[0][0]), float(pl.intercept_[0])])
            else:
                rawbar = np.full(len(B["t"]), np.nan); rawbar[fin] = raw_score(M, Xa[fin])
            pbar = np.full(len(B["t"]), -1.0); pbar[fin] = 1 / (1 + np.exp(-(M["platt"][0] * rawbar[fin] + M["platt"][1])))
            r["platt_slope"] = M["platt"][0]
            r["auc_raw_cal"] = auc(C["y"][cal & ok], rawbar[C["i"][cal & ok]])
            r["auc_raw_test"] = auc(C["y"][tst], rawbar[C["i"][tst]])
            r["auc_cal_test"] = auc(C["y"][tst], pbar[C["i"][tst]])
            pstar, best = de.choose_p(B, O, GS, cfg, pbar, q4, ys, {"inst": "CONTROL", "kind": kind, "mu": mu, "seed": seed, "e": name})
            r["p_star"] = None if not np.isfinite(pstar) else pstar
            r["thr_best"] = [None if not np.isfinite(best[0]) else best[0], None if not np.isfinite(best[1]) else best[1], best[2]]
            # diagnostic risk-coverage curve on the control test window (the frozen rule does not see it)
            r["curve"] = []
            for pq in de.PGRID:
                Tq = te(de.trades(B, O, de.run_d(B, O, GS, cfg, extra=pbar >= pq)["entries"]))
                r["curve"].append([pq, int(len(Tq["i"])), float(Tq["net"].mean()) if len(Tq["i"]) else None])
            TE = te(de.trades(B, O, de.run_d(B, O, GS, cfg, extra=pbar >= pstar)["entries"]))
            r["trades"] = int(len(TE["i"]))
            if len(TE["i"]) >= 2:
                tail = float((TE["net"] < -1.5).mean()); prun = float(TE["runner"].sum() / max(1, TE["arm"].sum()))
                b = de.boot_mean(TE, all_days, K_BONF)[1]
                inc = de.diff_ci(TE, TD, all_days, K_BONF)
                r.update(meanR=float(TE["net"].mean()), bonf_ci=b, inc_vs_D=inc[0], inc_bonf=inc[2], tail=tail, p_runner=prun,
                         verdict=de.verdict(b, inc[2], tail, prun, out["D"]["p_runner"], len(TE["i"]), years))
            else:
                r["verdict"] = "abstain"
                r["abstain_cause"] = "threshold window mean R <= 0 at every p" if best[2] >= de.MIN_THR_TRADES else "threshold window support < 30 at every p"
        except Exception as ex:  # a learner failure is a result, not a crash of the whole grid
            r["verdict"] = "error"; r["error"] = repr(ex)
        out[name] = r
    out["secs"] = round(time.time() - t0, 1)
    return out


def _job(a):
    try:
        return realize(*a)
    except Exception as ex:
        return dict(kind=a[0], mu=a[1], seed=a[2], fatal=repr(ex))


def run(which, nproc):
    from multiprocessing import get_context
    reg = dict(created=time.strftime("%Y-%m-%dT%H:%M:%S%z"), design=__doc__, grid=GRID, seeds=SEEDS, cfg=[str(CFG_X), str(CFG_W)],
               calendar=dict(fit_until=Q3, cal=[Q3, Q4], thr=[Q4, TEST0], test=[TEST0, UNTIL]), k_bonf=K_BONF, mue=de.MUE)
    regf = REGISTRY.format(which)
    if not os.path.exists(regf):
        json.dump(reg, open(regf, "w"), indent=1)
    reg0 = json.load(open(regf))
    assert reg0["grid"] == json.loads(json.dumps(GRID)) and reg0["seeds"] == SEEDS, "grid or seeds changed after registration"
    jobs = [(k, mu, s) for k, mus in GRID.items() for mu in mus for s in SEEDS[which]]
    path = os.path.join(OUT, f"controls_{which}.jsonl")
    done = set()
    if os.path.exists(path):
        done = {(r["kind"], r["mu"], r["seed"]) for r in map(json.loads, open(path))}
    jobs = [j for j in jobs if j not in done]
    print(f"{len(jobs)} realizations to run ({len(done)} already done) with {nproc} processes", flush=True)
    base()
    with get_context("fork").Pool(nproc) as pool, open(path, "a") as f:
        for r in pool.imap_unordered(_job, jobs):
            f.write(json.dumps(r, default=float) + "\n"); f.flush()
            print(r["kind"], r["mu"], r["seed"], r.get("lr", {}).get("verdict"), r.get("hgb", {}).get("verdict"),
                  r.get("econ", {}).get("meanR"), r.get("oracle", {}).get("verdict"), r.get("secs"), r.get("fatal", ""), flush=True)


def probe():
    t = time.time(); base(); print("base", round(time.time() - t, 1), "s", flush=True)
    for kind, mu in (("null", 0.0), ("linear", 0.04)):
        r = realize(kind, mu, 1001)
        print(json.dumps(r, default=float), flush=True)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "probe":
        probe()
    elif cmd == "run":
        run(sys.argv[2], int(sys.argv[3]))
