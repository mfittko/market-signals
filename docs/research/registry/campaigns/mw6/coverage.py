"""mw6 data coverage: per instrument, weekday sessions with M1 data, missing weekday sessions, longest gap, newest bar.
Run before prereg; output out/coverage.json."""
import os, sys, json
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))
import bars  # noqa: E402

INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "NATGAS/USD", "SPX500/USD", "EUR/USD"]
out = {}
for inst in INSTS:
    m1 = bars.load_m1(inst)
    t = m1["t"]
    day = (t + 120) // 1440                       # research session key (22:00 UTC roll)
    ud, cnt = np.unique(day, return_counts=True)
    dates = ud.astype("datetime64[D]")
    wd = (dates.astype(np.int64) + 3) % 7         # 0 = Monday
    allwd = np.arange(ud[0], ud[-1] + 1)
    allwd = allwd[((allwd + 3) % 7) < 5]
    missing = np.setdiff1d(allwd, ud)
    gaps = np.diff(t)
    k = np.argsort(gaps)[-5:][::-1]
    yrs = {}
    for y in range(2018, 2027):
        a = np.datetime64(f"{y}-01-01").astype(np.int64); b = np.datetime64(f"{y + 1}-01-01").astype(np.int64)
        m = (ud >= a) & (ud < b) & (wd < 5)
        yrs[y] = dict(sessions=int(m.sum()), median_rows=int(np.median(cnt[m])) if m.any() else 0,
                      thin_sessions_lt300=int(((cnt < 300) & m).sum()),
                      missing_weekdays=int(((missing >= a) & (missing < b)).sum()))
    out[inst] = dict(rows=int(len(t)), first=str(bars.iso(t[0])), last=str(bars.iso(t[-1])),
                     missing_weekday_sessions=[str(d) for d in missing.astype("datetime64[D]")][:60],
                     n_missing=int(len(missing)),
                     top_gaps=[[str(bars.iso(t[i])), int(gaps[i])] for i in k], years=yrs)
    print(inst, out[inst]["first"], out[inst]["last"], "missing weekday sessions", len(missing),
          {y: (v["sessions"], v["median_rows"], v["thin_sessions_lt300"]) for y, v in yrs.items()}, flush=True)
json.dump(out, open(os.path.join(HERE, "out", "coverage.json"), "w"), indent=1)
