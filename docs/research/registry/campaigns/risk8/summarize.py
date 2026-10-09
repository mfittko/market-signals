"""Markdown tables from out/overlay_<inst>.json and out/refit_<inst>.json.  python summarize.py INST"""
import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__))
TAG = sys.argv[1].replace("/", "_")
f2 = lambda v: f"{v:+.3f}"
c2 = lambda v: f"{v[0]:+.3f} [{v[1][0]:+.3f}, {v[1][1]:+.3f}]"
r2 = lambda v: f"{v[0]:.2f} [{v[1][0]:.2f}, {v[1][1]:.2f}]"
o = json.load(open(os.path.join(HERE, "out", f"overlay_{TAG}.json")))
print(f"# {o['inst']} overlays (data to {o['data_last']})\n")
for s, S in o["sets"].items():
    for part, W in S["windows"].items():
        b = W["variants"]["BASE"]
        print(f"## {s} / {part}: {W['n_entries']} entries, {W['days']} days, base runners {W['base']['runners']}\n")
        print("| variant | R/entry | diff vs base | daily CVaR5 | dCVaR5 | maxDD | dMaxDD | trade CVaR5 | loss>1R | winners kept | runners kept | cover | expo | opt bound | cost .05 | obj |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        for v, r in W["variants"].items():
            ob = r.get("objective")
            obs = "-" if ob is None else ("MEETS" if ob["all"] else ",".join(k for k, x in ob.items() if not x and k != "all"))
            print(f"| {v} | {c2(r['meanR_entry'])} | {c2(r['diff_vs_base'])} | {c2(r['daily_cvar5'])} | {c2(r['daily_cvar5_diff'])} | "
                  f"{r['maxdd'][0]:.1f} [{r['maxdd'][1][0]:.1f}, {r['maxdd'][1][1]:.1f}] | {c2(r['maxdd_diff'])} | {c2(r['cvar5_trade'])} | "
                  f"{r['loss_beyond_1R_share'][0]:.3f} | {r2(r['winners_retained'])} | {r2(r['runners_retained'])} | {r['coverage']:.2f} | "
                  f"{r['exposure_bars_ratio']:.2f} | {f2(r['opt_bound_meanR'])} | {f2(r['cost']['0.05'])} | {obs} |")
        print()
        print("by year R/entry: " + "; ".join(f"{v}: " + " ".join(f"{y[2:]}:{x:+.2f}" for y, x in r["by_year"].items()) for v, r in W["variants"].items()))
        print()
p = os.path.join(HERE, "out", f"refit_{TAG}.json")
if os.path.exists(p):
    r = json.load(open(p))
    print(f"# {r['inst']} item 5: fixed vs scheduled refit\n")
    print("| pop/year | n | base | schedule | AUC [CI] | dAUC vs fixed [CI] | Brier | cal-in-large | slope | ECE |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for k, Y in r["by_year"].items():
        for s, m in Y["models"].items():
            d = m.get("auc_minus_fixed")
            ds = "-" if d is None else f"{d[0]:+.3f} [{d[1]:+.3f}, {d[2]:+.3f}]"
            print(f"| {k} | {Y['n']} | {Y['base']:.3f} | {s} | {m['auc'][0]:.3f} [{m['auc'][1][0]:.3f}, {m['auc'][1][1]:.3f}] | {ds} | "
                  f"{m['brier']:.4f} | {m['cal_in_large']:+.3f} | {m['cal_slope']:.2f} | {m['ece']:.3f} |")
    print("\nartifacts: " + "; ".join(f"{k}: {len(v)} (cutoffs {v[0]['train_cutoff']}..{v[-1]['train_cutoff']})" for k, v in r["artifacts"].items()))
