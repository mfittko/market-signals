"""POST-HOC diagnostic (not registered): what drives T2 learnability on P3 (WTI)? Feature-group LR (lr_eng learner on a
subset of ENG) fitted on the V4 fit rows of each fold, raw test AUC. Development evidence only; no trials affect any policy.
  python diag_t2.py INST"""
import os, sys, json
import run as A
from run import bm, de, np, year_start_day

GROUPS = {"time_of_day": ["tod_s", "tod_c", "dow_s", "dow_c", "nday"],
          "vol_state": ["rv12_288", "rv48_288", "rv288", "atr_px", "atr_ratio", "range", "range3"],
          "activity_spread": ["act1", "act12", "spr", "spr_chg"],
          "returns_geometry": ["r1", "r3", "r6", "r12", "r36", "r72", "body", "wick_with", "wick_against", "daymv", "dpos"],
          "all_ENG": bm.ENG}
inst = sys.argv[2]; TG = sys.argv[3] if len(sys.argv) > 3 else "T2"
m1, B, O, L = de.prep(inst, None)
Eb = bm.eng_bars(B)
cad = A.cadence_mask(B)
kx = json.load(open(os.path.join(A.OUT, inst.replace("/", "_") + ".json")))["kx"]
big, first, endb = A.big_move(B, kx)
C = A.p3_rows(B, O, cad)
Ct, lab = A.with_target(B, C, TG, (big, first, endb))
X = {g: np.column_stack([Eb[k][C["i"]] for k in cols]) for g, cols in GROUPS.items()}
ok = lab & np.isfinite(X["all_ENG"]).all(1)
out = {}
for y in A.FOLDS[1:]:
    lo = year_start_day(y); hi = year_start_day(y + 1) if y < 2023 else int(B["day"][-1]) + 1
    fitm, _, _ = bm.v4_fit_mask(Ct, ok, int(B["day"][0]), lo)
    tst = (Ct["day"] >= lo) & (Ct["day"] < hi) & ok
    out[y] = {}
    for g in GROUPS:
        M = de.e2_lr_fit(X[g][fitm], Ct["y"][fitm], Ct["w"][fitm])
        out[y][g] = round(bm.auc(Ct["y"][tst], de.e2_lr_raw(M, X[g][tst])), 3)
    print(y, out[y], flush=True)
    de.log_trial({"exp": "ablate4-posthoc", "mode": "dev" if y < 2023 else "devwindow2023", "inst": inst, "pop": "P3", "target": TG, "fold": y, "learner": "lr_eng-subset", "groups": out[y]})
json.dump(dict(inst=inst, kx=kx, posthoc=True, target=TG, auc=out), open(os.path.join(A.OUT, f"diag_{TG}_{inst.replace('/', '_')}.json"), "w"), indent=1)
