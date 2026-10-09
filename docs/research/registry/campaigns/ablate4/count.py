"""Counts coverage-curve points whose paired CI vs the unselected policy excludes 0, and points with absolute CI > 0."""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
for inst in sys.argv[1:]:
    d = json.load(open(os.path.join(HERE, "out", inst + ".json")))
    n = up = dn = absp = 0; hits = []
    for part, P in d["pooled"].items():
        for pop, po in P.items():
            for cell, o in po.items():
                for q, c in (o.get("coverage") or {}).items() if isinstance(o, dict) else []:
                    if "vs_D" not in c:
                        continue
                    n += 1; lo, hi = c["vs_D"][1]
                    up += lo > 0; dn += hi < 0; absp += c["ci"][0] > 0
                    if lo > 0 or c["ci"][0] > 0:
                        hits.append((part, pop, cell, q, round(c["meanR"], 3), round(c["vs_D"][0], 3), c["trades"]))
    print(inst, dict(points=n, above_D=up, below_D=dn, abs_ci_above_0=absp), hits)
