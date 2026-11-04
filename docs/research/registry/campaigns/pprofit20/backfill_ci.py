"""Backfill the per-decile expected-R bootstrap interval into existing pprofit20 artifacts (PP_TF=M5 or M15).

Recomputes the walk-forward P and the final model with the current pp20.py, asserts that every exported number already
in the artifact is reproduced (coef, scaler, tod_norm, Platt, decile edges, meanR, n), then adds expected_R.<side>.meanR_ci.
No outcome, label or model changes; no trials logged (no new configuration).
"""
import os, sys, json, glob, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np  # noqa: E402
import pp20 as pp  # noqa: E402


def close(a, b):
    return np.allclose(np.asarray(a, float), np.asarray(b, float), rtol=0, atol=1e-12)


def main():
    tcut = pp.mins(pp.CUT)
    for f in sorted(glob.glob(os.path.join(pp.OUT, f"artifact_*{pp.SUF}_pprofit20.json"))):
        old = json.load(open(f))
        if old["timeframe"] != pp.TF:
            continue
        inst = old["instrument"]
        m1, src = pp.load_m1c(inst)
        assert src == old["source_cache"], (src, old["source_cache"])
        B, Fb = pp.frame(inst, m1)
        R = pp.rows(B, Fb)
        P, _, _ = pp.walk_forward(R, tcut)
        cs = tcut - pp.CAL_DAYS * 1440
        M = pp.fit(R, R["texit"] < cs, (R["t"] >= cs) & (R["texit"] < tcut))
        new = pp.artifact(inst, M, R, P, src, old["validity"])
        assert close(new["coef"], old["coef"]) and close(new["intercept"], old["intercept"])
        assert close(new["scaler"]["mean"], old["scaler"]["mean"]) and close(new["scaler"]["std"], old["scaler"]["std"])
        assert close(new["tod_norm"], old["tod_norm"])
        assert close([new["calibrator"]["a"], new["calibrator"]["b"]], [old["calibrator"]["a"], old["calibrator"]["b"]])
        for s in ("long", "short"):
            for k in ("p_edges", "meanR", "n"):
                assert close(new["expected_R"][s][k], old["expected_R"][s][k]), (inst, s, k)
            old["expected_R"][s]["meanR_ci"] = new["expected_R"][s]["meanR_ci"]
        old["expected_R"]["note"] = new["expected_R"]["note"]
        old["meanR_ci_backfill"] = {"created": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "code_sha256": pp.CODE,
                                    "check": "coef, scaler, tod_norm, Platt, decile edges, meanR and n reproduced (atol 1e-12)"}
        json.dump(old, open(f, "w"), indent=1)
        print(inst, pp.TF, "meanR_ci", {s: old["expected_R"][s]["meanR_ci"] for s in ("long", "short")}, flush=True)


if __name__ == "__main__":
    main()
