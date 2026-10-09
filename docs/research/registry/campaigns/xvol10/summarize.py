"""Render out/results.json of xvol10 as text tables -> out/report.txt (and stdout)."""
import os, json
HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "out", "results.json")))
PATH = ("t0", "+1", "+2", "+3", "+5", "+10", "+30")
EXEC = ("+3", "+5", "+10", "+30")
L = []
p = L.append


def tab(title, s, cols):
    if not s or "mean" not in s:
        p(f"  {title}: n={s.get('n') if s else 0} (too few)"); return
    p(f"  {title} (n={s['n']}, days={s['days']})")
    p("    " + " ".join(f"{c:>22}" for c in cols))
    p("    " + " ".join(f"{m:+.3f} [{a:+.3f},{b:+.3f}]".rjust(22) for m, a, b in zip(s["mean"], s["ci_lo"], s["ci_hi"])))
    p("    " + " ".join(f"se {e:.3f}".rjust(22) for e in s["se"]))


def block(name, st):
    for wn, r in st.items():
        p(f"{name} {wn}: events {r['events']}, confirmed+entry {r['confirmed']}")
        tab("mid path, all events (ATR14)", r["path_all"], PATH)
        tab("mid path, confirmed (ATR14)", r["path_conf"], PATH)
        tab("EXECUTABLE confirmed, entry t0+2 open (R, spread-incl.)", r["exec_conf"], EXEC)
        tab("executable, all events with entry bar (R)", r["exec_all"], EXEC)
        for k in ("conf", "all"):
            sp, sh = r.get("spread_R_" + k), r.get("share_ahead_" + k)
            if sp:
                p(f"  [{k}] entry spread R mean {sp['mean']:.3f} median {sp['median']:.3f}; share of move ahead at entry "
                  f"aggregate {sh['aggregate']:.3f} median {sh['median']:.3f}")
        p("")


for K, r in R["K"].items():
    p(f"=== M1 detection K={K}: {r['events']} events, lead events {r['lead_events']}, mean participants "
      f"{r['participants_mean']:.2f}")
    p(f"by year {r['by_year']}")
    p(f"lead by inst {r['lead_by_inst']}")
    block(f"M1 K={K}", r["study"])
    if "laggards" in r:
        p(f"laggards by inst {r['laggards_by_inst']}")
        for wn, x in r["laggards"].items():
            tab(f"laggard mid path {wn} (ATR14)", x["path"], PATH)
        p("")
m = R["M5"]
p(f"=== M5 detection (xvol9 reproduced) K={m['K']}: {m['events']} events; by year {m['by_year']}")
block("M5 K=3", m["study"])
for wn, x in m["laggards"].items():
    tab(f"M5 laggard mid path {wn} (ATR14)", x, PATH)
g = R["go_no_go"]
p(f"\nGO/NO-GO: {g['result']}  {json.dumps(g['per_window'])}\nrule: {g['rule']}")
txt = "\n".join(L)
open(os.path.join(HERE, "out", "report.txt"), "w").write(txt + "\n")
print(txt)
