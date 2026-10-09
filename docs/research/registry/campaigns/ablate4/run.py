"""ablate4 (#310 queue item 4): candidate-population x target ablation, learner and evaluator held fixed.

Populations (side = the M5 supertrend trend at the row's bar, as in D):
  P1   frozen D candidates (WTI: fired 0.9, brk, W 48)                          entry-capable (cfg P1)
  P2   broader no-gate H1-confirmation candidates (cfgX: none, h1, W 12)          entry-capable (cfg P2)
  P3   fixed-cadence market-state sample: every bar closing on :00/:30 UTC inside 07:00-20:30 UTC, spread <= 0.2 R,
       finite ATR and outcomes; no supertrend/impulse/gate trigger                learnability only (no confirmation)
  P3c  P3 rows that are also price-confirmed (H1 trend agrees) and inside a trend episode, first eligible one per
       episode-day, not busy: cfg (none, h1cad, 288)                             entry-capable
Targets:
  T1   y_arm: +1R before the stop within H=72 (308 contract, existing)
  T2   side-free big move: max(|mid excursion| up, down) over bars i+1..i+72 >= KX x ATR_i (KX fixed by the
       registered 2018 base-rate rule, see prereg)
  T3   direction given a big move: 1 if the first KX x ATR passage is on the row's side (rows with T2 = 1 and an
       unambiguous first passage only)
  T4   sign of side-specific net R under the 308 management policy (net_R > 0); Spearman of score vs net_R reported
Learners: lr_base, lr_eng, hgb_eng from audit/bench1/bench.py (unchanged).
Evaluator: de_v2 + labels_v2, V4 E stage via bench.evaluate (unchanged). The only runtime extension is one extra
confirm rule "h1cad" (= h1 & cadence mask) registered into de_v2.confirm_mask for cfg P3c; the evaluator files are
not edited.
Folds: purged walk-forward test years 2019-2022 (gate and learners fitted before the year) + 2023..newest
DEVELOPMENT window. No ledger, no verdicts, nothing is a holdout.

  python run.py register           write prereg.json (refuses to overwrite)
  python run.py amend "reason"     append an amendment with new code hashes
  python run.py run INST           all cells -> out/<inst>.json
"""
import os, sys, json, time, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.join(os.path.dirname(HERE), "bench1")
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
sys.path.insert(0, BENCH)
MODE = sys.argv[1] if len(sys.argv) > 1 else ""
sys.argv = [sys.argv[0], "ablate4"] + sys.argv[2:]  # bench.py reads argv[1]; "ablate4" = campaign trials log
import numpy as np
import bench as bm
from bench import de, Bench, evaluate
from scipy.stats import spearmanr
from validate import year_start_day

EXP = "ablate4"
N_FWD = 72                        # T2/T3 horizon = the policy horizon H
KX_GRID = (3.0, 4.5, 6.0)         # ATR multiples; one is fixed by the 2018 base-rate rule
KX_TARGET_RATE = 1 / 3
LIQ = (7 * 60, 20 * 60 + 30)      # UTC minutes of the bar close, inclusive
CADENCE = 30
FOLDS = [2019, 2020, 2021, 2022, 2023]
LEARNERS = ("lr_base", "lr_eng", "hgb_eng")
TARGETS = ("T1", "T2", "T3", "T4")
COSTS = (0.0, 0.02, 0.05, 0.10)
NBOOT_AUC = 300
CFGS = {"WTICO/USD": {"P1": (("fired", 0.9), "brk", 48), "P2": (("none", None), "h1", 12), "P3c": (("none", None), "h1cad", 288)},
        "XAU/USD": {"P1": (("none", None), "h1", 12), "P3c": (("none", None), "h1cad", 288)}}
CODE = {f: hashlib.sha256(open(os.path.join(HERE, f), "rb").read()).hexdigest() for f in ("run.py",)}


# ------------------------------------------------------------------ labels and populations
def utc_close(B):
    return (B["tod"] + 5 - 120) % 1440  # tod counts from 22:00 UTC


def cadence_mask(B):
    u = utc_close(B)
    return (u % CADENCE == 0) & (u >= LIQ[0]) & (u <= LIQ[1])


def big_move(B, kx):
    """T2 and T3 per bar (side = B['trend']). Mid prices; path = bars i+1..i+N_FWD; nan when censored.
    Returns big (float, nan censored), first-passage direction (+1 up, -1 down, 0 none/ambiguous), end bar."""
    n = len(B["t"]); c, h, l, a = B["mid_c"], B["mid_h"], B["mid_l"], B["atr"]
    up, dn = c + kx * a, c - kx * a
    first = np.zeros(n, np.int8); done = np.zeros(n, bool)
    hi = np.full(n, -np.inf); lo = np.full(n, np.inf)
    for j in range(1, N_FWD + 1):
        b = np.clip(np.arange(n) + j, 0, n - 1)
        hu, hd = h[b] >= up, l[b] <= dn
        new = ~done & (hu | hd)
        first[new & hu & ~hd] = 1; first[new & hd & ~hu] = -1  # both in one bar: ambiguous (0)
        done |= new
        hi = np.maximum(hi, h[b]); lo = np.minimum(lo, l[b])
    big = done.astype(float)
    cens = (np.arange(n) + N_FWD >= n) | ~np.isfinite(a) | (a <= 0)
    big[cens] = np.nan
    return big, first, np.minimum(np.arange(n) + N_FWD, n - 1)


def choose_kx(B):
    """Registered rule: KX in KX_GRID whose T2 base rate over the 2018 cadence sample is closest to 1/3 (label
    definition only; uses no feature, model or post-2018 data)."""
    m = cadence_mask(B) & (B["day"] < year_start_day(2019))
    rates = {}
    for kx in KX_GRID:
        big, _, _ = big_move(B, kx)
        v = big[m]; rates[kx] = float(np.nanmean(v))
    kx = min(KX_GRID, key=lambda k: abs(rates[k] - KX_TARGET_RATE))
    return kx, rates


def register_h1cad(cad):
    orig = de.confirm_mask

    def cm(B, conf):
        if conf == "h1cad":
            return (B["tr_H1"] == B["trend"]) & cad
        return orig(B, conf)
    de.confirm_mask = cm


def p3_rows(B, O, cad):
    m = cad & de.base_active(B, O) & (B["spr"] <= de.SPR_MAX)
    i = np.where(m)[0]
    T = de.trades(B, O, i)
    T["ep"] = np.unique(B["day"][i], return_inverse=True)[1]  # cluster = trading day
    T["w"] = 1.0 / np.bincount(T["ep"])[T["ep"]]
    T["y"] = T["arm"].astype(int)
    return T


def with_target(B, C, tgt, LAB):
    """Copy of C with y = target and exit_day = max(trade exit, label horizon end); lab_ok = defined label."""
    i, s = C["i"], C["s"]
    big, first, endb = LAB
    Ct = dict(C)
    Ct["exit_day"] = np.maximum(C["exit_day"], B["day"][endb[i]])
    if tgt == "T1":
        y = C["arm"].astype(float)
    elif tgt == "T2":
        y = big[i]
    elif tgt == "T3":
        y = np.where((big[i] == 1) & (first[i] != 0), (first[i] == s).astype(float), np.nan)
    else:
        y = np.where(np.isfinite(C["net"]), (C["net"] > 0).astype(float), np.nan)
    ok = np.isfinite(y)
    Ct["y"] = np.nan_to_num(y).astype(int)
    return Ct, ok


# ------------------------------------------------------------------ metrics
def auc_ci(y, s, day, rng):
    m = np.isfinite(s); y, s, day = y[m], s[m], day[m]
    a = bm.auc(y, s)
    if not np.isfinite(a):
        return a, [np.nan, np.nan]
    ud, inv = np.unique(day, return_inverse=True)
    rows = [np.where(inv == k)[0] for k in range(len(ud))]
    bs = []
    for _ in range(NBOOT_AUC):
        ix = np.concatenate([rows[k] for k in rng.integers(0, len(ud), len(ud))])
        bs.append(bm.auc(y[ix], s[ix]))
    return a, [float(np.nanpercentile(bs, 2.5)), float(np.nanpercentile(bs, 97.5))]


def diag_cal(z_pool, y_pool, g_pool, z_test, y_test):
    """Diagnostic Platt on the V4 pooled window (no guard), applied to the test rows: reliability with support."""
    if len(z_pool) < 50 or y_pool.min() == y_pool.max():
        return None
    c = de.platt_ci(z_pool, y_pool, g_pool)
    p = de.e2_prob(c, z_test)
    qb = tuple(np.unique(np.r_[0.0, np.quantile(p, [0.2, 0.4, 0.6, 0.8]), 1.01]))
    return dict(platt=dict(slope=c["slope"], slope_ci=c["slope_ci"]), scores=de.scores(p, y_test), rel=de.reliability(p, y_test, qb))


# ------------------------------------------------------------------ run
def run(inst):
    t0 = time.time()
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    assert reg["code_sha256"]["run.py"] == CODE["run.py"], "run.py changed after registration (amend first)"
    assert reg["code_sha256"]["evaluator"] == de.CODE_SHA and reg["code_sha256"]["bench.py"] == bm.CODE["bench.py"]
    cfgs = CFGS[inst]
    m1, B, O, L = de.prep(inst, None)
    Eb = bm.eng_bars(B); bm.eng_bars = lambda _B: Eb  # identical per-bar features for every population (memo)
    cad = cadence_mask(B); register_h1cad(cad)
    kx, rates = choose_kx(B)
    LAB = big_move(B, kx)
    last_day = int(B["day"][-1]) + 1; a_day = int(B["day"][0])
    rng = np.random.default_rng(11)
    res = dict(inst=inst, data_first=str(de.iso(B["t"][0])), data_last=str(de.iso(B["t"][-1])), kx=kx, kx_rates_2018=rates,
               evaluator=de.CODE_SHA, bench=bm.CODE["bench.py"], run=CODE["run.py"], folds={},
               note="development evidence; 2023+ is a development window, not a holdout")
    pops = list(cfgs) + ["P3"]
    keepT = {}   # (pop, tgt, learner, part) -> registered trade sets ; curves
    keepC = {}
    keepD = {}   # (pop, fold) -> unselected policy trades; paired with exactly the folds a cell covers
    keepW = {}
    keepS = {}   # pooled test scores for pooled AUC
    for y in FOLDS:
        lo = year_start_day(y); hi = year_start_day(y + 1) if y < 2023 else last_day
        part = "dev" if y < 2023 else "w23"
        GS = de.gate_states(B, L, de.fit_gate(L, lo - de.EMB))
        te = lambda T: de.sel(T, (T["day"] >= lo) & (T["day"] < hi))
        _, _, all_days = de.window_bars(B, lo, hi)
        years = (hi - lo) / 365.25
        fr = {}
        R3 = de.run_d(B, O, GS, cfgs["P3c"])
        for pop in pops:
            if pop == "P3":
                cfg, R, C = None, R3, p3_rows(B, O, cad)
            else:
                cfg = cfgs[pop]; R = R3 if pop == "P3c" else de.run_d(B, O, GS, cfg); C = de.candidates(B, O, R, cfg[2])
            F = de.e_features(B, GS, R["ep"])
            bench = Bench(B, F, C)
            TD = te(de.trades(B, O, R["entries"])) if cfg else None
            if cfg:
                keepD[(pop, y)] = TD; keepW[y] = all_days
            fr[pop] = dict(rows=int(len(C["i"])), ok=int(bench.ok.sum()),
                           D=dict(trades=int(len(TD["i"])), meanR=float(TD["net"].mean()) if len(TD["i"]) else None) if cfg else None, cells={})
            for tgt in TARGETS:
                Ct, lab = with_target(B, C, tgt, LAB)
                ok = bench.ok & lab
                bench.C = Ct
                tst = (Ct["day"] >= lo) & (Ct["day"] < hi) & ok
                fitm, pool, _ = bm.v4_fit_mask(Ct, ok, a_day, lo)
                for name in LEARNERS:
                    t1 = time.time()
                    bench.cache = {}; bench.logs = {}
                    fit = bench.fitter(name)
                    r = dict(rows=dict(fit=int(fitm.sum()), pool=int(pool.sum()), test=int(tst.sum()),
                                       test_base=float(Ct["y"][tst].mean()) if tst.any() else None))
                    if fitm.sum() >= 50 and tst.sum() > 10:
                        sb = fit(fitm)
                        st = sb[Ct["i"][tst]]; yt = Ct["y"][tst]
                        r["auc"], r["auc_ci"] = auc_ci(yt, st, Ct["day"][tst], rng)
                        r["auc_side"] = {str(s): bm.auc(yt[Ct["s"][tst] == s], st[Ct["s"][tst] == s]) for s in (1, -1)}
                        if tgt == "T4":
                            nt = Ct["net"][tst]; mm = np.isfinite(st) & np.isfinite(nt)
                            r["spearman_netR"] = float(spearmanr(st[mm], nt[mm])[0]) if mm.sum() > 10 else None
                        zp = sb[Ct["i"][pool]]; mp = np.isfinite(zp)
                        r["cal"] = diag_cal(zp[mp], Ct["y"][pool][mp], Ct["ep"][pool][mp], st[np.isfinite(st)], yt[np.isfinite(st)])
                        keepS.setdefault((pop, tgt, name, part), []).append((st, yt, Ct["day"][tst]))
                    if cfg:
                        ev, S, TE = evaluate(fit, B, O, GS, cfg, Ct, ok, a_day, lo, tst, te, TD, all_days, years, verdict=False)
                        r.update(cause=ev["cause"], cut=ev.get("cut"), thr={k: v for k, v in ev.get("thr", {}).items() if k in ("q", "thr_meanR", "thr_trades", "D_meanR")},
                                 slope_ci=(ev.get("cal") or {}).get("slope_ci"))
                        if TE is not None:
                            r["trades"] = int(len(TE["i"])); r["meanR"] = float(TE["net"].mean()) if len(TE["i"]) else None
                            keepT.setdefault((pop, tgt, name, part), []).append((y, TE))
                        if fitm.sum() >= 50:
                            sb = fit(fitm); sbar = np.nan_to_num(sb, nan=-np.inf); zt = sb[Ct["i"][pool]]; zt = zt[np.isfinite(zt)]
                            if len(zt):
                                for q in de.E2_QGRID:
                                    Tq = te(de.trades(B, O, de.run_d(B, O, GS, cfg, extra=sbar >= float(np.quantile(zt, 1 - q)))["entries"]))
                                    keepC.setdefault((pop, tgt, name, part, q), []).append((y, Tq))
                    r["log"] = bench.logs.get(name); r["secs"] = round(time.time() - t1, 1)
                    fr[pop]["cells"][f"{tgt}/{name}"] = r
                    de.log_trial({"exp": EXP, "mode": "dev" if part == "dev" else "devwindow2023", "inst": inst, "pop": pop, "target": tgt,
                                  "fold": y, "learner": name, "kx": kx, "cause": r.get("cause"), "auc_test": r.get("auc"),
                                  "hyper": {k: v for k, v in (r.get("log") or {}).items() if k in ("n_iter",)},
                                  "test_trades": r.get("trades", 0), "bench_sha256": bm.CODE["bench.py"], "run_sha256": CODE["run.py"]})
                    print(inst, y, pop, tgt, name, r.get("cause", "-"), "auc", r.get("auc"), "trades", r.get("trades"), r["secs"], flush=True)
        res["folds"][str(y)] = fr
    # pooled summaries
    res["pooled"] = {}

    def paired(pop, lst):
        """Trades of a cell over the folds it covers, the unselected policy over exactly those folds, and their days."""
        ys = [y for y, _ in lst]
        days = np.unique(np.concatenate([keepW[y] for y in ys]))
        return de.cat([T for _, T in lst]), de.cat([keepD[(pop, y)] for y in ys]), days, ys

    for part, (lo, hi) in (("dev", (year_start_day(2019), year_start_day(2023))), ("w23", (year_start_day(2023), last_day))):
        fy = [y for y in FOLDS if (y < 2023) == (part == "dev")]
        out = {}
        for pop in pops:
            po = {}
            if all((pop, y) in keepD for y in fy):
                TD, _, days, _ = paired(pop, [(y, keepD[(pop, y)]) for y in fy])
                po["D"] = dict(trades=int(len(TD["i"])), meanR=float(TD["net"].mean()), ci=de.boot_mean(TD, days)[0],
                               cost={str(k): float(TD["net"].mean()) - k for k in COSTS})
            for tgt in TARGETS:
                for name in LEARNERS:
                    o = {}
                    sc = keepS.get((pop, tgt, name, part))
                    if sc:
                        st, yy, dd = (np.concatenate([x[j] for x in sc]) for j in range(3))
                        o["auc"], o["auc_ci"] = auc_ci(yy, st, dd, rng); o["n"] = int(len(yy)); o["base"] = float(yy.mean())
                    if (pop, tgt, name, part) in keepT:
                        TE, TDp, days, ys = paired(pop, keepT[(pop, tgt, name, part)])
                        if len(TE["i"]) >= 2:
                            o["registered"] = dict(folds_available=ys, trades=int(len(TE["i"])), meanR=float(TE["net"].mean()),
                                                   ci=de.boot_mean(TE, days)[0], D_same_folds=float(TDp["net"].mean()),
                                                   vs_D=de.diff_ci(TE, TDp, days)[:2])
                    cov = {}
                    for q in de.E2_QGRID:
                        lst = keepC.get((pop, tgt, name, part, q))
                        if not lst:
                            continue
                        T, TDp, days, ys = paired(pop, lst)
                        if len(T["i"]) < 2:
                            cov[str(q)] = dict(trades=int(len(T["i"]))); continue
                        c = de.boot_mean(T, days)[0]
                        cov[str(q)] = dict(folds=ys, trades=int(len(T["i"])), meanR=float(T["net"].mean()), ci=c,
                                           D_same_folds=dict(trades=int(len(TDp["i"])), meanR=float(TDp["net"].mean())),
                                           vs_D=de.diff_ci(T, TDp, days)[:2],
                                           cost={str(k): [float(T["net"].mean()) - k, c[0] - k] for k in COSTS},
                                           losers=float((T["net"] < 0).mean()), runner=float(T["runner"].mean()))
                    if cov:
                        o["coverage"] = cov
                    po[f"{tgt}/{name}"] = o
            out[pop] = po
        res["pooled"][part] = out
    res["secs"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(OUT, f"{inst.replace('/', '_')}.json"), "w"), indent=1, default=float)
    print("done", inst, res["secs"], "s")


def register(amend=None):
    P = os.path.join(HERE, "prereg.json")
    sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
    hashes = dict(evaluator=de.CODE_SHA, evaluator_files=de.CODE_FILES_SHA, selected_json=sha(de.E2_SELECTED),
                  **{"bench.py": bm.CODE["bench.py"], "run.py": CODE["run.py"]})
    if amend:
        reg = json.load(open(P))
        reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=amend, code_sha256=hashes))
        reg["code_sha256"] = hashes
        json.dump(reg, open(P, "w"), indent=1); return
    assert not os.path.exists(P), "prereg.json exists; amend instead"
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="ablate4: candidate population x target ablation, learners and evaluator v2 (V4) fixed (#310 queue item 4)",
        question="Is the dead end the candidate POPULATION or the LABEL? Learner, features, evaluator, fills, spread rule, "
                 "management policy and windows held fixed.",
        before_registration="No real-data scoring in this campaign before this file. Reused: bench1 harness (bench.py unchanged, "
                            "its causality check passed), evaluator v2 digest 1b66053d unchanged.",
        populations=dict(
            P1="frozen D candidates (WTI: fired 0.9, brk, W 48) - entry-capable",
            P2="cfgX: none, h1, W 12 (broader no-gate H1-confirmation population of bench1) - entry-capable",
            P3=f"fixed cadence: every M5 bar closing on a multiple of {CADENCE} min UTC in [{LIQ[0]//60:02d}:{LIQ[0]%60:02d}, "
               f"{LIQ[1]//60:02d}:{LIQ[1]%60:02d}] UTC, spread <= 0.2 R, finite ATR, uncensored outcomes, side = M5 trend; "
               "independent of supertrend flips, impulse and gate; no price confirmation; learnability only; cluster = day",
            P3c="P3 rows that are price-confirmed (H1 supertrend agrees) inside a trend episode-day: cfg (none, h1cad, 288) where "
                "h1cad = h1 & cadence (runtime extension of de_v2.confirm_mask, evaluator files unchanged); one entry per episode, "
                "no overlap - entry-capable"),
        targets=dict(
            T1="y_arm: +1R before the stop within H=72 (308 contract)",
            T2=f"side-free big move: mid high/low over bars i+1..i+{N_FWD} reaches close_i +/- KX*ATR_i (either side). KX from "
               f"{KX_GRID}: the value whose 2018 base rate on the P3 cadence sample is closest to 1/3 (label definition only, "
               "pre-fold data, computed and recorded at run time)",
            T3="direction given a big move: 1 if the first KX*ATR passage is on the row's side; rows with T2=1 and an unambiguous "
               "first passage only",
            T4="sign of side-specific net R under the 308 management policy (net_R > 0); Spearman(score, net_R) also reported"),
        purge="label end = max(trade exit, bar i+72); V4 fit rows exit before test - 6 months - 5 days",
        learners="bench1 lr_base (BASEF+VOLF), lr_eng (ENG), hgb_eng (ENG); unchanged hyperparameters; no tuning",
        evaluator="de_v2 + labels_v2, V4 E stage via bench.evaluate, unchanged; for each target the V4 calibration guard and "
                  "threshold rule use that target's label as y (calibration) and the policy net R (threshold, vs unselected)",
        folds="purged walk-forward test years 2019, 2020, 2021, 2022 (gate and learners fitted before the year) + 2023-01-01..newest "
              "DEVELOPMENT window (inspected before; never a holdout). No test ledger, no verdicts.",
        report="raw AUC by fold and pooled (day-bootstrap CI), by side; diagnostic calibration (Platt fitted on the V4 pooled "
               "window, no guard) with quintile reliability and support; for entry-capable cells: registered V4 policy and the "
               "coverage curve (q = 0.5/0.35/0.2/0.1) net R with 5-day moving-block CIs, vs unselected population policy and vs "
               "no-trade (0 R), cost sensitivity 0/0.02/0.05/0.10 R",
        layers="market-path predictability = raw AUC of T1-T4; policy conversion = V4 availability and coverage-curve net R vs the "
               "unselected policy; net economics = absolute net R and cost sensitivity",
        budget=dict(populations=4, targets=4, learners=3, folds=5, cells=4 * 4 * 3 * 5, kx_values_considered=len(KX_GRID),
                    hyperparameters="none tuned (bench1 fixed values; HGB iteration count by chronological validation)",
                    thresholds="V4 coverage grid (4 values) inside the evaluator"),
        controls="planted-signal controls only if a positive cell needs interpretation; bench1/audit controls cover the T1 pipeline",
        expectation="to test, not assume: T2 learnable; T1 and T3 not",
        instruments=["WTICO/USD primary", "XAU/USD only if time permits (P1 = its frozen D = cfgX; no P2)"],
        code_sha256=hashes)
    json.dump(reg, open(P, "w"), indent=1)


if __name__ == "__main__":
    if MODE == "register":
        register()
    elif MODE == "amend":
        register(sys.argv[2])
    elif MODE == "run":
        run(sys.argv[2])
