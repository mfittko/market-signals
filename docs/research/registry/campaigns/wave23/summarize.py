"""Print wave23 tables from out/results.json."""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "out", "results.json")))
f = lambda x, n=3: "na" if x is None else f"{x:+.{n}f}"
ci = lambda c: "na" if not c else f"[{c[0]:+.3f},{c[1]:+.3f}]"


def row(nm, unit, w):
    r = R["results"][nm][unit].get(w)
    if not r:
        return f"{nm:32s} {unit:10s} {w:12s} (no data)"
    a = r["armed"]
    if not a.get("n_days"):
        return f"{nm:32s} {unit:10s} {w:12s} (no days)"
    s = (f"{nm:32s} {unit:10s} {w:12s} days {a['n_days']:5d} tr {a['n_trades']:5d} R/day {f(a['R_per_day'])} {ci(a['ci'])} "
         f"mde {a['mde80']:.3f} | R/att {f(a.get('R_per_attempt'))} hit {a.get('hit', 0):.2f} pay {f(a.get('payoff'), 2)} "
         f"top10 {f(a.get('top10_share_of_win_R'), 2)} maxR {f(a.get('max_R'), 1)} DD {a.get('maxdd_R', 0):.1f} cvar5 {f(a.get('cvar5_day'), 2)}")
    for c in ("C1", "C2", "C3"):
        s += f" | {c} {f(r[c].get('R_per_day'))} d {f(r['diff_' + c].get('diff'))} {ci(r['diff_' + c].get('ci'))}"
    return s


mode = sys.argv[1] if len(sys.argv) > 1 else "decision"
if mode == "decision":
    for nm, d in R["decision"].items():
        print(nm, d)
        for w in ("dev", "w2023", "2020H1", "2022H1", "2025Q4_26Q1"):
            print("  ", row(nm, "POOLED", w))
elif mode == "sens":
    for nm in R["results"]:
        for w in ("dev", "w2023"):
            print(row(nm, "POOLED", w))
elif mode == "inst":
    nm = sys.argv[2]
    for u in R["results"][nm]:
        for w in ("dev", "w2023", "2020H1", "2022H1", "2025Q4_26Q1"):
            print(row(nm, u, w))
