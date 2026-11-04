"""notrade12 (queue v2 item 12): evidence-based "do not enter now" reasons as a filter on the live signal types.

Evaluator v2 (labels_v2.simulate, fills, validate.day_boot) and the xvol9 burst code are imported, never edited.

  python nt12.py check       synthetic self-checks (release calendar, impulses, reason helpers)
  python nt12.py explore     signal counts, reason block rates, R5 feature quantiles (NO outcomes)
  python nt12.py register    write prereg.json (refuses to overwrite)
  python nt12.py run         outcomes + statistics -> out/results.json, out/report.txt
"""
import os, sys, json, time, glob, hashlib
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
XV = os.path.join(ENG, "audit", "xvol9")
sys.path.insert(0, ENG); sys.path.insert(0, XV)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from pandas.tseries.holiday import USFederalHolidayCalendar  # noqa: E402
import de_v2 as de  # noqa: E402
from bars import resample, CACHE  # noqa: E402
from labels_v2 import simulate, POLICY  # noqa: E402
from validate import day_of, day_boot, year_start_day  # noqa: E402
import xvol9 as XV9  # noqa: E402

EXP = "notrade12"
OUT = os.path.join(HERE, "out")
CUT = "2026-10-07T18:30"                     # common data end (WTI cache ends 18:38 UTC)
INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "NATGAS/USD", "SPX500/USD", "EUR/USD"]
M1_INSTS = ["WTICO/USD", "XAU/USD"]
GMIN = {"M1": 1, "M5": 5, "M15": 15}
IMP = dict(mult=2.0, period=20, cooldown=10)  # scripts/supertrend.mjs impulseSettings defaults
SPR_R = 0.2                                   # R1
CHASE_MIN, K_X = 15, 3                        # R2
THIN_N = 4                                    # R3: the 4 UTC hours with the highest median spread/ATR, 2018-2022
PRE, POST = 15, 10                            # R4 window around a release, minutes
X_ST, X_OPEN = 4.5, 3.0                       # R5: ATR_tf from the supertrend line; H1 ATR from the session open
REASONS = ["R1_spread", "R2_chase", "R3_thin_hours", "R4_release", "R5_extended", "R6_counter_h1"]
NBOOT, NNULL, CVQ = 1000, 500, 0.05
DEV_END = "2023-01-01"
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"nt12.py": sha(os.path.join(HERE, "nt12.py"))}
TEXT = {
    "R1_spread": "The spread is wide right now (more than 0.2 of the stop distance).",
    "R2_chase": "Price just burst in this direction; entering now chases the move.",
    "R3_thin_hours": "Thin trading hour: spreads are usually wide relative to movement now.",
    "R4_release": "A scheduled data release is due or just out.",
    "R5_extended": "The move is already stretched far from its base.",
    "R6_counter_h1": "The signal goes against the hourly trend.",
}
ET = ZoneInfo("America/New_York")


# ------------------------------------------------------------------ release calendar (R4)
def _hol(y0=2017, y1=2027):
    return set(d.date() for d in USFederalHolidayCalendar().holidays(f"{y0}-01-01", f"{y1}-12-31"))


def _utcmin(d, hh, mm):
    t = datetime(d.year, d.month, d.day, hh, mm, tzinfo=ET).astimezone(ZoneInfo("UTC"))
    return int(t.timestamp() // 60)


def nfp_dates(y0=2018, y1=2026):
    """BLS rule: third Friday after the Saturday that ends the week containing the 12th of the reference month."""
    out = []
    for y in range(y0 - 1, y1 + 1):
        for m in range(1, 13):
            d12 = date(y, m, 12)
            sat = d12 + timedelta(days=(5 - d12.weekday()) % 7)
            out.append(sat + timedelta(days=20))
    return [d for d in out if y0 <= d.year <= y1]


def eia_crude(y0=2018, y1=2026, H=None):
    """Wednesday 10:30 ET; a federal holiday Mon-Wed of that week moves it to Thursday 11:00 ET."""
    H = H or _hol()
    out, d = [], date(y0, 1, 1)
    d += timedelta(days=(2 - d.weekday()) % 7)
    while d.year <= y1:
        mon = d - timedelta(days=2)
        if any(mon + timedelta(days=k) in H for k in range(3)):
            out.append(_utcmin(d + timedelta(days=1), 11, 0))
        else:
            out.append(_utcmin(d, 10, 30))
        d += timedelta(days=7)
    return out


def eia_gas(y0=2018, y1=2026, H=None):
    """Thursday 10:30 ET; a Thursday holiday (Thanksgiving) moves it to Wednesday 12:00 ET."""
    H = H or _hol()
    out, d = [], date(y0, 1, 1)
    d += timedelta(days=(3 - d.weekday()) % 7)
    while d.year <= y1:
        out.append(_utcmin(d - timedelta(days=1), 12, 0) if d in H else _utcmin(d, 10, 30))
        d += timedelta(days=7)
    return out


def releases(inst):
    r = [_utcmin(d, 8, 30) for d in nfp_dates()]
    if inst == "WTICO/USD":
        r += eia_crude()
    if inst == "NATGAS/USD":
        r += eia_gas()
    return np.sort(np.array(r, np.int64))


def in_window(c, rel):
    """c (minutes) within [release - PRE, release + POST] of any release."""
    k = np.searchsorted(rel, c - POST, side="left")  # first release >= c - POST
    kk = np.clip(k, 0, len(rel) - 1)
    return (k < len(rel)) & (rel[kk] <= c + PRE)


# ------------------------------------------------------------------ signals
def impulses(B, mult=IMP["mult"], period=IMP["period"], cd=IMP["cooldown"]):
    """detectVolumeImpulse + detectHistoricalImpulses (scripts/supertrend.mjs) on mid candles; fires on bar i's close."""
    v = B["volume"]; n = len(v)
    avg = pd.Series(v).rolling(period).mean().shift(2).to_numpy()
    d = np.sign(B["mid_c"] - B["mid_o"])
    dp = np.r_[0, d[:-1]]; vp = np.r_[0, v[:-1]]
    ok = (np.arange(n) >= period + 1) & (avg > 0) & (d != 0) & (d == dp) & (vp >= mult * avg) & (v >= mult * avg)
    keep, last = [], -10 ** 9
    for i in np.where(ok)[0]:
        if i - last > cd:
            keep.append(i); last = i
    keep = np.array(keep, np.int64)
    return keep, d[keep].astype(int)


# ------------------------------------------------------------------ data
def load_m1c(inst):
    f = sorted(glob.glob(os.path.join(CACHE, inst.replace("/", "_") + "_*.npz")), key=lambda p: int(p.split("_")[-2]))[-1]
    z = np.load(f); m = z["t"] < np.datetime64(CUT, "m").astype(np.int64)
    return {k: z[k][m] for k in z.files}, os.path.basename(f)


def frame(inst, m1, g, H1):
    B = resample(m1, g)
    S = de.supertrend(inst, B)
    for k in ("trend", "atr", "st"):
        B[k] = S[k]
    B["flip"] = np.nan_to_num(S["flip"]).astype(int)
    B["c"] = B["t"] + GMIN[g]
    B["day"] = day_of(B["t"])
    B["spr"] = (B["ask_c"] - B["bid_c"]) / (POLICY["k"] * B["atr"])
    B["dopen"] = pd.Series(B["mid_o"]).groupby(B["day"]).transform("first").to_numpy()
    j = np.searchsorted(H1["t"] + 60, B["c"], side="right") - 1  # completed H1 bars only
    jc = np.clip(j, 0, None)
    B["trH1"] = np.where(j >= 0, H1["trend"][jc], 0)
    B["atrH1"] = np.where(j >= 0, H1["atr"][jc], np.nan)
    return B


def h1(inst, m1):
    G = resample(m1, "H1")
    S = de.supertrend(inst, G)
    return {"t": G["t"], "trend": np.nan_to_num(S["trend"]).astype(int), "atr": S["atr"]}


def thin_hours(B5):
    m = (B5["t"] < np.datetime64(DEV_END, "m").astype(np.int64)) & np.isfinite(B5["spr"]) & (B5["atr"] > 0) & ~XV9.weekend(B5["t"])
    hr = (B5["c"][m] % 1440) // 60
    med = np.array([np.median(B5["spr"][m][hr == h]) if (hr == h).any() else -np.inf for h in range(24)])
    return sorted(int(h) for h in np.argsort(-med)[:THIN_N]), [float(x) for x in med]


def xgrid():
    D = XV9.load(); G = XV9.grid(D)
    return D, G


def chase(inst, c, s, D, G):
    """R2: any completed M5 bucket ending within the last CHASE_MIN minutes (end <= c) with a cross-instrument burst
    (>= K_X instruments above) or this instrument above, AND this instrument's bucket move in the signal direction."""
    I = D[inst]; out = np.zeros(len(c), bool)
    e_last = (c // 5) * 5
    for k in range(CHASE_MIN // 5):
        e = e_last - 5 * k
        use = e > c - CHASE_MIN
        T = e - 5
        p = np.clip(np.searchsorted(I["t"], T), 0, len(I["t"]) - 1)
        has = I["t"][p] == T
        own = has & I["above"][p]
        g = np.clip(np.searchsorted(G["t"], T), 0, len(G["t"]) - 1)
        cross = (G["t"][g] == T) & (G["count"][g] >= K_X)
        mv = np.where(has, I["move"][p], np.nan)
        out |= use & (own | cross) & (np.sign(mv) == s)
    return out


def streams(D, G, only=None):
    """Per (inst, tf, kind): signal bars with reason flags. Yields (key, B, i, s, flags dict)."""
    for inst in INSTS:
        if only and inst not in only:
            continue
        m1, src = load_m1c(inst)
        H1 = h1(inst, m1)
        rel = releases(inst)
        B5 = frame(inst, m1, "M5", H1)
        thin, med = thin_hours(B5)
        for g in (["M1"] if inst in M1_INSTS else []) + ["M5", "M15"]:
            B = B5 if g == "M5" else frame(inst, m1, g, H1)
            for kind in ("flip", "impulse"):
                if kind == "flip":
                    i = np.where(B["flip"] != 0)[0]; s = B["flip"][i]
                else:
                    i, s = impulses(B)
                good = np.isfinite(B["atr"][i]) & (B["atr"][i] > 0)
                i, s = i[good], s[good]
                c = B["c"][i]
                with np.errstate(invalid="ignore"):
                    F = {"R1_spread": B["spr"][i] > SPR_R,
                         "R2_chase": chase(inst, c, s, D, G),
                         "R3_thin_hours": np.isin((c % 1440) // 60, thin),
                         "R4_release": in_window(c, rel),
                         "R5_extended": (s * (B["mid_c"][i] - B["st"][i]) / B["atr"][i] > X_ST) |
                                        (s * (B["mid_c"][i] - B["dopen"][i]) / B["atrH1"][i] > X_OPEN),
                         "R6_counter_h1": (B["trH1"][i] != 0) & (B["trH1"][i] != s)}
                    feat = {"dst": s * (B["mid_c"][i] - B["st"][i]) / B["atr"][i],
                            "dop": s * (B["mid_c"][i] - B["dopen"][i]) / B["atrH1"][i]}
                yield (inst, g, kind), B, i, s, F, feat, dict(src=src, thin=thin, thin_med=med)


# ------------------------------------------------------------------ statistics
def cvar(x, q=CVQ):
    x = np.sort(np.asarray(x, float))
    return float(x[:max(1, int(np.ceil(q * len(x))))].mean()) if len(x) else np.nan


def mdd(x):
    cum = np.cumsum(x); peak = np.maximum.accumulate(np.r_[0.0, cum])[1:]
    return float(np.max(peak - cum)) if len(x) else 0.0


def holm(p):
    p = np.asarray(p, float); o = np.argsort(p); m = len(p); adj = np.empty(m); run = 0.0
    for r, k in enumerate(o):
        run = max(run, min(1.0, (m - r) * p[k])); adj[k] = run
    return adj


def evaluate(net, day, Fm, names, all_days, rng, nboot=NBOOT):
    """Fm: bool [n, k] blocked flags. Returns per-reason dict."""
    n, k = Fm.shape
    keep = ~Fm
    ud = np.unique(day); dpos = np.searchsorted(ud, day)
    dall = np.bincount(dpos, net, len(ud))
    out = {"n": int(n), "days_with_signals": int(len(ud)), "meanR_all": float(net.mean()),
           "total_R_all": float(net.sum()), "daily_cvar5_all": cvar(dall), "maxdd_all": mdd(dall), "reasons": {}}

    nd0 = n / len(ud)  # mean signals per signal-day

    def stat(ix):
        x, K = net[ix], keep[ix]
        ma = x.mean()
        mk = np.array([(x[K[:, r]].mean() if K[:, r].any() else np.nan) for r in range(k)])
        mb = np.array([(x[~K[:, r]].mean() if (~K[:, r]).any() else np.nan) for r in range(k)])
        return np.r_[mk - ma, mk - mb, mk, -np.array([x[~K[:, r]].sum() for r in range(k)]) * (nd0 / len(ix))]  # per signal-day: R saved per signal x mean signals per day (bootstrap-consistent)
    bt = day_boot(day, all_days, stat, nboot)
    T = stat(np.arange(n))
    nd = len(ud)

    # day-level paired bootstrap over days with signals (precompute kept daily sums once)
    KD = np.column_stack([np.bincount(dpos, net * keep[:, r], nd) for r in range(k)])

    def dstat2(ix):
        a = dall[ix]
        return np.r_[[cvar(KD[ix, r]) - cvar(a) for r in range(k)], [mdd(a) - mdd(KD[ix, r]) for r in range(k)]]
    bd = day_boot(ud, all_days, dstat2, nboot)
    D0 = dstat2(np.arange(nd))
    pct = lambda a, j: [float(np.nanpercentile(a[:, j], 2.5)), float(np.nanpercentile(a[:, j], 97.5))]
    for r, name in enumerate(names):
        b = Fm[:, r]; nb = int(b.sum()); rate = nb / n
        # random-thinning null: same block count, uniform over signals
        nullD, nullC, nullM = [], [], []
        for _ in range(NNULL):
            rb = np.zeros(n, bool); rb[rng.choice(n, nb, replace=False)] = True
            mk = net[~rb].mean() if nb < n else np.nan
            nullD.append(mk - net.mean())
            kd = np.bincount(dpos, net * ~rb, nd)
            nullC.append(cvar(kd) - cvar(dall)); nullM.append(mdd(dall) - mdd(kd))
        nullD, nullC, nullM = map(np.array, (nullD, nullC, nullM))
        p_one = float((np.sum(bt[:, r] <= 0) + 1) / (len(bt) + 1))
        out["reasons"][name] = dict(
            blocked=nb, block_share=rate,
            meanR_blocked=float(net[b].mean()) if nb else None, meanR_kept=float(net[~b].mean()) if nb < n else None,
            losses_avoided_R=float(-net[b & (net < 0)].sum()), winners_missed_R=float(net[b & (net > 0)].sum()),
            net_saved_R=float(-net[b].sum()), net_saved_R_per_day=[float(T[3 * k + r]), pct(bt, 3 * k + r)],
            delta_kept_vs_all=[float(T[r]), pct(bt, r)], kept_minus_blocked=[float(T[k + r]), pct(bt, k + r)],
            meanR_kept_ci=[float(T[2 * k + r]), pct(bt, 2 * k + r)], p_one_sided=p_one,
            null_random_thinning=dict(delta_q975=float(np.quantile(nullD, 0.975)), delta_mean=float(nullD.mean()),
                                      beats=bool(T[r] > np.quantile(nullD, 0.975)),
                                      pct_of_null=float((nullD < T[r]).mean()),
                                      cvar_diff_null_mean=float(nullC.mean()), cvar_pct_of_null=float((nullC < D0[r]).mean()),
                                      mdd_diff_null_mean=float(nullM.mean()), mdd_pct_of_null=float((nullM < D0[k + r]).mean())),
            daily_cvar5_kept_minus_all=[float(D0[r]), pct(bd, r)], maxdd_reduction=[float(D0[k + r]), pct(bd, k + r)])
    return out


# ------------------------------------------------------------------ modes
def explore():
    D, G = xgrid()
    rows = []
    for key, B, i, s, F, feat, meta in streams(D, G):
        dev = B["t"][i] < np.datetime64(DEV_END, "m").astype(np.int64)
        anyb = np.any(np.column_stack(list(F.values())), 1)
        r = dict(stream="/".join(key), n_dev=int(dev.sum()), n_2023=int((~dev).sum()), thin=meta["thin"],
                 block_dev={k: round(float(v[dev].mean()), 3) for k, v in F.items()}, any_dev=round(float(anyb[dev].mean()), 3),
                 dst_q=[round(float(x), 2) for x in np.nanquantile(feat["dst"][dev], [0.5, 0.9, 0.95])],
                 dop_q=[round(float(x), 2) for x in np.nanquantile(feat["dop"][dev], [0.5, 0.9, 0.95])])
        rows.append(r); print(json.dumps(r), flush=True)
    json.dump(rows, open(os.path.join(OUT, "explore.json"), "w"), indent=1)


def run():
    t0 = time.time()
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    assert reg["code_sha256"]["nt12.py"] == CODE["nt12.py"], "nt12.py changed after registration (amend first)"
    assert reg["code_sha256"]["evaluator"] == de.CODE_SHA
    D, G = xgrid()
    recs = []
    meta_all = {}
    for key, B, i, s, F, feat, meta in streams(D, G):
        sm = simulate(B, i, s, B["atr"][i], B["flip"], POLICY)
        ok = sm["ok"]
        recs.append(dict(key=key, net=sm["net_R"][ok], day=B["day"][i][ok], t=B["t"][i][ok],
                         F=np.column_stack([F[r] for r in REASONS])[ok], censored=int((~ok).sum())))
        meta_all["/".join(key)] = dict(src=meta["src"], thin=meta["thin"], signals=int(len(i)), censored=int((~ok).sum()))
        print(key, len(i), "signals", round(time.time() - t0), "s", flush=True)
    rng = np.random.default_rng(12)
    names = REASONS + ["ANY"]
    res = dict(created=time.strftime("%Y-%m-%dT%H:%M:%S%z"), evaluator=de.CODE_SHA, nt12=CODE["nt12.py"], streams=meta_all,
               note="development evidence only; 2023+ is a development window, never a holdout", families={})
    devt = np.datetime64(DEV_END, "m").astype(np.int64)
    fams = {"primary_M5_M15": lambda k: k[1] in ("M5", "M15"), "secondary_M1": lambda k: k[1] == "M1"}
    for fam, sel in fams.items():
        R = [r for r in recs if sel(r["key"])]
        net = np.concatenate([r["net"] for r in R]); day = np.concatenate([r["day"] for r in R])
        t = np.concatenate([r["t"] for r in R]); Fm = np.concatenate([r["F"] for r in R])
        Fm = np.column_stack([Fm, Fm.any(1)])
        res["families"][fam] = {}
        for win, m in (("dev2018_22", t < devt), ("w2023", t >= devt)):
            all_days = np.arange(day[m].min(), day[m].max() + 1)
            o = evaluate(net[m], day[m], Fm[m], names, all_days, rng)
            ps = holm([o["reasons"][r]["p_one_sided"] for r in names])
            for r, p in zip(names, ps):
                o["reasons"][r]["p_holm"] = float(p)
            # incremental over R1 (reasons among R1-kept signals)
            k1 = m & ~Fm[:, 0]
            inc = evaluate(net[k1], day[k1], Fm[k1][:, 1:], names[1:], all_days, rng, nboot=300)
            o["incremental_over_R1"] = {r: dict(block_share=v["block_share"], delta=v["delta_kept_vs_all"],
                                                meanR_kept=v["meanR_kept"], meanR_blocked=v["meanR_blocked"],
                                                beats_null=v["null_random_thinning"]["beats"]) for r, v in inc["reasons"].items()}
            o["incremental_over_R1"]["_base_R1_kept"] = dict(n=inc["n"], meanR=inc["meanR_all"])
            # per-stream breakdown (points)
            br = {}
            off = 0
            for r in R:
                nn = len(r["net"]); mm = m[off:off + nn]; off += nn
                x, f = r["net"][mm], np.column_stack([r["F"][mm], r["F"][mm].any(1)])
                if not len(x):
                    continue
                br["/".join(r["key"])] = dict(n=int(len(x)), meanR_all=float(x.mean()), **{
                    nm: dict(share=float(f[:, j].mean()), n_kept=int((~f[:, j]).sum()), kept=float(x[~f[:, j]].mean()) if (~f[:, j]).any() else None,
                             blocked=float(x[f[:, j]].mean()) if f[:, j].any() else None) for j, nm in enumerate(names)})
            o["by_stream"] = br
            res["families"][fam][win] = o
            for r in names:
                v = o["reasons"][r]
                de.log_trial({"exp": EXP, "mode": "dev" if win == "dev2018_22" else "devwindow2023", "family": fam, "reason": r,
                              "window": win, "block_share": v["block_share"], "delta": v["delta_kept_vs_all"][0],
                              "p_holm": v["p_holm"], "nt12_sha256": CODE["nt12.py"]})
            print(fam, win, "done", round(time.time() - t0), "s", flush=True)
    res["verdicts"] = verdicts(res)
    res["secs"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)


def verdicts(res):
    out = {}
    for fam, W in res["families"].items():
        out[fam] = {}
        for r in REASONS + ["ANY"]:
            d, w = W["dev2018_22"]["reasons"][r], W["w2023"]["reasons"][r]
            a = d["p_holm"] < 0.05
            b = d["null_random_thinning"]["beats"]
            c = w["delta_kept_vs_all"][0] > 0 and (w["meanR_blocked"] or 0) < (w["meanR_kept"] or 0)
            out[fam][r] = dict(dev_holm=a, dev_beats_random=b, w2023_same_sign=c, PASS=bool(a and b and c))
    return out


def check():
    nf = nfp_dates(2024, 2024)
    assert date(2024, 10, 4) in nf and date(2024, 1, 5) in nf and date(2024, 2, 2) in nf, nf
    H = _hol()
    ec = eia_crude(2024, 2024, H)
    assert _utcmin(date(2024, 10, 9), 10, 30) in ec            # ordinary Wednesday (EDT: 14:30 UTC)
    assert _utcmin(date(2024, 9, 5), 11, 0) in ec               # Labor Day week -> Thursday 11:00
    assert _utcmin(date(2024, 12, 26), 11, 0) in ec             # Christmas Wednesday -> Thursday
    eg = eia_gas(2024, 2024, H)
    assert _utcmin(date(2024, 11, 27), 12, 0) in eg and _utcmin(date(2024, 10, 10), 10, 30) in eg
    t = datetime(2024, 1, 10, 15, 30, tzinfo=ZoneInfo("UTC")).timestamp() // 60  # 10:30 EST = 15:30 UTC
    assert _utcmin(date(2024, 1, 10), 10, 30) == t
    rel = np.array([1000, 5000], np.int64)
    c = np.array([984, 985, 1000, 1010, 1011, 4990, 6000])
    assert list(in_window(c, rel)) == [False, True, True, True, False, True, False]
    # impulses: two up bars at 3x volume after 22 flat bars; cooldown blocks the immediate repeat
    n = 40; v = np.ones(n); v[25:27] = 3; v[28:30] = 3
    o = np.full(n, 10.0); cl = o + 0.1
    i, s = impulses({"volume": v, "mid_o": o, "mid_c": cl})
    assert list(i) == [26] and list(s) == [1], (i, s)
    cl2 = cl.copy(); cl2[25] = o[25] - 0.1
    assert len(impulses({"volume": v, "mid_o": o, "mid_c": cl2})[0]) == 1  # 26 broken, 29 (28,29 pair) fires
    assert holm([0.01, 0.04, 0.03]).round(3).tolist() == [0.03, 0.06, 0.06]
    assert cvar([-3, -1, 0, 1, 2] * 4) == -3.0 and mdd([1, -2, 1, -1, 3]) == 2.0
    print("nt12 self-check OK: NFP rule, EIA crude/gas holiday shifts, ET->UTC (DST), release window, impulses, holm, cvar/mdd")


def register():
    Pf = os.path.join(HERE, "prereg.json")
    assert not os.path.exists(Pf), "prereg.json exists"
    ex = json.load(open(os.path.join(OUT, "explore.json")))
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="notrade12: no-trade advisor - evidence-based 'do not enter now' reasons as a filter on the live signal types (queue v2 item 12)",
        before_registration="explore mode only: signal counts, reason block rates and R5 feature quantiles on 2018-2022 "
                            "(out/explore.json). No outcome (net R, label, fill) was computed before this file.",
        evaluator=dict(version="v2", digest=de.CODE_SHA, note="labels_v2.simulate, fills.resolve, validate.day_boot unchanged"),
        data=f"engine/cache M1 bid/ask npz (newest per instrument), cut at {CUT} UTC; M1/M5/M15/H1 by bars.resample; "
             "production supertrend (flips.mjs, ATR 10, mult 3) per timeframe",
        signals=dict(
            flips="every supertrend flip bar of the timeframe; side = flip",
            impulses=f"detectVolumeImpulse/detectHistoricalImpulses (scripts/supertrend.mjs): two consecutive closed mid bars with "
                     f"the same nonzero body sign, both volume >= {IMP['mult']} x mean volume of the {IMP['period']} bars before the "
                     f"pair, cooldown {IMP['cooldown']} bars; side = body sign; volume = OANDA tick count",
            instruments=INSTS, timeframes="M5, M15 for all; M1 for WTI and XAU",
            unfiltered="no spread filter (as the live engine emits them); entries with a censored outcome dropped"),
        management="308 baseline: labels_v2.simulate POLICY (k=1.5, stop -1R, breakeven after +1R with one-bar latency, 3R target, "
                   "opposite flip of the SAME timeframe exits, H=72 bars of that timeframe), entry next bar open on ask/bid, "
                   "equal cash risk (1 unit per trade, so cash = net R); matched-entry accounting, overlap allowed",
        reasons={
            "R1_spread": f"(ask_c - bid_c) / (1.5 ATR) at the signal bar > {SPR_R}",
            "R2_chase": f"any completed M5 bucket ending within the last {CHASE_MIN} min before the signal close (incl. the signal "
                        f"bar's own bucket) where (>= {K_X} of the 8 xvol9 instruments are above their causal 95th-percentile "
                        "normalized activity [xvol9 K=3] OR this instrument is above its own threshold) AND this instrument's M5 "
                        "mid move in that bucket has the signal's sign. Burst data: xvol9 cache (same M1 source)",
            "R3_thin_hours": f"UTC hour of the entry (signal close) is among the {THIN_N} hours with the highest median M5 "
                             "spread/(1.5 ATR) per instrument over 2018-2022 non-weekend bars (spread data only, no outcomes)",
            "R4_release": f"entry within [{PRE} min before, {POST} min after] a scheduled release: NFP 08:30 ET (all instruments) "
                          "by the BLS rule (third Friday after the week containing the 12th); EIA crude WPSR Wed 10:30 ET, moved to "
                          "Thu 11:00 ET when a US federal holiday falls Mon-Wed (WTI); EIA gas storage Thu 10:30 ET, Thanksgiving "
                          "-> Wed 12:00 ET (NATGAS). ET via zoneinfo (DST). CPI and FOMC SKIPPED: no reliable historical date "
                          "list in the repo, and neither follows a derivable rule. Ad-hoc exceptions (shutdowns, special shifts) "
                          "are not modelled",
            "R5_extended": f"side x (close - supertrend line) / ATR_tf > {X_ST} OR side x (close - trading-day open [22:00 UTC "
                           f"roll]) / ATR_H1 (completed H1 bar) > {X_OPEN}",
            "R6_counter_h1": "completed-H1 supertrend trend is nonzero and opposite to the signal side"},
        thresholds_rationale="R1 = the evaluator's carried-forward spread rule. R5: band = 3 ATR, so 4.5 ATR = 1.5 bands; 3 H1 "
                             "ATR from the day open = a stretched intraday move. Chosen from principle; explore.json shows the "
                             "resulting block rates (no outcomes). Not tuned afterwards.",
        combined="ANY: blocked when any of R1..R6 fires",
        families=dict(primary="M5 + M15, all 6 instruments, flips + impulses pooled, signal-weighted (decision family)",
                      secondary="M1 WTI + XAU (reported, same rule, separate family)"),
        objective="delta = mean net R of KEPT signals minus mean net R of ALL signals (paired; under random thinning E[delta]=0)",
        statistics=f"5-day moving-block day bootstrap (validate.day_boot, {NBOOT} reps) for delta, kept-minus-blocked, kept mean, "
                   f"net R saved per day, daily CVaR 5% and max drawdown differences; random-thinning null: {NNULL} uniform "
                   "draws of the same blocked count; one-sided bootstrap p for delta > 0; Holm across the 7 tests (R1..R6, ANY) "
                   "per family in the dev window",
        decision_rule="PASS per reason and family iff (a) dev 2018-2022 Holm-adjusted one-sided p < 0.05 for delta > 0, (b) dev "
                      "delta above the 97.5th percentile of the random-thinning null, (c) 2023+ development window delta > 0 "
                      "and blocked mean < kept mean. Anything else FAIL. Absolute question reported separately: kept-set "
                      "mean R with CI (>= 0 or not).",
        diagnostics="incremental effect of R2..R6 and ANY among R1-kept signals; per-stream (instrument/timeframe/kind) "
                    "block shares and kept/blocked means; losses avoided vs winners missed in R",
        windows=dict(dev2018_22="signal time < 2023-01-01 (nothing is fitted; R3 hour list from spread only)",
                     w2023="2023-01-01..cut: DEVELOPMENT window, inspected by earlier campaigns, never a holdout"),
        explore_summary=[dict(stream=r["stream"], n_dev=r["n_dev"], any_dev=r["any_dev"]) for r in ex],
        rules="no test_ledger use; nothing marked qualified; development evidence only; trials logged with exp notrade12",
        code_sha256=dict(evaluator=de.CODE_SHA, evaluator_files=de.CODE_FILES_SHA, **CODE,
                         **{"xvol9.py": sha(os.path.join(XV, "xvol9.py"))}))
    json.dump(reg, open(Pf, "w"), indent=1)
    print("registered", reg["created"])


def amend():
    Pf = os.path.join(HERE, "prereg.json")
    reg = json.load(open(Pf))
    reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=sys.argv[2],
                                                  old_sha=reg["code_sha256"]["nt12.py"], new_sha=CODE["nt12.py"]))
    reg["code_sha256"]["nt12.py"] = CODE["nt12.py"]
    json.dump(reg, open(Pf, "w"), indent=1)


if __name__ == "__main__":
    {"check": check, "explore": explore, "register": register, "run": run, "amend": amend}[sys.argv[1]]()
