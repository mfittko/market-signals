"""alert7 diagnostic (no labels/scores): cadence rows per year before and after each population filter."""
import sys
INST = sys.argv[1]
sys.argv = [sys.argv[0], "x", INST]
import os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ablate4"))
import run as A
from run import bm, de, np, year_start_day
m1, B, O, L = de.prep(INST, None)
u = A.utc_close(B); cad = u % 30 == 0
ba = de.base_active(B, O); sp = B["spr"] <= de.SPR_MAX
for y in range(2018, 2027):
    m = cad & (B["day"] >= year_start_day(y)) & (B["day"] < year_start_day(y + 1))
    print(INST, y, "cad", int(m.sum()), "base_active", int((m & ba).sum()), "spread", int((m & sp).sum()), "both", int((m & ba & sp).sum()),
          "median spr", float(np.nanmedian(B["spr"][m])) if m.any() else None)
