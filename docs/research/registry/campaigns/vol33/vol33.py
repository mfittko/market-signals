"""vol33: extreme tick volume as climax (fade a fast move) or absorption (trade the wick rejection).

Volume ratio v = bar tick volume / median volume of the same UTC time-of-day slot over the prior 20 trading days
(>= 10 such bars, else no v). Extreme thresholds = percentiles of v over the trailing 250 trading days before the
bar's trading day (no lookahead; at least 60 trading days of history, so early 2018 uses a shorter window).
  H1 climax      fast move (updown.features: run of same-sign bars capped at 6, |move| >= 1.5 ATR(10)) whose last bar
                 has v >= trailing 99th pct. Trade AGAINST the run at the next bar open.
  H2 absorption  v >= trailing 98th pct, mid body <= 25% of the mid range, wicks differ by more than 10% of the longer
                 wick. Long if the lower wick is longer, short if the upper wick is longer. Next bar open.
  trade          labels_v2.simulate k=1 (stop 1 ATR = 1 R), m=T=1 (target +1 R), H=12 (time exit at the close of
                 bar 12), no flip exit. Gross = mid (primary), net = bid/ask. One open trade per instrument per strategy.
  H3 (side-free) mean (max high - min low over bars i+1..i+12) / ATR at v >= 98th pct, over the hour-matched mean of
                 bars with v inside the trailing 25th..75th pct. Ratio with a day-block CI.

  python vol33.py check | plumb | register | amend "<reason>" | run
"""
import os, sys, json, time, hashlib, importlib.util
HERE = os.path.dirname(os.path.abspath(__file__))
AUD = os.path.dirname(HERE); ENG = os.path.dirname(AUD)
OUT = os.path.join(HERE, "out"); os.makedirs(OUT, exist_ok=True)
sys.path[:0] = [ENG, os.path.join(AUD, "news24")]
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import events as ev  # noqa: E402
from labels_v2 import simulate  # noqa: E402
from validate import day_boot, ci, day_of, log_trial as _log  # noqa: E402

UPDOWN = "/Users/mfittko/github/market-signals/.claude/worktrees/agent-a40011b354d14aac5/data/research/localpred/updown.py"
_s = importlib.util.spec_from_file_location("updown", UPDOWN); U = importlib.util.module_from_spec(_s); _s.loader.exec_module(U)

log_trial = (lambda rec: None) if os.environ.get("VOL33_NOLOG") else _log   # rerun after a fix: no duplicate ledger rows
EXP = "vol33"
INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "NATGAS/USD", "SPX500/USD", "EUR/USD"]
TFS = ["M5", "M1", "M15"]
FAST, BODY_MAX, WICK_TIE = 1.5, 0.25, 0.10
SLOT_N, SLOT_MIN = 20, 10
THR_N, THR_MIN = 250, 60
QS = [25.0, 75.0, 95.0, 98.0, 99.0, 99.5]
PRIM_Q = {"H1": 99.0, "H2": 98.0}
SEC_Q = [99.5, 95.0]                 # top 0.5% and top 5%, both hypotheses
H3_Q = [98.0, 99.5, 95.0]
VAR = dict(k=1.0, m=1.0, T=1.0, H=12)
H = 12
T0 = np.datetime64("2018-01-01", "m").astype(np.int64)
T23 = np.datetime64("2023-01-01", "m").astype(np.int64)
WINS = ("dev", "w2023")
REPS, BLOCK, SEED, ALPHA = 1000, 5, 33, 0.025      # one-sided alpha = 95% two-sided CI
TAG = lambda s: s.replace("/", "_")
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()


# ------------------------------------------------------------------ pure helpers
def vol_ratio(t, vol, step):
    """v = volume / median of the same UTC slot over the previous SLOT_N trading days (>= SLOT_MIN bars present)."""
    d = day_of(t); days, r = np.unique(d, return_inverse=True)
    slot = (t % 1440) // step
    M = np.full((len(days), 1440 // step), np.nan); M[r, slot] = vol
    med = pd.DataFrame(M).rolling(SLOT_N, min_periods=SLOT_MIN).median().shift(1).to_numpy()[r, slot]
    return np.where(med > 0, vol / med, np.nan)


def trailing_q(t, v):
    """Per bar: percentiles QS of v over the previous THR_N trading days (excluding the bar's own day)."""
    d = day_of(t); days, r = np.unique(d, return_inverse=True)
    start = np.searchsorted(r, np.arange(len(days)))
    out = np.full((len(days), len(QS)), np.nan)
    for k in range(THR_MIN, len(days)):
        x = v[start[max(0, k - THR_N)]:start[k]]
        x = x[np.isfinite(x)]
        if len(x) >= 100:
            out[k] = np.percentile(x, QS)
    return out[r]


def wick_side(o, h, l, c):
    """+1 long (lower wick longer), -1 short (upper wick longer), 0 if the body is too large or the wicks are tied."""
    rng = h - l; uw = h - np.maximum(o, c); lw = np.minimum(o, c) - l
    ok = (rng > 0) & (np.abs(c - o) <= BODY_MAX * rng) & (np.abs(uw - lw) > WICK_TIE * np.maximum(uw, lw))
    return np.where(ok, np.sign(lw - uw), 0).astype(np.int64)


def one_at_a_time(i, xb):
    """Keep signals in time order whose entry bar (i+1) comes after the exit bar of the last kept trade."""
    keep, last = np.zeros(len(i), bool), -1
    for k in range(len(i)):
        if i[k] + 1 > last:
            keep[k] = True; last = xb[k]
    return keep


def holm(p):
    p = np.asarray(p, float); o = np.argsort(p); m = len(p)
    adj = np.maximum.accumulate((m - np.arange(m)) * p[o]); out = np.empty(m); out[o] = np.minimum(adj, 1)
    return out


def range12(B, step):
    """(max mid high - min mid low over bars i+1..i+H) / ATR_i; NaN if the H bars are not contiguous."""
    n = len(B["t"]); r = np.full(n, np.nan)
    sw = np.lib.stride_tricks.sliding_window_view
    hi = sw(B["mid_h"][1:], H).max(1); lo = sw(B["mid_l"][1:], H).min(1)
    m = len(hi)
    contig = B["t"][H:H + m] - B["t"][:m] == H * step
    r[:m] = np.where(contig, (hi - lo) / B["atr"][:m], np.nan)
    return r


# ------------------------------------------------------------------ build
def feats(inst, tf):
    f = os.path.join(OUT, f"feat_{TAG(inst)}_{tf}.npz")
    B = ev.load(inst, tf); step = int(B["step"])
    if os.path.exists(f):
        z = np.load(f); return B, {k: z[k] for k in z.files}
    b = pd.DataFrame({"t": B["t"], "o": B["mid_o"], "h": B["mid_h"], "l": B["mid_l"], "c": B["mid_c"], "v": B["volume"]})
    u = U.features(b, step)
    assert np.nanmax(np.abs(u["atr"] - B["atr"])) < 1e-9, "updown ATR != production ATR"
    v = vol_ratio(B["t"], B["volume"].astype(float), step)
    F = dict(v=v, q=trailing_q(B["t"], v), move=u["move"], valid=u["valid"])
    np.savez(f, **F)
    return B, F


def signals(B, F):
    """Signal bars and sides per strategy name (no outcomes)."""
    n = len(B["t"]); v, q = F["v"], F["q"]
    base = np.isfinite(v) & np.isfinite(q[:, 0]) & (B["t"] >= T0) & (np.arange(n) + H < n) & np.isfinite(B["atr"]) & (B["atr"] > 0)
    fast = base & F["valid"] & (np.abs(F["move"]) >= FAST)
    fade = -np.sign(np.nan_to_num(F["move"])).astype(np.int64)
    ws = wick_side(B["mid_o"], B["mid_h"], B["mid_l"], B["mid_c"])
    S = {"FADEALL": (np.flatnonzero(fast), fade)}
    for qq in [99.0] + SEC_Q:
        S[f"H1q{qq}"] = (np.flatnonzero(fast & (v >= q[:, QS.index(qq)])), fade)
    for qq in [98.0] + SEC_Q:
        S[f"H2q{qq}"] = (np.flatnonzero(base & (v >= q[:, QS.index(qq)]) & (ws != 0)), ws)
    return {k: (i, s[i]) for k, (i, s) in S.items()}, base


def win(t):
    t = np.asarray(t)
    return np.where(t >= T23, "w2023", np.where(t >= T0, "dev", ""))


def trades(B, i, side):
    atr = B["atr"][i]; z = np.zeros(len(B["t"]), int)
    Bm = {f"{s}_{k}": B["mid_" + k] for s in ("bid", "ask") for k in "ohlc"}
    g, nt = simulate(Bm, i, side, atr, z, VAR), simulate(B, i, side, atr, z, VAR)
    ok = g["ok"] & nt["ok"]
    keep = one_at_a_time(i, np.where(ok, g["exit_bar"], i + H)) & ok
    return dict(i=i[keep], side=side[keep], g=g["net_R"][keep], n=nt["net_R"][keep],
                spr=((B["ask_c"] - B["bid_c"])[i[keep]] / atr[keep]))


# ------------------------------------------------------------------ statistics
def mean_ci(x, day, all_days):
    x = np.asarray(x, float)
    if len(x) < 2:
        return dict(n=int(len(x)), mean=float(x.mean()) if len(x) else None)
    bs = day_boot(day, all_days, lambda ix: x[ix].mean(), reps=REPS, block=BLOCK, seed=SEED)
    bs = bs[np.isfinite(bs)]
    return dict(n=int(len(x)), days=int(len(np.unique(day))), mean=float(x.mean()), ci=ci(bs), sd=float(np.std(bs)),
                mde80=float(2.8 * np.std(bs)), hit=float((x > 0).mean()), p_one=float(np.mean(bs <= 0)), _bs=bs)


def diff_ci(x, a, day, all_days):
    """mean(x[a]) - mean(x[~a]) with a day-block CI (rows of both groups in one array)."""
    if a.sum() < 2 or (~a).sum() < 2:
        return None
    def st(ix):
        aa = a[ix]
        return x[ix][aa].mean() - x[ix][~aa].mean() if aa.any() and (~aa).any() else np.nan
    bs = day_boot(day, all_days, st, reps=REPS, block=BLOCK, seed=SEED); bs = bs[np.isfinite(bs)]
    return dict(diff=float(x[a].mean() - x[~a].mean()), ci=ci(bs), mde80=float(2.8 * np.std(bs)))


def h3(B, F, base, rng, wn, alld):
    """Spike/normal hour-matched range ratio per window and threshold, day-block CI over day aggregates."""
    hour = (B["t"] // 60) % 24
    v, q = F["v"], F["q"]
    ok = base & np.isfinite(rng)
    normal = ok & (v >= q[:, 0]) & (v <= q[:, 1])
    res = {}
    for w in WINS:
        days = np.unique(alld[wn == w]); D = len(days)
        mw = wn == w
        dpos = np.searchsorted(days, alld)
        def agg(m):
            m = m & mw
            S = np.zeros((D, 24)); C = np.zeros((D, 24))
            np.add.at(S, (dpos[m], hour[m]), rng[m]); np.add.at(C, (dpos[m], hour[m]), 1)
            return S, C
        Ns, Nc = agg(normal)
        res[w] = {}
        for qq in H3_Q:
            Ss, Sc = agg(ok & (v >= q[:, QS.index(qq)]))
            def st(ix):
                nm = Ns[ix].sum(0) / np.where(Nc[ix].sum(0) > 0, Nc[ix].sum(0), np.nan)
                e = np.nansum(Sc[ix].sum(0) * nm)
                return Ss[ix].sum() / e if e > 0 else np.nan
            bs = day_boot(days, days, st, reps=REPS, block=BLOCK, seed=SEED); bs = bs[np.isfinite(bs)]
            res[w][f"q{qq}"] = dict(n_spike=int(Sc.sum()), n_normal=int(Nc.sum()), ratio=float(st(np.arange(D))),
                                    spike_mean=float(Ss.sum() / max(Sc.sum(), 1)), ci=ci(bs), mde80=float(2.8 * np.std(bs)))
    return res


def analyse(inst, tf, outcomes):
    B, F = feats(inst, tf)
    S, base = signals(B, F)
    wn_all = win(B["t"]); alld = day_of(B["t"])
    res = dict(inst=inst, tf=tf, signals={k: {w: int((win(B["t"][i]) == w).sum()) for w in WINS} for k, (i, s) in S.items()})
    if not outcomes:
        return res
    TR = {k: trades(B, i, s) for k, (i, s) in S.items()}
    for w in WINS:
        ad = np.unique(alld[wn_all == w])
        r = res.setdefault(w, {})
        for k, T in TR.items():
            m = win(B["t"][T["i"]]) == w
            d = alld[T["i"][m]]
            r[k] = dict(gross=mean_ci(T["g"][m], d, ad), net=mean_ci(T["n"][m], d, ad), per_day=float(m.sum() / len(ad)),
                        spr_med=float(np.median(T["spr"][m])) if m.any() else None, longs=int((T["side"][m] > 0).sum()))
        # H1 versus all fast-move fades (separate one-at-a-time sequences, rows pooled)
        a, b = TR["H1q99.0"], TR["FADEALL"]
        ma, mb = win(B["t"][a["i"]]) == w, win(B["t"][b["i"]]) == w
        x = np.r_[a["g"][ma], b["g"][mb]]; lab = np.r_[np.ones(ma.sum(), bool), np.zeros(mb.sum(), bool)]
        r["H1_minus_FADEALL"] = diff_ci(x, lab, alld[np.r_[a["i"][ma], b["i"][mb]]], ad)
    res["H3"] = h3(B, F, base, range12(B, int(B["step"])), wn_all, alld)
    return res


def primary(P):
    """Holm over H1, H2 per window on one-sided bootstrap p; adjusted lower bound at the Holm level of each rank."""
    out = {}
    for w in WINS:
        ks = ["H1q99.0", "H2q98.0"]
        ps = [P[w][k]["gross"]["p_one"] for k in ks]
        adj = holm(ps); order = np.argsort(ps)
        for rank, j in enumerate(order):
            bs = P[w][ks[j]]["gross"]["_bs"]
            out.setdefault(ks[j], {})[w] = dict(p_one=ps[j], p_holm=float(adj[j]),
                                                 lb_holm=float(np.percentile(bs, 100 * ALPHA / (2 - rank))))
    for k in out:
        out[k]["PASS"] = all(out[k][w]["p_holm"] < ALPHA and out[k][w]["lb_holm"] > 0 for w in WINS)
    return out, ("PASS" if any(out[k]["PASS"] for k in out) else "FAIL")


def strip(o):
    if isinstance(o, dict):
        return {k: strip(v) for k, v in o.items() if k != "_bs"}
    if isinstance(o, list):
        return [strip(v) for v in o]
    return o


def main(mode):
    out = []
    for tf in TFS:
        for inst in INSTS:
            t0 = time.time()
            r = analyse(inst, tf, outcomes=(mode == "run"))
            out.append(r)
            print(tf, inst, r["signals"], f"{time.time() - t0:.0f}s", flush=True)
            if mode == "run":
                for w in WINS:
                    for k in r[w]:
                        if k == "H1_minus_FADEALL":
                            continue
                        g = r[w][k]["gross"]
                        log_trial(dict(exp=EXP, cell=f"{tf}|{k}", unit=TAG(inst), window=w,
                                       primary=(inst == "WTICO/USD" and tf == "M5" and k in ("H1q99.0", "H2q98.0")),
                                       mode="dev" if w == "dev" else "devwindow2023", n=g["n"], gross=g.get("mean"),
                                       gross_ci=g.get("ci"), p_one=g.get("p_one"), net=r[w][k]["net"].get("mean"), hit=g.get("hit")))
                    log_trial(dict(exp=EXP, cell=f"{tf}|H3", unit=TAG(inst), window=w, primary=False, h3=r["H3"][w]))
    if mode == "plumb":
        json.dump(out, open(os.path.join(OUT, "plumb.json"), "w"), indent=1); return
    P = next(r for r in out if r["inst"] == "WTICO/USD" and r["tf"] == "M5")
    prim, v = primary(P)
    log_trial(dict(exp=EXP, cell="PRIMARY|M5|H1q99,H2q98 Holm", unit="WTICO_USD", verdict=v, holm=prim))
    json.dump(dict(verdict=v, primary=prim, results=strip(out), code_sha256=codeshas()),
              open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    print("VERDICT", v, json.dumps(prim, default=float))


def codeshas():
    return {"vol33.py": sha(os.path.join(HERE, "vol33.py")), "updown.py": sha(UPDOWN),
            "events.py": sha(os.path.join(AUD, "news24", "events.py")), "labels_v2.py": sha(os.path.join(ENG, "labels_v2.py")),
            "fills.py": sha(os.path.join(ENG, "fills.py")), "validate.py": sha(os.path.join(ENG, "validate.py"))}


# ------------------------------------------------------------------ self-checks
def check():
    # slot median: slot 0 has volumes 1..21 on 21 trading days, slot 1 constant 3
    t = (np.repeat(np.arange(22) * 1440, 2) + np.tile([0, 5], 22)).astype(np.int64)
    vol = np.c_[np.arange(1, 23), np.full(22, 3)].ravel().astype(float)
    r = vol_ratio(t, vol, 5)
    assert np.isnan(r[:20]).all() and abs(r[20] - 11 / 5.5) < 1e-12        # day 10: median of 1..10, 10 prior days
    assert abs(r[42] - 22 / 11.5) < 1e-12 and abs(r[43] - 1.0) < 1e-12     # day 21: median of 2..21 (20 prior days) = 11.5
    # trailing quantiles exclude the bar's own day and use at most THR_N previous days
    tt = np.repeat(np.arange(THR_N + 70) * 1440, 200).astype(np.int64)
    vv = np.repeat(np.arange(THR_N + 70, dtype=float), 200)
    q = trailing_q(tt, vv)
    assert np.isnan(q[200 * (THR_MIN - 1)]).all() and q[200 * THR_MIN, 5] <= THR_MIN - 1
    k = THR_N + 60
    assert q[200 * k, 0] >= k - THR_N and q[200 * k, 5] <= k - 1
    # wick side: long lower wick -> long, long upper wick -> short, big body -> 0, tied wicks -> 0
    o = np.array([10, 10, 10, 10.0]); c = np.array([10.1, 9.9, 11, 10.0])
    h = np.array([10.2, 11, 11.1, 10.5]); l = np.array([9, 9.8, 9.9, 9.5])
    assert list(wick_side(o, h, l, c)) == [1, -1, 0, 0]
    # holm
    assert np.allclose(holm([0.01, 0.04]), [0.02, 0.04]) and np.allclose(holm([0.03, 0.02]), [0.04, 0.04])
    assert list(one_at_a_time(np.array([0, 3, 13, 14]), np.array([12, 15, 25, 26]))) == [True, False, True, False]
    # simulate: +1 R target, -1 R stop, time exit at the close of bar 12
    def mk(rows):
        a = np.array(rows, float)
        return {f"{s}_{k}": a[:, j] for s in ("bid", "ask") for j, k in enumerate("ohlc")}
    z = np.zeros(30, int); flat = [[100] * 4]
    run = lambda B, s=1: {k: v[0] for k, v in simulate(B, [0], [s], [1.0], z, VAR).items()}
    assert abs(run(mk(flat + [[100, 101.1, 99.9, 100.2]] + flat * 14))["net_R"] - 1) < 1e-12
    assert abs(run(mk(flat + [[100, 100.1, 98.9, 99.0]] + flat * 14))["net_R"] + 1) < 1e-12
    tim = run(mk(flat + [[100, 100.2, 99.8, 100]] * 11 + [[100, 100.2, 99.8, 100.4]] + flat * 3))
    assert abs(tim["net_R"] - 0.4) < 1e-12 and tim["exit_bar"] == 12, tim
    # range12: bars 1..12 span high 105 / low 95 -> 10 / ATR 2 = 5
    n = 20; B = dict(t=np.arange(n) * 5, mid_h=np.full(n, 101.0), mid_l=np.full(n, 99.0), atr=np.full(n, 2.0))
    B["mid_h"][12] = 105; B["mid_l"][3] = 95; B["mid_h"][13] = 200
    rr = range12(B, 5)
    assert abs(rr[0] - 5) < 1e-12 and rr[1] == (200 - 95) / 2 and np.isnan(rr[n - H:]).all()
    B["t"] = B["t"].copy(); B["t"][10:] += 60
    assert np.isnan(range12(B, 5)[0])
    print("vol33 check ok")


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
    if mode == "check":
        check()
    elif mode == "register":
        register()
    elif mode == "amend":
        register(amend=sys.argv[2])
    elif mode in ("plumb", "run"):
        main(mode)
