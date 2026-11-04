"""Print vm40 tables from out/results.json."""
import json, os
R = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "results.json")))
C = R["cells"]
pct = lambda x: f"{100 * x:+.1f}%"
ci = lambda a: f"[{a[0]:+.2f},{a[1]:+.2f}]"
def row(u, cell, wn):
    s = C[u][cell][wn]
    return (f"{u:11s} {cell:26s} {wn:5s} n{s['days']:5d} BH {pct(s['bh_ret'])}/{100*s['bh_vol']:.1f}/{s['bh_sharpe']:+.2f} "
            f"M {pct(s['m_ret'])}/{100*s['m_vol']:.1f}/{s['m_sharpe']:+.2f} d {s['diff']:+.2f} {ci(s['diff_ci'])} "
            f"a {pct(s['alpha'])} [{pct(s['alpha_ci'][0])},{pct(s['alpha_ci'][1])}] b {s['beta']:.2f} "
            f"DD {pct(s['bh_mdd'])}/{pct(s['m_mdd'])} TO {s['turnover_ann']:.1f} MDE {s['mde80']:.2f}")
print("== primary + variants SPX")
for cell in ["rv21_cap2_causal_gross", "rv21_cap2_causal_net", "rv21_cap2_full_gross", "rv21_cap1_causal_gross",
             "rv21_cap1_full_gross", "rv10_cap2_causal_gross", "rv63_cap2_causal_gross", "rv10_cap1_causal_gross", "rv63_cap1_causal_gross"]:
    for wn in ("dev", "w2023"):
        print(row("SPX500_USD", cell, wn))
for cell in ["rv21_cap2_causal_gross", "rv21_cap1_causal_gross", "rv21_cap2_full_gross"]:
    print("== all units", cell)
    for u in C:
        for wn in ("dev", "w2023"):
            print(row(u, cell, wn))
print("== mean weight SPX")
for k, v in R["mean_weight"].items():
    if k.startswith("SPX"):
        print(k, {w: round(x, 3) for w, x in v.items()})
print("== mean weight rv21 cap2 causal all")
for k, v in R["mean_weight"].items():
    if k.endswith("rv21_cap2_causal"):
        print(k, {w: round(x, 3) for w, x in v.items()})
print("== yearly SPX primary")
for y, s in R["yearly"].items():
    print(y, f"BH {s['bh_sharpe']:+.2f} M {s['m_sharpe']:+.2f} d {s['diff']:+.2f} BHret {pct(s['bh_ret'])} Mret {pct(s['m_ret'])} w {s['mean_w']:.2f}")
n = sum(1 for u in C for c in C[u] for w in C[u][c] if C[u][c][w]["diff_ci"][0] > 0)
m = sum(1 for u in C for c in C[u] for w in C[u][c] if C[u][c][w]["diff_ci"][1] < 0)
both = [(u, c) for u in C for c in C[u] if all(C[u][c][w]["diff_ci"][0] > 0 for w in ("dev", "w2023"))]
print("rows CI>0", n, "CI<0", m, "of", sum(len(C[u][c]) for u in C for c in C[u]), "both windows >0:", both)
print("verdict", R["verdict"])
