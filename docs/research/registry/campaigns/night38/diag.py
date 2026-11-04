"""night38 data-integrity diagnostic (post-run): skipped days, largest night/day returns, and the
night + day sum against the close-to-close change per year (SPX500)."""
import sys
import numpy as np
import pandas as pd
import night38 as N

days, close, _ = N.calendar()
inst = sys.argv[1] if len(sys.argv) > 1 else "SPX500/USD"
T = N.table(*N.load(inst), days, close)
print("skipped open:", list(T.index[T["pO"].isna()].strftime("%Y-%m-%d")))
print("skipped close:", list(T.index[T["pC"].isna()].strftime("%Y-%m-%d")))
for c in ("night", "day"):
    s = T[c].dropna()
    print(c, "largest |r|:", [(d.strftime("%Y-%m-%d"), round(v, 1)) for d, v in s.reindex(s.abs().sort_values().index[-8:]).items()])
cc = np.log(T["pC"]).diff() * 1e4
nd = (np.log1p(T["night"].shift(1) / 1e4) + np.log1p(T["day"] / 1e4)) * 1e4
g = pd.DataFrame({"cc": cc, "nd": nd, "night_log": np.log1p(T["night"] / 1e4) * 1e4, "day_log": np.log1p(T["day"] / 1e4) * 1e4})
print(g.groupby(g.index.year).sum().round(0))
print("close-to-close minus night+day per day, max abs:", float((g["cc"] - g["nd"]).abs().max()))
