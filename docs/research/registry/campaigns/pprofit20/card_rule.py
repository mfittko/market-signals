"""Card headline rule on exported artifacts: a decile qualifies when expected R >= +0.05 R and its 95% interval lies above 0.
Prints expected R [CI] by decile per side for every artifact with meanR_ci -> out/card_rule.txt"""
import os, glob, json
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
L = []
for f in sorted(glob.glob(os.path.join(OUT, "artifact_*_pprofit20.json"))):
    A = json.load(open(f))
    E = A["expected_R"]
    if "meanR_ci" not in E["long"]:
        continue
    L.append(f"## {A['instrument']} {A['timeframe']} ({A['status'][:40]})")
    for s in ("long", "short"):
        cells = [f"{m:+.3f} [{c[0]:+.3f}, {c[1]:+.3f}]" if c else "empty" for m, c in zip(E[s]["meanR"], E[s]["meanR_ci"])]
        ok = [d + 1 for d, (m, c) in enumerate(zip(E[s]["meanR"], E[s]["meanR_ci"])) if c and m >= 0.05 and c[0] > 0]
        L.append(f"{s}: qualifying deciles {ok or 'none'}; P edges {' '.join(f'{x:.3f}' for x in E[s]['p_edges'])}")
        L += [f"  d{d + 1} n {n}: {c}" for d, (n, c) in enumerate(zip(E[s]["n"], cells))]
    L.append("")
open(os.path.join(OUT, "card_rule.txt"), "w").write("\n".join(L) + "\n")
print("\n".join(L))
