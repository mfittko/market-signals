"""alert7 summary: markdown tables from out/<TAG>.json -> stdout."""
import os, sys, json
SUF = sys.argv[1] if len(sys.argv) > 1 else ""   # "_ns" = amendment A1 population
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
INSTS = ["XAG/USD", "NATGAS/USD", "SPX500/USD", "EUR/USD", "WTICO/USD", "XAU/USD"]
f2 = lambda v: "-" if v is None else f"{v:.2f}"
f3 = lambda v: "-" if v is None else f"{v:.3f}"
ci = lambda a: f"{a[0]:.3f} [{a[1][0]:.2f}, {a[1][1]:.2f}]"
R = {i: json.load(open(os.path.join(OUT, i.replace("/", "_") + SUF + ".json"))) for i in INSTS if os.path.exists(os.path.join(OUT, i.replace("/", "_") + SUF + ".json"))}

print("## Coverage and label\n\n| Inst | data | KX | 2018 rates 3/4.5/6 | rows | base 2020..2026 |\n|---|---|---|---|---|---|")
for i, r in R.items():
    rt = "/".join(f"{v:.2f}" for v in r["kx_rates_2018"].values())
    print(f"| {i} | {r['data_first']}..{r['data_last']} | {r['kx']} | {rt} | {r['rows']} | " + " ".join(f"{r['base_by_year'][str(y)]:.2f}" for y in range(2020, 2027)) + " |")

print("\n## AUC, all-hours (quarterly todvol), by year\n\n| Inst | " + " | ".join(str(y) for y in range(2020, 2027)) + " | dev20-22 | 2023+ |\n|---|" + "---|" * 9)
for i, r in R.items():
    print(f"| {i} | " + " | ".join(ci(r["auc"][f"all/{w}"]["q_todvol"]) for w in [*map(str, range(2020, 2027)), "dev2020_22", "w2023"]) + " |")

print("\n## Pooled AUC: todvol vs tod-only vs vol-only, fixed2020; paired differences (all-hours; P3 in brackets for todvol)\n")
print("| Inst | window | q_todvol | P3 q_todvol | q_tod | q_vol | fixed2020 | todvol-tod | todvol-vol |\n|---|---|---|---|---|---|---|---|---|")
for i, r in R.items():
    for w in ("dev2020_22", "w2023"):
        a = r["auc"][f"all/{w}"]; pd_ = r["paired"][f"all/{w}"]
        pr = lambda d: f"{d[0]:+.3f} [{d[1]:+.3f}, {d[2]:+.3f}]"
        print(f"| {i} | {w} | {ci(a['q_todvol'])} | {ci(r['auc'][f'p3/{w}']['q_todvol'])} | {a['q_tod'][0]:.3f} | {a['q_vol'][0]:.3f} | {a['fixed2020'][0]:.3f} | "
              f"{pr(pd_['q_todvol - q_tod'])} | {pr(pd_['q_todvol - q_vol'])} |")

print("\n## Calibration by year (all-hours): CITL quarterly / fixed2020 (/fixed2023); Brier quarterly vs training-base Brier\n")
print("| Inst | " + " | ".join(str(y) for y in range(2020, 2027)) + " |\n|---|" + "---|" * 7)
for i, r in R.items():
    cells = []
    for y in range(2020, 2027):
        c = r["cal"][str(y)]
        s = f"{c['q_todvol']['citl']:+.3f}/{c['fixed2020']['citl']:+.3f}"
        if "fixed2023" in c:
            s += f"/{c['fixed2023']['citl']:+.3f}"
        s += f"; B {c['q_todvol']['brier']:.3f} vs {c['q_todvol']['brier_base_train']:.3f}"
        cells.append(s)
    print(f"| {i} | " + " | ".join(cells) + " |")

print("\n## Reliability, quarterly model (pooled windows): band mean_p -> observed (n)\n")
for i, r in R.items():
    for w in ("dev2020_22", "w2023"):
        rel = r["rel"][w]["q_todvol"]
        print(f"- {i} {w}: " + "; ".join(f"{b['band']} {b['mean_p']:.2f}->{b['obs']:.2f} ({b['n']})" for b in rel if b["n"]))

print("\n## Operating curves (quarterly model, trailing-rank thresholds)\n")
print("| Inst | target/wk | window | alerts/wk | precision [Wilson] | base | recall ep | recall major | lead min | ahead (hits) | ahead (all) |\n|---|---|---|---|---|---|---|---|---|---|---|")
for i, r in R.items():
    for rt in (1, 2, 4):
        for w in ("dev2020_22", "w2023"):
            o = r["ops"][f"{rt}/{w}"]
            print(f"| {i} | {rt} | {w} | {o['per_week']:.2f} | {f2(o['precision'])} [{o['precision_ci'][0]:.2f}, {o['precision_ci'][1]:.2f}] | {o['base']:.2f} | "
                  f"{f2(o['recall_ep'])} | {f2(o['recall_major'])} | {f2(o['lead_min_median'])} | {f2(o['ahead_share_median_hits'])} | {f2(o['ahead_share_median_all'])} |")

print("\n## Precision by year at 2/week (base in brackets)\n\n| Inst | " + " | ".join(str(y) for y in range(2020, 2027)) + " |\n|---|" + "---|" * 7)
for i, r in R.items():
    print(f"| {i} | " + " | ".join(f"{f2(r['ops'][f'2/{y}']['precision'])} ({r['ops'][f'2/{y}']['base']:.2f})" for y in range(2020, 2027)) + " |")

print("\n## Crisis windows at 2/week (1 and 4/week in json)\n")
print("| Inst | window | alerts/wk | precision | base | recall ep | recall major (n) | first alert lag d | first major start | lag to alert h | calm wks | false/calm wk | calm wks w/ false |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for i, r in R.items():
    for w in ("2020H1", "2022H1", "2025Q4_26Q1", "dev2020_22", "w2023"):
        o = r["crisis"][w]["2"]
        print(f"| {i} | {w} | {o['per_week']:.2f} | {f2(o['precision'])} | {o['base']:.2f} | {f2(o['recall_ep'])} | {f2(o['recall_major'])} ({o['n_major']}) | "
              f"{f2(o['first_alert_lag_days'])} | {o.get('first_major_start', '-')} | {f2(o.get('first_major_lag_h'))} | {o['calm_weeks']} | {f2(o['calm_false_per_week'])} | {f2(o['calm_weeks_with_false_share'])} |")

print("\n## Drift monitor: band from 2019-22 OOS, share of sessions outside, by year\n")
for i, r in R.items():
    d = r["drift"]
    for k, b in d["band_from_2019_22"].items():
        t = d["trigger_share_by_year"][k]
        print(f"- {i} {k}: band [{b[0]:+.3f}, {b[1]:+.3f}]; " + " ".join(f"{y}:{t[str(y)]:.2f}" for y in range(2019, 2027) if str(y) in t)
              + f"; first 2023+ {t['first_trigger_2023plus']}; latest {t['latest']:+.3f}")
