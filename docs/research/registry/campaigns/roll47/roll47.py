"""roll47: rolling 1-hour window checked every 15 minutes; CONTINUE or REVERT when |r60| crosses a threshold.

Data: data/research/history.db candles_ba M1 bid/ask (read-only), cached as out/cache/*.npz. Mid = (bid + ask) / 2.
Grid: decision times T on the UTC clock with T % 15 == 0. Window = M1 bars starting in [T-60, T-1].
  valid(T): >= 50 of the 60 bars present, bar T-60 and bar T-1 present.
  r60 = mid_c[T-1] / mid_o[T-60] - 1.
Thresholds: fixed |r60| >= 0.4%, 0.8%, 1.2%; vol-scaled |r60| >= k x med20(slot), k 2, 3, where med20(slot) is the median
  |r60| over the previous 20 valid decisions at the same UTC clock slot (min 15 of them, today excluded).
Trade: entry at the open of the first bar starting in [T, T+4] (else no trade); exit at the close of the latest bar starting in
  [e+h-5, e+h-1] (else the trade is dropped and counted). Direction CONTINUE s = sign(r60), REVERT s = -sign(r60).
  gross bps = s * (mid_c_x / mid_o_e - 1) * 1e4. net: long (bid_c_x - ask_o_e) / mid_o_e, short (bid_o_e - ask_c_x) / mid_o_e.
  sigma unit: gross / sig20, sig20 = RMS of r60 (bps) over all valid decisions of the previous 20 trading days (min 10 days).
No stacking: per (instrument, threshold, h), after an entry at e the next decision must satisfy T >= e + h.
  CONTINUE and REVERT share the same trade list, so their gross means are mirror images; net differs.
Inference: validate.day_boot (block 5 trading days, 1000 reps, seed 47) over all trading days of the window with a valid
  decision. One-sided p = 1 - Phi(mean / SE), SE = bootstrap SD. Holm over the 40 WTI cells per window.

  python roll47.py check | counts | run
"""
import os, sys, json, time, hashlib, sqlite3
from math import erf, sqrt
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out"); CACHE = os.path.join(OUT, "cache"); os.makedirs(CACHE, exist_ok=True)
sys.path.insert(0, ENG)
import numpy as np  # noqa: E402
from numpy.lib.stride_tricks import sliding_window_view as swv  # noqa: E402
from validate import day_boot, ci, log_trial, day_of  # noqa: E402

EXP = "roll47"
HIST = os.path.join(os.path.dirname(ENG), "history.db")
CUT = "2026-10-09T00:00"
INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "NATGAS/USD", "SPX500/USD", "NAS100/USD", "US30/USD", "DE30/EUR", "EUR/USD"]
PRIMARY = "WTICO/USD"
THRS = [("fix0.4", "fix", 0.004), ("fix0.8", "fix", 0.008), ("fix1.2", "fix", 0.012), ("vol2", "vol", 2.0), ("vol3", "vol", 3.0)]
HS = [15, 30, 60, 120]
DIRS = ["CONTINUE", "REVERT"]
MIN_BARS, MED_N, MED_MIN, SIG_N, SIG_MIN = 50, 20, 15, 20, 10
WINS = {"dev": ("2018-01-01", "2022-12-31"), "w2023": ("2023-01-01", "2026-10-08")}
REPS, BLOCK, SEED, ALPHA = 1000, 5, 47, 0.05
SESS = [("asia", 22 * 60, 7 * 60), ("london", 7 * 60, 13 * 60), ("ny", 13 * 60, 22 * 60)]  # by UTC minute of T
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()


def load_m1(inst):
    f = os.path.join(CACHE, inst.replace("/", "_") + ".npz")
    if not os.path.exists(f):
        con = sqlite3.connect(f"file:{HIST}?mode=ro", uri=True)
        rows = con.execute("select time, bid_o, bid_c, ask_o, ask_c from candles_ba where instrument=? and "
                           "granularity='M1' and time < ? order by time", (inst, CUT)).fetchall()
        con.close()
        t = np.array([r[0][:16] for r in rows], dtype="datetime64[m]").astype(np.int64)
        a = np.array([r[1:] for r in rows], float)
        np.savez(f, t=t, bo=a[:, 0], bc=a[:, 1], ao=a[:, 2], ac=a[:, 3])
    z = np.load(f)
    return {k: z[k] for k in ("t", "bo", "bc", "ao", "ac")}


def dense(m):
    """Dense minute arrays (NaN where no bar) from the first to the last bar."""
    t0, t1 = int(m["t"][0]), int(m["t"][-1])
    n = t1 - t0 + 1
    D = {"t0": t0, "n": n}
    for k in ("bo", "bc", "ao", "ac"):
        a = np.full(n, np.nan); a[m["t"] - t0] = m[k]; D[k] = a
    D["mo"], D["mc"] = (D["bo"] + D["ao"]) / 2, (D["bc"] + D["ac"]) / 2
    return D


def decisions(D):
    """Grid table: T (UTC minute), r60, med20(slot), sig20, entry/exit-ready arrays."""
    t0, n = D["t0"], D["n"]
    have = np.isfinite(D["mc"]).astype(np.int64)
    cs = np.r_[0, np.cumsum(have)]
    first = t0 + (-t0) % 15
    T = np.arange(first + 60, t0 + n, 15)                       # needs bars T-60..T-1 inside the range
    i = T - t0
    cnt = cs[i] - cs[i - 60]
    r = D["mc"][i - 1] / D["mo"][i - 60] - 1
    ok = (cnt >= MIN_BARS) & np.isfinite(r)
    T, r = T[ok], r[ok]
    slot = (T % 1440) // 15
    med = np.full(len(T), np.nan)
    a = np.abs(r)
    for s in range(96):
        j = np.flatnonzero(slot == s)
        if len(j) <= MED_MIN:
            continue
        x = a[j]
        # previous MED_N values at this slot; the slot occurs once per day, so these are earlier days only
        p = np.full(len(x), np.nan)
        W = swv(np.r_[np.full(MED_N, np.nan), x[:-1]], MED_N)      # W[k] = x[k-MED_N..k-1]
        good = np.sum(np.isfinite(W), axis=1) >= MED_MIN
        p[good] = np.nanmedian(W[good], axis=1)
        med[j] = p
    day = day_of(T)
    ud, inv = np.unique(day, return_inverse=True)
    ss = np.bincount(inv, weights=(r * 1e4) ** 2); nn = np.bincount(inv)
    cs2, csn = np.r_[0, np.cumsum(ss)], np.r_[0, np.cumsum(nn)]
    k = np.arange(len(ud)); lo = np.maximum(k - SIG_N, 0)
    sig_d = np.where(k - lo >= SIG_MIN, np.sqrt((cs2[k] - cs2[lo]) / np.maximum(csn[k] - csn[lo], 1)), np.nan)
    return dict(T=T, r=r, med=med, sig=sig_d[inv], day=day)


def first_bar(D, a, b, last=False):
    """Index (minute offset) of the first (or last) present bar starting in [a, b], else -1. a, b arrays of UTC minutes."""
    out = np.full(len(a), -1)
    if len(a) == 0:
        return out
    rng = range(b[0] - a[0], -1, -1) if not last else range(0, b[0] - a[0] + 1)
    for d in rng:                                              # later assignment wins
        j = a - D["t0"] + d
        okj = (j >= 0) & (j < D["n"])
        hit = np.zeros(len(a), bool); hit[okj] = np.isfinite(D["mo"][j[okj]])
        out[hit] = j[hit]
    return out


def trades(D, G, sig_mask, h):
    """Non-stacking trade list for signals sig_mask at horizon h. Returns dict of arrays (CONTINUE sign)."""
    T, r = G["T"], G["r"]
    idx = np.flatnonzero(sig_mask)
    e = first_bar(D, T[idx], T[idx] + 4)
    x = first_bar(D, D["t0"] + np.maximum(e, 0) + h - 5, D["t0"] + np.maximum(e, 0) + h - 1, last=True)
    keep, dropped, nxt = [], 0, -10 ** 12
    for q in range(len(idx)):
        if T[idx[q]] < nxt or e[q] < 0:
            continue
        nxt = D["t0"] + e[q] + h                               # the slot is busy until the planned exit
        if x[q] < 0:
            dropped += 1
            continue
        keep.append(q)
    keep = np.array(keep, int)
    q, ei, xi = idx[keep], e[keep], x[keep]
    s = np.sign(r[q])
    mo = D["mo"][ei]
    g = s * (D["mc"][xi] / mo - 1) * 1e4
    nl = (D["bc"][xi] - D["ao"][ei]) / mo * 1e4
    ns = (D["bo"][ei] - D["ac"][xi]) / mo * 1e4
    return dict(T=T[q], day=G["day"][q], g=g, net_c=np.where(s > 0, nl, ns), net_r=np.where(s > 0, ns, nl),
                sig=G["sig"][q], n_sig=int(sig_mask.sum()), dropped=dropped)


def signal_mask(G, kind, v):
    a = np.abs(G["r"])
    return a >= v if kind == "fix" else np.isfinite(G["med"]) & (a >= v * G["med"])


def in_win(day, w):
    a, b = (day_of(np.datetime64(x + "T00:00", "m").astype(np.int64)) for x in WINS[w])
    return (day >= a) & (day <= b)


def pone(m, se):
    return 0.5 * (1 - erf((m / se) / sqrt(2))) if se > 0 else np.nan


def cell_stats(tr, sel, all_days):
    g, nc, nr, sg = tr["g"][sel], tr["net_c"][sel], tr["net_r"][sel], tr["g"][sel] / tr["sig"][sel]
    n = int(sel.sum())
    if n < 10:
        return None
    stat = lambda i: [g[i].mean(), nc[i].mean(), nr[i].mean(), np.nanmean(sg[i])]
    B = np.array(day_boot(tr["day"][sel], all_days, stat, reps=REPS, block=BLOCK, seed=SEED))
    est = stat(np.arange(n))
    res = {}
    for d, sgn, jn in (("CONTINUE", 1, 1), ("REVERT", -1, 2)):
        gb = sgn * B[:, 0]; se = float(np.std(gb, ddof=1))
        res[d] = dict(n=n, gross=sgn * est[0], gross_ci=ci(gb), se=se, p1=pone(sgn * est[0], se), mde80=2.8 * se,
                      net=est[jn], net_ci=ci(B[:, jn]), sigma=sgn * est[3], sigma_ci=ci(sgn * B[:, 3]),
                      hit=float((sgn * g > 0).mean()), spread_share=float(np.mean(sgn * g - (nc if sgn > 0 else nr))
                                                                         / max(np.mean(np.abs(g)), 1e-12)))
    return res


def holm(ps):
    ps = np.asarray(ps, float); o = np.argsort(ps); m = len(ps); adj = np.empty(m); run = 0
    for k, i in enumerate(o):
        run = max(run, min(1.0, (m - k) * ps[i])); adj[i] = run
    return adj


def check():
    # synthetic: a pure random walk gives no edge and REVERT gross == -CONTINUE gross
    rng = np.random.default_rng(0)
    n = 60 * 24 * 200
    t = np.arange(n) + 28_000_000 - (28_000_000 % 1440)
    mid = 100 * np.exp(np.cumsum(rng.normal(0, 4e-4, n)))
    m = dict(t=t, bo=np.r_[mid[0], mid[:-1]] - .01, bc=mid - .01, ao=np.r_[mid[0], mid[:-1]] + .01, ac=mid + .01)
    D = dense(m); G = decisions(D)
    assert np.all(G["T"] % 15 == 0)
    j = 100; T = G["T"][j]; assert abs(G["r"][j] - (mid[T - 1 - t[0]] / mid[T - 61 - t[0]] - 1)) < 1e-12
    tr = trades(D, G, signal_mask(G, "fix", 0.004), 60)
    assert np.all(np.diff(tr["T"]) >= 60), "stacking"
    assert np.all(tr["net_c"] < tr["g"] + 1e-9) and np.all(tr["net_r"] < -tr["g"] + 1e-9), "net must be below gross"
    assert abs(tr["g"].mean()) < 3 * tr["g"].std() / np.sqrt(len(tr["g"])) + 1e-9
    # vol baseline excludes today: med at a slot equals the median of the previous 20 values at that slot
    s0 = np.flatnonzero((G["T"] % 1440) == (G["T"][200] % 1440))
    k = 40; assert abs(G["med"][s0[k]] - np.median(np.abs(G["r"][s0[k - 20:k]]))) < 1e-15
    print("check ok", len(G["T"]), "decisions", len(tr["g"]), "trades")


def counts():
    out = {}
    for inst in INSTS:
        D = dense(load_m1(inst)); G = decisions(D)
        c = {}
        for w in WINS:
            sel = in_win(G["day"], w); nd = len(np.unique(G["day"][sel]))
            c[w] = dict(decisions=int(sel.sum()), days=nd,
                        signals_per_day={name: round(float((signal_mask(G, kd, v) & sel).sum()) / max(nd, 1), 3)
                                         for name, kd, v in THRS})
        out[inst] = c
        print(inst, json.dumps(c))
    json.dump(out, open(os.path.join(OUT, "counts.json"), "w"), indent=1)


def run():
    rows, code = [], {"roll47.py": sha(__file__), "validate.py": sha(os.path.join(ENG, "validate.py"))}
    for inst in INSTS:
        D = dense(load_m1(inst)); G = decisions(D)
        for name, kd, v in THRS:
            mask = signal_mask(G, kd, v)
            for h in HS:
                tr = trades(D, G, mask, h)
                for w in WINS:
                    wsel = in_win(G["day"], w); all_days = np.unique(G["day"][wsel])
                    nd = len(all_days)
                    sel = in_win(tr["day"], w)
                    base = dict(inst=inst, thr=name, h=h, win=w, signals_per_day=float((mask & wsel).sum()) / nd,
                                trades=int(sel.sum()), trades_per_day=float(sel.sum()) / nd, dropped_exit=tr["dropped"])
                    res = cell_stats(tr, sel, all_days)
                    tod = {}
                    if res is not None:
                        tm = tr["T"] % 1440
                        for sn, a, b in SESS:
                            ss = sel & (((tm >= a) | (tm < b)) if a > b else ((tm >= a) & (tm < b)))
                            if ss.sum() >= 10:
                                tod[sn] = dict(n=int(ss.sum()), gross_continue=float(tr["g"][ss].mean()),
                                               net_continue=float(tr["net_c"][ss].mean()),
                                               net_revert=float(tr["net_r"][ss].mean()))
                    for d in DIRS:
                        row = dict(base, dir=d, **(res[d] if res else dict(n=int(sel.sum()))), tod=tod)
                        rows.append(row)
                print(inst, name, h, "done", flush=True)
    for w in WINS:
        P = [r for r in rows if r["inst"] == PRIMARY and r["win"] == w]
        adj = holm([r.get("p1", 1.0) if np.isfinite(r.get("p1", np.nan)) else 1.0 for r in P])
        for r, a in zip(P, adj):
            r["holm_p"] = float(a)
    for r in rows:
        log_trial(dict(exp=EXP, role="primary" if r["inst"] == PRIMARY else "secondary", code_sha256=code,
                       **{k: r[k] for k in r if k != "tod"}))
    json.dump(rows, open(os.path.join(OUT, "cells.json"), "w"), indent=1, default=float)
    key = lambda r: (r["thr"], r["dir"], r["h"])
    P = {w: {key(r): r for r in rows if r["inst"] == PRIMARY and r["win"] == w} for w in WINS}
    passing = [k for k in P["dev"] if all(P[w][k].get("holm_p", 1) < ALPHA and P[w][k].get("net", -1) > 0 for w in WINS)]
    holm_both = [k for k in P["dev"] if all(P[w][k].get("holm_p", 1) < ALPHA for w in WINS)]
    verdict = dict(PASS=bool(passing), passing=passing, holm_both_windows=holm_both, code_sha256=code)
    json.dump(verdict, open(os.path.join(OUT, "verdict.json"), "w"), indent=1, default=str)
    print(json.dumps(verdict, default=str))


if __name__ == "__main__":
    {"check": check, "counts": counts, "run": run}[sys.argv[1]]()
