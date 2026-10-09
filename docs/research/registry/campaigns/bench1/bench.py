"""Representation benchmark bench1 (#310 item 1): learners and representations on the frozen D population, scored by
evaluator v2 (de_v2.py, labels_v2.py, selected E stage V4 = audit/v2/selected.json) without any change to it.

Every learner is a `fitter(mask)` for de_v2.e2_select: it fits on the masked candidate rows (inside the permitted
training period) and returns a per-bar raw score. Every learned scaler, transform and encoder is fitted inside fitter
from the masked rows only. At inference a representation reads only the trailing window that ends at the decision bar.

Learners (identical candidates, labels, costs, windows and V4 stage):
  lr_base    frozen E learner (standardized L2 LR, C=0.1, episode weights) on the existing E features (reproduction)
  lr_eng     the same LR on the compact engineered set ENG
  hgb_eng    HistGradientBoostingClassifier on ENG (iteration count by chronological validation, no internal split)
  mr_lr      MiniRocket (aeon) on the trailing side-signed ATR-normalized return window + CTX, LR head (C by chrono val)
  ts_lr      TS2Vec (official code) embedding of the trailing multivariate window + CTX, LR head
  tscomb_lr  TS2Vec embedding + ENG, LR head
  tscomb_hgb TS2Vec embedding + ENG, HGB head
  oracle     (controls only) the planted driver g
In the planted controls every learner also receives the observables c1, c2 (the controls expose them as as-of context).

  python bench.py check                      causality and leakage self-checks
  python bench.py probe KIND MU SEED         one control realization (timing)
  python bench.py controls dev|final N       planted-drift controls (V4 only), N worker processes
  python bench.py real POP                   real WTI: purged walk-forward 2020-2022 + 2023..newest development window
"""
import os, sys, json, time, hashlib
NT = os.environ.get("BENCH_THREADS", "1")
for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS"):
    os.environ[_v] = NT
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
ENGINE = os.path.dirname(os.path.dirname(HERE))
MODE = sys.argv[1] if len(sys.argv) > 1 else ""
if MODE in ("controls", "probe", "check"):
    os.environ["ENGINE_TRIALS"] = os.path.join(OUT, "controls_trials.jsonl")  # control trials never go to the campaign log
sys.path.insert(0, ENGINE); sys.path.insert(1, os.path.join(ENGINE, "audit", "v1")); sys.path.append(os.path.join(HERE, "ts2vec_src"))
import numpy as np
import pandas as pd
import torch
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
import de_v2 as de
from labels_v2 import simulate, POLICY
from validate import year_start_day, log_trial

torch.set_num_threads(int(NT))
EXP = "bench1"
L_SEQ = 64                       # trailing window length (M5 bars) for MiniRocket and TS2Vec; one lookback, fixed
C_GRID = (1e-4, 1e-3, 1e-2, 1e-1)  # LR head penalty for the high-dimensional representations, chosen by chronological validation
CHUNK = 4096
HGB_KW = dict(learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=100, l2_regularization=1.0, early_stopping=False, random_state=0)
HGB_MAX_ITER = 300
MR_KW = dict(n_kernels=10_000, max_dilations_per_kernel=32, random_state=0)
TS_KW = dict(output_dims=320, hidden_dims=64, depth=10, lr=0.001, batch_size=16)  # official defaults
TS_SEED = 0
LEARNERS = ("lr_base", "lr_eng", "hgb_eng", "mr_lr", "ts_lr", "tscomb_lr", "tscomb_hgb")
COSTS = (0.0, 0.02, 0.05, 0.10)  # extra cost per trade in R (cost sensitivity)
KS = (3, 1, 5)
SPEC_NAME, SPEC = de.e2_spec()
assert SPEC_NAME == "V4"
CODE = {f: hashlib.sha256(open(os.path.join(HERE, f), "rb").read()).hexdigest() for f in ("bench.py",)}
CODE["ts2vec_src"] = "b0088e14a99706c05451316dc6db8d3da9351163"


# ------------------------------------------------------------------ representations (per bar, causal)
def _lag(x, k):
    return np.r_[np.full(k, np.nan), x[:-k]]


def eng_bars(B):
    """Compact engineered set ENG, per bar, side = the bar's M5 trend (the candidate side). Uses data <= bar only."""
    s = B["trend"].astype(float); a = B["atr"]; c, o, h, l = B["mid_c"], B["mid_o"], B["mid_h"], B["mid_l"]
    F = {}
    for k in (1, 3, 6, 12, 36, 72):  # normalized lagged returns
        F[f"r{k}"] = s * (c - _lag(c, k)) / a
    up, dn = (h - np.maximum(o, c)) / a, (np.minimum(o, c) - l) / a  # candle structure
    F["body"] = s * (c - o) / a; F["wick_with"] = np.where(s > 0, up, dn); F["wick_against"] = np.where(s > 0, dn, up)
    rng = (h - l) / a; F["range"] = rng; F["range3"] = pd.Series(rng).rolling(3).mean().to_numpy()
    lr = np.r_[np.nan, np.diff(c)]  # absolute changes: WTI traded below zero in April 2020, so no log prices
    rv = {n: pd.Series(lr).rolling(n).std().to_numpy() for n in (12, 48, 288)}  # multi-scale realized volatility
    with np.errstate(divide="ignore", invalid="ignore"):
        e = 0.01 * a  # floor: flat stretches give zero realized vol
        F["rv12_288"] = np.log((rv[12] + e) / (rv[288] + e)); F["rv48_288"] = np.log((rv[48] + e) / (rv[288] + e)); F["rv288"] = np.log((rv[288] + e) / a)
        F["atr_px"] = np.log(a) - np.log(np.maximum(np.abs(c), 1.0))  # scale level; abs and floor for negative prices
    F["atr_ratio"] = B["atr_ratio"]
    F["spr"] = B["spr"]; F["spr_chg"] = B["spr"] - pd.Series(B["spr"]).rolling(12).mean().to_numpy()
    v = pd.Series(np.log1p(B["volume"])); v12 = v.rolling(12).mean(); tod = pd.Series(B["tod"])
    for name, x in (("act1", v), ("act12", v12)):  # tick activity vs the same time of day over the prior 20 sessions
        med = x.groupby(tod).transform(lambda z: z.rolling(20, min_periods=10).median().shift(1))
        F[name] = (x - med).to_numpy()
    ang = 2 * np.pi * (B["tod"] + 5) / 1440; wd = 2 * np.pi * ((B["day"] + 3) % 7) / 7
    F["tod_s"], F["tod_c"], F["dow_s"], F["dow_c"] = np.sin(ang), np.cos(ang), np.sin(wd), np.cos(wd)
    F["nday"] = np.log1p(B["nday"]); F["daymv"] = s * (c - B["dopen"]) / a
    with np.errstate(divide="ignore", invalid="ignore"):
        F["dpos"] = s * ((c - B["dlo"]) / (B["dhi"] - B["dlo"]) - 0.5)
    F["dpos"] = np.where(np.isfinite(F["dpos"]), F["dpos"], 0.0)
    return F


ENG = ["r1", "r3", "r6", "r12", "r36", "r72", "body", "wick_with", "wick_against", "range", "range3", "rv12_288", "rv48_288",
       "rv288", "atr_px", "atr_ratio", "spr", "spr_chg", "act1", "act12", "tod_s", "tod_c", "dow_s", "dow_c", "nday", "daymv", "dpos"]
CTX = ["spr", "atr_ratio", "atr_px", "tod_s", "tod_c"]  # scale/spread/session context kept beside the sequence representations


def windows(B, i, L=L_SEQ):
    """Trailing windows ending at decision bar i (bars i-L+1..i), side-signed and normalized by the ATR at bar i.
    Channels: return, range, spread, activity (log volume minus its window mean). Returns (n, L, 4); nan if i < L."""
    i = np.asarray(i, np.int64)
    J = np.clip(i[:, None] + np.arange(-L + 1, 1)[None, :], 1, None)
    s = B["trend"][i].astype(float)[:, None]; a = B["atr"][i][:, None]
    ret = s * (B["mid_c"][J] - B["mid_c"][J - 1]) / a
    rng = (B["mid_h"][J] - B["mid_l"][J]) / a
    spr = (B["ask_c"][J] - B["bid_c"][J]) / a
    lv = np.log1p(B["volume"][J]); act = lv - lv.mean(1, keepdims=True)
    W = np.stack([ret, rng, spr, act], -1)
    W[i < L] = np.nan
    return W


# ------------------------------------------------------------------ learners
def chrono(day):
    """Chronological validation split inside the fit rows: earlier 80% of days (5-day embargo) vs the later 20%."""
    cut = np.quantile(day, 0.8)
    return day < cut - 5, day >= cut


def wll(y, p, w):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-(w * (y * np.log(p) + (1 - y) * np.log(1 - p))).sum() / w.sum())


def lr_head(X, y, w, day, grid, log):
    mu, sd = X.mean(0), X.std(0) + 1e-12; Z = (X - mu) / sd
    C = grid[0]
    if len(grid) > 1:
        tr, va = chrono(day)
        ll = []
        for c in grid:
            m = LogisticRegression(C=c, max_iter=3000).fit(Z[tr], y[tr], sample_weight=w[tr])
            ll.append(wll(y[va], m.predict_proba(Z[va])[:, 1], w[va]))
        C = grid[int(np.argmin(ll))]; log["val_ll"] = ll
    m = LogisticRegression(C=C, max_iter=3000).fit(Z, y, sample_weight=w)
    log["C"] = C
    return lambda Xn: (Xn - mu) / sd @ m.coef_[0] + m.intercept_[0]


def hgb_head(X, y, w, day, log):
    tr, va = chrono(day)
    h = HistGradientBoostingClassifier(max_iter=HGB_MAX_ITER, **HGB_KW).fit(X[tr], y[tr], sample_weight=w[tr])
    pv = np.clip(np.array([p[:, 1] for p in h.staged_predict_proba(X[va])]), 1e-6, 1 - 1e-6)
    nit = int(np.argmin(-(y[va] * np.log(pv) + (1 - y[va]) * np.log(1 - pv)) @ w[va])) + 1
    h = HistGradientBoostingClassifier(max_iter=nit, **HGB_KW).fit(X, y, sample_weight=w)
    assert list(h.classes_) == [0, 1]
    log["n_iter"] = nit
    return h.decision_function


def ts2vec_encoder(Wtr, seed=TS_SEED):
    """Official TS2Vec, CPU, defaults; channel scaler and encoder fitted on the training windows only."""
    from ts2vec import TS2Vec
    mu = np.nanmean(Wtr.reshape(-1, Wtr.shape[-1]), 0); sd = np.nanstd(Wtr.reshape(-1, Wtr.shape[-1]), 0) + 1e-9
    torch.manual_seed(seed); np.random.seed(seed)
    m = TS2Vec(input_dims=Wtr.shape[-1], device="cpu", **TS_KW)
    t0 = time.time(); loss = m.fit(((Wtr - mu) / sd).astype(np.float32))
    enc = lambda W: m.encode(((W - mu) / sd).astype(np.float32), encoding_window="full_series", batch_size=512)
    return enc, dict(train_windows=int(len(Wtr)), n_iters=int(m.n_iters), secs=round(time.time() - t0, 1),
                     last_loss=float(loss[-1]) if loss else None)


class Bench:
    """Representations for one candidate population C (rows C['i']) and memoized fitters keyed by the fit mask."""

    def __init__(self, B, F, C, extra=None):
        self.B, self.C, self.n = B, C, len(B["t"])
        Eb = eng_bars(B)
        base_cols = de.BASEF + de.VOLF + (list(extra) if extra else [])
        ex = {k: v for k, v in (extra or {}).items()}
        col = lambda k: (ex[k] if k in ex else F[k] if k in F else Eb[k])
        i = C["i"]
        self.X = {"base": np.column_stack([col(k)[i] for k in base_cols]),
                  "eng": np.column_stack([col(k)[i] for k in ENG + list(ex)]),
                  "ctx": np.column_stack([col(k)[i] for k in CTX + list(ex)])}
        self.W = windows(B, i)
        self.ok = (np.isfinite(self.X["base"]).all(1) & np.isfinite(self.X["eng"]).all(1) & np.isfinite(self.X["ctx"]).all(1)
                   & np.isfinite(self.W).all((1, 2)))
        self.cache, self.logs = {}, {}

    def _bar(self, sc):
        out = np.full(self.n, np.nan); out[self.C["i"][self.ok]] = sc[self.ok]
        return out

    def _seq(self, kind, mask):
        """MiniRocket features or TS2Vec embedding of every ok candidate row (float32, chunked), transform fitted on the
        mask rows only."""
        key = (kind, mask.tobytes())
        if key not in self.cache:
            fitm = mask & self.ok
            okix = np.where(self.ok)[0]
            t0 = time.time()
            if kind == "mr":
                from aeon.transformations.collection.convolution_based import MiniRocket
                x = np.ascontiguousarray(self.W[:, :, 0][:, None, :])
                mr = MiniRocket(**MR_KW).fit(x[fitm])
                tf = lambda ix: np.asarray(mr.transform(x[ix]), np.float32)
                info = {}
            else:
                enc, info = ts2vec_encoder(self.W[fitm])
                tf = lambda ix: np.asarray(enc(self.W[ix]), np.float32)
            first = tf(okix[:CHUNK])
            Z = np.zeros((len(self.ok), first.shape[1]), np.float32); Z[okix[:CHUNK]] = first
            for a in range(CHUNK, len(okix), CHUNK):
                Z[okix[a:a + CHUNK]] = tf(okix[a:a + CHUNK])
            info = dict(info, features=int(Z.shape[1]), transform_secs=round(time.time() - t0, 1))
            self.cache[key] = (Z, info)
        return self.cache[key]

    def fitter(self, name):
        C = self.C

        def fit(mask):
            key = (name, mask.tobytes())
            if key in self.cache:
                return self.cache[key]
            m = mask & self.ok
            y, w, day = C["y"][m], C["w"][m], C["day"][m]
            log = dict(fit_rows=int(m.sum()), fit_last_day=int(C["exit_day"][m].max()) if m.any() else None)
            if name == "lr_base":
                M = de.e2_lr_fit(self.X["base"][m], y, w); f = lambda X: de.e2_lr_raw(M, X); rows = lambda ix: self.X["base"][ix]
            elif name == "lr_eng":
                M = de.e2_lr_fit(self.X["eng"][m], y, w); f = lambda X: de.e2_lr_raw(M, X); rows = lambda ix: self.X["eng"][ix]
            elif name == "hgb_eng":
                rows = lambda ix: self.X["eng"][ix]; f = hgb_head(rows(m), y, w, day, log)
            else:
                Z, info = self._seq("mr" if name == "mr_lr" else "ts", mask)
                log["seq"] = info
                side = self.X["ctx"] if name in ("mr_lr", "ts_lr") else self.X["eng"]
                rows = lambda ix: np.hstack([Z[ix], side[ix].astype(np.float32)])
                f = (hgb_head(rows(m), y, w, day, log) if name == "tscomb_hgb" else lr_head(rows(m), y, w, day, C_GRID, log))
            sc = np.full(len(self.ok), np.nan)
            okix = np.where(self.ok)[0]
            for a in range(0, len(okix), CHUNK):
                sc[okix[a:a + CHUNK]] = f(rows(okix[a:a + CHUNK]))
            self.logs[name] = log
            self.cache[key] = self._bar(sc)
            return self.cache[key]
        return fit


# ------------------------------------------------------------------ one V4 evaluation of one learner
def auc(y, s):
    m = np.isfinite(s)
    return float(roc_auc_score(y[m], s[m])) if m.sum() > 10 and 0 < y[m].sum() < m.sum() else float("nan")


def v4_fit_mask(C, ok, a_day, test_day):
    lo = de.month_back(test_day, de.E2_POOL_MONTHS)
    return (C["exit_day"] < lo - de.EMB) & (C["day"] >= a_day) & ok, (C["day"] >= lo) & (C["exit_day"] < test_day - de.EMB) & ok, lo


def evaluate(fitter, B, O, GS, cfg, C, ok, a_day, test_day, test_rows, te, TD, all_days, years, verdict=True, diag=True):
    """Registered V4 stage (de_v2.e2_select) + diagnostics that do not change it: unconditional raw test AUC of the test
    model, the calibrator on the test rows, and the test risk-vs-coverage curve at the pooled-window quantile cuts."""
    r = {}
    S = de.e2_select(SPEC, fitter, B, O, GS, cfg, C, ok, a_day, test_day)
    r.update(cause=S["cause"] or "available", rows=S["rows"], cut=S["cut"] if np.isfinite(S["cut"]) else None,
             cal={k: v for k, v in (S["cal"] or {}).items() if k in ("kind", "slope", "intercept", "slope_ci")},
             thr={k: v for k, v in (S.get("info") or {}).items() if k != "cause"})
    fitm, pool, lo = v4_fit_mask(C, ok, a_day, test_day)
    if not diag or fitm.sum() < 50:
        return r, S, None
    sb = fitter(fitm)  # memoized: the same test model e2_select used (or would use)
    st = sb[C["i"][test_rows]]; yt = C["y"][test_rows]; ss = C["s"][test_rows]
    r["auc_test"] = auc(yt, st)
    r["auc_test_side"] = {str(s): auc(yt[ss == s], st[ss == s]) for s in (1, -1)}
    r["auc_pool"] = auc(C["y"][pool], sb[C["i"][pool]])
    if S["cal"] and S["cal"].get("kind") == "platt":
        r["test_rel"] = de.reliability(de.e2_prob(S["cal"], st), yt)
    zthr = sb[C["i"][pool]]; zthr = zthr[np.isfinite(zthr)]
    sbar = np.nan_to_num(sb, nan=-np.inf)
    curve = []
    if len(zthr):
        for q in de.E2_QGRID:
            cut = float(np.quantile(zthr, 1 - q))
            Tq = te(de.trades(B, O, de.run_d(B, O, GS, cfg, extra=sbar >= cut)["entries"]))
            curve.append(dict(q=q, trades=int(len(Tq["i"])), meanR=float(Tq["net"].mean()) if len(Tq["i"]) else None,
                              losers=float((Tq["net"] < 0).mean()) if len(Tq["i"]) else None))
    r["curve"] = curve
    TE = None
    if S["available"]:
        TE = te(de.trades(B, O, de.run_d(B, O, GS, cfg, extra=S["sbar"] >= S["cut"])["entries"]))
        r["trades"] = int(len(TE["i"]))
        if verdict:
            p_run_D = float(TD["runner"].sum() / max(1, TD["arm"].sum()))
            v, stt = de.e2_verdicts(TE, TD, all_days, years, p_run_D, KS)
            r.update(verdict={str(k): x for k, x in v.items()}, **{k: x for k, x in stt.items() if k in ("meanR", "inc_vs_D", "tail", "p_runner")},
                     ci3=stt.get("ci", {}).get(3), inc_ci3=stt.get("inc_ci", {}).get(3))
    elif verdict:
        r["verdict"] = {str(k): "abstain" for k in KS}
    return r, S, TE


# ------------------------------------------------------------------ planted controls (audit v1 plant, v2 harness settings)
def outcomes_lite(B):
    n = len(B["t"]); idx = np.arange(n)
    o = {s: simulate(B, idx, np.full(n, s), B["atr"], B["flip"], POLICY) for s in (1, -1)}
    return {False: o, True: o}


def realize(kind, mu, seed, learners=LEARNERS):
    import controls as c1
    de.supertrend = c1.supertrend_nocache
    t0 = time.time()
    m1p, obs = c1.plant(kind, mu, seed)
    B = de.build(c1.INST, m1p); O = outcomes_lite(B); L = de.gate_layer(m1p)
    ys = year_start_day(int(c1.TEST0[:4]))
    GS = de.gate_states(B, L, de.fit_gate(L, ys - de.EMB))
    hi_day = int(B["day"][-1]) + 1
    _, _, all_days = de.window_bars(B, ys, hi_day)
    years = (hi_day - ys) / 365.25
    te = lambda T: de.sel(T, T["day"] >= ys)
    cfg = c1.CFG_X
    RD = de.run_d(B, O, GS, cfg); TD = te(de.trades(B, O, RD["entries"]))
    F = de.e_features(B, GS, RD["ep"])
    C = de.candidates(B, O, RD, cfg[2])
    bench = Bench(B, F, C, extra={"c1": obs["c1"], "c2": obs["c2"]})
    ok = bench.ok
    tst = (C["day"] >= ys) & ok
    out = dict(kind=kind, mu=mu, seed=seed, evaluator=de.EVALUATOR_VERSION, code_sha256=de.CODE_SHA, bench_sha256=CODE,
               rows=dict(candidates=int(len(C["i"])), ok=int(ok.sum()), test=int(tst.sum())))
    TO = te(de.trades(B, O, de.run_d(B, O, GS, cfg, extra=c1.ORACLE[kind](obs["c1"], obs["c2"]))["entries"]))
    p_run_D = float(TD["runner"].sum() / max(1, TD["arm"].sum()))
    vo, _ = de.e2_verdicts(TO, TD, all_days, years, p_run_D, KS)
    out["econ"] = dict(trades=int(len(TO["i"])), meanR=float(TO["net"].mean()) if len(TO["i"]) else float("nan"),
                       verdict={str(k): v for k, v in vo.items()})
    out["D"] = dict(trades=int(len(TD["i"])), meanR=float(TD["net"].mean()))
    fitters = {n: bench.fitter(n) for n in learners}
    fitters["oracle"] = lambda mask: obs["g"].astype(float)
    for name in list(learners) + ["oracle"]:
        t1 = time.time()
        try:
            r, _, _ = evaluate(fitters[name], B, O, GS, cfg, C, ok, int(B["day"][0]), ys, tst, te, TD, all_days, years)
            r["log"] = bench.logs.get(name)
        except Exception as ex:
            r = dict(cause="error", error=repr(ex), verdict={str(k): "error" for k in KS})
        r["secs"] = round(time.time() - t1, 1)
        out[name] = r
    out["secs"] = round(time.time() - t0, 1)
    return out


def _job(a):
    try:
        return realize(*a)
    except Exception as ex:
        import traceback
        return dict(kind=a[0], mu=a[1], seed=a[2], fatal=repr(ex), tb=traceback.format_exc()[-2000:])


def run_controls(which, nproc):
    import controls as c1
    from multiprocessing import get_context
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    assert reg["code_sha256"]["bench.py"] == CODE["bench.py"], "bench.py changed after the preregistration (amend it first)"
    assert reg["code_sha256"]["evaluator"] == de.CODE_SHA
    path = os.path.join(OUT, f"controls_{which}.jsonl")
    seeds = reg["controls"]["seeds"][which]
    jobs = [(k, mu, s) for k, mus in c1.GRID.items() for mu in mus for s in seeds]
    done = {(r["kind"], r["mu"], r["seed"]) for r in map(json.loads, open(path))} if os.path.exists(path) else set()
    if which == "final" and done and len(done) >= len(jobs):
        sys.exit("final seeds already reported once")
    jobs = [j for j in jobs if j not in done]
    jobs.sort(key=lambda j: (j[2], j[0], j[1]))  # seed-major: a partial final run still covers every cell
    print(f"{len(jobs)} realizations ({len(done)} done), {nproc} processes", flush=True)
    c1.base()
    with get_context("fork").Pool(nproc) as pool, open(path, "a") as f:
        for r in pool.imap_unordered(_job, jobs):
            f.write(json.dumps(r, default=float) + "\n"); f.flush()
            print(r["kind"], r["mu"], r["seed"], r.get("econ", {}).get("meanR"),
                  {n: r.get(n, {}).get("verdict", {}).get("3") for n in LEARNERS + ("oracle",)}, r.get("secs"), r.get("fatal", ""), flush=True)


# ------------------------------------------------------------------ self-checks
def check():
    """1) ENG and windows are causal (perturb every bar after a cut: rows up to the cut unchanged; a planted leak is
    detected). 2) A TS2Vec encoder trained on windows that end before the cut gives the same embedding for a pre-cut
    window whether or not post-cut data changed (no future context through the encoder). 3) Fitters see only mask rows."""
    import controls as c1
    de.supertrend = c1.supertrend_nocache
    m1 = de.load_m1("WTICO/USD", "2019-01-01")
    B = de.build("WTICO/USD", m1)
    cut = int(m1["t"][len(m1["t"]) * 3 // 4])
    m2 = {k: v.copy() for k, v in m1.items()}
    late = m2["t"] >= cut
    noise = np.random.default_rng(5).normal(1, 0.03, late.sum())
    for f in ("bid_o", "bid_h", "bid_l", "bid_c", "ask_o", "ask_h", "ask_l", "ask_c"):
        m2[f][late] *= noise
    m2["volume"][late] *= 3
    B2 = de.build("WTICO/USD", m2)
    keep = np.where(B["t"] + 5 <= cut)[0]
    E1, E2 = eng_bars(B), eng_bars(B2)
    for k in ENG:
        assert np.allclose(E1[k][keep], E2[k][keep], equal_nan=True), k
    idx = keep[keep >= L_SEQ][-3000:]
    W1, W2 = windows(B, idx), windows(B2, idx)
    assert np.allclose(W1, W2, equal_nan=True)
    leak1 = windows({**B, "mid_c": np.r_[B["mid_c"][1:], np.nan]}, idx); leak2 = windows({**B2, "mid_c": np.r_[B2["mid_c"][1:], np.nan]}, idx)
    assert not np.allclose(leak1, leak2, equal_nan=True), "planted next-bar leak not detected"
    tr = keep[keep >= L_SEQ][-6000:-3000]
    enc, info = ts2vec_encoder(windows(B, tr)[:, :, :], seed=0)
    Z1, Z2 = enc(W1[-200:]), enc(W2[-200:])
    assert np.allclose(Z1, Z2, atol=1e-5)
    # an encoder applied to a sequence that includes later bars changes the embedding (the test has power)
    later = np.clip(idx[-200:] + 12, 0, len(B["t"]) - 1)
    Zf = enc(windows(B2, later)); assert not np.allclose(Z1, Zf, atol=1e-3)
    print(f"bench check OK: ENG ({len(ENG)} features) and trailing windows unchanged on {len(keep)} pre-cut bars under "
          f"post-cut perturbation; next-bar leak detected; TS2Vec ({info}) embeddings of pre-cut windows unchanged; "
          f"windows shifted 12 bars later change the embedding")


if __name__ == "__main__":
    if MODE == "check":
        check()
    elif MODE == "probe":
        print(json.dumps(realize(sys.argv[2], float(sys.argv[3]), int(sys.argv[4])), default=float, indent=1))
    elif MODE == "controls":
        run_controls(sys.argv[2], int(sys.argv[3]))
    elif MODE == "real":
        import real
        real.main(sys.argv[2])
