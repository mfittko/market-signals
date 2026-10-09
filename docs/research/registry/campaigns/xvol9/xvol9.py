"""xvol9 (#310 campaign): do simultaneous cross-instrument activity bursts give an entry signal?

Evaluator v2 (labels_v2.simulate, fills, validate.day_boot) is imported, never edited. Bars come from prep.py
(de_v2.build on M1 bid/ask, read-only). Nothing is fitted: every threshold below is fixed in the prereg.

  python xvol9.py check      synthetic self-checks
  python xvol9.py register   write prereg.json (refuses to overwrite)
  python xvol9.py run        all K, hypotheses, managements, nulls -> out/results.json, out/report.txt
"""
import os, sys, json, time, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ENG)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import de_v2 as de  # noqa: E402
from labels_v2 import simulate, POLICY  # noqa: E402
from validate import day_boot, day_of, year_start_day  # noqa: E402

EXP = "xvol9"
INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "NATGAS/USD", "SPX500/USD", "EUR/USD", "USD/JPY", "BTC/USD"]
LEADERS = {"SPX500/USD": {"WTICO/USD": 1, "EUR/USD": 1, "USD/JPY": 1, "XAG/USD": 1},
           "XAU/USD": {"XAG/USD": 1, "EUR/USD": 1, "USD/JPY": -1}}
MED_DAYS, MED_MIN = 20, 10          # time-of-day median: prior 20 trading days, >= 10 observations
Q_DAYS, Q_MIN, Q = 20, 10, 95       # burst threshold: 95th pct of normalized activity, prior 20 trading days
K_MAIN, K_SENS = 3, (2, 4)
COOLDOWN = 60                       # minutes between burst events
LEAD_MOVE, LAG_STILL = 1.0, 0.5     # H2: leader |move| >= 1 ATR, laggard |move| < 0.5 ATR
MANAGE = {"M72": dict(POLICY), "M12": dict(POLICY, H=12)}
HYPS = ("H1", "H2", "H3")
NDRAW = 5
NBOOT = 3000
N_DECISION = len(HYPS) * len(MANAGE)  # Bonferroni family: 6 decision variants at K=3
MUE = 0.05
COST = 0.05
TAIL_MAX = 0.05                      # risk constraint: share of trades losing beyond 1.5 R
STUDY_MIN = (1, 5, 15, 30, 60)
WINDOWS = {"dev2018_22": ("2018-01-01", "2023-01-01"), "w2023": ("2023-01-01", "2100-01-01")}
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {f: sha(os.path.join(HERE, f)) for f in ("xvol9.py", "prep.py")}


# ------------------------------------------------------------------ pure helpers
def weekend(t):
    """Fri 21:00 UTC .. Sun 22:00 UTC (epoch day 0 is a Thursday)."""
    d = np.asarray(t) // 1440; m = np.asarray(t) % 1440; dow = (d + 3) % 7  # Mon=0
    return ((dow == 4) & (m >= 21 * 60)) | (dow == 5) | ((dow == 6) & (m < 22 * 60))


def norm_activity(t, vol):
    """vol / median(vol at the same UTC M5 slot over the prior MED_DAYS trading days); as-of (current day excluded)."""
    day = day_of(t); slot = (t % 1440) // 5
    P = pd.DataFrame({"d": day, "s": slot, "v": vol}).pivot_table(index="d", columns="s", values="v", aggfunc="first")
    med = P.rolling(MED_DAYS, min_periods=MED_MIN).median().shift(1)
    r = np.searchsorted(med.index.values, day); c = np.searchsorted(med.columns.values, slot)
    m = med.values[r, c]
    return vol / np.maximum(m, 1.0)  # nan while the median is not defined


def thresholds(day, a):
    """Per bar: Q-th percentile of normalized activity over the prior Q_DAYS trading days (rows sorted by time)."""
    ud, st = np.unique(day, return_index=True)
    st = np.r_[st, len(day)]
    thr_d = np.full(len(ud), np.nan)
    for k in range(len(ud)):
        lo = max(0, k - Q_DAYS)
        if k - lo < Q_MIN:
            continue
        v = a[st[lo]:st[k]]; v = v[np.isfinite(v)]
        if len(v):
            thr_d[k] = np.percentile(v, Q)
    return thr_d[np.searchsorted(ud, day)]


def cooldown(t, gap=COOLDOWN):
    keep, last = np.zeros(len(t), bool), -10 ** 12
    for k, x in enumerate(t):
        if x >= last + gap:
            keep[k] = True; last = x
    return keep


def confirm(I, b, s, kind):
    """Signal bar i = b + 1 (contiguous). ext: closes beyond the burst bar's extreme in direction s;
    mid: closes beyond the burst bar's midpoint in direction s. Returns (ok, i)."""
    n = len(I["t"]); i = np.minimum(b + 1, n - 1)
    ok = (b + 1 < n) & (I["t"][i] - I["t"][b] == 5)
    c, h, l = I["mid_c"][i], I["mid_h"][b], I["mid_l"][b]
    lvl = np.where(s > 0, h, l) if kind == "ext" else (h + l) / 2
    ok &= np.where(s > 0, c > lvl, c < lvl) & (s != 0)
    ok &= (I["spr"][i] <= de.SPR_MAX) & np.isfinite(I["atr"][i]) & (I["atr"][i] > 0)
    return ok, i


def mdd(x):
    cum = np.cumsum(x); peak = np.maximum.accumulate(np.r_[0.0, cum])[1:]
    return float(np.max(peak - cum)) if len(x) else 0.0


def check():
    t = np.array([0, 1, 2, 3]) * 1440 + 12 * 60  # epoch days 0..3 = Thu..Sun, noon
    assert list(weekend(t)) == [False, False, True, True]
    assert list(weekend(np.array([4 * 1440 + 21 * 60 + 55, 3 * 1440 + 22 * 60]))) == [False, False]  # Mon 21:55; Sun 22:00
    # normalization and thresholds are causal: changing the last day's volume leaves earlier bars unchanged
    rng = np.random.default_rng(0)
    days = 40; tt = np.concatenate([d * 1440 + np.arange(0, 1440, 5) for d in range(days)]) + 4 * 1440
    v = rng.poisson(50, len(tt)).astype(float)
    a1 = norm_activity(tt, v); q1 = thresholds(day_of(tt), a1)
    v2 = v.copy(); v2[day_of(tt) == day_of(tt[-1])] *= 10
    a2 = norm_activity(tt, v2); q2 = thresholds(day_of(tt), a2)
    pre = day_of(tt) < day_of(tt[-1])
    assert np.allclose(a1[pre], a2[pre], equal_nan=True) and np.allclose(q1, q2, equal_nan=True)
    assert np.isnan(a1[:288 * MED_MIN]).all() and np.isfinite(a1[-1])
    assert abs(np.nanmedian(a1[288 * MED_MIN:]) - 1) < 0.05 and 1.1 < np.nanmedian(q1) < 1.4
    assert list(cooldown(np.array([0, 5, 55, 60, 65, 130]))) == [True, False, False, True, False, True]
    # confirmation: up burst bar h=11 l=9; next closes 11.5 (ext ok), 10.5 (mid ok, ext no), non-contiguous bar fails
    I = {"t": np.array([0, 5, 10, 20]), "mid_c": np.array([10, 11.5, 10.5, 12.0]), "mid_h": np.array([11, 12, 11, 12.0]),
         "mid_l": np.array([9, 10, 10, 11.0]), "spr": np.zeros(4), "atr": np.ones(4)}
    ok, i = confirm(I, np.array([0, 0, 0]), np.array([1, -1, 0]), "ext")
    assert list(ok) == [True, False, False] and i[0] == 1
    ok, _ = confirm(I, np.array([0, 0]), np.array([1, -1]), "mid"); assert list(ok) == [True, False]
    ok, _ = confirm(I, np.array([2]), np.array([1]), "ext"); assert not ok[0]
    assert mdd(np.array([1, -2, 1, -1, 3.0])) == 2.0
    print("xvol9 self-check OK: weekend mask, causal normalization/threshold, cooldown, confirmation, drawdown")


# ------------------------------------------------------------------ data
def load():
    D = {}
    for inst in INSTS:
        z = np.load(os.path.join(HERE, "cache", inst.replace("/", "_") + ".npz"))
        I = {k: z[k] for k in z.files}
        we = weekend(I["t"])
        a = np.full(len(I["t"]), np.nan)
        a[~we] = norm_activity(I["t"][~we], I["volume"][~we])
        thr = np.full(len(I["t"]), np.nan)
        thr[~we] = thresholds(I["day"][~we], a[~we])
        I["a"], I["thr"], I["we"] = a, thr, we
        I["above"] = (a > thr) & ~we
        I["valid"] = np.isfinite(a) & np.isfinite(thr) & ~we
        prev = np.r_[0, np.arange(len(I["t"]) - 1)]
        with np.errstate(invalid="ignore", divide="ignore"):
            I["move"] = (I["mid_c"] - I["mid_c"][prev]) / I["atr"][prev]
        I["move"][0] = np.nan
        D[inst] = I
    return D


def grid(D):
    T = np.unique(np.concatenate([I["t"][I["valid"]] for I in D.values()]))
    G = {"t": T}
    for inst, I in D.items():
        p = np.searchsorted(I["t"], T); pc = np.minimum(p, len(I["t"]) - 1)
        has = (I["t"][pc] == T) & I["valid"][pc]
        G[inst] = dict(idx=np.where(has, pc, -1), above=has & I["above"][pc],
                       move=np.where(has, I["move"][pc], np.nan))
    G["count"] = np.sum([G[i]["above"] for i in INSTS], 0)
    G["present"] = np.sum([G[i]["idx"] >= 0 for i in INSTS], 0)
    return G


# ------------------------------------------------------------------ candidates: (inst, burst bar b, side, kind, t, tag)
def cand(rows):
    if not rows:
        return dict(inst=np.array([], object), b=np.array([], int), s=np.array([], int), kind=np.array([], object),
                    t=np.array([], int), ev=np.array([], int))
    r = list(zip(*rows))
    return dict(inst=np.array(r[0], object), b=np.array(r[1], int), s=np.array(r[2], int), kind=np.array(r[3], object),
                t=np.array(r[4], int), ev=np.array(r[5], int))


def h1h3(G, ev, kind, sign):
    rows = []
    for e in ev:
        best, bm = None, 0.0
        for inst in INSTS:
            m = G[inst]["move"][e]
            if G[inst]["above"][e] and np.isfinite(m) and abs(m) > bm:
                best, bm = inst, abs(m)
        if best:
            rows.append((best, G[best]["idx"][e], sign * int(np.sign(G[best]["move"][e])), kind, G["t"][e], e))
    return cand(rows)


def h2(G, ev):
    rows = []
    for e in ev:
        want = {}
        for L, mp in LEADERS.items():
            m = G[L]["move"][e]
            if G[L]["above"][e] and np.isfinite(m) and abs(m) >= LEAD_MOVE:
                for lag, sg in mp.items():
                    want.setdefault(lag, set()).add(int(np.sign(m)) * sg)
        for lag, sides in want.items():
            m = G[lag]["move"][e]
            if len(sides) == 1 and G[lag]["idx"][e] >= 0 and np.isfinite(m) and abs(m) < LAG_STILL:
                rows.append((lag, G[lag]["idx"][e], sides.pop(), "ext", G["t"][e], e))
    return cand(rows)


def events(G, k):
    e = np.where(G["count"] >= k)[0]
    return e[cooldown(G["t"][e])]


def single_events(G):
    """Bars where exactly one instrument is above its threshold; 60-minute cooldown per instrument."""
    out = {}
    for inst in INSTS:
        e = np.where((G["count"] == 1) & G[inst]["above"])[0]
        out[inst] = e[cooldown(G["t"][e])]
    return out


# ------------------------------------------------------------------ trades
def trades(D, C, P):
    """Confirm and simulate each candidate (matched-entry: overlapping trades allowed). Returns per-candidate arrays."""
    n = len(C["b"]); net = np.full(n, np.nan); ok = np.zeros(n, bool); sig = np.full(n, -1); xb = np.full(n, -1)
    for inst in INSTS:
        for kind in ("ext", "mid"):
            m = np.where((C["inst"] == inst) & (C["kind"] == kind))[0]
            if not len(m):
                continue
            I = D[inst]
            c, i = confirm(I, C["b"][m], C["s"][m], kind)
            mm, ii = m[c], i[c]
            if not len(mm):
                continue
            S = simulate(I, ii, C["s"][mm], I["atr"][ii], I["flip"], P)
            net[mm] = S["net_R"]; ok[mm] = S["ok"]; sig[mm] = ii; xb[mm] = S["exit_bar"]
    return dict(net=net, ok=ok, sig=sig, exit_bar=xb, t=C["t"], day=day_of(C["t"]), hour=(C["t"] % 1440) // 60)


def random_side(C, rng):
    out = [dict(C, s=rng.choice([-1, 1], len(C["b"]))) for _ in range(NDRAW)]
    return {k: np.concatenate([o[k] for o in out]) for k in C}


def random_time(D, C, kind_side, rng, lo_day, hi_day):
    """Same instrument and UTC M5 slot on a random other trading day of the same window; side from that bar's move
    (H1/H3: sign x kind_side) or the hypothesis side (H2: kind_side None)."""
    rows = []
    for k in range(len(C["b"])):
        I = D[C["inst"][k]]
        d0 = day_of(C["t"][k])
        for dd in rng.integers(lo_day, hi_day, NDRAW):
            tt = C["t"][k] + (dd - d0) * 1440
            p = np.searchsorted(I["t"], tt)
            if dd == d0 or p >= len(I["t"]) or I["t"][p] != tt or not I["valid"][p] or not np.isfinite(I["move"][p]):
                continue
            s = C["s"][k] if kind_side is None else kind_side * int(np.sign(I["move"][p]))
            rows.append((C["inst"][k], p, s, C["kind"][k], tt, -1))
    return cand(rows)


def matched_single(D, G, SE, C_hyp, R_hyp, kind, sign, rng, hyp, P):
    """N1: single-instrument bursts. H1/H3: the traded instrument bursting alone, side from its own move.
    H2: a leader bursting alone with the large move, same laggard map/condition. Matched by (instrument, UTC hour):
    NDRAW confirmed null trades per confirmed hypothesis trade, drawn from the same cell."""
    if hyp == "H2":
        rows = []
        for L in LEADERS:
            for e in SE[L]:
                C1 = h2_single(G, e, L)
                rows += C1
        C = cand(rows)
    else:
        rows = [(inst, G[inst]["idx"][e], sign * int(np.sign(G[inst]["move"][e])), kind, G["t"][e], e)
                for inst in INSTS for e in SE[inst] if np.isfinite(G[inst]["move"][e])]
        C = cand(rows)
    R = trades(D, C, P)
    pool = np.where(R["ok"])[0]
    keyp = {}
    for j in pool:
        keyp.setdefault((C["inst"][j], R["hour"][j]), []).append(j)
    pick, unmatched = [], 0
    for j in np.where(R_hyp["ok"])[0]:
        cell = keyp.get((C_hyp["inst"][j], R_hyp["hour"][j]))
        if not cell:
            unmatched += 1; continue
        pick += list(rng.choice(cell, NDRAW))
    pick = np.array(pick, int)
    return {k: v[pick] for k, v in R.items()}, unmatched, int(len(pool))


def h2_single(G, e, L):
    m = G[L]["move"][e]
    if not (np.isfinite(m) and abs(m) >= LEAD_MOVE):
        return []
    out = []
    for lag, sg in LEADERS[L].items():
        lm = G[lag]["move"][e]
        if G[lag]["idx"][e] >= 0 and np.isfinite(lm) and abs(lm) < LAG_STILL:
            out.append((lag, G[lag]["idx"][e], int(np.sign(m)) * sg, "ext", G["t"][e], e))
    return out


# ------------------------------------------------------------------ statistics
def boot_ci(x, day, all_days, alpha):
    q = (100 * alpha / 2, 100 * (1 - alpha / 2))
    bs = day_boot(day, all_days, lambda ix: x[ix].mean(), NBOOT)
    return [float(np.percentile(bs, q[0])), float(np.percentile(bs, q[1]))], float(np.std(bs))


def diff_ci(xa, da, xb, db, all_days, alpha):
    x = np.r_[xa, xb]; f = np.r_[np.ones(len(xa), bool), np.zeros(len(xb), bool)]; d = np.r_[da, db]

    def st(ix):
        g = f[ix]
        return x[ix][g].mean() - x[ix][~g].mean() if g.any() and (~g).any() else np.nan
    bs = day_boot(d, all_days, st, NBOOT); bs = bs[np.isfinite(bs)]
    q = (100 * alpha / 2, 100 * (1 - alpha / 2))
    return [float(xa.mean() - xb.mean()), float(np.percentile(bs, q[0])), float(np.percentile(bs, q[1]))]


def summarize(R, all_days):
    ok = R["ok"]; x = R["net"][ok]; d = R["day"][ok]
    if len(x) < 5:
        return dict(n_trades=int(len(x)), meanR=float(x.mean()) if len(x) else None)
    order = np.argsort(R["t"][ok], kind="stable")
    ci95, se = boot_ci(x, d, all_days, 0.05)
    ciB, _ = boot_ci(x, d, all_days, 0.05 / N_DECISION)
    return dict(n_trades=int(len(x)), trade_days=int(len(np.unique(d))), meanR=float(x.mean()), ci95=ci95, ci_bonf=ciB,
                se_boot=se, totalR=float(x.sum()), maxdd=mdd(x[order]), meanR_cost=float(x.mean() - COST),
                ci_bonf_cost=[ciB[0] - COST, ciB[1] - COST], loss_gt_1p5R=float((x < -1.5).mean()),
                win_rate=float((x > 0).mean()), mde80_bonf=float(3.48 * se), mde80=float(2.80 * se))


def disposition(s, diffs, s23):
    if s.get("ci_bonf") is None:
        return "inconclusive (support < 5 trades)"
    if s["ci_bonf"][1] < MUE or s["loss_gt_1p5R"] > TAIL_MAX:
        return "rejected"
    if (s["ci_bonf"][0] > MUE and all(v[1] > 0 for v in diffs.values() if v)
            and s23.get("meanR") is not None and s23["meanR"] > MUE):
        return "supported"
    return "inconclusive"


# ------------------------------------------------------------------ event study
def event_study(D, C, mask=None):
    """Mean signed ATR-normalized mid path after the burst bar close (M1 closes), side = candidate side."""
    out = {f"+{k}m": [] for k in STUDY_MIN}; out["burst_bar"] = []
    idx = np.arange(len(C["b"])) if mask is None else np.where(mask)[0]
    for j in idx:
        I = D[C["inst"][j]]; b = C["b"][j]; s = C["s"][j]
        if b < 1 or not np.isfinite(I["atr"][b - 1]) or I["atr"][b - 1] <= 0:
            continue
        a, c0 = I["atr"][b - 1], I["mid_c"][b]
        out["burst_bar"].append(s * I["move"][b])
        for k in STUDY_MIN:
            p = np.searchsorted(I["m1_t"], I["t"][b] + 5 + k - 1, side="right") - 1
            out[f"+{k}m"].append(s * (I["m1_c"][p] - c0) / a)
    res = {k: dict(mean=float(np.mean(v)), se=float(np.std(v) / np.sqrt(len(v)))) if v else None for k, v in out.items()}
    res["n"] = len(out["burst_bar"])
    return res


# ------------------------------------------------------------------ run
def wslice(C, lo, hi):
    m = (C["t"] >= lo) & (C["t"] < hi)
    return {k: v[m] for k, v in C.items()}


def run():
    t0 = time.time()
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    assert reg["code_sha256"]["xvol9.py"] == CODE["xvol9.py"], "xvol9.py changed after registration (amend first)"
    assert reg["code_sha256"]["evaluator"] == de.CODE_SHA
    D = load(); G = grid(D)
    print("loaded", round(time.time() - t0), "s", flush=True)
    SE = single_events(G)
    res = dict(evaluator=de.CODE_SHA, xvol9=CODE["xvol9.py"], coverage={}, K={}, note="development evidence only")
    for inst, I in D.items():
        res["coverage"][inst] = dict(m1_first=str(I["m1_first"]), m1_last=str(I["m1_last"]), m1_rows=int(I["m1_rows"]),
                                     m5_bars=int(len(I["t"])), valid_bars=int(I["valid"].sum()),
                                     above_share=float(I["above"].sum() / max(1, I["valid"].sum())))
    res["single_events"] = {i: int(len(e)) for i, e in SE.items()}
    res["present_mean"] = float(G["present"].mean())
    for K in (K_MAIN,) + K_SENS:
        ev = events(G, K)
        CH = {"H1": h1h3(G, ev, "ext", 1), "H2": h2(G, ev), "H3": h1h3(G, ev, "mid", -1)}
        RK = res["K"][str(K)] = dict(events=int(len(ev)), by_year={}, lead_by_inst={}, hyp={})
        yrs = G["t"][ev].astype("datetime64[m]").astype("datetime64[Y]").astype(int) + 1970
        RK["by_year"] = {str(y): int((yrs == y).sum()) for y in np.unique(yrs)}
        RK["lead_by_inst"] = {i: int((CH["H1"]["inst"] == i).sum()) for i in INSTS}
        RK["event_days"] = int(len(np.unique(day_of(G["t"][ev]))))
        RK["participants_mean"] = float(G["count"][ev].mean())
        for wn, (a, b) in WINDOWS.items():
            lo, hi = np.datetime64(a, "m").astype(np.int64), np.datetime64(b, "m").astype(np.int64)
            lo_d, hi_d = int(day_of(lo)), int(min(day_of(hi), day_of(G["t"][-1]) + 1))
            all_days = np.arange(max(lo_d, int(day_of(G["t"][0]))), hi_d)
            for hyp in HYPS:
                C = wslice(CH[hyp], lo, hi)
                kind, sign = ("ext", 1) if hyp != "H3" else ("mid", -1)
                RH = RK["hyp"].setdefault(hyp, {}).setdefault(wn, {})
                RH["candidates"] = int(len(C["b"]))
                RH["by_inst"] = {i: int((C["inst"] == i).sum()) for i in INSTS if (C["inst"] == i).any()}
                if K == K_MAIN:
                    RH["event_study_all"] = event_study(D, C)
                for mn, P in MANAGE.items():
                    rng = np.random.default_rng(910 + K)
                    R = trades(D, C, P)
                    s = summarize(R, all_days)
                    RH.setdefault("study_confirmed", event_study(D, C, R["sig"] >= 0)) if K == K_MAIN else None
                    o = dict(main=s, nulls={})
                    if True:  # nulls for every K
                        x, d = R["net"][R["ok"]], R["day"][R["ok"]]
                        Ns = random_side(C, rng); RN = trades(D, Ns, P)
                        Nt = random_time(D, C, None if hyp == "H2" else sign, rng, all_days[0], all_days[-1] + 1)
                        Nt = wslice(Nt, lo, hi); RT = trades(D, Nt, P)
                        N1, unm, pool = matched_single(D, G, {i: e[(G["t"][e] >= lo) & (G["t"][e] < hi)] for i, e in SE.items()},
                                                       C, R, kind, sign, rng, hyp, P)
                        alpha = 0.05 / N_DECISION
                        for nn, RR in (("N1_single", N1), ("N2_random_time", RT), ("N3_random_side", RN)):
                            okn = RR["ok"]
                            o["nulls"][nn] = dict(n=int(okn.sum()), meanR=float(RR["net"][okn].mean()) if okn.any() else None,
                                                  diff_bonf=diff_ci(x, d, RR["net"][okn], RR["day"][okn], all_days, alpha)
                                                  if okn.sum() >= 5 and len(x) >= 5 else None)
                        o["nulls"]["N1_single"].update(unmatched=unm, pool=pool)
                        o["nulls"]["N2_random_time"]["candidates"] = int(len(Nt["b"]))
                    RH[mn] = o
                    de.log_trial({"exp": EXP, "mode": "dev" if wn == "dev2018_22" else "devwindow2023", "K": K, "hyp": hyp,
                                  "manage": mn, "window": wn, "n": s["n_trades"], "meanR": s.get("meanR"),
                                  "decision_eligible": K == K_MAIN, "xvol9_sha256": CODE["xvol9.py"]})
                    print(K, wn, hyp, mn, s.get("n_trades"), round(s.get("meanR") or np.nan, 3),
                          {k: (v["diff_bonf"] or [None])[0] for k, v in o["nulls"].items()}, round(time.time() - t0), "s", flush=True)
        if K == K_MAIN:
            for hyp in HYPS:
                for mn in MANAGE:
                    dv, w3 = RK["hyp"][hyp]["dev2018_22"][mn], RK["hyp"][hyp]["w2023"][mn]
                    dv["disposition"] = disposition(dv["main"], {k: v["diff_bonf"] for k, v in dv["nulls"].items()}, w3["main"])
                    w3["disposition_devwindow"] = disposition(w3["main"], {k: v["diff_bonf"] for k, v in w3["nulls"].items()},
                                                              dv["main"])
    res["secs"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(HERE, "out", "results.json"), "w"), indent=1, default=float)


# ------------------------------------------------------------------ registration
def register():
    Pf = os.path.join(HERE, "prereg.json")
    assert not os.path.exists(Pf), "prereg.json exists"
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="xvol9: simultaneous cross-instrument activity bursts as an entry signal (#310 campaign, epic #307)",
        evaluator=dict(version="v2", digest=de.CODE_SHA, note="labels_v2.simulate, fills.resolve, validate.day_boot "
                       "imported unchanged"),
        before_registration="Coverage query only (M1 row counts per instrument/year; cov.py). No activity, burst or "
                            "outcome statistic was computed before this file.",
        instruments=INSTS,
        excluded={"NAS100/USD": "incomplete (backfill at 2020-03-19 at registration time)"},
        data="history.db candles_ba M1 bid/ask, read-only; volume = OANDA price-update count (activity proxy, not traded "
             "volume); M5 built from M1 (bars.resample via de_v2.build), production supertrend ATR/flip",
        weekend="bars Fri 21:00 UTC .. Sun 22:00 UTC are excluded from activity normalization, thresholds and burst "
                "detection for every instrument (BTC trades 24/7); trade management still runs through them",
        activity=f"a = tick count / median(tick count at the same UTC M5 slot over the prior {MED_DAYS} trading days of "
                 f"that instrument, >= {MED_MIN} obs, current day excluded; floor 1)",
        burst=f"instrument above = a > its {Q}th percentile of a over the prior {Q_DAYS} trading days (all non-weekend "
              f"bars, >= {Q_MIN} days). Burst bar = at least K instruments above in the same M5 bucket. K = {K_MAIN} "
              f"primary (decision-eligible); K = {K_SENS} sensitivity only. Cooldown: next event >= {COOLDOWN} min after "
              f"the previous event.",
        move="move = (mid close of burst bar - previous bar's mid close) / ATR of the previous bar; burst direction = sign",
        hypotheses=dict(
            H1="shock continuation: instrument with the largest |move| among instruments above threshold in the burst "
               "bar; side = its burst direction; confirmation 'ext': the next M5 bar (contiguous) closes beyond the "
               "burst bar's high (long) / low (short)",
            H2=f"lead-lag: leader in {list(LEADERS)} above threshold with |move| >= {LEAD_MOVE} ATR; laggard map "
               f"{LEADERS} (side = sign(leader move) x map sign); laggard |move| < {LAG_STILL} ATR in the burst bar; "
               "conflicting implied sides from both leaders -> skip; confirmation 'ext' on the laggard; one trade per "
               "qualifying laggard per event",
            H3="fade: same lead instrument as H1, side = opposite of its burst direction; confirmation 'mid': the next "
               "M5 bar closes beyond the burst bar's midpoint in the fade direction"),
        entry="signal bar = confirmation bar; entry at the next bar's open, long at the ask, short at the bid (labels_v2); "
              "spread at the signal bar <= 0.2 R (de_v2.SPR_MAX); R = 1.5 x ATR at the signal bar",
        management={"M72": "308 baseline: labels_v2 POLICY k=1.5, stop -1R, breakeven after +1R (one-bar latency), 3R "
                           "target, opposite supertrend flip exit, max 72 bars",
                    "M12": "same with a 12-bar time stop (H=12)"},
        accounting="matched-entry evaluation: every confirmed candidate is one trade; overlapping trades in one "
                   "instrument are allowed (diagnostic, not a capital replay); max drawdown over trades in entry order",
        variants=dict(decision=[f"{h}/{m}" for h in HYPS for m in MANAGE], count=N_DECISION,
                      sensitivity="the same 6 at K=2 and K=4 (reported, never decision-eligible)"),
        nulls=dict(
            N1_single=f"single-instrument bursts (exactly one instrument above; {COOLDOWN}-min cooldown per instrument). "
                      "H1/H3: that instrument, side from its own move, same confirmation; H2: a leader bursting alone "
                      f"with |move| >= {LEAD_MOVE}, same laggard rule. Matched: {NDRAW} null trades per hypothesis "
                      "trade drawn from the same (instrument, UTC hour) cell of the same window",
            N2_random_time=f"same instrument and UTC M5 slot on {NDRAW} random other trading days of the same window; "
                           "side from that bar's move (H1: same sign, H3: opposite) or the hypothesis side (H2); same "
                           "confirmation and management",
            N3_random_side=f"same candidates, side random (+/-1, {NDRAW} draws), confirmation in that side's direction"),
        windows=dict(dev2018_22="2018-01-01..2022-12-31 (first ~20 trading days lose to warm-up); nothing is fitted, "
                                "so no walk-forward is needed", w2023="2023-01-01..newest: DEVELOPMENT window, inspected "
                                "many times by earlier campaigns, never a holdout"),
        objective="net R per trade of the confirmed policy (bid/ask fills, management as declared)",
        mue=MUE,
        statistics=f"5-day moving-block bootstrap by trading day (validate.day_boot, {NBOOT} reps); Bonferroni over the "
                   f"{N_DECISION} decision variants (two-sided alpha 0.05/{N_DECISION}); paired differences vs each null "
                   "with a joint day-block bootstrap; cost sensitivity +0.05 R per trade",
        risk_constraint=f"share of trades losing beyond 1.5 R <= {TAIL_MAX}",
        decision_rule=dict(
            supported="dev window: Bonferroni CI lower bound of net R/trade > MUE, every null difference Bonferroni CI "
                      "lower bound > 0, risk constraint holds, AND 2023+ development-window point estimate > MUE",
            rejected="dev window: Bonferroni CI upper bound of net R/trade < MUE, or the risk constraint fails",
            inconclusive="anything else"),
        diagnostics=f"event study of mean signed ATR-normalized mid path at +{STUDY_MIN} minutes after the burst bar close "
                    "(lead instrument for H1/H3 orientation, laggards for H2), all events and confirmed only; events "
                    "per year and per instrument; distinct event days",
        rules="no test_ledger use; nothing marked qualified for production; development evidence only; trials logged "
              "to trials.jsonl with exp xvol9",
        code_sha256=dict(evaluator=de.CODE_SHA, evaluator_files=de.CODE_FILES_SHA, **CODE))
    json.dump(reg, open(Pf, "w"), indent=1)
    print("registered", reg["created"])


if __name__ == "__main__":
    {"check": check, "register": register, "run": run}[sys.argv[1]]()
