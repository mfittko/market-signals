"""Print imom34 tables from out/results.json -> out/report.txt."""
import os, json
HERE = os.path.dirname(os.path.abspath(__file__))
Z = json.load(open(os.path.join(HERE, "out", "results.json")))
f = lambda x: f"{x:+.2f}"
c = lambda d: f"[{d['ci'][0]:+.2f},{d['ci'][1]:+.2f}]"
L = [f"VERDICT (SPX500 on1 gross bps, CI lb > 0 in both windows): {Z['verdict']} lb {Z['primary_lb']}", ""]
L.append("inst        win    valid skipB skipP Rmed | sig   n    gross bps [CI]        MDE80  gross R [CI]        net bps [CI]          hit")
for r in Z["results"]:
    for w in ("dev", "w2023"):
        x = r[w]
        for k in ["on1", "r1", "r12", "both", "on1|big1=1", "on1|big1=0", "on1|hivol=1", "on1|hivol=0"]:
            y = x[k]
            if "gross" not in y:
                L.append(f"{r['inst']:11s} {w:5s} {k:11s} n {y['n']}"); continue
            L.append(f"{r['inst']:11s} {w:5s} {x['valid']:5d} {x['skip_bars']:4d} {x['skip_prev']:3d} {x['R_median_bps']:5.1f} | {k:11s} "
                     f"{y['n']:5d} {f(y['gross']['mean'])} {c(y['gross'])} {y['gross']['mde80']:5.2f} "
                     f"{y['gross_R']['mean']:+.3f} {c(y['gross_R'])} {f(y['net']['mean'])} {c(y['net'])} {y['hit']['mean']:.3f}")
        L.append(f"{'':18s} drift long {x['drift_long']['mean']:+.2f} bps")
        for rg in ("reg_on_r1", "reg_on_r1_r12"):
            g = x[rg]
            L.append(f"{'':18s} {rg} R2 {g['r2']:.4f} " + " ".join(f"{k} {v['b']:+.4f} [{v['ci'][0]:+.4f},{v['ci'][1]:+.4f}]"
                                                                for k, v in g["coef"].items() if k != "const"))
open(os.path.join(HERE, "out", "report.txt"), "w").write("\n".join(L) + "\n")
print("\n".join(L))
