"""Print flipdens32 tables from out/results.json -> out/report.txt."""
import os, json
HERE = os.path.dirname(os.path.abspath(__file__))
Z = json.load(open(os.path.join(HERE, "out", "results.json")))
f = lambda x: "  -   " if x is None else f"{x:+.3f}"
ci = lambda c: f"[{c[0]:+.3f},{c[1]:+.3f}]"
L = [f"VERDICT (WTI M5, scheme all): {Z['verdict']} (H {Z['H']})", ""]
for r in Z["results"]:
    for H in (1, 3, 6):
        for w in ("dev", "w2023"):
            s = r[f"H{H}|{w}"]
            if not s:
                continue
            for side in ("low", "high"):
                c = s[side]
                L.append(f"{r['inst']:11s} {r['tf']:3s} {r['scheme']:3s} H{H} {w:5s} {side:4s} n {c['n']:5d} gross {f(c['gross'])} "
                         f"{ci(c['gross_ci'])} D {f(c['D'])} {ci(c['D_ci'])} bonf3 {ci(c['D_ci_bonf3'])} p1 {c['p_one']:.3f} "
                         f"holm {c.get('p_holm', float('nan')):.3f} MDE80 {c['mde80']:.3f} net {f(c['net'])}")
            L.append(f"{'':20s} H{H} {w:5s} all n {s['all_n']} gross {f(s['all_gross'])} net {f(s['all_net'])} days {s['days']} | "
                     "n_q " + " ".join(str(x) for x in s["n_by_q"]) + " | gross_q " + " ".join(f(x) for x in s["gross_by_q"]) +
                     " | net_q " + " ".join(f(x) for x in s["net_by_q"]) + " | raw c_q " +
                     " ".join("-" if x is None else f"{x:.1f}" for x in s["raw_count_mean_by_q"]))
    L.append("")
open(os.path.join(HERE, "out", "report.txt"), "w").write("\n".join(L) + "\n")
print("\n".join(L))
