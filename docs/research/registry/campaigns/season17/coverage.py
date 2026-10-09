"""season17 coverage check: first/last M1 bar, bars per year, weekend share per instrument (no returns computed)."""
import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__)); ENG = os.path.dirname(os.path.dirname(HERE))
sys.path[:0] = [ENG, os.path.join(ENG, "audit", "notrade12")]
import numpy as np
import nt12

INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "NATGAS/USD", "SPX500/USD", "EUR/USD", "USD/JPY", "NAS100/USD", "BTC/USD"]
out = {}
for inst in INSTS:
    m1, src = nt12.load_m1c(inst)
    t = m1["t"]; d = t // 1440; wd = (d + 3) % 7
    yrs = (t.astype("datetime64[m]").astype("datetime64[Y]").astype(int) + 1970)
    out[inst] = dict(src=src, first=str(t[0].astype("datetime64[m]")), last=str(t[-1].astype("datetime64[m]")),
                     per_year={int(y): int((yrs == y).sum()) for y in np.unique(yrs)}, weekend_share=float((wd >= 5).mean()))
    print(inst, out[inst]["first"], out[inst]["last"], out[inst]["per_year"], round(out[inst]["weekend_share"], 3), flush=True)
json.dump(out, open(os.path.join(HERE, "out", "coverage.json"), "w"), indent=1)
