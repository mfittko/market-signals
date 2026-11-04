"""Print the filter316 report tables from out/results.json.  python summarize.py"""
import os, json
HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "out", "results.json")))
f = lambda x: "n/a" if x is None else f"{x:+.3f}"
ci = lambda v: f"{v[0]:+.3f} [{v[1][0]:+.3f}, {v[1][1]:+.3f}]"
mc = lambda m: f"{m['meanR']:+.3f} [{m['ci'][0]:+.3f}, {m['ci'][1]:+.3f}] (n={m['n']})" if m.get("n") else "n=0"
print(f"n={R['n']} scored, {R['days']} days, censored {R['censored']}, {R['first'][:10]}..{R['last'][:10]}")
print(f"all {mc(R['all'])}; allowed {mc(R['allowed'])}; suppressed {mc(R['suppressed'])}")


def row(name, o, dec=""):
    if "delta_kept_vs_all" not in o:
        print(f"| {name} | {o.get('blocked', 0)} | - | - | - | - | - | - | {dec} |"); return
    n = o["null"]
    print(f"| {name} | {o['blocked']} ({o['block_share']:.0%}) | {f(o['meanR_blocked'])} | {f(o['meanR_kept'])} | "
          f"{ci(o['blocked_minus_all'])} | {ci(o['delta_kept_vs_all'])} | {n['pct_of_null']:.0%} [{n['q025']:+.3f}, {n['q975']:+.3f}] | "
          f"{o.get('p_holm', o['p_one_sided']):.2f} | {o['mde80']:.3f} | {dec} |")


hdr = ("| rule | blocked | R blocked | R kept | blocked - all [CI] | kept - all [CI] | pct of random null [q2.5, q97.5] | p (Holm) | MDE80 | decision |\n"
       "|---|---|---|---|---|---|---|---|---|---|")
print("\n### LLM verdicts and categories\n" + hdr)
row("LLM suppress (all)", R["overall"], R["decisions"]["overall"])
for k, o in R["categories"].items():
    row(k, o, R["decisions"].get(k, ""))
print("\n### 315 gate comparison\n" + hdr)
for k, o in R["gate315"].items():
    if k != "overlap":
        row(k, o)
print("overlap", R["gate315"]["overlap"])
print("\n### primary (first-mentioned) category, mean R")
for k, m in R["primary"].items():
    print(f"- {k}: {mc(m)}")
for col in ("by_tf", "by_model", "by_stream", "by_month"):
    print(f"\n### {col}\n| group | n | suppress share | allowed R [CI] | suppressed R [CI] |\n|---|---|---|---|---|")
    for k, v in R[col].items():
        print(f"| {k} | {v['n']} | {v['suppress_share']:.0%} | {mc(v['allowed'])} | {mc(v['suppressed'])} |")
print("\n### by_tf tests")
for tf, T in R["by_tf_tests"].items():
    for k, o in T.items():
        row(f"{tf} {k}", o)
print("\n### weeks")
for w in R["by_week_counts"]:
    print(f"{w['week']} n={w['n']} sup={w['suppress_share']:.0%} meanR={w['meanR']:+.3f}")
print("\nlate_chasing vs average:", R["late_chasing_vs_average"], "| role:", R["role"])
