"""Sanity check of a built instrument: feature coverage, trade timing and a few trades (no policy statistics)."""
import os, sys
import numpy as np
import pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__))
tag = sys.argv[1]
W = pd.read_pickle(os.path.join(HERE, "out", f"day_{tag}.pkl")); T = pd.read_pickle(os.path.join(HERE, "out", f"trd_{tag}.pkl"))
print(W.filter(regex="^(rv1|gap|stress|pre_|so_)").describe().T[["count", "mean", "min", "max"]].round(3))
print(W.label.value_counts())
T["hh"] = ((T.t + 5) % 1440) / 60
print(T.groupby(["pol", "cp"]).agg(n=("net", "size"), ok=("ok", "mean"), hh_med=("hh", "median"), hh_min=("hh", "min"), hh_max=("hh", "max"),
                                   spr=("spr", "median"), nan=("net", lambda x: x.isna().mean())))
print(T.head(6).to_string())
