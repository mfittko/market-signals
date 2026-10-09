"""Pre-registration look (no outcomes): entry-set sizes and UTC hours of the fixed entry sets.
  python explore.py INST"""
import os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "ablate4"))
INST = sys.argv[1]
sys.argv = [sys.argv[0], "x", INST]
import run as A  # noqa: E402
from run import de, np, year_start_day  # noqa: E402

t0 = time.time()
m1, B, O, L = de.prep(INST, None)
print("prep", round(time.time() - t0), "s; bars", len(B["t"]), de.iso(B["t"][0]), de.iso(B["t"][-1]))
R = de.run_d(B, O, None, (("none", None), "h1", 12))
ea = R["entries"]
fl = np.where((B["flip"] != 0) & (B["spr"] <= de.SPR_MAX))[0]
utc = A.utc_close(B)
for name, i in (("cfgX", ea), ("flipsA", fl)):
    h = utc[i] // 60
    inliq = ((utc[i] >= A.LIQ[0]) & (utc[i] <= A.LIQ[1])).mean()
    print(name, len(i), "in 07:00-20:30", round(inliq, 3), "per year", np.bincount((B["day"][i] - B["day"][0]) // 365))
    print("  hours", np.bincount(h, minlength=24).tolist())
