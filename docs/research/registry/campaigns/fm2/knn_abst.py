"""Reporting-only (A1): kNN retrieval T2 AUC on all scored rows vs non-abstained rows, abstention share.
python knn_abst.py WTICO_USD   (bench1 venv)"""
import os, sys, json
import numpy as np
from sklearn.metrics import roc_auc_score
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "out"); TAG = sys.argv[1]
z = np.load(os.path.join(OUT, f"p3_{TAG}.npz")); k = np.load(os.path.join(OUT, f"fm_{TAG}_knn_bolt.npz"))
pos = {b: j for j, b in enumerate(z["i"])}; j = np.array([pos[b] for b in k["i"]])
y, day, s, ab = z["y2"][j], z["day"][j], k["s_main"], k["s_abstain"] == 1
yr = z["t"][k["i"]].astype("datetime64[m]").astype("datetime64[Y]").astype(int) + 1970
rng = np.random.default_rng(5); out = {}


def ci(m):
    ud, inv = np.unique(day[m], return_inverse=True); rows = [np.where(inv == q)[0] for q in range(len(ud))]
    yy, ss = y[m], s[m]; bs = []
    for _ in range(300):
        ix = np.concatenate([rows[q] for q in rng.integers(0, len(ud), len(ud))]); bs.append(roc_auc_score(yy[ix], ss[ix]))
    return [round(float(roc_auc_score(yy, ss)), 3), round(float(np.percentile(bs, 2.5)), 3), round(float(np.percentile(bs, 97.5)), 3)]


for part, m0 in (("dev2020_22", (yr >= 2020) & (yr <= 2022)), ("w2023", yr >= 2023)):
    m0 &= np.isfinite(y) & np.isfinite(s)
    out[part] = dict(n=int(m0.sum()), abstain=round(float(ab[m0].mean()), 3), auc_all=ci(m0), auc_kept=ci(m0 & ~ab),
                     base_kept=round(float(y[m0 & ~ab].mean()), 3), base_abstained=round(float(y[m0 & ab].mean()), 3))
print(TAG, json.dumps(out))
json.dump(out, open(os.path.join(OUT, f"knn_abst_{TAG}.json"), "w"), indent=1)
