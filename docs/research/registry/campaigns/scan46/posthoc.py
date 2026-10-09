"""scan46 POST-HOC (never decides): how far the best cells are from the DSR hurdle under looser hurdle choices,
and the daily discovery top 10. Reads out/cells.parquet only; writes out/posthoc.json."""
import os, json, math
import numpy as np
import pandas as pd
from scan46 import sr0_dsr, psr

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
C = pd.read_parquet(os.path.join(OUT, "cells.parquet"))
res = {}
for tf in ("D", "H4", "H1"):
    c = C[C.tf == tf]
    sc = float(c.scale_disc.median())
    best = c.loc[c.sr_disc.idxmax()]
    alt = {"registered": (float(np.nanvar(c.sr_disc, ddof=1)), len(c)),
           "V_from_positive_cells": (float(np.nanvar(c.sr_disc[c.sr_disc > 0], ddof=1)), len(c)),
           "N_families_x_classes": (float(np.nanvar(c.sr_disc, ddof=1)), int(c.family.nunique() * c.cls.nunique())),
           "both_loose": (float(np.nanvar(c.sr_disc[c.sr_disc > 0], ddof=1)), int(c.family.nunique() * c.cls.nunique()))}
    r = {"best_cell": f"{best.cell} [{best.cls}]", "best_sr_ann_disc": float(best.sr_ann_disc),
         "best_sr_ann_val": float(best.sr_ann_val)}
    for k, (V, N) in alt.items():
        s0 = sr0_dsr(V, N)
        d = c.apply(lambda x: psr(x.sr_disc, s0, x.T_disc, x.g3_disc, x.g4_disc) if np.isfinite(x.sr_disc) else np.nan, axis=1)
        r[k] = {"N": N, "sr0_ann": s0 * sc, "max_dsr": float(d.max()), "n_dsr_gt_095": int((d > 0.95).sum()),
                "n_and_val_pos": int(((d > 0.95) & (c.sr_val > 0)).sum())}
    res[tf] = r
top = C[C.tf == "D"].sort_values("sr_ann_disc", ascending=False).head(10)
res["D_top10"] = top[["cell", "cls", "sr_ann_disc", "sr_ann_val", "sr_ann_w2023", "dsr", "psr0", "tpy_per_inst_disc"]].round(3).to_dict("records")
top = C[C.tf == "H4"].sort_values("sr_ann_disc", ascending=False).head(5)
res["H4_top5"] = top[["cell", "cls", "sr_ann_disc", "sr_ann_val", "dsr", "psr0"]].round(3).to_dict("records")
json.dump(res, open(os.path.join(OUT, "posthoc.json"), "w"), indent=1, default=float)
print(json.dumps(res, indent=1, default=float))
