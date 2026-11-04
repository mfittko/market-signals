"""Markdown tables from out/eval_<inst>.json.  python summarize.py WTICO_USD"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(HERE, "out", f"eval_{sys.argv[1]}.json")))
f = lambda a: f"{a[0]:.3f} [{a[1][0]:.3f}, {a[1][1]:.3f}]"
print(f"# {d['inst']}  rows P3 {d['rows_p3']}, eval rows {d['rows_eval']}, KX {d['kx']}\n")
print("ms/row:", {k: round(v["secs_per_row"] * 1000, 1) for k, v in d["models"].items()}, "\n")
folds = list(d["folds"])
keys = list(d["folds"][folds[0]]["auc"])
print("| scorer | " + " | ".join(folds) + " | dev 2020-22 pooled | 2023+ |")
print("|---" * (len(folds) + 3) + "|")
for k in keys:
    print(f"| {k} | " + " | ".join(f"{d['folds'][y]['auc'][k][0]:.3f}" for y in folds) + " | "
          + " | ".join(f(d["pooled"][p]["auc"][k]) for p in ("dev2020_22", "w2023")) + " |")
print("\n| paired AUC difference | dev 2020-22 | 2023+ |\n|---|---|---|")
for k in d["pooled"]["dev2020_22"]["paired"]:
    a, b = d["pooled"]["dev2020_22"]["paired"][k], d["pooled"]["w2023"]["paired"][k]
    print(f"| {k} | {a[0]:+.3f} [{a[1]:+.3f}, {a[2]:+.3f}] | {b[0]:+.3f} [{b[1]:+.3f}, {b[2]:+.3f}] |")
print("\n| LR model | part | n | base | Brier | Brier base | logloss | logloss base |\n|---|---|---|---|---|---|---|---|")
for p in ("dev2020_22", "w2023"):
    for k, c in d["pooled"][p]["cal"].items():
        s = c["scores"]
        print(f"| {k} | {p} | {s['n']} | {s['base']:.3f} | {s['brier']:.4f} | {s['brier_base']:.4f} | {s['logloss']:.4f} | {s['logloss_base']:.4f} |")
for p in ("dev2020_22", "w2023"):
    for k in [x for x in d["pooled"][p]["cal"] if x.startswith("stack_") or x == "lr_todvol"]:
        print(f"\nreliability {k} {p}: " + "; ".join(f"{r['band']} n={r['n']} p={r.get('mean_p', 0):.2f} obs={r.get('obs', 0):.2f}"
                                                   for r in d["pooled"][p]["cal"][k]["rel"] if r["n"]))
print("\nT3 (direction given big move, AUC of side-signed s_dir):")
for k, v in d["T3"].items():
    print(f"  {k}: n={v['n']} base={v['base']:.3f} auc={f(v['auc'])}")
