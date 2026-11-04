"""imom34: market intraday momentum (Gao, Han, Li and Zhou 2018, JFE) on OANDA M1 mid prices.

Clock: America/New_York, DST per calendar date (zoneinfo via pandas). P(T) = mid close of the M1 bar that starts at T-1 min
(the last price before T). Session open O and close C per instrument (SESS).
  r_on  = P(O) / P(C of the previous valid session) - 1   (previous session at most 5 calendar days back)
  r1    = P(O+30) / P(O) - 1                             first half hour
  r12   = P(C-30) / P(C-60) - 1                          second-to-last half hour (the paper's 12th half hour for SPX)
  y     = P(C) / P(C-30) - 1                             last half hour (the traded window)
Signals: on1 = sign(r_on + r1) [primary for SPX500], r1 = sign(r1), r12 = sign(r12), both = on1 only when sign(r12) agrees.
Gross bps = s * y * 1e4 (mid entry, mid exit). Net bps: long buys ask_c / sells bid_c of the same M1 bars, short the reverse,
divided by the mid entry. R = median |y| in bps over the previous 60 valid days of the instrument (>= 20 days), gross R = gross/R.
Valid day: Mon-Fri; the five price bars (O-1, O+29, C-61, C-31, C-1) exist; >= 24 of 30 M1 bars present in each of the first,
second-to-last and last half hour (holidays and half days drop out by missing bars); a previous valid session close exists.

  python imom34.py check | counts | register | amend "<reason>" | run
"""
import os, sys, json, time, glob, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out"); os.makedirs(OUT, exist_ok=True)
sys.path.insert(0, ENG)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from validate import day_boot, ci, log_trial  # noqa: E402

EXP = "imom34"
CACHE = os.path.join(ENG, "cache")
CUT = "2026-10-07T18:30"           # common data end of the cached M1 files (same cut as orb15 / nt12)
NY = "America/New_York"
SESS = {"SPX500/USD": (9 * 60 + 30, 16 * 60), "WTICO/USD": (9 * 60, 14 * 60 + 30), "NATGAS/USD": (9 * 60, 14 * 60 + 30),
        "XAU/USD": (8 * 60 + 20, 13 * 60 + 30), "XAG/USD": (8 * 60 + 20, 13 * 60 + 30), "EUR/USD": (8 * 60, 17 * 60)}
INSTS = list(SESS)
PRIMARY = ("SPX500/USD", "on1")
SIGS = ["on1", "r1", "r12", "both"]
MIN_BARS, ON_MAX_DAYS = 24, 5
R_N, R_MIN = 60, 20
TERC_N, TERC_MIN = 250, 60
WINS = {"dev": ("2018-01-01", "2022-12-31"), "w2023": ("2023-01-01", "2026-10-07")}
REPS, BLOCK, SEED = 1000, 5, 34
TAG = lambda s: s.replace("/", "_")
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()


def load_m1(inst):
    f = sorted(glob.glob(os.path.join(CACHE, TAG(inst) + "_*.npz")), key=lambda p: int(p.split("_")[-2]))[-1]
    z = np.load(f); m = z["t"] < np.datetime64(CUT, "m").astype(np.int64)
    return {k: z[k][m] for k in ("t", "bid_c", "ask_c")}, os.path.basename(f)


def day_table(m1, o, c):
    """One row per ET weekday date: prices at the five clock points, bar coverage, first-half-hour realized vol."""
    et = pd.to_datetime(m1["t"] * 60, unit="s", utc=True).tz_convert(NY)
    mod = np.asarray(et.hour * 60 + et.minute)
    date = np.asarray(et.tz_localize(None).normalize())
    sel = (mod >= o - 1) & (mod < c) & (np.asarray(et.weekday) < 5)
    mid = (m1["bid_c"] + m1["ask_c"]) / 2
    df = pd.DataFrame({"d": date[sel], "m": mod[sel], "mid": mid[sel], "bid": m1["bid_c"][sel], "ask": m1["ask_c"][sel]})
    M = df.pivot_table(index="d", columns="m", values="mid", aggfunc="last").reindex(columns=range(o - 1, c))
    Bd = df.pivot_table(index="d", columns="m", values="bid", aggfunc="last").reindex(columns=range(o - 1, c))
    Ak = df.pivot_table(index="d", columns="m", values="ask", aggfunc="last").reindex(columns=range(o - 1, c))
    T = pd.DataFrame(index=M.index)
    for name, tt in (("pO", o), ("p1", o + 30), ("pA", c - 60), ("pB", c - 30), ("pC", c)):
        T[name] = M[tt - 1]
    T["bidB"], T["askB"], T["bidC"], T["askC"] = Bd[c - 31], Ak[c - 31], Bd[c - 1], Ak[c - 1]
    cnt = lambda a: M.loc[:, a:a + 29].notna().sum(axis=1)
    T["n1"], T["nA"], T["nB"] = cnt(o), cnt(c - 60), cnt(c - 30)
    lm = np.log(M.loc[:, o - 1:o + 29].to_numpy())
    T["rv1"] = np.sqrt(np.nansum(np.diff(lm, axis=1) ** 2, axis=1)) * 1e4
    return T


def features(T):
    """Validity, returns (bps), signals, R unit and causal tercile flags on the day table."""
    T = T.copy()
    ok = T[["pO", "p1", "pA", "pB", "pC"]].notna().all(axis=1) & (T[["n1", "nA", "nB"]] >= MIN_BARS).all(axis=1)
    closes = T["pC"].where(ok)
    prev = closes.shift(1).ffill()
    prev_d = pd.Series(np.where(closes.notna(), T.index, pd.NaT), index=T.index).shift(1).ffill()
    gap = (T.index - pd.DatetimeIndex(prev_d)).days
    T["valid"] = ok & prev.notna() & (gap <= ON_MAX_DAYS)
    T["skip_bars"] = ~ok
    T["skip_prev"] = ok & ~T["valid"]
    T["r_on"] = (T["pO"] / prev - 1) * 1e4
    T["r1"] = (T["p1"] / T["pO"] - 1) * 1e4
    T["r12"] = (T["pB"] / T["pA"] - 1) * 1e4
    T["y"] = (T["pC"] / T["pB"] - 1) * 1e4
    V = T[T["valid"]].copy()
    V["R"] = V["y"].abs().rolling(R_N, min_periods=R_MIN).median().shift(1)
    for col, src in (("big1", V["r1"].abs()), ("hivol", V["rv1"])):
        thr = src.rolling(TERC_N, min_periods=TERC_MIN).quantile(2 / 3).shift(1)
        V[col] = np.where(thr.notna(), src > thr, np.nan)
    s_on1 = np.sign(V["r_on"] + V["r1"])
    V["s_on1"], V["s_r1"], V["s_r12"] = s_on1, np.sign(V["r1"]), np.sign(V["r12"])
    V["s_both"] = np.where(s_on1 == np.sign(V["r12"]), s_on1, 0.0)
    long_net = (V["bidC"] - V["askB"]) / V["pB"] * 1e4
    short_net = (V["bidB"] - V["askC"]) / V["pB"] * 1e4
    for k in SIGS:
        s = V["s_" + k]
        V["g_" + k] = s * V["y"]
        V["n_" + k] = np.where(s > 0, long_net, np.where(s < 0, short_net, np.nan))
    return T, V


def in_win(idx, w):
    a, b = WINS[w]
    return (idx >= pd.Timestamp(a)) & (idx <= pd.Timestamp(b))


def boot_cell(V, k, all_days):
    """Mean gross bps, net bps, gross R, hit with day-block bootstrap CIs on days with a position (s != 0)."""
    m = V["s_" + k] != 0
    g, n, r = V.loc[m, "g_" + k].to_numpy(), V.loc[m, "n_" + k].to_numpy(), (V.loc[m, "g_" + k] / V.loc[m, "R"]).to_numpy()
    day = V.index[m].to_numpy().astype("datetime64[D]").astype(np.int64)
    if len(g) < 5:
        return dict(n=int(len(g)))
    stat = lambda i: [g[i].mean(), n[i].mean(), np.nanmean(r[i]), (g[i] > 0).mean()]
    B = day_boot(day, all_days, stat, reps=REPS, block=BLOCK, seed=SEED)
    res = dict(n=int(len(g)), n_R=int(np.isfinite(r).sum()), longs=int((V.loc[m, "s_" + k] > 0).sum()))
    for j, nm in enumerate(("gross", "net", "gross_R", "hit")):
        est = [g.mean(), n.mean(), np.nanmean(r), (g > 0).mean()][j]
        res[nm] = dict(mean=float(est), ci=ci(B[:, j]), sd=float(np.std(B[:, j])), mde80=float(2.8 * np.std(B[:, j])),
                       p_le0=float((B[:, j] <= 0).mean()) if nm != "hit" else float((B[:, j] <= 0.5).mean()))
    return res


def regress(V, all_days, cols):
    """OLS of y (bps) on cols with an intercept; day-block bootstrap CIs on the coefficients."""
    X = np.c_[np.ones(len(V)), V[cols].to_numpy()]; y = V["y"].to_numpy()
    day = V.index.to_numpy().astype("datetime64[D]").astype(np.int64)
    fit = lambda i: np.linalg.lstsq(X[i], y[i], rcond=None)[0]
    b = fit(np.arange(len(y)))
    B = day_boot(day, all_days, fit, reps=REPS, block=BLOCK, seed=SEED)
    r2 = 1 - np.sum((y - X @ b) ** 2) / np.sum((y - y.mean()) ** 2)
    return dict(n=int(len(y)), r2=float(r2), coef={nm: dict(b=float(b[j]), ci=ci(B[:, j]))
                                                   for j, nm in enumerate(["const"] + cols)})


def evaluate(inst):
    m1, f = load_m1(inst)
    o, c = SESS[inst]
    T, V = features(day_table(m1, o, c))
    out = dict(inst=inst, cache=f, sess=[o, c])
    for w in WINS:
        tw, vw = T[in_win(T.index, w)], V[in_win(V.index, w)]
        all_days = tw.index[(tw[["n1", "nA", "nB"]] > 0).any(axis=1)].to_numpy().astype("datetime64[D]").astype(np.int64)
        all_days = np.union1d(all_days, vw.index.to_numpy().astype("datetime64[D]").astype(np.int64))
        r = dict(weekdays=int(len(tw)), valid=int(len(vw)), skip_bars=int(tw["skip_bars"].sum()),
                 skip_prev=int(tw["skip_prev"].sum()), R_median_bps=float(vw["R"].median()))
        r["drift_long"] = dict(mean=float(vw["y"].mean()))
        for k in SIGS:
            r[k] = boot_cell(vw, k, all_days)
        for cond in ("big1", "hivol"):
            for flag in (1.0, 0.0):
                sub = vw[vw[cond] == flag]
                r[f"on1|{cond}={int(flag)}"] = boot_cell(sub, "on1", all_days)
        r["reg_on_r1"] = regress(vw, all_days, ["r_on", "r1"])
        r["reg_on_r1_r12"] = regress(vw, all_days, ["r_on", "r1", "r12"])
        out[w] = r
    return out


def verdict(res):
    spx = next(x for x in res if x["inst"] == PRIMARY[0])
    lbs = {w: spx[w][PRIMARY[1]]["gross"]["ci"][0] for w in WINS}
    return ("PASS" if all(v > 0 for v in lbs.values()) else "FAIL"), lbs


def run():
    res = []
    for inst in INSTS:
        r = evaluate(inst); res.append(r)
        for w in WINS:
            for k in list(SIGS) + [k for k in r[w] if k.startswith("on1|")]:
                x = r[w][k]
                if "gross" not in x:
                    continue
                log_trial(dict(exp=EXP, cell=k, unit=TAG(inst), window=w, primary=(inst, k) == PRIMARY,
                               n=x["n"], gross_bps=x["gross"]["mean"], gross_ci=x["gross"]["ci"], net_bps=x["net"]["mean"],
                               gross_R=x["gross_R"]["mean"], hit=x["hit"]["mean"], mde80=x["gross"]["mde80"]))
            print(inst, w, r[w]["valid"], {k: round(r[w][k]["gross"]["mean"], 2) for k in SIGS if "gross" in r[w][k]}, flush=True)
    v, lbs = verdict(res)
    json.dump(dict(verdict=v, primary_lb=lbs, results=res), open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    print("VERDICT", v, lbs)


def counts():
    """Pre-outcome: valid-day counts only (no return is read)."""
    rows = {}
    for inst in INSTS:
        m1, _ = load_m1(inst)
        T, V = features(day_table(m1, *SESS[inst]))
        rows[inst] = {w: dict(weekdays=int(in_win(T.index, w).sum()), valid=int(in_win(V.index, w).sum()),
                              skip_bars=int(T.loc[in_win(T.index, w), "skip_bars"].sum()),
                              skip_prev=int(T.loc[in_win(T.index, w), "skip_prev"].sum())) for w in WINS}
        print(inst, rows[inst], flush=True)
    json.dump(rows, open(os.path.join(OUT, "counts.json"), "w"), indent=1)


def check():
    """Synthetic: DST clock, return definitions, signs, net fills, skip rules."""
    days = pd.date_range("2024-03-07", "2024-03-13", freq="D")      # DST starts Sun 2024-03-10
    t, bid, ask = [], [], []
    o, c = SESS["SPX500/USD"]
    px = {}
    for i, d in enumerate(days):
        if d.weekday() >= 5:
            continue
        base = 100.0 + i
        for mm in range(o - 1, c):
            p = base
            if mm >= o - 1: p = base + 1.0                          # pO = base + 1
            if mm >= o + 29: p = base + 2.0                         # p1 = base + 2 (r1 > 0)
            if mm >= c - 61: p = base + 1.5
            if mm >= c - 31: p = base + 1.0                         # pB
            if mm == c - 1: p = base + 1.0 + (0.5 if i % 2 else -0.5)  # pC
            local = pd.Timestamp(d.date()).tz_localize(NY) + pd.Timedelta(minutes=mm)
            t.append(int(local.tz_convert("UTC").timestamp() // 60)); bid.append(p - 0.01); ask.append(p + 0.01)
        px[d] = base
    m1 = {"t": np.array(t), "bid_c": np.array(bid), "ask_c": np.array(ask)}
    # 09:29 ET is 14:29 UTC before DST and 13:29 UTC after
    tt = pd.to_datetime(m1["t"] * 60, unit="s", utc=True)
    first = pd.Series(tt).groupby(tt.date).min()
    assert [x.strftime("%H:%M") for x in first] == ["14:29", "14:29", "13:29", "13:29", "13:29"]
    T, V = features(day_table(m1, o, c))
    assert len(T) == 5 and len(V) == 4                              # first day has no previous close
    d = pd.Timestamp("2024-03-11")
    i = list(days).index(d); base = px[d]
    assert abs(V.loc[d, "r1"] - (1 / (base + 1)) * 1e4) < 1e-9
    prevC = px[pd.Timestamp("2024-03-08")] + 1.0 + (0.5 if list(days).index(pd.Timestamp("2024-03-08")) % 2 else -0.5)
    assert abs(V.loc[d, "r_on"] - ((base + 1) / prevC - 1) * 1e4) < 1e-9          # Friday close -> Monday open
    y = ((base + 1 + (0.5 if i % 2 else -0.5)) / (base + 1) - 1) * 1e4
    assert abs(V.loc[d, "y"] - y) < 1e-9 and V.loc[d, "s_r1"] == 1 and abs(V.loc[d, "g_r1"] - y) < 1e-9
    pC = base + 1 + (0.5 if i % 2 else -0.5)
    assert abs(V.loc[d, "n_r1"] - ((pC - 0.01) - (base + 1 + 0.01)) / (base + 1) * 1e4) < 1e-9
    assert V.loc[d, "s_r12"] == -1                                  # pA = base+1.5 -> pB = base+1
    # drop 7 bars of the last half hour on one day -> invalid
    drop = (tt.tz_convert(NY).normalize().tz_localize(None) == pd.Timestamp("2024-03-12")) & \
           (np.asarray(tt.tz_convert(NY).hour * 60 + tt.tz_convert(NY).minute) >= c - 20) & \
           (np.asarray(tt.tz_convert(NY).hour * 60 + tt.tz_convert(NY).minute) < c - 13)
    m2 = {k: v[~drop] for k, v in m1.items()}
    T2, V2 = features(day_table(m2, o, c))
    assert pd.Timestamp("2024-03-12") not in V2.index and T2.loc[pd.Timestamp("2024-03-12"), "skip_bars"]
    print("check ok")


def codeshas():
    return {"imom34.py": sha(os.path.join(HERE, "imom34.py")), "validate.py": sha(os.path.join(ENG, "validate.py"))}


def register(amend=None):
    f = os.path.join(HERE, "prereg.json")
    if amend:
        reg = json.load(open(f))
        reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=amend, code_sha256=codeshas()))
        json.dump(reg, open(f, "w"), indent=1); print("amended"); return
    assert not os.path.exists(f), "prereg.json exists (use amend)"
    reg = json.load(open(os.path.join(HERE, "prereg_body.json")))
    reg = dict(created=time.strftime("%Y-%m-%dT%H:%M:%S%z"), code_sha256=codeshas(), **reg)
    json.dump(reg, open(f, "w"), indent=1); print("registered", sha(f))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    {"check": check, "counts": counts, "register": register, "run": run}.get(mode, lambda: None)() if mode != "amend" \
        else register(amend=sys.argv[2])
