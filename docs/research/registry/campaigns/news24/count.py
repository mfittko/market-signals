"""Candidate counts per instrument/TF/window and the distinct GDELT 15-min files they need (no outcomes).
Writes cache/needed_windows.npy (file end times, epoch minutes) for the fetcher."""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
import events as ev

INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "EUR/USD", "SPX500/USD", "NATGAS/USD"]
W23 = np.datetime64("2023-01-01", "m").astype(np.int64)
need = {}
for tf in ("M5", "M1", "M15"):
    s = set()
    for inst in INSTS:
        E = ev.candidates(ev.load(inst, tf))
        end1 = E["close"] // 15 * 15  # newest file whose timestamp <= bar close
        s |= set(end1.tolist()) | set((end1 - 15).tolist())
        d = (E["close"] < W23).sum()
        print(tf, inst, "dev", d, "w2023", len(E["i"]) - d, "spread_drop", E["n_spread_drop"], flush=True)
    need[tf] = s
    print(tf, "distinct files", len(s))
allw = need["M5"] | need["M1"] | need["M15"]
print("union files", len(allw), "M5+M15", len(need["M5"] | need["M15"]))
for tf, s in need.items():
    np.save(os.path.join(HERE, "cache", f"needed_{tf}.npy"), np.array(sorted(s), np.int64))
