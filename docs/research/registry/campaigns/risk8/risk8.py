"""risk8 (#311 queue item 8, item 5 folded in): T2-conditioned stop width, sizing and exposure gating on FIXED entries,
plus fixed-vs-scheduled refit of the T2 time-of-day + volatility LR.

Runs in the bench1 venv. Evaluator v2 (de_v2, labels_v2, fills) and the ablate4/bench1 harnesses are imported, not edited.

  python risk8.py register            write prereg.json (refuses to overwrite)
  python risk8.py amend "reason"      append an amendment with new code hashes
  python risk8.py check               synthetic self-checks of the metric helpers
  python risk8.py run INST            overlays -> out/overlay_<inst>.json
  python risk8.py refit INST          item 5 -> out/refit_<inst>.json
"""
import os, sys, json, time, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
ABL = os.path.join(os.path.dirname(HERE), "ablate4")
sys.path.insert(0, ABL)
MODE = sys.argv[1] if len(sys.argv) > 1 else ""
ARG = sys.argv[2] if len(sys.argv) > 2 else "WTICO/USD"
sys.argv = [sys.argv[0], "x", ARG]  # ablate4/run.py rewrites argv for bench.py
import run as A  # noqa: E402
from run import bm, de, np, year_start_day  # noqa: E402
from labels_v2 import simulate, POLICY  # noqa: E402
from validate import day_boot, day_of  # noqa: E402
from sklearn.linear_model import Ridge, LogisticRegression  # noqa: E402

EXP = "risk8"
TODVOL = ["tod_s", "tod_c", "dow_s", "dow_c", "nday", "rv12_288", "rv48_288", "rv288", "atr_px", "atr_ratio", "range", "range3"]
KX = 6.0                       # T2 threshold fixed by ablate4 (2018 base-rate rule; 6.0 for WTI and XAU)
N_FWD = A.N_FWD                # 72
SETS = ("cfgX", "flipsA")
CFGX = (("none", None), "h1", 12)
VARIANTS = ("V1_volstop", "V2_volsize", "V3_t2stop", "V4_t2wide", "G1_gate33", "G2_gate50")
CLIP = (0.67, 1.5)
NBOOT = 1000
CVAR_Q = 0.05
NI_MARGIN = 0.03               # return non-inferiority margin, R per entry
MDD_TOL = 0.10                 # max drawdown may not exceed baseline by more than 10 % (point)
RUN_RET = 0.75                 # baseline runners retained (point)
COV_MIN = 0.50                 # gating variants: share of entries taken (point)
COSTS = (0.0, 0.02, 0.05, 0.10)
WF_FOLDS = [2019, 2020, 2021, 2022]
FIXED_CUT = 2023
TAG = ARG.replace("/", "_")
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"risk8.py": sha(os.path.join(HERE, "risk8.py"))}


# ------------------------------------------------------------------ helpers (pure; covered by `check`)
def cvar(x, q=CVAR_Q):
    x = np.sort(np.asarray(x, float))
    if not len(x):
        return np.nan
    return float(x[:max(1, int(np.ceil(q * len(x))))].mean())


def mdd(x):
    cum = np.cumsum(np.asarray(x, float))
    peak = np.maximum.accumulate(np.r_[0.0, cum])[1:]
    return float(np.max(peak - cum)) if len(cum) else 0.0


def ece(p, y, nb=10):
    qb = np.unique(np.quantile(p, np.linspace(0, 1, nb + 1)))
    k = np.clip(np.searchsorted(qb, p, side="right") - 1, 0, len(qb) - 2)
    return float(sum(abs(p[k == j].mean() - y[k == j].mean()) * (k == j).mean() for j in range(len(qb) - 1) if (k == j).any()))


def cal_slope(p, y):
    z = np.log(np.clip(p, 1e-6, 1 - 1e-6) / np.clip(1 - p, 1e-6, 1))
    lr = LogisticRegression(C=1e6, max_iter=1000).fit(z[:, None], y)
    return float(lr.coef_[0][0]), float(lr.intercept_[0])


def quarter_starts(first_year, last_day):
    out = []
    for y in range(first_year, 2100):
        for m in (1, 4, 7, 10):
            d = int(day_of(np.datetime64(f"{y}-{m:02d}-01", "m").astype(np.int64)))
            if d > last_day:
                return out
            out.append((f"{y}-{m:02d}-01", d))


def check():
    assert cvar([-3, -1, 0, 1, 2] * 4, 0.05) == -3.0 and cvar(np.arange(100.0), 0.1) == 4.5
    assert mdd([1, -2, 1, -1, 3]) == 2.0 and mdd([-1, -1]) == 2.0 and mdd([1, 1]) == 0.0
    p = np.r_[np.full(50, 0.2), np.full(50, 0.8)]; y = np.r_[np.zeros(40), np.ones(10), np.zeros(10), np.ones(40)]
    assert abs(ece(p, y)) < 1e-12
    s, b = cal_slope(np.r_[p, p], np.r_[y, y]); assert abs(s - 1) < 0.05 and abs(b) < 0.05
    q = quarter_starts(2023, int(day_of(np.datetime64("2023-08-01", "m").astype(np.int64))))
    assert [k for k, _ in q] == ["2023-01-01", "2023-04-01", "2023-07-01"]
    # overlay mechanics on a synthetic path: entry 100 (bar 1 open), ATR 1 -> base R 1.5; wider stop survives a dip
    rows = [[100] * 4, [100, 100.2, 98.3, 99], [99, 106, 98.9, 105.8]] + [[105.8] * 4] * 80
    a = np.array(rows, float)
    Bs = {"bid_o": a[:, 0], "bid_h": a[:, 1], "bid_l": a[:, 2], "bid_c": a[:, 3], "ask_o": a[:, 0], "ask_h": a[:, 1], "ask_l": a[:, 2], "ask_c": a[:, 3]}
    fl = np.zeros(len(a), int)
    base = simulate(Bs, [0], [1], [1.0], fl, POLICY)
    wide = simulate(Bs, [0], [1], [1.0 * 1.25], fl, POLICY)
    assert base["net_R"][0] == -1.0 and wide["runner"][0] and wide["net_R"][0] == 3.0
    print("risk8 self-check OK: cvar, mdd, ece, calibration slope, quarter schedule, stop-width overlay on a synthetic path")


# ------------------------------------------------------------------ data
def fwd_exc(B):
    """max(|mid high/low - close_i|) over bars i+1..i+72, in ATR_i units (continuous T2); nan when censored."""
    n = len(B["t"]); c = B["mid_c"]; hi = np.full(n, -np.inf); lo = np.full(n, np.inf)
    for j in range(1, N_FWD + 1):
        b = np.clip(np.arange(n) + j, 0, n - 1)
        hi = np.maximum(hi, B["mid_h"][b]); lo = np.minimum(lo, B["mid_l"][b])
    with np.errstate(invalid="ignore", divide="ignore"):
        e = np.maximum(hi - c, c - lo) / B["atr"]
    e[(np.arange(n) + N_FWD >= n) | ~np.isfinite(B["atr"]) | (B["atr"] <= 0)] = np.nan
    return e


def load(inst):
    m1, B, O, L = de.prep(inst, None)
    Eb = bm.eng_bars(B)
    X = np.column_stack([Eb[k] for k in TODVOL])
    big, _, _ = A.big_move(B, KX)
    exc = fwd_exc(B)
    u = A.utc_close(B)
    m = (u % 30 == 0) & de.base_active(B, O) & (B["spr"] <= de.SPR_MAX) & np.isfinite(X).all(1) & np.isfinite(big)
    i = np.where(m)[0]
    day = B["day"][i]
    S = dict(i=i, day=day, w=1.0 / np.bincount(np.unique(day, return_inverse=True)[1])[np.unique(day, return_inverse=True)[1]],
             y=big[i].astype(int), lexc=np.log(np.maximum(exc[i], 0.1)), p3=(u[i] >= A.LIQ[0]) & (u[i] <= A.LIQ[1]))
    return B, O, X, S


def fit(X, S, cut_day, start_day=None):
    """T2 LR (lr_todvol: de_v2.e2_lr_fit, 12 coefficients, day weights) and a ridge forecast of log forward excursion,
    on all-hours cadence rows whose label ends before cut_day - EMB (label horizon 72 bars < 1 day)."""
    m = S["day"] < cut_day - de.EMB
    if start_day is not None:
        m &= S["day"] >= start_day
    Xi = X[S["i"][m]]
    M = de.e2_lr_fit(Xi, S["y"][m], S["w"][m])
    mu, sd = Xi.mean(0), Xi.std(0) + 1e-12
    rg = Ridge(alpha=1.0).fit((Xi - mu) / sd, S["lexc"][m], sample_weight=S["w"][m])
    return dict(lr=M, rg=dict(mean=mu.tolist(), scale=sd.tolist(), coef=rg.coef_.tolist(), b=float(rg.intercept_)),
                cut=str(np.datetime64(int(cut_day - de.EMB), "D")), cut_day=int(cut_day), start_day=start_day,
                n=int(m.sum()), base=float(S["y"][m].mean()))


def score(F, Xr):
    p = 1 / (1 + np.exp(-de.e2_lr_raw(F["lr"], Xr)))
    r = F["rg"]
    g = np.exp((Xr - np.array(r["mean"])) / np.array(r["scale"]) @ np.array(r["coef"]) + r["b"])
    return p, g


def entries(B, O, name):
    if name == "cfgX":
        i = de.run_d(B, O, None, CFGX)["entries"]; s = B["trend"][i]
    else:
        i = np.where((B["flip"] != 0) & (B["spr"] <= de.SPR_MAX))[0]; s = B["flip"][i]
    return i, s


# ------------------------------------------------------------------ overlays
def overlay(v, p, g, prm):
    """(stop multiplier, cash weight, take) per entry for variant v; nan scores fall back to the baseline."""
    n = len(p); mult = np.ones(n); w = np.ones(n); take = np.ones(n, bool); ok = np.isfinite(p) & np.isfinite(g)
    if v == "V1_volstop":
        mult = np.where(ok, np.clip(g / prm["g_med"], *CLIP), 1.0)
    elif v == "V2_volsize":
        w = np.where(ok, np.clip(prm["g_med"] / g, *CLIP) / prm["w_norm"], 1.0)
    elif v == "V3_t2stop":
        mult = np.where(ok & (p < prm["q33"]), 0.75, np.where(ok & (p > prm["q67"]), 1.25, 1.0))
    elif v == "V4_t2wide":
        mult = np.where(ok & (p > prm["q67"]), 1.25, 1.0)
    elif v == "G1_gate33":
        take = ~(ok & (p < prm["q33"]))
    elif v == "G2_gate50":
        take = ~(ok & (p < prm["q50"]))
    return mult, w, take


def params(p, g):
    ok = np.isfinite(p) & np.isfinite(g)
    p, g = p[ok], g[ok]
    g_med = float(np.median(g))
    return dict(q33=float(np.quantile(p, 1 / 3)), q50=float(np.median(p)), q67=float(np.quantile(p, 2 / 3)), g_med=g_med,
                w_norm=float(np.mean(np.clip(g_med / g, *CLIP))), n=int(ok.sum()))


def sim(B, i, s, mult, opt=False):
    return simulate(B, i, s, B["atr"][i] * mult, B["flip"], POLICY, optimistic=opt)


def run(inst):
    t0 = time.time()
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    assert reg["code_sha256"]["risk8.py"] == CODE["risk8.py"], "risk8.py changed after registration (amend first)"
    assert reg["code_sha256"]["evaluator"] == de.CODE_SHA
    B, O, X, S = load(inst)
    last_day = int(B["day"][-1]) + 1
    res = dict(inst=inst, data_first=str(de.iso(B["t"][0])), data_last=str(de.iso(B["t"][-1])), evaluator=de.CODE_SHA,
               risk8=CODE["risk8.py"], note="development evidence; 2023+ is a development window, never a holdout", artifacts={}, sets={})
    folds = [(y, year_start_day(y), year_start_day(y + 1)) for y in WF_FOLDS] + [(FIXED_CUT, year_start_day(FIXED_CUT), last_day)]
    models = {}
    for y, lo, _ in folds:
        F = fit(X, S, lo); models[y] = F
        res["artifacts"][str(y)] = dict(train_cutoff=F["cut"], rows=F["n"], base=F["base"], coef=F["lr"]["coef"], rg_coef=F["rg"]["coef"])
    for name in SETS:
        i_all, s_all = entries(B, O, name)
        base_all = sim(B, i_all, s_all, np.ones(len(i_all)))
        keep = base_all["ok"]
        i_all, s_all = i_all[keep], s_all[keep]
        pall = {}
        per = {"dev2019_22": [], "w2023": []}
        res["sets"][name] = dict(entries=int(len(i_all)), folds={})
        for y, lo, hi in folds:
            F = models[y]
            pr = np.where(B["day"][i_all] < lo)[0]
            Xp = X[i_all[pr]]; fin = np.isfinite(Xp).all(1)
            pp, gp = np.full(len(pr), np.nan), np.full(len(pr), np.nan)
            pp[fin], gp[fin] = score(F, Xp[fin])
            prm = params(pp, gp)
            te = np.where((B["day"][i_all] >= lo) & (B["day"][i_all] < hi))[0]
            i, s = i_all[te], s_all[te]
            Xt = X[i]; fin = np.isfinite(Xt).all(1)
            p, g = np.full(len(i), np.nan), np.full(len(i), np.nan)
            p[fin], g[fin] = score(F, Xt[fin])
            rows = dict(i=i, s=s, day=B["day"][i], p=p, g=g)
            for v in ("BASE",) + VARIANTS:
                mult, w, take = overlay(v, p, g, prm) if v != "BASE" else (np.ones(len(i)), np.ones(len(i)), np.ones(len(i), bool))
                take = take & (B["spr"][i] <= de.SPR_MAX * mult)  # spread rule against the variant's own R
                Sv, So = sim(B, i, s, mult), sim(B, i, s, mult, True)
                okv = Sv["ok"]
                net = np.where(okv, Sv["net_R"], 0.0); neto = np.where(So["ok"], So["net_R"], 0.0)
                rows[v] = dict(mult=mult, w=w, take=take & okv, net=net, net_opt=neto, runner=Sv["runner"] & take & okv,
                               bars=np.where(take & okv, Sv["exit_bar"] - i, 0), amb=Sv["amb"] & take)
            res["sets"][name]["folds"][str(y)] = dict(test_entries=int(len(i)), params=prm, train_cutoff=F["cut"])
            per["dev2019_22" if y < FIXED_CUT else "w2023"].append((rows, lo, hi))
        res["sets"][name]["windows"] = {}
        for part, lst in per.items():
            R = {k: np.concatenate([r[k] for r, _, _ in lst]) for k in ("i", "s", "day", "p", "g")}
            for v in ("BASE",) + VARIANTS:
                R[v] = {k: np.concatenate([r[v][k] for r, _, _ in lst]) for k in lst[0][0][v]}
            all_days = np.unique(np.concatenate([de.window_bars(B, lo, hi)[2] for _, lo, hi in lst]))
            res["sets"][name]["windows"][part] = report(R, all_days, inst, name, part)
            print(inst, name, part, "done", round(time.time() - t0), "s", flush=True)
    res["secs"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(OUT, f"overlay_{TAG}.json"), "w"), indent=1, default=float)


def report(R, all_days, inst, name, part):
    b = R["BASE"]
    cb = np.where(b["take"], b["net"], 0.0)
    n = len(cb)
    o = dict(n_entries=int(n), score_missing=int((~np.isfinite(R["p"])).sum()), days=int(len(all_days)),
             base=dict(meanR=float(cb.mean()), runners=int(b["runner"].sum()), winners=int((cb > 0).sum())), variants={})
    ent_days = np.unique(R["day"])
    dpos = np.searchsorted(ent_days, R["day"])
    for v in ("BASE",) + VARIANTS:
        x = R[v]
        c = np.where(x["take"], x["w"] * x["net"], 0.0)
        co = np.where(x["take"], x["w"] * x["net_opt"], 0.0)
        dc, dcb = np.bincount(dpos, c, len(ent_days)), np.bincount(dpos, cb, len(ent_days))
        winb, runb = cb > 0, b["runner"]

        def tstat(ix):
            cc, bb = c[ix], cb[ix]
            return [cc.mean(), cc.mean() - bb.mean(), cvar(cc), (cc < -1 - 1e-9).mean(),
                    ((cc > 0) & winb[ix]).sum() / max(1, winb[ix].sum()), (x["runner"][ix] & runb[ix]).sum() / max(1, runb[ix].sum())]

        def dstat(ix):
            a_, b_ = dc[ix], dcb[ix]
            return [cvar(a_), cvar(a_) - cvar(b_), mdd(a_), mdd(a_) - mdd(b_)]
        bt = np.array(day_boot(R["day"], all_days, tstat, NBOOT))
        bd = np.array(day_boot(ent_days, all_days, dstat, NBOOT))
        cis = lambda a: [[float(np.nanpercentile(a[:, k], 2.5)), float(np.nanpercentile(a[:, k], 97.5))] for k in range(a.shape[1])]
        T, D = tstat(np.arange(n)), dstat(np.arange(len(ent_days)))
        tci, dci = cis(bt), cis(bd)
        taken = x["take"]
        r = dict(
            meanR_entry=[T[0], tci[0]], diff_vs_base=[T[1], tci[1]],
            meanR_taken=float(c[taken].mean()) if taken.any() else None,
            cvar5_trade=[T[2], tci[2]], loss_beyond_1R_share=[T[3], tci[3]], loss_beyond_1p5R_share=float((c < -1.5).mean()),
            winners_retained=[T[4], tci[4]], runners_retained=[T[5], tci[5]],
            runner_count_ratio=float(x["runner"].sum() / max(1, runb.sum())),
            daily_cvar5=[D[0], dci[0]], daily_cvar5_diff=[D[1], dci[1]], maxdd=[D[2], dci[2]], maxdd_diff=[D[3], dci[3]],
            maxdd_base=float(mdd(dcb)), total_R=float(c.sum()),
            coverage=float(taken.mean()), exposure_bars_ratio=float((x["bars"] * x["w"]).sum() / max(1, b["bars"].sum())),
            mult=dict(mean=float(x["mult"].mean()), at_lo=float((x["mult"] <= CLIP[0] + 1e-9).mean()), at_hi=float((x["mult"] >= CLIP[1] - 1e-9).mean())),
            w=dict(mean=float(x["w"].mean()), min=float(x["w"].min()), max=float(x["w"].max())),
            opt_bound_meanR=float(co.mean()), ambiguous_share=float(x["amb"].mean()),
            cost={str(k): float((c - np.where(taken, x["w"] * k / x["mult"], 0)).mean()) for k in COSTS},
            by_year={str(yy): float(c[(R["day"] >= year_start_day(yy)) & (R["day"] < year_start_day(yy + 1))].mean())
                     for yy in range(2019, 2027) if ((R["day"] >= year_start_day(yy)) & (R["day"] < year_start_day(yy + 1))).any()})
        if v != "BASE":
            gate = v.startswith("G")
            r["objective"] = dict(
                risk_improved=bool(dci[1][0] > 0), return_noninferior=bool(tci[1][0] > -NI_MARGIN),
                mdd_ok=bool(D[2] <= (1 + MDD_TOL) * mdd(dcb)), runners_ok=bool(T[5] >= RUN_RET),
                coverage_ok=bool(r["coverage"] >= COV_MIN) if gate else True)
            r["objective"]["all"] = all(r["objective"].values())
        o["variants"][v] = r
        de.log_trial({"exp": EXP, "mode": "dev" if part == "dev2019_22" else "devwindow2023", "inst": inst, "set": name, "variant": v,
                      "window": part, "meanR": T[0], "diff": T[1], "daily_cvar5_diff": D[1], "coverage": r["coverage"],
                      "risk8_sha256": CODE["risk8.py"]})
    return o


# ------------------------------------------------------------------ item 5: fixed vs scheduled refit
def paired_auc(y, sa, sb, day, rng, nb=500):
    ud, inv = np.unique(day, return_inverse=True)
    rows = [np.where(inv == k)[0] for k in range(len(ud))]
    d0 = bm.auc(y, sa) - bm.auc(y, sb); bs = []
    for _ in range(nb):
        ix = np.concatenate([rows[k] for k in rng.integers(0, len(ud), len(ud))])
        bs.append(bm.auc(y[ix], sa[ix]) - bm.auc(y[ix], sb[ix]))
    return [float(d0), float(np.nanpercentile(bs, 2.5)), float(np.nanpercentile(bs, 97.5))]


def refit(inst):
    t0 = time.time()
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    assert reg["code_sha256"]["risk8.py"] == CODE["risk8.py"], "risk8.py changed after registration (amend first)"
    B, O, X, S = load(inst)
    last_day = int(B["day"][-1]) + 1
    a_day = int(S["day"][0])
    rng = np.random.default_rng(31)
    Q = quarter_starts(FIXED_CUT, last_day)
    sched = {"fixed": None, "refit_q_expanding": "expanding", "refit_q_rolling3y": "rolling3y"}
    P = {k: np.full(len(S["i"]), np.nan) for k in sched}
    arts = {k: [] for k in sched}
    F = fit(X, S, year_start_day(FIXED_CUT))
    m = S["day"] >= year_start_day(FIXED_CUT)
    P["fixed"][m] = score(F, X[S["i"][m]])[0]
    arts["fixed"].append(dict(train_cutoff=F["cut"], train_start=str(np.datetime64(a_day, "D")), rows=F["n"], base=F["base"], coef=F["lr"]["coef"]))
    for k, kind in sched.items():
        if kind is None:
            continue
        for qi, (qs, qd) in enumerate(Q):
            qe = Q[qi + 1][1] if qi + 1 < len(Q) else last_day
            st = qd - int(3 * 365.25) if kind == "rolling3y" else None
            Fq = fit(X, S, qd, st)
            mm = (S["day"] >= qd) & (S["day"] < qe)
            P[k][mm] = score(Fq, X[S["i"][mm]])[0]
            arts[k].append(dict(applies_from=qs, train_cutoff=Fq["cut"], train_start=str(np.datetime64(st if st else a_day, "D")),
                                rows=Fq["n"], base=Fq["base"], coef=Fq["lr"]["coef"]))
    res = dict(inst=inst, artifacts=arts, by_year={}, note="development window 2023+; fixed = fitted once on 2018-2022")
    for pop in ("all_hours", "p3"):
        for yy in range(FIXED_CUT, 2027):
            mm = (S["day"] >= year_start_day(yy)) & (S["day"] < year_start_day(yy + 1))
            if pop == "p3":
                mm &= S["p3"]
            if mm.sum() < 50:
                continue
            y = S["y"][mm]; d = S["day"][mm]
            o = dict(n=int(mm.sum()), base=float(y.mean()), models={})
            for k in sched:
                p = P[k][mm]
                sl, ic = cal_slope(p, y)
                o["models"][k] = dict(auc=A.auc_ci(y, p, d, rng), brier=float(np.mean((p - y) ** 2)),
                                      logloss=float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))), mean_p=float(p.mean()),
                                      cal_in_large=float(p.mean() - y.mean()), cal_slope=sl, cal_intercept=ic, ece=ece(p, y))
                if k != "fixed":
                    o["models"][k]["auc_minus_fixed"] = paired_auc(y, p, P["fixed"][mm], d, rng)
                    o["models"][k]["brier_minus_fixed"] = float(np.mean((p - y) ** 2) - np.mean((P["fixed"][mm] - y) ** 2))
                de.log_trial({"exp": EXP + "-refit", "mode": "devwindow2023", "inst": inst, "pop": pop, "year": yy, "schedule": k,
                              "auc_test": o["models"][k]["auc"][0], "risk8_sha256": CODE["risk8.py"]})
            res["by_year"][f"{pop}/{yy}"] = o
            print(inst, pop, yy, {k: round(v["auc"][0], 3) for k, v in o["models"].items()},
                  {k: round(v["cal_in_large"], 3) for k, v in o["models"].items()}, flush=True)
    res["secs"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(OUT, f"refit_{TAG}.json"), "w"), indent=1, default=float)


# ------------------------------------------------------------------ registration
def register(amend=None):
    Pf = os.path.join(HERE, "prereg.json")
    hashes = dict(evaluator=de.CODE_SHA, evaluator_files=de.CODE_FILES_SHA, **{"risk8.py": CODE["risk8.py"], "bench.py": bm.CODE["bench.py"],
                  "ablate4/run.py": sha(os.path.join(ABL, "run.py")), "fm2/fm2.py": sha(os.path.join(os.path.dirname(HERE), "fm2", "fm2.py"))})
    if amend:
        reg = json.load(open(Pf))
        reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=amend, code_sha256=hashes))
        reg["code_sha256"] = hashes
        json.dump(reg, open(Pf, "w"), indent=1); return
    assert not os.path.exists(Pf), "prereg.json exists; amend instead"
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="risk8: T2-conditioned stop width, sizing and exposure gating on fixed entries (#311 queue item 8) + fixed vs "
              "scheduled refit of the T2 LR (queue item 5)",
        question="Can the side-free big-move forecast (T2) improve the RISK of fixed entries through stop width and sizing, at "
                 "non-inferior return, although it cannot pick direction?",
        before_registration="Looked at entry-set sizes and UTC hours only (explore.py; no outcomes): WTI cfgX 4631 entries, 79 % "
                            "inside 07:00-20:30 UTC; flipsA 7864, 85 %. Hence the T2 model is fitted on an ALL-HOURS cadence "
                            "sample (P3 covers only 07:00-20:30). No overlay outcome or refit score was computed before this file.",
        entry_sets=dict(cfgX="unselected D-nogate entries: de_v2.run_d cfg (none, h1, W 12), one entry per episode, no overlap, "
                             "spread <= 0.2 R at the decision bar",
                        flipsA="every M5 supertrend flip bar with spread <= 0.2 R; side = flip; overlapping trades allowed "
                               "(matched-entry diagnostic, not a capital replay)",
                        common="entries with an uncensored baseline outcome; identical entries for every variant"),
        management="308 baseline policy (labels_v2.simulate, POLICY k=1.5, m=1, T=3, H=72, flip exit, one-bar modification "
                   "latency, conservative intrabar ordering, bid/ask fills). A variant changes only the stop distance "
                   "(R = 1.5 x ATR x mult); arm (+1R), breakeven and the 3R target stay in R units of the variant. Labels "
                   "(arm/runner/net R) are regenerated per variant by re-simulation (311 rule). The T2 label is side- and "
                   "policy-free, so it is not regenerated.",
        spread_rule="a variant stands aside when spread > 0.2 x its own R (only binds when mult < 1)",
        cash="equal cash risk: 1 cash unit at the variant's stop, so cash return = net R of the variant; V2 scales cash risk by "
             "w (mean ~1); stood-aside entries return 0",
        t2_model=dict(
            name="lr_todvol",
            features=TODVOL,
            learner="de_v2.e2_lr_fit (standardized L2 LR, C=0.1), day weights 1/rows-per-day, 12 coefficients + intercept; "
                    "probability = sigmoid(raw); no separate calibrator",
            label=f"T2: mid high/low over bars i+1..i+{N_FWD} reaches close_i +/- {KX} ATR_i (ablate4 KX)",
            fit_rows="all-hours cadence: every M5 bar closing on :00/:30 UTC, base_active, spread <= 0.2 R, finite features, "
                     "uncensored; label end before cutoff - 5 days",
            vol_forecast="ridge (alpha 1) of log(max(forward 72-bar max |excursion| / ATR, 0.1)) on the same 12 standardized "
                         "features, same rows and weights; g = exp(prediction)",
            schedule="overlays: walk-forward annual refit for test years 2019-2022 (expanding from 2018); one fixed fit on "
                     "2018-2022 for 2023+. Overlay parameters (quantiles, medians, normalizer) from the same set's entries "
                     "BEFORE the test year, scored by that fold's model"),
        variants={
            "V1_volstop": "stop mult = clip(g / median_prior(g), 0.67, 1.5); equal cash risk (vol-targeted 1R)",
            "V2_volsize": "stop unchanged; cash weight w = clip(median_prior(g) / g, 0.67, 1.5) / mean_prior(same) (size down "
                          "when forecast vol is high relative to ATR)",
            "V3_t2stop": "stop mult 0.75 if p < q33_prior, 1.25 if p > q67_prior, else 1",
            "V4_t2wide": "stop mult 1.25 if p > q67_prior, else 1",
            "G1_gate33": "stand aside if p < q33_prior (changes the population; reported separately)",
            "G2_gate50": "stand aside if p < median_prior (changes the population; reported separately)"},
        budget=dict(variants=len(VARIANTS), entry_sets=2, instruments="WTI primary, XAU if time permits", models="lr_todvol + ridge vol "
                    "forecast, no tuning", clip=list(CLIP), thresholds="terciles/median fixed in advance",
                    refit_schedules=2, note="development windows only; no multiplicity correction; every cell logged (exp risk8)"),
        objective=dict(
            kind="risk-reduction overlay with predeclared return non-inferiority (#307 allows; it can never confer economic "
                 "qualification: the baselines are not qualified against no-trade)",
            primary_risk="daily CVaR 5 % of cash P&L over days with at least one entry of the set (paired, same days): variant "
                         "minus baseline, 95 % 5-day moving-block bootstrap CI lower bound > 0",
            return_noninferiority=f"paired mean cash return per entry, variant minus baseline: CI lower bound > -{NI_MARGIN} R",
            constraints=f"max drawdown (day-level, cash) <= (1 + {MDD_TOL}) x baseline (point); baseline runners retained >= "
                        f"{RUN_RET} (point); gating variants: coverage >= {COV_MIN}",
            decision_window="2023-01-01..newest DEVELOPMENT window (fixed 2018-2022 model). Consistency: in walk-forward 2019-2022 "
                            "the risk-difference point estimate is > 0 and the return difference point estimate > -margin. Both "
                            "required for 'meets the risk objective'. Evaluated per entry set and instrument.",
            no_switch="objective, margin and constraints fixed here; not changed after results"),
        report="per variant and window: net R per entry (and per taken trade), net return under equal cash risk, max drawdown, "
               "per-trade CVaR 5 %, daily CVaR 5 %, share of entries losing beyond 1R (and 1.5R), winners and runners retained, "
               "coverage, exposure (cash-weighted bars held vs baseline), optimistic-ordering bound, cost sensitivity "
               "0/0.02/0.05/0.10 base-R (price slippage, so x 1/mult in variant R); 1000-rep 5-day moving-block CIs; paired vs "
               "baseline on identical entries",
        item5=dict(
            question="fixed lr_todvol (fit once on 2018-2022) vs frozen scheduled refits: AUC and calibration drift by year",
            schedules={"fixed": "one fit, cutoff 2023-01-01 - 5 days",
                       "refit_q_expanding": "refit at every calendar quarter start from 2023-01-01, on all rows with label end "
                                            "< quarter start - 5 days (expanding from 2018)",
                       "refit_q_rolling3y": "same, trailing 3 years only"},
            populations="all-hours cadence rows (fit population) and its P3 subset (07:00-20:30 UTC, comparable to fm2)",
            metrics="AUC with day-bootstrap CI, paired AUC difference vs fixed, Brier, log loss, calibration-in-the-large, "
                    "calibration slope/intercept, ECE (10 equal-frequency bins), per calendar year 2023-2026; every artifact "
                    "recorded with its training cutoff"),
        rules="no test_ledger use; nothing is marked qualified; development evidence only",
        code_sha256=hashes)
    json.dump(reg, open(Pf, "w"), indent=1)


if __name__ == "__main__":
    if MODE == "register":
        register()
    elif MODE == "amend":
        register(ARG)
    elif MODE == "check":
        check()
    elif MODE == "run":
        run(ARG)
    elif MODE == "refit":
        refit(ARG)
