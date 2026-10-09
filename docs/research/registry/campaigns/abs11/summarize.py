"""Print the abs11 report tables from out/<TAG>.json."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "NATGAS/USD", "SPX500/USD", "EUR/USD"]
R = {i: json.load(open(os.path.join(HERE, "out", i.replace("/", "_") + ".json"))) for i in INSTS}
f = lambda v, n=2: "-" if v is None else f"{v:.{n}f}"
ci = lambda a: f"{a[0]:.3f} [{a[1]:.3f},{a[2]:.3f}]"

print("## thresholds")
for i, r in R.items():
    print(f"{i:11s} T1 {r['T1_pct']:.2f}%  T2 {r['T2_pct']:.2f}%")

for tgt in ("A1_open", "A1", "A2"):
    print(f"\n## AUC {tgt}: lr / hgb / baselines (dev 2019-22, 2023+)")
    for i, r in R.items():
        for w in ("dev", "w2023"):
            a = r[tgt]["auc"][w]
            print(f"{i:11s} {w:5s} " + "  ".join(f"{k} {ci(v)}" for k, v in a.items()))
    if tgt != "A1_open":
        print(f"\n## CITL by year {tgt} (lr)")
        for i, r in R.items():
            print(f"{i:11s} " + " ".join(f"{y}:{r[tgt]['cal'][str(y)]['lr']['citl']:+.3f}" for y in range(2019, 2027) if str(y) in r[tgt]["cal"]))

print("\n## A1 operating points (model vs naive at matched rate)")
for i, r in R.items():
    for w in ("dev", "w2023"):
        for k, o in r["ops_A1"][w].items():
            print(f"{i:11s} {w:5s} {k:16s} /mo {f(o['per_month'])} base {f(o['base_rate'])} prec {f(o['precision'])} rec {f(o['recall'])} "
                  f"lead_h {f(o['lead_h_median'],1)} ahead_hit {f(o['ahead_median_hits'])} ahead_all {f(o['ahead_median_all'])} "
                  f"hourUTC {f(o['alert_hour_utc_median'],0)} calmFA/wk {f(o['calm_false_per_week'])}")

print("\n## A2 operating points")
for i, r in R.items():
    for w in ("dev", "w2023"):
        for k, o in r["ops_A2"][w].items():
            print(f"{i:11s} {w:5s} {k:10s} /wk {f(o['per_week'])} base {f(o['base_rate'])} prec {f(o['precision'])} recEp {f(o['recall_ep'])} "
                  f"lead_min {f(o['lead_min_median'],0)} ahead_hit {f(o['ahead_median_hits'])} fwd% alert {f(o['fwd_pct_median_alerts'])} all {f(o['fwd_pct_median_all'])} "
                  f"calmFA/wk {f(o['calm_false_per_week'])}")

print("\n## crisis windows (A1 model 2/mo | naive 2/mo | A2 model 2/wk)")
for c in ("2020H1", "2022H1", "2025Q4_26Q1"):
    for i, r in R.items():
        a, n, b = r["ops_A1"][c]["model_2pm"], r["ops_A1"][c]["naive_2pm"], r["ops_A2"][c]["model_2pw"]
        print(f"{c:12s} {i:11s} A1 big {a['big_days']:3d} alerts {a['alerts']:3d} lag_d {f(a['first_alert_lag_days'],1)} rec {f(a['recall'])} prec {f(a['precision'])} /wk {f(a['per_month']*7/30.44)} "
              f"| naive rec {f(n['recall'])} prec {f(n['precision'])} lead_h {f(n['lead_h_median'],1)} vs {f(a['lead_h_median'],1)} "
              f"| A2 alerts {b['alerts']} /wk {f(b['per_week'])} lag_d {f(b['first_alert_lag_days'],1)} prec {f(b['precision'])} recEp {f(b['recall_ep'])}")

print("\n## session clock")
for i, r in R.items():
    c = r["clock"]
    top = lambda h: sorted(h.items(), key=lambda kv: -kv[1])[:4]
    tot = lambda h: sum(h.values())
    print(f"{i:11s} A1 alerts top hours {top(c['A1_alert_hours_2pm'])} of {tot(c['A1_alert_hours_2pm'])}; crossing top {top(c['A1_crossing_hours'])}; "
          f"remaining exc% alerts {c['A1_remaining_exc_median_alerts']:.2f} vs all {c['A1_remaining_exc_median_all']:.2f}")
    print(f"{'':11s} A2 alerts top hours {top(c['A2_alert_hours_2pw'])} of {tot(c['A2_alert_hours_2pw'])}; positives top {top(c['A2_positive_hours'])}; "
          f"fwd% alerts {c['A2_fwd_median_alerts']:.2f} vs all {c['A2_fwd_median_all']:.2f}; best hour median {max(c['A2_fwd_median_by_hour'].values()):.2f}")

print("\n## decision")
for i, r in R.items():
    for t, d in r["decision"].items():
        why = [k for k in ("auc_dev", "auc_w2023", "op_dev", "op_w2023") if not d[k]["ok"]] + ([] if d["citl_ok"] else ["citl"])
        print(f"{i:11s} {t} {'PASS' if d['PASS'] else 'FAIL'} fails: {why}  op_dev rec {f(d['op_dev']['recall'])} prec {f(d['op_dev']['precision'])} 2xbase {f(2*d['op_dev']['base'])}"
              f"  op_2023 rec {f(d['op_w2023']['recall'])} prec {f(d['op_w2023']['precision'])} 2xbase {f(2*d['op_w2023']['base'])}"
              f"  best base dev {d['auc_dev']['best_baseline']} {d['auc_dev']['best_baseline_auc']:.3f} 2023 {d['auc_w2023']['best_baseline']} {d['auc_w2023']['best_baseline_auc']:.3f}")
