"""night38: overnight drift in US stock index CFDs (Cliff, Cooper and Gulen 2008; Kelly and Clark 2011; Lou, Polk and Skouras 2019).

Clock: America/New_York, DST per calendar date. P(T) = mid close of the latest M1 bar that starts in [T-3, T-1] min
(the bar ending at T, at most 2 minutes stale), else missing. Mid = (bid_c + ask_c) / 2 from history.db candles_ba (read-only).
Trading days: NYSE weekdays minus full-day holidays (pandas holiday rules as in cal37, plus the 2018-12-05 and 2025-01-09
closures). Cash close C = 16:00 ET, 13:00 ET on early-close days (day after Thanksgiving, Dec 24 and Jul 3 when trading days).
Open O = 09:30 ET.
  day_d   = P(C_d) / P(O_d) - 1                    (bps)
  night_d = P(O_next) / P(C_d) - 1                 (bps; next = next trading day; row keyed by the close date d)
  span_d  = calendar days from d to next (1 = weekday night, > 1 = weekend/holiday night)
Net night = night - (half spread at C_d + half spread at O_next, window medians of (ask_c - bid_c) / mid of the bars used)
            - 3%/365 x span x 1e4.

  python night38.py check | counts | register | amend "<reason>" | run
"""
import os, sys, json, time, sqlite3, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out"); os.makedirs(OUT, exist_ok=True)
sys.path.insert(0, ENG)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from pandas.tseries.holiday import (AbstractHolidayCalendar, Holiday, USMartinLutherKingJr, USPresidentsDay, GoodFriday,  # noqa: E402
                                    USMemorialDay, USLaborDay, USThanksgivingDay, nearest_workday, sunday_to_monday)
from validate import day_boot, ci, log_trial  # noqa: E402

EXP = "night38"
DB = os.path.join(os.path.dirname(ENG), "history.db")
NY = "America/New_York"
INSTS = ["SPX500/USD", "NAS100/USD", "US30/USD"]
PRIMARY = "SPX500/USD"
CUT = "2026-10-09"                     # close dates strictly before; data ends 2026-10-09 04:18 UTC
WINS = {"dev": ("2018-01-01", "2022-12-31"), "w2023": ("2023-01-01", CUT)}
OPEN, CLOSE, EARLY = 9 * 60 + 30, 16 * 60, 13 * 60
STALE = 2                              # minutes
FIN = 0.03                             # financing per year, charged per calendar day spanned
REPS, BLOCK, SEED = 1000, 5, 38
TAG = lambda s: s.replace("/", "_")
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()


class NYSE(AbstractHolidayCalendar):
    rules = [Holiday("NewYear", month=1, day=1, observance=sunday_to_monday), USMartinLutherKingJr, USPresidentsDay,
             GoodFriday, USMemorialDay, Holiday("Juneteenth", month=6, day=19, start_date="2022-01-01", observance=nearest_workday),
             Holiday("July4", month=7, day=4, observance=nearest_workday), USLaborDay, USThanksgivingDay,
             Holiday("Christmas", month=12, day=25, observance=nearest_workday)]


def calendar(a="2018-01-01", b=CUT):
    """Trading days and their close minute-of-day (ET)."""
    hol = set(NYSE().holidays(a, b)) | {pd.Timestamp("2018-12-05"), pd.Timestamp("2025-01-09")}
    days = pd.DatetimeIndex([d for d in pd.bdate_range(a, b) if d not in hol and d < pd.Timestamp(b)])
    tg = set(NYSE().holidays(a, b, return_name=True).loc[lambda s: s == "Thanksgiving Day"].index)
    early = set()
    for d in days:
        if (d - pd.Timedelta(days=1)) in tg or (d.month, d.day) in ((12, 24), (7, 3)):
            early.add(d)
    close = np.array([EARLY if d in early else CLOSE for d in days])
    return days, close, early


def utc_min(days, mod):
    """UTC epoch minutes of ET wall time days + mod minutes (DST per date)."""
    loc = (days + pd.to_timedelta(mod, unit="m")).tz_localize(NY)
    return loc.tz_convert("UTC").tz_localize(None).to_numpy().astype("datetime64[m]").astype(np.int64)


def load(inst):
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = con.execute("select time, bid_c, ask_c from candles_ba where instrument=? and granularity='M1' "
                       "and substr(time,12,2) between '13' and '20'", (inst,)).fetchall()
    con.close()
    t = np.array([r[0][:16] for r in rows], "datetime64[m]").astype(np.int64)
    bid = np.array([r[1] for r in rows], float); ask = np.array([r[2] for r in rows], float)
    return t, bid, ask


def price_at(t, bid, ask, T):
    """Mid, spread bps at clock minutes T: latest bar starting in [T-1-STALE, T-1]; NaN if none."""
    o = np.argsort(t); t, bid, ask = t[o], bid[o], ask[o]
    j = np.searchsorted(t, T - 1, side="right") - 1
    ok = (j >= 0) & (t[np.clip(j, 0, None)] >= T - 1 - STALE)
    jj = np.clip(j, 0, None)
    mid = np.where(ok, (bid[jj] + ask[jj]) / 2, np.nan)
    spr = np.where(ok, (ask[jj] - bid[jj]) / mid * 1e4, np.nan)
    return mid, spr


def table(t, bid, ask, days, close):
    """One row per trading day d: day return, night return to the next trading day, span, spreads."""
    pO, sO = price_at(t, bid, ask, utc_min(days, np.full(len(days), OPEN)))
    pC, sC = price_at(t, bid, ask, utc_min(days, close))
    T = pd.DataFrame(index=days)
    T["pO"], T["pC"], T["sO"], T["sC"] = pO, pC, sO, sC
    T["day"] = (pC / pO - 1) * 1e4
    nxt = np.r_[days[1:], [pd.NaT]]
    T["span"] = (pd.DatetimeIndex(nxt) - days).days
    T["pO_next"] = np.r_[pO[1:], np.nan]
    T["sO_next"] = np.r_[sO[1:], np.nan]
    T["night"] = (T["pO_next"] / T["pC"] - 1) * 1e4
    T["early"] = close != CLOSE
    T = T.iloc[:-1]                                    # last row has no next open inside the data
    return T


def in_win(idx, w):
    a, b = WINS[w]
    return (idx >= pd.Timestamp(a)) & (idx <= pd.Timestamp(b)) & (idx < pd.Timestamp(CUT))


def boot(W, m, all_days):
    """Night, day, night-day, hit, net night on rows m of window table W; day-block CIs over all trading days."""
    V = W[m]
    nt, dy, net = V["night"].to_numpy(), V["day"].to_numpy(), V["net"].to_numpy()
    day = V.index.to_numpy().astype("datetime64[D]").astype(np.int64)
    f = lambda i: [np.nanmean(nt[i]), np.nanmean(dy[i]), np.nanmean(nt[i]) - np.nanmean(dy[i]),
                   np.nanmean(nt[i][np.isfinite(nt[i])] > 0), np.nanmean(net[i])]
    est = f(np.arange(len(V)))
    B = day_boot(day, all_days, f, reps=REPS, block=BLOCK, seed=SEED)
    r = dict(n_night=int(np.isfinite(nt).sum()), n_day=int(np.isfinite(dy).sum()))
    for j, nm in enumerate(("night", "day", "diff", "hit", "net")):
        r[nm] = dict(mean=float(est[j]), ci=ci(B[:, j]), mde80=float(2.8 * np.nanstd(B[:, j])),
                     p_le0=float((B[:, j] <= (0.5 if nm == "hit" else 0)).mean()))
    r["net_ann_pct"] = float(est[4] * 252 / 100)
    r["night_ann_pct"] = float(est[0] * 252 / 100)
    return r


def evaluate(inst, days, close):
    t, bid, ask = load(inst)
    T = table(t, bid, ask, days, close)
    out = dict(inst=inst, bars=int(len(t)))
    for w in WINS:
        W = T[in_win(T.index, w)].copy()
        all_days = W.index.to_numpy().astype("datetime64[D]").astype(np.int64)
        valid_n = W["night"].notna()
        half = (W.loc[valid_n, "sC"].median() + W.loc[valid_n, "sO_next"].median()) / 2
        W["net"] = W["night"] - half - FIN / 365 * W["span"] * 1e4
        r = dict(trading_days=int(len(W)), night_valid=int(valid_n.sum()), day_valid=int(W["day"].notna().sum()),
                 skip_open=int(W["pO"].isna().sum()), skip_close=int(W["pC"].isna().sum()),
                 skip_night=int((~valid_n).sum()), early_close_days=int(W["early"].sum()),
                 spread_close_med=float(W.loc[valid_n, "sC"].median()), spread_open_med=float(W.loc[valid_n, "sO_next"].median()),
                 cost_rt_bps=float(half), fin_weekday_bps=FIN / 365 * 1e4)
        r["all"] = boot(W, np.ones(len(W), bool), all_days)
        r["weekday"] = boot(W, (W["span"] == 1).to_numpy(), all_days)
        r["weekend"] = boot(W, (W["span"] > 1).to_numpy(), all_days)
        r["prev_up"] = boot(W, (W["day"] > 0).to_numpy(), all_days)
        r["prev_dn"] = boot(W, (W["day"] < 0).to_numpy(), all_days)
        out[w] = r
    yr = T.groupby(T.index.year)
    out["yearly"] = {int(y): dict(n=int(g["night"].notna().sum()), night=float(g["night"].mean()), day=float(g["day"].mean()),
                                  night_sum=float(g["night"].sum()), day_sum=float(g["day"].sum()))
                     for y, g in yr}
    return out


def verdict(res):
    spx = next(x for x in res if x["inst"] == PRIMARY)
    lb = {w: spx[w]["all"]["night"]["ci"][0] for w in WINS}
    d = {w: spx[w]["all"]["diff"]["mean"] for w in WINS}
    return ("PASS" if all(v > 0 for v in lb.values()) and all(v > 0 for v in d.values()) else "FAIL"), lb, d


def report(Z):
    f = lambda x: f"{x['mean']:+.2f} [{x['ci'][0]:+.2f},{x['ci'][1]:+.2f}]"
    L = [f"VERDICT {Z['verdict']}  night CI lb {Z['night_lb']}  night-day point {Z['diff_point']}", ""]
    for r in Z["results"]:
        for w in WINS:
            x = r[w]
            L.append(f"{r['inst']} {w}: trading days {x['trading_days']}, night valid {x['night_valid']}, day valid {x['day_valid']}, "
                     f"skip open {x['skip_open']}, skip close {x['skip_close']}, early-close days {x['early_close_days']}, "
                     f"median spread close {x['spread_close_med']:.2f} open {x['spread_open_med']:.2f} bps, rt cost {x['cost_rt_bps']:.2f} bps")
            for k in ("all", "weekday", "weekend", "prev_up", "prev_dn"):
                y = x[k]
                L.append(f"  {k:8s} n {y['n_night']:5d}/{y['n_day']:5d} night {f(y['night'])} day {f(y['day'])} diff {f(y['diff'])} "
                         f"hit {y['hit']['mean']:.3f} net {f(y['net'])} net/yr {y['net_ann_pct']:+.1f}% gross/yr {y['night_ann_pct']:+.1f}% "
                         f"MDE80 night {y['night']['mde80']:.2f} diff {y['diff']['mde80']:.2f}")
        L.append(f"  yearly night/day mean bps: " + "; ".join(f"{y} {v['night']:+.2f}/{v['day']:+.2f} (n {v['n']})"
                                                         for y, v in r["yearly"].items()))
        L.append("")
    open(os.path.join(OUT, "report.txt"), "w").write("\n".join(L) + "\n")
    print("\n".join(L))


def run():
    days, close, _ = calendar()
    res = []
    for inst in INSTS:
        r = evaluate(inst, days, close); res.append(r)
        for w in WINS:
            for k in ("all", "weekday", "weekend", "prev_up", "prev_dn"):
                y = r[w][k]
                log_trial(dict(exp=EXP, unit=TAG(inst), tf="M1", cell=k, window=w, primary=(inst == PRIMARY and k == "all"),
                               n=y["n_night"], night_bps=y["night"]["mean"], night_ci=y["night"]["ci"], day_bps=y["day"]["mean"],
                               diff_bps=y["diff"]["mean"], diff_ci=y["diff"]["ci"], hit=y["hit"]["mean"], net_bps=y["net"]["mean"],
                               mde80_night=y["night"]["mde80"]))
        print(inst, "done", flush=True)
    v, lb, d = verdict(res)
    Z = dict(verdict=v, night_lb=lb, diff_point=d, results=res)
    json.dump(Z, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    report(Z)


def counts():
    """Pre-outcome: availability counts only (no return is computed)."""
    days, close, early = calendar()
    rows = {}
    for inst in INSTS:
        t, bid, ask = load(inst)
        pO, _ = price_at(t, bid, ask, utc_min(days, np.full(len(days), OPEN)))
        pC, _ = price_at(t, bid, ask, utc_min(days, close))
        okO, okC = np.isfinite(pO), np.isfinite(pC)
        rows[inst] = {}
        for w in WINS:
            m = in_win(days, w)[:-1]
            nightok = okC[:-1] & okO[1:]
            rows[inst][w] = dict(trading_days=int(m.sum()), night_valid=int((m & nightok).sum()), day_valid=int((m & okO[:-1] & okC[:-1]).sum()),
                                 skip_open=int((m & ~okO[:-1]).sum()), skip_close=int((m & ~okC[:-1]).sum()),
                                 weekend_nights=int((m & (np.diff(days.to_numpy().astype("datetime64[D]").astype(np.int64)) > 1)).sum()))
        print(inst, len(t), rows[inst], flush=True)
    json.dump(rows, open(os.path.join(OUT, "counts.json"), "w"), indent=1)


def check():
    days, close, early = calendar("2024-01-01", "2025-01-15")
    ds = set(days.strftime("%Y-%m-%d"))
    for h in ("2024-01-01", "2024-01-15", "2024-03-29", "2024-05-27", "2024-06-19", "2024-07-04", "2024-09-02", "2024-11-28",
              "2024-12-25", "2025-01-01", "2025-01-09"):
        assert h not in ds, h
    assert {d.strftime("%Y-%m-%d") for d in early} == {"2024-07-03", "2024-11-29", "2024-12-24"}, early
    # DST: 09:30 ET is 14:30 UTC on 2024-03-08 and 13:30 UTC on 2024-03-11
    u = utc_min(pd.DatetimeIndex(["2024-03-08", "2024-03-11"]), np.array([OPEN, OPEN]))
    assert [str(np.datetime64(int(x), "m")) for x in u] == ["2024-03-08T14:30", "2024-03-11T13:30"]
    # clock lookup and staleness: bars at T-1 preferred, T-3 accepted, T-4 rejected, bars at T ignored
    T0 = 1_000_000
    t = np.array([T0 - 4, T0 - 3, T0 + 10 - 1, T0 + 10, T0 + 20 - 5, T0 + 30])
    bid = np.array([1., 2., 3., 9., 5., 6.]); ask = bid + 0.02
    mid, spr = price_at(t, bid, ask, np.array([T0, T0 + 10, T0 + 20, T0 + 30]))
    assert np.allclose(mid[:2], [2.01, 3.01]) and np.isnan(mid[2]) and np.isnan(mid[3]), mid
    assert abs(spr[0] - 0.02 / 2.01 * 1e4) < 1e-9
    # synthetic table: Fri 2024-03-08 -> Mon 2024-03-11 (DST change) and Mon -> Tue
    dd = pd.DatetimeIndex(["2024-03-08", "2024-03-11", "2024-03-12"]); cl = np.array([CLOSE] * 3)
    pts = {("2024-03-08", OPEN): 100., ("2024-03-08", CLOSE): 101., ("2024-03-11", OPEN): 102., ("2024-03-11", CLOSE): 100.,
           ("2024-03-12", OPEN): 99., ("2024-03-12", CLOSE): 99.}
    tt, bb = [], []
    for (d, mm), p in pts.items():
        tt.append(utc_min(pd.DatetimeIndex([d]), np.array([mm - 1]))[0]); bb.append(p - 0.01)
    tt, bb = np.array(tt), np.array(bb)
    T = table(tt, bb, bb + 0.02, dd, cl)
    assert len(T) == 2 and list(T["span"]) == [3, 1]
    assert abs(T["day"].iloc[0] - 100) < 1e-9 and abs(T["night"].iloc[0] - (102 / 101 - 1) * 1e4) < 1e-9
    assert abs(T["night"].iloc[1] - (99 / 100 - 1) * 1e4) < 1e-9
    print("check ok")


def codeshas():
    return {"night38.py": sha(os.path.join(HERE, "night38.py")), "validate.py": sha(os.path.join(ENG, "validate.py"))}


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
