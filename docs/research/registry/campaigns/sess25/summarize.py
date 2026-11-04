"""sess25 report: out/results.json -> out/report.txt"""
import os, json
HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "out", "results.json")))
C = R["cells"]
f = lambda c: f"{c[0]:+.3f} [{c[1]:+.3f},{c[2]:+.3f}]"
L = [f"sess25 verdict: {R['verdict']} (2023+ is a development window, not a holdout)", ""]
for ev, p in R["primary"].items():
    L.append(f"PRIMARY WTI M5 HIGH {ev}: PASS={p['PASS']} | " + " | ".join(
        f"{w} gross6 {f(p[w]['gross6'])} p {p[w]['p']:.3f} holm {p[w]['holm']:.3f}" for w in ("dev", "w2023")))
L.append("")
insts = ["WTICO_USD", "XAU_USD", "XAG_USD", "EUR_USD", "SPX500_USD", "NATGAS_USD"]
for tf in ("M5", "M1"):
    for ev in ("asia", "pday"):
        L.append(f"== {tf} {ev}   per window: n | gross 3/6/12 [CI] | cont 3/6/12 | net 3/6/12 | side6 p")
        for inst in insts:
            for v in ("HIGH", "QUIET"):
                for w in ("dev", "w2023"):
                    o = C.get(f"{inst}_{tf}_{ev}_{v}", {}).get(w)
                    if not o:
                        continue
                    L.append(f"{inst:10s} {v:5s} {w:5s} n {o['n']:5d} | " + " ".join(f(o[f'gross{h}']) for h in (3, 6, 12)) + " | " +
                             " ".join(f"{o[f'cont{h}'][0]:.3f}" for h in (3, 6, 12)) + " | " +
                             " ".join(f"{o[f'net{h}'][0]:+.3f}" for h in (3, 6, 12)) + f" | {o['side6']['p']:.3f}")
            for w in ("dev", "w2023"):
                d = C.get(f"{inst}_{tf}_{ev}_DIFF", {}).get(w)
                if d:
                    L.append(f"{inst:10s} HIGH-QUIET {w:5s} gross " + " ".join(f(d[f'diff_gross{h}']) for h in (3, 6, 12)))
        L.append("")
open(os.path.join(HERE, "out", "report.txt"), "w").write("\n".join(L) + "\n")
print("\n".join(L))
