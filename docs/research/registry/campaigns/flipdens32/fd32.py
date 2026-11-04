"""flipdens32: does the number of supertrend flips in the hours BEFORE a flip (causal, rolling) predict whether that flip
trade pays off (gross)?

Reuses flipday30 unchanged: nt12.frame (production supertrend ATR 10), labels_v2.simulate POLICY, next-bar-open entry,
gross on mid bars (x_recompute.mid), net on bid/ask, flipday30 day table and valid-day rule, validate.day_boot block 5.
The flipday30 frames (out/b_*.pkl) hold only post-07:00 trades without timestamps, so the frames are rebuilt here with
the same functions; build() asserts that the post-07:00 subset equals the flipday30 trades exactly.

  python fd32.py check             synthetic self-checks
  python fd32.py register          prereg.json (refuses to overwrite)
  python fd32.py build INST TF     every flip trade + density features -> out/f_<TAG>_<TF>.pkl
  python fd32.py run               quintiles, bootstrap, Holm -> out/results.json
"""
import os, sys, json, time, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
AUD = os.path.dirname(HERE)
ENG = os.path.dirname(AUD)
OUT = os.path.join(HERE, "out")
FD30 = os.path.join(AUD, "flipday30")
os.makedirs(OUT, exist_ok=True)
for p in (ENG, FD30, os.path.join(AUD, "notrade12"), os.path.join(AUD, "xvol9"), os.path.join(AUD, "rescan26")):
    sys.path.insert(0, p)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import de_v2 as de  # noqa: E402
from labels_v2 import simulate, POLICY  # noqa: E402
from validate import day_boot, log_trial  # noqa: E402
import fd30  # noqa: E402

EXP = "flipdens32"
INSTS = fd30.INSTS
TFS = ["M5", "M15"]
G = {"M5": 5, "M15": 15}
TAG = fd30.TAG
sha = fd30.sha
HS = [1, 3, 6]               # look-back hours
MED_N = 20                   # normalizer: median of the previous 20 open occurrences of the same UTC hour slot
EDGE_DAYS = 250              # quintile edges: flips of the previous 250 valid trading days
NBOOT, BLOCK, SEED = 1000, 5, 32
ALPHA = 0.025                # one-sided, Holm over the three H values per window


# ------------------------------------------------------------------ pure helpers
def density(t, flip_t, tq, H):
    """Flips on bars that opened in [tq - 60H, tq): closed bars strictly before the bar that opens at tq."""
    F = np.sort(np.asarray(flip_t, np.int64)); tq = np.asarray(tq, np.int64)
    return np.searchsorted(F, tq, "left") - np.searchsorted(F, tq - 60 * H, "left")


def slot_median(t, flip_t, H):
    """Per open UTC hour (any bar opens in it): count in the H hours before the hour start; then, per hour-of-day slot,
    the median of that count over the previous MED_N open occurrences of the slot (current one excluded)."""
    U = np.unique(np.asarray(t, np.int64) // 60)
    ref = density(t, flip_t, U * 60, H)
    s = pd.Series(ref, index=U, dtype=float)
    med = s.groupby(U % 24).transform(lambda x: x.shift(1).rolling(MED_N, min_periods=MED_N).median())
    return med


def feature(t, flip_t, ti, H):
    """x = (count + 1) / (slot median + 1); NaN until the slot has MED_N earlier occurrences."""
    c = density(t, flip_t, ti, H)
    med = slot_median(t, flip_t, H)
    m = med.reindex(np.asarray(ti, np.int64) // 60).to_numpy()
    return c, (c + 1.0) / (m + 1.0)


def quintiles(day, x, vdays, by=None):
    """Causal quintile 0..4 per row. Edges = 20/40/60/80% quantiles of x over rows on the previous EDGE_DAYS valid days
    (strictly before the row's day); within the same `by` bucket if given. Ties at an edge go to the lower bin
    (searchsorted side left). NaN where fewer than EDGE_DAYS earlier valid days exist or no reference rows."""
    day = np.asarray(day); x = np.asarray(x, float); vdays = np.sort(np.asarray(vdays))
    q = np.full(len(day), np.nan)
    groups = [np.arange(len(day))] if by is None else [np.where(by == b)[0] for b in np.unique(by)]
    for ix in groups:
        ix = ix[np.isfinite(x[ix])]
        o = ix[np.argsort(day[ix], kind="stable")]
        d, v = day[o], x[o]
        for dd in np.unique(d):
            k = np.searchsorted(vdays, dd)
            if k < EDGE_DAYS:
                continue
            a, b = np.searchsorted(d, vdays[k - EDGE_DAYS], "left"), np.searchsorted(d, dd, "left")
            if b - a < 5:
                continue
            e = np.quantile(v[a:b], [0.2, 0.4, 0.6, 0.8])
            r = slice(np.searchsorted(d, dd, "left"), np.searchsorted(d, dd, "right"))
            q[o[r]] = np.searchsorted(e, v[r], side="left")
    return q


def holm(p):
    """Holm step-down adjusted p-values."""
    p = np.asarray(p, float); o = np.argsort(p); m = len(p)
    adj = np.maximum.accumulate(np.minimum(1, (m - np.arange(m)) * p[o]))
    out = np.empty(m); out[o] = adj
    return out


# ------------------------------------------------------------------ data
def build(inst, tf):
    import nt12 as N
    from x_recompute import mid
    m1, src = N.load_m1c(inst); H1 = N.h1(inst, m1)
    B = N.frame(inst, m1, tf, H1); Bm = mid(B)
    g = G[tf]
    C = fd30.features(fd30.day_counts(B["t"], B["flip"], g, B["day"]))
    i = np.where(B["flip"] != 0)[0]
    i = i[np.isfinite(B["atr"][i]) & (B["atr"][i] > 0)]
    s = B["flip"][i]
    sn = simulate(B, i, s, B["atr"][i], B["flip"], POLICY); sg = simulate(Bm, i, s, B["atr"][i], B["flip"], POLICY)
    ok = sn["ok"] & sg["ok"]
    i = i[ok]
    T = pd.DataFrame({"day": B["day"][i], "t": B["t"][i], "hod": (B["t"][i] // 60) % 24, "gross": sg["net_R"][ok],
                      "net": sn["net_R"][ok], "spr": B["spr"][i]})
    # parity with flipday30: post-07:00 subset must equal its trades
    f30 = os.path.join(FD30, "out", f"b_{TAG(inst)}_{tf}.pkl")
    if os.path.exists(f30):
        T30 = pd.read_pickle(f30)["T"]
        post = ((T["t"] + 120) % 1440 + g > fd30.DEC).to_numpy()
        P = T[post]
        assert len(P) == len(T30) and np.array_equal(P["day"].to_numpy(), T30["day"].to_numpy()) \
            and np.allclose(P["gross"].to_numpy(), T30["gross"].to_numpy()) and np.allclose(P["net"].to_numpy(), T30["net"].to_numpy()), "parity"
    ft = B["t"][B["flip"] != 0]
    for H in HS:
        T[f"c{H}"], T[f"x{H}"] = feature(B["t"], ft, T["t"].to_numpy(), H)
    pd.to_pickle(dict(C=C, T=T, src=src), os.path.join(OUT, f"f_{TAG(inst)}_{tf}.pkl"))
    print(inst, tf, len(C), int(C["valid"].sum()), len(T), "parity ok" if os.path.exists(f30) else "no f30", flush=True)


# ------------------------------------------------------------------ statistics
def stats(T, all_days, q):
    g = T["gross"].to_numpy(); n = T["net"].to_numpy(); d = T["day"].to_numpy()
    lo, hi = q == 0, q == 4
    def rep(m):
        return day_boot(d, all_days, lambda ix: g[ix][m[ix]].mean() - g[ix].mean() if m[ix].any() else np.nan,
                        reps=NBOOT, block=BLOCK, seed=SEED)
    def mci(v, m):
        r = day_boot(d, all_days, lambda ix: v[ix][m[ix]].mean() if m[ix].any() else np.nan, reps=NBOOT, block=BLOCK, seed=SEED)
        return [float(np.nanpercentile(r, 2.5)), float(np.nanpercentile(r, 97.5))]
    out = dict(all_n=int(len(g)), all_gross=float(g.mean()), all_net=float(n.mean()), days=int(len(np.unique(all_days))),
               n_by_q=[int((q == k).sum()) for k in range(5)],
               gross_by_q=[float(g[q == k].mean()) if (q == k).any() else None for k in range(5)],
               net_by_q=[float(n[q == k].mean()) if (q == k).any() else None for k in range(5)])
    for name, m, side in (("low", lo, 1), ("high", hi, -1)):
        r = rep(m); r = r[np.isfinite(r)]
        out[name] = dict(n=int(m.sum()), gross=float(g[m].mean()) if m.any() else None, gross_ci=mci(g, m),
                         net=float(n[m].mean()) if m.any() else None, net_ci=mci(n, m),
                         D=float(g[m].mean() - g.mean()) if m.any() else None,
                         D_ci=[float(np.percentile(r, 2.5)), float(np.percentile(r, 97.5))],
                         D_ci_bonf3=[float(np.percentile(r, 2.5 / 3)), float(np.percentile(r, 100 - 2.5 / 3))],
                         p_one=float((1 + (side * r <= 0).sum()) / (1 + len(r))), mde80=float(2.8 * r.std()))
    return out


def analyse(inst, tf, scheme):
    Z = pd.read_pickle(os.path.join(OUT, f"f_{TAG(inst)}_{tf}.pkl")); C, T = Z["C"], Z["T"]
    vdays = C.index[C["valid"]].to_numpy()
    T = T[T["day"].isin(vdays)].reset_index(drop=True)
    res = dict(inst=inst, tf=tf, scheme=scheme)
    for H in HS:
        q = quintiles(T["day"].to_numpy(), T[f"x{H}"].to_numpy(), vdays, by=T["hod"].to_numpy() if scheme == "tod" else None)
        for w in ("dev", "w2023"):
            m = (fd30.win_of(T["day"].to_numpy()) == w) & np.isfinite(q)
            if m.sum() < 100:
                res[f"H{H}|{w}"] = None; continue
            Tw = T[m].reset_index(drop=True)
            all_days = vdays[(fd30.win_of(vdays) == w) & (vdays >= Tw["day"].min())]
            r = stats(Tw, all_days, q[m])
            r["first_day"] = int(Tw["day"].min())
            r["raw_count_mean_by_q"] = [float(Tw[f"c{H}"][q[m] == k].mean()) if (q[m] == k).any() else None for k in range(5)]
            res[f"H{H}|{w}"] = r
    for w in ("dev", "w2023"):
        ks = [f"H{H}|{w}" for H in HS]
        if all(res[k] for k in ks):
            for side in ("low", "high"):
                for k, a in zip(ks, holm([res[k][side]["p_one"] for k in ks])):
                    res[k][side]["p_holm"] = float(a)
    return res


def verdict(R):
    for H in HS:
        a, b = R[f"H{H}|dev"], R[f"H{H}|w2023"]
        if a and b and all(x["low"]["p_holm"] < ALPHA and x["low"]["gross"] > 0 for x in (a, b)):
            return "PASS", H
    return "FAIL", None


def run():
    res = []
    for inst in INSTS:
        for tf in TFS:
            if not os.path.exists(os.path.join(OUT, f"f_{TAG(inst)}_{tf}.pkl")):
                continue
            for scheme in ("all", "tod"):
                R = analyse(inst, tf, scheme); res.append(R)
                prim = inst == "WTICO/USD" and tf == "M5" and scheme == "all"
                for H in HS:
                    log_trial(dict(exp=EXP, cell=f"{scheme}|{tf}|H{H}|low-all,high-all", unit=TAG(inst), primary=prim,
                                   dev=R[f"H{H}|dev"] and {k: R[f"H{H}|dev"][k] for k in ("low", "high", "all_n", "all_gross", "all_net")},
                                   w2023=R[f"H{H}|w2023"] and {k: R[f"H{H}|w2023"][k] for k in ("low", "high", "all_n", "all_gross", "all_net")}))
                print(inst, tf, scheme, flush=True)
    P = next(r for r in res if r["inst"] == "WTICO/USD" and r["tf"] == "M5" and r["scheme"] == "all")
    v, h = verdict(P)
    log_trial(dict(exp=EXP, cell="PRIMARY|all|M5|D_low Holm", unit="WTICO_USD", verdict=v, H=h))
    json.dump(dict(verdict=v, H=h, results=res), open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    print("VERDICT", v, h)


# ------------------------------------------------------------------ self-checks / registration
def check():
    # density: bars every 5 min, flips at minutes 0, 30, 55; query at 60 with H=1 -> 3; the flip bar itself excluded
    t = np.arange(0, 300, 5)
    ft = np.array([0, 30, 55, 60])
    assert density(t, ft, [60], 1)[0] == 3 and density(t, ft, [61], 1)[0] == 3 and density(t, ft, [120], 1)[0] == 1
    # slot median uses only earlier occurrences of the same hour slot
    t = np.arange(0, 1440 * 40, 60)                      # one bar per hour, 40 days
    ft = t[(t // 60) % 24 == 9]                          # one flip every day in hour 9
    med = slot_median(t, ft, 1)
    h10 = med[(med.index % 24) == 10]
    assert np.isnan(h10.iloc[MED_N - 1]) and h10.iloc[MED_N] == 1.0
    c, x = feature(t, ft, np.array([30 * 1440 + 600]), 1)
    assert c[0] == 1 and x[0] == 1.0
    # quintiles: causal (a future outlier day must not move earlier edges), ties go low
    rng = np.random.default_rng(0)
    day = np.repeat(np.arange(400), 10); x = rng.normal(size=4000)
    q = quintiles(day, x, np.arange(400))
    assert np.isnan(q[day < EDGE_DAYS]).all() and set(np.unique(q[day >= EDGE_DAYS])) == {0, 1, 2, 3, 4}
    x2 = x.copy(); x2[day == 399] = 1e9
    q2 = quintiles(day, x2, np.arange(400))
    assert np.array_equal(q[day < 399], q2[day < 399], equal_nan=True)
    share = np.bincount(q[day >= EDGE_DAYS].astype(int)) / (day >= EDGE_DAYS).sum()
    assert np.all(np.abs(share - 0.2) < 0.04), share
    qt = quintiles(day, np.zeros(4000), np.arange(400))
    assert (qt[day >= EDGE_DAYS] == 0).all()
    # holm
    assert np.allclose(holm([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06])
    # bootstrap stats: a planted low-density edge is found, a shuffled one is not
    n = 6000; day = np.repeat(np.arange(600), 10); q = rng.integers(0, 5, n)
    T = pd.DataFrame({"day": day, "gross": rng.normal(0, 1, n) + np.where(q == 0, 0.3, 0), "net": 0.0})
    r = stats(T, np.arange(600), q)
    assert r["low"]["p_one"] < 0.01 and r["low"]["D_ci"][0] > 0
    r = stats(T, np.arange(600), rng.permutation(q))
    assert r["low"]["p_one"] > 0.01
    print("check ok")


def register(amend=None):
    f = os.path.join(HERE, "prereg.json")
    code = {"fd32.py": sha(os.path.join(HERE, "fd32.py")), "fd30.py": sha(os.path.join(FD30, "fd30.py")),
            "nt12.py": sha(os.path.join(AUD, "notrade12", "nt12.py")),
            "x_recompute.py": sha(os.path.join(AUD, "rescan26", "x_recompute.py")), "evaluator": de.CODE_SHA}
    if amend:
        reg = json.load(open(f))
        reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=amend, code_sha256=code))
        json.dump(reg, open(f, "w"), indent=1); print("amended"); return
    assert not os.path.exists(f), "prereg.json exists (use amend)"
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="flipdens32: causal rolling flip density in the H hours before each supertrend flip; do low-density flips earn more (gross); issue 310",
        before_registration="Nothing computed on market data for this design before this file (synthetic self-checks only). Prior "
                            "knowledge: flipday30 (07:00 day-level prediction FAIL; HINDSIGHT realized few-flip days +0.20..+0.43 R gross, "
                            "many-flip days lose), notrade12, rescan26.",
        declared="Development evidence only. 2023+ is a development window, not a holdout. Binding confirmation is prospective (issue 313) "
                 "or post-2026-10-07 data.",
        evaluator=dict(version="v2", digest=de.CODE_SHA, code_sha256=code),
        data="engine/cache M1 bid/ask via nt12.load_m1c (cut 2026-10-07T18:30 UTC); M5/M15 by bars.resample; mid = (bid+ask)/2. "
             "Frames rebuilt with flipday30's functions (its pickles keep only post-07:00 trades without timestamps); build asserts "
             "the post-07:00 subset equals flipday30's trades exactly.",
        trade_rule="flipday30 trade unchanged, every flip at all hours: production supertrend (ATR 10) via nt12.frame; every flip bar with "
                   "finite ATR > 0; labels_v2.simulate POLICY k=1.5 m=1.0 T=3.0 H=72 (entry next bar open, stop 1 R, breakeven at +1 R, "
                   "target 3 R, exit at the next open after an opposite flip, time stop 72 bars). Gross on mid bars (primary); net on "
                   "bid/ask. Trades kept where both are uncensored. Only flips on flipday30 valid days.",
        day="flipday30: trading day = validate.day_of (22:00 UTC rollover); valid day = bar count >= 50% of the median per-day bar count "
            "and >= 1 bar closing after 07:00 UTC.",
        feature="For flip bar i opening at t_i: c_H = number of flip bars (flip != 0) that opened in [t_i - 60H min, t_i), i.e. closed bars "
                "strictly before bar i, H in {1, 3, 6} hours. NORMALIZED (chosen, used for every row): x_H = (c_H + 1) / (m_H + 1), "
                "where m_H = median over the previous 20 open occurrences of the same UTC clock hour as t_i (an hour is open if any bar "
                "opens in it; ~20 trading days) of the count of flips in the H hours before that hour's start; current occurrence "
                "excluded. Where fewer than 20 earlier occurrences exist, x_H is missing and the flip is not scored (falls inside the "
                "250-day quintile burn-in anyway). The raw count is not used as a fallback.",
        quintiles="For a flip on valid day d: edges = 20/40/60/80% quantiles of x_H over all scored flips on the previous 250 valid days "
                  "(strictly before d); quintile = searchsorted(edges, x_H, side='left') (0 = lowest density; a tie at an edge goes to the "
                  "lower bin, so the bin shares can deviate from 20%; counts are reported). Needs 250 earlier valid days (data start "
                  "2018 -> dev scoring starts in late 2018/2019).",
        windows=dict(dev="2018-01-01 .. 2022-12-31 (effective start after the burn-in)",
                     w2023="2023-01-01 .. 2026-10-07 (development window, not a holdout)"),
        primary="WTICO/USD M5, scheme 'all'. For each H: D_low = gross mean R of flips in the lowest-density quintile minus gross mean R of "
                "all scored flips, per window. Day-block bootstrap validate.day_boot over the window's valid days from the first scored "
                "day, block 5, 1000 reps, seed 32. One-sided p = (1 + #reps with D_low <= 0) / (1 + reps). Holm over the three H values "
                "per window.",
        pass_rule="PASS iff for at least one H, in BOTH dev and 2023+: Holm-adjusted one-sided p(D_low > 0) < 0.025 (equivalent to the "
                  "Holm-adjusted two-sided 95% CI excluding 0 upward) AND the lowest-quintile gross mean R > 0. Otherwise FAIL.",
        key_secondary="D_high = gross mean R of the highest-density quintile minus all, as a 'chop, skip this flip' veto candidate: point "
                      "estimate, 95% CI, Bonferroni-3 CI, one-sided p(D_high < 0) with Holm over H, both windows. Not part of the verdict.",
        secondary="net (bid/ask) per quintile and overall; trade counts and gross per quintile; the other five instruments; M15 (M1: no "
                  "flipday30 frames exist, not run); time-of-day confound check = the primary repeated with edges computed within UTC "
                  "hour-of-day buckets of the flip bar (scheme 'tod', same 250-day trailing rule); power MDE80 = 2.8 x bootstrap SD of D. "
                  "Descriptive, never decides the verdict.",
        bootstrap=dict(fn="validate.day_boot", reps=NBOOT, block=BLOCK, seed=SEED),
    )
    json.dump(reg, open(f, "w"), indent=1); print("registered", sha(f))


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
