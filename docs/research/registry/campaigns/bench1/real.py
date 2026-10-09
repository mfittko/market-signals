"""bench1 on real WTICO/USD M5 (development evidence only; no ledger, no verdicts, nothing is a holdout result).

Folds: purged walk-forward test years 2020, 2021, 2022 (gate model and every learner fitted before the year, V4 windows
end 5 days before it), and the 2023-01-01..newest DEVELOPMENT window (inspected many times before; never a holdout).
Populations: 'frozenD' = the WTI frozen D (fired 0.9, brk, W 48); 'cfgX' = the XAU frozen D applied to WTI (none, h1,
W 12), the population of the audit controls.

  python bench.py real frozenD|cfgX
"""
import os, json, time
import numpy as np
import bench as bm
from bench import de, Bench, evaluate, LEARNERS, COSTS
from validate import year_start_day, log_trial

POPS = {"frozenD": (("fired", 0.9), "brk", 48), "cfgX": (("none", None), "h1", 12)}
FOLDS = [2020, 2021, 2022, 2023]
INST = "WTICO/USD"
PAIRS = [("hgb_eng", "lr_eng"), ("tscomb_hgb", "tscomb_lr"), ("tscomb_lr", "lr_eng"), ("ts_lr", "lr_eng"), ("mr_lr", "lr_eng"),
         ("lr_eng", "lr_base")]


def main(pop):
    t0 = time.time()
    cfg = POPS[pop]
    m1, B, O, L = de.prep(INST, None)
    last_day = int(B["day"][-1]) + 1
    res = dict(inst=INST, pop=pop, cfg=str(cfg), data_last=str(de.iso(B["t"][-1])), evaluator=de.CODE_SHA, bench=bm.CODE,
               folds={}, note="development evidence; 2023+ is a development window, not a holdout")
    keep = {n: {"dev": [], "w23": []} for n in LEARNERS + ("D",)}
    curves = {n: {"dev": {q: [] for q in de.E2_QGRID}, "w23": {q: [] for q in de.E2_QGRID}} for n in LEARNERS}
    scores = {n: {"dev": [], "w23": []} for n in LEARNERS}
    for y in FOLDS:
        lo = year_start_day(y); hi = year_start_day(y + 1) if y < 2023 else last_day
        part = "dev" if y < 2023 else "w23"
        GS = de.gate_states(B, L, de.fit_gate(L, lo - de.EMB))
        R = de.run_d(B, O, GS, cfg)
        F = de.e_features(B, GS, R["ep"])
        C = de.candidates(B, O, R, cfg[2])
        bench = Bench(B, F, C)
        ok = bench.ok
        okb = np.isfinite(de.e_matrix(F, de.BASEF + de.VOLF, C["i"])).all(1)
        te = lambda T: de.sel(T, (T["day"] >= lo) & (T["day"] < hi))
        tst = (C["day"] >= lo) & (C["day"] < hi) & ok
        TD = te(de.trades(B, O, R["entries"])); keep["D"][part].append(TD)
        _, _, all_days = de.window_bars(B, lo, hi)
        years = (hi - lo) / 365.25
        fr = dict(window=[str(np.datetime64(lo, "D")), str(np.datetime64(hi, "D"))], rows=dict(candidates=int(len(C["i"])), ok=int(ok.sum()),
                  ok_base_only=int(okb.sum()), test=int(tst.sum()), test_base_rate=float(C["y"][tst].mean()) if tst.any() else None),
                  D=dict(trades=int(len(TD["i"])), meanR=float(TD["net"].mean()) if len(TD["i"]) else None), learners={})
        for name in LEARNERS:
            t1 = time.time()
            fit = bench.fitter(name)
            r, S, TE = evaluate(fit, B, O, GS, cfg, C, ok, int(B["day"][0]), lo, tst, te, TD, all_days, years, verdict=False)
            r["log"] = bench.logs.get(name); r["secs"] = round(time.time() - t1, 1)
            if TE is not None:
                r["meanR"] = float(TE["net"].mean()) if len(TE["i"]) else None
                keep[name][part].append(TE)
            fitm, pool, _ = bm.v4_fit_mask(C, ok, int(B["day"][0]), lo)
            if fitm.sum() >= 50:
                sb = fit(fitm); sbar = np.nan_to_num(sb, nan=-np.inf); zthr = sb[C["i"][pool]]; zthr = zthr[np.isfinite(zthr)]
                for q in de.E2_QGRID:
                    if len(zthr):
                        curves[name][part][q].append(te(de.trades(B, O, de.run_d(B, O, GS, cfg, extra=sbar >= float(np.quantile(zthr, 1 - q)))["entries"])))
                if S["cal"] and S["cal"].get("kind") == "platt":
                    st = sb[C["i"][tst]]
                    scores[name][part].append((st, de.e2_prob(S["cal"], st), C["y"][tst], C["s"][tst], np.full(int(tst.sum()), y)))
            fr["learners"][name] = r
            log_trial({"exp": bm.EXP, "mode": "dev" if part == "dev" else "devwindow2023", "inst": INST, "pop": pop, "fold": y,
                       "learner": name, "spec": bm.SPEC_NAME, "lookback": bm.L_SEQ if name in ("mr_lr", "ts_lr", "tscomb_lr", "tscomb_hgb") else None,
                       "hyper": {k: v for k, v in (r.get("log") or {}).items() if k in ("C", "n_iter", "val_ll")},
                       "cause": r["cause"], "q": (r.get("thr") or {}).get("q"), "cut": r.get("cut"), "auc_test": r.get("auc_test"),
                       "test_trades": r.get("trades", 0), "evaluator": de.EVALUATOR_VERSION, "code_sha256": de.CODE_SHA, "bench_sha256": bm.CODE["bench.py"]})
            print(pop, y, name, r["cause"], "auc", r.get("auc_test"), "trades", r.get("trades"), r["secs"], flush=True)
        res["folds"][str(y)] = fr
    # pooled summaries
    for part, (lo, hi) in (("dev", (year_start_day(2020), year_start_day(2023))), ("w23", (year_start_day(2023), last_day))):
        _, _, days = de.window_bars(B, lo, hi)
        TD = de.cat(keep["D"][part]); out = dict(D=dict(trades=int(len(TD["i"])), meanR=float(TD["net"].mean()), ci=de.boot_mean(TD, days)[0]))
        for name in LEARNERS:
            o = {}
            if keep[name][part]:
                TE = de.cat(keep[name][part])
                if len(TE["i"]) >= 2:
                    o["registered"] = dict(folds_available=len(keep[name][part]), trades=int(len(TE["i"])), meanR=float(TE["net"].mean()),
                                           ci=de.boot_mean(TE, days)[0], vs_D=de.diff_ci(TE, TD, days)[:2])
            o["coverage"] = {}
            for q, lst in curves[name][part].items():
                if not lst:
                    continue
                T = de.cat(lst)
                if len(T["i"]) < 2:
                    o["coverage"][str(q)] = dict(trades=int(len(T["i"]))); continue
                c = de.boot_mean(T, days)[0]
                o["coverage"][str(q)] = dict(trades=int(len(T["i"])), meanR=float(T["net"].mean()), ci=c, vs_D=de.diff_ci(T, TD, days)[:2],
                                             cost={str(k): [float(T["net"].mean()) - k, c[0] - k] for k in COSTS},
                                             losers=float((T["net"] < 0).mean()), tail=float((T["net"] < -1.5).mean()))
            if scores[name][part]:
                st, p, yy, ss, fy = (np.concatenate([x[j] for x in scores[name][part]]) for j in range(5))
                o["calibration"] = dict(all=dict(scores=de.scores(p, yy), rel=de.reliability(p, yy)),
                                        **{f"side{s:+d}": dict(scores=de.scores(p[ss == s], yy[ss == s])) for s in (1, -1)})
                o["auc_by_fold"] = {str(f): bm.auc(yy[fy == f], st[fy == f]) for f in np.unique(fy)}
            out[name] = o
        # paired comparisons at a common coverage (q = 0.2) and of the registered policies
        out["paired_q0.2"] = {}
        for a, b in PAIRS:
            la, lb = curves[a][part][0.2], curves[b][part][0.2]
            if la and lb:
                Ta, Tb = de.cat(la), de.cat(lb)
                if len(Ta["i"]) >= 2 and len(Tb["i"]) >= 2:
                    out["paired_q0.2"][f"{a} - {b}"] = de.diff_ci(Ta, Tb, days)[:2]
        res[part] = out
    res["secs"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(bm.OUT, f"real_{pop}.json"), "w"), indent=1, default=float)
    print("done", pop, res["secs"], "s")
