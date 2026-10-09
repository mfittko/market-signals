"""night38 POST-HOC sensitivity (not registered, never decides the verdict).
The registered 2-minute staleness rule drops the March 2020 limit-down opens (the CFD stops quoting until the cash
market reopens), so the skipped nights are the largest negative ones. Here a missing point falls back to:
  - the latest bar starting in [T-31, T-1] (stale up to 30 min), else
  - the first bar starting in [T, T+29] (the first quote after a halt; its close is used).
Everything else is the registered night38 code."""
import json, os
import numpy as np
import night38 as N

_orig = N.price_at


def price_at(t, bid, ask, T):
    mid, spr = _orig(t, bid, ask, T)
    o = np.argsort(t); ts, b, a = t[o], bid[o], ask[o]
    miss = np.isnan(mid)
    j = np.searchsorted(ts, T - 1, side="right") - 1
    jc = np.clip(j, 0, None)
    back = miss & (j >= 0) & (ts[jc] >= T - 31)
    k = np.searchsorted(ts, T, side="left")
    kc = np.clip(k, 0, len(ts) - 1)
    fwd = miss & ~back & (k < len(ts)) & (ts[kc] <= T + 29)
    for m, idx in ((back, jc), (fwd, kc)):
        mid = np.where(m, (b[idx] + a[idx]) / 2, mid)
        spr = np.where(m, (a[idx] - b[idx]) / ((b[idx] + a[idx]) / 2) * 1e4, spr)
    return mid, spr


N.price_at = price_at
N.OUT = os.path.join(N.HERE, "out", "posthoc"); os.makedirs(N.OUT, exist_ok=True)
days, close, _ = N.calendar()
res = [N.evaluate(i, days, close) for i in N.INSTS]
for r in res:
    for w in N.WINS:
        y = r[w]["all"]
        N.log_trial(dict(exp=N.EXP, unit=N.TAG(r["inst"]), tf="M1", cell="all_posthoc_fallback", window=w, primary=False,
                         n=y["n_night"], night_bps=y["night"]["mean"], night_ci=y["night"]["ci"], day_bps=y["day"]["mean"],
                         diff_bps=y["diff"]["mean"], diff_ci=y["diff"]["ci"], hit=y["hit"]["mean"], net_bps=y["net"]["mean"],
                         mde80_night=y["night"]["mde80"]))
v, lb, d = N.verdict(res)
Z = dict(verdict=v, night_lb=lb, diff_point=d, results=res, note="POST-HOC fallback for missing clock points")
json.dump(Z, open(os.path.join(N.OUT, "results.json"), "w"), indent=1, default=float)
N.report(Z)
