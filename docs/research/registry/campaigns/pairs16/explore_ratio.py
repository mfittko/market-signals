"""Exploratory, post-hoc, outside the candidate budget, descriptive only: XAU/XAG with beta fixed at 1 (the gold-silver
log ratio itself) instead of the rolling OLS beta; same rules, fills, financing, windows. Also beta-1 half-lives."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pairs16 as p
from validate import log_trial

p.beta_asof = lambda a, b, t: np.ones(len(t))
out = {}
for h in p.HZ:
    a, b = p.PAIRS["XAUXAG"]
    P = p.pair_frame(a, b, h); T = p.find_trades(P, h)
    net, gross = p.outcome(P, T["i"], T["e"], T["x"], T["side"])
    net0 = p.outcome(P, T["i"], T["e"], T["x"], T["side"], fin=0.0)[0]
    et = P["t"][T["e"]]
    rows = {}
    for w, (lo, hi) in {**p.WINDOWS, **p.CRISES}.items():
        m = (et >= p.mn(lo)) & (et < p.mn(hi))
        if not m.any():
            continue
        bs = p.day_boot(P["day"][T["e"]][m], p.all_days(p.mn(lo), min(p.mn(hi), p.mn(p.CUT))),
                        lambda ix, v=net[m]: v[ix].mean(), reps=p.NBOOT, block=p.HZ[h]["block"])
        rows[w] = {"trades": int(m.sum()), "net": float(net[m].mean()), "ci": [float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))],
                   "gross": float(gross[m].mean()), "net_fin0": float(net0[m].mean()), "hit": float((net[m] > 0).mean()),
                   "exit_mix": [float((T["reason"][m] == k).mean()) for k in (0, 1, 2)]}
        log_trial({"exp": p.EXP, "variant": f"explore_XAUXAG_beta1_{h}", "window": w, "net_per_trade": rows[w]["net"],
                   "trades": rows[w]["trades"], "mode": "exploratory_posthoc", "evaluator": "v2", "code_sha256": p.de.CODE_SHA})
    out[h] = {"windows": rows, "half_life": p.half_lives(P, h)}
    print(h, json.dumps(out[h], default=float))
json.dump(out, open(os.path.join(p.OUT, "explore_ratio.json"), "w"), indent=1, default=float)
