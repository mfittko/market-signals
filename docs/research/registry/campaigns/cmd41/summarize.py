"""cmd41 summary tables from out/results.json (+ roll drops per window, recomputed from the same build). Writes out/summary.txt."""
import json, os, sys
import numpy as np
import pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cmd41

R = json.load(open(os.path.join(cmd41.OUT, "results.json")))
C = R["cells"]
L = []
f = lambda s: (f"n {s['n']:4d}  {s['mean_sig']:+.3f} [{s['ci_sig'][0]:+.3f},{s['ci_sig'][1]:+.3f}]  {s['mean_bps']:+7.1f} bps  hit {s['hit']:.2f}"
               f"  cfd {s['net_bps']:+7.1f} [{s['ci_net'][0]:+.0f},{s['ci_net'][1]:+.0f}]  fut {s.get('fut_bps', float('nan')):+7.1f}  mde80 {s['mde80_sig']:.2f}") if "mean_sig" in s else f"n {s['n']}"
L.append(f"verdict {R['verdict']}")
for key in ["k2.5_h5_close_all_all"]:
    for w in cmd41.WINDOWS:
        L.append(f"PRIMARY {w:6s} {f(C[f'{key}_{w}'])}")
L.append("\n-- h x entry (k2.5, all)")
for e in ("close", "next"):
    for h in cmd41.HS:
        L.append(f"h{h:<2d} {e:5s} " + " | ".join(f"{w} {f(C[f'k2.5_h{h}_{e}_all_all_{w}'])}" for w in cmd41.WINDOWS))
L.append("\n-- thresholds (h5 close, all)")
for k in cmd41.THRESHOLDS:
    L.append(f"k{k} " + " | ".join(f"{w} {f(C[f'k{k}_h5_close_all_all_{w}'])}" for w in cmd41.WINDOWS))
L.append("\n-- groups and markets (k2.5 h5 close)")
for u in [*cmd41.GROUPS, "GF", "HE", "HO", "KE", "LE", "PA", "RB", "ZL", "ZM", "ZO"]:
    L.append(f"{u:9s} " + " | ".join(f"{w} {f(C[f'k2.5_h5_close_{u}_all_{w}'])}" for w in cmd41.WINDOWS))
L.append("\n-- up vs down (k2.5 h5 close)")
for d in ("up", "down"):
    L.append(f"{d:5s} " + " | ".join(f"{w} {f(C[f'k2.5_h5_close_all_{d}_{w}'])}" for w in cmd41.WINDOWS))
L.append("\n-- combined with ext39 commodities (NOT independent)")
for w in cmd41.WINDOWS:
    L.append(f"ext39 alone {w} {f(R['ext39_commodities_alone'][w])}")
    L.append(f"combined    {w} {f(R['combined_ext39_commodities_not_independent'][w])}")
# CI-excluding-zero tally over all cells
pos = sum(1 for s in C.values() if "ci_sig" in s and s["ci_sig"][0] > 0)
neg = sum(1 for s in C.values() if "ci_sig" in s and s["ci_sig"][1] < 0)
L.append(f"\ncells with CI > 0: {pos}, CI < 0: {neg}, of {sum(1 for s in C.values() if 'ci_sig' in s)} with n >= 5 ({len(C)} total)")
# roll drops per window (primary)
data = cmd41.load()
rows = []
for m, fr in data.items():
    t, r, sig, iid = cmd41.events(fr, cmd41.PRIMARY_K)
    te = cmd41.outcomes(fr, t, np.sign(r[t]), sig, iid, 5, 0)[0]
    ex = t[t + 5 < len(fr)]
    for w, (a, b) in cmd41.WINDOWS.items():
        dts = fr.index[ex]; kd = fr.index[te]
        n_ev = int(((dts >= a) & (dts <= b)).sum()); n_k = int(((kd >= a) & (kd <= b)).sum())
        rows.append({"mkt": m, "w": w, "events_with_exit": n_ev, "kept": n_k, "roll_drop": n_ev - n_k})
rd = pd.DataFrame(rows)
L.append("\n-- roll drops, k2.5 h5 close, per window\n" + rd.groupby("w")[["events_with_exit", "kept", "roll_drop"]].sum().to_string())
L.append(rd.pivot(index="mkt", columns="w", values=["kept", "roll_drop"]).to_string())
txt = "\n".join(L)
open(os.path.join(cmd41.OUT, "summary.txt"), "w").write(txt + "\n")
print(txt)
