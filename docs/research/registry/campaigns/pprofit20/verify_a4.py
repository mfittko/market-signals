"""A4 T_up label self-check on synthetic bars (run with PP_TF=M5 PP_H=12 PP_TGT=up)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
import pp20 as pp  # noqa: E402

assert pp.TGT == "up" and pp.A4_H == 12
n = 40
t = 10 + 15 * np.arange(n)  # all bars are cadence bars
mid = 100 + np.arange(n, dtype=float)  # rising 1 per bar
B = {"t": t, "bid_o": mid - .1, "ask_o": mid + .1, "bid_c": mid + .4, "ask_c": mid + .6}
z = np.zeros(n)
Fb = dict(U={k: z for k in pp.UNS}, D={k: z for k in pp.DIRF}, slot=np.zeros(n, int), valid=np.ones(n, bool),
          atr=np.full(n, 2.0), day=np.zeros(n, int))
R = pp.rows(B, Fb)
# bar i: long entry ask_o[i+1] = 101.1 + i, exit bid_c[i+12] = 112.4 + i -> +11.3 / 3 R; short = -(ask_c[i+12] - bid_o[i+1]) = -11.7 / 3
L, S = R["side"] == 1, R["side"] == -1
assert L.sum() == n - 12 and np.allclose(R["net"][L], 11.3 / 3) and np.all(R["y"][L] == 1)
assert np.allclose(R["net"][S], -11.7 / 3) and np.all(R["y"][S] == 0)
assert np.all(R["texit"][L] == t[R["i"][L] + 12] + 5)
print("A4 T_up self-check OK", int(L.sum()), "rows per side")
