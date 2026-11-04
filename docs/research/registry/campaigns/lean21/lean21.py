"""lean21: does price continue in the direction of the day's move when the abs11 big-day alert is high?

Operator hypothesis (2026-10-08, WTI +3.4% trend day): "When the big-day alert is high AND the day has already moved
strongly in one direction, the move continues in that direction." Development evidence only; no ledger.

  python lean21.py check      synthetic self-checks (bootstrap weights, cells, Holm)
  python lean21.py register   prereg.json (refuses to overwrite)
  python lean21.py run        out/results.json
  python lean21.py today      out/today_WTI.json (illustration only, live mid candles, no costs)
"""
import os, sys, json, time, hashlib, sqlite3
HERE = os.path.dirname(os.path.abspath(__file__))
AUD = os.path.dirname(HERE)
ENG = os.path.dirname(AUD)
OUT = os.path.join(HERE, "out")
sys.path[:0] = [ENG, os.path.join(AUD, "abs11"), os.path.join(AUD, "pprofit20")]
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import abs11 as A  # noqa: E402
import pp20 as PP  # noqa: E402
import de_v2 as de  # noqa: E402
from bars import resample  # noqa: E402
from validate import day_of, year_start_day, log_trial  # noqa: E402

EXP = "lean21"
INSTS = A.INSTS
HS = (12, 48)
K_R = 1.5                    # 1R = 1.5 x Wilder ATR14 (pprofit20 A4 "up")
ALERT_X = 3.0                # C_alert: P(big day) >= 3 x trailing session base rate
K_MAIN, K_SENS = 0.5, (0.25, 0.75)
SPR_MAX = 0.2                # shared spread rule: no entry with spread > 0.2 R
NREP, BLOCK, SEED = 1000, 5, 21
ALPHA = 0.05
CUT = PP.CUT
LIVE_DB = "file:" + os.path.join(os.path.dirname(os.path.dirname(ENG)), "candles.db") + "?mode=ro&immutable=1"
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"lean21.py": sha(os.path.join(HERE, "lean21.py")), "abs11.py": A.CODE["abs11.py"], "pp20.py": PP.CODE["pp20.py"],
        "bars.py": A.CODE["bars.py"], "evaluator": de.CODE_SHA}
mins = lambda s: int(np.datetime64(s, "m").astype(np.int64))
WIN = {"dev": (year_start_day(2019), year_start_day(2023)), "w2023": (year_start_day(2023), 10 ** 9)}
CRISES = {k: (day_of(mins(a)), day_of(mins(b))) for k, (a, b) in A.CRISES.items()}


# ------------------------------------------------------------------ pure helpers
def boot_weights(ndays, reps=NREP, block=BLOCK, seed=SEED):
    """Moving-block bootstrap over consecutive trading days as a (reps x ndays) multiplicity matrix."""
    rng = np.random.default_rng(seed)
    nb = -(-ndays // block)
    starts = rng.integers(0, max(ndays - block + 1, 1), (reps, nb))
    idx = (starts[:, :, None] + np.arange(block)).reshape(reps, -1)[:, :ndays] % ndays
    W = np.zeros((reps, ndays))
    np.add.at(W, (np.repeat(np.arange(reps), ndays), idx.ravel()), 1)
    return W


def daysum(pos, ndays, v):
    return np.bincount(pos, v, ndays), np.bincount(pos, minlength=ndays).astype(float)


def holm(p):
    p = np.asarray(p, float); o = np.argsort(p); m = len(p)
    adj = np.maximum.accumulate(np.minimum(1, (m - np.arange(m)) * p[o]))
    out = np.empty(m); out[o] = adj
    return out


def check():
    W = boot_weights(10, reps=50, block=3)
    assert W.shape == (50, 10) and (W.sum(1) == 10).all()
    s, c = daysum(np.array([0, 0, 2]), 3, np.array([1.0, 3, 5]))
    assert list(s) == [4, 0, 5] and list(c) == [2, 0, 1]
    assert np.allclose(holm([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06])
    # stat with identity weights equals the plain mean
    st = cell_stats(np.array([1.0, -1, 2, 0.5]), np.array([0, 1, 1, 2]), np.ones((1, 3)))
    assert abs(st["boot"][0] - 0.625) < 1e-12 and st["n_days"] == 3
    print("lean21 self-check OK: block weights, day sums, Holm, weighted mean")


def cell_stats(net, pos, W):
    ndays = W.shape[1]
    S, C = daysum(pos, ndays, net)
    with np.errstate(invalid="ignore", divide="ignore"):
        b = (W @ S) / (W @ C)
    return dict(S=S, C=C, boot=b, n_days=int((C > 0).sum()))


def summarize(net, y, pos, W):
    if len(net) == 0:
        return dict(n=0)
    st = cell_stats(net, pos, W); b = st["boot"][np.isfinite(st["boot"])]
    sd = float(np.std(b)) if len(b) else np.nan
    return dict(n=int(len(net)), n_days=st["n_days"], cont=float(y.mean()), netR=float(net.mean()),
                ci=[float(np.percentile(b, 2.5)), float(np.percentile(b, 97.5))] if len(b) else [None, None],
                p_le0=float((b <= 0).mean()) if len(b) else None, mde80=float(2.486 * sd))


def diff(net1, pos1, net2, pos2, W):
    if len(net1) == 0 or len(net2) == 0:
        return dict(diff=None)
    b = cell_stats(net1, pos1, W)["boot"] - cell_stats(net2, pos2, W)["boot"]
    b = b[np.isfinite(b)]
    return dict(diff=float(net1.mean() - net2.mean()), ci=[float(np.percentile(b, 2.5)), float(np.percentile(b, 97.5))],
                p_le0=float((b <= 0).mean()))


# ------------------------------------------------------------------ data
def alert_rows(inst, bars30=None, stress=None):
    """abs11 A1 day-level intraday OOS P(big day) per 30-min close + trailing session base rate + state."""
    reg = json.load(open(os.path.join(AUD, "abs11", "prereg.json")))
    T1, T2 = reg["thresholds"][inst]["T1"], reg["thresholds"][inst]["T2"]
    stress = A.stress_table() if stress is None else stress
    if bars30 is not None:
        A.bars30 = lambda _i: bars30
    R, _, _, D = A.build(inst, T1, T2, stress)
    m1 = R["valid"] & R["fin"] & (R["exc_so"] < T1)
    i1 = np.flatnonzero(m1); d1 = R["day"][i1]
    inv = np.unique(d1, return_inverse=True)[1]; w1 = 1.0 / np.bincount(inv)[inv]
    P1, Ms = A.walk(d1, R["X"][i1], R["yday"][i1], w1, A.F_ALL, {}, hgb=False)
    n = len(R["t"]); P = np.full(n, np.nan); base = np.full(n, np.nan)
    P[i1] = P1["lr"]
    Dv = D[D.valid]; big = (Dv.exc >= T1).to_numpy(); dd = Dv.index.to_numpy()
    for qd, qe, _M in Ms:
        te = (R["day"] >= qd) & (R["day"] < qe)
        base[te] = big[dd < qd - A.EMB].mean()
    state = np.where(R["valid"] & R["fin"] & (R["exc_so"] >= T1) & np.isfinite(base), 2,      # day already crossed T1
                     np.where(np.isfinite(P), 1, 0))                                           # 1 scored, 0 none
    return dict(tc=R["tc"].astype(np.int64), day=R["day"], P=P, base=base, state=state, yday=R["yday"], T1=T1,
                last_model=dict(cut=Ms[-1][2]["cut"], applies_from=Ms[-1][2]["applies_from"]))


def decision_rows(inst, B, AR):
    """M5 decision bars (every 3rd bar, the M15 close) joined to the latest 30-min alert state of the same session."""
    o, h, l, c = (B["mid_" + k] for k in "ohlc")
    atr = PP.atr_wilder(h, l, c)
    t = B["t"]; day = day_of(t); n = len(t)
    dopen = pd.Series(o).groupby(day).transform("first").to_numpy()
    move = 100 * (c - dopen) / dopen
    i = np.flatnonzero((t % 15 == 10) & np.isfinite(atr) & (atr > 0))
    j = np.searchsorted(AR["tc"], t[i] + 5, side="right") - 1
    ok = (j >= 0) & (AR["day"][np.clip(j, 0, None)] == day[i])
    i, j = i[ok], j[ok]
    side = np.sign(move[i]).astype(int)
    spr = (B["ask_c"][i] - B["bid_c"][i]) / (K_R * atr[i])
    out = dict(i=i, t=t[i], day=day[i], move=move[i], side=side, spr=spr, P=AR["P"][j], base=AR["base"][j],
               state=AR["state"][j], yday=AR["yday"][j], T1=AR["T1"])
    e = np.clip(i + 1, 0, n - 1); R1 = K_R * atr[i]
    for H in HS:
        x = np.clip(i + H, 0, n - 1); okh = i + H < n
        if "bid_c" in B and np.isfinite(B["bid_c"]).all():
            nl = (B["bid_c"][x] - B["ask_o"][e]) / R1; ns = (B["bid_o"][e] - B["ask_c"][x]) / R1
        else:
            nl = (c[x] - o[e]) / R1; ns = -nl
        out[f"netL{H}"] = np.where(okh, nl, np.nan); out[f"netS{H}"] = np.where(okh, ns, np.nan)
    return out


def m5(inst):
    m1, src = PP.load_m1c(inst)
    return resample(m1, "M5"), src


# ------------------------------------------------------------------ analysis
def analyse(Ds):
    """Ds: {unit: decision-row dict}. Returns per unit, H, window results."""
    rng = np.random.default_rng(SEED)
    res = {}
    for unit, Dr in Ds.items():
        res[unit] = {}
        for H in HS:
            netL, netS = Dr[f"netL{H}"], Dr[f"netS{H}"]
            base_ok = (Dr["state"] >= 1) & (Dr["side"] != 0) & (Dr["spr"] <= SPR_MAX) & np.isfinite(netL) & np.isfinite(netS)
            net = np.where(Dr["side"] > 0, netL, netS)
            rside = rng.choice([-1, 1], len(net))
            netr = np.where(rside > 0, netL, netS)
            alert = Dr["P"] >= ALERT_X * Dr["base"]
            scored = base_ok & (Dr["state"] == 1)
            mv = lambda k: np.abs(Dr["move"]) >= k * Dr["T1"]
            res[unit][f"H{H}"] = {}
            wins = {**WIN, **CRISES}
            for wn, (lo, hi) in wins.items():
                inw = (Dr["day"] >= lo) & (Dr["day"] < hi)
                days = np.unique(Dr["day"][inw & base_ok])
                if len(days) < 10:
                    continue
                W = boot_weights(len(days))
                pos = np.searchsorted(days, Dr["day"])
                def S(m):
                    m = m & inw
                    return summarize(net[m], (net[m] > 0).astype(float), pos[m], W)
                def Dm(m1_, m2_, a=net, b=net):
                    m1_, m2_ = m1_ & inw, m2_ & inw
                    return diff(a[m1_], pos[m1_], b[m2_], pos[m2_], W)
                main = scored & alert & mv(K_MAIN)
                b1 = scored & ~alert & mv(K_MAIN); b2 = scored & alert & ~mv(K_MAIN); b3 = scored
                r = dict(main=S(main))
                if wn in WIN:
                    mi = main & inw
                    rnd = diff(net[mi], pos[mi], netr[mi], pos[mi], W)
                    rnd["random_side_netR"] = float(netr[mi].mean()) if mi.any() else None
                    r.update(B1=S(b1), B2=S(b2), B3=S(b3), diff_B1=Dm(main, b1), diff_B2=Dm(main, b2), diff_B3=Dm(main, b3),
                             diff_random=rnd,
                             survivorship_NOT_available_at_decision=S(main & (Dr["yday"] == 1)),
                             crossed_day_already_big=S(base_ok & (Dr["state"] == 2)),
                             sens={str(k): dict(main=S(scored & alert & mv(k)), B1=S(scored & ~alert & mv(k)),
                                                diff_B1=Dm(scored & alert & mv(k), scored & ~alert & mv(k))) for k in K_SENS})
                res[unit][f"H{H}"][wn] = r
                if wn in WIN:
                    log_trial(dict(exp=EXP, unit=unit, H=H, window=wn, cell="main", alert_x=ALERT_X, k_move=K_MAIN, spr_max=SPR_MAX,
                                   n=r["main"].get("n"), netR=r["main"].get("netR"), mode="dev" if wn == "dev" else "devwindow2023",
                                   lean21_sha256=CODE["lean21.py"]))
    return res


def decide(res):
    cells = [(u, h) for u in res for h in res[u]]
    pc, rows = [], {}
    for u, h in cells:
        r = res[u][h]
        ok_w = all(w in r for w in WIN)
        if not ok_w or any(r[w]["main"].get("n", 0) == 0 or r[w]["diff_B1"].get("diff") is None for w in WIN):
            rows[(u, h)] = dict(verdict="INCONCLUSIVE", reason="empty cell in a window"); pc.append(1.0); continue
        m = {w: r[w]["main"] for w in WIN}; d1 = {w: r[w]["diff_B1"] for w in WIN}
        p = max([m[w]["p_le0"] for w in WIN] + [d1[w]["p_le0"] for w in WIN])
        pc.append(p)
        sup = all(m[w]["cont"] > 0.5 and m[w]["netR"] > 0 and m[w]["ci"][0] > 0 and d1[w]["ci"][0] > 0 for w in WIN)
        rej = all(m[w]["ci"][1] < 0 for w in WIN)
        rows[(u, h)] = dict(sup_unadj=sup, rej=rej, p_iu=p)
    adj = holm(pc)
    out = {}
    for k, (cell, a) in enumerate(zip(cells, adj)):
        r = rows[cell]
        if "verdict" not in r:
            r["p_holm"] = float(a)
            r["verdict"] = "SUPPORTED" if r["sup_unadj"] and a < ALPHA else "REJECTED" if r["rej"] else "INCONCLUSIVE"
        out[f"{cell[0]}|{cell[1]}"] = r
    return out


def run():
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    assert reg["code_sha256"]["lean21.py"] == CODE["lean21.py"], "lean21.py changed after registration"
    assert reg["code_sha256"]["evaluator"] == de.CODE_SHA
    os.makedirs(OUT, exist_ok=True)
    Ds, meta = {}, {}
    for inst in INSTS:
        t0 = time.time()
        AR = alert_rows(inst)
        B, src = m5(inst)
        Ds[inst] = decision_rows(inst, B, AR)
        meta[inst] = dict(src=src, T1=AR["T1"], last_model=AR["last_model"], secs=round(time.time() - t0))
        print(inst, meta[inst], flush=True)
    pooled = {k: np.concatenate([Ds[i][k] if np.ndim(Ds[i][k]) else np.full(len(Ds[i]["i"]), Ds[i][k]) for i in INSTS])
              for k in Ds[INSTS[0]] if k != "T1"}
    pooled["T1"] = np.concatenate([np.full(len(Ds[i]["i"]), Ds[i]["T1"]) for i in INSTS])
    Ds["POOLED"] = pooled
    res = analyse(Ds)
    out = dict(code=CODE, meta=meta, results=res, decision=decide(res),
               note="development evidence; 2023+ inspected for other questions; not qualified; no ledger")
    json.dump(out, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    print(json.dumps(out["decision"], indent=1, default=float))


def today():
    """WTI 2026-10-08 from the live candle store (mid only; outcomes without bid/ask costs). Illustration only."""
    inst = "WTICO/USD"
    con = sqlite3.connect(LIVE_DB, uri=True)
    rows = con.execute("select cast(strftime('%s', substr(time,1,19)) as integer)/60, open, high, low, close from candles "
                       "where instrument=? and granularity='M1' and time >= '2026-10-01' order by time", (inst,)).fetchall()
    L = np.array(rows, float)
    m1, _ = PP.load_m1c(inst)
    keep = L[:, 0] > m1["t"][-1]
    lt = L[keep, 0].astype(np.int64)
    mid = {k: np.r_[(m1["bid_" + k] + m1["ask_" + k]) / 2, L[keep, 1 + "ohlc".index(k)]] for k in "ohlc"}
    t = np.r_[m1["t"], lt]
    M = {"t": t, **{f"{s}_{k}": mid[k] for s in ("bid", "ask") for k in "ohlc"}, "volume": np.zeros(len(t))}
    B5 = resample(M, "M5")
    for k in "ohlc":
        B5["bid_" + k] = B5["ask_" + k] = np.full(len(B5["t"]), np.nan)  # force mid outcomes
    A.BR.MIN["M30"] = 30
    B30 = resample(M, "M30")
    b30 = {"t": B30["t"].astype(np.int64), "o": B30["mid_o"], "h": B30["mid_h"], "l": B30["mid_l"], "c": B30["mid_c"], "n": B30["n"]}
    st = A.stress_table()
    st = st.reindex(np.arange(st.index.min(), day_of(t[-1]) + 1)).ffill(limit=2)  # carry the last stress value (declared)
    AR = alert_rows(inst, bars30=b30, stress=st)
    Dr = decision_rows(inst, B5, AR)
    d = day_of(mins("2026-10-08T12:00"))
    m = Dr["day"] == d
    rec = [dict(bar_close_utc=str(np.datetime64(int(Dr["t"][k]) + 5, "m")), move_pct=round(float(Dr["move"][k]), 3),
                P_big=None if not np.isfinite(Dr["P"][k]) else round(float(Dr["P"][k]), 3),
                alert_thr=round(float(ALERT_X * Dr["base"][k]), 3), state=int(Dr["state"][k]),
                C_alert=bool(Dr["P"][k] >= ALERT_X * Dr["base"][k]), C_move=bool(abs(Dr["move"][k]) >= K_MAIN * AR["T1"]),
                side=int(Dr["side"][k]),
                **{f"midR_H{H}": None if not np.isfinite(Dr[f"netL{H}"][k]) else round(float(Dr["side"][k] * Dr[f"netL{H}"][k]), 3) for H in HS})
           for k in np.flatnonzero(m)]
    out = dict(note="illustration only; live mid M1 appended after the research cache end; outcomes on mid without costs; "
                    "stress carried from the previous session", T1=AR["T1"], last_live_bar=str(np.datetime64(int(t[-1]), "m")), rows=rec)
    os.makedirs(OUT, exist_ok=True)
    json.dump(out, open(os.path.join(OUT, "today_WTI.json"), "w"), indent=1)
    for r in rec:
        print(r)


def register():
    f = os.path.join(HERE, "prereg.json")
    assert not os.path.exists(f), "prereg.json exists"
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="lean21: continuation of the day's move when the abs11 big-day alert is high (direction 'lean' test)",
        motivation=("Operator observation on 2026-10-08 (WTI +3.4% trend day): 'When the big-day alert is high AND the day has already "
                    "moved strongly in one direction, the move continues in that direction.' The hypothesis was formed from one "
                    "observed day. 2023+ has been inspected for other questions (abs11, pprofit20, daytype14 and others); it is a "
                    "development window, not a holdout. Prior related knowledge: daytype14 found trend-day-so-far probability usable "
                    "as context only; pprofit20 'up' labels near chance."),
        before_registration="No outcome of this test computed. Code written and self-checked (synthetic only).",
        declared="Development evidence only. No test ledger, nothing qualified, no entries shipped.",
        instruments=INSTS, timeframe="M5", horizons_bars=list(HS),
        alert=("abs11 A1 day-level intraday LR, out-of-sample walk-forward (quarterly expanding refit, 5-day purge), scored at every "
               "30-min close while the session excursion so far < T1. C_alert: P(big day) >= 3 x the trailing session base rate "
               "(share of valid sessions with max |excursion| >= T1 among sessions before the quarter's training cutoff, expanding from 2018)."),
        state=("Each M5 decision bar uses the latest abs11 30-min row of the same session (bar close >= row close). Bars before the "
               "session's first 30-min close have no score and are excluded. Bars whose latest 30-min row has already crossed T1 "
               "(day already big, the alert model does not score them) are excluded from all decision cells and reported separately."),
        move="move so far % = 100 x (M5 mid close - session open mid) / session open (22:00 UTC roll, abs11 session); side = sign",
        conditions=dict(C_move=f"|move so far| >= {K_MAIN} x T1 (sensitivity {K_SENS}, not decision)", main="C_alert AND C_move, side = move",
                        B1="C_move AND NOT C_alert", B2="C_alert AND NOT C_move", B3="all scored bars, side = move",
                        random="main cell bars with a random side (seeded)",
                        survivorship="main cell restricted to days ending >= T1: NOT available at decision time, reported only"),
        decision_bars="M5 bars with start minute % 15 == 10 (every 3rd bar, pprofit20 cadence); spread rule: (ask_c - bid_c)/(1.5 ATR14) <= 0.2",
        target=("pprofit20 A4 'up': entry at bar i+1 open (long ask / short bid), exit at the close of bar i+H (long bid / short ask); "
                "y = net > 0; net R = net / (1.5 x Wilder ATR14 of mid M5 at bar i). H = 12 and 48 M5 bars."),
        windows=dict(dev="2019-2022 (abs11 OOS starts 2019Q1)", w2023="2023-01-01 .. pprofit20 cut 2026-10-07T18:30 (development window)",
                     stress=A.CRISES),
        stats=f"moving-block bootstrap over trading days (block {BLOCK}, {NREP} reps, seed {SEED}); per window; pooled clusters by calendar day; paired diffs share the day draws; MDE80 = 2.486 x bootstrap SD of mean net R",
        decision_rule=("Decision cells: 6 instruments + pooled x H12, H48 = 14. SUPPORTED if in BOTH windows continuation rate > 0.5, net R > 0 "
                       "with CI lower bound > 0, AND main minus B1 CI lower bound > 0, AND the Holm-adjusted (14 cells) intersection-union "
                       "p = max of the four one-sided bootstrap p values < 0.05. REJECTED if net R CI upper bound < 0 in both windows. "
                       "Else INCONCLUSIVE."),
        budget=dict(alert_multiplier=1, move_thresholds_decision=1, move_thresholds_sensitivity=2, horizons=2, instruments=6, tuned=0),
        code_sha256=CODE)
    json.dump(reg, open(f, "w"), indent=1)
    print("registered", reg["created"], CODE)


if __name__ == "__main__":
    {"check": check, "register": register, "run": run, "today": today}[sys.argv[1]]()
