"""Print flipday30 tables from out/results.json -> out/report.txt."""
import os, json
HERE = os.path.dirname(os.path.abspath(__file__))
Z = json.load(open(os.path.join(HERE, "out", "results.json")))
f = lambda x: "  -  " if x is None else f"{x:+.3f}"
ci = lambda c: f"[{c[0]:+.3f},{c[1]:+.3f}]"
L = [f"VERDICT (WTI M5 M0): {Z['verdict']}", ""]
L.append("STEP 1: Spearman pred vs post-07 count | yday | pre | med20 ; days ; mean post count by predicted quintile")
for r in Z["results"]:
    for w in ("dev", "w2023"):
        s = r[w]
        if s:
            L.append(f"{r['inst']:11s} {r['tf']:3s} {r['model']} {w:5s} rho {s['rho_pred']:+.2f} | {s['rho_yday']:+.2f} | {s['rho_pre']:+.2f} | "
                     f"{s['rho_med20']:+.2f} ; {s['days']:4d} ; " + " ".join(f"{x:.1f}" for x in s["post_by_q"]))
L += ["", "HINDSIGHT (not a policy): gross mean R per flip by REALIZED post-07 count quintile (n)"]
for r in Z["results"]:
    if r["model"] != "M0":
        continue
    for w in ("dev", "w2023"):
        s = r[w]
        L.append(f"{r['inst']:11s} {r['tf']:3s} {w:5s} " + " ".join(f(x) for x in s["HINDSIGHT_gross_by_realized_q"]) +
                 "  n " + " ".join(str(x) for x in s["HINDSIGHT_n_by_realized_q"]))
L += ["", "STEP 2: Q1 (lowest predicted) and Q5 (highest): n, gross [CI], minus-all [CI], net [CI], MDE80 ; all gross ; trades/day"]
for r in Z["results"]:
    for w in ("dev", "w2023"):
        s = r[w]
        for q in ("Q1", "Q5"):
            c = s[q]
            L.append(f"{r['inst']:11s} {r['tf']:3s} {r['model']} {w:5s} {q} n {c['n']:5d} gross {f(c['gross'])} {ci(c['gross_ci'])} "
                     f"D {f(c['diff'])} {ci(c['diff_ci'])} net {f(c['net'])} {ci(c['net_ci'])} MDE80 {c['mde80_diff']:.3f} ; "
                     f"all {f(c['all_gross'])} n {c['all_n']} ; {s['trades_per_day']:.2f}/day")
        L.append(f"{'':21s} {w:5s} gross by q " + " ".join(f(x) for x in s["gross_by_q"]) + " | net by q " +
                 " ".join(f(x) for x in s["net_by_q"]) + f" | all net {f(s['all_net'])}")
open(os.path.join(HERE, "out", "report.txt"), "w").write("\n".join(L) + "\n")
print("\n".join(L))
