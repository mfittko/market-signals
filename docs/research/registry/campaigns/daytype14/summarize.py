"""Tables from out/results.json -> out/summary.txt"""
import os, json
HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "out", "results.json")))
L = []
f = lambda v: "-" if v is None else f"{v:+.3f}"
ci = lambda c: f"{c[0]:+.3f} [{c[1]:+.3f}, {c[2]:+.3f}]" if len(c) == 3 else f"{c[0]:.3f}"
L.append("## Classifier (LR / HGB / best baseline AUC; dev 2019-22 | 2023+; base rate; precision of predicted type)")
for inst, C in R["classifier"].items():
    for cp, T in C.items():
        for tgt, Wd in T.items():
            s = []
            for w in ("dev", "w2023"):
                if w not in Wd:
                    continue
                o = Wd[w]; a = o["auc"]
                bb = max((k for k in a if k.startswith(("base", "naive"))), key=lambda k: a[k][0])
                s.append(f"{w}: LR {ci(a['lr'])} HGB {a['hgb'][0]:.3f} {bb} {a[bb][0]:.3f} base {o['base']:.2f} prec {f(o['precision'])} rec {f(o['recall'])} citl {o['cal']['lr']['citl']:+.3f}")
            cy = " ".join(f"{k}:{v:+.3f}" for k, v in Wd.get("citl_dev_years", {}).items())
            L.append(f"{inst} cp{cp} {tgt} | " + " | ".join(s) + f" | citl yrs {cy}")
L.append("\n## Policies (net R/trade [CI]; per day; delta vs all-days; random assignment; oracle; gross; optimistic)")
for v, P in R["policies"].items():
    L.append(f"### {v}: {P['disposition']}  MDE dev {P['mde_dev']:.3f} / 2023+ {P['mde_w2023']:.3f}")
    for w, o in P.items():
        if not isinstance(o, dict):
            continue
        rnd = o["random"]
        L.append(f"  {w}: rows {o['rows']} predT {o['pred_trend']:.2f} predR {o['pred_range']:.2f} trades {o['trades']} | net/trade {ci(o['net_per_trade'])} | "
                 f"per day {ci(o['net_per_day'])} | alldays {ci(o['alldays_per_trade'])} (n {o['alldays_trades']}) | delta {ci(o['delta_vs_alldays'])} | "
                 f"random {rnd['per_trade_mean']:+.3f} [{rnd['per_trade_q'][0]:+.3f}, {rnd['per_trade_q'][1]:+.3f}] pct {rnd['pct_of_actual']:.2f} | "
                 f"oracle {ci(o['oracle_per_trade'])} (n {o['oracle_trades']}) | gross {f(o['gross_per_trade'])} alldays gross {f(o['alldays_gross'])} | opt {f(o['opt_per_trade'])}"
                 + (f" | holm p>0 {o['holm_p_trade_le0']:.3f} holm p rand {o['holm_p_rand']:.3f}" if "holm_p_rand" in o else ""))
        if o["by_actual_type_alldays"]:
            L.append("     all-days by actual type: " + "; ".join(f"{k} n {t['n']} net {f(t['net'])} gross {f(t['gross'])}" for k, t in o["by_actual_type_alldays"].items()))
open(os.path.join(HERE, "out", "summary.txt"), "w").write("\n".join(L) + "\n")
print("\n".join(L))
