"""fade31: after a fast move WITHOUT a news burst, does fading it (entering against the move) make money before spread?

Definitions reused unchanged:
  fast move  updown.features (port of nowMotion in scripts/local-predict.mjs): run of same-direction closed mid bars capped
             at 6, move = (close - open of run start) / supertrend ATR(10); fast = |move| >= 1.5. Signal = the first bar of
             a same-sign streak that is fast (one signal per streak).
  news burst news24.news_features + news24.classify (relevance.json, share z >= 2.0, >= 5 relevant articles in the two
             15-minute files at or before the bar close, 14-day baseline). Missing files -> excluded, counted.
  bars       news24 cache (bid/ask/mid OHLC, production ATR 10).
  trade      labels_v2.simulate, entry against the move at the next bar open; R = 1.0 ATR; stop -1 R, target +0.5 R
             (m = T = 0.5: the arm level equals the target), time exit at the close of bar 6. Gross = mid bars (primary),
             net = bid/ask. One open trade per instrument (sequential over all signals, gross exit bar of the variant).

  python fade31.py check | register | amend "<reason>" | plumb | run
"""
import os, sys, json, time, hashlib, importlib.util
HERE = os.path.dirname(os.path.abspath(__file__))
AUD = os.path.dirname(HERE); ENG = os.path.dirname(AUD)
OUT = os.path.join(HERE, "out"); os.makedirs(OUT, exist_ok=True)
sys.path[:0] = [ENG, os.path.join(AUD, "news24")]
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import events as ev  # noqa: E402
import news24 as n24  # noqa: E402
from labels_v2 import simulate  # noqa: E402
from validate import day_boot, ci, day_of, log_trial  # noqa: E402

UPDOWN = "/Users/mfittko/github/market-signals/.claude/worktrees/agent-a40011b354d14aac5/data/research/localpred/updown.py"
_s = importlib.util.spec_from_file_location("updown", UPDOWN); U = importlib.util.module_from_spec(_s); _s.loader.exec_module(U)

EXP = "fade31"
INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "NATGAS/USD", "SPX500/USD", "EUR/USD"]
TFS = ["M5", "M1", "M15"]
FAST = 1.5
W_DEV = (np.datetime64("2019-01-01", "m").astype(np.int64), np.datetime64("2023-01-01", "m").astype(np.int64))
W23 = W_DEV[1]
VAR = {"P": dict(k=1.0, m=0.5, T=0.5, H=6),       # primary: +0.5 R target, -1 R stop, time exit at bar 6
       "T1": dict(k=1.0, m=1.0, T=1.0, H=6),      # target 1.0 R
       "TO": None}                                # time exit only (no stop, no target): close of bar 6
H = 6
REPS, BLOCK, SEED = 1000, 5, 31
TAG = lambda s: s.replace("/", "_")
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()


def first_fast(o, c, move, valid):
    """Index of the first fast bar of each same-sign streak (a zero-body bar is its own streak)."""
    s = np.sign(c - o)
    sid = np.cumsum(np.r_[1, (s[1:] != s[:-1]) | (s[1:] == 0)])
    fast = valid & (np.abs(move) >= FAST)
    seen = pd.Series(fast).groupby(sid).cumsum().to_numpy()
    return np.flatnonzero(fast & (seen == 1))


def one_at_a_time(i, xb):
    """Keep signals in time order whose entry bar (i+1) comes after the exit bar of the last kept trade."""
    keep, last = np.zeros(len(i), bool), -1
    for k in range(len(i)):
        if i[k] + 1 > last:
            keep[k] = True; last = xb[k]
    return keep


def time_only(B, i, side, atr):
    e, x = i + 1, i + H
    n = len(B["bid_o"]); ok = x < n
    e, x = np.clip(e, 0, n - 1), np.clip(x, 0, n - 1)
    entry = np.where(side > 0, B["ask_o"][e], B["bid_o"][e]); exitp = np.where(side > 0, B["bid_c"][x], B["ask_c"][x])
    return dict(net_R=np.where(ok, side * (exitp - entry) / atr, np.nan), exit_bar=x, ok=ok & np.isfinite(atr) & (atr > 0))


def trades(B, i, side, var):
    atr = B["atr"][i]
    Bm = {f"{s}_{k}": B["mid_" + k] for s in ("bid", "ask") for k in "ohlc"}
    if VAR[var] is None:
        g, nt = time_only(Bm, i, side, atr), time_only(B, i, side, atr)
    else:
        z = np.zeros(len(B["t"]), int)
        g, nt = simulate(Bm, i, side, atr, z, VAR[var]), simulate(B, i, side, atr, z, VAR[var])
    ok = g["ok"] & nt["ok"]
    return np.where(ok, g["net_R"], np.nan), np.where(ok, nt["net_R"], np.nan), g["exit_bar"], ok


def build(inst, tf, N):
    B = ev.load(inst, tf); step = int(B["step"])
    b = pd.DataFrame({"t": B["t"], "o": B["mid_o"], "h": B["mid_h"], "l": B["mid_l"], "c": B["mid_c"], "v": B["volume"]})
    f = U.features(b, step)
    assert np.nanmax(np.abs(f["atr"] - B["atr"])) < 1e-9, "updown ATR != production ATR"
    i = first_fast(B["mid_o"], B["mid_c"], f["move"], f["valid"])
    i = i[(B["t"][i] >= W_DEV[0]) & (i + H < len(B["t"]))]
    side = -np.sign(f["move"][i]).astype(np.int64)            # fade: against the move
    close = B["t"][i] + step
    F = n24.news_features(close, inst, N)
    ok, news, ctrl = n24.classify(F)
    grp = np.where(news, "news", np.where(ctrl, "nonews", "excl"))
    R = dict(i=i, side=side, t=B["t"][i], day=day_of(B["t"][i]), grp=grp, z=F[:, 0], move=f["move"][i],
             spr=(B["ask_c"][i] - B["bid_c"][i]) / B["atr"][i], all_t=B["t"])
    return B, R


def win(t):
    t = np.asarray(t)
    return np.where(t >= W23, "w2023", np.where(t >= W_DEV[0], "dev", ""))


def mean_ci(x, day, all_days):
    x = np.asarray(x, float)
    if len(x) < 2:
        return dict(n=int(len(x)), mean=float(x.mean()) if len(x) else None)
    bs = day_boot(day, all_days, lambda ix: x[ix].mean(), reps=REPS, block=BLOCK, seed=SEED)
    return dict(n=int(len(x)), days=int(len(np.unique(day))), mean=float(x.mean()), ci=ci(bs), sd=float(np.nanstd(bs)),
                mde80=float(2.8 * np.nanstd(bs)), hit=float((x > 0).mean()), p_le0=float(np.mean(bs[np.isfinite(bs)] <= 0)))


def diff_ci(x, a, b, day, all_days):
    """mean(x[a]) - mean(x[b]) with day-block CI."""
    if a.sum() < 2 or b.sum() < 2:
        return None
    def st(ix):
        aa, bb = a[ix], b[ix]
        return x[ix][aa].mean() - x[ix][bb].mean() if aa.any() and bb.any() else np.nan
    bs = day_boot(day, all_days, st, reps=REPS, block=BLOCK, seed=SEED)
    return dict(diff=float(x[a].mean() - x[b].mean()), ci=ci(bs), mde80=float(2.8 * np.nanstd(bs)))


def analyse(inst, tf, N, outcomes=True):
    B, R = build(inst, tf, N)
    res = dict(inst=inst, tf=tf)
    wn = win(R["t"])
    for w in ("dev", "w2023"):
        m = wn == w
        res[w] = dict(signals={g: int((m & (R["grp"] == g)).sum()) for g in ("nonews", "news", "excl")})
    if not outcomes:
        return res
    alld = day_of(R["all_t"])
    for var in VAR:
        g, nt, xb, ok = trades(B, R["i"], R["side"], var)
        kept = one_at_a_time(R["i"], np.where(ok, xb, R["i"] + H))
        u = kept & ok
        for w in ("dev", "w2023"):
            m = u & (wn == w)
            ad = np.unique(alld[win(R["all_t"]) == w])
            r = dict(kept={gg: int((m & (R["grp"] == gg)).sum()) for gg in ("nonews", "news", "excl")}, trading_days=int(len(ad)))
            for gg, sel in (("nonews", R["grp"] == "nonews"), ("news", R["grp"] == "news"), ("all", np.ones(len(m), bool)),
                            ("covered", R["grp"] != "excl")):
                mm = m & sel
                r[gg] = dict(gross=mean_ci(g[mm], R["day"][mm], ad), net=mean_ci(nt[mm], R["day"][mm], ad),
                             per_day=float(mm.sum() / len(ad)))
            mc = m & (R["grp"] != "excl")
            r["news_minus_nonews"] = diff_ci(g[mc], R["grp"][mc] == "news", R["grp"][mc] == "nonews", R["day"][mc], ad)
            res[w][var] = r
            log_trial(dict(exp=EXP, cell=f"{tf}|{var}|nonews", unit=TAG(inst), window=w,
                           primary=(inst == "WTICO/USD" and tf == "M5" and var == "P"),
                           mode="dev" if w == "dev" else "devwindow2023",
                           n=r["nonews"]["gross"]["n"], gross=r["nonews"]["gross"].get("mean"), gross_ci=r["nonews"]["gross"].get("ci"),
                           net=r["nonews"]["net"].get("mean"), news_minus_nonews=r["news_minus_nonews"]))
    return res


def verdict(r):
    return "PASS" if all(r[w]["P"]["nonews"]["gross"].get("ci", [0])[0] > 0 for w in ("dev", "w2023")) else "FAIL"


def main(mode):
    N = n24.news_table()
    out = []
    for tf in TFS:
        for inst in INSTS:
            r = analyse(inst, tf, N, outcomes=(mode == "run"))
            out.append(r)
            print(tf, inst, {w: r[w]["signals"] for w in ("dev", "w2023")}, flush=True)
            if mode == "run":
                json.dump(out, open(os.path.join(OUT, "partial.json"), "w"), default=float)
    if mode == "plumb":
        json.dump(out, open(os.path.join(OUT, "plumb.json"), "w"), indent=1); return
    P = next(r for r in out if r["inst"] == "WTICO/USD" and r["tf"] == "M5")
    v = verdict(P)
    log_trial(dict(exp=EXP, cell="PRIMARY|M5|P|nonews", unit="WTICO_USD", verdict=v))
    json.dump(dict(verdict=v, results=out, code_sha256=codeshas()), open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    print("VERDICT", v)


def codeshas():
    return {"fade31.py": sha(os.path.join(HERE, "fade31.py")), "updown.py": sha(UPDOWN),
            "news24.py": sha(os.path.join(AUD, "news24", "news24.py")), "events.py": sha(os.path.join(AUD, "news24", "events.py")),
            "relevance.json": sha(os.path.join(AUD, "news24", "relevance.json")), "labels_v2.py": sha(os.path.join(ENG, "labels_v2.py")),
            "validate.py": sha(os.path.join(ENG, "validate.py"))}


def check():
    # streaks: up up(fast) up(fast) | down(fast) | zero | up(fast)
    o = np.array([0, 1, 2, 3, 2, 2, 2.0]); c = np.array([1, 2, 3, 2, 2, 3, 3.0])
    move = np.array([0.5, 1.6, 2.0, -1.6, 0, 1.5, 0]); valid = np.ones(7, bool)
    assert list(first_fast(o, c, move, valid)) == [1, 3, 5]
    assert list(one_at_a_time(np.array([0, 3, 6, 7]), np.array([6, 9, 12, 13]))) == [True, False, True, False]
    assert list(one_at_a_time(np.array([0, 6]), np.array([5, 9]))) == [True, True]
    # simulate with the primary variant: target +0.5 R, stop -1 R, time exit at the close of bar 6
    def mk(rows):
        a = np.array(rows, float)
        return {f"{s}_{k}": a[:, j] for s in ("bid", "ask") for j, k in enumerate("ohlc")}
    z = np.zeros(20, int)
    tgt = mk([[100] * 4, [100, 100.6, 99.9, 100.2]] + [[100] * 4] * 8)
    stp = mk([[100] * 4, [100, 100.1, 98.9, 99.0]] + [[100] * 4] * 8)
    tim = mk([[100] * 4] + [[100, 100.2, 99.8, 100]] * 5 + [[100, 100.2, 99.8, 100.3]] + [[100] * 4] * 3)
    run = lambda B, s=1: {k: v[0] for k, v in simulate(B, [0], [s], [1.0], z, VAR["P"]).items()}
    assert abs(run(tgt)["net_R"] - 0.5) < 1e-12
    assert abs(run(stp)["net_R"] + 1) < 1e-12
    r = run(tim); assert abs(r["net_R"] - 0.3) < 1e-12 and r["exit_bar"] == 6, r
    assert abs(time_only(tim, np.array([0]), np.array([1]), np.array([1.0]))["net_R"][0] - 0.3) < 1e-12
    assert abs(run(stp, -1)["net_R"] - 0.5) < 1e-12  # short side: the drop bar hits the short target
    n24.selfcheck()
    print("fade31 check ok")


def register(amend=None):
    f = os.path.join(HERE, "prereg.json")
    if amend:
        reg = json.load(open(f))
        reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=amend, code_sha256=codeshas()))
        json.dump(reg, open(f, "w"), indent=1); print("amended"); return
    assert not os.path.exists(f), "prereg.json exists (use amend)"
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="fade31: fade fast moves without a news burst (gross mid R); issue 310",
        before_registration="No outcome computed. Before this file: synthetic self-checks and signal/coverage counts only (no prices "
                            "after the signal bar). WTI M5 fast-move signals since 2019: 55,040; with both GDELT files present: 6,680 "
                            "(219 news). Prior knowledge: updown tables (fast moves lean back ~4-5 pp over 6 M5 bars), flow29 "
                            "(heavy order flow reverses 5.1 pp, -0.16 ATR), news24 (news-backed strong candles tended to continue, "
                            "within noise).",
        declared="Development evidence only. 2023+ is a development window, not a holdout.",
        code_sha256=codeshas(),
        data="news24 cache (engine history.db M1 bid/ask, resampled; production supertrend ATR 10), 2019-01-01 .. 2026-10-07 18:30 UTC; "
             "news24.db read-only.",
        fast_move="updown.features on mid bars (nowMotion port): run of same-sign closed bars capped at 6, move = (close - open of run "
                  "start) / ATR(10), fast = |move| >= 1.5. Signal = first fast bar of each same-sign streak (zero-body bar = own streak).",
        news="news24.news_features + classify at the signal bar close: NEWS = share z >= 2.0 and >= 5 relevant articles (two newest "
             "15-min files <= close, 14-day 4-hourly baseline >= 40 files). Missing files or baseline -> EXCLUDED from both groups, counted.",
        coverage_caveat="GDELT files exist only on the news24 4-hourly grid and around news24 candidate events, so the covered "
                        "subset (~12% of WTI M5 signals) is selected toward bars near strong high-volume candles. Reported as is.",
        trade="entry against the move at the next bar open; labels_v2.simulate with k=1.0 (R = 1 ATR), m=T=0.5 (target +0.5 R), stop "
              "-1 R, H=6 (time exit at the close of bar 6), no flip exit. Gross = mid bars (primary); net = bid/ask (secondary). "
              "Trades kept where both are uncensored. One open trade per instrument: signals in time order over all groups, a "
              "signal is skipped while the previous kept trade (its gross exit bar) is open.",
        windows=dict(dev="2019-01-01 .. 2022-12-31", w2023="2023-01-01 .. 2026-10-07 (development window, not a holdout)"),
        primary="WTICO/USD M5, NO-NEWS fades, gross mean R per trade. validate.day_boot over all trading days of the window, block 5, "
                "1000 reps, seed 31, percentile 95% CI.",
        pass_rule="PASS iff the CI lower bound is above 0 in BOTH windows. Otherwise FAIL.",
        key_secondary="news-backed minus no-news fades, gross mean R difference with day-block CI, per window (operator rule "
                      "'don't fade news': supported if the difference is negative with CI upper bound < 0).",
        secondary="net (bid/ask); target 1.0 R (k=1, m=T=1.0); time exit only (close of bar 6 minus next open, no stop or target); M1 "
                  "and M15; XAU, XAG, NATGAS, SPX500, EUR/USD; hit rate (R > 0); trades per day; MDE80 = 2.8 x bootstrap SD; all "
                  "signals including EXCLUDED (coverage-free context). Never decide the verdict. No multiplicity correction claimed.",
        bootstrap=dict(fn="validate.day_boot", reps=REPS, block=BLOCK, seed=SEED),
    )
    json.dump(reg, open(f, "w"), indent=1); print("registered", sha(f))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "check":
        check()
    elif mode == "register":
        register()
    elif mode == "amend":
        register(amend=sys.argv[2])
    elif mode in ("plumb", "run"):
        main(mode)
