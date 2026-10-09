"""Print the notrade12 report tables from out/results.json.  python summarize.py"""
import os, json
HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "out", "results.json")))
f = lambda x: f"{x:+.3f}"
ci = lambda v: f"{v[0]:+.3f} [{v[1][0]:+.3f}, {v[1][1]:+.3f}]"
for fam, W in R["families"].items():
    for win, o in W.items():
        print(f"\n## {fam} / {win}: n={o['n']} signals, mean R all {f(o['meanR_all'])}, daily CVaR5 {o['daily_cvar5_all']:.2f}, maxDD {o['maxdd_all']:.0f} R")
        print("| reason | blocked | R blocked | R kept | delta kept-all [CI] | p_holm | null q97.5 | losses avoided / winners missed (R) | saved R/day [CI] | dCVaR5 kept-all [CI] (null mean) | MDD reduction (null mean) |")
        print("|---|---|---|---|---|---|---|---|---|---|---|")
        for r, v in o["reasons"].items():
            nl = v["null_random_thinning"]
            print(f"| {r} | {v['block_share']:.1%} | {f(v['meanR_blocked'] or 0)} | {f(v['meanR_kept'] or 0)} | {ci(v['delta_kept_vs_all'])} | "
                  f"{v['p_holm']:.3g} | {f(nl['delta_q975'])} | {v['losses_avoided_R']:.0f} / {v['winners_missed_R']:.0f} | "
                  f"{ci(v['net_saved_R_per_day'])} | {ci(v['daily_cvar5_kept_minus_all'])} ({nl['cvar_diff_null_mean']:+.2f}) | "
                  f"{v['maxdd_reduction'][0]:.0f} ({nl['mdd_diff_null_mean']:.0f}) |")
        print(f"kept mean R with CI (absolute): " + ", ".join(f"{r} {ci(v['meanR_kept_ci'])}" for r, v in o["reasons"].items()))
        inc = o["incremental_over_R1"]
        print(f"incremental over R1 (base n={inc['_base_R1_kept']['n']}, mean {f(inc['_base_R1_kept']['meanR'])}): " +
              "; ".join(f"{r} share {v['block_share']:.1%} delta {ci(v['delta'])} beats_null={v['beats_null']}" for r, v in inc.items() if r[0] != "_"))
        pos = [(k, v["n"], v["ANY"]["kept"]) for k, v in o["by_stream"].items() if (v["ANY"]["kept"] or -9) >= 0]
        print("streams with ANY-kept mean R >= 0:", pos or "none")
        print("by stream (n, all, ANY share, ANY kept, R1-only kept):")
        for k, v in o["by_stream"].items():
            print(f"  {k}: n={v['n']} all {f(v['meanR_all'])} ANY {v['ANY']['share']:.0%} kept {f(v['ANY']['kept'] or 0)} R1kept {f(v['R1_spread']['kept'] or 0)}")
print("\n## verdicts")
for fam, V in R["verdicts"].items():
    for r, v in V.items():
        print(fam, r, v)
