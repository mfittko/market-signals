"""Print a compact summary of out/results.json."""
import json, os
R = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "results.json")))
f = lambda c: f"{c[0]:+.3f} [{c[1]:+.3f}, {c[2]:+.3f}]"
for v, o in R["variants"].items():
    print(f"### {v}: {o['disposition']}")
    for w, s in o.items():
        if w == "disposition":
            continue
        extra = f" | long {s['always_long']:+.3f} delta {f(s['delta_vs_long'])}" if "always_long" in s else ""
        holm = " ".join(f"{k}={s[k]:.3f}" for k in s if k.startswith("holm_"))
        print(f"  {w}: n {s['trades']} ({s['trades_per_year']:.0f}/yr) net {f(s['net_per_trade'])} hit {s['hit'][0]:.3f} gross {s['gross_per_trade']:+.3f} "
              f"cost {s['cost_per_trade']:.3f} per-day {s['net_per_day']:+.3f} MDE {s['mde']:.3f} | side {s['side']['mean']:+.3f} p {s['side']['p']:.3f} "
              f"| clock {s['clock']['mean'] if s['clock']['mean'] is not None else float('nan'):+.3f} p {s['clock']['p']:.3f}{extra} {holm}")
        for i, p in s.get("per_instrument", {}).items():
            ex = f" long {p['always_long']:+.3f} d {f(p['delta_vs_long'])}" if "always_long" in p else ""
            print(f"      {i:11s} n {p['trades']:5d} net {f(p['net_per_trade'])} hit {p['hit'][0]:.3f} gross {p['gross_per_trade']:+.3f} MDE {p['mde']:.3f} "
                  f"side p {p['side']['p']:.3f} clock {p['clock']['mean']:+.3f} p {p['clock']['p']:.3f}{ex}")
