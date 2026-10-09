"""Plumbing checks on built events: UTC clock of actual ORB signals per month (DST), EIA weekday mix, spread-rule pass rates."""
import os, sys
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__))
for inst in ("SPX500_USD", "EUR_USD", "WTICO_USD"):
    z = pd.read_pickle(os.path.join(HERE, "out", f"ev_{inst}.pkl"))["res"]
    E = z["orb15"]; A = E[E.draw == -1]
    t = pd.to_datetime((A.day.to_numpy() * 1440) * 60, unit="s")
    print(inst, "orb15 actual", len(A), "ok rate", round(A.ok.mean(), 3), "start_off uniq", A.start_off.unique()[:5],
          "null ok rate", round(E[E.draw >= 0].ok.mean(), 3), "null offsets", np.percentile(E[E.draw >= 0].start_off, [0, 50, 100]))
    for k in ("mom30",):
        M = z[k]; Ma = M[M.draw == -1]
        print("  ", k, "spread-pass", round((Ma.spr <= 0.2).mean(), 3), "median spr", round(Ma.spr.median(), 3))
    if "eia" in z:
        D = z["eia"]
        wd = (D.day + 3) % 7
        print("  eia rel weekday counts", pd.Series(wd[D.is_rel]).value_counts().to_dict(), "null weekday", pd.Series(wd[~D.is_rel]).value_counts().to_dict(),
              "rel spread-pass", round((D[D.is_rel].spr <= 0.2).mean(), 3))
