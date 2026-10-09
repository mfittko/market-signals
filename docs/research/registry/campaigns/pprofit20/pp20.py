"""pprofit20: calibrated P(a long / short entered NOW is profitable after costs) per instrument, M5.

Evaluator v2 (labels_v2.simulate, fills.resolve, validate.day_boot) is imported, never edited.

  python pp20.py check       synthetic self-checks + feature quantiles on 2018-2022 (NO outcomes)
  python pp20.py register    write prereg.json (refuses to overwrite)
  python pp20.py run [INST]  outcomes, walk-forward, calibration, export -> out/
"""
import os, sys, json, time, glob, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ENG)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.ensemble import HistGradientBoostingClassifier  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.isotonic import IsotonicRegression  # noqa: E402
import de_v2 as de  # noqa: E402
from bars import resample, CACHE  # noqa: E402
from labels_v2 import simulate, POLICY  # noqa: E402
from validate import day_of, tod_of, day_boot, log_trial  # noqa: E402

EXP = "pprofit20"
OUT = os.path.join(HERE, "out")
CUT = "2026-10-07T18:30"
INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "NATGAS/USD", "SPX500/USD", "EUR/USD"]
DEV_END = "2023-01-01"
TF = os.environ.get("PP_TF", "M5"); GM = {"M1": 1, "M5": 5, "M15": 15}[TF]; SUF = "" if TF == "M5" else "_" + TF  # amendments: M15 (every bar), M1
# decision bars: start minute % CADENCE == CADENCE - GM. M5: % 15 == 10 (every 3rd bar, the M15 close); M15: every bar;
# M1 (amendment A2): % 5 == 4 (every 5th bar, the M5 close)
CADENCE = 5 if TF == "M1" else 15
CAL = os.environ.get("PP_CAL", "platt")  # amendment A3: "iso" = isotonic calibrator (M1 only)
assert CAL in ("platt", "iso") and (CAL == "platt" or TF == "M1")
SUF += "_iso" if CAL == "iso" else ""
REG = "prereg.json" if TF == "M5" else f"prereg_{TF.lower()}{'_iso' if CAL == 'iso' else ''}.json"
POL = dict(POLICY, H=360) if TF == "M1" else POLICY  # M1: time exit 360 bars = 6 h, the M5 horizon (72 x 5 min)
# amendment A4 (operator horizons): PP_H bars of the viewed timeframe, PP_TGT plan (trade-plan label) | up (price better
# after costs at bar i + H close). Calibrator per timeframe as registered: isotonic M1 (A3), Platt M5/M15 (A1).
A4_H = int(os.environ.get("PP_H", "0")); TGT = os.environ.get("PP_TGT", "plan")
if A4_H:
    assert A4_H in (12, 48) and TGT in ("plan", "up") and "PP_CAL" not in os.environ
    CAL = "iso" if TF == "M1" else "platt"
    POL = dict(POLICY, H=A4_H)
    SUF = f"_{TF}_H{A4_H}_{TGT}"
    REG = "prereg_horizons.json"
NSLOT, SLOTW = (1440, 5) if TF == "M1" else (288, 1)  # M1: tod norm fitted on 288 5-minute slots, exported per minute
ATR_N, ATR_REG_N, BURST_K, BURST_ATR = 14, 1440, 3, 2.5
CAL_DAYS = 182          # calibration window before each quarter start (chronologically after the fit window)
MIN_SUPPORT, TOL = 1000, 0.03
NBOOT = 1000
UNS = ["spr", "h_s1", "h_c1", "h_s2", "h_c2", "h_s3", "h_c3", "mon", "fri", "lrv12", "lrv72", "latr", "lrng"]
DIRF = ["mv", "st_al", "h1_al", "dst", "burst"]
BASE = UNS + DIRF
CLIP = dict(spr=(0, 2), lrv12=(-3, 3), lrv72=(-3, 3), latr=(-3, 3), lrng=(-5, 5), mv=(-20, 20), dst=(-10, 10))
DESIGN = BASE + ["side"] + ["side*" + f for f in BASE]
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"pp20.py": sha(os.path.join(HERE, "pp20.py"))}
mins = lambda s: int(np.datetime64(s, "m").astype(np.int64))


# ------------------------------------------------------------------ data and features
def load_m1c(inst):
    f = sorted(glob.glob(os.path.join(CACHE, inst.replace("/", "_") + "_*.npz")), key=lambda p: int(p.split("_")[-2]))[-1]
    z = np.load(f); m = z["t"] < mins(CUT)
    return {k: z[k][m] for k in z.files}, os.path.basename(f)


def atr_wilder(h, l, c, n=ATR_N):
    """Wilder ATR on mid bars: TR_0 = h-l, TR_j = max(h-l, |h-c_{j-1}|, |l-c_{j-1}|); seed = mean TR_0..TR_{n-1} at
    index n-1, then atr_j = (atr_{j-1} (n-1) + TR_j) / n. NaN before n-1."""
    pc = np.r_[np.nan, c[:-1]]
    tr = np.where(np.isnan(pc), h - l, np.maximum(h - l, np.maximum(np.abs(h - pc), np.abs(l - pc))))
    out = np.full(len(c), np.nan)
    if len(c) < n:
        return out
    a = tr[:n].mean(); out[n - 1] = a
    for j in range(n, len(c)):
        a = (a * (n - 1) + tr[j]) / n; out[j] = a
    return out


def bar_features(inst, B):
    """Per-M5-bar features (side-free part U and side-signed part D, to be multiplied by side). B: M5 bid/ask bars
    (t, bid_*, ask_*, volume, mid_*). Everything uses bars <= i only."""
    S = de.supertrend(inst, B)
    trend = np.nan_to_num(S["trend"]).astype(int)
    flip = np.nan_to_num(S["flip"]).astype(int)
    H = resample({k: B[k] for k in ["t", "volume"] + [s + "_" + x for s in ("bid", "ask") for x in "ohlc"]}, "H1")
    trH = np.nan_to_num(de.supertrend(inst, H)["trend"]).astype(int)
    j = np.searchsorted(H["t"] + 60, B["t"] + GM, side="right") - 1      # completed H1 bars only
    trH1 = np.where(j >= 0, trH[np.clip(j, 0, None)], 0)
    o, h, l, c = (B["mid_" + k] for k in "ohlc")
    atr = atr_wilder(h, l, c)
    t = B["t"]; day = day_of(t)
    U, D = {}, {}
    U["spr"] = (B["ask_c"] - B["bid_c"]) / (POLICY["k"] * atr)
    m = 2 * np.pi * ((t + GM) % 1440) / 1440
    for k in (1, 2, 3):
        U[f"h_s{k}"] = np.sin(k * m); U[f"h_c{k}"] = np.cos(k * m)
    dw = (day + 3) % 7  # trading day (22:00 UTC roll), Monday = 0
    U["mon"] = (dw == 0).astype(float); U["fri"] = (dw == 4).astype(float)
    d2 = pd.Series(np.r_[np.nan, np.diff(c)] ** 2)
    with np.errstate(divide="ignore", invalid="ignore"):
        for n in (12, 72):
            U[f"lrv{n}"] = np.log(np.maximum(np.sqrt(d2.rolling(n).mean().to_numpy()), 1e-12 * atr) / atr)
        U["latr"] = np.log(atr / pd.Series(atr).rolling(ATR_REG_N).mean().to_numpy())
        g = pd.Series(day)
        dopen = pd.Series(o).groupby(g).transform("first").to_numpy()
        rng = pd.Series(h).groupby(g).cummax().to_numpy() - pd.Series(l).groupby(g).cummin().to_numpy()
        U["lrng"] = np.log(np.maximum(rng, 1e-12 * atr) / atr)  # minus the time-of-day norm, fitted per fold
        D["mv"] = (c - dopen) / atr
        D["st_al"] = trend.astype(float)
        D["h1_al"] = trH1.astype(float)
        D["dst"] = (c - S["st"]) / atr
        c3 = np.r_[np.full(BURST_K, np.nan), c[:-BURST_K]]
        D["burst"] = np.sign(c - c3) * (np.abs(c - c3) / atr > BURST_ATR)
    for k, (a, b) in CLIP.items():
        X = U if k in U else D
        X[k] = np.clip(X[k], a, b)
    slot = (tod_of(t) // GM).astype(int)
    valid = np.isfinite(atr) & (atr > 0) & (trend != 0) & (trH1 != 0)
    for X in (U, D):
        for v in X.values():
            valid &= np.isfinite(v)
    return dict(U=U, D=D, slot=slot, valid=valid, atr=atr, flip=flip, trend=trend, day=day)


def frame(inst, m1):
    B = resample(m1, TF)
    return B, bar_features(inst, B)


def rows(B, Fb, labels=True):
    """Decision rows: cadence bars x both sides. Returns dict of arrays."""
    i = np.where((B["t"] % CADENCE == (CADENCE - GM) % CADENCE) & Fb["valid"])[0]
    i = i[i < len(B["t"]) - 1]
    ii = np.r_[i, i]; s = np.r_[np.ones(len(i), int), -np.ones(len(i), int)]
    R = dict(i=ii, side=s, t=B["t"][ii], day=Fb["day"][ii], slot=Fb["slot"][ii])
    for k in UNS:
        R[k] = Fb["U"][k][ii]
    for k in DIRF:
        R[k] = s * Fb["D"][k][ii]
    if labels and TGT == "up":  # A4 T_up: entry next open (long ask / short bid), exit at the close of bar i + H (long bid / short ask)
        n = len(B["t"]); ok = ii + A4_H < n; x = np.clip(ii + A4_H, 0, n - 1); e = np.clip(ii + 1, 0, n - 1)
        R1 = POLICY["k"] * Fb["atr"][ii]
        R["net"] = np.where(s > 0, B["bid_c"][x] - B["ask_o"][e], B["bid_o"][e] - B["ask_c"][x]) / R1
        R["y"] = (R["net"] > 0).astype(int)
        R["texit"] = B["t"][x] + GM
        ok &= np.isfinite(R["net"])
        return {k: v[ok] for k, v in R.items()}
    if labels:
        sm = simulate(B, ii, s, Fb["atr"][ii], Fb["flip"], POL)
        R["net"] = sm["net_R"]; R["y"] = (sm["net_R"] > 0).astype(int)
        xb = np.clip(sm["exit_bar"], 0, len(B["t"]) - 1)
        R["texit"] = np.where(sm["ok"], B["t"][xb] + GM, np.iinfo(np.int64).max)
        ok = sm["ok"]
        R = {k: v[ok] for k, v in R.items()}
    return R


# ------------------------------------------------------------------ model
def tod_norm(R, m):
    med = np.median(R["lrng"][m])
    tab = np.full(NSLOT // SLOTW, med)
    s = pd.Series(R["lrng"][m]).groupby(R["slot"][m] // SLOTW).median()
    tab[s.index.to_numpy()] = s.to_numpy()
    return np.repeat(tab, SLOTW)


def raw_matrix(R, tab):
    X = np.column_stack([R[k] for k in UNS[:-1]] + [R["lrng"] - tab[R["slot"]]] + [R[k] for k in DIRF])
    return X


def design(X, mu, sd, side):
    Z = (X - mu) / sd
    return np.column_stack([Z, side, side[:, None] * Z])


def fit(R, mtr, mcal):
    tab = tod_norm(R, mtr)
    X = raw_matrix(R, tab)
    mu = X[mtr].mean(0); sd = X[mtr].std(0); sd[sd == 0] = 1.0
    Dm = design(X[mtr], mu, sd, R["side"][mtr])
    lr = LogisticRegression(C=1.0, max_iter=2000).fit(Dm, R["y"][mtr])
    M = dict(tab=tab, mu=mu, sd=sd, coef=lr.coef_[0], b0=float(lr.intercept_[0]))
    zc = score(M, R, mcal)
    if CAL == "iso":  # knots ascending in raw score; prob() interpolates linearly between them and clips outside
        ir = IsotonicRegression(out_of_bounds="clip").fit(zc, R["y"][mcal])
        M["iso"] = (ir.X_thresholds_.astype(float), ir.y_thresholds_.astype(float)); M["platt"] = None
        return M
    pl = LogisticRegression(C=1e6, max_iter=1000).fit(zc[:, None], R["y"][mcal])
    M["platt"] = (float(pl.coef_[0][0]), float(pl.intercept_[0]))
    return M


def score(M, R, m):
    X = raw_matrix({k: (v[m] if isinstance(v, np.ndarray) else v) for k, v in R.items()}, M["tab"])
    return design(X, M["mu"], M["sd"], R["side"][m]) @ M["coef"] + M["b0"]


def prob(M, z):
    if M.get("iso") is not None:
        return np.interp(z, *M["iso"])  # = sklearn IsotonicRegression.predict (linear between knots, clip at the ends)
    a, b = M["platt"]
    return 1 / (1 + np.exp(-(a * z + b)))


def quarters(t0, t1):
    out = []
    for y in range(2019, 2027):
        for q in range(4):
            a = mins(f"{y}-{3 * q + 1:02d}-01")
            b = mins(f"{y + (q == 3)}-{(3 * q + 4) % 12 if q < 3 else 1:02d}-01")
            if a < t1:
                out.append((a, min(b, t1)))
    return out


def walk_forward(R, tcut):
    """Quarterly expanding refit: fit rows with exit < cal start; Platt on rows starting in [Qs - CAL_DAYS, Qs) with
    exit < Qs; predict rows starting in the quarter."""
    P = np.full(len(R["t"]), np.nan); Z = P.copy(); fits = []
    for a, b in quarters(R["t"].min(), tcut):
        cs = a - CAL_DAYS * 1440
        mtr = R["texit"] < cs; mcal = (R["t"] >= cs) & (R["texit"] < a); mte = (R["t"] >= a) & (R["t"] < b)
        if mtr.sum() < 20000 or mcal.sum() < 5000 or not mte.any():
            continue
        M = fit(R, mtr, mcal)
        z = score(M, R, mte); Z[mte] = z; P[mte] = prob(M, z)
        fits.append(dict(q=str(np.datetime64(a, "m"))[:10], n_fit=int(mtr.sum()), n_cal=int(mcal.sum()), n_test=int(mte.sum()),
                         platt=M["platt"]))
    return P, Z, fits


def hgb_walk(R, tcut):
    """Comparator: HGB on the same raw features + side, yearly refit (fit rows with exit < year start), raw probs."""
    P = np.full(len(R["t"]), np.nan)
    X = np.column_stack([R[k] for k in BASE] + [R["slot"], R["side"]])
    for y in range(2019, 2027):
        a, b = mins(f"{y}-01-01"), min(mins(f"{y + 1}-01-01"), tcut)
        mtr = R["texit"] < a; mte = (R["t"] >= a) & (R["t"] < b)
        if mtr.sum() < 20000 or not mte.any():
            continue
        m = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=200,
                                           l2_regularization=1.0, random_state=0).fit(X[mtr], R["y"][mtr])
        P[mte] = m.predict_proba(X[mte])[:, 1]
    return P


# ------------------------------------------------------------------ evaluation
def deciles(p):
    e = np.quantile(p, np.linspace(0, 1, 11)); e[0], e[-1] = -np.inf, np.inf
    return np.clip(np.searchsorted(e, p, side="right") - 1, 0, 9), e


def auc(y, p):
    return float(roc_auc_score(y, p)) if 0 < y.mean() < 1 else None


def evaluate(R, P, m, rng_days):
    """Per side: reliability by decile with bootstrap CIs for the observed rate and mean net R, AUC, CITL by year."""
    out = {}
    for sd, nm in ((1, "long"), (-1, "short")):
        k = m & (R["side"] == sd)
        p, y, net, day, t = P[k], R["y"][k], R["net"][k], R["day"][k], R["t"][k]
        dec, edges = deciles(p)

        def stat(ix):
            d = dec[ix]
            n = np.bincount(d, minlength=10)
            return np.r_[np.bincount(d, y[ix], 10) / np.maximum(n, 1), np.bincount(d, net[ix], 10) / np.maximum(n, 1)]
        bt = day_boot(day, rng_days, stat, NBOOT)
        rows_ = []
        for d in range(10):
            q = dec == d
            win = net[q & (net > 0)]; los = net[q & (net <= 0)]
            rows_.append(dict(decile=d + 1, n=int(q.sum()), p_mean=float(p[q].mean()), obs=float(y[q].mean()),
                              gap=float(p[q].mean() - y[q].mean()),
                              obs_ci=[float(np.percentile(bt[:, d], 2.5)), float(np.percentile(bt[:, d], 97.5))],
                              meanR=float(net[q].mean()),
                              meanR_ci=[float(np.percentile(bt[:, 10 + d], 2.5)), float(np.percentile(bt[:, 10 + d], 97.5))],
                              avg_win=float(win.mean()) if len(win) else None, avg_loss=float(los.mean()) if len(los) else None))
        yr = t.astype("datetime64[m]").astype("datetime64[Y]").astype(int) + 1970
        citl = {int(Y): dict(n=int((yr == Y).sum()), p=float(p[yr == Y].mean()), obs=float(y[yr == Y].mean()),
                             citl=float(p[yr == Y].mean() - y[yr == Y].mean()),
                             auc=auc(y[yr == Y], p[yr == Y])) for Y in np.unique(yr)}
        sup = [r for r in rows_ if r["n"] >= MIN_SUPPORT]
        out[nm] = dict(n=int(k.sum()), base=float(y.mean()), meanR=float(net.mean()), auc=auc(y, p),
                       p_q=[float(x) for x in np.percentile(p, [10, 50, 90])],
                       max_abs_gap=float(max(abs(r["gap"]) for r in sup)), calib_pass=all(abs(r["gap"]) <= TOL for r in sup),
                       deciles=rows_, edges=[float(x) for x in edges[1:-1]], by_year=citl,
                       pos_deciles=[r["decile"] for r in rows_ if r["meanR_ci"][0] > 0])
    return out


def breakdown(R, P, m):
    """Spread of predictions by 4h UTC block and by spread bucket, per side."""
    out = {}
    hr = ((R["t"][m] + GM) % 1440) // 60
    blocks = {f"{a:02d}-{a + 4:02d}": (hr >= a) & (hr < a + 4) for a in range(0, 24, 4)}
    sp = R["spr"][m]
    sb = {"<0.05": sp < .05, "0.05-0.1": (sp >= .05) & (sp < .1), "0.1-0.2": (sp >= .1) & (sp < .2),
          "0.2-0.5": (sp >= .2) & (sp < .5), ">=0.5": sp >= .5}
    p, y, net, side = P[m], R["y"][m], R["net"][m], R["side"][m]
    for name, G in (("hour_utc", blocks), ("spread_R", sb)):
        out[name] = {}
        for g, q in G.items():
            out[name][g] = {}
            for sd, nm in ((1, "long"), (-1, "short")):
                k = q & (side == sd)
                if k.sum() < 50:
                    continue
                out[name][g][nm] = dict(n=int(k.sum()), p10=float(np.percentile(p[k], 10)), p50=float(np.percentile(p[k], 50)),
                                        p90=float(np.percentile(p[k], 90)), p_mean=float(p[k].mean()), obs=float(y[k].mean()),
                                        meanR=float(net[k].mean()))
    return out


def long_minus_short(R, P, m, rng_days):
    L = m & (R["side"] == 1); S = m & (R["side"] == -1)
    kl = pd.Series(np.where(L)[0], index=R["i"][L]); ks = pd.Series(np.where(S)[0], index=R["i"][S])
    both = kl.index.intersection(ks.index)
    a, b = kl[both].to_numpy(), ks[both].to_numpy()
    d = P[a] - P[b]; dy = (R["y"][a] - R["y"][b]).astype(float); dn = R["net"][a] - R["net"][b]
    dec, _ = deciles(d)
    tab = [dict(decile=k + 1, n=int((dec == k).sum()), d_mean=float(d[dec == k].mean()), obs=float(dy[dec == k].mean()),
                net_diff=float(dn[dec == k].mean())) for k in range(10)]
    slope = lambda ix: float(np.polyfit(d[ix], dy[ix], 1)[0]) if np.std(d[ix]) > 0 else np.nan
    bt = day_boot(R["day"][a], rng_days, slope, 500)
    return dict(n=int(len(both)), q=[float(x) for x in np.percentile(d, [5, 25, 50, 75, 95])],
                frac_abs_gt_0_05=float((np.abs(d) > 0.05).mean()), frac_abs_gt_0_10=float((np.abs(d) > 0.10).mean()),
                deciles=tab, slope_obs_on_pred=[slope(np.arange(len(d))), float(np.nanpercentile(bt, 2.5)), float(np.nanpercentile(bt, 97.5))])


# ------------------------------------------------------------------ export
def relabel(A):
    """Texts are written for M5; for another timeframe swap the bar length in them (numbers untouched).
    ponytail: string replace over the JSON text, fine while texts only name M5 and the 5-minute offsets."""
    if TF == "M5":
        return A
    s = json.dumps(A).replace("M5", TF).replace("t + 5", f"t + {GM}").replace(") / 5", f") / {GM}")
    return json.loads(s)


def artifact(inst, M, R, P, src, ev):
    win = f"rows starting in the {CAL_DAYS} days before {CUT}, exit before the cutoff"
    if CAL == "iso":
        cal = {"type": "isotonic", "kind": "isotonic", "x": [float(v) for v in M["iso"][0]], "y": [float(v) for v in M["iso"][1]],
               "out_of_bounds": "clip",
               "interpolation": "linear between knots (sklearn IsotonicRegression.predict default = numpy.interp): for x[j] <= raw <= "
                                "x[j+1], P = y[j] + (y[j+1] - y[j]) * (raw - x[j]) / (x[j+1] - x[j]); raw < x[0] -> y[0]; "
                                "raw > x[-1] -> y[-1]; x strictly ascending",
               "window": win}
    else:
        a, b = M["platt"]
        cal = {"kind": "platt", "a": a, "b": b, "formula": "P = 1 / (1 + exp(-(a * raw + b)))", "window": win}
    ok = np.isfinite(P)
    er = {}
    for sd, nm in ((1, "long"), (-1, "short")):
        k = ok & (R["side"] == sd)
        dec, e = deciles(P[k])
        net = R["net"][k]
        bt = day_boot(R["day"][k], np.arange(R["day"].min(), R["day"].max() + 1),
                      lambda ix: np.bincount(dec[ix], net[ix], 10) / np.maximum(np.bincount(dec[ix], minlength=10), 1), NBOOT)
        er[nm] = dict(p_edges=[float(x) for x in e[1:-1]],
                      # an empty decile (possible with tied isotonic P) exports null, never NaN
                      meanR=[float(net[dec == d].mean()) if (dec == d).any() else None for d in range(10)],
                      meanR_ci=[[float(np.percentile(bt[:, d], 2.5)), float(np.percentile(bt[:, d], 97.5))] if (dec == d).any() else None
                                for d in range(10)],
                      n=[int((dec == d).sum()) for d in range(10)])
    a4 = {}
    if A4_H:
        a4 = {"horizon_bars": A4_H, "target": TGT, "target_definition": (
            f"plan: net R > 0 of the trade below, time exit after {A4_H} M5 bars" if TGT == "plan" else
            f"up: long y = 1 if bid close of bar i + {A4_H} > ask open of bar i + 1; short y = 1 if ask close of bar i + {A4_H} "
            f"< bid open of bar i + 1; expected R = that net move / (1.5 x Wilder ATR14 of mid M5 at bar i)")}
    return relabel({
        **a4,
        "name": f"pprofit20 P(profit) {inst} M5" + (f" H{A4_H} {TGT}" if A4_H else ""), "instrument": inst, "timeframe": "M5", "exp": EXP,
        "status": "development evidence, research preview; not qualified; never an edge claim",
        "training_cutoff": CUT, "source_cache": src,
        "code_sha256": {**CODE, "evaluator_digest": de.CODE_SHA},
        "trade": "entry at the next M5 bar open (long ask / short bid); stop 1.5 x Wilder ATR14 of mid M5 = 1R; breakeven after "
                 "+1R (one-bar latency), 3R target, exit at the next open after an opposite M5 supertrend flip (ATR10, mult 3, "
                 f"mid), time exit after {POL['H']} bars; label = net R > 0 after bid/ask",
        "decision": "score at the close of a completed M5 bar i (bars <= i only); mid = (bid + ask) / 2 per OHLC field",
        "features": {
            "order": BASE,
            "definitions": {
                "spr": "(ask_c - bid_c) / (1.5 * atr14), clip [0, 2]",
                "h_sK/h_cK": "sin/cos(K * 2 pi * ((t + 5) mod 1440) / 1440), t = bar start in UTC minutes, K = 1..3",
                "mon/fri": "trading day (22:00 UTC roll: day = floor((t + 120) / 1440)) is Monday / Friday: (day + 3) mod 7 == 0 / 4",
                "lrv12/lrv72": "log(max(sqrt(mean of (c_j - c_{j-1})^2 over the last N bars j <= i), 1e-12 * atr14) / atr14), clip [-3, 3]",
                "latr": "log(atr14 / mean(atr14 over the last 1440 bars incl. i)), clip [-3, 3]",
                "lrng": "clip(log(max(day high - day low of mid bars so far incl. i, 1e-12 * atr14) / atr14), -5, 5) - tod_norm[slot], slot = ((t + 120) mod 1440) / 5",
                "mv": "side * (c_i - open of the first bar of the trading day) / atr14, clip [-20, 20]",
                "st_al": "side * M5 supertrend trend (+1/-1, production ATR10 mult 3 on mid)",
                "h1_al": "side * trend of the last COMPLETED H1 supertrend bar (H1 = M5 resampled on the hour; usable when H1 start + 60 <= t + 5)",
                "dst": "side * (c_i - M5 supertrend line) / atr14, clip [-10, 10]",
                "burst": "side * sign(c_i - c_{i-3}) if |c_i - c_{i-3}| / atr14 > 2.5 else 0",
                "atr14": "Wilder ATR14 on mid: TR_0 = h-l, TR_j = max(h-l, |h-c_{j-1}|, |l-c_{j-1}|); seed = mean(TR_0..TR_13) at index 13; atr_j = (13 atr_{j-1} + TR_j) / 14",
            },
            "valid": "atr14 finite > 0, M5 and H1 trend nonzero, all features finite (1440-bar ATR mean warm-up)",
        },
        "tod_norm": [float(x) for x in M["tab"]],
        "scaler": {"mean": [float(x) for x in M["mu"]], "std": [float(x) for x in M["sd"]]},
        "design": "x = [z_1..z_18, side, side * z_1..side * z_18], z = (feature - mean) / std, side = +1 long / -1 short",
        "design_order": DESIGN,
        "coef": [float(x) for x in M["coef"]], "intercept": M["b0"],
        "raw_score": "intercept + coef . x",
        "calibrator": cal,
        "fit_window": f"rows with exit before {CUT} minus {CAL_DAYS} days",
        "expected_R": {"note": "mean net R by out-of-sample calibrated-P decile (walk-forward 2019..cutoff), per side; look up the "
                               "bin that contains P; meanR_ci = 95% moving-block (5 trading days) day bootstrap, "
                               f"{NBOOT} replicates, seed 7", **er},
        **({"tod_norm_note": "fitted on 288 five-minute slots (median per slot), stored per minute (1440 entries, each minute "
                             "carries its 5-minute slot value), so slot = ((t + 120) mod 1440)"} if TF == "M1" else {}),
        "validity": ev,
    })


FXB, FXR = (2000, 40) if TF == "M1" else (6000, 200)  # M1: fixture bars fixed by the check-mode probe before registration


def window_rows(inst, B, nbars, nrows):
    """Features recomputed on the last `nbars` bars only; rows = last `nrows` cadence bars x 2 sides."""
    n = len(B["t"]); s0 = n - nbars
    W = {k: v[s0:] for k, v in B.items()}
    Fw = bar_features(inst + "_fx", W)
    Rw = rows(W, Fw, labels=False)
    keep = np.argsort(Rw["t"], kind="stable")[-2 * nrows:]
    return W, {k: v[keep] for k, v in Rw.items()}, s0


def window_diffs(Rw, s0, R_full):
    """Max |feature diff| per row vs full-history features for the same bar and side."""
    fk = dict(zip(zip(R_full["i"].tolist(), R_full["side"].tolist()), range(len(R_full["i"]))))
    keys = [(int(Rw["i"][r]) + s0, int(Rw["side"][r])) for r in range(len(Rw["t"]))]
    return [max(abs(Rw[f][r] - R_full[f][fk[k]]) for f in BASE) for r, k in enumerate(keys) if k in fk]


def fixture(inst, B, R_full, P_full, M, nbars=FXB, nrows=FXR):
    """Bars-to-probability parity: features recomputed on the last `nbars` bars only; rows = last cadence bars."""
    W, Rw, s0 = window_rows(inst, B, nbars, nrows)
    allm = np.ones(len(Rw["t"]), bool)
    z = score(M, Rw, allm); p = prob(M, z)
    X = raw_matrix(Rw, M["tab"])
    diffs = window_diffs(Rw, s0, R_full)  # cross-check against full-history features for the same bars
    bars = [dict(t=str(np.datetime64(int(W["t"][j]), "m")), **{k: float(W[k][j]) for k in
                                                              ["bid_o", "bid_h", "bid_l", "bid_c", "ask_o", "ask_h", "ask_l", "ask_c"]})
            for j in range(nbars)]
    rws = [dict(bar_index=int(Rw["i"][r]), t=str(np.datetime64(int(Rw["t"][r]), "m")), side=int(Rw["side"][r]),
                features={f: float(X[r, k]) for k, f in enumerate(BASE)}, lrng_raw=float(Rw["lrng"][r]),
                raw=float(z[r]), p=float(p[r])) for r in range(len(Rw["t"]))]
    return relabel(dict(instrument=inst, note="bars are M5 bid/ask, t = bar start UTC; features computed from these bars only; "
                                      "lrng in features already has tod_norm subtracted; tolerance 1e-9",
                artifact=f"artifact_{inst.replace('/', '_')}{SUF}_pprofit20.json", bars=bars, rows=rws,
                max_abs_diff_vs_full_history=float(max(diffs)) if diffs else None, n_crosschecked=len(diffs)))


# ------------------------------------------------------------------ modes
def check():
    # Wilder ATR on a constant-range series: TR = 1 -> ATR = 1
    h = np.full(30, 101.0); l = np.full(30, 100.0); c = np.full(30, 100.5)
    a = atr_wilder(h, l, c); assert np.isnan(a[12]) and abs(a[13] - 1) < 1e-15 and abs(a[-1] - 1) < 1e-15
    h2 = h.copy(); h2[20] = 105; a2 = atr_wilder(h2, l, c)
    assert abs(a2[20] - (13 + 5) / 14) < 1e-12
    q = quarters(0, mins("2019-07-15"))
    assert q[0] == (mins("2019-01-01"), mins("2019-04-01")) and q[-1] == (mins("2019-07-01"), mins("2019-07-15"))
    assert quarters(0, mins("2020-01-02"))[3] == (mins("2019-10-01"), mins("2020-01-01"))
    print("pp20 self-check OK: Wilder ATR seed/recursion, quarter folds")
    rep = {}
    for inst in INSTS:
        m1, src = load_m1c(inst)
        B, Fb = frame(inst, m1)
        R = rows(B, Fb, labels=False)
        dv = R["t"] < mins(DEV_END)
        rep[inst] = dict(src=src, bars=len(B["t"]), first=str(np.datetime64(int(B["t"][0]), "m")), rows_dev=int(dv.sum()),
                         rows_2023=int((~dv).sum()),
                         q={k: [round(float(x), 3) for x in np.percentile(R[k][dv], [1, 10, 50, 90, 99])] for k in BASE},
                         burst_rate=float((R["burst"][dv] != 0).mean()))
        if TF == "M1" and inst in ("WTICO/USD", "EUR/USD"):  # fixture size probe: features only, no outcomes
            rep[inst]["fixture_probe"] = {nb: float(max(window_diffs(*window_rows(inst, B, nb, FXR)[1:], R)))
                                          for nb in (1500, 1700, 2000, 2500, 3000, 4000)}
        print(json.dumps({inst: rep[inst]}), flush=True)
    json.dump(rep, open(os.path.join(OUT, f"explore{SUF}.json"), "w"), indent=1)


def register():
    f = os.path.join(HERE, REG)
    assert not os.path.exists(f), "prereg.json exists"
    reg = json.load(open(os.path.join(HERE, REG.replace("prereg", "prereg_draft"))))
    reg["created"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    reg["code_sha256"] = {**CODE, "evaluator": de.CODE_SHA}
    json.dump(reg, open(f, "w"), indent=1)
    print("registered", reg["code_sha256"])


def run(only=None):
    reg = json.load(open(os.path.join(HERE, REG)))
    if reg["code_sha256"]["pp20.py"] != CODE["pp20.py"]:
        print("WARNING pp20.py differs from the registered hash; see amendments in prereg/report", flush=True)
    assert reg["code_sha256"]["evaluator"] == de.CODE_SHA
    os.makedirs(OUT, exist_ok=True)
    tcut = mins(CUT)
    for inst in INSTS:
        if only and inst not in only:
            continue
        t0 = time.time()
        m1, src = load_m1c(inst)
        B, Fb = frame(inst, m1)
        R = rows(B, Fb)
        P, Z, fits = walk_forward(R, tcut)
        Ph = hgb_walk(R, tcut)
        all_days = np.arange(R["day"].min(), R["day"].max() + 1)
        res = dict(inst=inst, src=src, n_rows=len(R["t"]), fits=fits, windows={})
        for wn, m in (("dev2019_22", np.isfinite(P) & (R["t"] < mins(DEV_END))), ("w2023", np.isfinite(P) & (R["t"] >= mins(DEV_END)))):
            ev = evaluate(R, P, m, all_days)
            mh = m & np.isfinite(Ph)
            hgb = {nm: dict(auc=auc(R["y"][mh & (R["side"] == sd)], Ph[mh & (R["side"] == sd)]),
                            citl=float(Ph[mh & (R["side"] == sd)].mean() - R["y"][mh & (R["side"] == sd)].mean()))
                   for sd, nm in ((1, "long"), (-1, "short"))}
            res["windows"][wn] = dict(lr=ev, hgb=hgb, breakdown=breakdown(R, P, m), lms=long_minus_short(R, P, m, all_days),
                                      auc_spread_only={nm: auc(R["y"][m & (R["side"] == sd)], -R["spr"][m & (R["side"] == sd)])
                                                       for sd, nm in ((1, "long"), (-1, "short"))})
            print(inst, wn, {nm: (round(ev[nm]["auc"], 3), round(ev[nm]["max_abs_gap"], 3), ev[nm]["calib_pass"]) for nm in ev},
                  "hgb", {k: round(v["auc"], 3) for k, v in hgb.items()}, flush=True)
        passed = all(res["windows"][w]["lr"][s]["calib_pass"] for w in res["windows"] for s in ("long", "short"))
        res["calib_pass"] = passed
        tag = inst.replace("/", "_") + SUF
        # final model at the cutoff, same scheme as one more quarter
        cs = tcut - CAL_DAYS * 1440
        M = fit(R, R["texit"] < cs, (R["t"] >= cs) & (R["texit"] < tcut))
        res["final"] = dict(platt=M["platt"], n_fit=int((R["texit"] < cs).sum()))
        vs = {w: {s: dict(auc=res["windows"][w]["lr"][s]["auc"], max_abs_gap=res["windows"][w]["lr"][s]["max_abs_gap"],
                          calib_pass=res["windows"][w]["lr"][s]["calib_pass"]) for s in ("long", "short")} for w in res["windows"]}
        validity = dict(calibration_pass=passed, rule=f"|mean P - observed| <= {TOL} in every per-side decile with n >= {MIN_SUPPORT}, "
                        "dev 2019-2022 walk-forward and 2023+ development window", windows=vs,
                        statement=("calibrated in development evidence; discrimination is weak; the number is a cost-and-conditions "
                                   "readout, not an edge" if passed else "NOT calibrated to the preregistered tolerance; do not show as a probability"))
        if passed:
            art = artifact(inst, M, R, P, src, validity)
            p50 = float(np.median(P[np.isfinite(P)]))
            if (CAL == "iso" or A4_H) and p50 < 0.01:  # A3 rule: a pass on near-certain losers is not a display number
                art["status"] = f"degenerate: not for display (median out-of-sample P {p50:.4f} < 1%); " + art["status"]
            json.dump(art, open(os.path.join(OUT, f"artifact_{tag}_pprofit20.json"), "w"), indent=1)
        if inst in ("WTICO/USD", "EUR/USD"):
            fx = fixture(inst, B, R, P, M)
            fx["calibration_pass"] = passed
            json.dump(fx, open(os.path.join(OUT, f"parity_{tag}_pprofit20.json"), "w"))
            print(inst, "fixture rows", len(fx["rows"]), "max diff vs full history", fx["max_abs_diff_vs_full_history"], flush=True)
            if not passed:  # artifact still needed to read the fixture; mark it
                art = artifact(inst, M, R, P, src, validity); art["status"] = "NOT calibrated: parity reference only, do not ship"
                json.dump(art, open(os.path.join(OUT, f"artifact_{tag}_pprofit20.json"), "w"), indent=1)
        json.dump(res, open(os.path.join(OUT, f"results_{tag}.json"), "w"), indent=1, default=float)
        log_trial(dict(exp=EXP, inst=inst, tf=TF, model="lr_side_interaction+" + ("isotonic" if CAL == "iso" else "platt"), refit="quarterly", cal_days=CAL_DAYS, H=POL["H"], target=TGT, cal=CAL,
                       features=BASE, cadence=CADENCE, calib_pass=passed, evaluator="v2", code_sha256=CODE["pp20.py"]))
        log_trial(dict(exp=EXP, inst=inst, tf=TF, model="hgb_comparator", refit="yearly", features=BASE + ["slot", "side"],
                       params=dict(max_iter=200, lr=0.05, leaves=31, min_leaf=200, l2=1.0), evaluator="v2", code_sha256=CODE["pp20.py"]))
        print(inst, "done", round(time.time() - t0), "s", flush=True)


if __name__ == "__main__":
    cmd = sys.argv[1]
    {"check": check, "register": register}.get(cmd, lambda: run(sys.argv[2:] or None))()
