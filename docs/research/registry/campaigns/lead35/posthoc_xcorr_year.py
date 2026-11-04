"""POST-HOC diagnostic (not preregistered): SPX500/WTI lag-0 M1 return correlation per year, and at offsets of +-60 min (clock check)."""
import sys, numpy as np
import lead35 as M
L, Fo, g0, step = M.grid("SPX500/USD", "WTICO/USD", "M1")
r = lambda D: np.r_[np.nan, np.log(D["mc"][1:] / D["mc"][:-1])]
rl, rf = r(L), r(Fo)
yr = (g0 + np.arange(len(rl))).astype("datetime64[m]").astype("datetime64[Y]").astype(int) + 1970
for y in range(2018, 2027):
    out = []
    for off in (-60, 0, 60):
        a = rl[max(0, -off):len(rl) - max(0, off)]; b = rf[max(0, off):len(rf) - max(0, -off)]; yy = yr[max(0, off):len(rf) - max(0, -off)]
        m = np.isfinite(a) & np.isfinite(b) & (yy == y)
        out.append(f"off{off:+d} {np.corrcoef(a[m], b[m])[0,1]:+.3f}")
    print(y, *out)
