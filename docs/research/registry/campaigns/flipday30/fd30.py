"""flipday30: can the number of supertrend flips per trading day be predicted at 07:00 UTC, and do flips traded on
predicted low-flip days earn more (gross) than all flips?

Trade rule reused unchanged: notrade12 / rescan26 flip population (nt12.frame -> de_v2.supertrend, production ATR 10;
labels_v2.simulate with POLICY; gross = the same trade on a mid copy of the bars, next-bar-open entry). A1 big-day
probability from lean21.alert_rows (abs11 walk-forward OOS, causal). Development evidence only.

  python fd30.py check             synthetic self-checks
  python fd30.py register          prereg.json (refuses to overwrite)
  python fd30.py a1 INST           A1 probability at 07:00 UTC per trading day -> out/a1_<TAG>.pkl
  python fd30.py build INST TF     day table + post-07:00 flip trades -> out/b_<TAG>_<TF>.pkl
  python fd30.py run               model, quintiles, bootstrap -> out/results.json, out/report.txt
"""
import os, sys, json, time, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
AUD = os.path.dirname(HERE)
ENG = os.path.dirname(AUD)
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
for p in (ENG, os.path.join(AUD, "notrade12"), os.path.join(AUD, "xvol9"), os.path.join(AUD, "rescan26")):
    sys.path.insert(0, p)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from scipy.stats import spearmanr  # noqa: E402
from sklearn.linear_model import PoissonRegressor  # noqa: E402
import de_v2 as de  # noqa: E402
from labels_v2 import simulate, POLICY  # noqa: E402
from validate import day_of, day_boot, year_start_day, log_trial  # noqa: E402

EXP = "flipday30"
INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "NATGAS/USD", "SPX500/USD", "EUR/USD"]
TFS = ["M5", "M15"]
G = {"M5": 5, "M15": 15}
TAG = lambda inst: inst.replace("/", "_")
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
DEC = 540                    # decision time: 07:00 UTC = 540 min after the 22:00 UTC session start
MED_N = 20                   # median flip count over the previous 20 valid days
MIN_TRAIN = 250              # valid days before the first prediction
EDGE_N = 250                 # quintile edges: fitted values of the last 250 training days
COVER = 0.5                  # valid day: bar count >= 50% of the median bar count of non-empty days
NBOOT, BLOCK, SEED = 1000, 5, 30
F0 = ["l_yday", "l_pre", "l_med20"]
F1 = F0 + ["a1_logit"]


# ------------------------------------------------------------------ pure helpers
def day_counts(t, flip, g, day):
    """Per trading day: full-day flip count, flips known by 07:00 (bar close <= 07:00), flips after, bar count."""
    tod = (np.asarray(t, np.int64) + 120) % 1440
    pre = (tod + g) <= DEC
    f = flip != 0
    df = pd.DataFrame({"day": day, "f": f, "pre": f & pre, "post": f & ~pre, "bars": 1, "bpost": ~pre})
    return df.groupby("day").sum()


def features(C):
    """C: day table (index = day, columns f, pre, post, bars, bpost). Adds valid, yday, med20 from earlier valid days."""
    C = C.copy()
    C["valid"] = (C["bars"] >= COVER * C["bars"].median()) & (C["bpost"] > 0)
    V = C[C["valid"]]
    yday = V["f"].shift(1)
    med = V["f"].shift(1).rolling(MED_N, min_periods=MED_N).median()
    C["yday"] = yday.reindex(C.index); C["med20"] = med.reindex(C.index)
    C["l_yday"] = np.log1p(C["yday"]); C["l_pre"] = np.log1p(C["pre"]); C["l_med20"] = np.log1p(C["med20"])
    return C


def months(days):
    """Refit points: first day key of each calendar month present in `days`."""
    d = np.asarray(days)
    ym = pd.to_datetime((d * 1440 - 120 + 1440) * 60, unit="s").to_period("M")   # calendar date of the session's 22:00+2h
    first = pd.Series(d).groupby(np.asarray(ym)).min()
    return np.sort(first.to_numpy())


def walk(C, cols):
    """Monthly expanding Poisson GLM on strictly earlier valid days. Returns pred and causal quintile (0..4) per day."""
    D = C[C["valid"]].dropna(subset=cols + ["post"])
    days = D.index.to_numpy(); X = D[cols].to_numpy(float); y = D["post"].to_numpy(float)
    pred = pd.Series(np.nan, index=C.index); q = pd.Series(np.nan, index=C.index)
    rp = months(days)
    for k, r in enumerate(rp):
        tr = days < r
        if tr.sum() < MIN_TRAIN:
            continue
        hi = rp[k + 1] if k + 1 < len(rp) else days.max() + 1
        te = (days >= r) & (days < hi)
        if not te.any():
            continue
        M = PoissonRegressor(alpha=0.0, max_iter=1000).fit(X[tr], y[tr])
        edges = np.quantile(M.predict(X[tr][-EDGE_N:]), [0.2, 0.4, 0.6, 0.8])
        p = M.predict(X[te])
        pred[days[te]] = p; q[days[te]] = np.searchsorted(edges, p, side="right")
    return pred, q


def win_of(day):
    day = np.asarray(day)
    return np.where(day >= year_start_day(2023), "w2023", np.where(day >= year_start_day(2018), "dev", None))


# ------------------------------------------------------------------ data
def a1(inst):
    """abs11 A1 P(big day) at the latest 30-min close <= 07:00 UTC of the same session (state 2 = already big -> 1.0)."""
    sys.path[:0] = [os.path.join(AUD, "lean21"), os.path.join(AUD, "abs11"), os.path.join(AUD, "pprofit20")]
    import lean21 as L
    AR = L.alert_rows(inst)
    tc = np.asarray(AR["tc"], np.int64); day = np.asarray(AR["day"], np.int64)
    ok = (tc - (day * 1440 - 120) <= DEC) & (AR["state"] >= 1)
    df = pd.DataFrame({"day": day[ok], "tc": tc[ok], "P": np.where(AR["state"][ok] == 2, 1.0, AR["P"][ok])})
    s = df.sort_values("tc").groupby("day")["P"].last()
    s.to_pickle(os.path.join(OUT, f"a1_{TAG(inst)}.pkl")); print(inst, len(s), flush=True)


def build(inst, tf):
    import nt12 as N
    from x_recompute import mid
    m1, src = N.load_m1c(inst); H1 = N.h1(inst, m1)
    B = N.frame(inst, m1, tf, H1); Bm = mid(B)
    g = G[tf]
    C = features(day_counts(B["t"], B["flip"], g, B["day"]))
    fa = os.path.join(OUT, f"a1_{TAG(inst)}.pkl")
    a = pd.read_pickle(fa) if os.path.exists(fa) else pd.Series(dtype=float)
    C["a1"] = a.reindex(C.index)
    C["a1_logit"] = np.log(np.clip(C["a1"], 1e-4, 1 - 1e-4) / (1 - np.clip(C["a1"], 1e-4, 1 - 1e-4)))
    tod = (B["t"] + 120) % 1440
    i = np.where((B["flip"] != 0) & (tod + g > DEC))[0]
    i = i[np.isfinite(B["atr"][i]) & (B["atr"][i] > 0)]
    s = B["flip"][i]
    sn = simulate(B, i, s, B["atr"][i], B["flip"], POLICY); sg = simulate(Bm, i, s, B["atr"][i], B["flip"], POLICY)
    ok = sn["ok"] & sg["ok"]
    T = pd.DataFrame({"day": B["day"][i][ok], "gross": sg["net_R"][ok], "net": sn["net_R"][ok], "spr": B["spr"][i][ok]})
    pd.to_pickle(dict(C=C, T=T, src=src), os.path.join(OUT, f"b_{TAG(inst)}_{tf}.pkl"))
    print(inst, tf, len(C), int(C["valid"].sum()), len(T), flush=True)


# ------------------------------------------------------------------ statistics
def boot(day, all_days, fn):
    r = day_boot(day, all_days, fn, reps=NBOOT, block=BLOCK, seed=SEED)
    return [float(np.nanpercentile(r, 2.5)), float(np.nanpercentile(r, 97.5)), float(np.nanstd(r))]


def cell(T, all_days, mask):
    """gross mean R of flips with mask, minus gross mean of all flips; plus the mask-only mean and net."""
    g = T["gross"].to_numpy(); n = T["net"].to_numpy(); m = mask
    d = T["day"].to_numpy()
    diff = lambda ix: g[ix][m[ix]].mean() - g[ix].mean() if m[ix].any() else np.nan
    mean = lambda ix: g[ix][m[ix]].mean() if m[ix].any() else np.nan
    nmean = lambda ix: n[ix][m[ix]].mean() if m[ix].any() else np.nan
    cd, cm, cn = boot(d, all_days, diff), boot(d, all_days, mean), boot(d, all_days, nmean)
    return dict(n=int(m.sum()), days=int(len(np.unique(d[m]))), gross=float(g[m].mean()) if m.any() else None, gross_ci=cm[:2],
                diff=float(g[m].mean() - g.mean()) if m.any() else None, diff_ci=cd[:2], mde80_diff=2.8 * cd[2],
                net=float(n[m].mean()) if m.any() else None, net_ci=cn[:2], all_gross=float(g.mean()), all_n=int(len(g)))


def analyse(inst, tf, model="M0"):
    Z = pd.read_pickle(os.path.join(OUT, f"b_{TAG(inst)}_{tf}.pkl")); C, T = Z["C"], Z["T"]
    cols = F0 if model == "M0" else F1
    C["pred"], C["q"] = walk(C, cols)
    sc = C[C["valid"] & C["q"].notna()]
    out = dict(inst=inst, tf=tf, model=model)
    for w in ("dev", "w2023"):
        S = sc[win_of(sc.index.to_numpy()) == w]
        if len(S) < 30:
            out[w] = None; continue
        r = dict(days=len(S), first_day=int(S.index.min()),
                 rho_pred=float(spearmanr(S["pred"], S["post"])[0]),
                 rho_yday=float(spearmanr(S["yday"], S["post"])[0]), rho_pre=float(spearmanr(S["pre"], S["post"])[0]),
                 rho_med20=float(spearmanr(S["med20"], S["post"])[0]),
                 post_by_q=[float(S["post"][S["q"] == k].mean()) for k in range(5)],
                 days_by_q=[int((S["q"] == k).sum()) for k in range(5)])
        Tw = T[T["day"].isin(S.index)].reset_index(drop=True)
        qd = Tw["day"].map(S["q"]).to_numpy()
        all_days = S.index.to_numpy()
        r["trades_per_day"] = float(len(Tw) / len(S))
        r["Q1"] = cell(Tw, all_days, qd == 0)
        r["Q5"] = cell(Tw, all_days, qd == 4)
        r["gross_by_q"] = [float(Tw["gross"][qd == k].mean()) if (qd == k).any() else None for k in range(5)]
        r["net_by_q"] = [float(Tw["net"][qd == k].mean()) if (qd == k).any() else None for k in range(5)]
        r["all_net"] = float(Tw["net"].mean())
        # HINDSIGHT: realized post-07:00 flip-count quintile (edges from this window's own days)
        e = np.quantile(S["post"], [0.2, 0.4, 0.6, 0.8])
        hq = np.searchsorted(e, Tw["day"].map(S["post"]).to_numpy(), side="right")
        r["HINDSIGHT_gross_by_realized_q"] = [float(Tw["gross"][hq == k].mean()) if (hq == k).any() else None for k in range(5)]
        r["HINDSIGHT_n_by_realized_q"] = [int((hq == k).sum()) for k in range(5)]
        out[w] = r
    return out


def verdict(R):
    ok = True
    for w in ("dev", "w2023"):
        c = R[w]["Q1"]
        ok &= c["diff_ci"][0] > 0 and c["gross"] > 0 and c["gross_ci"][0] > 0
    return "PASS" if ok else "FAIL"


def run():
    res = []
    for inst in INSTS:
        for tf in TFS:
            for model in ("M0", "M1"):
                if model == "M1" and not os.path.exists(os.path.join(OUT, f"a1_{TAG(inst)}.pkl")):
                    continue
                R = analyse(inst, tf, model)
                res.append(R)
                log_trial(dict(exp=EXP, cell=f"{model}|{tf}|Q1-all", unit=TAG(inst),
                               primary=(inst == "WTICO/USD" and tf == "M5" and model == "M0"),
                               dev=R["dev"] and R["dev"]["Q1"], w2023=R["w2023"] and R["w2023"]["Q1"]))
                print(inst, tf, model, flush=True)
    P = next(r for r in res if r["inst"] == "WTICO/USD" and r["tf"] == "M5" and r["model"] == "M0")
    v = verdict(P)
    log_trial(dict(exp=EXP, cell="PRIMARY|M0|M5|Q1-all", unit="WTICO_USD", verdict=v))
    json.dump(dict(verdict=v, results=res), open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    print("VERDICT", v)


# ------------------------------------------------------------------ self-checks / registration
def check():
    # day 100 starts at t = 100*1440-120; M5 bars: one flip at 06:50 (close 06:55, pre), one at 06:55 (close 07:00, pre),
    # one at 07:00 (close 07:05, post)
    t0 = 100 * 1440 - 120
    t = t0 + np.arange(0, 1440, 5)
    flip = np.zeros(len(t), int)
    for hhmm, s in ((6 * 60 + 50, 1), (6 * 60 + 55, -1), (7 * 60, 1)):
        flip[(t - t0) == hhmm + 120] = s
    C = day_counts(t, flip, 5, day_of(t))
    assert C.loc[100, "f"] == 3 and C.loc[100, "pre"] == 2 and C.loc[100, "post"] == 1, C
    # features use strictly earlier valid days
    C = pd.DataFrame({"f": np.arange(30), "pre": 0, "post": 0, "bars": 288, "bpost": 1}, index=np.arange(30))
    C.loc[5, "bars"] = 10
    F = features(C)
    assert not F.loc[5, "valid"] and F.loc[6, "yday"] == 4 and F.loc[4, "yday"] == 3
    assert np.isnan(F.loc[20, "med20"]) and F.loc[21, "med20"] == np.median([x for x in range(21) if x != 5])
    # walk: predictions only after MIN_TRAIN days, never using the predicted day
    rng = np.random.default_rng(0)
    n = 700; d = np.arange(n) + 6000
    lam = rng.uniform(2, 20, n)
    C = pd.DataFrame({"valid": True, "post": rng.poisson(lam), "l_yday": np.log1p(lam), "l_pre": 0.0, "l_med20": 0.0}, index=d)
    pred, q = walk(C, F0)
    first = pred.first_valid_index()
    assert (pred.index < first).sum() >= MIN_TRAIN and spearmanr(pred.dropna(), C["post"][pred.notna()])[0] > 0.5
    assert set(q.dropna().unique()) <= {0, 1, 2, 3, 4}
    # mutation: shuffling the outcome must destroy the rank correlation
    C2 = C.copy(); C2["post"] = rng.permutation(C2["post"].to_numpy())
    p2, _ = walk(C2, F0)
    assert abs(spearmanr(p2.dropna(), C2["post"][p2.notna()])[0]) < 0.15
    print("check ok")


def register(amend=None):
    f = os.path.join(HERE, "prereg.json")
    code = {"fd30.py": sha(os.path.join(HERE, "fd30.py")), "nt12.py": sha(os.path.join(AUD, "notrade12", "nt12.py")),
            "x_recompute.py": sha(os.path.join(AUD, "rescan26", "x_recompute.py")), "evaluator": de.CODE_SHA}
    if amend:
        reg = json.load(open(f))
        reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=amend, code_sha256=code))
        json.dump(reg, open(f, "w"), indent=1); print("amended"); return
    assert not os.path.exists(f), "prereg.json exists (use amend)"
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="flipday30: predicted flips per day at 07:00 UTC; do flips on predicted low-flip days earn more (gross); issue 310",
        before_registration="Nothing computed on market data before this file (synthetic self-checks only). Prior knowledge: notrade12 "
                            "flip population (all flips about -0.1 R net), rescan26 gross re-scoring, wave23 (flips on A1-armed days, rejected), "
                            "daytype14 (trend/range day classifier, rejected).",
        declared="Development evidence only. 2023+ is a development window, not a holdout. Binding confirmation is prospective (issue 313) "
                 "or post-2026-10-07 data.",
        evaluator=dict(version="v2", digest=de.CODE_SHA, code_sha256=code),
        data="engine/cache M1 bid/ask via nt12.load_m1c (cut 2026-10-07T18:30 UTC); M5/M15 by bars.resample; mid = (bid+ask)/2",
        trade_rule="unchanged notrade12/rescan26 flip trade: production supertrend (de_v2.supertrend = flips.mjs, ATR 10) via nt12.frame; "
                   "every flip bar with finite ATR; labels_v2.simulate POLICY k=1.5 m=1.0 T=3.0 H=72 (entry next bar open, stop 1 R, "
                   "breakeven at +1 R, target 3 R, exit at the next open after an opposite flip, time stop 72 bars). Gross = the same "
                   "trade on mid bars (x_recompute.mid); net = bid/ask. Trades kept where both are uncensored.",
        instruments=INSTS, timeframes="M5 primary, M15 secondary",
        day="trading day = validate.day_of (22:00 UTC rollover). Valid day: bar count >= 50% of the median per-day bar count of this "
            "instrument/timeframe and >= 1 bar closing after 07:00 UTC.",
        decision="07:00 UTC (540 min after the 22:00 UTC session start). Flips on bars that close at or before 07:00 are features; flips on "
                 "bars that close after 07:00 (to the end of the trading day) are counted for the outcome and traded.",
        outcome_count="post = number of flips after 07:00 in the trading day",
        features=dict(l_yday="log1p(full-day flip count of the previous valid day)", l_pre="log1p(flips at or before 07:00 today)",
                      l_med20="log1p(median full-day flip count of the previous 20 valid days)",
                      a1_logit="logit of abs11 A1 P(big day) (lean21.alert_rows, walk-forward OOS) at the latest 30-min close <= 07:00 of the "
                               "same session; state 2 (day already crossed T1) -> P = 1; clipped to [1e-4, 1-1e-4]; missing -> day not scored "
                               "by M1"),
        model="M0 (primary): Poisson GLM (sklearn PoissonRegressor, alpha 0, log link) on l_yday, l_pre, l_med20 (4 coefficients). "
              "M1 (secondary): M0 + a1_logit. Refit at the first valid day of each calendar month on all strictly earlier valid days "
              "(expanding); first fit needs >= 250 training days; the fitted model predicts that month's days.",
        quintiles="at each refit, edges = 20/40/60/80% quantiles of the new model's fitted values on the last 250 training days; "
                  "predicted quintile = searchsorted(edges, pred, right) (0 = lowest predicted flip count). Past days only.",
        windows=dict(dev="2018-01-01 .. 2022-12-31 (effective start after the 250-day burn-in)",
                     w2023="2023-01-01 .. 2026-10-07 (development window, not a holdout)"),
        step1="descriptive: Spearman rank correlation of pred vs post per window (also each single feature). HINDSIGHT (not a policy): gross "
              "mean R per flip by realized post-count quintile (edges from that window's own days).",
        step2_primary="WTICO/USD M5 M0: D = gross mean R per flip on lowest-predicted-quintile days minus gross mean R of all scored "
                      "post-07:00 flips, per window. Day-block bootstrap: validate.day_boot over scored days, block 5, 1000 reps, seed 30, "
                      "percentile 95% CI.",
        pass_rule="PASS iff in BOTH dev and 2023+: CI(D) lower bound > 0, AND the lowest-quintile gross mean R > 0 with its CI lower "
                  "bound > 0. Otherwise FAIL.",
        secondary="highest predicted quintile (Q5) mean and Q5 minus all (does predicted chop lose more?); gross and net by predicted "
                  "quintile; net (bid/ask) mean R; trades per day; MDE80 = 2.8 x bootstrap SD of D; all six instruments, M15, M1 model "
                  "with A1. Descriptive, no multiplicity correction claimed.",
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
    elif MODE == "a1":
        a1(sys.argv[2])
    elif MODE == "build":
        build(sys.argv[2], sys.argv[3])
    elif MODE == "run":
        run()
