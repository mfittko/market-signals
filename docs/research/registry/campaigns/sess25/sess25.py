"""sess25: session-level breakouts split by tick volume. (1) a closed bar breaks the Asia-session range during the London/NY
window; (2) a closed bar breaks the prior trading day's high/low during the same window. First break per level per day.
HIGH-VOL iff break-bar tick volume / median volume of the same UTC slot over the prior 20 trading days >= 2.
Entry at the next bar open in the break direction; harness stop 1.5 ATR (labels_v2 POLICY k) from the entry; exit after
3 / 6 / 12 bars (dt14.range_sim, stop first). Gross = mid fills (primary), net = bid/ask (secondary).
Evaluator v2 helpers (dt14.range_sim -> fills.resolve, validate.day_boot) imported unchanged. Development evidence only.

  python sess25.py check        synthetic self-checks
  python sess25.py register     prereg.json (refuses to overwrite)
  python sess25.py build INST TF  events + outcomes -> out/ev_<TAG>_<TF>.pkl
  python sess25.py run          statistics -> out/results.json, out/base_rates.json, out/report.txt
"""
import os, sys, json, time, hashlib
from datetime import datetime
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
for p in (ENG, os.path.join(ENG, "audit", "notrade12"), os.path.join(ENG, "audit", "abs11"), os.path.join(ENG, "audit", "limit13"),
          os.path.join(ENG, "audit", "xvol9"), os.path.join(ENG, "audit", "daytype14")):
    sys.path.insert(0, p)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import de_v2 as de  # noqa: E402
from labels_v2 import POLICY  # noqa: E402
from validate import day_boot, year_start_day  # noqa: E402
import nt12  # noqa: E402
import dt14  # noqa: E402

EXP = "sess25"
INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "EUR/USD", "SPX500/USD", "NATGAS/USD"]
TFS = ["M5", "M1"]
G = {"M5": 5, "M1": 1}
TAG = lambda inst: inst.replace("/", "_")
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"sess25.py": sha(os.path.join(HERE, "sess25.py")), "dt14.py": dt14.CODE["dt14.py"], "nt12.py": nt12.CODE["nt12.py"],
        "evaluator": de.CODE_SHA}

ASIA = (0, 7 * 60)                                   # UTC minutes of the calendar date = Tokyo 09:00-16:00 (Japan has no DST)
WIN_OPEN = ("Europe/London", 8, 0)                   # break window opens at the London open (DST-aware)
WIN_CLOSE = ("America/New_York", 17, 0)              # and closes at the New York close (DST-aware)
VOL_N, VOL_THR = 20, 2.0
H = (3, 6, 12)
K = POLICY["k"]                                      # 1.5 ATR harness stop
MIN_COVER = 0.8
PRIOR_COVER = 0.5
NBOOT, BLOCK, SEED, NSIDE = 1000, 5, 25, 1000
EVENTS = ["asia", "pday"]
VOLS = ["HIGH", "QUIET"]


def utc_min(cal_day, tz, hh, mm):
    d = np.datetime64(int(cal_day), "D").astype(datetime)
    return int(datetime(d.year, d.month, d.day, hh, mm, tzinfo=ZoneInfo(tz)).timestamp() // 60)


# ------------------------------------------------------------------ pure helpers
def first_break(mc, a, b, level, side):
    """First bar j in [a, b) whose close is beyond `level` in direction `side` while the previous close was not. -1 if none."""
    if b <= a or a < 1:
        return -1
    c, p = mc[a:b], mc[a - 1:b - 1]
    hit = np.flatnonzero((c > level) & (p <= level)) if side > 0 else np.flatnonzero((c < level) & (p >= level))
    return a + int(hit[0]) if len(hit) else -1


def vol_ratio(t, vol, n=VOL_N):
    """volume / median volume of the same UTC minute-of-day slot over the previous n occurrences (strictly earlier days)."""
    df = pd.DataFrame({"slot": t % 1440, "v": vol.astype(float)})
    med = df.groupby("slot")["v"].transform(lambda s: s.rolling(n, min_periods=n).median().shift(1))
    return np.where(med > 0, df.v / med, np.nan)


def check():
    mc = np.array([10, 10.1, 10.2, 10.6, 10.4, 10.7, 9.4, 9.6, 9.3])
    assert first_break(mc, 1, 9, 10.5, 1) == 3          # 10.2 -> 10.6 crosses 10.5
    assert first_break(mc, 4, 9, 10.5, 1) == 5          # 10.4 -> 10.7, a later re-cross
    assert first_break(mc, 1, 9, 9.5, -1) == 6
    assert first_break(mc, 7, 9, 9.5, -1) == 8          # previous close 9.6 >= 9.5, close 9.3 < 9.5
    assert first_break(mc, 4, 5, 10.5, 1) == -1         # 10.6 -> 10.4: no cross
    # vol ratio: slot 0 has volumes 1..21 on 21 days; day 21 ratio = 21 / median(1..20) = 21 / 10.5
    t = np.repeat(np.arange(22) * 1440, 2) + np.tile([0, 5], 22)
    v = np.c_[np.arange(1, 23), np.full(22, 3)].ravel()
    r = vol_ratio(t, v, 20)
    assert np.isnan(r[:40]).all() and abs(r[40] - 21 / 10.5) < 1e-12 and abs(r[41] - 1.0) < 1e-12
    # range_sim with no target and a time exit after h bars, mid fills
    n = 8
    B = {k: np.full(n, 10.0) for k in ("bid_o", "bid_h", "bid_l", "bid_c", "mid_o", "mid_h", "mid_l", "mid_c")}
    B.update({k: np.full(n, 10.2) for k in ("ask_o", "ask_h", "ask_l", "ask_c")}); B["t"] = np.arange(n) * 5
    for k in ("mid_o", "mid_h", "mid_l", "mid_c"):
        B[k] = B[k] + 0.1
    B["mid_o"][4] = 10.6
    g, ok = dt14.range_sim(B, np.array([1]), np.array([1]), np.array([10.1 - 0.5]), np.array([1e12]), np.array([4]), mid=True)
    assert ok[0] and abs(g[0] - 1.0) < 1e-12, g
    g, ok = dt14.range_sim(B, np.array([1]), np.array([-1]), np.array([10.1 + 0.5]), np.array([-1e12]), np.array([4]), mid=True)
    assert ok[0] and abs(g[0] + 1.0) < 1e-12, g          # the mirror side stops out at the gap open 10.6 = -1 R
    # session clock: London 08:00 = 07:00 UTC in summer, 08:00 UTC in winter; NY 17:00 = 21:00 / 22:00 UTC
    jul, jan = np.datetime64("2024-07-10", "D").astype(int), np.datetime64("2024-01-10", "D").astype(int)
    assert utc_min(jul, *WIN_OPEN) % 1440 == 420 and utc_min(jan, *WIN_OPEN) % 1440 == 480
    assert utc_min(jul, *WIN_CLOSE) % 1440 == 1260 and utc_min(jan, *WIN_CLOSE) % 1440 == 1320
    print("sess25 self-check OK: first break (crossing), same-slot volume ratio, range_sim time exit (mid), DST session clock")


# ------------------------------------------------------------------ build
def load(inst, tf):
    m1, src = nt12.load_m1c(inst)
    B = nt12.frame(inst, m1, tf, nt12.h1(inst, m1))
    return B, src


def events(inst, B, g):
    t, mh, ml, mc = B["t"], B["mid_h"], B["mid_l"], B["mid_c"]
    day = B["day"]
    vr = vol_ratio(t, B["volume"])
    dk, first = np.unique(day, return_index=True)
    cnt = np.diff(np.r_[first, len(day)])
    full = cnt >= PRIOR_COVER * 1440 / g
    rows = []
    for i, d in enumerate(dk):
        cal = d                                         # trading day key d contains calendar date d from 00:00 UTC
        if (cal + 3) % 7 >= 5:                          # Mon-Fri calendar dates only
            continue
        prev = np.flatnonzero(full[:i])
        a_lo, a_hi = np.searchsorted(t, [cal * 1440 + ASIA[0], cal * 1440 + ASIA[1]])
        wo, wc = utc_min(cal, *WIN_OPEN), utc_min(cal, *WIN_CLOSE)
        w_lo, w_hi = np.searchsorted(t, [wo, wc - g + 1])   # bars with t + g <= close
        if w_hi - w_lo < MIN_COVER * (wc - wo) / g:
            continue
        levels = {}
        if a_hi - a_lo >= MIN_COVER * (ASIA[1] - ASIA[0]) / g:
            levels["asia"] = (mh[a_lo:a_hi].max(), ml[a_lo:a_hi].min())
        if len(prev):
            p = prev[-1]; ps, pe = first[p], first[p] + cnt[p]
            levels["pday"] = (mh[ps:pe].max(), ml[ps:pe].min())
        for ev, (hi, lo) in levels.items():
            for s, lv in ((1, hi), (-1, lo)):
                j = first_break(mc, w_lo, w_hi, lv, s)
                if j < 0 or j + 1 + max(H) >= len(t):
                    continue
                rows.append(dict(day=int(d), t=int(t[j]), j=int(j), event=ev, side=s, level=float(lv), vr=float(vr[j]),
                                 atr=float(B["atr"][j]), spr=float(B["ask_c"][j] - B["bid_c"][j])))
    return pd.DataFrame(rows)


def outcomes(B, E, g):
    j = E.j.to_numpy(); e = j + 1; s = E.side.to_numpy(); R = K * E.atr.to_numpy()
    good = np.isfinite(R) & (R > 0)
    R = np.where(good, R, 1.0)
    t = B["t"]
    fill = np.where(s > 0, B["ask_o"][e], B["bid_o"][e])
    E = E.copy()
    E["spr_R"] = E.spr / R
    for h in H:
        x = e + h
        contig = (t[x] - t[e] == g * h) & good
        for nm, sd, ent, mid in (("g", s, B["mid_o"][e], True), ("n", s, fill, False), ("m", -s, B["mid_o"][e], True)):
            v, ok = dt14.range_sim(B, e, sd, ent - sd * R, sd * 1e12, x, mid=mid)
            E[f"{nm}{h}"] = np.where(ok & contig, v, np.nan)
    return E


def build(inst, tf):
    t0 = time.time()
    B, src = load(inst, tf)
    E = events(inst, B, G[tf])
    E = outcomes(B, E, G[tf])
    E["inst"] = inst; E["tf"] = tf
    E["vol"] = np.where(E.vr >= VOL_THR, "HIGH", np.where(np.isfinite(E.vr), "QUIET", "NA"))
    pd.to_pickle(dict(ev=E, m1=src), os.path.join(OUT, f"ev_{TAG(inst)}_{tf}.pkl"))
    print(json.dumps(dict(inst=inst, tf=tf, m1=src, events=int(len(E)), by=E.groupby(["event", "vol"]).size().to_dict().__repr__(),
                          secs=round(time.time() - t0))), flush=True)


# ------------------------------------------------------------------ run
def wins(last_day):
    return {"dev": (year_start_day(2018), year_start_day(2023)), "w2023": (year_start_day(2023), last_day + 1)}


def cell_stats(X, lo, hi, rng):
    """X: event rows of one cell in one window. Gross/net mean R, continuation (gross R > 0) at 3/6/12 bars with day-block CIs."""
    day = X.day.to_numpy()
    cols = [f"g{h}" for h in H] + [f"n{h}" for h in H]
    M = X[cols].to_numpy(float)
    C = (X[[f"g{h}" for h in H]].to_numpy(float) > 0).astype(float)
    C[~np.isfinite(X[[f"g{h}" for h in H]].to_numpy(float))] = np.nan
    A = np.c_[M, C]

    def stat(ix):
        return np.nanmean(A[ix], 0)
    T = stat(np.arange(len(X)))
    bt = day_boot(day, np.arange(lo, hi), stat, NBOOT, block=BLOCK, seed=SEED)
    names = [f"gross{h}" for h in H] + [f"net{h}" for h in H] + [f"cont{h}" for h in H]
    o = {"n": int(len(X))}
    for k, nm in enumerate(names):
        o[nm] = [float(T[k]), float(np.nanpercentile(bt[:, k], 2.5)), float(np.nanpercentile(bt[:, k], 97.5))]
    for k, h in enumerate(H):
        o[f"p_le0_gross{h}"] = float((np.sum(bt[:, k] <= 0) + 1) / (len(bt) + 1))
        o[f"mde_gross{h}"] = float(2.8 * np.nanstd(bt[:, k]))
        o[f"n{h}_valid"] = int(np.isfinite(X[f"g{h}"]).sum())
    g6, m6 = X.g6.to_numpy(float), X.m6.to_numpy(float)
    ok = np.isfinite(g6) & np.isfinite(m6)
    flips = rng.random((NSIDE, ok.sum())) < 0.5
    rs = np.where(flips, m6[ok][None, :], g6[ok][None, :]).mean(1)
    o["side6"] = dict(mean=float(rs.mean()), p=float((np.sum(rs >= np.nanmean(g6)) + 1) / (NSIDE + 1)))
    return o


def diff_stats(X, lo, hi):
    """HIGH minus QUIET gross mean R at 3/6/12 (day-block bootstrap over the pooled rows)."""
    day = X.day.to_numpy(); hv = (X.vol == "HIGH").to_numpy()
    M = X[[f"g{h}" for h in H]].to_numpy(float)

    def stat(ix):
        a, b = M[ix][hv[ix]], M[ix][~hv[ix]]
        return np.nanmean(a, 0) - np.nanmean(b, 0) if len(a) and len(b) else np.full(3, np.nan)
    T = stat(np.arange(len(X)))
    bt = day_boot(day, np.arange(lo, hi), stat, NBOOT, block=BLOCK, seed=SEED)
    return {f"diff_gross{h}": [float(T[k]), float(np.nanpercentile(bt[:, k], 2.5)), float(np.nanpercentile(bt[:, k], 97.5))]
            for k, h in enumerate(H)}


def run():
    check_reg()
    t0 = time.time()
    rng = np.random.default_rng(SEED)
    E = pd.concat([pd.read_pickle(os.path.join(OUT, f"ev_{TAG(i)}_{tf}.pkl"))["ev"] for i in INSTS for tf in TFS], ignore_index=True)
    E = E[E.vol != "NA"]
    W = wins(int(E.day.max()))
    res = dict(code=CODE, note="development evidence; 2023+ is a development window, not a holdout; nothing qualified", cells={})
    base = {}
    for (inst, tf, ev), D in E.groupby(["inst", "tf", "event"]):
        for w, (lo, hi) in W.items():
            X = D[(D.day >= lo) & (D.day < hi)]
            key = f"{TAG(inst)}_{tf}_{ev}"
            for v in VOLS:
                Xv = X[X.vol == v]
                if len(Xv) >= 20:
                    o = cell_stats(Xv, lo, hi, rng)
                    res["cells"].setdefault(f"{key}_{v}", {})[w] = o
                    de.log_trial({"exp": EXP, "cell": f"{key}_{v}", "window": w, "n": o["n"], "gross6": o["gross6"][0],
                                  "mode": "dev" if w == "dev" else "devwindow2023", "sess25_sha256": CODE["sess25.py"]})
            if (X.vol == "HIGH").sum() >= 20 and (X.vol == "QUIET").sum() >= 20:
                res["cells"].setdefault(f"{key}_DIFF", {})[w] = diff_stats(X, lo, hi)
        lo, hi = W["dev"][0], W["w2023"][1]
        for v in VOLS:
            Xv = D[(D.vol == v) & (D.day >= lo)]
            if len(Xv) < 20:
                continue
            o = cell_stats(Xv, lo, hi, rng)
            base[f"{TAG(inst)}_{tf}_{ev}_{v}"] = dict(n=o["n"], **{f"cont{h}": [round(x, 4) for x in o[f"cont{h}"]] for h in H})
        print(inst, tf, ev, round(time.time() - t0), flush=True)
    # primary: WTI M5 HIGH-VOL gross R at 6 bars, events asia and pday; Holm over the 2 events per window
    prim = {}
    for w in ("dev", "w2023"):
        ps = [res["cells"].get(f"WTICO_USD_M5_{ev}_HIGH", {}).get(w, {}).get("p_le0_gross6", 1.0) for ev in EVENTS]
        for ev, a in zip(EVENTS, nt12.holm(ps)):
            prim.setdefault(ev, {})[w] = dict(p=ps[EVENTS.index(ev)], holm=float(a),
                                              gross6=res["cells"].get(f"WTICO_USD_M5_{ev}_HIGH", {}).get(w, {}).get("gross6"))
    for ev in EVENTS:
        prim[ev]["PASS"] = all(prim[ev][w]["gross6"] is not None and prim[ev][w]["gross6"][1] > 0 and prim[ev][w]["holm"] < 0.05
                               for w in ("dev", "w2023"))
    res["primary"] = prim
    res["verdict"] = "PASS" if any(prim[ev]["PASS"] for ev in EVENTS) else "FAIL"
    res["secs"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    json.dump(dict(note="sess25 base rates, 2018-01-01..2026-10-07, continuation = gross (mid) R > 0 after h bars with a 1.5 ATR stop, "
                        "entry at the next bar open; [point, CI low, CI high], day-block bootstrap (block 5, 1000 reps)",
                   rates=base), open(os.path.join(OUT, "base_rates.json"), "w"), indent=1)
    print("done", res["secs"], res["verdict"], {ev: prim[ev]["PASS"] for ev in EVENTS}, flush=True)


def check_reg():
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    cur = (reg.get("amendments") or [{}])[-1].get("code_sha256") or reg["code_sha256"]
    assert cur["sess25.py"] == CODE["sess25.py"], "sess25.py changed after registration (amend first)"


def register(amend=None):
    f = os.path.join(HERE, "prereg.json")
    if amend:
        reg = json.load(open(f))
        reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=amend, code_sha256=CODE))
        json.dump(reg, open(f, "w"), indent=1); print("amended"); return
    assert not os.path.exists(f), "prereg.json exists (use amend)"
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="sess25: Asia-range and prior-day high/low breakouts split by tick volume; issue 310",
        before_registration="Nothing computed on market data before this file (synthetic self-checks only). Prior knowledge: orb15 "
                            "(opening-range breakouts gross +0.07 R in dev only), xvol9/xvol10 (bursts end inside the burst bar), "
                            "notrade12 (spread and thin hours).",
        declared="Development evidence only. No test ledger, nothing qualified. 2023+ is a development window, not a holdout (inspected "
                 "by earlier campaigns). Binding confirmation for any survivor is prospective (issue 313) or post-2026-10-07 data. "
                 "Operator decision: direction signals are judged GROSS (mid, no spread) with realistic latency; net is secondary.",
        evaluator=dict(version="v2", digest=de.CODE_SHA, note="dt14.range_sim (fills.resolve, stop first) and validate.day_boot imported unchanged"),
        data="engine/cache M1 bid/ask/volume via nt12.load_m1c (cut 2026-10-07T18:30 UTC); M5 by bars.resample; tick volume = OANDA "
             "candle volume summed per bar; ATR from de_v2.supertrend on the same timeframe",
        instruments=INSTS, timeframes=dict(primary="M5", secondary="M1 (same rules, horizons in M1 bars)"),
        clock=dict(trading_day="validate.day_of (22:00 UTC rollover); trading day key d contains calendar date d from 00:00 UTC; Mon-Fri only",
                   asia="Asia range = mid high / mid low of bars starting in [00:00, 07:00) UTC of calendar date d = Tokyo 09:00-16:00 "
                        "(Japan has no DST). Valid iff >= 80% of its bars exist.",
                   break_window="bars with start >= 08:00 Europe/London and end <= 17:00 America/New_York on calendar date d "
                                "(DST-aware per date via zoneinfo; London open to New York close; covers both sessions). Valid iff >= 80% of its bars exist.",
                   prior_day="mid high / mid low over all bars of the most recent earlier trading day with >= 50% of its bars"),
        events=dict(
            asia="E1: first bar in the break window whose mid close is above the Asia high (long) while the previous close was not; "
                 "separately the first close below the Asia low (short). First break per level per day only.",
            pday="E2: as E1 with the prior trading day high / low as the levels, same break window."),
        volume_split=f"ratio = break-bar tick volume / median tick volume of the same UTC minute-of-day slot over the previous {VOL_N} "
                     f"occurrences of that slot (strictly earlier days; needs all {VOL_N}). HIGH-VOL iff ratio >= {VOL_THR}; QUIET otherwise; "
                     "no ratio (warm-up, zero median) -> excluded.",
        trade=f"Entry at the open of the bar after the break bar (gross: mid open; net: long ask, short bid), side = break direction. "
              f"Stop = entry -/+ {K} x ATR at the break bar (labels_v2 POLICY k, the harness stop; R = {K} ATR). No target. "
              f"Exit at the open of bar entry + h for h in {list(H)} (held h bars), dt14.range_sim, stop first. A horizon whose bars are not "
              "contiguous (gap, weekend) is missing for that event. No spread filter (operator: spread is the operator's risk).",
        metrics="per instrument x timeframe x event x volume class x window: n, gross mean R [95% CI], continuation rate (gross R > 0) [CI], "
                "net mean R [CI] at 3/6/12 bars; moving-block day bootstrap (validate.day_boot, block 5, 1000 reps, seed 25); MDE = 2.8 x SE; "
                "random-side null at 6 bars (coin flip between the actual and the mirror outcome per event, 1000 draws); "
                "HIGH-VOL minus QUIET gross R difference [CI].",
        windows=dict(dev="2018-01-01 .. 2022-12-31", w2023="2023-01-01 .. 2026-10-07 (development window, not a holdout)"),
        primary="WTICO/USD, M5, HIGH-VOL: gross mean R at 6 bars, events E1 and E2 tested separately. "
                "Event PASS iff in BOTH dev and 2023+: 95% CI lower bound > 0 AND Holm-adjusted (2 events) one-sided bootstrap p (mean <= 0) < 0.05. "
                "Campaign verdict PASS iff any event passes. All other instruments, M1, 3/12 bars and net are reported descriptively.",
        secondary="HIGH-VOL minus QUIET gross R at 6 bars (CI), per instrument; base rates JSON for a card line (out/base_rates.json, "
                  "key <INST>_<TF>_<event>_<vol>: n, continuation at 3/6/12 bars with CI over 2018-2026).",
        budget=dict(primary_hypotheses=2, cells=f"{len(INSTS)} instruments x {len(TFS)} TF x 2 events x 2 vol x 2 windows x 3 horizons",
                    tuned_hyperparameters=0, fixed_constants=dict(VOL_N=VOL_N, VOL_THR=VOL_THR, H=list(H), K=K, ASIA_UTC=list(ASIA),
                                                                  MIN_COVER=MIN_COVER, PRIOR_COVER=PRIOR_COVER, NBOOT=NBOOT, BLOCK=BLOCK, SEED=SEED)),
        code_sha256=CODE,
        file_sha256={"sess25.py": CODE["sess25.py"], "dt14.py": CODE["dt14.py"], "nt12.py": CODE["nt12.py"],
                     "labels_v2.py": sha(os.path.join(ENG, "labels_v2.py")), "fills.py": sha(os.path.join(ENG, "fills.py")),
                     "validate.py": sha(os.path.join(ENG, "validate.py")), "bars.py": sha(os.path.join(ENG, "bars.py"))})
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
