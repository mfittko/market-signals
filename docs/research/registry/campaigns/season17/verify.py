"""season17 spot check: SPX500 Monday trades in 2020H1 (prices, R, gross long, short net) against known index moves."""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ENG = os.path.dirname(os.path.dirname(HERE))
sys.path[:0] = [ENG, os.path.join(ENG, "audit", "notrade12")]
import numpy as np, pandas as pd
import nt12
m1, _ = nt12.load_m1c("SPX500/USD")
B = nt12.frame("SPX500/USD", m1, "M5", nt12.h1("SPX500/USD", m1))
T = pd.read_pickle(os.path.join(HERE, "out", "tr_SPX500_USD.pkl"))
X = T[T.cand == "N07_SPX_monday_short"]
X = X[(X.e > 0)]
ts = pd.to_datetime(B["t"][X.e.to_numpy()], unit="m")
X = X.assign(t_in=ts, t_out=pd.to_datetime(B["t"][X.x.to_numpy()] + 5, unit="m"), px_in=B["mid_o"][X.e.to_numpy()], px_out=B["mid_c"][X.x.to_numpy()],
             R=(B["mid_c"][X.x.to_numpy()] - B["mid_o"][X.e.to_numpy()]) / X.gl.to_numpy())
print(X[(X.t_in >= "2020-02-20") & (X.t_in < "2020-05-01")][["t_in", "t_out", "px_in", "px_out", "R", "gl", "ns", "spr"]].round(3).to_string())
print("R / price median (all Mondays):", float(np.median(X.R / X.px_in)))
