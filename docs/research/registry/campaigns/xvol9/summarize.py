"""Print the xvol9 report tables from out/results.json."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "out", "results.json")))
f = lambda x: "-" if x is None else f"{x:+.3f}"
ci = lambda c: "-" if not c else f"[{c[0]:+.3f}, {c[1]:+.3f}]"
print("## coverage")
for i, c in R["coverage"].items():
    print(f"| {i} | {c['m1_first'][:16]} | {c['m1_last'][:16]} | {c['m1_rows']} | {c['valid_bars']} | {c['above_share']:.3f} |")
print("single events", R["single_events"], "present mean", round(R["present_mean"], 2))
for K, RK in R["K"].items():
    print(f"\n## K={K}: events {RK['events']}, event days {RK['event_days']}, mean participants {RK['participants_mean']:.2f}")
    print("by year", RK["by_year"]); print("H1 lead by inst", RK["lead_by_inst"])
    for h, H in RK["hyp"].items():
        for w, W in H.items():
            print(f"{h} {w} candidates {W['candidates']} by inst {W['by_inst']}")
    if K == "3":
        print("\n### event study (K=3)")
        for h in ("H1", "H2"):
            for w, W in RK["hyp"][h].items():
                for lab in ("event_study_all", "study_confirmed"):
                    E = W[lab]
                    cols = ["burst_bar", "+1m", "+5m", "+15m", "+30m", "+60m"]
                    print(f"| {h} {w} {lab} | {E['n']} | " + " | ".join(f"{E[c]['mean']:+.2f} ({E[c]['se']:.2f})" for c in cols) + " |")
    print(f"\n### policies K={K}")
    for h, H in RK["hyp"].items():
        for w, W in H.items():
            for m in ("M72", "M12"):
                o = W[m]; s = o["main"]
                nl = " | ".join(f"{f(v['meanR'])} n{v['n']} d{f((v['diff_bonf'] or [None])[0])} {ci((v['diff_bonf'] or [None])[1:])}"
                                for v in o["nulls"].values())
                print(f"| {h}/{m} | {w} | {s['n_trades']} | {s.get('trade_days')} | {f(s.get('meanR'))} {ci(s.get('ci95'))} | "
                      f"{ci(s.get('ci_bonf'))} | {s.get('totalR', 0):+.1f} | {s.get('maxdd', 0):.1f} | {f(s.get('meanR_cost'))} | "
                      f"{s.get('loss_gt_1p5R', 0):.3f} | {s.get('mde80_bonf', 0):.3f} | {nl} | "
                      f"{W[m].get('disposition') or W[m].get('disposition_devwindow') or ''} |")
