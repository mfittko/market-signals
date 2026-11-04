"""Print the season17 report tables from out/results.json."""
import os, json
R = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "results.json")))
f = lambda c: f"{c[0]:+.3f} [{c[1]:+.3f}, {c[2]:+.3f}]" if c else "-"
print("SCAN", json.dumps(R["scan"]))
print("PROCEDURE", json.dumps(R["procedure"]))
print("\nSELECTED")
for k, o in R["selected"].items():
    v, w = o.get("val2021_22", {}), o.get("w2023", {})
    print(f"{k:16s} side {o['side']:+d} t_sel {o['t_sel']:+.2f} gross_sel {o['gross_sel']:+.3f} | val n {v.get('trades')} net {f(v.get('net_per_trade'))} gross {o['gross_val']:+.3f}"
          f" | w23 n {w.get('trades')} net {f(w.get('net_per_trade'))} mde {w.get('mde', 0):.3f} p_sel {w.get('p_sel', 1):.3f} p_side {w.get('side', {}).get('p', 1):.3f}"
          f" p_cmp {w.get('p_cmp', 1):.3f} | {o['disposition']}")
for k in ("XAU_USD:D4", "SPX500_USD:L16"):
    o = R["selected"][k]
    print(k, "per_year", {y: round(v["net_per_trade"][0], 3) for y, v in o["per_year"].items()},
          "crises", {c: f(o[c]["net_per_trade"]) for c in ("2020H1", "2022H1", "2025Q4_26Q1") if c in o},
          "w23 costs", {x: round(o["w2023"][x], 3) for x in ("gross_per_trade", "spread_cost", "fin_cost", "net_spread15")}, "holm", {x: round(o["w2023"][x], 3) for x in o["w2023"] if x.startswith("holm")})
P = R.get("pooled_survivors", {})
print("\nPOOLED SURVIVORS", {w: (P[w]["trades"], f(P[w]["net_per_trade"]), round(P[w]["mde"], 3)) for w in P if w != "per_year" and P[w]},
      {y: round(v["net_per_trade"][0], 3) for y, v in P.get("per_year", {}).items()})
print("\nNAMED")
for k, o in R["named"].items():
    d, w = o["dev"], o["w2023"]
    print(f"{k:24s} dev n {d['trades']} net {f(d['net_per_trade'])} gross {d['gross_per_trade']:+.3f} cost {d['spread_cost']:.3f} fin {d['fin_cost']:.3f} "
          f"cmpD {f(d.get('delta_vs_long'))} mde {d['mde']:.3f} | w23 n {w['trades']} net {f(w['net_per_trade'])} gross {w['gross_per_trade']:+.3f} "
          f"fin {w['fin_cost']:.3f} cmpD {f(w.get('delta_vs_long'))} mde {w['mde']:.3f} holm_le0 {w['holm_p_le0']:.3f} | {o['disposition']}")
    print("   crises", {c: f(o[c]["net_per_trade"]) for c in ("2020H1", "2022H1", "2025Q4_26Q1") if c in o},
          "fin0/6 dev", round(d["net_fin0"], 3), round(d["net_fin6"], 3), "fin0/6 w23", round(w["net_fin0"], 3), round(w["net_fin6"], 3))
