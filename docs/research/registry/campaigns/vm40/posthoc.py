"""vm40 POST-HOC (after the registered run; never decides the verdict).
1) rows whose Sharpe-difference CI lies below 0.
2) cap 1.0 with a target mean weight below 1. The registered cap 1.0 variant is degenerate: mean(min(c/RV, 1)) = 1
   forces w = 1 every day, so it equals buy-and-hold. Here c_t solves mean(min(c/RV_s, 1)) = T (causal, expanding),
   T in {0.75, 0.5}; uninvested cash earns 0. Compared with buy-and-hold (Sharpe) and with a constant weight T
   (same average exposure): Sharpe is scale-free, so the constant-T row only differs in return/vol/drawdown.
"""
import json, os, sys
import numpy as np
import pandas as pd
import vm40 as V

HERE = os.path.dirname(os.path.abspath(__file__))


def solve_c_t(iv, cap, T):
    lo, hi = 0.0, 10.0 / iv.min() + 10.0 / iv.mean()
    for _ in range(60):
        m = 0.5 * (lo + hi)
        lo, hi = (m, hi) if np.minimum(m * iv, cap).mean() < T else (lo, m)
    return 0.5 * (lo + hi)


def causal_w(iv, cap, T):
    v = iv.to_numpy(); w = np.full(len(v), np.nan); ok = np.flatnonzero(np.isfinite(v))
    for j in range(V.MIN_HIST - 1, len(ok)):
        w[ok[j]] = min(solve_c_t(v[ok[:j + 1]], cap, T) * v[ok[j]], cap)
    return pd.Series(w, iv.index)


def main():
    R = json.load(open(os.path.join(HERE, "out", "results.json")))
    out = {"ci_below_0": [], "cap1_target": {}}
    for u, cells in R["cells"].items():
        for c, ws in cells.items():
            for wn, s in ws.items():
                if s["diff_ci"][1] < 0:
                    out["ci_below_0"].append([u, c, wn, round(s["diff"], 2), [round(x, 2) for x in s["diff_ci"]]])
    S = V.load()
    for T in (0.75, 0.5):
        fr = {}
        for i in V.INDICES:
            r = S[i].pct_change()
            w = causal_w(V.inv_var(r, 21), 1.0, T)
            f = pd.DataFrame({"r": r, "w": w}).dropna()
            f["m"] = f.w * f.r; f["dw"] = f.w.diff().abs()
            fr[i] = f
        for wn in V.WINDOWS:
            for u in ("SPX500_USD", "POOL8"):
                fs = [V.window(fr[i], wn) for i in (V.INDICES if u == "POOL8" else [u])]
                m = pd.concat([f.m for f in fs], axis=1, sort=True).mean(axis=1).to_numpy()
                b = pd.concat([f.r for f in fs], axis=1, sort=True).mean(axis=1).to_numpy()
                dw = pd.concat([f.dw for f in fs], axis=1, sort=True).mean(axis=1).to_numpy()
                s = V.stats(m, b, dw)
                s["const_T"] = {"ret": float(T * b.mean() * V.ANN), "vol": float(T * b.std(ddof=1) * np.sqrt(V.ANN)),
                                "mdd": V.maxdd(T * b)}
                s["mean_w"] = float(np.mean([V.window(fr[i], wn).w.mean() for i in (V.INDICES if u == "POOL8" else [u])]))
                out["cap1_target"][f"T{T}_{u}_{wn}"] = s
    json.dump(out, open(os.path.join(HERE, "out", "posthoc.json"), "w"), indent=1)
    for row in out["ci_below_0"]:
        print(row)
    for k, s in out["cap1_target"].items():
        print(k, f"w {s['mean_w']:.2f} BH {100*s['bh_ret']:+.1f}/{100*s['bh_vol']:.1f}/{s['bh_sharpe']:+.2f} "
              f"M {100*s['m_ret']:+.1f}/{100*s['m_vol']:.1f}/{s['m_sharpe']:+.2f} d {s['diff']:+.2f} "
              f"[{s['diff_ci'][0]:+.2f},{s['diff_ci'][1]:+.2f}] DD BH {100*s['bh_mdd']:.1f} M {100*s['m_mdd']:.1f} "
              f"constT {100*s['const_T']['ret']:+.1f}/{100*s['const_T']['vol']:.1f}/DD {100*s['const_T']['mdd']:.1f} TO {s['turnover_ann']:.1f}")




def log_trials():
    """Append the post-hoc cap-1 target rows to trials.jsonl (primary false, posthoc true)."""
    import time
    P = json.load(open(os.path.join(HERE, "out", "posthoc.json")))
    ts = time.strftime("%Y-%m-%dT%H:%M:%S")
    with open(V.TRIALS, "a") as fh:
        for k, s in P["cap1_target"].items():
            T, rest = k.split("_", 1)
            u, wn = rest.rsplit("_", 1)
            fh.write(json.dumps({"ts": ts, "exp": V.EXP, "unit": u, "tf": "D", "cell": f"rv21_cap1_causal_{T}_gross",
                                 "window": wn, "primary": False, "posthoc": True, **s}) + "\n")
    print(len(P["cap1_target"]), "post-hoc trial rows")


if __name__ == "__main__":
    log_trials() if sys.argv[1:] == ["log"] else main()
