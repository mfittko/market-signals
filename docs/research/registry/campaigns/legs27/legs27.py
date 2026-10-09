"""legs27: two operator claims about intraday structure, judged GROSS (mid) with next-bar-open latency.

H1 (chop means no direction): 12-bar efficiency ratio, wick share and range-to-spread, bucketed in dev-window quintiles;
    outcome = |move| / ATR over N = 3, 6, 12 bars from the next bar open (mid). M5 primary, M1 and M15 secondary.
H2 (long leg, then a longer counter-leg): causal leg = close minus the extreme of the last K bars of the same trading day;
    first event per day and direction at leg >= L x daily ATR; race / counter-leg / signed drift from the next bar open (mid)
    vs a driftless null (demeaned same-day M5 close increments, resampled). M5 only. Hindsight subset reported separately.

Evaluator v2 helpers (validate.day_boot, de_v2.supertrend, nt12.load_m1c/frame) imported unchanged. Development evidence only.

  python legs27.py check           synthetic self-checks
  python legs27.py register        prereg.json (refuses to overwrite)
  python legs27.py build INST TF   H1 day aggregates (+ H2 events on M5) -> out/b_<TAG>_<TF>.pkl
  python legs27.py run             statistics -> out/results.json
"""
import os, sys, json, time, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
for p in (ENG, os.path.join(ENG, "audit", "notrade12"), os.path.join(ENG, "audit", "xvol9")):
    sys.path.insert(0, p)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import de_v2 as de  # noqa: E402
from validate import day_boot, year_start_day  # noqa: E402
import nt12  # noqa: E402

EXP = "legs27"
INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "EUR/USD", "SPX500/USD", "NATGAS/USD"]
TFS = ["M5", "M1", "M15"]
G = {"M5": 5, "M1": 1, "M15": 15}
TAG = lambda inst: inst.replace("/", "_")
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"legs27.py": sha(os.path.join(HERE, "legs27.py")), "nt12.py": nt12.CODE["nt12.py"], "evaluator": de.CODE_SHA}

# H1 constants
W = 12                                   # lookback bars for the three chop measures
NS = (3, 6, 12)                          # outcome horizons in bars
CLEAR, NODIR = 0.5, 0.25                 # |move| / ATR thresholds
MEAS = ["er", "wick", "r2s"]
CHOP_Q = {"er": 0, "wick": 4, "r2s": 0}  # the quintile the operator calls chop (0 = lowest, 4 = highest)
CLEAN_Q = {"er": 4, "wick": 0, "r2s": 4}
MET = ["n", "sa", "clear", "nodir", "nc", "cont", "nsc", "ssc"]   # per day x quintile sums
# H2 constants (M5)
K = 48                                   # leg lookback, M5 bars (4 hours), bounded at the trading-day start
LS = (0.3, 0.6, 1.0)                     # leg thresholds as a multiple of the daily ATR
L_PRIMARY = 0.6
DATR_N, PRIOR_COVER = 14, 0.5            # daily ATR = mean mid high-low range of the previous 14 trading days with >= 50% bars
RACE = 0.5                               # retrace 50% of the leg vs extend 50% of the leg, from the entry price
HINDSIGHT = 0.003                        # hindsight subset: |day close / day open - 1| <= 0.3%
HS = (12, 48)
NNULL = 200
NBOOT, BLOCK, SEED = 1000, 5, 27


# ------------------------------------------------------------------ pure helpers
def roll_sum(x, w):
    cs = np.r_[0.0, np.cumsum(np.nan_to_num(x))]
    out = np.full(len(x), np.nan)
    out[w - 1:] = cs[w:] - cs[:-w]
    return out


def chop(o, h, l, c, spr, w=W):
    """ER, mean wick share and median range / median spread over the w bars ending at i (bars i-w+1..i; ER uses c[i-w])."""
    ad = np.abs(np.diff(c, prepend=np.nan))
    den = roll_sum(ad, w)
    er = np.full(len(c), np.nan)
    er[w:] = np.abs(c[w:] - c[:-w]) / np.where(den[w:] > 0, den[w:], np.nan)
    rng = h - l
    ws = np.where(rng > 0, (rng - np.abs(c - o)) / np.where(rng > 0, rng, 1), np.nan)
    wick = pd.Series(ws).rolling(w, min_periods=1).mean().to_numpy().copy()
    wick[:w - 1] = np.nan
    mr = pd.Series(rng).rolling(w).median().to_numpy()
    ms = pd.Series(spr).rolling(w).median().to_numpy()
    r2s = np.where(ms > 0, mr / np.where(ms > 0, ms, 1), np.nan)
    return {"er": er, "wick": wick, "r2s": r2s}


def race(rel, b):
    """rel: signed path in the leg direction from the entry (closes). 1 = rel <= -b first (retrace), 0 = rel >= b first, nan = neither."""
    up = np.flatnonzero(rel >= b); dn = np.flatnonzero(rel <= -b)
    iu = up[0] if len(up) else 10 ** 9; idn = dn[0] if len(dn) else 10 ** 9
    if iu == idn:
        return np.nan
    return 1.0 if idn < iu else 0.0


def counter_hit(rel, size):
    """True iff the drawdown from the running extreme in the leg direction (starting at the entry, rel = 0) reaches size."""
    m = np.maximum.accumulate(np.maximum(rel, 0.0))
    return bool(np.any(m - rel >= size))


def null_paths(inc, m, b, size, rng, nn=NNULL):
    """Driftless null: m demeaned increments resampled from inc. Returns (P retrace first | resolved, P counter >= size, frac resolved)."""
    d = inc - inc.mean()
    P = np.cumsum(rng.choice(d, size=(nn, m), replace=True), 1)
    up = np.where((P >= b).any(1), (P >= b).argmax(1), 10 ** 9)
    dn = np.where((P <= -b).any(1), (P <= -b).argmax(1), 10 ** 9)
    res = up != dn
    pr = float(np.mean(dn[res] < up[res])) if res.any() else np.nan
    M = np.maximum.accumulate(np.maximum(P, 0.0), 1)
    ch = float(np.mean(((M - P) >= size).any(1)))
    return pr, ch, float(res.mean())


def check():
    c = np.array([1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1.0, 2])
    f = chop(c, c + 0.5, c - 0.5, c, np.full(len(c), 0.1), w=12)
    assert abs(f["er"][12] - 0.0) < 1e-12 and np.isnan(f["er"][11])           # 12 steps of +-1 netting to 0
    t = np.arange(13.0)
    f = chop(t, t + 1, t, t + 1, np.full(13, 0.5), w=12)
    assert abs(f["er"][12] - 1.0) < 1e-12                                      # straight line
    assert abs(f["wick"][12] - 0.0) < 1e-12 and abs(f["r2s"][12] - 2.0) < 1e-12  # full-body bars, range 1 / spread 0.5
    o = np.full(12, 1.0); h = o + 1; l = o - 1
    assert abs(chop(o, h, l, o, np.full(12, 1.0), w=12)["wick"][11] - 1.0) < 1e-12   # dojis: all wick
    assert race(np.array([0.1, -0.2, -0.6, 0.9]), 0.5) == 1.0
    assert race(np.array([0.1, 0.6, -0.6]), 0.5) == 0.0
    assert np.isnan(race(np.array([0.1, -0.2]), 0.5))
    assert counter_hit(np.array([0.5, 1.0, 0.1]), 0.9) and not counter_hit(np.array([0.5, 1.0, 0.2]), 0.9)
    assert counter_hit(np.array([-1.0]), 1.0)                                   # from the entry itself
    rng = np.random.default_rng(0)
    pr, ch, fr = null_paths(rng.normal(0.3, 1, 500), 400, 5.0, 10.0, rng, 2000)
    assert abs(pr - 0.5) < 0.05 and fr > 0.95, (pr, fr)                        # demeaned symmetric race ~ 0.5
    print("legs27 self-check OK: ER / wick / range-to-spread, race, counter-leg, driftless null")


# ------------------------------------------------------------------ build
def h1_days(B, g, edges_from_dev=True):
    t, o, h, l, c = B["t"], B["mid_o"], B["mid_h"], B["mid_l"], B["mid_c"]
    n = len(t)
    F = chop(o, h, l, c, B["ask_c"] - B["bid_c"])
    ok12 = np.zeros(n, bool); ok12[W:] = (t[W:] - t[:-W]) == W * g
    atr = B["atr"]
    base = ok12 & np.isfinite(atr) & (atr > 0)
    dev = (B["day"] >= year_start_day(2018)) & (B["day"] < year_start_day(2023))
    s12 = np.zeros(n); s12[W:] = np.sign(c[W:] - c[:-W])
    out, edges = {}, {}
    for m in MEAS:
        x = F[m]
        v = base & np.isfinite(x)
        e = np.quantile(x[v & dev], [0.2, 0.4, 0.6, 0.8])
        edges[m] = [float(z) for z in e]
        q = np.searchsorted(e, x, side="right")
        for N in NS:
            i = np.flatnonzero(v[: n - 1 - N])
            i = i[(t[i + 1 + N] - t[i + 1]) == N * g]
            mv = o[i + 1 + N] - o[i + 1]
            a = np.abs(mv) / atr[i]
            sd = s12[i]; sm = np.sign(mv)
            nc = (sd != 0) & (sm != 0)
            nsc = sd != 0
            D = pd.DataFrame({"day": B["day"][i], "q": q[i], "n": 1.0, "sa": a, "clear": (a >= CLEAR) * 1.0, "nodir": (a < NODIR) * 1.0,
                              "nc": nc * 1.0, "cont": (nc & (sd == sm)) * 1.0, "nsc": nsc * 1.0, "ssc": np.where(nsc, sd * mv / atr[i], 0.0)})
            S = D.groupby(["day", "q"])[MET].sum()
            days = np.unique(D.day.to_numpy())
            A = np.zeros((len(days), 5, len(MET)))
            di = np.searchsorted(days, S.index.get_level_values(0).to_numpy())
            A[di, S.index.get_level_values(1).to_numpy(), :] = S.to_numpy()
            out[(m, N)] = (days, A)
    return out, edges


def h2_events(B, inst, rng):
    t, o, h, l, c = B["t"], B["mid_o"], B["mid_h"], B["mid_l"], B["mid_c"]
    day = B["day"]
    dk, first = np.unique(day, return_index=True)
    cnt = np.diff(np.r_[first, len(day)])
    rngd = np.array([h[s:s + k].max() - l[s:s + k].min() for s, k in zip(first, cnt)])
    full = cnt >= PRIOR_COVER * 1440 / 5
    rows = []
    for i, d in enumerate(dk):
        if (d + 3) % 7 >= 5:
            continue
        prev = np.flatnonzero(full[:i])[-DATR_N:]
        if len(prev) < DATR_N:
            continue
        datr = float(rngd[prev].mean())
        s, e_ = first[i], first[i] + cnt[i]
        if e_ - s < 3 or datr <= 0:
            continue
        rmin = pd.Series(l[s:e_]).rolling(K, min_periods=1).min().to_numpy()
        rmax = pd.Series(h[s:e_]).rolling(K, min_periods=1).max().to_numpy()
        cc = c[s:e_]
        legs = {1: cc - rmin, -1: rmax - cc}
        inc = np.diff(cc)
        dmove = c[e_ - 1] / o[s] - 1
        for L in LS:
            for sd, lg in legs.items():
                hit = np.flatnonzero(lg[:-1] >= L * datr)        # the entry bar must lie in the same trading day
                if not len(hit):
                    continue
                j = s + int(hit[0]); e = j + 1
                lsz = float(lg[hit[0]])
                p0 = o[e]
                rel = sd * (c[e:e_] - p0)
                r = race(rel, RACE * lsz)
                ch = counter_hit(rel, lsz)
                pr0, ch0, fr0 = null_paths(inc, len(rel), RACE * lsz, lsz, rng)
                hm = {}
                for H in HS:
                    x = e + H
                    hm[H] = sd * (o[x] - p0) / datr if x < len(t) and t[x] - t[e] == 5 * H else np.nan
                fill = (B["bid_o"][e] - B["ask_c"][e_ - 1]) if sd > 0 else (B["bid_c"][e_ - 1] - B["ask_o"][e])   # fade = opposite side
                rows.append(dict(day=int(d), t=int(t[j]), L=L, side=sd, datr=datr, leg=lsz, leg_datr=lsz / datr, bars_left=len(rel),
                                 race=r, race_null=pr0, race_null_res=fr0, counter=float(ch), counter_null=ch0,
                                 sess=float(rel[-1] / datr), h12=hm[12], h48=hm[48], fade_net=float(fill / datr),
                                 day_move=float(dmove), hind=bool(abs(dmove) <= HINDSIGHT)))
    return pd.DataFrame(rows)


def build(inst, tf):
    t0 = time.time()
    m1, src = nt12.load_m1c(inst)
    B = nt12.frame(inst, m1, tf, nt12.h1(inst, m1))
    H1, edges = h1_days(B, G[tf])
    o = dict(h1=H1, edges=edges, m1=src)
    if tf == "M5":
        o["h2"] = h2_events(B, inst, np.random.default_rng(SEED))
    pd.to_pickle(o, os.path.join(OUT, f"b_{TAG(inst)}_{tf}.pkl"))
    print(json.dumps(dict(inst=inst, tf=tf, m1=src, h2=int(len(o.get("h2", []))), secs=round(time.time() - t0))), flush=True)


# ------------------------------------------------------------------ run
def wins(last_day):
    return {"dev": (year_start_day(2018), year_start_day(2023)), "w2023": (year_start_day(2023), last_day + 1)}


def pct(bt, k):
    return [float(np.nanpercentile(bt[:, k], 2.5)), float(np.nanpercentile(bt[:, k], 97.5))]


def h1_stat(A, m):
    S = A.sum(0)                                  # 5 x MET
    n, sa, cl, nd, nc, co, nsc, ssc = S.T
    with np.errstate(invalid="ignore", divide="ignore"):
        pc, pn, ma, pco, msc = cl / n, nd / n, sa / n, co / nc, ssc / nsc
    a, b = CHOP_Q[m], CLEAN_Q[m]
    return np.r_[pc, pn, ma, pco, msc, pc[a] - pc[b], pn[a] - pn[b], pco[a] - pco[b], msc[a] - msc[b], n]


def h1_cell(days, A, m, lo, hi):
    sel = (days >= lo) & (days < hi)
    d, X = days[sel], A[sel]
    T = h1_stat(X, m)
    bt = day_boot(d, np.arange(lo, hi), lambda ix: h1_stat(X[ix], m), NBOOT, block=BLOCK, seed=SEED)
    names = ["p_clear", "p_nodir", "mean_absatr", "p_cont", "mean_signed_cont"]
    o = {nm: [[float(T[5 * k + q])] + pct(bt, 5 * k + q) for q in range(5)] for k, nm in enumerate(names)}
    for k, nm in enumerate(["diff_clear", "diff_nodir", "diff_cont", "diff_signed_cont"]):
        o[nm] = [float(T[25 + k])] + pct(bt, 25 + k)
    o["n_q"] = [int(x) for x in T[29:34]]
    return o


H2COLS = ["race", "race_d", "counter", "counter_d", "sess", "h12", "h48", "fade_net"]


def h2_stat(M):
    return np.nanmean(M, 0)


def h2_cell(X, lo, hi):
    M = np.c_[X.race, X.race - X.race_null, X.counter, X.counter - X.counter_null, X.sess, X.h12, X.h48, X.fade_net].astype(float)
    M[:, 1] = np.where(np.isfinite(M[:, 0]), M[:, 1], np.nan)
    T = h2_stat(M)
    bt = day_boot(X.day.to_numpy(), np.arange(lo, hi), lambda ix: h2_stat(M[ix]), NBOOT, block=BLOCK, seed=SEED)
    o = {nm: [float(T[k])] + pct(bt, k) for k, nm in enumerate(H2COLS)}
    o.update(n=int(len(X)), n_resolved=int(np.isfinite(X.race).sum()), race_null=float(X.race_null[np.isfinite(X.race)].mean()),
             counter_null=float(X.counter_null.mean()), leg_datr=float(X.leg_datr.mean()),
             p_le0_sess=float((np.sum(bt[:, 4] >= 0) + 1) / (len(bt) + 1)))
    return o


def run():
    check_reg()
    t0 = time.time()
    res = dict(code=CODE, note="development evidence; 2023+ is a development window, not a holdout; nothing qualified", h1={}, h2={}, edges={})
    last = 0
    P = {}
    for inst in INSTS:
        for tf in TFS:
            P[(inst, tf)] = pd.read_pickle(os.path.join(OUT, f"b_{TAG(inst)}_{tf}.pkl"))
            last = max(last, max(int(v[0].max()) for v in P[(inst, tf)]["h1"].values()))
    Wn = wins(last)
    for (inst, tf), o in P.items():
        res["edges"][f"{TAG(inst)}_{tf}"] = o["edges"]
        for (m, N), (days, A) in o["h1"].items():
            for w, (lo, hi) in Wn.items():
                c = h1_cell(days, A, m, lo, hi)
                res["h1"].setdefault(f"{TAG(inst)}_{tf}_{m}_N{N}", {})[w] = c
                de.log_trial({"exp": EXP, "cell": f"H1_{TAG(inst)}_{tf}_{m}_N{N}", "window": w, "n": int(sum(c["n_q"])),
                              "diff_clear": c["diff_clear"][0], "mode": "dev" if w == "dev" else "devwindow2023", "legs27_sha256": CODE["legs27.py"]})
        if "h2" in o:
            E = o["h2"]
            for L in LS:
                for w, (lo, hi) in Wn.items():
                    for sub, X in (("all", E), ("hindsight", E[E.hind])):
                        X = X[(X.L == L) & (X.day >= lo) & (X.day < hi)]
                        if len(X) < 20:
                            continue
                        c = h2_cell(X, lo, hi)
                        res["h2"].setdefault(f"{TAG(inst)}_L{L}_{sub}", {})[w] = c
                        de.log_trial({"exp": EXP, "cell": f"H2_{TAG(inst)}_M5_L{L}_{sub}", "window": w, "n": c["n"], "race_d": c["race_d"][0],
                                      "sess": c["sess"][0], "mode": "dev" if w == "dev" else "devwindow2023", "legs27_sha256": CODE["legs27.py"]})
        print(inst, tf, round(time.time() - t0), flush=True)
    prim1 = {}
    for m in MEAS:
        cell = res["h1"][f"WTICO_USD_M5_{m}_N6"]
        prim1[m] = dict(dev=cell["dev"]["diff_clear"], w2023=cell["w2023"]["diff_clear"],
                        PASS=all(cell[w]["diff_clear"][2] < 0 for w in ("dev", "w2023")))
    c2 = res["h2"][f"WTICO_USD_L{L_PRIMARY}_all"]
    prim2 = dict(race_d={w: c2[w]["race_d"] for w in ("dev", "w2023")}, sess={w: c2[w]["sess"] for w in ("dev", "w2023")})
    prim2["race_PASS"] = all(c2[w]["race_d"][1] > 0 for w in ("dev", "w2023"))
    prim2["sess_PASS"] = all(c2[w]["sess"][2] < 0 for w in ("dev", "w2023"))
    prim2["PASS"] = prim2["race_PASS"] and prim2["sess_PASS"]
    res["primary"] = dict(H1=prim1, H2=prim2)
    res["verdict"] = dict(H1={m: "PASS" if prim1[m]["PASS"] else "FAIL" for m in MEAS}, H2="PASS" if prim2["PASS"] else "FAIL")
    res["secs"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    print("done", res["secs"], res["verdict"], flush=True)


def check_reg():
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    cur = (reg.get("amendments") or [{}])[-1].get("code_sha256") or reg["code_sha256"]
    assert cur["legs27.py"] == CODE["legs27.py"], "legs27.py changed after registration (amend first)"


def register(amend=None):
    f = os.path.join(HERE, "prereg.json")
    if amend:
        reg = json.load(open(f))
        reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=amend, code_sha256=CODE))
        json.dump(reg, open(f, "w"), indent=1); print("amended"); return
    assert not os.path.exists(f), "prereg.json exists (use amend)"
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="legs27: H1 chop means no direction; H2 long leg then a longer counter-leg; issue 310",
        before_registration="Nothing computed on market data before this file (synthetic self-checks only). Prior knowledge: "
                            "notrade12 (spread and thin hours), daytype14 (trend-day probability is context only), de_v2 ER feature.",
        declared="Development evidence only. 2023+ is a development window, not a holdout (inspected by earlier campaigns). "
                 "Operator decision: judged GROSS (mid) with realistic latency (act at the next bar open after the condition is known); "
                 "net (bid/ask) is secondary where it applies (H2 fade). Binding confirmation is prospective (issue 313) or post-2026-10-07 data.",
        evaluator=dict(version="v2", digest=de.CODE_SHA, note="validate.day_boot, de_v2.supertrend (via nt12.frame) imported unchanged"),
        data="engine/cache M1 bid/ask via nt12.load_m1c (cut 2026-10-07T18:30 UTC); M5/M15 by bars.resample; mid = (bid+ask)/2",
        instruments=INSTS,
        windows=dict(dev="2018-01-01 .. 2022-12-31 (trading-day keys, validate.day_of 22:00 UTC rollover)",
                     w2023="2023-01-01 .. 2026-10-07 (development window, not a holdout)"),
        H1=dict(
            timeframes="M5 primary; M1 and M15 secondary (same rules in bars of that timeframe)",
            measures=f"at each closed bar t with bars t-{W}..t contiguous: ER = |c_t - c_(t-{W})| / sum_(i=t-{W - 1}..t) |c_i - c_(i-1)| (mid closes); "
                     f"wick share = mean over bars t-{W - 1}..t of (h - l - |c - o|) / (h - l) (bars with h = l skipped); "
                     f"range-to-spread = median(h - l) / median(ask_c - bid_c) over bars t-{W - 1}..t",
            buckets="quintiles per instrument x timeframe x measure; edges from dev-window bars only (np.quantile 0.2/0.4/0.6/0.8); bucket = "
                    "searchsorted(edges, x, right); the same edges apply to 2023+",
            atr="production supertrend ATR (flips.mjs, Wilder ATR(10)) at bar t; the request said ATR14 and named the production ATR; the "
                "production ATR is used",
            outcome=f"move = mid open of bar t+1+N minus mid open of bar t+1, N in {list(NS)}, bars t+1..t+1+N contiguous; a = |move| / ATR_t; "
                    f"clear move iff a >= {CLEAR}; no direction iff a < {NODIR}; continuation iff sign(move) = sign(c_t - c_(t-{W})) (both non-zero); "
                    "signed continuation = sign(c_t - c_(t-12)) x move / ATR_t",
            primary="WTICO/USD M5 N=6, three separate tests: P(clear) in the chop quintile minus P(clear) in the clean quintile; chop/clean = "
                    "ER lowest/highest, wick share highest/lowest, range-to-spread lowest/highest. Predicted < 0. A measure PASSES iff the 95% "
                    "day-block CI upper bound < 0 in BOTH dev and 2023+. Each measure has its own verdict; no pooling across measures.",
            secondary="P(no direction) chop minus clean (predicted > 0), mean |move|/ATR, continuation rate and mean signed continuation per "
                      "quintile (does chop predict a reversal (P(cont) < 0.5, signed < 0) or only a lack of continuation); all instruments, "
                      "M1, M15, N=3 and 12 descriptive."),
        H2=dict(
            timeframe="M5 only",
            session="trading day = validate.day_of (22:00 UTC rollover), Mon-Fri keys; day open = mid open of its first bar; session end = "
                    "mid close of its last bar in the data",
            daily_atr=f"DATR = mean of (max mid high - min mid low) over the previous {DATR_N} trading days that have >= 50% of their M5 bars "
                      "(strictly earlier days; no event without 14 such days)",
            leg=f"causal, fixed: up-leg_t = c_t - min(mid low over the last {K} bars of the same trading day, bars max(day start, t-{K - 1})..t); "
                f"down-leg_t = max(mid high over the same bars) - c_t",
            events=f"for each L in {list(LS)} and each direction separately: the first closed bar per trading day with leg >= L x DATR, "
                   "provided the next bar is in the same trading day. Leg size S = leg at that bar. Rough WTI scale: DATR ~ 2.5-3% of price, "
                   "so L = 0.3/0.6/1.0 is about 0.75%/1.5%/2.5%.",
            outcomes=f"from P0 = mid open of the next bar, on mid closes to the session end, rel = leg direction x (close - P0): "
                     f"race = 1 iff rel <= -{RACE} S comes before rel >= +{RACE} S (unresolved by session end -> excluded from the race); "
                     "counter = 1 iff the drawdown from the running extreme in the leg direction (starting at P0) reaches S before session end; "
                     f"sess = rel at the last close / DATR; h12/h48 = signed move to the mid open of bar entry + 12/48 (contiguous) / DATR; "
                     "fade_net (secondary) = opposite-side trade at bid/ask from the next bar open to the session-end close / DATR",
            null=f"per event, {NNULL} driftless paths of the same length from the event day's M5 mid-close increments (demeaned, resampled with "
                 "replacement): null P(race) among resolved paths and null P(counter); signed-move null = 0. race_d = race - null race "
                 "(resolved events), counter_d = counter - null counter",
            primary=f"WTICO/USD M5 L={L_PRIMARY}: (a) mean race_d 95% day-block CI lower bound > 0 in BOTH windows; (b) mean sess 95% CI upper "
                    "bound < 0 in BOTH windows. H2 PASS iff (a) and (b).",
            hindsight=f"separately labelled: the same statistics restricted to days with |day close / day open - 1| <= {HINDSIGHT} "
                      "(selects on the day end; descriptive only, never a test)"),
        bootstrap=f"moving-block day bootstrap (validate.day_boot, block {BLOCK}, {NBOOT} reps, seed {SEED}) over all trading days of the window",
        budget=dict(primary_tests="H1: 3 (one per measure); H2: 2 (a, b) combined into one verdict", tuned_hyperparameters=0,
                    fixed_constants=dict(W=W, NS=list(NS), CLEAR=CLEAR, NODIR=NODIR, K=K, LS=list(LS), L_PRIMARY=L_PRIMARY, DATR_N=DATR_N,
                                         RACE=RACE, HINDSIGHT=HINDSIGHT, HS=list(HS), NNULL=NNULL, NBOOT=NBOOT, BLOCK=BLOCK, SEED=SEED)),
        code_sha256=CODE,
        file_sha256={"legs27.py": CODE["legs27.py"], "nt12.py": CODE["nt12.py"], "validate.py": sha(os.path.join(ENG, "validate.py")),
                     "bars.py": sha(os.path.join(ENG, "bars.py")), "de_v2.py": sha(os.path.join(ENG, "de_v2.py")),
                     "flips.mjs": sha(os.path.join(ENG, "flips.mjs"))})
    json.dump(reg, open(f, "w"), indent=1)
    print("registered", reg["created"])


if __name__ == "__main__":
    MODE = sys.argv[1] if len(sys.argv) > 1 else ""
    if MODE == "check":
        check()
    elif MODE == "register":
        register()
    elif MODE == "amend":
        register(amend=sys.argv[2])
    elif MODE == "build":
        build(sys.argv[2], sys.argv[3])
    elif MODE == "run":
        run()
