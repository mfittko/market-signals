"""Print the pairs16 results table from out/results.json."""
import os, json
R = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "results.json")))
f = lambda x: "  -  " if x is None else f"{x:+.3f}"
for v, r in R["variants"].items():
    print(f"\n{v}  verdict={r['verdict']}")
    for w in ("dev", "w2023"):
        s = r[w]
        if not s["trades"]:
            print(" ", w, "no trades"); continue
        print(f"  {w:6s} n={s['trades']:4d} ({s['trades_per_year']:.0f}/y) net={f(s['net_per_trade'])} "
              f"[{s['ci'][0]:+.3f},{s['ci'][1]:+.3f}] fin0={f(s['net_per_trade_fin0'])} gross={f(s['gross_per_trade'])} "
              f"cost={s['cost_per_trade']:.3f} R/y={s['net_per_year']:+.2f} hit={s['hit']:.2f} mdd={s['maxdd']:.1f} "
              f"mde={s['mde']:.3f} | rt={f(s['rt_mean'])} p_rt={s['p_rt']:.3f}/{s['p_rt_holm']:.3f} "
              f"p_side={s['p_side']:.3f}/{s['p_side_holm']:.3f} p0={s['p_le0']:.3f}/{s['p_le0_holm']:.3f} "
              f"ctrl={f(s.get('ctrl_mean'))} p_ctrl={s.get('p_ctrl', float('nan')):.3f} exits={[round(x, 2) for x in s['exit_mix']]} "
              f"hold={s['hold_bars_median']:.0f}")
    print("  crisis:", {c: (r[c]["trades"], None if r[c]["net_per_trade"] is None else round(r[c]["net_per_trade"], 3))
                        for c in ("2020H1", "2022H1", "2025Q4_26Q1")})
print("\nhalf-lives")
for k, v in R["half_life"].items():
    print(" ", k, {y: (None if x is None else round(x, 2)) for y, x in v.items()})
print("\nyearly")
for k, v in R["yearly"].items():
    print(" ", k, {y: (n, round(m, 3)) for y, (n, m) in v.items()})
