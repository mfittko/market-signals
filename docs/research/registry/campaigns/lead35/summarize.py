"""Tables from out/results.json -> out/report.txt."""
import os, json
HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "out", "results.json")))
W = ("dev", "w2023")
L = []
p = L.append
f = lambda x, d=3: f"{x:+.{d}f}"
cif = lambda c, d=3: f"[{c[0]:+.{d}f},{c[1]:+.{d}f}]"

p(f"VERDICT {R['verdict']} primary CI lower bounds {R['primary_lb']}\n")
p("STEP 0 xcorr corr(rL[m-lag], rF[m]) M1")
p("pair | window | n | lag0 | lag1 | lag2 | lag3 | lag4 | lag5")
for r in R["results"]:
    if r["tf"] != "M1":
        continue
    for w in W:
        x = r[w]["xcorr"]
        p(f"{r['pair']} | {w} | {x['0']['n']:,} | " + " | ".join(f"{x[str(j)]['rho']:+.4f}" for j in range(6)))


def row(c):
    if "gross_atr" not in c:
        return f"n {c.get('n')}"
    g, b, n, nb, h = (c[k] for k in ("gross_atr", "gross_bps", "net_atr", "net_bps", "hit"))
    return (f"n {c['n']:,} | gross {f(g['mean'])} {cif(g['ci'])} ATR | {f(b['mean'],2)} bps {cif(b['ci'],2)} | "
            f"net {f(n['mean'])} ATR {f(nb['mean'],2)} bps | hit {h['mean']:.3f} | MDE80 {g['mde80']:.3f}")


for tf in ("M1", "M5"):
    for r in R["results"]:
        if r["tf"] != tf:
            continue
        p(f"\n== {tf} {r['pair']}")
        for key in ("k1|lag", "k3|lag", "k1|nolag", "k3|nolag"):
            for w in W:
                c = r[w][key]
                for hk in ("h2", "h5", "h10", "h5|asia", "h5|london", "h5|ny"):
                    if hk in c:
                        p(f"{key} {hk:10s} {w:6s} {row(c[hk])}")
open(os.path.join(HERE, "out", "report.txt"), "w").write("\n".join(L) + "\n")
print("\n".join(L))
