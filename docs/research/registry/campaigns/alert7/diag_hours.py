"""alert7 post-hoc diagnostic (after A1 results; not registered): UTC-hour mix of the 2/week alerts and the same alert
rule on the time-of-day-only model (q_tod) and on the volatility-only model (q_vol), nospread population.
  python diag_hours.py INST  -> out/diag_hours_<TAG>.json"""
import os, sys, json
INST = sys.argv[1]; POP = sys.argv[2] if len(sys.argv) > 2 else "nospread"   # "frozen" = registered spread-rule population
sys.argv = [sys.argv[0], "", INST, POP]
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import alert7 as Z
from alert7 import np, A, GROUPS, year_start_day

B, X, S, kx, rates, W = Z.load(INST)
n = len(S["i"]); Xr = {g: X[S["i"]][:, [GROUPS["todvol"].index(k) for k in c]] for g, c in GROUPS.items()}
last_day = int(B["day"][-1]); Q = Z.quarter_starts(Z.Q_FIRST, last_day)
P = {g: np.full(n, np.nan) for g in GROUPS}; T = {g: np.full(n, np.nan) for g in GROUPS}
for qi, (qs, qd) in enumerate(Q):
    qe = Q[qi + 1][1] if qi + 1 < len(Q) else last_day + 1
    mm = (S["day"] >= qd) & (S["day"] < qe); tr = (S["day"] >= qd - Z.TRAIL) & (S["day"] < qd)
    for g in GROUPS:
        M = Z.fit(Xr[g], S, qd); P[g][mm] = Z.sig(M, Xr[g][mm])
        T[g][mm] = Z.pick_thr(S["t"][tr], Z.sig(M, Xr[g][tr]), 2, Z.TRAIL / 7)
u = A.utc_close(B)[S["i"]]
out = dict(inst=INST, note=f"post-hoc diagnostic, {POP} population, 2/week target")
for g in GROUPS:
    ok = np.isfinite(P[g]); al = np.zeros(n, bool); last = -np.inf
    for k in np.flatnonzero(ok & (P[g] >= T[g])):
        if S["t"][k] - last >= Z.COOL:
            al[k] = True; last = S["t"][k]
    r = {}
    for w, lo, hi in (("dev2020_22", year_start_day(2020), year_start_day(2023)), ("w2023", year_start_day(2023), last_day + 1)):
        a = al & (S["day"] >= lo) & (S["day"] < hi)
        hrs = np.bincount((u[a] // 60).astype(int), minlength=24)
        r[w] = dict(alerts=int(a.sum()), per_week=float(a.sum() / ((hi - lo) / 7)), precision=float(S["y"][a].mean()),
                    top_hours_utc={int(h): int(hrs[h]) for h in np.argsort(hrs)[::-1][:4]},
                    median_fwd_pct=float(np.nanmedian(S["fwd_pct"][a])), median_fwd_pct_all=float(np.nanmedian(S["fwd_pct"][(S["day"] >= lo) & (S["day"] < hi)])))
    out[g] = r
json.dump(out, open(os.path.join(Z.OUT, f"diag_hours_{INST.replace('/', '_')}{'_frozen' if POP == 'frozen' else ''}.json"), "w"), indent=1)
print(json.dumps(out))
