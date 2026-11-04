"""POST-HOC (not registered): on predicted days, net R by actual type, and actual-type mix of traded days vs all traded days."""
import os
import numpy as np
import pandas as pd
from validate import year_start_day
HERE = os.path.dirname(os.path.abspath(__file__))
A = pd.read_pickle(os.path.join(HERE, "out", "pooled.pkl"))
lo, mid = year_start_day(2019), year_start_day(2023)
for cp in (120, 240):
    for pol, want in (("trend", 1), ("rmid", -1)):
        for w, m in (("dev", (A.day >= lo) & (A.day < mid)), ("w2023", A.day >= mid)):
            S = A[(A.cp == cp) & m & np.isfinite(A[f"{pol}_net"])]
            P = S[S.pred == want]
            mix = lambda D: " ".join(f"{n}:{(D.label == v).mean():.2f}" for v, n in ((1, "T"), (-1, "R"), (0, "M")))
            byp = " ".join(f"{n}:{P[P.label == v][f'{pol}_net'].mean():+.3f}(n{(P.label == v).sum()})" for v, n in ((1, "T"), (-1, "R"), (0, "M")))
            print(f"{pol}_{cp} {w}: traded all-days mix {mix(S)} | predicted+traded mix {mix(P)} | net by actual on predicted {byp}")
