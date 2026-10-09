"""Post-hoc diagnostic (not registered, no selection): why does the confirmed H1 drift not convert at K=3?
Spread at the signal bar in R, unmanaged 12-bar bid/ask hold, mid-to-mid drift from entry, per window."""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.argv = [sys.argv[0], "x"]
sys.path.insert(0, HERE)
import xvol9 as X  # noqa: E402
import numpy as np  # noqa: E402

D = X.load(); G = X.grid(D)
C = X.h1h3(G, X.events(G, X.K_MAIN), "ext", 1)
for wn, (a, b) in X.WINDOWS.items():
    lo, hi = np.datetime64(a, "m").astype(np.int64), np.datetime64(b, "m").astype(np.int64)
    W = X.wslice(C, lo, hi)
    spr, held, mid, slip = [], [], [], []
    for inst in X.INSTS:
        m = W["inst"] == inst
        if not m.any():
            continue
        I = D[inst]; ok, i = X.confirm(I, W["b"][m], W["s"][m], "ext"); s = W["s"][m][ok]; i = i[ok]
        i = i[i + 12 < len(I["t"])]; s = s[:len(i)] if len(s) == len(i) else s[np.isin(np.arange(len(s)), np.arange(len(i)))]
        R = 1.5 * I["atr"][i]; e, x = i + 1, i + 12
        ent = np.where(s > 0, I["ask_o"][e], I["bid_o"][e]); ex = np.where(s > 0, I["bid_c"][x], I["ask_c"][x])
        spr.append(I["spr"][i]); held.append(s * (ex - ent) / R)
        mid.append(s * (I["mid_c"][x] - I["mid_o"][e]) / R); slip.append(s * (I["mid_o"][e] - I["mid_c"][i]) / R)
    f = lambda v: float(np.mean(np.concatenate(v)))
    print(f"{wn}: n={len(np.concatenate(spr))} spread/R at signal {f(spr):.3f} | unmanaged 12-bar bid/ask hold {f(held):+.3f} R | "
          f"mid drift entry->+12 {f(mid):+.3f} R | mid gap signal close->entry open {f(slip):+.3f} R")
