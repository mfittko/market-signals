"""orb15 (queue v2 item 15): opening-range breakout, failed-breakout fade, first-hour -> last-hour momentum, EIA Wednesday
conditional momentum (WTI). Evaluator v2 helpers (fills.resolve via dt14.range_sim, validate.day_boot) and the nt12 / dt14 /
abs11 helpers are imported, never edited. Development evidence only; nothing is qualified; no test ledger.

  python orb15.py check       synthetic self-checks
  python orb15.py register    prereg.json (refuses to overwrite)
  python orb15.py amend "why" append an amendment with new code hashes
  python orb15.py build INST  events + outcomes (actual, mirror side, random-clock draws) -> out/ev_<TAG>.pkl
  python orb15.py run         statistics -> out/results.json
"""
import os, sys, json, time, hashlib
from datetime import datetime, date
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
import abs11  # noqa: E402
import dt14  # noqa: E402

EXP = "orb15"
INSTS = nt12.INSTS
TAG = lambda inst: inst.replace("/", "_")
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"orb15.py": sha(os.path.join(HERE, "orb15.py")), "dt14.py": dt14.CODE["dt14.py"], "nt12.py": nt12.CODE["nt12.py"],
        "abs11.py": abs11.CODE["abs11.py"], "evaluator": de.CODE_SHA}

MAIN_OPEN = dt14.MAIN_OPEN
# main close (local exchange clock, DST-aware): NYMEX settle 14:30 ET, COMEX gold settle 13:30 ET, NYSE 16:00 ET, London 16:00
MAIN_CLOSE = {"WTICO/USD": ("America/New_York", 14, 30), "NATGAS/USD": ("America/New_York", 14, 30),
              "SPX500/USD": ("America/New_York", 16, 0), "XAU/USD": ("America/New_York", 13, 30),
              "XAG/USD": ("America/New_York", 13, 30), "EUR/USD": ("Europe/London", 16, 0)}
MIN_COVER = 0.8
DEADLINE = 60        # ORB / fade signal bar must close >= 60 min before the main close
STOP_BUF = 0.25      # fade stop buffer (ATR M5), as dt14
LAST = 60            # last-hour momentum holding window (min)
SPR_R = nt12.SPR_R
RC_LO, RC_HI, RC_EXCL, NRC = -120, 180, 30, 200   # random clock: start offsets from the main open (min), |offset| >= 30, 200 draws/day
NBOOT, NSIDE, NEIA = 1000, 1000, 1000
VARIANTS = ["orb15", "orb30", "fade15", "fade30", "mom30", "mom60", "eia"]
CRISES = abs11.CRISES
dnum = abs11.dnum
ET = ZoneInfo("America/New_York")


def utc_min(d, tz, hh, mm):
    dt = np.datetime64(int(d), "D").astype(datetime)
    return int(datetime(dt.year, dt.month, dt.day, hh, mm, tzinfo=ZoneInfo(tz)).timestamp() // 60)


# ------------------------------------------------------------------ pure helpers
def orb_signal(mh, ml, mc, s, k, dl, fade):
    """Opening range = M5 bars [s, s+k). Breakout bar = first bar j in [s+k, dl) with mid close > H0 (long) or < L0 (short).
    fade=False: returns (signal bar j, side, stop = other side of the range, target None).
    fade=True: after the breakout, first bar j2 in (j, dl) whose mid close is back inside the range -> opposite side,
    stop = breakout extreme (mid high/low from j to j2) +/- STOP_BUF ATR (caller adds), target = the other side of the range.
    Returns None when nothing triggers."""
    H0, L0 = mh[s:s + k].max(), ml[s:s + k].min()
    if not H0 > L0 or dl <= s + k:
        return None
    seg = mc[s + k:dl]
    hit = np.flatnonzero((seg > H0) | (seg < L0))
    if not len(hit):
        return None
    j = s + k + hit[0]; d = 1 if mc[j] > H0 else -1
    if not fade:
        return j, d, (L0 if d > 0 else H0), None, H0, L0
    seg2 = mc[j + 1:dl]
    back = np.flatnonzero(seg2 < H0) if d > 0 else np.flatnonzero(seg2 > L0)
    if not len(back):
        return None
    j2 = j + 1 + back[0]
    ext = mh[j:j2 + 1].max() if d > 0 else ml[j:j2 + 1].min()
    return j2, -d, ext, (L0 if d > 0 else H0), H0, L0


def window_ret(B, a, b, e, x, R):
    """Predictor sign = sign(mid open of bar b - mid open of bar a) (return over [t_a, t_b)); trade from the open of bar e
    to the open of bar x. Returns sign, net long R, net short R, gross long R (mid)."""
    sg = np.sign(B["mid_o"][b] - B["mid_o"][a])
    nl = (B["bid_o"][x] - B["ask_o"][e]) / R
    ns = (B["bid_o"][e] - B["ask_o"][x]) / R
    gl = (B["mid_o"][x] - B["mid_o"][e]) / R
    return sg, nl, ns, gl


def check():
    # ORB on a synthetic path: range bars 0-2 (H0 10.2, L0 9.8), breakout close 10.3 at bar 4
    mh = np.array([10.2, 10.1, 10.0, 10.1, 10.35, 10.2, 10.1, 10.0, 9.9])
    ml = np.array([9.9, 9.8, 9.9, 10.0, 10.1, 10.0, 9.95, 9.9, 9.8])
    mc = np.array([10.0, 9.9, 10.0, 10.1, 10.3, 10.25, 10.15, 10.0, 9.85])
    r = orb_signal(mh, ml, mc, 0, 3, 9, False)
    assert r[:3] == (4, 1, 9.8), r
    r = orb_signal(mh, ml, mc, 0, 3, 9, True)  # back inside (close 10.15 < 10.2) at bar 6 -> short, stop at max high 10.35, target 9.8
    assert r[:4] == (6, -1, 10.35, 9.8), r
    assert orb_signal(mh, ml, mc, 0, 3, 4, False) is None   # deadline before any breakout
    assert orb_signal(mh, ml, mc, 0, 3, 6, True) is None    # no re-entry before the deadline
    B = {k: np.array([10.0, 10.0, 10.5, 11.0]) for k in ("mid_o",)}
    B["bid_o"] = B["mid_o"] - 0.05; B["ask_o"] = B["mid_o"] + 0.05
    sg, nl, ns, gl = window_ret(B, 0, 2, 2, 3, 0.5)
    assert sg == 1 and abs(nl - (10.95 - 10.55) / 0.5) < 1e-12 and abs(ns - (10.45 - 11.05) / 0.5) < 1e-12 and abs(gl - 1.0) < 1e-12
    # ORB through the evaluator simulator: long entry with an unreachable target exits at the session end
    n = 6
    BB = {k: np.full(n, 10.0) for k in ("bid_o", "bid_h", "bid_l", "bid_c", "mid_o", "mid_h", "mid_l", "mid_c")}
    BB.update({k: np.full(n, 10.1) for k in ("ask_o", "ask_h", "ask_l", "ask_c")}); BB["t"] = np.arange(n) * 5
    BB["bid_o"][4] = 10.6
    net, ok = dt14.range_sim(BB, np.array([1]), np.array([1]), np.array([9.6]), np.array([1e12]), np.array([4]))
    assert ok[0] and abs(net[0] - (10.6 - 10.1) / 0.5) < 1e-12, net
    net, ok = dt14.range_sim(BB, np.array([1]), np.array([-1]), np.array([10.6]), np.array([-1e12]), np.array([4]))
    assert ok[0] and abs(net[0] - (10.0 - BB["ask_o"][4]) / 0.6) < 1e-12, net
    # EIA calendar: 2018-07-04 is a Wednesday holiday -> Thursday 11:00 ET
    rel = nt12.eia_crude(2018, 2018)
    d = [datetime.utcfromtimestamp(m * 60).replace(tzinfo=ZoneInfo("UTC")).astimezone(ET) for m in rel]
    assert any(x.date() == date(2018, 7, 5) and x.hour == 11 for x in d) and all(x.weekday() in (2, 3) for x in d)
    print("orb15 self-check OK: ORB / fade signal, window returns (bid/ask), session-end exit via dt14.range_sim, EIA holiday shift")


# ------------------------------------------------------------------ build
def load(inst):
    m1, src = nt12.load_m1c(inst)
    B = nt12.frame(inst, m1, "M5", nt12.h1(inst, m1))
    thin, _ = nt12.thin_hours(B)
    return B, thin, src


def sessions(inst, B):
    t = B["t"]
    days = np.unique(B["day"]); days = days[((days + 3) % 7) < 5]
    op = np.array([utc_min(d, *MAIN_OPEN[inst]) for d in days]); cl = np.array([utc_min(d, *MAIN_CLOSE[inst]) for d in days])
    a = np.searchsorted(t, op); b = np.searchsorted(t, cl)
    ac, bc = np.clip(a, 0, len(t) - 1), np.clip(b, 0, len(t) - 1)
    valid = (t[ac] == op) & (t[bc] == cl) & (b - a >= MIN_COVER * (cl - op) / 5)
    return pd.DataFrame({"day": days, "open": op, "close": cl, "a": a, "b": b, "valid": valid})


def idx_at(t, m):
    """Index of the M5 bar starting exactly at minute m, else -1."""
    i = np.searchsorted(t, m); ic = np.clip(i, 0, len(t) - 1)
    return np.where(t[ic] == m, ic, -1)


def orb_events(B, S, starts, k, fade, draw):
    """One event per row of S (session) for the given start bar indices. Returns a list of dicts (signal / stop / target)."""
    t, mh, ml, mc = B["t"], B["mid_h"], B["mid_l"], B["mid_c"]
    dl = np.searchsorted(t, S.close.to_numpy() - DEADLINE - 5, side="right")   # bars with t + 5 <= close - 60
    ev = []
    for r, s in enumerate(starts):
        if s < 0 or not S.valid.iat[r]:
            continue
        if s + k >= len(t) or t[s + k - 1] - t[s] != 5 * (k - 1):
            continue   # range bars must be contiguous
        res = orb_signal(mh, ml, mc, s, k, dl[r], fade)
        if res is None:
            continue
        j, d, stop, tgt, H0, L0 = res
        atr = B["atr"][j]
        if not (np.isfinite(atr) and atr > 0):
            continue
        if fade:
            stop = stop - d * STOP_BUF * atr   # short fade: above the breakout high; long fade: below the breakout low
        ev.append(dict(day=int(S.day.iat[r]), r=r, j=int(j), side=int(d), stop=float(stop), tgt=float(tgt) if tgt is not None else np.nan,
                       ref=float(mc[j]), end=int(S.b.iat[r]), draw=draw, start_off=int(t[s] - S.open.iat[r])))
    return ev


def sim_orb(B, E):
    """Actual side and the mirror side (same entry bar, stop and target reflected through the signal-bar mid close).
    Spread rule: ask_c - bid_c at the signal bar <= 0.2 * |signal mid close - stop|."""
    if not len(E):
        return E
    j = E.j.to_numpy(); e = j + 1; s = E.side.to_numpy(); st = E.stop.to_numpy(); ref = E.ref.to_numpy(); end = E.end.to_numpy()
    tg = E.tgt.to_numpy()
    tg_a = np.where(np.isfinite(tg), tg, s * 1e12)
    st_m = 2 * ref - st; tg_m = np.where(np.isfinite(tg), 2 * ref - tg, -s * 1e12)
    out = {}
    for nm, sd, sp, tp in (("act", s, st, tg_a), ("mir", -s, st_m, tg_m)):
        for mode, mid in (("net", False), ("gross", True)):
            v, ok = dt14.range_sim(B, e, sd, sp, tp, end, mid=mid)
            out[f"{nm}_{mode}"] = np.where(ok, v, np.nan)
    E = E.copy()
    for k_, v in out.items():
        E[k_] = v
    E["spr"] = (B["ask_c"][j] - B["bid_c"][j]) / np.abs(ref - st)
    E["ok"] = (E.spr <= SPR_R) & np.isfinite(E.act_net) & np.isfinite(E.mir_net) & np.isfinite(E.act_gross)
    return E


def rc_starts(B, S, thin, rng, minlen):
    """Random-clock start bars: per session, a 5-min grid offset in [RC_LO, RC_HI] min from the main open, |offset| >= RC_EXCL,
    start hour not a thin hour, start + minlen + DEADLINE <= main close. Returns (NRC, n_sessions) bar indices (-1 = none)."""
    offs = np.arange(RC_LO, RC_HI + 1, 5); offs = offs[np.abs(offs) >= RC_EXCL]
    out = np.full((NRC, len(S)), -1)
    for r in range(len(S)):
        if not S.valid.iat[r]:
            continue
        m = S.open.iat[r] + offs
        okm = (((m // 60) % 24)[:, None] != np.array(thin)[None, :]).all(1) & (m + minlen + DEADLINE <= S.close.iat[r])
        cand = m[okm]
        if not len(cand):
            continue
        out[:, r] = idx_at(B["t"], rng.choice(cand, NRC))
    return out


def mom_events(B, S, a_idx, m, draw):
    """First-m-minutes sign from bar a -> last hour [close - 60, close). One row per session."""
    t = B["t"]; e = idx_at(t, S.close.to_numpy() - LAST); x = S.b.to_numpy()
    rows = []
    for r in range(len(S)):
        a = a_idx[r]
        if a < 0 or not S.valid.iat[r] or e[r] < 1:
            continue
        b = idx_at(t, np.array([t[a] + m]))[0]
        if b < 0 or b > e[r]:
            continue
        R = POLICY["k"] * B["atr"][e[r] - 1]
        if not (np.isfinite(R) and R > 0):
            continue
        sg, nl, ns, gl = window_ret(B, a, b, e[r], x[r], R)
        spr = (B["ask_c"][e[r] - 1] - B["bid_c"][e[r] - 1]) / R
        rows.append(dict(day=int(S.day.iat[r]), sg=sg, nl=nl, ns=ns, gl=gl, spr=spr, draw=draw, start_off=int(t[a] - S.open.iat[r])))
    return rows


def eia_events(B):
    """WTI: predictor [release, release + 30) -> trade 14:00-14:30 ET same date. Null days: Mon/Tue/Thu/Fri non-release dates,
    predictor 10:30-11:00 ET. Release weeks shifted to Thursday 11:00 ET use 11:00-11:30 ET."""
    t = B["t"]
    rel = np.array(nt12.eia_crude(2017, 2026), np.int64)
    rows = []
    days = np.unique(B["day"]); days = days[((days + 3) % 7) < 5]
    rel_by_day = {int((m + 120) // 1440): m for m in rel}
    for d in days:
        d = int(d)
        is_rel = d in rel_by_day
        p0 = rel_by_day[d] if is_rel else utc_min(d, "America/New_York", 10, 30)
        if not is_rel and ((d + 3) % 7) == 2:
            continue   # a Wednesday without a release (holiday week) is neither event nor null
        a, b = idx_at(t, np.array([p0, p0 + 30]))
        e, x = idx_at(t, np.array([utc_min(d, "America/New_York", 14, 0), utc_min(d, "America/New_York", 14, 30)]))
        if min(a, b, e, x) < 1:
            continue
        R = POLICY["k"] * B["atr"][e - 1]
        if not (np.isfinite(R) and R > 0):
            continue
        sg, nl, ns, gl = window_ret(B, a, b, e, x, R)
        rows.append(dict(day=d, is_rel=is_rel, sg=sg, nl=nl, ns=ns, gl=gl, spr=(B["ask_c"][e - 1] - B["bid_c"][e - 1]) / R))
    return pd.DataFrame(rows)


def check_reg():
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    cur = reg["amendments"][-1]["code_sha256"] if reg.get("amendments") else reg["code_sha256"]
    assert cur["orb15.py"] == CODE["orb15.py"], "orb15.py changed after registration (amend first)"


def build(inst):
    check_reg()
    t0 = time.time()
    B, thin, src = load(inst)
    S = sessions(inst, B)
    rng = np.random.default_rng(15 + INSTS.index(inst))
    a0 = np.where(S.valid, S.a, -1)
    res = {}
    for k_min in (15, 30):
        k = k_min // 5
        RC = rc_starts(B, S, thin, rng, k_min)
        for fade in (False, True):
            nm = f"{'fade' if fade else 'orb'}{k_min}"
            ev = orb_events(B, S, a0, k, fade, -1)
            for dr in range(NRC):
                ev += orb_events(B, S, RC[dr], k, fade, dr)
            res[nm] = sim_orb(B, pd.DataFrame(ev))
    for m in (30, 60):
        RC = rc_starts(B, S, thin, rng, m)
        rows = mom_events(B, S, a0, m, -1)
        for dr in range(NRC):
            rows += mom_events(B, S, RC[dr], m, dr)
        res[f"mom{m}"] = pd.DataFrame(rows)
    if inst == "WTICO/USD":
        res["eia"] = eia_events(B)
    for v in res.values():
        v["inst"] = inst
    pd.to_pickle(dict(res=res, sessions=int(S.valid.sum()), thin=thin, m1=src), os.path.join(OUT, f"ev_{TAG(inst)}.pkl"))
    print(json.dumps(dict(inst=inst, sessions=int(S.valid.sum()), thin=thin, m1=src, secs=round(time.time() - t0),
                          actual={k: int((v.draw == -1).sum()) if "draw" in v else int(v.is_rel.sum()) for k, v in res.items()})), flush=True)


# ------------------------------------------------------------------ run
def wins(last_day):
    w = {"dev": (year_start_day(2018), year_start_day(2023)), "w2023": (year_start_day(2023), last_day + 1)}
    w.update({c: (dnum(a), min(dnum(b), last_day + 1)) for c, (a, b) in CRISES.items()})
    return w


def trade_table(var, D):
    """Actual trades (one per instrument-day) with net, gross, mirror (random side) and null columns."""
    if var.startswith(("orb", "fade")):
        A = D[(D.draw == -1) & D.ok]
        return pd.DataFrame({"inst": A.inst, "day": A.day, "net": A.act_net, "gross": A.act_gross, "mir": A.mir_net})
    if var.startswith("mom"):
        A = D[(D.draw == -1) & (D.sg != 0) & (D.spr <= SPR_R)]
        return pd.DataFrame({"inst": A.inst, "day": A.day, "net": np.where(A.sg > 0, A.nl, A.ns),
                             "gross": A.sg * A.gl, "mir": np.where(A.sg > 0, A.ns, A.nl), "long": A.nl})
    A = D[D.is_rel & (D.sg != 0) & (D.spr <= SPR_R)]
    return pd.DataFrame({"inst": A.inst, "day": A.day, "net": np.where(A.sg > 0, A.nl, A.ns), "gross": A.sg * A.gl,
                         "mir": np.where(A.sg > 0, A.ns, A.nl), "long": A.nl})


def null_clock(var, D, lo, hi):
    """Mean net R/trade per random-clock draw (orb/fade/mom) or per random same-size subset of non-release days (eia)."""
    if var.startswith(("orb", "fade")):
        N = D[(D.draw >= 0) & D.ok & (D.day >= lo) & (D.day < hi)]
        return N.groupby("draw").act_net.mean().to_numpy()
    if var.startswith("mom"):
        N = D[(D.draw >= 0) & (D.sg != 0) & (D.spr <= SPR_R) & (D.day >= lo) & (D.day < hi)]
        return pd.Series(np.where(N.sg > 0, N.nl, N.ns)).groupby(N.draw.to_numpy()).mean().to_numpy()
    N = D[~D.is_rel & (D.sg != 0) & (D.spr <= SPR_R) & (D.day >= lo) & (D.day < hi)]
    x = np.where(N.sg > 0, N.nl, N.ns)
    n = int((D.is_rel & (D.sg != 0) & (D.spr <= SPR_R) & (D.day >= lo) & (D.day < hi)).sum())
    rng = np.random.default_rng(1515)
    return np.array([rng.choice(x, n, replace=False).mean() for _ in range(NEIA)]) if n and len(x) >= n else np.array([np.nan])


def stats(T, lo, hi, nboot, rng, nullc):
    m = ((T.day >= lo) & (T.day < hi)).to_numpy()
    X = T[m].reset_index(drop=True)
    if len(X) < 20:
        return None
    net, mir, day = X.net.to_numpy(), X.mir.to_numpy(), X.day.to_numpy()
    has_long = "long" in X
    lng = X.long.to_numpy() if has_long else None
    ndays = hi - lo

    def stat(ix):
        return np.array([net[ix].mean(), (net[ix] > 0).mean(), (net[ix].mean() - lng[ix].mean()) if has_long else np.nan])
    Tst = stat(np.arange(len(X)))
    bt = day_boot(day, np.arange(day.min(), day.max() + 1), stat, nboot, seed=15)
    ci = lambda j: [float(Tst[j]), float(np.nanpercentile(bt[:, j], 2.5)), float(np.nanpercentile(bt[:, j], 97.5))]
    # random side: coin flip per trade between the actual and the mirror outcome
    flips = rng.random((NSIDE, len(X))) < 0.5
    rs = np.where(flips, mir[None, :], net[None, :]).mean(1)
    nc = nullc[np.isfinite(nullc)]
    sessions_days = len(np.unique(day))
    o = dict(trades=int(len(X)), trades_per_year=float(len(X) / (ndays / 365.25)), net_per_trade=ci(0), hit=ci(1),
             gross_per_trade=float(X.gross.mean()), cost_per_trade=float(X.gross.mean() - X.net.mean()),
             net_per_day=float(net.sum() / sessions_days), se=float(np.nanstd(bt[:, 0])), mde=float(2.8 * np.nanstd(bt[:, 0])),
             p_le0=float((np.sum(bt[:, 0] <= 0) + 1) / (len(bt) + 1)),
             side=dict(mean=float(rs.mean()), q=[float(np.quantile(rs, 0.025)), float(np.quantile(rs, 0.975))],
                       p=float((np.sum(rs >= Tst[0]) + 1) / (NSIDE + 1))),
             clock=dict(mean=float(nc.mean()) if len(nc) else None, q=[float(np.quantile(nc, 0.025)), float(np.quantile(nc, 0.975))] if len(nc) else None,
                        n=int(len(nc)), p=float((np.sum(nc >= Tst[0]) + 1) / (len(nc) + 1)) if len(nc) else 1.0))
    if has_long:
        o["always_long"] = float(lng.mean()); o["delta_vs_long"] = ci(2)
        o["p_delta_long"] = float((np.sum(bt[:, 2] <= 0) + 1) / (len(bt) + 1))
    return o


def run():
    check_reg()
    t0 = time.time()
    rng = np.random.default_rng(1515)
    E = {}
    for inst in INSTS:
        z = pd.read_pickle(os.path.join(OUT, f"ev_{TAG(inst)}.pkl"))
        for k, v in z["res"].items():
            E.setdefault(k, []).append(v)
    E = {k: pd.concat(v, ignore_index=True) for k, v in E.items()}
    last = int(max(v.day.max() for v in E.values()))
    W = wins(last)
    res = dict(code=CODE, note="development evidence; 2023+ is a development window, not a holdout; nothing qualified", variants={})
    for var in VARIANTS:
        D = E[var]
        T = trade_table(var, D)
        o = {}
        for w, (lo, hi) in W.items():
            main = w in ("dev", "w2023")
            pooled = stats(T, lo, hi, NBOOT if main else 300, rng, null_clock(var, D, lo, hi))
            if pooled is None:
                continue
            per = {}
            for inst in sorted(T.inst.unique()):
                Ti = T[T.inst == inst]; Di = D[D.inst == inst]
                s = stats(Ti, lo, hi, 300, rng, null_clock(var, Di, lo, hi)) if main else None
                if s:
                    per[inst] = {k: s[k] for k in ("trades", "trades_per_year", "net_per_trade", "hit", "gross_per_trade", "mde", "side", "clock")
                                 } | ({"always_long": s["always_long"], "delta_vs_long": s["delta_vs_long"]} if "always_long" in s else {})
            pooled["per_instrument"] = per
            o[w] = pooled
            de.log_trial({"exp": EXP, "variant": var, "window": w, "net_per_trade": pooled["net_per_trade"][0], "trades": pooled["trades"],
                          "mode": "dev" if w == "dev" else "devwindow", "orb15_sha256": CODE["orb15.py"]})
            print(var, w, pooled["trades"], [round(x, 3) for x in pooled["net_per_trade"]], "clock", pooled["clock"]["mean"], flush=True)
        res["variants"][var] = o
    V = res["variants"]
    for w in ("dev", "w2023"):
        for key, get in (("p_le0", lambda o: o["p_le0"]), ("p_side", lambda o: o["side"]["p"]), ("p_clock", lambda o: o["clock"]["p"]),
                         ("p_long", lambda o: o.get("p_delta_long", np.nan))):
            vs = [v for v in VARIANTS if not (key == "p_long" and not v.startswith(("mom", "eia")))]
            adj = nt12.holm([get(V[v][w]) for v in vs])
            for v, a in zip(vs, adj):
                V[v][w][f"holm_{key}"] = float(a)
    for v in VARIANTS:
        d, z = V[v]["dev"], V[v]["w2023"]
        sup = all(o["net_per_trade"][1] > 0 and o["holm_p_le0"] < 0.05 and o["holm_p_side"] < 0.05 and o["holm_p_clock"] < 0.05
                  and (o.get("holm_p_long", 0) < 0.05) for o in (d, z))
        rej = all(o["net_per_trade"][2] < 0 for o in (d, z))
        V[v]["disposition"] = "SUPPORTED (development only)" if sup else ("REJECTED" if rej else "INCONCLUSIVE")
    res["secs"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    print("done", res["secs"], {v: V[v]["disposition"] for v in VARIANTS}, flush=True)


def register(amend=None):
    f = os.path.join(HERE, "prereg.json")
    if amend:
        reg = json.load(open(f))
        reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=amend, code_sha256=CODE))
        json.dump(reg, open(f, "w"), indent=1); print("amended"); return
    assert not os.path.exists(f), "prereg.json exists (use amend)"
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="orb15: opening-range breakout, failed-breakout fade, first-hour -> last-hour momentum, EIA Wednesday conditional momentum; queue v2 item 15, issue 310",
        before_registration="Nothing computed on market data before this file (synthetic self-checks only). Prior knowledge: notrade12, limit13, daytype14 "
                            "(trend-follow and fades after 2/4 h lose -0.11 to -0.22 R; costs 0.11-0.13 R/trade), literature (Gao et al. 2018, "
                            "Baltussen et al. 2021, Wen et al. 2023).",
        declared="Development evidence only. No test ledger, nothing qualified. 2023+ is a development window, not a holdout. "
                 "Binding confirmation for any survivor is prospective (issue 313) or post-2026-10-07 data.",
        evaluator=dict(version="v2", digest=de.CODE_SHA, note="fills.resolve via dt14.range_sim, validate.day_boot imported unchanged"),
        data="engine/cache M1 bid/ask via nt12.load_m1c (cut 2026-10-07T18:30 UTC); M5 bid/ask/mid by bars.resample; ATR(M5) from de_v2.supertrend",
        instruments=INSTS,
        clock=dict(main_open={k: f"{v[1]:02d}:{v[2]:02d} {v[0]}" for k, v in MAIN_OPEN.items()},
                   main_close={k: f"{v[1]:02d}:{v[2]:02d} {v[0]}" for k, v in MAIN_CLOSE.items()},
                   note="DST-aware per calendar date (zoneinfo). Session valid iff Mon-Fri, the M5 bars at the main open and the main close exist, and >= 80% of the M5 bars in [open, close) exist."),
        variants=dict(
            orb15="Opening range = mid high/low of the first 15 min (3 M5 bars, contiguous) after the main open. Signal = first M5 bar whose mid close is above the range high (long) "
                  "or below the range low (short), closing >= 60 min before the main close. Entry at the open of the next bar (long ask, short bid). Stop = the other side of the range "
                  "(declared; 1R alternative not tested). No target. Exit at the open of the main-close bar (session end). R = |signal mid close - stop| for the spread rule; "
                  "net R = (exit - entry) / (entry - stop) in long semantics (dt14.range_sim, stop first). One trade per instrument-day.",
            orb30="as orb15 with a 30-min range (6 bars)",
            fade15="Failed-breakout fade on the 15-min range: after the first breakout bar (as orb15), the first later bar whose mid close is back inside the range "
                   "(before the 60-min deadline) -> enter the opposite side at the next bar open. Stop = breakout extreme (mid high/low from the breakout bar to the signal bar) "
                   "+/- 0.25 ATR(M5) at the signal bar. Target = the other side of the range. Exit at the main close otherwise.",
            fade30="as fade15 with the 30-min range",
            mom30="Sign of the mid return from the main open to open + 30 min (open of bar at open+30 vs open of the first bar) -> position for the last hour "
                  "[main close - 60 min, main close): entry at the open of the bar at close - 60 (long ask, short bid), exit at the open of the main-close bar (long bid, short ask). "
                  "No stop. Equal cash risk unit R = 1.5 ATR(M5) of the bar before entry (labels_v2 POLICY k). Zero predictor return -> no trade.",
            mom60="as mom30 with the open -> open + 60 min predictor",
            eia="WTI only. Predictor = sign of the mid return over [EIA crude release, release + 30 min) (Wed 10:30 ET; Thu 11:00 ET when a US federal holiday falls Mon-Wed, nt12.eia_crude). "
                "Trade 14:00-14:30 ET on the release date (before the 14:30 NYMEX settle), fills and R as mom30."),
        common=f"Bid/ask fills. Spread rule: ask_c - bid_c at the signal bar (ORB/fade) or the bar before entry (mom/eia) <= {SPR_R} R. Equal cash risk; results in R. "
               "No thin-hour filter (all opens and closes lie outside nt12 thin hours).",
        nulls=dict(
            random_side="per trade, the actual outcome or the mirror outcome (same entry bar; opposite side; stop/target reflected through the signal-bar mid close for orb/fade; "
                        "opposite position for mom/eia) by a fair coin, 1000 draws; p = share of draws with mean R/trade >= actual",
            random_clock="orb/fade/mom: the same rules with the main open replaced by a random start time per session (5-min grid, offset in [-120, +180] min from the main open, "
                         "|offset| >= 30 min, start hour not a thin hour, start + range/predictor + 60 min <= main close), same exit at the main close, 200 draws per session; "
                         "eia: the same clock rule (10:30-11:00 ET -> 14:00-14:30 ET) on Mon/Tue/Thu/Fri non-release days, random subsets of the same size as the release set (1000 draws). "
                         "p = share of draws with mean R/trade >= actual",
            drift="mom/eia: always long in the same holding window on the same days (unconditional drift); paired delta (bootstrap)"),
        windows=dict(dev="2018-01-01 .. 2022-12-31", w2023="2023-01-01 .. 2026-10-07 (development window)", crisis="abs11 windows 2020H1, 2022H1, 2025Q4-26Q1 (stress tests, reported only)"),
        metrics="pooled over instruments and per instrument: trades, trades/year, net R/trade [95% CI], hit rate [CI], net R per session-day with a trade, gross (mid) R and cost, "
                "moving-block day bootstrap (block 5; 1000 reps pooled, 300 per instrument / crisis), random-side and random-clock null percentiles, drift delta (mom/eia), "
                "MDE = 2.8 x bootstrap SE",
        decision_rule="A variant is SUPPORTED (development evidence only, eligible to propose a shadow registration under issue 313) iff in BOTH dev 2018-2022 and 2023+ (pooled): "
                      "net R/trade 95% CI lower bound > 0; Holm-adjusted (7 variants) one-sided p (R/trade <= 0) < 0.05; Holm-adjusted p vs random side < 0.05; "
                      "Holm-adjusted p vs random clock < 0.05; and for mom/eia Holm-adjusted (3 variants) p (delta vs always-long <= 0) < 0.05. "
                      "REJECTED iff the net R/trade CI upper bound < 0 in both windows. Otherwise INCONCLUSIVE (with MDE). Per-instrument results are descriptive only.",
        budget=dict(policy_candidates=len(VARIANTS), variants=VARIANTS, tuned_hyperparameters=0,
                    fixed_constants=dict(DEADLINE=DEADLINE, STOP_BUF=STOP_BUF, LAST=LAST, SPR_R=SPR_R, RC=[RC_LO, RC_HI, RC_EXCL, NRC], MIN_COVER=MIN_COVER)),
        code_sha256=CODE)
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
        build(sys.argv[2])
    elif MODE == "run":
        run()
