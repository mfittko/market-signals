"""mw6 (#314, queue item 6): multi-week regime layer. Deterministic multi-day policies on D1 (and H4) bid/ask bars,
big-week state as conditioning input, financing per held night, gaps filled at the gapped price, matched nulls.

Evaluator v2 (de_v2, bars, fills, validate) is imported, never edited. Run in data/research/engine/.venv.

  python mw6.py check              fixtures (rollover multiple, overnight/weekend gap through stop, gap in favor, P&L telescoping)
  python mw6.py register           write prereg.json (refuses to overwrite)
  python mw6.py amend "reason"     append an amendment with new code hashes
  python mw6.py run                all instruments -> out/results.json
"""
import os, sys, json, time, hashlib
import numpy as np
import pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ENG)
import bars  # noqa: E402
import de_v2 as de  # noqa: E402
from fills import resolve, side_bar, STOP  # noqa: E402
from arch.bootstrap import MovingBlockBootstrap  # noqa: E402

EXP = "mw6"
OUT = os.path.join(HERE, "out")
PRIMARY = ["WTICO/USD", "XAU/USD"]
ATTEMPTS = ["XAG/USD", "NATGAS/USD", "SPX500/USD", "EUR/USD"]   # declared separate attempts (coverage verified, out/coverage.json)
INSTS = PRIMARY + ATTEMPTS
RMULT = 3.0                      # 1R = 3 x ATR10(D1) (production supertrend ATR) at the decision bar
FIN = (0.0, 0.03, 0.06)          # financing, annualized share of notional, charged on long AND short, per calendar night held
FIN_BASE = 0.03
BLOCK = 20                       # bootstrap block, trading days
NBOOT = 1000
NNULL = 200
MAXHOLD = 20
WINDOWS = {"dev2019_22": ("2019-01-01", "2023-01-01"), "w2023": ("2023-01-01", "2100-01-01")}
CRISES = {"2020H1": ("2020-01-01", "2020-07-01"), "2022H1": ("2022-01-01", "2022-07-01"), "2025Q4_26Q1": ("2025-10-01", "2026-04-01")}
POLICIES = {
    "B1_tsmom60_h20": "daily tranche of 1/20 risk unit, side = sign(C_i - C_{i-60}), enter next open, exit open 20 bars later, no stop",
    "B2_tsmom120_h20": "same with 120-day lookback",
    "B3_tsmom20_h5": "daily tranche of 1/5 risk unit, side = sign(C_i - C_{i-20}), hold 5 bars, no stop",
    "B4_st_d1": "always-in D1 supertrend(10,3) follower: reverse at next open after a D1 flip; no stop (gaps at full size)",
    "B5_st_h4d1": "enter next open on the onset of H4 and D1 supertrend agreement, side = trend; initial stop 1R (3 ATR), "
                  "trailing stop = max(initial, D1 supertrend line) updated at each close; exit next open on a D1 flip or after 20 bars",
    "B6_donchian": "enter next open after a close beyond the prior 20-bar high/low; exit next open after a close beyond the prior "
                   "10-bar opposite extreme or after 20 bars; initial stop 1R",
    "C1_st_h4d1_bigweek": "B5 entries taken only when the big-week state is ON at the decision bar",
    "C2_tsmom60_bigweek": "B1 tranches taken only when the big-week state is ON at the decision bar",
}
GATED = {"C1_st_h4d1_bigweek": "B5_st_h4d1", "C2_tsmom60_bigweek": "B1_tsmom60_h20"}
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"mw6.py": sha(os.path.join(HERE, "mw6.py")), "coverage.py": sha(os.path.join(HERE, "coverage.py"))}
bars.MIN.update(H4=240, D1=1440)   # runtime only; epoch-aligned UTC buckets like scripts/indicators.mjs resampleCandles


# ------------------------------------------------------------------ data
def d1_bars(m1):
    """UTC-midnight D1 buckets (production alignment). Sunday/Saturday minutes (the 22:00 UTC session open stub) join
    Monday's bar so one bar = one trading day; declared deviation."""
    du = m1["t"] // 1440
    wd = (du + 3) % 7
    key = du + (wd == 6) + 2 * (wd == 5)
    return bars.resample({**m1, "t": key * 1440}, "D1")


def build(inst):
    m1 = bars.load_m1(inst)
    D = d1_bars(m1)
    S = de.supertrend(inst + "_D1", D)
    D["trend"] = np.nan_to_num(S["trend"]).astype(int); D["st"] = S["st"]; D["atr"] = S["atr"]
    H = bars.resample(m1, "H4")
    th = np.nan_to_num(de.supertrend(inst + "_H4", H)["trend"]).astype(int)
    j = np.searchsorted(H["t"] + 240, D["t"] + 1440, side="right") - 1      # last H4 bar CLOSED at the D1 decision time
    D["tr_h4"] = np.where(j >= 0, th[np.clip(j, 0, None)], 0)
    n = len(D["t"])
    D["day"] = D["t"] // 1440
    D["nights"] = np.r_[np.diff(D["day"]), 1]                                 # calendar nights to the next bar (Fri->Mon 3)
    c, h, l = (pd.Series(D["mid_" + k]) for k in "chl")
    for w in (5, 20):
        ex = ((h.rolling(w).max() - l.rolling(w).min()) / c.shift(w)).to_numpy()
        D[f"ex{w}"] = ex
        D[f"thr{w}"] = pd.Series(ex).shift(w).rolling(252, min_periods=200).quantile(0.9).to_numpy()
    for L in (20, 60, 120):
        D[f"mom{L}"] = np.sign((c - c.shift(L)).to_numpy())
    D["hi20"] = h.shift(1).rolling(20).max().to_numpy(); D["lo20"] = l.shift(1).rolling(20).min().to_numpy()
    D["hi10"] = h.shift(1).rolling(10).max().to_numpy(); D["lo10"] = l.shift(1).rolling(10).min().to_numpy()
    D["date"] = D["day"].astype("datetime64[D]")
    D["n"] = n
    return D


def floors(D):
    """Fixed per-instrument big-week floors: 90th percentile of ex5/ex20 over 2018 bars (warm-up year, before every
    evaluation window). Recorded in the prereg before any outcome is computed."""
    m = D["date"] < np.datetime64("2019-01-01")
    return {f"floor{w}": float(np.nanquantile(D[f"ex{w}"][m], 0.9)) for w in (5, 20)}


def big_state(D, fl):
    on = np.zeros(D["n"], bool)
    for w in (5, 20):
        ex, thr = D[f"ex{w}"], D[f"thr{w}"]
        on |= np.isfinite(ex) & ((np.isfinite(thr) & (ex >= thr)) | (ex >= fl[f"floor{w}"]))
    on &= np.isfinite(D["thr20"])        # state defined only after a year of history
    return on


# ------------------------------------------------------------------ execution
def fill_px(D, side, j, kind):
    """Open fill on bar j: buy at ask, sell at bid. kind 'in' opens side, 'out' closes it."""
    buy = (side > 0) == (kind == "in")
    return D["ask_o"][j] if buy else D["bid_o"][j]


def sim_path(D, e, side, stop, xmax, exit_sig=None, trail=None):
    """One trade entered at the open of bar e. Stop checked on the exit-side bar with fills.resolve (open at/through
    the stop fills at the open: overnight and weekend gaps at full size). exit_sig[j] (decided at close j) or reaching
    bar xmax exits at the next open. trail[j] is a candidate stop level known at close j. Returns (exit bar, fill)."""
    n = D["n"]
    s = side
    for j in range(e, n):
        o, hh, ll = side_bar(s, D["bid_o"][j], D["bid_h"][j], D["bid_l"][j], D["ask_o"][j], D["ask_h"][j], D["ask_l"][j])
        if np.isfinite(stop):
            r, p, _ = resolve(o, hh, ll, s * stop, np.inf)
            if int(r) == STOP:
                return j, float(p) * s
        if j + 1 >= n:
            return None, None                                           # censored
        if j + 1 >= xmax or (exit_sig is not None and exit_sig[j]):
            return j + 1, fill_px(D, s, j + 1, "out")
        if trail is not None and np.isfinite(trail[j]):
            stop = max(stop * s, trail[j] * s) * s if np.isfinite(stop) else trail[j]
    return None, None


def trade_rows(D, trades):
    """trades: list of (e, x, side, N, entry_fill, exit_fill). Per-trade net R parts and per-bar P&L arrays (cash units)."""
    n = D["n"]; C = D["mid_c"]
    pos = np.zeros(n + 1); held = np.zeros(n + 1); pt = np.zeros(n)
    out = []
    for e, x, s, N, pin, pout in trades:
        if x == e:
            pt[e] += s * N * (pout - pin)
        else:
            pt[e] += s * N * (C[e] - pin)
            pt[x] += s * N * (pout - C[x - 1])
            pos[e + 1] += s * N; pos[x] -= s * N
        held[e] += N; held[x] -= N
        fin_n = float(np.sum(C[e:x] * D["nights"][e:x])) * N / 365.0      # financing per unit annual rate
        mid_in, mid_out = D["mid_o"][e], (D["mid_o"][x] if pout in (D["bid_o"][x], D["ask_o"][x]) else pout)
        gross = s * N * (pout - pin)
        out.append(dict(e=e, x=x, s=s, N=N, gross=gross, spread=N * (abs(pin - mid_in) + abs(pout - mid_out)), fin_unit=fin_n))
    pos = np.cumsum(pos)[:n]; held = np.cumsum(held)[:n]
    dC = np.r_[0.0, np.diff(C)]
    pnl_gross = pt + pos * dC
    fin_unit = held * C * D["nights"] / 365.0
    return out, pnl_gross, fin_unit, held


def size(D, i):
    a = D["atr"][i]
    return 1.0 / (RMULT * a) if np.isfinite(a) and a > 0 else np.nan


# ------------------------------------------------------------------ policies -> trade lists
def tsmom(D, L, H, mask=None):
    trades = []
    sig = D[f"mom{L}"]
    n = D["n"]
    for i in range(n):
        if mask is not None and not mask[i]:
            continue
        s = sig[i]
        if not np.isfinite(s) or s == 0:
            continue
        e, x = i + 1, i + 1 + H
        N = size(D, i)
        if x >= n or not np.isfinite(N):
            continue
        trades.append((e, x, int(s), N / H, fill_px(D, s, e, "in"), fill_px(D, s, x, "out")))
    return trades


def st_d1(D):
    tr = D["trend"]; n = D["n"]
    flips = np.where((tr[1:] != tr[:-1]) & (tr[1:] != 0))[0] + 1
    trades = []
    for a, b in zip(flips, np.r_[flips[1:], n]):
        e, x = a + 1, b + 1
        N = size(D, a)
        if x >= n or not np.isfinite(N):
            continue
        s = int(tr[a])
        trades.append((e, x, s, N, fill_px(D, s, e, "in"), fill_px(D, s, x, "out")))
    return trades


def signals(D, name):
    """(entry decision bars, sides, exit_sig long, exit_sig short, trail) for the stop-based policies."""
    tr, th = D["trend"], D["tr_h4"]
    if name == "B5":
        agree = (tr != 0) & (tr == th)
        onset = agree & ~np.r_[False, agree[:-1]]
        ent = np.where(onset)[0]
        return ent, tr[ent], tr == -1, tr == 1, D["st"]
    up = D["mid_c"] > D["hi20"]; dn = D["mid_c"] < D["lo20"]
    ent = np.where(up | dn)[0]
    return ent, np.where(up[ent], 1, -1), D["mid_c"] < D["lo10"], D["mid_c"] > D["hi10"], None


def stop_policy(D, name, mask=None, sides=None, starts=None, durs=None):
    """Sequential (one position at a time). With `starts`/`durs`/`sides` given: matched-null re-simulation (same stop
    rule, exit at the original duration or the stop, overlapping allowed)."""
    n = D["n"]; trades = []
    if starts is not None:
        for i, s, d in zip(starts, sides, durs):
            e = i + 1; N = size(D, i)
            if e >= n or not np.isfinite(N):
                continue
            pin = fill_px(D, s, e, "in")
            x, pout = sim_path(D, e, s, pin - s / N, e + d)
            if x is not None:
                trades.append((e, x, s, N, pin, pout))
        return trades
    ent, side, xl, xs, trail = signals(D, name)
    busy = -1
    for i, s in zip(ent, side):
        if i < busy or (mask is not None and not mask[i]):
            continue
        e = i + 1; N = size(D, i)
        if e >= n or not np.isfinite(N):
            continue
        s = int(s)
        pin = fill_px(D, s, e, "in")
        x, pout = sim_path(D, e, s, pin - s / N, e + MAXHOLD, xl if s > 0 else xs,
                           (np.where(D["trend"] == s, trail, np.nan) if trail is not None else None))
        if x is None:
            break
        trades.append((e, x, s, N, pin, pout))
        busy = x  # the exit bar's decision may open the next trade (decided at close x, entered x+1)
    return trades


def policy_trades(D, name, big):
    if name == "B1_tsmom60_h20":
        return tsmom(D, 60, 20)
    if name == "B2_tsmom120_h20":
        return tsmom(D, 120, 20)
    if name == "B3_tsmom20_h5":
        return tsmom(D, 20, 5)
    if name == "B4_st_d1":
        return st_d1(D)
    if name == "B5_st_h4d1":
        return stop_policy(D, "B5")
    if name == "B6_donchian":
        return stop_policy(D, "B6")
    if name == "C1_st_h4d1_bigweek":
        return stop_policy(D, "B5", mask=big)
    if name == "C2_tsmom60_bigweek":
        return tsmom(D, 60, 20, mask=big)


def H_of(name):
    return 5 if "h5" in name else 20


def null_trades(D, name, trades, kind, rng, big_cov=None):
    """random-side: same entries and holding durations, random side, same stop rule (re-simulated).
    random-timing: entries circularly shifted by a random offset (sides and durations kept).
    thin: the ungated parent's trades randomly thinned to the gated policy's count."""
    n = D["n"]
    if not trades:
        return []
    e = np.array([t[0] for t in trades]); x = np.array([t[1] for t in trades]); s = np.array([t[2] for t in trades])
    dur = x - e
    if kind == "side":
        s = rng.choice([-1, 1], len(s))
    elif kind == "time":
        lo, hi = e.min(), e.max() + 1
        e = lo + (e - lo + rng.integers(1, hi - lo)) % (hi - lo)
    if name.startswith(("B1", "B2", "B3", "C2", "B4")):   # no-stop policies: exit at open after the same duration
        out = []
        for ee, ss, dd in zip(e, s, dur):
            xx = ee + dd
            N = size(D, ee - 1)
            if xx >= n or not np.isfinite(N):
                continue
            if name.startswith(("B1", "B2", "B3", "C2")):
                N = N / H_of(name)
            out.append((ee, xx, int(ss), N, fill_px(D, ss, ee, "in"), fill_px(D, ss, xx, "out")))
        return out
    return stop_policy(D, None, starts=e - 1, sides=s.astype(int), durs=dur)


# ------------------------------------------------------------------ metrics
def boot(series_list, stat, reps=NBOOT, seed=11):
    bs = MovingBlockBootstrap(BLOCK, *series_list, seed=seed)
    return np.array([stat(*a) for a, _ in bs.bootstrap(reps)])


def sharpe(x):
    sd = np.std(x)
    return float(np.mean(x) / sd * np.sqrt(252)) if sd > 0 else 0.0


def mdd(x):
    cum = np.cumsum(x); peak = np.maximum.accumulate(np.r_[0.0, cum])[1:]
    return float(np.max(peak - cum)) if len(cum) else 0.0


def pct(a):
    return [float(np.nanpercentile(a, 2.5)), float(np.nanpercentile(a, 97.5))]


def metrics(D, rows, pnl, held, m, nulls=None):
    """Window m (bar mask). pnl: net daily cash P&L per bar. rows: trades with net R (trades entered inside m)."""
    x = pnl[m]
    yrs = m.sum() / 252.0
    bt = boot([x], lambda a: [sharpe(a), a.mean() * 252])
    r = [t for t in rows if m[t["e"]]]
    net = np.array([t["netR"] for t in r]) if r else np.zeros(0)
    netR_full = np.array([t["netR"] / t["N"] * t["N0"] for t in r]) if r else np.zeros(0)
    fin = sum(t["fin"] for t in r); spr = sum(t["spread"] for t in r)
    o = dict(days=int(m.sum()), trades=len(r), sharpe=[sharpe(x), pct(bt[:, 0])], ann_return_R=[float(x.mean() * 252), pct(bt[:, 1])],
             total_R=float(x.sum()), maxdd_R=mdd(x), exposure_days=float((held[m] > 0).mean()),
             meanR_trade=float(net.mean()) if len(net) else None,
             worst_trade_R_fullsize=float(netR_full.min()) if len(net) else None,
             loss_beyond_1R_share=float((netR_full < -1).mean()) if len(net) else None,
             financing_R=float(fin), spread_R=float(spr), financing_share_of_costs=float(fin / (fin + spr)) if fin + spr > 0 else None,
             by_year={str(y): float(pnl[m & (D["date"] >= np.datetime64(f"{y}-01-01")) & (D["date"] < np.datetime64(f"{y + 1}-01-01"))].sum())
                      for y in range(2019, 2027)})
    o["years"] = round(yrs, 2)
    if nulls:
        for k, Z in nulls.items():                # Z: reps x bars net P&L
            zs = np.array([sharpe(z[m]) for z in Z])
            mu = Z[:, m].mean(0)
            bd = boot([x, mu], lambda a, b: (a - b).mean() * 252)
            o["vs_null_" + k] = dict(null_sharpe_mean=float(zs.mean()), null_sharpe_q95=float(np.quantile(zs, 0.95)),
                                     p_null_ge=float((zs >= o["sharpe"][0]).mean()),
                                     ann_diff_R=[float((x - mu).mean() * 252), pct(bd)])
    return o


def net_pnl(D, trades, rate):
    rows, g, fu, held = trade_rows(D, trades)
    for t, tr in zip(rows, trades):
        t["fin"] = t["fin_unit"] * rate
        t["netR"] = t["gross"] - t["fin"]
    return rows, g - fu * rate, held


# ------------------------------------------------------------------ labels (direction-bearing multi-day targets)
def labels(D, sig, H, k, m):
    """Sign agreement of `sig` with the forward return open(i+1)->open(i+1+H), and first passage of +/- k ATR_i from
    open(i+1) in the signal's direction over bars i+1..i+H (both in one bar: unresolved). Block bootstrap over decisions."""
    n = D["n"]; i = np.where(m & np.isfinite(sig) & (sig != 0))[0]; i = i[i + 1 + H < n]
    s = sig[i]
    fr = D["mid_o"][i + 1 + H] - D["mid_o"][i + 1]
    agree = (np.sign(fr) == s).astype(float)
    fp = np.full(len(i), np.nan)
    for q, ii in enumerate(i):
        p0 = D["mid_o"][ii + 1]; A = k * D["atr"][ii]
        for j in range(ii + 1, ii + 1 + H):
            up, dn = D["mid_h"][j] >= p0 + A, D["mid_l"][j] <= p0 - A
            if up and dn:
                break
            if up or dn:
                fp[q] = float((1 if up else -1) == s[q]); break
    res = fp[np.isfinite(fp)]
    bt = boot([agree], lambda a: a.mean())
    o = dict(n=len(i), eff_episodes=round(len(i) / H, 1), sign_hit=[float(agree.mean()), pct(bt)],
             fwd_R_mean=float(np.mean(s * fr / (RMULT * D["atr"][i]))))
    if len(res) > 20:
        o["first_passage_hit"] = [float(res.mean()), pct(boot([res], lambda a: a.mean()))]
        o["first_passage_resolved"] = int(len(res))
    return o


# ------------------------------------------------------------------ fixtures
def check():
    def mk(rows):
        a = np.array(rows, float)
        D = {"bid_o": a[:, 0], "bid_h": a[:, 1], "bid_l": a[:, 2], "bid_c": a[:, 3]}
        for k in "ohlc":
            D["ask_" + k] = D["bid_" + k] + 0.1
            D["mid_" + k] = D["bid_" + k] + 0.05
        D["n"] = len(a); D["atr"] = np.full(len(a), 1.0)
        return D
    # Fri bar 0, Mon bar 1 (weekend), Tue bar 2: nights 3, 1
    D = mk([[100, 101, 99.5, 100.5], [96, 97, 95, 96.5], [96.5, 97, 96, 96.8], [97, 98, 96.5, 97.5]])
    D["day"] = np.array([4, 7, 8, 9]); D["nights"] = np.r_[np.diff(D["day"]), 1]
    # weekend gap through the stop: long entered at Fri open (ask 100.1), stop 1R = 3 ATR -> 97.1; Monday opens 96 bid
    x, p = sim_path(D, 0, 1, 100.1 - 3.0, 10)
    assert (x, p) == (1, 96.0), (x, p)
    rows, g, fu, held = trade_rows(D, [(0, x, 1, 1 / 3, 100.1, p)])
    assert abs(rows[0]["gross"] - (96.0 - 100.1) / 3) < 1e-12 and rows[0]["gross"] < -1, "weekend gap loss beyond 1R kept at full size"
    assert abs(g.sum() - rows[0]["gross"]) < 1e-12, "daily P&L telescopes to the trade P&L"
    assert abs(rows[0]["fin_unit"] - 100.55 * 3 / 365 / 3) < 1e-12, "Fri->Mon hold is charged 3 nights (rollover-day multiple)"
    # overnight gap through the stop (Mon->Tue, 1 night): short entered Mon open at bid 96, stop 99; Tue opens 99.5 ask
    D2 = mk([[100, 101, 99, 100], [96, 97, 95.5, 96.5], [99.4, 100, 99, 99.6], [99, 99, 98, 98]])
    D2["day"] = np.array([4, 7, 8, 9]); D2["nights"] = np.r_[np.diff(D2["day"]), 1]
    x, p = sim_path(D2, 1, -1, 96 + 3.0, 10)
    assert x == 2 and abs(p - 99.5) < 1e-12, (x, p)
    # gap in favor: long entered Fri, Monday gaps up; exit signal at Monday close -> Tuesday open; no stop touch
    D3 = mk([[100, 101, 99.5, 100.5], [104, 105, 103.5, 104.5], [105, 106, 104, 105.5], [105, 106, 104, 105.5]])
    D3["day"] = np.array([4, 7, 8, 9]); D3["nights"] = np.r_[np.diff(D3["day"]), 1]
    x, p = sim_path(D3, 0, 1, 97.1, 10, exit_sig=np.array([False, True, False, False]))
    assert (x, p) == (2, 105.0), (x, p)
    rows, g, fu, held = trade_rows(D3, [(0, x, 1, 1 / 3, 100.1, p)])
    assert abs(rows[0]["fin_unit"] - (100.55 * 3 + 104.55 * 1) / 365 / 3) < 1e-12
    assert abs(rows[0]["spread"] - (1 / 3) * (0.05 + 0.05)) < 1e-12
    # stop in the entry bar (intrabar), not at the entry open
    x, p = sim_path(D3, 1, 1, 104.1 - 0.3, 10)
    assert (x, p) == (1, 103.8), (x, p)
    print("mw6 fixtures OK: weekend gap through stop (full-size loss), overnight gap through stop (short), gap in favor, "
          "entry-bar stop, Fri->Mon financing x3, P&L telescoping, spread accounting")


# ------------------------------------------------------------------ registration
def register(amend=None):
    Pf = os.path.join(HERE, "prereg.json")
    hashes = dict(evaluator=de.CODE_SHA, evaluator_files=de.CODE_FILES_SHA, **CODE)
    if amend:
        reg = json.load(open(Pf))
        reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=amend, code_sha256=hashes))
        reg["code_sha256"] = hashes
        json.dump(reg, open(Pf, "w"), indent=1); return
    assert not os.path.exists(Pf), "prereg.json exists; amend instead"
    fl = {}
    for inst in INSTS:
        D = build(inst)
        fl[inst] = floors(D)
    cov = json.load(open(os.path.join(OUT, "coverage.json")))
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="mw6: multi-week regime layer (#314, queue item 6): multi-day direction-bearing policies, big-week state, financing, gaps",
        question="Does any deterministic multi-day policy (time-series momentum, D1/H4 supertrend, donchian), alone or conditioned on "
                 "the big-week state, earn a positive net return after bid/ask, financing and gap fills, and beat matched nulls?",
        before_registration="Computed only coverage (coverage.py) and the 2018 feature floors below. No policy outcome, label or "
                            "null was computed before this file.",
        data=dict(source="data/research/history.db candles_ba M1 bid/ask (read-only)",
                  bars="D1: UTC-midnight buckets (production resampleCandles alignment) with the Sunday 22:00-24:00 UTC open stub "
                       "joined to Monday; H4: epoch-aligned UTC buckets. mid = (bid + ask) / 2 per field. Decision at the D1 close "
                       "(00:00 UTC); H4 trend from the last H4 bar closed at that time.",
                  primary=PRIMARY, attempts=ATTEMPTS,
                  coverage={k: dict(first=v["first"], last=v["last"], missing_weekday_sessions=v["n_missing"]) for k, v in cov.items()},
                  coverage_note="all six instruments: every year 2018-2026 has a full weekday session count; missing weekday "
                                "sessions are exchange holidays (13-24 per instrument over 8.8 years); newest bar within 1 day of "
                                "registration. XAG 2018-19 and NATGAS have thinner M1 (minutes without quotes), sessions present."),
        risk_unit="1R = 3 x ATR10(D1) (production supertrend Wilder ATR) at the decision bar; position N = 1/(3 ATR) cash per price "
                  "unit (equal cash risk). Tranche policies use N/H per tranche, so a full position is 1R of risk.",
        execution="enter at the next D1 open (buy ask / sell bid); exits at the next open after the exit decision or at the stop. "
                  "Stops are checked on the exit-side D1 bar with fills.resolve: an open at or through the stop fills at the open "
                  "(overnight and weekend gaps at full size; losses beyond 1R reported at full size). Daily P&L marks at the mid close.",
        financing=dict(rule="charged on long AND short positions: notional (N x mid close) x rate / 365 x calendar nights to the "
                            "next bar, for every bar the position is held at its close (Fri->Mon = 3 nights; this approximates "
                            "OANDA's rollover-day multiple: the weekly total matches, the day the multiple lands may differ)",
                       rates=list(FIN), base=FIN_BASE,
                       note="OANDA CFD financing = benchmark rate +/- admin fee (about 2.5 %); 3 % is a mid approximation, 6 % "
                            "conservative, 0 % the gross bound. Currency conversion costs: none (all instruments quote in USD; "
                            "a USD account)."),
        policies=POLICIES, max_hold=MAXHOLD,
        big_week_state="ON at decision bar i when ex5_i or ex20_i (range of the last 5 / 20 bars over the close 5 / 20 bars "
                       "before) >= the 90th percentile of the same measure over the 252 values whose windows ended before the "
                       "current window started, OR >= the fixed per-instrument floor. Undefined (OFF) before 200 prior values. "
                       "Consecutive ON days form one episode.",
        floors=fl,
        stress_index="count of the 6 instruments whose big-week state is ON at the same D1 decision date (all D1 bars close at "
                     "00:00 UTC). Reported as a conditioning diagnostic only; no policy uses it (candidate budget).",
        labels="per base signal (mom20/60/120, D1 trend, H4+D1 agreement trend): sign agreement with the 5-day and 20-day forward "
               "return (next open to open), first passage of +/- 2 ATR over 5 bars and +/- 4 ATR over 20 bars in the signal "
               "direction; split by big-week state. Diagnostics, not policies.",
        nulls=dict(random_side="same entries and holding durations, random side, same stop rule re-simulated (200 reps)",
                   random_timing="entries circularly shifted by a random offset within the trade span, sides and durations kept, "
                                 "stops re-simulated (200 reps)",
                   random_thinning="for C1/C2: the ungated parent's trades randomly thinned to the gated count (200 reps)",
                   pairing="daily P&L minus the null's mean daily P&L, 20-day moving-block bootstrap CI of the annualized "
                           "difference; and the share of null Sharpe ratios >= the policy's"),
        windows=dict(dev="2019-01-01..2022-12-31 (2018 is warm-up for the 120-day lookback and the 252-day percentile). Rules "
                         "have no fitted parameters, so walk-forward refitting is void; the trailing percentiles are causal.",
                     w2023="2023-01-01..newest: DEVELOPMENT window (inspected before), never a holdout", crises=CRISES),
        objective=dict(
            primary="per policy and instrument (and the 6-instrument equal-risk pooled portfolio as a declared attempt): annualized "
                    "Sharpe-like ratio of net daily cash P&L at 3 % financing, 20-day moving-block bootstrap 95 % CI",
            minimum_useful_effect="Sharpe CI lower bound > 0 AND paired annualized difference vs the random-side null CI lower "
                                  "bound > 0, in dev2019_22 AND in w2023, at 3 % financing; for C1/C2 also vs random thinning",
            risk_constraints="max drawdown <= 15 R per instrument (point); worst single trade at full size >= -2.5 R in every "
                             "crisis window; loss-beyond-1R share reported",
            references="no-trade (0), the always-on parent (C1 vs B5, C2 vs B1), random-side, random-timing, random-thinning",
            sample="report effective episodes (trades; tranche days / H); a cell with < 30 effective episodes is underpowered",
            multiplicity="no correction: every window is development data; any candidate goes to prospective shadow (#313) as "
                         "the binding confirmation",
            verdict_scope="development evidence only; nothing is qualified; at most 'worth registering for prospective shadow'",
            no_switch="objective, MUE and constraints fixed here"),
        budget=dict(candidates=len(POLICIES), instruments=len(INSTS), financing_levels=len(FIN),
                    ml="none (deterministic first; ML is skipped within this time box)",
                    note="every cell logged to trials.jsonl (exp mw6)"),
        rules="no test_ledger use; nothing marked qualified; development evidence only",
        code_sha256=hashes)
    json.dump(reg, open(Pf, "w"), indent=1)
    print(json.dumps(fl, indent=1))


# ------------------------------------------------------------------ run
def run():
    t0 = time.time()
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    assert reg["code_sha256"]["mw6.py"] == CODE["mw6.py"], "mw6.py changed after registration (amend first)"
    assert reg["code_sha256"]["evaluator"] == de.CODE_SHA
    rng = np.random.default_rng(6)
    Ds, BIG = {}, {}
    for inst in INSTS:
        Ds[inst] = build(inst)
        BIG[inst] = big_state(Ds[inst], reg["floors"][inst])
    res = dict(prereg_created=reg["created"], code=CODE, evaluator=de.CODE_SHA, inst={}, pooled={}, stress={})
    daily = {}   # (policy, rate) -> {inst: Series by date}
    for inst in INSTS:
        D, big = Ds[inst], BIG[inst]
        R = dict(data_first=str(D["date"][0]), data_last=str(D["date"][-1]), bars=int(D["n"]), policies={}, labels={}, state={})
        masks = {w: (D["date"] >= np.datetime64(a)) & (D["date"] < np.datetime64(b)) for w, (a, b) in {**WINDOWS, **CRISES}.items()}
        # big-week state diagnostics
        fwd5 = np.full(D["n"], np.nan)
        e5 = (pd.Series(D["mid_h"]).rolling(5).max().shift(-5) - pd.Series(D["mid_l"]).rolling(5).min().shift(-5)) / D["mid_c"]
        fwd5[:] = e5.to_numpy()
        for w, m in masks.items():
            mm = m & np.isfinite(fwd5) & np.isfinite(D["thr5"])
            bigfwd = mm & (fwd5 >= D["thr5"])
            epi = np.diff(np.r_[0, (big & m).astype(int)]) == 1
            R["state"][w] = dict(on_share=float(big[m].mean()), episodes=int(epi.sum()),
                                 first_on=str(D["date"][m & big][0]) if (m & big).any() else None,
                                 first_on_lag_days=int(np.argmax(big[m])) if (m & big).any() else None,
                                 recall_fwd_bigweek=float(big[bigfwd].mean()) if bigfwd.any() else None,
                                 calm_false_alert_share=float((big & mm & (fwd5 < np.nanmedian(fwd5[mm]))).sum() / max(1, (big & mm).sum())),
                                 fwd_ex5_on=float(np.nanmean(fwd5[mm & big])) if (mm & big).any() else None,
                                 fwd_ex5_off=float(np.nanmean(fwd5[mm & ~big])) if (mm & ~big).any() else None)
        # labels
        agree = np.where((D["trend"] != 0) & (D["trend"] == D["tr_h4"]), D["trend"], 0).astype(float)
        sigs = {"mom20": D["mom20"], "mom60": D["mom60"], "mom120": D["mom120"], "st_d1": D["trend"].astype(float), "st_h4d1": agree}
        for w in WINDOWS:
            for sn, sg in sigs.items():
                for H, k in ((5, 2.0), (20, 4.0)):
                    for part, pm in (("all", masks[w]), ("big_on", masks[w] & big), ("big_off", masks[w] & ~big)):
                        o = labels(D, sg, H, k, pm)
                        R["labels"][f"{w}/{sn}/H{H}/{part}"] = o
                        de.log_trial({"exp": EXP + "-label", "mode": "dev" if w == "dev2019_22" else "devwindow2023", "inst": inst,
                                      "signal": sn, "H": H, "part": part, "sign_hit": o["sign_hit"][0], "mw6_sha256": CODE["mw6.py"]})
        print(inst, "labels done", round(time.time() - t0), "s", flush=True)
        # policies
        for name in POLICIES:
            trades = policy_trades(D, name, big)
            N0 = {}
            for t in trades:
                N0[(t[0], t[1])] = t[3] * (H_of(name) if name.startswith(("B1", "B2", "B3", "C2")) else 1)
            nulls = {}
            kinds = ["side", "time"] + (["thin"] if name in GATED else [])
            parent = policy_trades(D, GATED[name], big) if name in GATED else None
            for kind in kinds:
                Z = []
                for _ in range(NNULL):
                    if kind == "thin":
                        k = rng.choice(len(parent), size=min(len(trades), len(parent)), replace=False)
                        nt = [parent[q] for q in sorted(k)]
                    else:
                        nt = null_trades(D, name, trades, kind, rng)
                    Z.append(net_pnl(D, nt, FIN_BASE)[1])
                nulls[kind] = np.array(Z)
            P = {}
            for rate in FIN:
                rows, pnl, held = net_pnl(D, trades, rate)
                for t in rows:
                    t["N0"] = N0[(t["e"], t["x"])]
                daily.setdefault((name, rate), {})[inst] = pd.Series(pnl, index=D["date"])
                P[str(rate)] = {w: metrics(D, rows, pnl, held, m, nulls if rate == FIN_BASE and w in WINDOWS else None)
                                for w, m in masks.items()}
                for w in masks:
                    q = P[str(rate)][w]
                    de.log_trial({"exp": EXP, "mode": "dev" if w == "dev2019_22" else "devwindow", "inst": inst, "policy": name,
                                  "fin": rate, "window": w, "sharpe": q["sharpe"][0], "trades": q["trades"], "mw6_sha256": CODE["mw6.py"]})
            P["eff_episodes"] = {w: (round(float(sum(min(t[1] - t[0], H_of(name)) for t in trades if masks[w][t[0]]) / H_of(name)), 1)
                                     if name.startswith(("B1", "B2", "B3", "C2")) else sum(1 for t in trades if masks[w][t[0]]))
                                 for w in masks}
            R["policies"][name] = P
            b = P[str(FIN_BASE)]["dev2019_22"]; c = P[str(FIN_BASE)]["w2023"]
            print(inst, name, "dev S", round(b["sharpe"][0], 2), [round(v, 2) for v in b["sharpe"][1]], "n", b["trades"],
                  "| 2023+ S", round(c["sharpe"][0], 2), [round(v, 2) for v in c["sharpe"][1]], round(time.time() - t0), "s", flush=True)
        res["inst"][inst] = R
    # stress index
    st = pd.DataFrame({k: pd.Series(BIG[k].astype(int), index=Ds[k]["date"]) for k in INSTS}).fillna(0).sum(1)
    res["stress"] = {w: dict(mean=float(st[(st.index >= np.datetime64(a)) & (st.index < np.datetime64(b))].mean()),
                             share_ge3=float((st[(st.index >= np.datetime64(a)) & (st.index < np.datetime64(b))] >= 3).mean()))
                     for w, (a, b) in {**WINDOWS, **CRISES}.items()}
    # pooled equal-risk portfolio (declared attempt)
    for (name, rate), byi in daily.items():
        df = pd.DataFrame(byi).fillna(0.0)
        for scope, cols in (("all6", INSTS), ("wti_xau", PRIMARY)):
            s = df[cols].sum(1)
            out = {}
            for w, (a, b) in {**WINDOWS, **CRISES}.items():
                x = s[(s.index >= np.datetime64(a)) & (s.index < np.datetime64(b))].to_numpy()
                bt = boot([x], lambda v: sharpe(v))
                out[w] = dict(sharpe=[sharpe(x), pct(bt)], ann_R=float(x.mean() * 252), maxdd_R=mdd(x), days=len(x))
            res["pooled"].setdefault(name, {}).setdefault(str(rate), {})[scope] = out
            de.log_trial({"exp": EXP + "-pooled", "mode": "dev", "policy": name, "fin": rate, "scope": scope,
                          "sharpe_dev": out["dev2019_22"]["sharpe"][0], "mw6_sha256": CODE["mw6.py"]})
    res["secs"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    print("done", res["secs"], "s")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "check":
        check()
    elif mode == "register":
        register()
    elif mode == "amend":
        register(sys.argv[2])
    elif mode == "run":
        run()
