"""pprofit20: results_*.json + diag.json -> out/report.txt"""
import os, json
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
SUF = os.environ.get("PP_SUF", "")
INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "NATGAS/USD", "SPX500/USD", "EUR/USD"]
f3 = lambda x: f"{x:+.3f}" if x is not None else "n/a"
p2 = lambda x: f"{100 * x:.1f}%"


def main():
    D = json.load(open(os.path.join(OUT, f"diag{SUF}.json")))
    L = ["# pprofit20 report (development evidence; nothing qualified; no edge claimed)", ""]
    L += ["## Pass/fail (rule: |mean P - observed| <= 0.03 in every per-side decile with n >= 1000, both windows)", "",
          "| inst | pass | window | side | n | base rate | mean R | AUC LR | AUC spread-only | AUC HGB | max gap | P10/P50/P90 | CITL by year | +R deciles |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for inst in INSTS:
        r = json.load(open(os.path.join(OUT, f"results_{inst.replace('/', '_')}{SUF}.json")))
        for w, W in r["windows"].items():
            for s in ("long", "short"):
                e = W["lr"][s]
                cit = " ".join(f"{y % 100}:{v['citl']:+.3f}" for y, v in ((int(k), v) for k, v in e["by_year"].items()))
                L.append(f"| {inst} | {'PASS' if r['calib_pass'] else 'FAIL'} | {w} | {s} | {e['n']} | {p2(e['base'])} | {f3(e['meanR'])} | "
                         f"{e['auc']:.3f} | {D[inst][w][s]['auc_spread_only']:.3f} | {W['hgb'][s]['auc']:.3f} | {e['max_abs_gap']:.3f} | "
                         f"{'/'.join(p2(x) for x in e['p_q'])} | {cit} | {e['pos_deciles'] or '-'} |")
    L += ["", "Post-hoc isotonic (not registered, does not change status): " +
          "; ".join(f"{i} {w} {s} max gap {D[i][w][s]['isotonic_max_abs_gap']:.3f}" for i in INSTS if "isotonic_max_abs_gap" in D[i]["w2023"]["long"]
                    for w in ("dev2019_22", "w2023") for s in ("long", "short")), ""]
    for inst in INSTS:
        r = json.load(open(os.path.join(OUT, f"results_{inst.replace('/', '_')}{SUF}.json")))
        L += [f"## {inst}", ""]
        for w, W in r["windows"].items():
            for s in ("long", "short"):
                L += [f"### reliability + expected R, {w}, {s}", "", "| dec | n | mean P | observed [95% CI] | gap | mean net R [95% CI] | avg win | avg loss |", "|---|---|---|---|---|---|---|---|"]
                for d in W["lr"][s]["deciles"]:
                    L.append(f"| {d['decile']} | {d['n']} | {p2(d['p_mean'])} | {p2(d['obs'])} [{p2(d['obs_ci'][0])}, {p2(d['obs_ci'][1])}] | "
                             f"{d['gap']:+.3f} | {f3(d['meanR'])} [{f3(d['meanR_ci'][0])}, {f3(d['meanR_ci'][1])}] | {f3(d['avg_win'])} | {f3(d['avg_loss'])} |")
                L.append("")
            for name in ("hour_utc", "spread_R"):
                L += [f"### {name}, {w} (P10/P50/P90 of P; mean P vs observed; mean R)", "", "| bucket | side | n | P10/P50/P90 | mean P | observed | mean R |", "|---|---|---|---|---|---|---|"]
                for g, v in W["breakdown"][name].items():
                    for s, x in v.items():
                        L.append(f"| {g} | {s} | {x['n']} | {p2(x['p10'])}/{p2(x['p50'])}/{p2(x['p90'])} | {p2(x['p_mean'])} | {p2(x['obs'])} | {f3(x['meanR'])} |")
                L.append("")
            m = W["lms"]
            L += [f"### long minus short, {w}: n {m['n']}, P5/25/50/75/95 {' '.join(f'{x:+.3f}' for x in m['q'])}, |d|>0.05 {p2(m['frac_abs_gt_0_05'])}, "
                  f"|d|>0.10 {p2(m['frac_abs_gt_0_10'])}, slope observed-on-predicted {m['slope_obs_on_pred'][0]:+.2f} [{m['slope_obs_on_pred'][1]:+.2f}, {m['slope_obs_on_pred'][2]:+.2f}]", "",
                  "| dec | n | mean predicted d | observed y_L - y_S | net R L - S |", "|---|---|---|---|---|"]
            L += [f"| {d['decile']} | {d['n']} | {d['d_mean']:+.3f} | {d['obs']:+.3f} | {d['net_diff']:+.3f} |" for d in m["deciles"]]
            L.append("")
    for k, v in D.items():
        if k.endswith("recompute_max_abs_diff"):
            L.append(f"{k}: {v:.2e}")
    open(os.path.join(OUT, f"report{SUF}.txt"), "w").write("\n".join(L) + "\n")
    print("\n".join(L[:40]))


if __name__ == "__main__":
    main()
