"""Print the limit13 report tables from out/results.json.  python summarize.py"""
import os, json
HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "out", "results.json")))
c = lambda v: f"{v[0]:+.3f} [{v[1]:+.3f}, {v[2]:+.3f}]"
for win, W in R["windows"].items():
    print(f"\n## {win}: n={W['n']} signals, market mean {W['mkt_mean']:+.3f} R (optimistic {W['mkt_opt_mean']:+.3f}), mean spread {W['spread_R_mean']:.3f} R")
    print("| variant | fill | net R/signal | net R/filled | p_holm(pf>0) | mkt R filled | mkt R unfilled | adverse sel. (mkt_f - mkt_all) | exec diff on filled (lim - mkt) | d vs thinned mkt | p_holm | d vs random-timing null | null fill | touch+opt R/signal | touch+opt R/filled | wait bars |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for nm, v in W["primary"].items():
        print(f"| {nm} | {v['fill'][0]:.1%} | {c(v['ps'])} | {c(v['pf'])} | {v['p_pf_holm']:.3g} | {v['mkt_f'][0]:+.3f} | {v['mkt_u'][0]:+.3f} | "
              f"{c(v['adv'])} | {c(v['exec_f'])} | {c(v['d_thin'])} | {v['p_d_thin_holm']:.3g} | {c(v['d_null'])} | {v['null_fill'][0]:.1%} | "
              f"{c(v['ps_tb'])} | {c(v['pf_tb'])} | {W['wait_bars_median'][nm]:.0f} |")
    print("thinning null (filled subset market mean vs random subsets of same size, 95% band, percentile):")
    for nm, v in W["thinning_null"].items():
        print(f"  {nm}: {v['filled_mkt_mean']:+.3f} vs [{v['random_q025']:+.3f}, {v['random_q975']:+.3f}] pct {v['pct']:.3f}")
    print("signal families (TF/kind), net R per filled [CI] / per signal [CI] / market [CI], best variant by pf:")
    for fk, F in W["families"].items():
        mk = next(iter(F.values()))["mkt_all"]
        best = max(F, key=lambda k: F[k]["pf"][0])
        print(f"  {fk}: n={next(iter(F.values()))['n']} market {c(mk)}")
        for nm, v in F.items():
            print(f"     {nm}: fill {v['fill'][0]:.1%} pf {c(v['pf'])} ps {c(v['ps'])} adv {c(v['adv'])} d_thin {c(v['d_thin'])} d_null {c(v['d_null'])}{'  <- best pf' if nm == best else ''}")
    print("streams with any variant per-filled mean >= 0 (points, exploratory, n_filled unknown here):")
    for sk, s in W["streams"].items():
        pos = [f"{nm} {v['pf']:+.3f} (fill {v['fill']:.0%})" for nm, v in s.items() if isinstance(v, dict) and (v["pf"] or -9) >= 0]
        print(f"  {sk}: n={s['n']} mkt {s['mkt']:+.3f}; " + (", ".join(pos) or "none"))
print("\n## verdicts")
for nm, v in R["verdicts"].items():
    print(nm, v)
