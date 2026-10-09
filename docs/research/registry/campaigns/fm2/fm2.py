"""fm2 (#310 queue item 2, retargeted): zero-shot time-series foundation models as T2 scorers on P3.

Runs in the bench1 venv (same harness as ablate4). Foundation-model inference runs in separate venvs (infer.py) on the
exported context arrays; this file only exports inputs and evaluates scores.

  python fm2.py export INST     out/p3_<inst>.npz: P3 rows, T2/T3 labels, mid closes, ATR (no model scoring)
  python fm2.py eval INST       baselines + FM scores + stacking on identical rows/folds -> out/eval_<inst>.json
"""
import os, sys, json, time, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
ABL = os.path.join(os.path.dirname(HERE), "ablate4")
sys.path.insert(0, ABL)
MODE, INST = sys.argv[1], sys.argv[2]
sys.argv = [sys.argv[0], "x", INST]  # ablate4/run.py rewrites argv for bench.py
import run as A  # noqa: E402  (ablate4 harness: cadence, big_move, p3_rows, with_target, auc_ci)
from run import bm, de, np, year_start_day  # noqa: E402

EXP = "fm2"
FOLDS = [2020, 2021, 2022, 2023]
TAG = INST.replace("/", "_")
GROUPS = {"tod": ["tod_s", "tod_c", "dow_s", "dow_c", "nday"],
          "vol": ["rv12_288", "rv48_288", "rv288", "atr_px", "atr_ratio", "range", "range3"]}
GROUPS["todvol"] = GROUPS["tod"] + GROUPS["vol"]
NBOOT = 500


def load():
    m1, B, O, L = de.prep(INST, None)
    cad = A.cadence_mask(B)
    kx = json.load(open(os.path.join(A.OUT, TAG + ".json")))["kx"]
    LAB = A.big_move(B, kx)
    C = A.p3_rows(B, O, cad)
    return B, O, C, kx, LAB


def export():
    B, O, C, kx, LAB = load()
    big, first, endb = LAB
    i = C["i"]
    y3 = np.where((big[i] == 1) & (first[i] != 0), (first[i] == C["s"]).astype(float), np.nan)
    utc = A.utc_close(B)[i]
    np.savez_compressed(os.path.join(OUT, f"p3_{TAG}.npz"), i=i, day=C["day"], s=C["s"], y2=big[i], y3=y3, utc=utc,
                        mid_c=B["mid_c"], atr=B["atr"], t=B["t"], kx=kx)
    print(TAG, "rows", len(i), "kx", kx, "first", de.iso(B["t"][i[0]]), "last", de.iso(B["t"][i[-1]]))


def paired_boot(y, sa, sb, day, rng):
    """AUC(a) - AUC(b) on the same rows, day-cluster bootstrap."""
    ud, inv = np.unique(day, return_inverse=True)
    rows = [np.where(inv == k)[0] for k in range(len(ud))]
    d0 = bm.auc(y, sa) - bm.auc(y, sb); bs = []
    for _ in range(NBOOT):
        ix = np.concatenate([rows[k] for k in rng.integers(0, len(ud), len(ud))])
        bs.append(bm.auc(y[ix], sa[ix]) - bm.auc(y[ix], sb[ix]))
    return [float(d0), float(np.nanpercentile(bs, 2.5)), float(np.nanpercentile(bs, 97.5))]


def evaluate():
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    sha = lambda f: hashlib.sha256(open(os.path.join(HERE, f), "rb").read()).hexdigest()
    assert reg["code_sha256"]["fm2.py"] == sha("fm2.py"), "fm2.py changed after registration (amend first)"
    B, O, C, kx, LAB = load()
    Eb = bm.eng_bars(B); bm.eng_bars = lambda _B: Eb
    Ct, lab = A.with_target(B, C, "T2", LAB)
    C3, lab3 = A.with_target(B, C, "T3", LAB)
    i = C["i"]  # hgb_eng = bench1 hgb_head on ENG (same learner as ablate4, fitted on the same V4 fit rows)
    # FM scores (bar-indexed npz per model); a model is evaluated only on rows it scored
    fm = {}
    for f in sorted(os.listdir(OUT)):
        if f.startswith(f"fm_{TAG}_") and f.endswith(".npz"):
            z = np.load(os.path.join(OUT, f))
            name = f[len(f"fm_{TAG}_"):-4]
            pos = {b: k for k, b in enumerate(z["i"])}
            idx = np.array([pos.get(b, -1) for b in i])
            sc = {k: np.where(idx >= 0, z[k][np.maximum(idx, 0)], np.nan) for k in z.files if k.startswith("s_")}
            fm[name] = dict(sc=sc, secs_per_row=float(z["secs_per_row"]), meta=str(z["meta"]))
    X = {g: np.column_stack([Eb[k][i] for k in cols]) for g, cols in GROUPS.items()}
    Xeng = np.column_stack([Eb[k][i] for k in bm.ENG])
    ok = lab & np.isfinite(Xeng).all(1)
    # the evaluation row set: P3 rows that every model scored (subsample rule in prereg)
    gen = {k: v for k, v in fm.items() if not k.startswith("knn")}  # retrieval scores: raw AUC only (no score before 2020, no stack)
    for name in gen:
        ok &= np.isfinite(fm[name]["sc"]["s_main"])
    a_day = int(B["day"][0]); last_day = int(B["day"][-1]) + 1
    rng = np.random.default_rng(23)
    res = dict(inst=INST, kx=kx, rows_p3=int(len(i)), rows_eval=int(ok.sum()), models={k: dict(secs_per_row=v["secs_per_row"], meta=v["meta"]) for k, v in fm.items()},
               note="development evidence; 2023+ is a development window, not a holdout", folds={})
    keep = {}
    w = Ct["w"]; yv = Ct["y"]
    for y in FOLDS:
        lo = year_start_day(y); hi = year_start_day(y + 1) if y < 2023 else last_day
        fitm, _, _ = bm.v4_fit_mask(Ct, ok, a_day, lo)
        tst = (Ct["day"] >= lo) & (Ct["day"] < hi) & ok
        S = {}
        # baselines
        hgb = bm.hgb_head(Xeng[fitm], yv[fitm], w[fitm], Ct["day"][fitm], {})
        S["hgb_eng"] = hgb(Xeng[tst])
        P = {}
        for g in ("tod", "vol", "todvol"):
            M = de.e2_lr_fit(X[g][fitm], yv[fitm], w[fitm]); S[f"lr_{g}"] = de.e2_lr_raw(M, X[g][tst])
            P[f"lr_{g}"] = 1 / (1 + np.exp(-S[f"lr_{g}"]))
        for name, d in fm.items():
            for k, v in d["sc"].items():
                S[f"{name}:{k}"] = v[tst]  # zero-shot raw score, no fitting
            if name not in gen:
                continue
            Z = np.column_stack([X["todvol"], np.log(np.maximum(d["sc"]["s_main"], 1e-6))[:, None]])
            M = de.e2_lr_fit(Z[fitm], yv[fitm], w[fitm]); S[f"stack_{name}"] = de.e2_lr_raw(M, Z[tst])
            P[f"stack_{name}"] = 1 / (1 + np.exp(-S[f"stack_{name}"]))
            res.setdefault("stack_coef", {})[f"{name}/{y}"] = dict(cols=GROUPS["todvol"] + ["fm"], coef=M["coef"])
        if len(gen) > 1:
            Z = np.column_stack([X["todvol"]] + [np.log(np.maximum(d["sc"]["s_main"], 1e-6))[:, None] for d in gen.values()])
            M = de.e2_lr_fit(Z[fitm], yv[fitm], w[fitm]); S["stack_allfm"] = de.e2_lr_raw(M, Z[tst])
            P["stack_allfm"] = 1 / (1 + np.exp(-S["stack_allfm"]))
        yt = yv[tst]; dt = Ct["day"][tst]
        fr = dict(fit=int(fitm.sum()), test=int(tst.sum()), base=float(yt.mean()), auc={})
        for k, s in S.items():
            fr["auc"][k] = A.auc_ci(yt, s, dt, rng)
        res["folds"][str(y)] = fr
        keep[y] = (yt, dt, S, P, tst)
        for k in S:
            de.log_trial({"exp": EXP, "mode": "dev" if y < 2023 else "devwindow2023", "inst": INST, "pop": "P3", "target": "T2",
                          "fold": y, "scorer": k, "kx": kx, "auc_test": fr["auc"][k][0], "fm2_sha256": sha("fm2.py")})
        print(INST, y, {k: round(v[0], 3) for k, v in fr["auc"].items()}, flush=True)
    res["pooled"] = {}
    for part, ys in (("dev2020_22", [2020, 2021, 2022]), ("w2023", [2023])):
        yt = np.concatenate([keep[y][0] for y in ys]); dt = np.concatenate([keep[y][1] for y in ys])
        S = {k: np.concatenate([keep[y][2][k] for y in ys]) for k in keep[ys[0]][2]}
        P = {k: np.concatenate([keep[y][3][k] for y in ys]) for k in keep[ys[0]][3]}
        o = dict(n=int(len(yt)), base=float(yt.mean()), auc={k: A.auc_ci(yt, s, dt, rng) for k, s in S.items()}, paired={}, cal={})
        for k in S:
            if k.startswith(("stack_",)) or ":s_main" in k:
                o["paired"][f"{k} - hgb_eng"] = paired_boot(yt, S[k], S["hgb_eng"], dt, rng)
                o["paired"][f"{k} - lr_tod"] = paired_boot(yt, S[k], S["lr_tod"], dt, rng)
                o["paired"][f"{k} - lr_todvol"] = paired_boot(yt, S[k], S["lr_todvol"], dt, rng)
        for k, p in P.items():
            qb = (0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 1.01)
            o["cal"][k] = dict(scores=de.scores(p, yt), rel=de.reliability(p, yt, qb))
        res["pooled"][part] = o
    # T3 sanity: signed FM direction score vs first-passage direction (rows with a big move)
    res["T3"] = {}
    for name, d in fm.items():
        if "s_dir" not in d["sc"]:
            continue
        sd = d["sc"]["s_dir"] * C["s"]  # side-signed expected move
        for part, (lo, hi) in (("dev2020_22", (year_start_day(2020), year_start_day(2023))), ("w2023", (year_start_day(2023), last_day))):
            m = lab3 & ok & (C["day"] >= lo) & (C["day"] < hi) & np.isfinite(sd)
            res["T3"][f"{name}/{part}"] = dict(n=int(m.sum()), base=float(C3["y"][m].mean()),
                                               auc=A.auc_ci(C3["y"][m], sd[m], C["day"][m], rng))
    json.dump(res, open(os.path.join(OUT, f"eval_{TAG}.json"), "w"), indent=1, default=float)
    print("done", TAG)


if __name__ == "__main__":
    {"export": export, "eval": evaluate}[MODE]()
