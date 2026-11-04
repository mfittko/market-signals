"""rescan26 statistics over out/tr_*.pkl: one row per campaign / variant / instrument (plus POOLED per variant).
Per window (dev, w2023): n, gross mean R [95% CI], gross hit rate (gross R > 0) [CI], net mean R [CI], one-sided p (gross <= 0).
validate.day_boot (block 5, 1000 reps, seed 26) over the consecutive day keys of the window's rows.
HOLDS_GROSS = gross CI low > 0 in BOTH windows. Holm across all rows on p_row = max(p_dev, p_w2023) (intersection-union).
POST-HOC re-scoring of existing campaigns; descriptive."""
import os, sys, glob, json
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ENG); sys.path.insert(0, os.path.join(ENG, "audit", "notrade12"))
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from validate import day_boot  # noqa: E402
from scipy.stats import norm  # noqa: E402

OUT = os.path.join(HERE, "out")
NBOOT, SEED, MIN_N = 1000, 26, 20
BLOCK = int(os.environ.get("RESCAN_BLOCK", 5))   # 20 only for the mw6 overlap sensitivity (20-day tranches)


def holm(p):
    p = np.asarray(p, float); o = np.argsort(p); m = len(p); adj = np.empty(m); run = 0.0
    for r, k in enumerate(o):
        run = max(run, min(1.0, (m - r) * p[k])); adj[k] = run
    return adj


def win_stats(X):
    g, n, d = X.gross.to_numpy(float), X.net.to_numpy(float), X.day.to_numpy()
    A = np.c_[g, (g > 0).astype(float), n]

    def stat(ix):
        return np.nanmean(A[ix], 0)
    T = stat(np.arange(len(X)))
    bt = day_boot(d, np.arange(d.min(), d.max() + 1), stat, NBOOT, block=BLOCK, seed=SEED)
    ci = lambda j: [float(T[j]), float(np.nanpercentile(bt[:, j], 2.5)), float(np.nanpercentile(bt[:, j], 97.5))]
    se = float(np.nanstd(bt[:, 0]))
    pz = float(norm.sf(T[0] / se)) if se > 0 else 1.0       # normal approximation; resolves p below the 1/1001 bootstrap floor
    return dict(n=int(len(X)), gross=ci(0), hit=ci(1), net=ci(2), se_gross=se, p_gross_le0=float((np.sum(bt[:, 0] <= 0) + 1) / (len(bt) + 1)),
                p_gross_le0_z=pz)


def main(only=None):
    files = sorted(glob.glob(os.path.join(OUT, "tr_*.pkl")))
    R = pd.concat([pd.read_pickle(f) for f in files if not only or os.path.basename(f)[3:-4] in only], ignore_index=True)
    R = R[R.win.isin(["dev", "w2023"]) & np.isfinite(R.gross.astype(float))]
    R["net"] = R.net.astype(float).where(np.isfinite(R.net.astype(float)), np.nan)
    rows = []
    for (camp, var), V in R.groupby(["camp", "variant"], sort=True):
        units = [("POOLED", V)] + ([(i, V[V.inst == i]) for i in sorted(V.inst.unique())] if V.inst.nunique() > 1 else [])
        if V.inst.nunique() == 1:
            units = [(V.inst.iat[0], V)]
        for unit, U in units:
            o = dict(camp=camp, variant=var, inst=unit)
            for w in ("dev", "w2023"):
                X = U[U.win == w]
                o[w] = win_stats(X) if len(X) >= MIN_N else None
            rows.append(o)
        print(camp, var, len(rows), flush=True)
    ok = [r for r in rows if r["dev"] and r["w2023"]]
    for r in rows:
        r["checked"] = bool(r["dev"] and r["w2023"])
        r["HOLDS_GROSS"] = bool(r["checked"] and r["dev"]["gross"][1] > 0 and r["w2023"]["gross"][1] > 0)
        r["p_row"] = max(r["dev"]["p_gross_le0"], r["w2023"]["p_gross_le0"]) if r["checked"] else None
        r["p_row_z"] = max(r["dev"]["p_gross_le0_z"], r["w2023"]["p_gross_le0_z"]) if r["checked"] else None
    adj = holm([r["p_row_z"] for r in ok])   # bootstrap p cannot reach 0.05 / rows with 1000 reps; Holm uses the z p
    for r, a in zip(ok, adj):
        r["p_holm"] = float(a); r["HOLDS_GROSS_HOLM"] = bool(r["HOLDS_GROSS"] and a < 0.05)
    return rows


def fmt(c):
    return f"{c[0]:+.3f} [{c[1]:+.3f}, {c[2]:+.3f}]"


def report(rows, path_txt, path_json):
    ok = [r for r in rows if r["checked"]]
    hold = [r for r in ok if r["HOLDS_GROSS"]]; holm_ = [r for r in ok if r.get("HOLDS_GROSS_HOLM")]
    L = ["rescan26: POST-HOC gross re-scoring of existing campaigns (descriptive; no new prereg)",
         "Gross = mid fills, no spread, entry at the next bar open after the signal is known (campaign's own entry rule).",
         "Net = the campaign's bid/ask result (secondary). Day-block bootstrap: validate.day_boot block 5, 1000 reps, seed 26.",
         "HOLDS_GROSS = gross mean R CI low > 0 in BOTH dev and w2023. Holm across all checked rows on p_row_z = max(p_dev, p_w2023), one-sided normal p from the bootstrap SE.",
         "2023+ is a development window, not a holdout. Rows overlap (POOLED and per-instrument, variants share trades), so Holm is conservative.",
         f"rows total {len(rows)}; checked (n >= {MIN_N} in both windows) {len(ok)}; HOLDS_GROSS raw {len(hold)}; HOLDS_GROSS after Holm {len(holm_)}",
         "", f"{'campaign':10s} {'variant':26s} {'inst':11s} | {'dev n':>6s} {'gross dev':>26s} {'hit':>5s} {'net dev':>7s} | "
         f"{'w23 n':>6s} {'gross w2023':>26s} {'hit':>5s} {'net w23':>7s} | flag"]
    for r in rows:
        d, w = r["dev"], r["w2023"]
        f = lambda x: (f"{x['n']:6d} {fmt(x['gross']):>26s} {x['hit'][0]:5.3f} {x['net'][0]:+7.3f}" if x else f"{'-':>6s} {'-':>26s} {'-':>5s} {'-':>7s}")
        flag = ("HOLDS_GROSS" + (" HOLM" if r.get("HOLDS_GROSS_HOLM") else "") if r["HOLDS_GROSS"] else "")
        L.append(f"{r['camp']:10s} {r['variant'][:26]:26s} {r['inst'][:11]:11s} | {f(d)} | {f(w)} | {flag}")
    open(path_txt, "w").write("\n".join(L) + "\n")
    json.dump(dict(note=L[:6], rows=rows), open(path_json, "w"), indent=1, default=float)
    return L


if __name__ == "__main__":
    only = sys.argv[1:] or None
    rows = main(only)
    sfx = ("_" + "_".join(only) if only else "") + (f"_b{BLOCK}" if BLOCK != 5 else "")
    L = report(rows, os.path.join(OUT, f"report{sfx}.txt"), os.path.join(OUT, f"results{sfx}.json"))
    print("\n".join(L[:7]))
