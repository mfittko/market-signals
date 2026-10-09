"""Evaluator v2: the registered E redesign variants (de_v2.E2_VARIANTS) on the audit v1 positive controls.

Same planted controls, calendar, D configuration, features, learners and seeds as audit/v1/controls.py (imported from
there: plant(), base(), supertrend without cache). Control calendar: data 2018-01..2019-12 before the test (E features
exist from about 2018-10), test 2020-01-01..2022-12-30; E-v2 windows as registered (crossfit: the quarterly blocks of
2018-2019 with >= 200 fit rows; split6: fit before 2019-07, pooled 2019-07..2019-12). Every record carries the evaluator version and code SHA-256.

  python controls_v2.py run dev|final N
"""
import os, sys, json, time
for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[_v] = "1"  # one thread per worker process (16 workers)
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
os.environ["ENGINE_TRIALS"] = os.path.join(OUT, "controls_v2_trials.jsonl")
ENGINE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ENGINE); sys.path.insert(0, os.path.join(ENGINE, "audit", "v1"))
import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score
import de_v2 as de
from labels_v2 import simulate, POLICY
from validate import day_of, year_start_day
import controls as c1  # audit v1 harness (plant, base, seeds, grid); its de patch is mirrored below

de.supertrend = c1.supertrend_nocache
INST, UNTIL, TEST0 = c1.INST, c1.UNTIL, c1.TEST0
CFG_X = c1.CFG_X
GRID, SEEDS = c1.GRID, c1.SEEDS
KS = (3, 1, 5)  # primary: 3 = verdicts issued in a campaign D-E look (D, E, E_novol); 1 and 5 are sensitivity only
LEARNERS = ("lr", "hgb", "oracle")
SELF = {f: __import__("hashlib").sha256(open(os.path.join(HERE, f), "rb").read()).hexdigest() for f in ("controls_v2.py",)}


def outcomes_lite(B):
    n = len(B["t"]); idx = np.arange(n)
    o = {s: simulate(B, idx, np.full(n, s), B["atr"], B["flip"], POLICY) for s in (1, -1)}
    return {False: o, True: o}


def hgb_fitter(B, Xa, fin, Xc, C):
    """audit v1 HGB comparator without its Platt step (chronological early stopping inside the fit rows)."""
    def fit(mask):
        X, y, w, day = Xc[mask], C["y"][mask], C["w"][mask], C["day"][mask]
        cut = np.quantile(day, 0.8); tr, va = day < cut - 5, day >= cut
        kw = dict(learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=100, l2_regularization=1.0, early_stopping=False, random_state=0)
        h = HistGradientBoostingClassifier(max_iter=300, **kw).fit(X[tr], y[tr], sample_weight=w[tr])
        pv = np.clip(np.array([p[:, 1] for p in h.staged_predict_proba(X[va])]), 1e-6, 1 - 1e-6)
        nit = int(np.argmin(-(y[va] * np.log(pv) + (1 - y[va]) * np.log(1 - pv)) @ w[va])) + 1
        h = HistGradientBoostingClassifier(max_iter=nit, **kw).fit(X, y, sample_weight=w)
        s = np.full(len(B["t"]), np.nan); s[fin] = h.decision_function(Xa[fin])
        return s
    return fit


def memo(f):
    cache = {}

    def g(mask):
        k = mask.tobytes()
        if k not in cache:
            cache[k] = f(mask)
        return cache[k]
    return g


def auc(y, s):
    m = np.isfinite(s)
    return float(roc_auc_score(y[m], s[m])) if m.any() and 0 < y[m].sum() < m.sum() else float("nan")


def realize(kind, mu, seed):
    t0 = time.time()
    m1p, obs = c1.plant(kind, mu, seed)
    B = de.build(INST, m1p)
    O = outcomes_lite(B)
    L = de.gate_layer(m1p)
    ys = year_start_day(int(TEST0[:4]))
    GS = de.gate_states(B, L, de.fit_gate(L, ys - de.EMB))
    hi_day = int(B["day"][-1]) + 1
    _, _, all_days = de.window_bars(B, ys, hi_day)
    years = (hi_day - ys) / 365.25
    te = lambda T: de.sel(T, T["day"] >= ys)
    out = dict(kind=kind, mu=mu, seed=seed, years=round(years, 3), evaluator=de.EVALUATOR_VERSION, code_sha256=de.CODE_SHA, harness_sha256=SELF)
    RD = de.run_d(B, O, GS, CFG_X)
    TD = te(de.trades(B, O, RD["entries"]))
    p_run_D = float(TD["runner"].sum() / max(1, TD["arm"].sum()))
    F = de.e_features(B, GS, RD["ep"]); F["c1"] = obs["c1"]; F["c2"] = obs["c2"]
    cols = de.BASEF + de.VOLF + ["c1", "c2"]
    C = de.candidates(B, O, RD, CFG_X[2])
    Xc = de.e_matrix(F, cols, C["i"]); ok = np.isfinite(Xc).all(1)
    Xa = np.column_stack([F[c] for c in cols]); fin = np.isfinite(Xa).all(1)
    tst = (C["day"] >= ys) & ok
    out["D"] = dict(trades=int(len(TD["i"])), meanR=float(TD["net"].mean()), p_runner=p_run_D)
    # economic value (oracle policy) and the qualification ceiling: does the oracle POLICY itself qualify?
    TO = te(de.trades(B, O, de.run_d(B, O, GS, CFG_X, extra=c1.ORACLE[kind](obs["c1"], obs["c2"]))["entries"]))
    vo, so = de.e2_verdicts(TO, TD, all_days, years, p_run_D, KS)
    out["econ"] = dict(trades=int(len(TO["i"])), meanR=float(TO["net"].mean()) if len(TO["i"]) else float("nan"),
                       dR_vs_D=float(TO["net"].mean() - TD["net"].mean()) if len(TO["i"]) else float("nan"),
                       verdict={str(k): v for k, v in vo.items()})
    fitters = dict(lr=memo(de.lr_fitter(B, F, cols, C)), hgb=memo(hgb_fitter(B, Xa, fin, Xc, C)),
                   oracle=lambda mask: obs["g"].astype(float))
    for name in LEARNERS:
        out[name] = {}
        for vn, spec in de.E2_VARIANTS.items():
            r = {}
            try:
                S = de.e2_select(spec, fitters[name], B, O, GS, CFG_X, C, ok, int(B["day"][0]), ys)
                r.update(cause=S["cause"] or "available", rows=S["rows"], cut=S["cut"] if np.isfinite(S["cut"]) else None,
                         cal={k: v for k, v in (S["cal"] or {}).items() if k in ("kind", "slope", "slope_ci")},
                         thr={k: v for k, v in (S.get("info") or {}).items() if k != "cause"})
                if S.get("sbar") is not None:
                    r["auc_test"] = auc(C["y"][tst], S["sbar"][C["i"][tst]])
                if not S["available"]:
                    r["verdict"] = {str(k): "abstain" for k in KS}
                else:
                    TE = te(de.trades(B, O, de.run_d(B, O, GS, CFG_X, extra=S["sbar"] >= S["cut"])["entries"]))
                    v, st = de.e2_verdicts(TE, TD, all_days, years, p_run_D, KS)
                    r.update(trades=int(len(TE["i"])), verdict={str(k): x for k, x in v.items()},
                             **{k: x for k, x in st.items() if k in ("meanR", "inc_vs_D", "tail", "p_runner")},
                             ci3=st.get("ci", {}).get(3), inc_ci3=st.get("inc_ci", {}).get(3))
            except Exception as ex:  # a learner failure is a result, not a crash of the grid
                r["verdict"] = {str(k): "error" for k in KS}; r["cause"] = "error"; r["error"] = repr(ex)
            out[name][vn] = r
    out["secs"] = round(time.time() - t0, 1)
    return out


def _job(a):
    try:
        return realize(*a)
    except Exception as ex:
        return dict(kind=a[0], mu=a[1], seed=a[2], fatal=repr(ex))


def run(which, nproc):
    from multiprocessing import get_context
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    assert reg["code_sha256"]["evaluator"] == de.CODE_SHA, "evaluator code changed after the preregistration (amend it first)"
    assert reg["code_sha256"]["controls_v2.py"] == SELF["controls_v2.py"], "control harness changed after the preregistration"
    path = os.path.join(OUT, f"controls_v2_{which}.jsonl")
    jobs = [(k, mu, s) for k, mus in GRID.items() for mu in mus for s in SEEDS[which]]
    done = {(r["kind"], r["mu"], r["seed"]) for r in map(json.loads, open(path))} if os.path.exists(path) else set()
    if which == "final" and done and len(done) >= len(jobs):
        sys.exit("final seeds already reported once")
    jobs = [j for j in jobs if j not in done]
    print(f"{len(jobs)} realizations ({len(done)} done), {nproc} processes, evaluator {de.CODE_SHA[:12]}", flush=True)
    c1.base()
    with get_context("fork").Pool(nproc) as pool, open(path, "a") as f:
        for r in pool.imap_unordered(_job, jobs):
            f.write(json.dumps(r, default=float) + "\n"); f.flush()
            print(r["kind"], r["mu"], r["seed"], r.get("econ", {}).get("meanR"),
                  {n: {v: r.get(n, {}).get(v, {}).get("verdict", {}).get("3") for v in de.E2_VARIANTS} for n in LEARNERS},
                  r.get("secs"), r.get("fatal", ""), flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "probe":
        print(json.dumps(realize(sys.argv[2], float(sys.argv[3]), int(sys.argv[4])), default=float, indent=1))
    elif sys.argv[1] == "run":
        run(sys.argv[2], int(sys.argv[3]))
