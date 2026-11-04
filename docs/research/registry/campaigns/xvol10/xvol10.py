"""xvol10 (#310 campaign): M1 event study of cross-instrument activity bursts. Gating diagnostic only.

Do bursts detected on M1 leave drift that exceeds the spread after a one-minute confirmation? Nothing is fitted
and no policy is searched. Activity normalization, burst rule, cooldown and instrument set come from xvol9
(imported unchanged); xvol9's M5 detection is rerun for a side-by-side row. M1 bid/ask comes from the same
read-only snapshot xvol9 used (engine/cache M1 files named in the xvol9 cache), so history.db is not touched.

  python xvol10.py check      synthetic self-checks
  python xvol10.py register   write prereg.json (refuses to overwrite)
  python xvol10.py run        -> out/results.json, out/report.txt
"""
import os, sys, json, time, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
X9DIR = os.path.join(os.path.dirname(HERE), "xvol9")
ENG = os.path.dirname(os.path.dirname(HERE))
sys.path[:0] = [ENG, X9DIR]
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import xvol9 as X9  # noqa: E402
import de_v2 as de  # noqa: E402
from validate import day_of, day_boot  # noqa: E402

EXP = "xvol10"
INSTS = X9.INSTS
KS, K_MAIN = (3, 2, 4), 3
PATH_MIN = (0, 1, 2, 3, 5, 10, 30)    # minutes after the burst bar close (0 = burst bar close)
EXEC_MIN = (3, 5, 10, 30)             # minutes after entry
ATR_N, RK, SPR_MAX = 14, 1.5, 0.2     # Wilder ATR14 of M5 mid bars; R = 1.5 x ATR14; spread rule at the signal bar
LEAD_M1, LAG_M1 = 0.5, 0.25           # H2 laggard map thresholds on M1: xvol9's 1.0 / 0.5 ATR scaled by ~1/sqrt(5)
GO_LB, GO_H = 0.05, (5, 10)
NBOOT = 3000
WINDOWS = X9.WINDOWS
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"xvol10.py": sha(os.path.join(HERE, "xvol10.py")), "xvol9.py": sha(os.path.join(X9DIR, "xvol9.py")),
        "xvol9/prep.py": sha(os.path.join(X9DIR, "prep.py")), "validate.py": sha(os.path.join(ENG, "validate.py"))}
GO_TEXT = ("GO to a full policy test only if, in BOTH dev and 2023+, the mean executable spread-inclusive return at +5 "
           "or +10 minutes after the confirmed entry has a 95% CI lower bound above +0.05 R for K=3. Otherwise NO-GO "
           "and the line closes.")


# ------------------------------------------------------------------ pure helpers
def wilder_atr(h, l, c, n=ATR_N):
    pc = np.r_[np.nan, c[:-1]]
    tr = np.nanmax(np.c_[h - l, np.abs(h - pc), np.abs(l - pc)], axis=1)
    return pd.Series(tr).ewm(alpha=1 / n, adjust=False, min_periods=n).mean().to_numpy()


def norm1(t, vol):
    """M1 version of xvol9.norm_activity: vol / median(vol at the same UTC minute over the prior 20 trading days)."""
    day = day_of(t); slot = t % 1440
    ud, r = np.unique(day, return_inverse=True)
    M = np.full((len(ud), 1440), np.nan); M[r, slot] = vol
    med = pd.DataFrame(M).rolling(X9.MED_DAYS, min_periods=X9.MED_MIN).median().shift(1).to_numpy()
    return vol / np.maximum(med[r, slot], 1.0)


def atr_asof(A5, t0):
    """ATR14 of the last M5 bar completed at or before t0 (as of the burst bar open)."""
    j = np.searchsorted(A5["t"] + 5, t0, side="right") - 1
    return A5["atr"][j] if j >= 0 else np.nan


def measure(M, A, t0, L, s):
    """One event on M1 arrays M. Burst bar = [t0, t0+L), confirmation (signal) bar = [t0+L, t0+2L),
    entry = first M1 bar in [t0+2L, t0+3L) at its open (ask long / bid short). Units: path in ATR A, exec in R."""
    t, n = M["t"], len(M["t"])
    o = dict(path=np.full(len(PATH_MIN), np.nan), ex=np.full(len(EXEC_MIN), np.nan), conf=False, entry=False,
             spr=np.nan, ahead=np.nan, total=np.nan)
    i0 = np.searchsorted(t, t0)
    if not (A > 0) or s == 0 or i0 == 0 or i0 >= n or t[i0] >= t0 + L:
        return o
    last = lambda x: np.searchsorted(t, x, side="right") - 1
    ref = M["mid_c"][i0 - 1]
    o["path"] = np.array([s * (M["mid_c"][last(t0 + L - 1 + h)] - ref) / A for h in PATH_MIN])
    a, b = np.searchsorted(t, t0 + L), np.searchsorted(t, t0 + 2 * L)
    R = RK * A
    if a < b:  # signal bar exists (contiguous)
        hi = (M["bid_h"][i0:a].max() + M["ask_h"][i0:a].max()) / 2
        lo = (M["bid_l"][i0:a].min() + M["ask_l"][i0:a].min()) / 2
        c = M["mid_c"][b - 1]
        o["conf"] = bool((c > hi if s > 0 else c < lo) and (M["ask_c"][b - 1] - M["bid_c"][b - 1]) / R <= SPR_MAX)
    if b < n and t[b] < t0 + 3 * L:
        o["entry"] = True
        px = M["ask_o"][b] if s > 0 else M["bid_o"][b]
        o["spr"] = (M["ask_o"][b] - M["bid_o"][b]) / R
        for k, h in enumerate(EXEC_MIN):
            x = last(t[b] + h - 1)
            o["ex"][k] = s * ((M["bid_c"][x] if s > 0 else M["ask_c"][x]) - px) / R
        w = last(t0 + L - 1 + 30)
        mo0, mob = (M["bid_o"][i0] + M["ask_o"][i0]) / 2, (M["bid_o"][b] + M["ask_o"][b]) / 2
        mh, ml = M["mid_h"], M["mid_l"]
        ext = (lambda u, v: mh[u:v + 1].max()) if s > 0 else (lambda u, v: ml[u:v + 1].min())
        o["total"] = max(0.0, s * (ext(i0, w) - mo0))
        o["ahead"] = max(0.0, s * (ext(b, w) - mob)) if w >= b else 0.0
    return o


def check():
    # norm1 is causal and ~1 on stationary data
    rng = np.random.default_rng(0)
    tt = np.concatenate([d * 1440 + np.arange(1440) for d in range(30)]) + 4 * 1440
    v = rng.poisson(50, len(tt)).astype(float)
    a1 = norm1(tt, v); v2 = v.copy(); v2[day_of(tt) == day_of(tt[-1])] *= 10; a2 = norm1(tt, v2)
    pre = day_of(tt) < day_of(tt[-1])
    assert np.allclose(a1[pre], a2[pre], equal_nan=True) and np.isfinite(a1[-1])
    assert abs(np.nanmedian(a1) - 1) < 0.05
    # wilder ATR on constant range 2 -> 2
    assert abs(wilder_atr(np.full(50, 2.0), np.zeros(50), np.ones(50))[-1] - 2) < 1e-9
    # measure: flat 100 (spread 0.2), burst minute 10 up to 102 (high 102.5), minute 11 closes 103, then 104 from 12 on
    t = np.arange(60); mid = np.full(60, 100.0); mid[10] = 102; mid[11] = 103; mid[12:] = 104
    hi = mid.copy(); hi[10] = 102.5; hi[12:] = 105
    M = dict(t=t, mid_c=mid, bid_c=mid - .1, ask_c=mid + .1, bid_h=hi - .1, ask_h=hi + .1, bid_l=mid - .1, ask_l=mid + .1,
             bid_o=np.r_[100, mid[:-1]] - .1, ask_o=np.r_[100, mid[:-1]] + .1)
    M["bid_o"][12:] = 104 - .1; M["ask_o"][12:] = 104 + .1
    M["mid_h"], M["mid_l"] = hi, mid
    o = measure(M, 2.0, 10, 1, 1)
    assert np.allclose(o["path"], [1, 1.5, 2, 2, 2, 2, 2]) and o["conf"] and o["entry"]
    assert np.allclose(o["ex"], (103.9 - 104.1) / 3) and np.isclose(o["spr"], .2 / 3)
    assert np.isclose(o["total"], 5) and np.isclose(o["ahead"], 1)       # o0 = 100, peak 105; entry mid 104
    assert not measure(M, 2.0, 10, 1, -1)["conf"]
    M2 = {k: np.delete(x, 11) for k, x in M.items()}                         # missing confirmation minute
    assert not measure(M2, 2.0, 10, 1, 1)["conf"]
    o5 = measure(M, 2.0, 5, 5, 1)  # M5 bar [5,10) flat, confirmation [10,15) closes 104 > 100.1 -> conf
    assert o5["conf"] and o5["entry"] and np.isclose(o5["path"][0], 0)
    print("xvol10 self-check OK: causal M1 normalization, ATR, event measurement, confirmation, entry/exit fills")


# ------------------------------------------------------------------ data
def m1_file(inst):
    z = np.load(os.path.join(X9DIR, "cache", inst.replace("/", "_") + ".npz"))
    n, tmax = int(z["m1_rows"]), str(z["m1_last"])
    return os.path.join(ENG, "cache", f"{inst.replace('/', '_')}_{n}_{tmax[:16].replace(':', '')}.npz")


def load_m1():
    D1, M1, A5 = {}, {}, {}
    for inst in INSTS:
        z = np.load(m1_file(inst)); M = {k: z[k] for k in z.files}
        for k in "ohlc":
            M["mid_" + k] = (M["bid_" + k] + M["ask_" + k]) / 2
        z5 = np.load(os.path.join(X9DIR, "cache", inst.replace("/", "_") + ".npz"))
        A5[inst] = dict(t=z5["t"], atr=wilder_atr(z5["mid_h"], z5["mid_l"], z5["mid_c"]))
        t = M["t"]; we = X9.weekend(t)
        a = np.full(len(t), np.nan); a[~we] = norm1(t[~we], M["volume"][~we])
        thr = np.full(len(t), np.nan); thr[~we] = X9.thresholds(day_of(t[~we]), a[~we])
        j = np.searchsorted(A5[inst]["t"] + 5, t, side="right") - 1
        atr = np.where(j >= 0, A5[inst]["atr"][np.clip(j, 0, None)], np.nan)
        with np.errstate(invalid="ignore", divide="ignore"):
            move = (M["mid_c"] - np.r_[np.nan, M["mid_c"][:-1]]) / atr
        D1[inst] = dict(t=t, above=(a > thr) & ~we, valid=np.isfinite(a) & np.isfinite(thr) & ~we, move=move)
        M1[inst] = M
        print("loaded", inst, len(t), "M1 rows, above share", round(D1[inst]["above"].sum() / max(1, D1[inst]["valid"].sum()), 4),
              flush=True)
    return D1, M1, A5


# ------------------------------------------------------------------ study
def study(C, M1, A5, L):
    rows = []
    for j in range(len(C["b"])):
        inst, t0, s = C["inst"][j], int(C["t"][j]), int(C["s"][j])
        o = measure(M1[inst], atr_asof(A5[inst], t0), t0, L, s)
        rows.append(o)
    out = dict(t=np.asarray(C["t"], np.int64), inst=C["inst"])
    for k in ("path", "ex"):
        out[k] = np.array([r[k] for r in rows]).reshape(len(rows), -1)
    for k in ("conf", "entry", "spr", "ahead", "total"):
        out[k] = np.array([r[k] for r in rows])
    return out


def stats(X, day, all_days):
    """Per column: n, mean, se, day-block bootstrap 95% CI (validate.day_boot, 5-day blocks)."""
    ok = np.isfinite(X).all(1); X, day = X[ok], day[ok]
    if len(X) < 5:
        return dict(n=int(len(X)))
    bs = day_boot(day, all_days, lambda ix: X[ix].mean(0), NBOOT)
    return dict(n=int(len(X)), days=int(len(np.unique(day))), mean=X.mean(0).tolist(),
                se=(X.std(0) / np.sqrt(len(X))).tolist(), ci_lo=np.percentile(bs, 2.5, 0).tolist(),
                ci_hi=np.percentile(bs, 97.5, 0).tolist())


def summarize(S, wins):
    out = {}
    for wn, (lo, hi, all_days) in wins.items():
        w = (S["t"] >= lo) & (S["t"] < hi); d = day_of(S["t"])
        c = w & S["conf"] & S["entry"]; e = w & S["entry"]
        r = dict(events=int(w.sum()), confirmed=int(c.sum()),
                 path_all=stats(S["path"][w], d[w], all_days),
                 path_conf=stats(S["path"][c], d[c], all_days),
                 exec_conf=stats(S["ex"][c], d[c], all_days),
                 exec_all=stats(S["ex"][e], d[e], all_days))
        for nm, m in (("conf", c), ("all", e)):
            sp, ah, to = S["spr"][m], S["ahead"][m], S["total"][m]
            with np.errstate(invalid="ignore", divide="ignore"):
                sh = np.where(to > 0, ah / to, np.nan)
            r["spread_R_" + nm] = dict(mean=float(np.nanmean(sp)), median=float(np.nanmedian(sp))) if m.any() else None
            r["share_ahead_" + nm] = dict(aggregate=float(np.nansum(ah) / np.nansum(to)),
                                          median=float(np.nanmedian(sh))) if m.any() else None
        out[wn] = r
    return out


def by_year(t):
    y = np.asarray(t).astype("datetime64[m]").astype("datetime64[Y]").astype(int) + 1970
    return {str(k): int((y == k).sum()) for k in np.unique(y)}


def laggards(G, ev, lead, lag):
    X9.LEAD_MOVE, X9.LAG_STILL = lead, lag  # xvol9.h2 reads these module globals at call time
    try:
        return X9.h2(G, ev)
    finally:
        X9.LEAD_MOVE, X9.LAG_STILL = 1.0, 0.5


def go_decision(R):
    per = {}
    for wn in WINDOWS:
        ex = R["K"][str(K_MAIN)]["study"][wn]["exec_conf"]
        lbs = {h: (ex["ci_lo"][EXEC_MIN.index(h)] if "ci_lo" in ex else None) for h in GO_H}
        per[wn] = dict(lb=lbs, pass_=any(v is not None and v > GO_LB for v in lbs.values()))
    return dict(per_window=per, result="GO" if all(v["pass_"] for v in per.values()) else "NO-GO", rule=GO_TEXT)


def run():
    t00 = time.time()
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    assert reg["code_sha256"]["xvol10.py"] == CODE["xvol10.py"], "xvol10.py changed after registration (amend first)"
    D1, M1, A5 = load_m1()
    T_last = max(int(M["t"][-1]) for M in M1.values())
    wins = {}
    for wn, (a, b) in WINDOWS.items():
        lo, hi = np.datetime64(a, "m").astype(np.int64), np.datetime64(b, "m").astype(np.int64)
        wins[wn] = (lo, hi, np.arange(int(day_of(lo)), int(min(day_of(hi), day_of(T_last) + 1))))
    G = X9.grid(D1)
    print("M1 grid", len(G["t"]), round(time.time() - t00), "s", flush=True)
    res = dict(exp=EXP, code=CODE, note="development evidence only; gating diagnostic", K={})
    for K in KS:
        ev = X9.events(G, K)
        C = X9.h1h3(G, ev, "ext", 1)
        S = study(C, M1, A5, 1)
        RK_ = res["K"][str(K)] = dict(events=int(len(ev)), lead_events=int(len(C["b"])), by_year=by_year(G["t"][ev]),
                                      lead_by_inst={i: int((C["inst"] == i).sum()) for i in INSTS},
                                      participants_mean=float(G["count"][ev].mean()), study=summarize(S, wins))
        if K == K_MAIN:
            CL = laggards(G, ev, LEAD_M1, LAG_M1); SL = study(CL, M1, A5, 1)
            RK_["laggards"] = {wn: dict(n=int(((SL["t"] >= lo) & (SL["t"] < hi)).sum()),
                                        path=stats(SL["path"][(SL["t"] >= lo) & (SL["t"] < hi)],
                                                   day_of(SL["t"][(SL["t"] >= lo) & (SL["t"] < hi)]), ad))
                               for wn, (lo, hi, ad) in wins.items()}
            RK_["laggards_by_inst"] = {i: int((CL["inst"] == i).sum()) for i in INSTS if (CL["inst"] == i).any()}
        for wn in WINDOWS:
            ex = RK_["study"][wn]["exec_conf"]
            de.log_trial({"exp": EXP, "mode": "dev" if wn == "dev2018_22" else "devwindow2023", "detect": "M1", "K": K,
                          "window": wn, "n": ex.get("n"), "exec_mean_R": ex.get("mean"), "decision_eligible": K == K_MAIN,
                          "xvol10_sha256": CODE["xvol10.py"]})
        print("M1 K", K, len(ev), "events", round(time.time() - t00), "s", flush=True)
    del G
    # M5 side-by-side: xvol9 detection reproduced unchanged (its ATR10 move picks the lead), measured here in ATR14 units
    D5 = X9.load(); G5 = X9.grid(D5)
    ev5 = X9.events(G5, K_MAIN)
    C5 = X9.h1h3(G5, ev5, "ext", 1)
    S5 = study(C5, M1, A5, 5)
    CL5 = laggards(G5, ev5, 1.0, 0.5); SL5 = study(CL5, M1, A5, 5)
    res["M5"] = dict(K=K_MAIN, events=int(len(ev5)), by_year=by_year(G5["t"][ev5]), study=summarize(S5, wins),
                     laggards={wn: stats(SL5["path"][(SL5["t"] >= lo) & (SL5["t"] < hi)],
                                         day_of(SL5["t"][(SL5["t"] >= lo) & (SL5["t"] < hi)]), ad)
                               for wn, (lo, hi, ad) in wins.items()})
    for wn in WINDOWS:
        ex = res["M5"]["study"][wn]["exec_conf"]
        de.log_trial({"exp": EXP, "mode": "dev" if wn == "dev2018_22" else "devwindow2023", "detect": "M5", "K": K_MAIN,
                      "window": wn, "n": ex.get("n"), "exec_mean_R": ex.get("mean"), "decision_eligible": False,
                      "xvol10_sha256": CODE["xvol10.py"]})
    res["go_no_go"] = go_decision(res)
    res["secs"] = round(time.time() - t00)
    os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
    json.dump(res, open(os.path.join(HERE, "out", "results.json"), "w"), indent=1, default=float)
    print("GO/NO-GO:", res["go_no_go"]["result"], json.dumps(res["go_no_go"]["per_window"], default=float), flush=True)


# ------------------------------------------------------------------ registration
def register():
    Pf = os.path.join(HERE, "prereg.json")
    assert not os.path.exists(Pf), "prereg.json exists"
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="xvol10: M1 event study of cross-instrument activity bursts (gating diagnostic, #310 campaign)",
        purpose="gating diagnostic for a possible follow-up policy test; no policy, no stops/targets, no optimization, "
                "no test_ledger, nothing marked qualified",
        before_registration="No activity, burst or outcome statistic on M1 was computed before this file. The M5 "
                            "results of xvol9 (issue 310 comment 6053439954) are known.",
        instruments=INSTS,
        data="the same M1 bid/ask snapshot xvol9 used (engine/cache M1 npz named by the xvol9 cache row count and last "
             "time); history.db is not read. volume = OANDA price-update count. M5 bars from xvol9 cache.",
        data_files={i: os.path.basename(m1_file(i)) for i in INSTS},
        weekend="Fri 21:00 .. Sun 22:00 UTC excluded from normalization, thresholds and detection (xvol9.weekend)",
        activity="a = M1 tick count / median(tick count at the same UTC M1 slot over the prior 20 trading days, >= 10 "
                 "obs, current day excluded; floor 1). Instrument above = a > its 95th percentile over the prior 20 "
                 "trading days (xvol9.thresholds, all non-weekend M1 bars, >= 10 days)",
        burst="M1 burst = at least K of 8 instruments above in the same M1 bar; K=3 primary, K=2 and 4 sensitivity; "
              "60-minute cooldown (xvol9.events). t0 = first burst minute",
        atr="ATR14 = Wilder ATR(14) of M5 mid bars (xvol9 cache), value of the last M5 bar completed at or before t0 "
            "(as-of t0 open). R = 1.5 x ATR14. Note: xvol9 used the production supertrend ATR(10)",
        lead="lead = instrument above threshold in the t0 bar with the largest |mid close(t0) - mid close(previous M1 "
             "bar)| / ATR14 (xvol9.h1h3 on the M1 grid); direction = sign of that return",
        measurements=dict(
            path=f"signed mid path of the lead, (mid close at t0 close + h minutes - mid close before t0) / ATR14, h in "
                 f"{PATH_MIN} (0 = t0 close); mean, se, 5-day block bootstrap 95% CI (validate.day_boot, {NBOOT} reps); "
                 "windows dev2018_22 and w2023 separately; all events and confirmed only",
            confirmation="t0+1 M1 bar exists (contiguous) and its mid close is beyond the t0 bar mid high (long) / low "
                         "(short); spread at the t0+1 close <= 0.2 R (queue spread rule); entry bar = M1 bar at t0+2 "
                         "must exist",
            executable=f"entry at t0+2 open, ask (long) / bid (short); mark at entry + {EXEC_MIN} minutes on the bid "
                       "(long) / ask (short) close of the last M1 bar ending by then; in R; spread-inclusive; also "
                       "reported for all events with an entry bar (unconfirmed)",
            spread="(ask open - bid open) at the entry bar, in R",
            share_ahead="total = max favourable mid excursion from the t0 open over bars t0 .. t0 close + 30 min; ahead "
                        "= max favourable mid excursion after the entry open (entry bar .. same end); reported as "
                        "sum(ahead)/sum(total) and the median per-event ratio",
            laggards=f"xvol9 H2 leader map {X9.LEADERS}; on M1 leader |move| >= {LEAD_M1} ATR14 and laggard |move| < "
                     f"{LAG_M1} ATR14 (xvol9 1.0/0.5 scaled by ~1/sqrt(5)); signed laggard mid path in laggard ATR14",
            counts="events per year, lead per instrument"),
        m5_row="xvol9 M5 detection reproduced unchanged (K=3, its ATR10 move chooses the lead and direction; H2 with "
               "1.0/0.5); the same measurements with the burst bar [t0, t0+5), confirmation bar [t0+5, t0+10), entry "
               "at the first M1 bar in [t0+10, t0+15), ATR14 as-of t0, path h measured from the M5 burst bar close",
        windows={"dev2018_22": "2018-01-01..2022-12-31", "w2023": "2023-01-01..newest (DEVELOPMENT window, not a holdout)"},
        go_no_go=GO_TEXT,
        go_operational="For K=3 M1 detection, confirmed events: window passes if the 95% day-block CI lower bound of "
                       "the mean executable R at +5 or at +10 minutes after entry is > +0.05 R. GO iff dev2018_22 and "
                       "w2023 both pass. Unadjusted 95% CI. Otherwise NO-GO.",
        rules="no test_ledger; nothing marked qualified; trials logged to trials.jsonl with exp xvol10; development "
              "evidence only",
        code_sha256=dict(**CODE, evaluator=de.CODE_SHA))
    json.dump(reg, open(Pf, "w"), indent=1)
    print("registered", reg["created"])


if __name__ == "__main__":
    {"check": check, "register": register, "run": run}[sys.argv[1]]()
