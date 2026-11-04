"""scan46 report: overfitting illustration, shrinkage, swing44 reference rank (reads out/cells.parquet and the scan46
instrument rows in trials.jsonl; never opens the locked data). Writes out/report.json."""
import os, json, math
import numpy as np
import pandas as pd
from scipy.stats import spearmanr, norm

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
TRIALS = os.path.join(os.path.dirname(os.path.dirname(HERE)), "trials.jsonl")
YEARS = {"D": {"disc": 14.0, "val": 4.0}, "H4": {"disc": 4.0, "val": 2.0}, "H1": {"disc": 4.0, "val": 2.0}}

C = pd.read_parquet(os.path.join(OUT, "cells.parquet"))
rep = {}
inst = []
with open(TRIALS) as fh:
    for line in fh:
        if '"exp": "scan46"' in line and '"role": "instrument"' in line:
            r = json.loads(line)
            inst.append((r["tf"], r["cell"], r["unit"], r.get("sr_disc"), r.get("sr_val"), r.get("sr_w2023"), r.get("tpy_disc")))
I = pd.DataFrame(inst, columns=["tf", "cell", "unit", "sr_disc", "sr_val", "sr_w2023", "tpy"])
for tf in ("D", "H4", "H1"):
    c = C[C.tf == tf]
    i = I[I.tf == tf]
    z_inst = i.sr_disc * math.sqrt(YEARS[tf]["disc"])   # approx t-stat of the annualized Sharpe
    d = {"class_cells": int(len(c)), "naive_p05_class": int((c.psr0 > 0.95).sum()),
         "naive_p05_class_neg_side": int((c.psr0 < 0.05).sum()),
         "dsr_pass": int(c.pass_dsr.sum()), "dsr_and_val": int(c.pass_val.sum()),
         "instrument_cells": int(len(i)), "naive_p05_instrument_approx": int((norm.sf(z_inst) < 0.05).sum()),
         "max_dsr": float(c.dsr.max()), "max_sr_ann_disc": float(c.sr_ann_disc.max()),
         "median_sr_ann_disc": float(c.sr_ann_disc.median()), "median_sr_ann_val": float(c.sr_ann_val.median()),
         "share_pos_disc": float((c.sr_ann_disc > 0).mean()), "share_pos_val": float((c.sr_ann_val > 0).mean())}
    ok = c.sr_ann_disc.notna() & c.sr_ann_val.notna()
    rho = spearmanr(c.sr_ann_disc[ok], c.sr_ann_val[ok])
    d["spearman_disc_val"] = [float(rho.statistic), float(rho.pvalue)]
    d["ols_slope_val_on_disc"] = float(np.polyfit(c.sr_ann_disc[ok], c.sr_ann_val[ok], 1)[0])
    s = c[ok].sort_values("sr_ann_disc", ascending=False)
    k1 = max(1, int(round(0.01 * len(s))))
    d["top10"] = {"mean_disc": float(s.sr_ann_disc.head(10).mean()), "mean_val": float(s.sr_ann_val.head(10).mean()),
                  "share_val_pos": float((s.sr_ann_val.head(10) > 0).mean())}
    d["top1pct"] = {"k": k1, "mean_disc": float(s.sr_ann_disc.head(k1).mean()), "mean_val": float(s.sr_ann_val.head(k1).mean())}
    d["top10_cells"] = s.head(10)[["cell", "cls", "sr_ann_disc", "sr_ann_val", "dsr"]
                                  + (["sr_ann_w2023"] if "sr_ann_w2023" in s else [])].to_dict("records")
    ii = i.dropna(subset=["sr_disc", "sr_val"])
    d["instrument_spearman"] = float(spearmanr(ii.sr_disc, ii.sr_val).statistic)
    for cl in c.cls.unique():
        cc = c[c.cls == cl]
        d[f"by_class_{cl}"] = {"cells": int(len(cc)), "naive": int((cc.psr0 > 0.95).sum()), "dsr": int(cc.pass_dsr.sum()),
                               "val": int(cc.pass_val.sum()), "median_disc": float(cc.sr_ann_disc.median()),
                               "median_val": float(cc.sr_ann_val.median())}
    fam = c.groupby("family").agg(med_disc=("sr_ann_disc", "median"), med_val=("sr_ann_val", "median"),
                                  best_disc=("sr_ann_disc", "max"))
    d["family_medians"] = fam.round(3).to_dict("index")
    rep[tf] = d
# swing44 reference rule
D = C[(C.tf == "D") & (C.cls == "index")].copy()
for w in ("disc", "val", "w2023"):
    D[f"rank_{w}"] = D[f"sr_ann_{w}"].rank(ascending=False)
r = D[D.cell == "consec_pullback(down=3)"].iloc[0]
rep["swing44_reference"] = {"cell": r.cell, "n_index_cells": int(len(D)),
                            **{f"sr_ann_{w}": float(r[f"sr_ann_{w}"]) for w in ("disc", "val", "w2023")},
                            **{f"rank_{w}": int(r[f"rank_{w}"]) for w in ("disc", "val", "w2023")},
                            "dsr": float(r.dsr), "psr0": float(r.psr0),
                            "rank_disc_all_daily": int((C[C.tf == "D"].sr_ann_disc > r.sr_ann_disc).sum() + 1)}
json.dump(rep, open(os.path.join(OUT, "report.json"), "w"), indent=1, default=float)
print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk not in ("family_medians", "top10_cells")} for k, v in rep.items()},
                 indent=1, default=float))
