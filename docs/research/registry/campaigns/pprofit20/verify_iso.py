"""A3/A4 checks.  python verify_iso.py self                 np.interp over the knots == sklearn IsotonicRegression.predict
                python verify_iso.py parity [GLOB]       P from each fixture's artifact JSON + fixture features == fixture raw / P
                (default GLOB parity_*_M1_iso_pprofit20.json; Platt or isotonic calibrator read from the artifact)"""
import os, sys, json, glob
import numpy as np
from sklearn.isotonic import IsotonicRegression

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")


def self_check():
    rng = np.random.default_rng(0)
    z = rng.normal(size=20000); y = (rng.random(20000) < 1 / (1 + np.exp(-z))).astype(int)
    ir = IsotonicRegression(out_of_bounds="clip").fit(z, y)
    q = np.r_[rng.normal(size=5000) * 2, -10, 10, ir.X_thresholds_]
    assert np.all(np.diff(ir.X_thresholds_) > 0)
    d = np.abs(ir.predict(q) - np.interp(q, ir.X_thresholds_, ir.y_thresholds_)).max()
    assert d < 1e-12, d
    print("isotonic self-check OK: np.interp == sklearn predict, max diff", d, "knots", len(ir.X_thresholds_))


def parity(pattern="parity_*_M1_iso_pprofit20.json"):
    for fp in sorted(glob.glob(os.path.join(OUT, pattern))):
        F = json.load(open(fp)); A = json.load(open(os.path.join(OUT, F["artifact"])))
        mu, sd, w = np.array(A["scaler"]["mean"]), np.array(A["scaler"]["std"]), np.array(A["coef"])
        C = A["calibrator"]
        worst = 0.0
        for r in F["rows"]:
            x = np.array([r["features"][f] for f in A["features"]["order"]]); zz = (x - mu) / sd
            raw = A["intercept"] + w @ np.r_[zz, r["side"], r["side"] * zz]
            p = float(np.interp(raw, C["x"], C["y"])) if "x" in C else 1 / (1 + np.exp(-(C["a"] * raw + C["b"])))
            worst = max(worst, abs(raw - r["raw"]), abs(p - r["p"]))
        print(os.path.basename(fp), "rows", len(F["rows"]), "bars", len(F["bars"]), "pass", F.get("calibration_pass"),
              "full-history diff", F["max_abs_diff_vs_full_history"], "artifact recompute", worst)
        assert worst < 1e-9


if __name__ == "__main__":
    {"self": self_check, "parity": lambda: parity(*sys.argv[2:])}[sys.argv[1]]()
