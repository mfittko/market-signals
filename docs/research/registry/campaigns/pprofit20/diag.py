"""pprofit20 diagnostics (post hoc, NOT registered; never change the pass status):
  1. spread-only and hour-only baselines (AUC of -spr per side/window) to show how much of the ranking is cost
  2. isotonic recalibration of the same walk-forward raw scores (same calibration windows) for the failing instruments
  3. artifact recompute: P from the exported artifact JSON + fixture features equals the fixture P (1e-12)
"""
import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np  # noqa: E402
from sklearn.isotonic import IsotonicRegression  # noqa: E402
import pp20 as pp  # noqa: E402

OUT = os.path.join(HERE, "out")


def iso_walk(R, tcut):
    P = np.full(len(R["t"]), np.nan)
    for a, b in pp.quarters(R["t"].min(), tcut):
        cs = a - pp.CAL_DAYS * 1440
        mtr = R["texit"] < cs; mcal = (R["t"] >= cs) & (R["texit"] < a); mte = (R["t"] >= a) & (R["t"] < b)
        if mtr.sum() < 20000 or mcal.sum() < 5000 or not mte.any():
            continue
        M = pp.fit(R, mtr, mcal)
        ir = IsotonicRegression(out_of_bounds="clip").fit(pp.score(M, R, mcal), R["y"][mcal])
        P[mte] = ir.predict(pp.score(M, R, mte))
    return P


def max_gap(R, P, m, sd):
    k = m & (R["side"] == sd) & np.isfinite(P)
    dec, _ = pp.deciles(P[k] + 1e-12 * np.arange(k.sum()) / k.sum())  # break isotonic ties deterministically
    return max(abs(P[k][dec == d].mean() - R["y"][k][dec == d].mean()) for d in range(10))


def main():
    tcut = pp.mins(pp.CUT); out = {}
    for inst in pp.INSTS:
        m1, _ = pp.load_m1c(inst)
        B, Fb = pp.frame(inst, m1)
        R = pp.rows(B, Fb)
        d = {}
        for wn, m in (("dev2019_22", (R["t"] >= pp.mins("2019-01-01")) & (R["t"] < pp.mins(pp.DEV_END))), ("w2023", R["t"] >= pp.mins(pp.DEV_END))):
            d[wn] = {}
            for sd, nm in ((1, "long"), (-1, "short")):
                k = m & (R["side"] == sd)
                d[wn][nm] = dict(auc_spread_only=pp.auc(R["y"][k], -R["spr"][k]))
        if not json.load(open(os.path.join(OUT, f"results_{inst.replace('/', '_')}{pp.SUF}.json")))["calib_pass"]:
            Pi = iso_walk(R, tcut)
            for wn, m in (("dev2019_22", R["t"] < pp.mins(pp.DEV_END)), ("w2023", R["t"] >= pp.mins(pp.DEV_END))):
                for sd, nm in ((1, "long"), (-1, "short")):
                    d[wn][nm]["isotonic_max_abs_gap"] = float(max_gap(R, Pi, m, sd))
        out[inst] = d
        print(inst, json.dumps(d), flush=True)
    # artifact recompute
    for tag in ("WTICO_USD" + pp.SUF, "EUR_USD" + pp.SUF):
        A = json.load(open(os.path.join(OUT, f"artifact_{tag}_pprofit20.json")))
        F = json.load(open(os.path.join(OUT, f"parity_{tag}_pprofit20.json")))
        mu, sdv, w = np.array(A["scaler"]["mean"]), np.array(A["scaler"]["std"]), np.array(A["coef"])
        worst = 0.0
        for r in F["rows"]:
            x = np.array([r["features"][f] for f in A["features"]["order"]])
            z = (x - mu) / sdv
            raw = A["intercept"] + w @ np.r_[z, r["side"], r["side"] * z]
            p = 1 / (1 + np.exp(-(A["calibrator"]["a"] * raw + A["calibrator"]["b"])))
            lr = r["lrng_raw"] - A["tod_norm"][((pp.mins(r["t"]) + 120) % 1440) // pp.GM]
            worst = max(worst, abs(raw - r["raw"]), abs(p - r["p"]), abs(lr - r["features"]["lrng"]))
        out[tag + "_artifact_recompute_max_abs_diff"] = worst
        print(tag, "artifact recompute max diff", worst)
    json.dump(out, open(os.path.join(OUT, f"diag{pp.SUF}.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
