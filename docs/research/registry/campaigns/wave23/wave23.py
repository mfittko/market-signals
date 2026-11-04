"""wave23: "ride the wave" on abs11 big-day alert days. Small-risk entries, tight initial stop, trailing exit, no target.

Operator hypothesis (2026-10-08): on days the big-day model flags, take small-risk entries with a tight stop and a
trailing exit, accept several small losses, and catch the big run. Development evidence only; no ledger.

  python wave23.py check      synthetic fixtures for the trailing simulator + stats helpers
  python wave23.py register   prereg.json (refuses to overwrite)
  python wave23.py run        out/results.json
  python wave23.py today      out/today_WTI.json (illustration only, live mid candles, no costs)
"""
import os, sys, json, time, hashlib, sqlite3, itertools
HERE = os.path.dirname(os.path.abspath(__file__))
AUD = os.path.dirname(HERE)
ENG = os.path.dirname(AUD)
OUT = os.path.join(HERE, "out")
sys.path[:0] = [ENG, os.path.join(AUD, "abs11"), os.path.join(AUD, "pprofit20"), os.path.join(AUD, "lean21")]
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import lean21 as L  # noqa: E402  (alert rows, block bootstrap, Holm: reused unchanged)
import abs11 as A  # noqa: E402
import pp20 as PP  # noqa: E402
import de_v2 as de  # noqa: E402
from fills import resolve, STOP  # noqa: E402
from bars import resample  # noqa: E402
from validate import day_of, year_start_day, log_trial  # noqa: E402

EXP = "wave23"
INSTS = A.INSTS
TFS = {"M5": 5, "M15": 15}
KS = (0.5, 0.75, 1.0)          # initial stop = k x Wilder ATR14 (entry TF, mid); 1 R = that distance
TRIGS = ("flip", "brk")       # primary: supertrend flip of the entry TF; variant: close beyond the session range so far
TRAILS = ("st", "chand")      # primary: supertrend line of the entry TF; variant: chandelier (HH since entry - 2 ATR14)
SESS = (False, True)          # primary: no session-end exit; variant: exit at the close of the session's last bar
CH_MULT = 2.0
CAP = {"M5": 288, "M15": 96}  # hard time cap = 24 h of bars, exit at the close (declared safety cap)
BRK_MIN = 60                  # range-break trigger needs >= 60 min of session bars before the signal bar
MAX_ATT = 3
ALERT_X = L.ALERT_X           # 3 x trailing base rate (lean21)
SPR_MAX = 0.2
THIN_N = 4                    # notrade12 R3 rule: the 4 UTC hours with the highest median M5 spread/(1.5 ATR14), 2018-2022
SEED = 23
ALPHA = 0.05
MODES = ("armed", "C1", "C2", "C3")
PRIMARY = dict(trig="flip", trail="st", sess=False)
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"wave23.py": sha(os.path.join(HERE, "wave23.py")), "lean21.py": L.CODE["lean21.py"], "abs11.py": A.CODE["abs11.py"],
        "pp20.py": PP.CODE["pp20.py"], "bars.py": A.CODE["bars.py"], "fills.py": sha(os.path.join(ENG, "fills.py")),
        "evaluator": de.CODE_SHA}
WIN = L.WIN
CRISES = L.CRISES


# ------------------------------------------------------------------ trailing simulator (registered extension of labels_v2)
def sim_trade(B, i, s, k, trail, cap, end=None):
    """One trade. Signal at the close of bar i, entry at the open of bar e = i+1 (long ask, short bid).
    Long semantics: short uses the ask bar negated. Stop for bar b is fixed before b opens:
      stop_e = entry - R;  stop_b = max(stop_{b-1}, cand_{b-1}) for b > e   (ratchet: never moves against the position)
      st:    cand_j = s * st_j if trend_j == s else +inf (the trend flipped: exit at the next open)
      chand: cand_j = max(s*mid_hl[e..j]) - CH_MULT * atr_j
    Inside a bar the stop does not move (conservative: a new extreme in bar b cannot raise b's own stop).
    Fill: fills.resolve (open at or through the stop -> the open, else touch -> the stop level).
    No exit by min(e+cap, end+1) -> time exit at the close of the last bar. Returns (net_R, exit_bar, reason, stops) or None
    when censored (data ends) or no entry bar."""
    n = len(B["t"]); e = i + 1
    if e >= n:
        return None
    last = e + cap - 1 if end is None else min(e + cap - 1, end)
    if last < e:
        return None
    trunc = last >= n
    last = min(last, n - 1)
    b = np.arange(e, last + 1)
    if s > 0:
        o, h, l, c = B["bid_o"][b], B["bid_h"][b], B["bid_l"][b], B["bid_c"][b]
        entry = B["ask_o"][e]; ext = B["mid_h"][b]
    else:
        o, h, l, c = -B["ask_o"][b], -B["ask_l"][b], -B["ask_h"][b], -B["ask_c"][b]
        entry = -B["bid_o"][e]; ext = -B["mid_l"][b]
    R = k * B["atr"][i]
    if not (np.isfinite(R) and R > 0 and np.isfinite(entry)):
        return None
    if trail == "st":
        cand = np.where(B["trend"][b] == s, s * B["st"][b], np.inf)
    else:
        cand = np.maximum.accumulate(ext) - CH_MULT * B["atr"][b]
    cand = np.nan_to_num(cand, nan=-np.inf)
    stops = np.maximum(entry - R, np.r_[-np.inf, np.maximum.accumulate(cand[:-1])])
    r, p, _ = resolve(o, h, l, stops, np.inf)
    hit = np.flatnonzero(r == STOP)
    if len(hit):
        j = hit[0]
        return (p[j] - entry) / R, int(b[j]), "stop", stops
    if trunc:
        return None
    return (c[-1] - entry) / R, int(last), "time", stops


# ------------------------------------------------------------------ data
def frame(inst, m1, gran, thin):
    B = resample(m1, gran); gm = TFS[gran]
    S = de.supertrend(inst, B)
    B["trend"] = np.nan_to_num(S["trend"]).astype(int); B["flip"] = np.nan_to_num(S["flip"]).astype(int); B["st"] = S["st"]
    B["atr"] = PP.atr_wilder(B["mid_h"], B["mid_l"], B["mid_c"])
    t = B["t"]; B["day"] = day_of(t); B["tc"] = t + gm
    d = pd.Series(B["day"]); h, l = pd.Series(B["mid_h"]), pd.Series(B["mid_l"])
    dhi = h.groupby(d).cummax().groupby(d).shift(1).to_numpy(); dlo = l.groupby(d).cummin().groupby(d).shift(1).to_numpy()
    nday = d.groupby(d).cumcount().to_numpy()
    c = B["mid_c"]
    B["brk"] = np.where(nday * gm >= BRK_MIN, np.where(c > dhi, 1, np.where(c < dlo, -1, 0)), 0)
    B["sprabs"] = B["ask_c"] - B["bid_c"]
    B["thin"] = np.isin((B["tc"] % 1440) // 60, thin)
    B["dlast"] = np.r_[np.flatnonzero(np.diff(B["day"]) != 0), len(t) - 1][np.unique(B["day"], return_inverse=True)[1]]
    return B


def thin_hours(m1):
    B = resample(m1, "M5")
    atr = PP.atr_wilder(B["mid_h"], B["mid_l"], B["mid_c"])
    spr = (B["ask_c"] - B["bid_c"]) / (1.5 * atr)
    m = (B["t"] < np.datetime64("2023-01-01", "m").astype(np.int64)) & np.isfinite(spr) & (atr > 0)
    hr = ((B["t"][m] + 5) % 1440) // 60
    med = np.array([np.median(spr[m][hr == x]) if (hr == x).any() else -np.inf for x in range(24)])
    return sorted(int(x) for x in np.argsort(-med)[:THIN_N])


def day_starts(AR):
    """Per session: first scored 30-min close (C1/C3 start) and first close with P >= 3 x base (arm time)."""
    sc = AR["state"] == 1
    arm = sc & np.isfinite(AR["base"]) & (AR["P"] >= ALERT_X * AR["base"])
    st = pd.Series(AR["tc"][sc]).groupby(AR["day"][sc]).min()
    ar = pd.Series(AR["tc"][arm]).groupby(AR["day"][arm]).min()
    return st.to_dict(), ar.to_dict()


# ------------------------------------------------------------------ policy
def run_policy(B, starts, arms, mode, k, trig, trail, sess, cap, rng):
    """Trades for one (inst, TF) and one policy. mode: armed (from arm time), C1 (non-armed days, from the first scored
    close), C2 (armed, random side), C3 (all scored days, from the first scored close)."""
    sig = B["flip"] if trig == "flip" else B["brk"]
    if mode in ("armed", "C2"):
        days = {d: arms[d] for d in arms}
    elif mode == "C1":
        days = {d: t0 for d, t0 in starts.items() if d not in arms}
    else:
        days = dict(starts)
    cand = np.flatnonzero(sig != 0)
    cday = B["day"][cand]
    trades = []
    for d, t0 in days.items():
        lo, hi = np.searchsorted(cday, d), np.searchsorted(cday, d, side="right")
        att, free = 0, -1
        for i in cand[lo:hi]:
            if att >= MAX_ATT:
                break
            if B["tc"][i] < t0 or i < free:
                continue
            R = k * B["atr"][i]
            if not (R > 0) or B["sprabs"][i] > SPR_MAX * R or B["thin"][i]:
                continue
            s = int(sig[i]) if mode != "C2" else int(rng.choice([-1, 1]))
            end = int(B["dlast"][i]) if sess else None
            if sess and i == end:
                continue
            res = sim_trade(B, i, s, k, trail, cap, end)
            if res is None:
                break  # censored at the data end
            trades.append((d, int(B["tc"][i]), s, float(res[0]), res[1] - i))
            att += 1; free = res[1]
    return days, trades


# ------------------------------------------------------------------ statistics
def ratio_boot(S, C, W):
    with np.errstate(invalid="ignore", divide="ignore"):
        return (W @ S) / (W @ C)


def metrics(daysets, trades, cal, W, lo, hi):
    """daysets: {inst: set(days)}, trades: list (inst, day, tc, side, R, hold). Calendar-day clustering over `cal`."""
    nd = len(cal)
    S = np.zeros(nd); C = np.zeros(nd)
    for inst, ds in daysets.items():
        dd = np.array([d for d in ds if lo <= d < hi], np.int64)
        if len(dd):
            np.add.at(C, np.searchsorted(cal, dd), 1)
    tr = [x for x in trades if lo <= x[1] < hi]
    if tr:
        np.add.at(S, np.searchsorted(cal, np.array([x[1] for x in tr])), np.array([x[4] for x in tr]))
    if C.sum() == 0:
        return dict(n_days=0), None
    b = ratio_boot(S, C, W); b = b[np.isfinite(b)]
    out = dict(n_days=int(C.sum()), n_trades=len(tr), R_per_day=float(S.sum() / C.sum()),
               ci=[float(np.percentile(b, 2.5)), float(np.percentile(b, 97.5))], p_le0=float((b <= 0).mean()),
               mde80=float(2.486 * np.std(b)))
    if tr:
        R = np.array([x[4] for x in tr]); order = np.argsort([x[2] for x in tr], kind="stable")
        win, los = R[R > 0], R[R <= 0]
        top = np.sort(R)[::-1][:max(1, int(np.ceil(0.1 * len(R))))]
        cum = np.cumsum(R[order])
        dayR = {}
        for x in tr:
            dayR[(x[0], x[1])] = dayR.get((x[0], x[1]), 0) + x[4]
        allday = np.array(list(dayR.values()) + [0.0] * (int(C.sum()) - len(dayR)))
        q = np.sort(allday)[:max(1, int(np.ceil(0.05 * len(allday))))]
        out.update(R_per_attempt=float(R.mean()), hit=float((R > 0).mean()),
                   payoff=float(win.mean() / -los.mean()) if len(win) and len(los) and los.mean() < 0 else None,
                   top10_share_of_win_R=float(top[top > 0].sum() / win.sum()) if win.sum() > 0 else None,
                   max_R=float(R.max()), maxdd_R=float((np.maximum.accumulate(np.r_[0, cum]) - np.r_[0, cum]).max()),
                   cvar5_day=float(q.mean()), median_hold_bars=float(np.median([x[5] for x in tr])))
    return out, b


def evaluate(cfg_trades, cfg_days, cal_all, units):
    """cfg_*: {mode: {inst: ...}}. Returns per unit (inst or POOLED), window: mode metrics + paired diffs."""
    res = {}
    for unit in units:
        insts = INSTS if unit == "POOLED" else [unit]
        res[unit] = {}
        for wn, (lo, hi) in {**WIN, **CRISES}.items():
            cal = cal_all[(cal_all >= lo) & (cal_all < hi)]
            if len(cal) < 10:
                continue
            W = L.boot_weights(len(cal), seed=SEED)
            r, bs = {}, {}
            for mode in MODES:
                tr = [(i,) + x for i in insts for x in cfg_trades[mode][i]]
                r[mode], bs[mode] = metrics({i: cfg_days[mode][i] for i in insts}, tr, cal, W, lo, hi)
            for c in ("C1", "C2", "C3"):
                if bs["armed"] is None or bs[c] is None or len(bs["armed"]) != len(bs[c]):
                    r["diff_" + c] = dict(diff=None); continue
                d = bs["armed"] - bs[c]
                r["diff_" + c] = dict(diff=float(r["armed"]["R_per_day"] - r[c]["R_per_day"]),
                                      ci=[float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))], p_le0=float((d <= 0).mean()))
            res[unit][wn] = r
    return res


def decide(dec):
    """dec: {cell: pooled result}. SUPPORTED needs, in BOTH windows, armed R/day CI lb > 0 and armed - C1, armed - C2
    CI lb > 0, and Holm (over the decision cells) of the intersection-union p (max of the six one-sided p) < 0.05."""
    cells = list(dec); pc, rows = [], {}
    for cell in cells:
        r = dec[cell]
        if any(w not in r or r[w]["armed"].get("n_days", 0) == 0 or r[w]["diff_C1"].get("diff") is None for w in WIN):
            rows[cell] = dict(verdict="INCONCLUSIVE", reason="empty window"); pc.append(1.0); continue
        ps = [r[w]["armed"]["p_le0"] for w in WIN] + [r[w][f"diff_{c}"]["p_le0"] for w in WIN for c in ("C1", "C2")]
        p = max(ps); pc.append(p)
        sup = all(r[w]["armed"]["ci"][0] > 0 and r[w]["diff_C1"]["ci"][0] > 0 and r[w]["diff_C2"]["ci"][0] > 0 for w in WIN)
        rej = all(r[w]["armed"]["ci"][1] < 0 for w in WIN)
        rows[cell] = dict(sup_unadj=sup, rej=rej, p_iu=p)
    adj = L.holm(pc)
    for cell, a in zip(cells, adj):
        r = rows[cell]
        if "verdict" not in r:
            r["p_holm"] = float(a)
            r["verdict"] = "SUPPORTED" if r["sup_unadj"] and a < ALPHA else "REJECTED" if r["rej"] else "INCONCLUSIVE"
    return rows


# ------------------------------------------------------------------ checks
def check():
    def mk(rows, spread=0.0, trend=None, st=None, atr=1.0):
        a = np.array(rows, float); n = len(a)
        B = {"t": np.arange(n) * 5, "bid_o": a[:, 0], "bid_h": a[:, 1], "bid_l": a[:, 2], "bid_c": a[:, 3]}
        for x in "ohlc":
            B["ask_" + x] = B["bid_" + x] + spread
            B["mid_" + x] = B["bid_" + x] + spread / 2
        B["atr"] = np.full(n, atr)
        B["trend"] = np.ones(n, int) if trend is None else np.array(trend)
        B["st"] = np.full(n, -1e9) if st is None else np.array(st, float)
        return B
    flat = [100, 100.2, 99.8, 100]
    # F1 ratchet: the supertrend line falls (99.5 -> 98) but the stop never moves down
    B = mk([flat, flat, flat, flat, [100, 100.1, 98.6, 99]], st=[0, 99.5, 99.5, 98, 98])
    net, xb, why, stops = sim_trade(B, 0, 1, 1.0, "st", 10, end=4)
    assert np.all(np.diff(stops) >= 0) and stops[-1] == 99.5 and why == "stop" and xb == 4 and abs(net + 0.5) < 1e-12
    # F2 gap through the trailing stop: fill at the open
    B = mk([flat, flat, [101, 102, 100.9, 102], [102, 103, 101.9, 103], [100, 100.2, 99, 99.5]], st=[0, 99, 100.5, 101.5, 101.5])
    net, xb, why, _ = sim_trade(B, 0, 1, 1.0, "st", 10)
    assert why == "stop" and xb == 4 and abs(net - 0.0) < 1e-12  # opened at 100 below the 101.5 trail
    # F3 same bar: a new high in bar b does not raise b's own chandelier stop (conservative), even if the low then
    # falls below where an intrabar update would have put it
    B = mk([flat, flat, [100, 104, 101.5, 102], [102, 102.5, 101.8, 102]])
    net, xb, why, stops = sim_trade(B, 0, 1, 1.0, "chand", 3)
    assert stops[1] == 99.0 and stops[2] == 102.0 and why == "stop" and xb == 3 and abs(net - 2.0) < 1e-12
    # F4 trend flip against the position -> stop = +inf -> exit at the next open
    B = mk([flat, flat, [100.5, 100.8, 100.3, 100.6], [100.7, 101, 100.5, 100.9]], trend=[1, 1, -1, -1], st=[0, 99, 101, 101])
    net, xb, why, _ = sim_trade(B, 0, 1, 1.0, "st", 10)
    assert why == "stop" and xb == 3 and abs(net - 0.7) < 1e-12
    # F5 short with spread: entry at the bid, stop checked on the ask high; ratchet in short space
    B = mk([flat, flat, [99, 99.1, 98, 98.2], [98.3, 99.6, 98.2, 99.5]], spread=0.2, trend=[-1] * 4, st=[0, 101, 99.4, 99.3])
    net, xb, why, stops = sim_trade(B, 0, -1, 1.0, "st", 10)
    assert why == "stop" and xb == 3 and abs(net - (100 - 99.4) / 1.0) < 1e-12 and np.all(np.diff(stops) >= 0)
    # F6 time cap exits at the close; censoring at the data end returns None
    B = mk([flat] * 5)
    net, xb, why, _ = sim_trade(B, 0, 1, 1.0, "st", 3)
    assert why == "time" and xb == 3 and net == 0.0
    assert sim_trade(B, 0, 1, 1.0, "st", 10) is None
    # F7 entry bar: the initial stop is live in the entry bar
    B = mk([flat, [100, 100.1, 98.9, 99]] + [flat] * 3)
    net, xb, why, _ = sim_trade(B, 0, 1, 1.0, "st", 3)
    assert xb == 1 and net == -1.0
    # stats: ratio estimator with identity weights; Holm
    assert abs(ratio_boot(np.array([1.0, 2]), np.array([1.0, 3]), np.ones((1, 2)))[0] - 0.75) < 1e-12
    assert np.allclose(L.holm([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06])
    print("wave23 self-check OK: ratchet, gap at open, same-bar conservative, flip exit, short/spread, time cap/censor, entry bar")


# ------------------------------------------------------------------ run
def configs():
    return [dict(tf=tf, k=k, trig=tg, trail=tr, sess=se) for tf in TFS for k in KS for tg in TRIGS for tr in TRAILS for se in SESS]


def cell_name(c):
    return f"{c['tf']}|k{c['k']}|{c['trig']}|{c['trail']}|{'sessexit' if c['sess'] else 'noexit'}"


def run():
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    assert reg["code_sha256"]["wave23.py"] == CODE["wave23.py"], "wave23.py changed after registration"
    assert reg["code_sha256"]["evaluator"] == de.CODE_SHA
    os.makedirs(OUT, exist_ok=True)
    cfgs = configs()
    T = {cell_name(c): {m: {} for m in MODES} for c in cfgs}
    Dd = {cell_name(c): {m: {} for m in MODES} for c in cfgs}
    meta, cal = {}, set()
    for ii, inst in enumerate(INSTS):
        t0 = time.time()
        AR = L.alert_rows(inst)
        starts, arms = day_starts(AR)
        cal |= set(starts)
        m1, src = PP.load_m1c(inst)
        thin = thin_hours(m1)
        Bs = {tf: frame(inst, m1, tf, thin) for tf in TFS}
        for ci, c in enumerate(cfgs):
            nm = cell_name(c)
            for m in MODES:
                rng = np.random.default_rng([SEED, ii, ci])
                days, tr = run_policy(Bs[c["tf"]], starts, arms, m, c["k"], c["trig"], c["trail"], c["sess"], CAP[c["tf"]], rng)
                T[nm][m][inst] = tr; Dd[nm][m][inst] = set(days)
        meta[inst] = dict(src=src, thin_utc_hours=thin, scored_days=len(starts), armed_days=len(arms), secs=round(time.time() - t0))
        print(inst, meta[inst], flush=True)
    cal = np.array(sorted(cal), np.int64)
    res, dec = {}, {}
    for c in cfgs:
        nm = cell_name(c)
        prim = c["trig"] == PRIMARY["trig"] and c["trail"] == PRIMARY["trail"] and c["sess"] == PRIMARY["sess"]
        res[nm] = evaluate(T[nm], Dd[nm], cal, ["POOLED"] + INSTS)
        if prim:
            dec[nm] = res[nm]["POOLED"]
        for wn in WIN:
            r = res[nm]["POOLED"].get(wn, {}).get("armed", {})
            log_trial(dict(exp=EXP, cell=nm, unit="POOLED", window=wn, decision=prim, n_days=r.get("n_days"),
                           n_trades=r.get("n_trades"), R_per_day=r.get("R_per_day"), mode="dev" if wn == "dev" else "devwindow2023",
                           wave23_sha256=CODE["wave23.py"]))
    out = dict(code=CODE, meta=meta, decision=decide(dec), results=res,
               note="development evidence; 2023+ inspected before; not qualified; no ledger")
    json.dump(out, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    print(json.dumps(out["decision"], indent=1, default=float))


def plumb():
    """Pre-registration plumbing on WTI: session, trade and day counts only. No R is printed or stored."""
    inst = "WTICO/USD"
    AR = L.alert_rows(inst); starts, arms = day_starts(AR)
    m1, _ = PP.load_m1c(inst); thin = thin_hours(m1)
    t0 = time.time()
    for tf in TFS:
        B = frame(inst, m1, tf, thin)
        for m in MODES:
            days, tr = run_policy(B, starts, arms, m, 0.75, "flip", "st", False, CAP[tf], np.random.default_rng(0))
            print(tf, m, "sessions", len(days), "trades", len(tr), "thin", thin, flush=True)
    print("secs", round(time.time() - t0))


def today():
    """WTI 2026-10-08 from the live candle store (mid only, no costs). Illustration only. Primary trigger and trail."""
    inst = "WTICO/USD"
    con = sqlite3.connect(L.LIVE_DB, uri=True)
    rows = con.execute("select cast(strftime('%s', substr(time,1,19)) as integer)/60, open, high, low, close from candles "
                       "where instrument=? and granularity='M1' and time >= '2026-10-01' order by time", (inst,)).fetchall()
    Lv = np.array(rows, float)
    m1, _ = PP.load_m1c(inst)
    keep = Lv[:, 0] > m1["t"][-1]
    lt = Lv[keep, 0].astype(np.int64)
    mid = {x: np.r_[(m1["bid_" + x] + m1["ask_" + x]) / 2, Lv[keep, 1 + "ohlc".index(x)]] for x in "ohlc"}
    t = np.r_[m1["t"], lt]
    M = {"t": t, **{f"{s}_{x}": mid[x] for s in ("bid", "ask") for x in "ohlc"}, "volume": np.zeros(len(t))}
    A.BR.MIN["M30"] = 30
    B30 = resample(M, "M30")
    b30 = {"t": B30["t"].astype(np.int64), "o": B30["mid_o"], "h": B30["mid_h"], "l": B30["mid_l"], "c": B30["mid_c"], "n": B30["n"]}
    st = A.stress_table()
    st = st.reindex(np.arange(st.index.min(), day_of(t[-1]) + 1)).ffill(limit=2)
    AR = L.alert_rows(inst, bars30=b30, stress=st)
    starts, arms = day_starts(AR)
    d = int(day_of(np.datetime64("2026-10-08T12:00", "m").astype(np.int64)))
    iso = lambda m: str(np.datetime64(int(m), "m"))
    out = dict(note="illustration only; live mid M1 appended after the research cache end; mid fills, no costs, no thin-hour or "
                    "spread filter; open trades are marked at the last live close", last_live_bar=iso(t[-1]),
               armed=d in arms, arm_time=iso(arms[d]) if d in arms else None, policies={})
    for tf in TFS:
        B = frame(inst, M, tf, [])
        for k in KS:
            days = {d: arms.get(d, starts.get(d))}
            tr, att, free = [], 0, -1
            for i in np.flatnonzero((B["day"] == d) & (B["flip"] != 0)):
                if att >= MAX_ATT or days[d] is None:
                    break
                if B["tc"][i] < days[d] or i < free:
                    continue
                s = int(B["flip"][i])
                r = sim_trade(B, i, s, k, "st", CAP[tf])
                if r is None:  # still open at the data end: mark at the last close
                    e = i + 1
                    if e >= len(B["t"]):
                        break
                    px = B["mid_c"][-1]; R = k * B["atr"][i]
                    tr.append(dict(signal=iso(B["tc"][i]), side=s, R=round(float(s * (px - B["mid_o"][e]) / R), 2), exit="open"))
                    break
                tr.append(dict(signal=iso(B["tc"][i]), side=s, R=round(float(r[0]), 2), exit=iso(B["t"][r[1]])))
                att += 1; free = r[1]
            out["policies"][f"{tf}|k{k}"] = dict(trades=tr, total_R=round(sum(x["R"] for x in tr), 2))
    os.makedirs(OUT, exist_ok=True)
    json.dump(out, open(os.path.join(OUT, "today_WTI.json"), "w"), indent=1)
    print(json.dumps(out, indent=1))


def register():
    f = os.path.join(HERE, "prereg.json")
    assert not os.path.exists(f), "prereg.json exists"
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="wave23: ride the wave on abs11 big-day alert days (tight stop, trailing exit, no target, up to 3 attempts)",
        motivation=("Operator hypothesis on 2026-10-08: on days the big-day model flags, take small-risk entries with a tight stop and a "
                    "trailing exit (no fixed target), accept several small losses, and catch the big run. 2019-2022 and 2023+ have both "
                    "been inspected for other questions (abs11, lean21, risk8, pprofit20, mw6 and others); both are development windows, "
                    "not holdouts. Related negative results: Ladder D (https://github.com/mfittko/market-signals/issues/310), lean21 "
                    "continuation on alert days (https://github.com/mfittko/market-signals/issues/310#issuecomment-6059927619), risk8 "
                    "stop width / sizing (https://github.com/mfittko/market-signals/issues/311#issuecomment-6051369045). Related positive "
                    "signal: mw6 trend followers gained inside crisis windows."),
        before_registration="No outcome of this test computed. Code checked on synthetic fixtures; plumbing run on WTI printed session and trade counts only (no R).",
        declared="Development evidence only. No test ledger, nothing qualified, no entries shipped.",
        instruments=INSTS, timeframes=list(TFS),
        alert=("abs11 A1 day-level intraday LR, out-of-sample walk-forward (lean21.alert_rows unchanged). A session is ARMED from the close "
               f"of the first scored 30-min row with P(big day) >= {ALERT_X} x trailing session base rate until the session end "
               "(22:00 UTC roll). Rows after the session already crossed T1 are not scored and cannot arm."),
        triggers=dict(primary="flip: production supertrend (10, 3) flip of the entry TF on a bar whose close >= arm time; side = flip",
                      variant_brk=f"brk: entry-TF mid close beyond the session's prior high/low, >= {BRK_MIN} min into the session; side = break"),
        filters=(f"spread rule: (ask_c - bid_c) at the signal bar <= {SPR_MAX} R; thin hours: no signal in the {THIN_N} UTC hours with the "
                 "highest median M5 spread/(1.5 ATR14) in 2018-2022 per instrument (notrade12 R3 rule, recomputed). Filtered signals are "
                 "not attempts."),
        entry="open of the bar after the signal bar; long at the ask, short at the bid",
        stops=dict(k=list(KS), initial="entry fill - k x Wilder ATR14 (mid, entry TF, signal bar); 1 R = k x ATR14",
                   trail_primary="supertrend line of the entry TF from the completed bar; trend flips against the position -> exit at the next open",
                   trail_variant=f"chandelier: highest mid high (short: lowest low) since entry - {CH_MULT} x ATR14, from completed bars",
                   ratchet="the stop only tightens; no intrabar update; no breakeven move; no target",
                   time_cap={tf: f"{CAP[tf]} bars (24 h), exit at the close" for tf in TFS},
                   session_exit_variant="exit at the close of the signal session's last bar"),
        attempts=f"up to {MAX_ATT} per armed session per instrument per TF, one open at a time (next signal bar >= previous exit bar)",
        fills="fills.resolve (labels_v2 semantics: gap through the stop fills at the open; exit side bid for long, ask for short)",
        comparisons=dict(C1="same policy on non-armed scored sessions, from the first scored 30-min close",
                         C2=("armed sessions, same triggers, random side (seeded). With the st trail a side against the supertrend exits at the next "
                             "open (the line is on the other side); C2 under the chandelier trail is the cleaner side null (sensitivity)."),
                         C3="all scored sessions, from the first scored 30-min close"),
        metrics=("R per armed day (sum R / sessions in the cell, zero-trade sessions included), R per attempt, hit rate, payoff ratio, share "
                 "of winning R from the top 10% of trades, max drawdown of cumulative R, daily CVaR 5%, median hold; crisis windows separately"),
        windows=dict(dev="2019-2022", w2023="2023-01-01 .. 2026-10-07T18:30 (development window)", stress=A.CRISES),
        stats=(f"moving-block bootstrap over calendar trading days (block {L.BLOCK}, {L.NREP} reps, seed {SEED}); ratio estimator sum R / "
               "sum sessions; pooled clusters all instruments by calendar day; differences armed - C share the day draws; MDE80 = 2.486 x SD"),
        decision_cells="6 = POOLED x {M5, M15} x k {0.5, 0.75, 1.0}, primary trigger (flip) + primary trail (st) + no session exit",
        decision_rule=("SUPPORTED if in BOTH dev and w2023: armed R/day CI lower bound > 0, armed - C1 CI lower bound > 0, armed - C2 CI lower "
                       "bound > 0, AND Holm (6 cells) of the intersection-union p (max of the six one-sided bootstrap p) < 0.05. REJECTED "
                       "if armed R/day CI upper bound < 0 in both windows. Else INCONCLUSIVE. Per-instrument cells, brk trigger, chandelier "
                       "trail, session exit, C3 and crisis windows are sensitivity only."),
        export="If any decision cell is SUPPORTED, export its exact policy as JSON for bot vigilance mode (https://github.com/mfittko/market-signals/issues/321).",
        budget=dict(timeframes=2, k=3, triggers=2, trails=2, session_exit=2, comparisons=3, decision_cells=6, tuned=0),
        code_sha256=CODE)
    json.dump(reg, open(f, "w"), indent=1)
    print("registered", reg["created"], CODE)


if __name__ == "__main__":
    {"check": check, "plumb": plumb, "register": register, "run": run, "today": today}[sys.argv[1]]()
