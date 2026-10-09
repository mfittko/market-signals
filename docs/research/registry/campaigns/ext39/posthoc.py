"""ext39 POST-HOC diagnostics (not registered, never decide the verdict): outcome tails, medians, winsorized means,
largest contributors, and the count-of-markets breadth view for the primary cell."""
import json, os
import numpy as np
from ext39 import load, build, window, week_boot, OUT, SPREADS, WINDOWS

data = load()
df = build(data, 2.5, json.load(open(SPREADS)))
p = df[(df.h == 3) & (df.entry == "close")]
res = {}
for w in WINDOWS:
    x = window(p, w)
    s = x["sig"].to_numpy()
    wk = (x["date"].dt.isocalendar().year * 100 + x["date"].dt.isocalendar().week).to_numpy()
    lo, hi = np.percentile(s, [1, 99])
    sw = np.clip(s, lo, hi)
    b = week_boot(sw, wk)
    top = x.reindex(x["sig"].abs().sort_values(ascending=False).index).head(8)
    res[w] = {"sd_sig": float(s.std()), "median_sig": float(np.median(s)), "share_abs_gt_10": float((np.abs(s) > 10).mean()),
              "winsor1_mean": float(sw.mean()), "winsor1_ci": [float(np.percentile(b, 2.5)), float(np.percentile(b, 97.5))],
              "mean_without_top10_abs": float(x.loc[x["sig"].abs().sort_values().index[:-10], "sig"].mean()),
              "largest": top[["inst", "date", "d", "z", "sig", "bps"]].astype({"date": str}).round(2).to_dict("records"),
              "by_year": x.groupby(x.date.dt.year)["sig"].mean().round(3).to_dict()}
json.dump(res, open(os.path.join(OUT, "posthoc.json"), "w"), indent=1)
print(json.dumps(res, indent=1, default=str))
