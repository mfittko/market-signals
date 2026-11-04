"""Print the mw6 report tables from out/results.json."""
import os, json
HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "out", "results.json")))
f = lambda v: "-" if v is None else f"{v:+.2f}"
ci = lambda c: f"[{c[0]:+.2f},{c[1]:+.2f}]"

print("== policy table (fin 3 %): Sharpe [CI] | annR | maxDD | trades/eff | worst R | >1R | fin share | side null p, diff [CI] | time null p | thin p")
for inst, I in R["inst"].items():
    for name, P in I["policies"].items():
        for w in ("dev2019_22", "w2023"):
            q = P["0.03"][w]
            sn, tn, th = q.get("vs_null_side"), q.get("vs_null_time"), q.get("vs_null_thin")
            print(f"{inst[:6]:6} {name:20} {w[:5]} S {q['sharpe'][0]:+.2f} {ci(q['sharpe'][1])} annR {q['ann_return_R'][0]:+.2f} "
                  f"dd {q['maxdd_R']:.1f} n {q['trades']}/{P['eff_episodes'][w]} worst {f(q['worst_trade_R_fullsize'])} "
                  f">1R {f(q['loss_beyond_1R_share'])} finsh {f(q['financing_share_of_costs'])} | "
                  f"side p {sn['p_null_ge']:.2f} d {sn['ann_diff_R'][0]:+.2f} {ci(sn['ann_diff_R'][1])} | time p {tn['p_null_ge']:.2f}"
                  + (f" | thin p {th['p_null_ge']:.2f} d {th['ann_diff_R'][0]:+.2f} {ci(th['ann_diff_R'][1])}" if th else ""))
print("\n== financing sensitivity: Sharpe dev / w2023 at 0, 3, 6 %")
for inst, I in R["inst"].items():
    for name, P in I["policies"].items():
        print(f"{inst[:6]:6} {name:20}", "  ".join(f"{r}: {P[r]['dev2019_22']['sharpe'][0]:+.2f}/{P[r]['w2023']['sharpe'][0]:+.2f}" for r in ("0.0", "0.03", "0.06")))
print("\n== pooled (fin 3 %)")
for name, P in R["pooled"].items():
    for sc in ("wti_xau", "all6"):
        o = P["0.03"][sc]
        print(f"{name:20} {sc:7}", " | ".join(f"{w[:6]} S {o[w]['sharpe'][0]:+.2f} {ci(o[w]['sharpe'][1])} annR {o[w]['ann_R']:+.2f} dd {o[w]['maxdd_R']:.1f}" for w in ("dev2019_22", "w2023")),
              "| crises", " ".join(f"{w}:{o[w]['ann_R'] * o[w]['days'] / 252:+.1f}R" for w in ("2020H1", "2022H1", "2025Q4_26Q1")))
print("\n== crisis stress (fin 3 %): total R, worst trade, maxDD per policy")
for inst, I in R["inst"].items():
    for name, P in I["policies"].items():
        print(f"{inst[:6]:6} {name:20}", " | ".join(f"{w}: {P['0.03'][w]['total_R']:+.1f} worst {f(P['0.03'][w]['worst_trade_R_fullsize'])} dd {P['0.03'][w]['maxdd_R']:.1f}" for w in ("2020H1", "2022H1", "2025Q4_26Q1")))
print("\n== big-week state")
for inst, I in R["inst"].items():
    for w, s in I["state"].items():
        print(f"{inst[:6]:6} {w:12} on {s['on_share']:.2f} epis {s['episodes']} first {s['first_on']} lag {s['first_on_lag_days']} "
              f"recall {f(s['recall_fwd_bigweek'])} calmFA {f(s['calm_false_alert_share'])} fwdex5 on/off {f(s['fwd_ex5_on'])}/{f(s['fwd_ex5_off'])}")
print("\n== stress index", json.dumps(R["stress"]))
print("\n== labels: sign hit [CI] (eff) | first passage hit")
for inst, I in R["inst"].items():
    for k, o in I["labels"].items():
        fp = o.get("first_passage_hit")
        print(f"{inst[:6]:6} {k:32} {o['sign_hit'][0]:.3f} {ci(o['sign_hit'][1])} eff {o['eff_episodes']} fwdR {o['fwd_R_mean']:+.3f}"
              + (f" | fp {fp[0]:.3f} {ci(fp[1])} n {o['first_passage_resolved']}" if fp else ""))
