"""Print news24 tables from out/results.json (gross primary per amendment 1, bid/ask net secondary)."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "out", "results.json")))
f = lambda x: "   na " if x is None else f"{x:+.3f}"
c = lambda v: "      na       " if not v else f"[{v[0]:+.3f},{v[1]:+.3f}]"
p = lambda x: " na" if x is None else f"{100 * x:3.0f}"
print("DECISION", R["decision"])
for tf in ("M5", "M15", "M1"):
    print(f"\n== {tf} ==  NEWS mean R [CI] | CONTROL mean R | NEWS-CONTROL [CI] | cont% news/ctrl | n news/ctrl")
    for inst, W in R[tf].items():
        for w in ("dev", "w2023"):
            for key in ("gross", "net"):
                for h in (3, 6, 12):
                    s = W[w][f"{key}_H{h}"]
                    flag = " SMALL-N" if s["n_news"] < 30 else ""
                    print(f"{inst:11s} {w:5s} {key:5s} H{h:<2d} news {f(s['news_mean'])} {c(s.get('news_ci'))} ctrl {f(s['ctrl_mean'])} "
                          f"diff {f(s.get('diff'))} {c(s.get('diff_ci'))} cont {p(s['news_cont'])}/{p(s['ctrl_cont'])} "
                          f"n {s['n_news']}/{s['n_ctrl']}{flag}")
