"""POST-HOC (after the registered run): per-year gross of the few large fixed-threshold REVERT cells."""
import numpy as np
import roll47 as R

for inst, thr, h in (("WTICO/USD", 0.012, 60), ("NAS100/USD", 0.012, 120), ("SPX500/USD", 0.012, 120), ("US30/USD", 0.012, 30)):
    D = R.dense(R.load_m1(inst)); G = R.decisions(D)
    tr = R.trades(D, G, R.signal_mask(G, "fix", thr), h)
    yr = (tr["T"] // 1440).astype("datetime64[D]").astype("datetime64[Y]").astype(int) + 1970
    out = {int(y): (int((yr == y).sum()), round(float(-tr["g"][yr == y].mean()), 1)) for y in np.unique(yr)}
    print(inst, thr, h, "REVERT gross by year (n, bps):", out)
