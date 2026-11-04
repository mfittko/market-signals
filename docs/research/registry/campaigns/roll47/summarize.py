"""Print the roll47 tables from out/cells.json."""
import json, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "out", "cells.json")))
f = lambda x: "nan" if x is None or not np.isfinite(x) else f"{x:+.2f}"
c = lambda v: "[" + ",".join(f(x) for x in v) + "]" if v else "-"

if sys.argv[1:] == ["wti"]:
    for r in R:
        if r["inst"] == "WTICO/USD":
            print(r["win"], r["thr"], r["dir"], r["h"], "n", r["n"], "tpd %.2f" % r["trades_per_day"], "gross", f(r.get("gross")),
                  c(r.get("gross_ci")), "holm %.3f" % r.get("holm_p", 1), "net", f(r.get("net")), c(r.get("net_ci")),
                  "sig", f(r.get("sigma")), "hit %.3f" % r.get("hit", np.nan), "mde", f(r.get("mde80")),
                  "spsh %.2f" % r.get("spread_share", np.nan), "drop", r["dropped_exit"])
elif sys.argv[1:] == ["tod"]:
    for r in R:
        if r["inst"] == "WTICO/USD" and r["dir"] == "CONTINUE" and r["h"] == 60:
            print(r["win"], r["thr"], {k: (v["n"], round(v["gross_continue"], 2)) for k, v in r["tod"].items()})
else:
    # per instrument and window: cells with gross CI excluding 0, by threshold kind and sign; net CI > 0 count
    out = {}
    for r in R:
        if "gross_ci" not in r:
            continue
        k = (r["inst"], r["win"], r["thr"][:3])
        d = out.setdefault(k, dict(cells=0, pos=0, neg=0, netpos=0, best=None))
        d["cells"] += 1
        d["pos"] += r["gross_ci"][0] > 0
        d["neg"] += r["gross_ci"][1] < 0
        d["netpos"] += r["net_ci"][0] > 0
        if d["best"] is None or r["net"] > d["best"][0]:
            d["best"] = (round(r["net"], 2), r["thr"], r["dir"], r["h"], round(r["gross"], 2), r["n"])
    for k, d in out.items():
        print(*k, d)
    # REVERT-favoured vs CONTINUE-favoured gross by kind (CONTINUE sign only, all instruments)
    for kind in ("fix", "vol"):
        for w in ("dev", "w2023"):
            g = [r["gross"] for r in R if r["dir"] == "CONTINUE" and r["thr"].startswith(kind) and r["win"] == w and "gross" in r]
            s = [r["sigma"] for r in R if r["dir"] == "CONTINUE" and r["thr"].startswith(kind) and r["win"] == w and "sigma" in r]
            print(kind, w, "continue-gross median %.2f bps, share>0 %.2f, sigma median %.3f, n cells %d" %
                  (np.median(g), np.mean(np.array(g) > 0), np.nanmedian(s), len(g)))

if sys.argv[1:] == ["both"]:
    # cells (CONTINUE sign) with the same gross sign in both windows and at least one CI excluding 0; plus net CI > 0
    idx = {(r["inst"], r["thr"], r["h"], r["dir"], r["win"]): r for r in R if "gross_ci" in r}
    for (i, t, h, d, w), r in idx.items():
        if w != "dev":
            continue
        q = idx.get((i, t, h, d, "w2023"))
        if q is None:
            continue
        same = np.sign(r["gross"]) == np.sign(q["gross"]) and r["gross"] > 0
        excl = r["gross_ci"][0] > 0 or q["gross_ci"][0] > 0
        netp = r["net_ci"][0] > 0 or q["net_ci"][0] > 0
        if (same and excl) or netp:
            print(i, t, h, d, "dev", f(r["gross"]), c(r["gross_ci"]), "net", f(r["net"]), c(r["net_ci"]), r["n"],
                  "| 2023+", f(q["gross"]), c(q["gross_ci"]), "net", f(q["net"]), c(q["net_ci"]), q["n"])
