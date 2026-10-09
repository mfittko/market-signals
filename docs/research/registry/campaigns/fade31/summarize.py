"""Print fade31 tables from out/results.json -> out/report.txt."""
import os, json
HERE = os.path.dirname(os.path.abspath(__file__))
Z = json.load(open(os.path.join(HERE, "out", "results.json")))
f = lambda x: "   -  " if x is None else f"{x:+.3f}"
c = lambda d: f"[{d['ci'][0]:+.3f},{d['ci'][1]:+.3f}]" if d and d.get("ci") else "[   -   ]"
L = [f"VERDICT (WTI M5 no-news fades, gross, primary exits): {Z['verdict']}", ""]
L.append("signals before the one-trade filter (nonews/news/excl) | kept trades (nonews/news/excl)")
for r in Z["results"]:
    for w in ("dev", "w2023"):
        s, k = r[w]["signals"], r[w]["P"]["kept"]
        L.append(f"{r['inst']:11s} {r['tf']:3s} {w:5s} {s['nonews']:6d}/{s['news']:4d}/{s['excl']:6d} | {k['nonews']:6d}/{k['news']:4d}/{k['excl']:6d}")
for var, name in (("P", "PRIMARY exits (+0.5 R / -1 R / bar 6)"), ("T1", "target 1.0 R"), ("TO", "time exit only")):
    L += ["", f"== {name}: no-news n, gross [CI], MDE80, net [CI], hit, per day | news n, gross | news-nonews [CI] | all signals n, gross [CI]"]
    for r in Z["results"]:
        for w in ("dev", "w2023"):
            x = r[w][var]; nn, nw, al = x["nonews"], x["news"], x["all"]; d = x["news_minus_nonews"]
            L.append(f"{r['inst']:11s} {r['tf']:3s} {w:5s} n {nn['gross']['n']:6d} {f(nn['gross'].get('mean'))} {c(nn['gross'])} "
                     f"{nn['gross'].get('mde80', 0):.3f} net {f(nn['net'].get('mean'))} {c(nn['net'])} hit {nn['gross'].get('hit', 0):.3f} "
                     f"{nn['per_day']:.2f}/d | n {nw['gross']['n']:4d} {f(nw['gross'].get('mean'))} | "
                     f"{f(d and d['diff'])} {c(d)} | n {al['gross']['n']:6d} {f(al['gross'].get('mean'))} {c(al['gross'])}")
open(os.path.join(HERE, "out", "report.txt"), "w").write("\n".join(L) + "\n")
print("\n".join(L))
