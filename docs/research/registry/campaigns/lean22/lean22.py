"""lean22: honest track record of the card's "Lean: LONG/SHORT" (argmax of pprofit20 A4 P_long vs P_short).

Descriptive measurement, development evidence only. No pass/fail rule, no test ledger, nothing qualified.

  python lean22.py check                      synthetic self-checks (no outcomes)
  python lean22.py register                   prereg.json (refuses to overwrite)
  python lean22.py cell INST TF H TGT         walk-forward P (pp20, unchanged) -> out/cells/<key>.npz (per-day sums)
  python lean22.py report                     out/lean_track_record.json + out/report.txt
"""
import os, sys, json, time, glob, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
AUD = os.path.dirname(HERE)
ENG = os.path.dirname(AUD)
OUT = os.path.join(HERE, "out"); CELLS = os.path.join(OUT, "cells")
PPD = os.path.join(AUD, "pprofit20")
sys.path[:0] = [ENG, PPD]
import numpy as np  # noqa: E402

sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
EVAL_DIGEST = "1b66053da304e13ab2539fef82f3ce31f180d1a5478e991a34985f294b72c6bb"
BUCKETS = [(0, 1), (1, 2), (2, 3), (3, 5), (5, 101)]           # |P_long - P_short| in percentage points
BNAMES = ["all", "0-1", "1-2", "2-3", "3-5", ">=5"]
MET = ["n", "lean_right", "lean_pos", "lean_net", "long_right", "long_pos", "st_n", "st_right", "st_pos", "lean_eq_st", "tie", "st_tie"]  # amendment A1: tie, st_tie
NREP, BLOCK, SEED = 1000, 5, 22
MIN_BUCKET_N = 300            # a bucket with fewer bars does not count for the greying threshold
MIN_W2023_N = 2000            # card window: 2023+ if it has at least this many bars, else full OOS
DEV_END_YEAR = 2023


def mins(s):
    return int(np.datetime64(s, "m").astype(np.int64))


def day_of(t):
    return (np.asarray(t, np.int64) + 120) // 1440


def shipped_cells():
    """The A4 artifacts that passed calibration and are not degenerate (status starts 'development evidence')."""
    out = []
    for f in sorted(glob.glob(os.path.join(PPD, "out", "artifact_*_H*_*_pprofit20.json"))):
        A = json.load(open(f))
        if A["status"].startswith("development evidence") and "horizon_bars" in A:
            tf = A["timeframe"]
            out.append((A["instrument"], tf, int(A["horizon_bars"]), A["target"]))
    return out


def key(inst, tf, h, tgt):
    return f"{inst.replace('/', '_')}_{tf}_H{h}_{tgt}"


# ------------------------------------------------------------------ pure helpers
def lean_rows(pl, ps, nl, ns, st):
    """Per decision bar: lean side (+1 long if pl >= ps, else -1), gap in pp, metrics. st = M5 supertrend (+1/-1/0)."""
    lean = np.where(pl >= ps, 1, -1)
    gap = 100 * np.abs(pl - ps)
    ln = np.where(lean > 0, nl, ns); on = np.where(lean > 0, ns, nl)
    stn = np.where(st > 0, nl, ns); sto = np.where(st > 0, ns, nl)
    m = dict(n=np.ones(len(pl)), lean_right=(ln > on).astype(float), lean_pos=(ln > 0).astype(float), lean_net=ln,
             long_right=(nl > ns).astype(float), long_pos=(nl > 0).astype(float), st_n=(st != 0).astype(float),
             st_right=((st != 0) & (stn > sto)).astype(float), st_pos=((st != 0) & (stn > 0)).astype(float),
             lean_eq_st=((st != 0) & (lean == st)).astype(float),
             tie=(np.abs(nl - ns) < 1e-9).astype(float), st_tie=((st != 0) & (np.abs(nl - ns) < 1e-9)).astype(float))
    return gap, m


def bucket_of(gap):
    b = np.searchsorted([e for _, e in BUCKETS], gap, side="right")
    return np.clip(b, 0, len(BUCKETS) - 1) + 1          # 1..5 (0 = all)


def day_sums(dpos, ndays, gap, m):
    """S[metric, bucket(0=all,1..5), day]."""
    b = bucket_of(gap)
    S = np.zeros((len(MET), 1 + len(BUCKETS), ndays))
    for k, nm in enumerate(MET):
        S[k, 0] = np.bincount(dpos, m[nm], ndays)
        for j in range(1, 1 + len(BUCKETS)):
            q = b == j
            S[k, j] = np.bincount(dpos[q], m[nm][q], ndays)
    return S


def boot_weights(ndays, reps=NREP, block=BLOCK, seed=SEED):
    """Moving-block bootstrap over consecutive trading days as a (reps x ndays) multiplicity matrix (as lean21)."""
    rng = np.random.default_rng(seed)
    nb = -(-ndays // block)
    starts = rng.integers(0, max(ndays - block + 1, 1), (reps, nb))
    idx = (starts[:, :, None] + np.arange(block)).reshape(reps, -1)[:, :ndays] % ndays
    W = np.zeros((reps, ndays))
    np.add.at(W, (np.repeat(np.arange(reps), ndays), idx.ravel()), 1)
    return W


def ratio(num, den, W):
    """Point estimate and 95% percentile CI of sum(num)/sum(den) under day weights W."""
    d = den.sum()
    if d == 0:
        return None, [None, None]
    with np.errstate(invalid="ignore", divide="ignore"):
        b = (W @ num) / (W @ den)
    b = b[np.isfinite(b)]
    return float(num.sum() / d), [float(np.percentile(b, 2.5)), float(np.percentile(b, 97.5))]


def ratio_boot(num, den, W):
    with np.errstate(invalid="ignore", divide="ignore"):
        return (W @ num) / (W @ den)


def grey_threshold(buckets):
    """Lower gap edge (pp) from which every supported bucket (n >= MIN_BUCKET_N) has hit-rate CI low > 0.5, with at
    least one supported bucket at or above it. None = the CI includes (or lies below) 50% in the top supported bucket."""
    sup = [(lo, b) for (lo, _), b in zip(BUCKETS, buckets) if b["n"] >= MIN_BUCKET_N]
    thr = None
    for lo, b in reversed(sup):
        if b["ci"][0] is not None and b["ci"][0] > 0.5:
            thr = lo
        else:
            break
    return thr


def check():
    pl = np.array([.30, .20, .25, .10]); ps = np.array([.20, .30, .25, .12])
    nl = np.array([1.0, -1, .5, -2]); ns = np.array([-1.0, 2, -.4, -1]); st = np.array([1, 1, -1, 0])
    gap, m = lean_rows(pl, ps, nl, ns, st)
    assert np.allclose(gap, [10, 10, 0, 2])
    # bar0 lean L (1 > -1) right; bar1 lean S (2 > -1) right; bar2 tie -> L (.5 > -.4) right; bar3 lean S (-1 > -2) right
    assert list(m["lean_right"]) == [1, 1, 1, 1] and list(m["lean_pos"]) == [1, 1, 1, 0]
    assert list(m["long_right"]) == [1, 0, 1, 0] and list(m["st_right"]) == [1, 0, 0, 0] and list(m["st_n"]) == [1, 1, 1, 0]
    assert list(bucket_of(np.array([0, .99, 1, 2.5, 3, 4.99, 5, 50]))) == [1, 1, 2, 3, 4, 4, 5, 5]
    S = day_sums(np.array([0, 0, 1, 2]), 3, gap, m)
    assert S[0, 0].tolist() == [2, 1, 1] and S[0, 5].tolist() == [2, 0, 0] and S[0, 2].tolist() == [0, 0, 1]
    W = boot_weights(10, reps=50, block=3)
    assert W.shape == (50, 10) and (W.sum(1) == 10).all()
    p, ci = ratio(np.array([1., 0, 1]), np.array([2., 1, 1]), np.ones((1, 3)))
    assert abs(p - .5) < 1e-12 and abs(ci[0] - .5) < 1e-12
    bk = [dict(n=1000, ci=[.45, .55]), dict(n=1000, ci=[.49, .53]), dict(n=1000, ci=[.51, .56]), dict(n=10, ci=[.3, .4]),
          dict(n=1000, ci=[.52, .6])]
    assert grey_threshold(bk) == 2
    bk[4]["ci"] = [.48, .6]
    assert grey_threshold(bk) is None
    assert len(shipped_cells()) == 32
    print("lean22 self-check OK: lean/tie rule, metrics, buckets, day sums, bootstrap weights, ratio, grey threshold, 32 cells")


def register():
    f = os.path.join(HERE, "prereg.json")
    assert not os.path.exists(f), "prereg.json exists"
    sys.path.insert(0, ENG)
    import de_v2 as de
    assert de.CODE_SHA == EVAL_DIGEST, de.CODE_SHA
    reg = {
        "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "title": "lean22: track record of the card lean (side with the higher pprofit20 A4 calibrated P)",
        "before_registration": "No outcome of this measurement computed. Code self-checked on synthetic data only. A first registration (14:39:58) had wrong cell keys (timeframe parsed from the file name) and was replaced before any outcome run. "
                               "pprofit20 A4 results (per-side calibration, AUC, decile mean R, long-minus-short deciles) were "
                               "inspected earlier; 2023+ is a development window, never a holdout.",
        "declared": "Descriptive measurement. No pass/fail rule for shipping a lean. Development evidence. No test ledger, "
                    "nothing qualified.",
        "cells": [key(*c) for c in shipped_cells()],
        "cells_rule": "the 32 A4 artifacts whose status starts 'development evidence' (calibration pass, not degenerate)",
        "predictions": "pp20.walk_forward (quarterly expanding refit, 182-day calibration window, Platt M5/M15, isotonic M1), "
                       "recomputed with pp20.py unchanged via PP_TF/PP_H/PP_TGT; out-of-sample rows only (P finite on both sides)",
        "decision_bars": "pp20 cadence bars (M5: start % 15 == 10; M15: every bar; M1: start % 5 == 4) with both sides labelled",
        "lean": "LONG if P_long >= P_short else SHORT (ties go LONG); gap = 100 x |P_long - P_short| percentage points",
        "outcomes": "realized net R per side from the cell's own label (plan: labels_v2.simulate trade; up: entry bar i+1 open, "
                    "exit bar i+H close, bid/ask), 1R = 1.5 x Wilder ATR14 of mid at bar i",
        "lean_right_primary": "lean side net R > other side net R (strict)",
        "lean_positive_secondary": "lean side net R > 0 after costs",
        "gap_buckets_pp": ["[0,1)", "[1,2)", "[2,3)", "[3,5)", ">=5"],
        "baselines": {"always_long": "long net R > short net R (and long net R > 0)",
                      "supertrend": "side = direction of the last COMPLETED M5 supertrend bar (production ATR10 mult 3 on mid; "
                                    "M5 resampled from M1 for M1/M15 cells; completed when M5 start + 5 <= decision bar close); "
                                    "bars with no trend are excluded from that baseline's denominator"},
        "windows": {"dev": "OOS 2019-2022", "w2023": "2023-01-01 .. pprofit20 cut 2026-10-07T18:30 (development window)",
                    "full": "all OOS"},
        "stats": f"moving-block bootstrap over trading days (22:00 UTC roll), block {BLOCK}, {NREP} reps, seed {SEED}, per window; "
                 "95% percentile CI of the ratio of day sums; pooled = equal-weight mean of cell hit rates with shared day draws "
                 "(cells overlap in instrument and time, so pooled CI is not 32x independent evidence); also pooled per timeframe; "
                 "paired differences lean minus baseline use the same draws",
        "monotonicity": "per cell and pooled: hit rate by bucket non-decreasing across supported buckets (n >= 300); "
                        "Spearman of bucket index vs hit rate reported",
        "card_window": f"w2023 if it has >= {MIN_W2023_N} bars, else full OOS",
        "grey_threshold": f"per cell, card window: the lowest bucket lower edge from which every supported bucket (n >= "
                          f"{MIN_BUCKET_N}) has CI low > 50%; null = grey always",
        "label": "'right X% of the time (lo-hi%), <window>' from the primary metric, overall",
        "budget": {"metrics": 2, "gap_buckets": 5, "baselines": 2, "windows": 3, "tuned": 0},
        "code_sha256": {"lean22.py": sha(os.path.join(HERE, "lean22.py")), "pp20.py": sha(os.path.join(PPD, "pp20.py")),
                        "evaluator": de.CODE_SHA},
    }
    json.dump(reg, open(f, "w"), indent=1)
    print("registered", reg["code_sha256"])


# ------------------------------------------------------------------ outcomes
def day_axis():
    import pp20 as PP
    d0 = int(day_of(mins("2019-01-01"))); d1 = int(day_of(mins(PP.CUT))) + 1
    return d0, d1


def cell(inst, tf, h, tgt):
    os.environ.update(PP_TF=tf, PP_H=str(h), PP_TGT=tgt)
    os.environ.pop("PP_CAL", None)
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    amd = os.path.join(HERE, "prereg_amendment_A1.json")
    ok_h = [reg["code_sha256"]["lean22.py"]] + ([json.load(open(amd))["code_sha256"]["lean22.py"]] if os.path.exists(amd) else [])
    assert sha(os.path.join(HERE, "lean22.py")) in ok_h, "lean22.py changed since registration"
    import pp20 as PP
    import de_v2 as de
    from bars import resample
    assert de.CODE_SHA == EVAL_DIGEST and PP.CODE["pp20.py"] == reg["code_sha256"]["pp20.py"]
    t0 = time.time()
    m1, src = PP.load_m1c(inst)
    B, Fb = PP.frame(inst, m1)
    R = PP.rows(B, Fb)
    P, _, fits = PP.walk_forward(R, mins(PP.CUT))
    ok = np.isfinite(P)
    L = np.where(ok & (R["side"] == 1))[0]; S = np.where(ok & (R["side"] == -1))[0]
    li = dict(zip(R["i"][L].tolist(), L.tolist())); si = dict(zip(R["i"][S].tolist(), S.tolist()))
    both = sorted(set(li) & set(si))
    a = np.array([li[i] for i in both]); b = np.array([si[i] for i in both])
    B5 = resample(m1, "M5")
    tr5 = np.nan_to_num(de.supertrend(inst, B5)["trend"]).astype(int)
    tdec = R["t"][a]
    j = np.searchsorted(B5["t"] + 5, tdec + PP.GM, side="right") - 1
    st = np.where(j >= 0, tr5[np.clip(j, 0, None)], 0)
    gap, m = lean_rows(P[a], P[b], R["net"][a], R["net"][b], st)
    d0, d1 = day_axis()
    dpos = day_of(tdec) - d0
    assert dpos.min() >= 0 and dpos.max() < d1 - d0
    Sm = day_sums(dpos, d1 - d0, gap, m)
    gq = [float(x) for x in np.percentile(gap, [10, 25, 50, 75, 90])]
    k = key(inst, tf, h, tgt)
    np.savez_compressed(os.path.join(CELLS, k + ".npz"), S=Sm)
    json.dump(dict(key=k, src=src, n_pairs=len(both), first=str(np.datetime64(int(tdec.min()), "m")),
                   gap_q=gap_q_by_window(gap, tdec), st_check_m5=(bool((st == Fb["trend"][R["i"][a]]).all()) if tf == "M5" else None),
                   n_fits=len(fits), secs=round(time.time() - t0)), open(os.path.join(CELLS, k + ".json"), "w"), indent=1)
    print(k, len(both), "pairs", round(time.time() - t0), "s", "gap pctl", [round(x, 2) for x in gq], flush=True)


def gap_q_by_window(gap, t):
    w = t >= mins(f"{DEV_END_YEAR}-01-01")
    return {nm: [float(x) for x in np.percentile(gap[q], [10, 25, 50, 75, 90])] if q.any() else None
            for nm, q in (("dev", ~w), ("w2023", w))}


# ------------------------------------------------------------------ report
def report():
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    d0, d1 = (int(day_of(mins("2019-01-01"))), None)
    keys = reg["cells"]
    Ss = {k: np.load(os.path.join(CELLS, k + ".npz"))["S"] for k in keys}
    I = {nm: i for i, nm in enumerate(MET + ["dec_n", "st_dec_n"])}
    Ss = {k: np.concatenate([S, S[[I["n"]]] - S[[I["tie"]]], S[[I["st_n"]]] - S[[I["st_tie"]]]]) for k, S in Ss.items()}  # A1 decisive denominators
    meta = {k: json.load(open(os.path.join(CELLS, k + ".json"))) for k in keys}
    nd = next(iter(Ss.values())).shape[2]
    split = int(day_of(mins(f"{DEV_END_YEAR}-01-01"))) - d0
    wins = {"dev": slice(0, split), "w2023": slice(split, nd), "full": slice(0, nd)}
    Wd = {w: boot_weights(s.stop - s.start) for w, s in wins.items()}

    def stats(S, w):
        X = S[:, :, wins[w]]; W = Wd[w]
        o = {}
        for bi, bn in enumerate(BNAMES):
            n = X[I["n"], bi]
            r = dict(n=int(n.sum()), n_days=int((n > 0).sum()))
            r["hit"], r["ci"] = ratio(X[I["lean_right"], bi], n, W)
            r["lean_pos"], r["lean_pos_ci"] = ratio(X[I["lean_pos"], bi], n, W)
            r["lean_meanR"], r["lean_meanR_ci"] = ratio(X[I["lean_net"], bi], n, W)
            r["always_long"], r["always_long_ci"] = ratio(X[I["long_right"], bi], n, W)
            r["always_long_pos"], _ = ratio(X[I["long_pos"], bi], n, W)
            r["supertrend"], r["supertrend_ci"] = ratio(X[I["st_right"], bi], X[I["st_n"], bi], W)
            r["supertrend_pos"], _ = ratio(X[I["st_pos"], bi], X[I["st_n"], bi], W)
            r["lean_agrees_supertrend"], _ = ratio(X[I["lean_eq_st"], bi], X[I["st_n"], bi], W)
            r["tie_share"], r["tie_share_ci"] = ratio(X[I["tie"], bi], n, W)  # A1: decisive = the two sides' net R differ
            r["hit_dec"], r["ci_dec"] = ratio(X[I["lean_right"], bi], X[I["dec_n"], bi], W)
            r["always_long_dec"], r["always_long_dec_ci"] = ratio(X[I["long_right"], bi], X[I["dec_n"], bi], W)
            r["supertrend_dec"], r["supertrend_dec_ci"] = ratio(X[I["st_right"], bi], X[I["st_dec_n"], bi], W)
            if X[I["dec_n"], bi].sum():
                bd = ratio_boot(X[I["lean_right"], bi], X[I["dec_n"], bi], W)
                for nm, num, den in (("dec_minus_always_long", X[I["long_right"], bi], X[I["dec_n"], bi]),
                                     ("dec_minus_supertrend", X[I["st_right"], bi], X[I["st_dec_n"], bi])):
                    d = bd - ratio_boot(num, den, W); d = d[np.isfinite(d)]
                    r[nm] = [r["hit_dec"] - (num.sum() / den.sum()), float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))]
            if n.sum():
                bl = ratio_boot(X[I["lean_right"], bi], n, W)
                for nm, num, den in (("minus_always_long", X[I["long_right"], bi], n), ("minus_supertrend", X[I["st_right"], bi], X[I["st_n"], bi])):
                    d = bl - ratio_boot(num, den, W); d = d[np.isfinite(d)]
                    r[nm] = [r["hit"] - (num.sum() / den.sum()), float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))]
            o[bn] = r
        return o

    def mono(bk, f="hit"):
        sup = [bk[b][f] for b in BNAMES[1:] if bk[b]["n"] >= MIN_BUCKET_N and bk[b][f] is not None]
        if len(sup) < 2:
            return dict(nondecreasing=None, spearman=None, n_buckets=len(sup))
        rk = np.argsort(np.argsort(sup)); sp = float(np.corrcoef(np.arange(len(sup)), rk)[0, 1])
        return dict(nondecreasing=bool(all(x <= y for x, y in zip(sup, sup[1:]))), spearman=sp, n_buckets=len(sup))

    res, export = {}, {}
    for k in keys:
        res[k] = {w: stats(Ss[k], w) for w in wins}
        cw = "w2023" if res[k]["w2023"]["all"]["n"] >= MIN_W2023_N else "full"
        A = res[k][cw]; al = A["all"]
        thr = grey_threshold([A[b] | dict(ci=A[b]["ci"]) for b in BNAMES[1:]])
        wl = "2023+" if cw == "w2023" else "2019+ out-of-sample"
        pc = lambda x: f"{100 * x:.0f}"
        export[k] = dict(
            window=cw, window_label=wl, n_bars=al["n"], n_days=al["n_days"],
            hit_rate=al["hit"], hit_rate_ci=al["ci"],
            lean_positive_rate=al["lean_pos"], lean_positive_ci=al["lean_pos_ci"],
            lean_mean_R=al["lean_meanR"], lean_mean_R_ci=al["lean_meanR_ci"],
            by_gap={b: dict(n=A[b]["n"], n_days=A[b]["n_days"], hit_rate=A[b]["hit"], hit_rate_ci=A[b]["ci"],
                            lean_positive_rate=A[b]["lean_pos"], lean_mean_R=A[b]["lean_meanR"]) for b in BNAMES[1:]},
            baselines=dict(always_long=dict(hit_rate=al["always_long"], ci=al["always_long_ci"], positive_rate=al["always_long_pos"]),
                           supertrend_m5=dict(hit_rate=al["supertrend"], ci=al["supertrend_ci"], positive_rate=al["supertrend_pos"]),
                           lean_minus_always_long=al.get("minus_always_long"), lean_minus_supertrend=al.get("minus_supertrend"),
                           lean_agrees_with_supertrend=al["lean_agrees_supertrend"]),
            grey_below_gap_pp=thr, grey_rule=("grey always: no gap bucket's CI clears 50%" if thr is None else
                                              f"grey when gap < {thr} pp" if thr > 0 else "never grey: every supported bucket clears 50%"),
            monotonic=mono(A), monotonic_decisive=mono(A, "hit_dec"),
            amendment_A1=dict(note="post-hoc (after outcomes): ties = both sides realize the same net R (plan stops at exactly -1 R, breakeven 0 R); decisive bars exclude ties",
                              tie_share=al["tie_share"], hit_rate_decisive=al["hit_dec"], hit_rate_decisive_ci=al["ci_dec"],
                              always_long_decisive=al["always_long_dec"], supertrend_decisive=al["supertrend_dec"],
                              lean_minus_always_long_decisive=al.get("dec_minus_always_long"), lean_minus_supertrend_decisive=al.get("dec_minus_supertrend"),
                              by_gap={b: dict(tie_share=A[b]["tie_share"], hit_rate_decisive=A[b]["hit_dec"], hit_rate_decisive_ci=A[b]["ci_dec"],
                                              n_decisive=int(round(A[b]["n"] * (1 - (A[b]["tie_share"] or 0))))) for b in BNAMES[1:]},
                              grey_below_gap_pp=grey_threshold([dict(n=int(round(A[b]["n"] * (1 - (A[b]["tie_share"] or 0)))), ci=A[b]["ci_dec"]) for b in BNAMES[1:]]),
                              label=(f"right {pc(al['hit_dec'])}% of the time ({pc(al['ci_dec'][0])}-{pc(al['ci_dec'][1])}%) when the two sides end differently; "
                                     f"both sides end the same {pc(al['tie_share'])}% of the time, {wl}")),
            label=f"right {pc(al['hit'])}% of the time ({pc(al['ci'][0])}-{pc(al['ci'][1])}%), {wl}",
            label_positive=f"lean side profitable after costs {pc(al['lean_pos'])}% ({pc(al['lean_pos_ci'][0])}-{pc(al['lean_pos_ci'][1])}%)",
            gap_percentiles_pp=meta[k]["gap_q"].get(cw if cw != "full" else "w2023"),
            status="development evidence; descriptive; not qualified")
    # pooled: equal-weight mean of cell ratios, shared day draws
    groups = {"pooled_all": keys, **{f"pooled_{tf}": [k for k in keys if f"_{tf}_" in k] for tf in ("M1", "M5", "M15")}}
    pooled = {}
    for g, ks in groups.items():
        pooled[g] = {}
        for w in wins:
            W = Wd[w]; pooled[g][w] = {}
            for bi, bn in enumerate(BNAMES):
                out = {}
                for nm, num_m, den_m in (("hit", "lean_right", "n"), ("lean_pos", "lean_pos", "n"), ("always_long", "long_right", "n"),
                                         ("supertrend", "st_right", "st_n"), ("hit_dec", "lean_right", "dec_n"),
                                         ("always_long_dec", "long_right", "dec_n"), ("supertrend_dec", "st_right", "st_dec_n"), ("tie", "tie", "n")):
                    pts, bts = [], []
                    for k in ks:
                        X = Ss[k][:, bi, wins[w]]
                        if X[I[den_m]].sum() < (MIN_BUCKET_N if bi else 1):
                            continue
                        pts.append(X[I[num_m]].sum() / X[I[den_m]].sum()); bts.append(ratio_boot(X[I[num_m]], X[I[den_m]], W))
                    if pts:
                        bb = np.nanmean(np.array(bts), 0)
                        out[nm] = [float(np.mean(pts)), float(np.nanpercentile(bb, 2.5)), float(np.nanpercentile(bb, 97.5))]
                        out["n_cells"] = len(pts)
                out["n"] = int(sum(Ss[k][I["n"], bi, wins[w]].sum() for k in ks))
                pooled[g][w][bn] = out
    json.dump(dict(created=time.strftime("%Y-%m-%dT%H:%M:%S%z"), prereg=reg["created"], code_sha256=reg["code_sha256"],
                   status="development evidence; descriptive measurement; nothing qualified",
                   definitions=dict(lean=reg["lean"], right=reg["lean_right_primary"], positive=reg["lean_positive_secondary"],
                                    buckets_pp=reg["gap_buckets_pp"], baselines=reg["baselines"], ci=reg["stats"]),
                   cells=export, pooled=pooled), open(os.path.join(OUT, "lean_track_record.json"), "w"), indent=1)
    json.dump(dict(cells=res, meta=meta), open(os.path.join(OUT, "results_full.json"), "w"), indent=1)
    print_report(res, export, pooled)


def print_report(res, export, pooled):
    f = lambda x: "  -  " if x is None else f"{100 * x:.1f}"
    ci = lambda c: "[ - ]" if c[0] is None else f"[{100 * c[0]:.1f},{100 * c[1]:.1f}]"
    L = ["# lean22 track record (development evidence; descriptive; nothing qualified)", ""]
    for w in ("w2023", "dev"):
        L += [f"## window {w}", "| cell | n | hit [CI] | pos | meanR | long | ST | 0-1 | 1-2 | 2-3 | 3-5 | >=5 | mono | grey<pp |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        rows = sorted(res, key=lambda k: -res[k][w]["all"]["hit"])
        for k in rows:
            A = res[k][w]; a = A["all"]
            bks = " | ".join(f"{f(A[b]['hit'])} ({A[b]['n']})" for b in BNAMES[1:])
            thr = grey_threshold([A[b] for b in BNAMES[1:]])
            L.append(f"| {k} | {a['n']} | {f(a['hit'])} {ci(a['ci'])} | {f(a['lean_pos'])} | {a['lean_meanR']:+.3f} | {f(a['always_long'])} | "
                     f"{f(a['supertrend'])} | {bks} | {{}} | {thr} |".format(export[k]["monotonic"]["nondecreasing"] if w == export[k]["window"] else ""))
        L.append("")
        for g, P in pooled.items():
            L.append(f"{g} {w}: " + "; ".join(f"{b}: hit {f(P[w][b].get('hit', [None])[0])} {ci(P[w][b].get('hit', [None, None, None])[1:])} "
                                             f"long {f(P[w][b].get('always_long', [None])[0])} ST {f(P[w][b].get('supertrend', [None])[0])} "
                                             f"pos {f(P[w][b].get('lean_pos', [None])[0])} n {P[w][b]['n']}" for b in BNAMES))
        L.append("")
    for w in ("w2023", "dev"):  # amendment A1: decisive bars (the two sides' net R differ)
        L += [f"## A1 decisive, window {w}", "| cell | tie% | hit_dec [CI] | long_dec | ST_dec | lean-long [CI] | lean-ST [CI] | 0-1 | 1-2 | 2-3 | 3-5 | >=5 | mono | grey<pp |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for k in sorted(res, key=lambda k: -(res[k][w]["all"]["hit_dec"] or 0)):
            A = res[k][w]; a = A["all"]
            dd = lambda v: "-" if v is None else f"{100 * v[0]:+.1f} [{100 * v[1]:+.1f},{100 * v[2]:+.1f}]"
            nn = lambda b: int(round(A[b]["n"] * (1 - (A[b]["tie_share"] or 0))))
            bks = " | ".join(f"{f(A[b]['hit_dec'])} ({nn(b)})" for b in BNAMES[1:])
            thr = grey_threshold([dict(n=nn(b), ci=A[b]["ci_dec"]) for b in BNAMES[1:]])
            sup = [A[b]["hit_dec"] for b in BNAMES[1:] if nn(b) >= MIN_BUCKET_N]
            L.append(f"| {k} | {f(a['tie_share'])} | {f(a['hit_dec'])} {ci(a['ci_dec'])} | {f(a['always_long_dec'])} | {f(a['supertrend_dec'])} | "
                     f"{dd(a.get('dec_minus_always_long'))} | {dd(a.get('dec_minus_supertrend'))} | {bks} | {all(x <= y for x, y in zip(sup, sup[1:]))} | {thr} |")
        L.append("")
        for g, P in pooled.items():
            L.append(f"{g} {w} decisive: " + "; ".join(f"{b}: hit {f(P[w][b].get('hit_dec', [None])[0])} {ci(P[w][b].get('hit_dec', [None, None, None])[1:])} "
                                             f"long {f(P[w][b].get('always_long_dec', [None])[0])} ST {f(P[w][b].get('supertrend_dec', [None])[0])} "
                                             f"tie {f(P[w][b].get('tie', [None])[0])}" for b in BNAMES))
        L.append("")
    open(os.path.join(OUT, "report.txt"), "w").write("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "cell":
        cell(sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5])
    else:
        {"check": check, "register": register, "report": report}[cmd]()
