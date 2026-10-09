"""season17 integrity check on built trades: counts, spread-rule pass rate, financing nights (no returns inspected)."""
import os, sys
import pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__))
for f in sorted(os.listdir(os.path.join(HERE, "out"))):
    if not f.startswith("tr_"):
        continue
    T = pd.read_pickle(os.path.join(HERE, "out", f))
    g = T.groupby("cand").agg(n=("day", "size"), spr_ok=("spr", lambda s: (s <= 0.2).mean()), nights=("nights", "mean"))
    print(f, len(T)); print(g.loc[[c for c in g.index if not c.startswith(("U", "L"))] + ["U00", "U12", "U21", "U22", "L09", "L16"]].round(3).to_string())
