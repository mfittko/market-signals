"""season17 (queue v2 item 17): directional intraday return seasonality (hour-of-day, day-of-week, named calendar effects)
after costs. Selection on 2018-2020, validation 2021-2022, frozen survivors reported on 2023+ (development window).
Evaluator v2 helpers (validate.day_boot / year_start_day / day_of, de_v2.log_trial, labels_v2.POLICY) and nt12 / abs11 helpers are
imported, never edited. Development evidence only; nothing is qualified; no test ledger.

  python season17.py check       synthetic self-checks
  python season17.py register    prereg.json (refuses to overwrite)
  python season17.py amend "why" append an amendment with new code hashes
  python season17.py build INST  per-candidate trades (net long / net short / gross / financing) -> out/tr_<TAG>.pkl
  python season17.py run         selection, validation, nulls, statistics -> out/results.json
"""
import os, sys, json, time, hashlib, calendar
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
for p in (ENG, os.path.join(ENG, "audit", "notrade12"), os.path.join(ENG, "audit", "abs11"), os.path.join(ENG, "audit", "xvol9"),
          os.path.join(ENG, "audit", "limit13")):
    sys.path.insert(0, p)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import de_v2 as de  # noqa: E402
from labels_v2 import POLICY  # noqa: E402
from validate import day_boot, year_start_day, day_of  # noqa: E402
import nt12  # noqa: E402
import abs11  # noqa: E402

EXP = "season17"
INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "NATGAS/USD", "SPX500/USD", "EUR/USD", "USD/JPY", "NAS100/USD", "BTC/USD"]
TAG = lambda inst: inst.replace("/", "_")
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"season17.py": sha(os.path.join(HERE, "season17.py")), "nt12.py": nt12.CODE["nt12.py"], "abs11.py": abs11.CODE["abs11.py"],
        "evaluator": de.CODE_SHA}
LOCAL_TZ = {i: "America/New_York" for i in INSTS} | {"EUR/USD": "Europe/London"}
ET = "America/New_York"
K = 3                  # selected windows per instrument
CORR_MAX = 0.5         # greedy de-duplication: skip a candidate whose per-day gross series correlates |r| > 0.5 with a selected one
MIN_N = 100            # minimum trades in the selection period for a candidate to be eligible
SPR_R = nt12.SPR_R     # 0.2
FIN_BASE, FIN_SENS = 0.03, (0.0, 0.03, 0.06)   # mw6 financing, annualized share of notional, long and short, per 17:00 ET roll (Fri x3)
NBOOT, NBOOT_SMALL, NSIDE, NSEL = 1000, 300, 1000, 1000
SEL = ("2018-01-01", "2021-01-01"); VAL = ("2021-01-01", "2023-01-01"); DEV = ("2018-01-01", "2023-01-01"); W23 = ("2023-01-01", "2100-01-01")
CRISES = abs11.CRISES
GOTOBI = (5, 10, 15, 20, 25)


# ------------------------------------------------------------------ pure helpers
def umin(d, tz, hh, mm):
    return int(datetime(d.year, d.month, d.day, hh, mm, tzinfo=ZoneInfo(tz)).timestamp() // 60)


def find_bars(t, start, end, tol_in, tol_out):
    """Entry bar e = first M5 bar with start <= t < start + tol_in (and < end); exit bar x = last bar with t < end and t >= end - tol_out.
    Entry at the open of e, exit at the close of x. Returns (e, x), -1 where invalid."""
    start = np.asarray(start, np.int64); end = np.asarray(end, np.int64); n = len(t)
    e = np.searchsorted(t, start); ec = np.clip(e, 0, n - 1)
    x = np.searchsorted(t, end) - 1; xc = np.clip(x, 0, n - 1)
    ok = (e < n) & (t[ec] < start + tol_in) & (t[ec] < end) & (x >= 0) & (t[xc] >= end - tol_out) & (x >= e) & (e >= 1)
    return np.where(ok, e, -1), np.where(ok, x, -1)


def roll_minutes(d0, d1):
    """17:00 ET financing rolls (UTC minutes) Mon-Fri between dates, weight 3 on Fridays."""
    m, w = [], []
    d = d0
    while d <= d1:
        if d.weekday() < 5:
            m.append(umin(d, ET, 17, 0)); w.append(3 if d.weekday() == 4 else 1)
        d += timedelta(days=1)
    return np.array(m, np.int64), np.cumsum(np.r_[0, w])


def nights(rm, rcum, t_in, t_out):
    """Weighted count of rolls in (t_in, t_out]."""
    return rcum[np.searchsorted(rm, t_out, side="right")] - rcum[np.searchsorted(rm, t_in, side="right")]


def gotobi_dates(d0, d1, bizdays):
    """Gotobi days: day of month in 5/10/15/20/25 or the month end, moved back to the previous business day (bizdays: set of dates)."""
    out = set(); y, m = d0.year, d0.month
    while date(y, m, 1) <= d1:
        for dd in GOTOBI + (calendar.monthrange(y, m)[1],):
            d = date(y, m, dd)
            while d not in bizdays and d >= date(y, m, 1):
                d -= timedelta(days=1)
            if d in bizdays:
                out.add(d)
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def tom_pairs(bizdays):
    """Turn-of-month: (entry date = 2nd-to-last trading day of month, exit date = 3rd trading day of the next month)."""
    b = sorted(bizdays); out = []
    for i in range(1, len(b) - 3):
        if b[i].month != b[i + 1].month:          # b[i] last trading day
            out.append((b[i - 1], b[i + 3]))
    return out


def greedy(order, tstat_ok, corr):
    """First K candidates in `order` with tstat_ok, skipping any with |corr| > CORR_MAX to an already chosen one."""
    ch = []
    for c in order:
        if not tstat_ok[c]:
            continue
        if all(not (abs(corr[c, s]) > CORR_MAX) for s in ch):
            ch.append(c)
        if len(ch) == K:
            break
    return ch


def check():
    t = np.array([0, 5, 10, 15, 20, 30, 35, 40], np.int64)
    e, x = find_bars(t, [5, 0, 22, 100], [20, 40, 40, 160], 10, 15)
    assert list(e) == [1, -1, 5, -1] and list(x) == [3, -1, 6, -1], (e, x)   # 2nd: e=0 invalid (no prior bar for R)
    rm, rc = roll_minutes(date(2024, 3, 7), date(2024, 3, 12))   # Thu, Fri, Mon, Tue
    assert len(rm) == 4 and list(rc) == [0, 1, 4, 5, 6]
    assert nights(rm, rc, rm[0] - 1, rm[0]) == 1 and nights(rm, rc, rm[0], rm[2]) == 4 and nights(rm, rc, rm[0] + 1, rm[1] - 1) == 0
    assert umin(date(2024, 7, 1), ET, 17, 0) % 1440 == 21 * 60 and umin(date(2024, 1, 2), ET, 17, 0) % 1440 == 22 * 60   # DST
    biz = {date(2024, 8, 1) + timedelta(days=i) for i in range(62) if (date(2024, 8, 1) + timedelta(days=i)).weekday() < 5}
    g = gotobi_dates(date(2024, 8, 1), date(2024, 9, 30), biz)
    assert date(2024, 8, 9) in g and date(2024, 8, 30) in g and date(2024, 8, 10) not in g and date(2024, 9, 25) in g   # Sat 10th -> Fri 9th
    tp = tom_pairs(biz)
    assert tp[0] == (date(2024, 8, 29), date(2024, 9, 4)), tp
    corr = np.array([[1, .9, .1, 0], [.9, 1, 0, 0], [.1, 0, 1, .2], [0, 0, .2, 1]])
    assert greedy([0, 1, 2, 3], np.ones(4, bool), corr) == [0, 2, 3]
    assert greedy([1, 0, 3, 2], np.array([True, True, False, True]), corr) == [1, 3]
    # fills: long buys ask at open, sells bid at close; short mirror
    B = dict(ask_o=np.array([10.1, 10.1]), bid_o=np.array([10.0, 10.0]), ask_c=np.array([10.6, 10.6]), bid_c=np.array([10.5, 10.5]),
             mid_o=np.array([10.05, 10.05]), mid_c=np.array([10.55, 10.55]))
    nl, ns, gl = fills(B, np.array([1]), np.array([1]), np.array([0.5]))
    assert abs(nl[0] - 0.8) < 1e-12 and abs(ns[0] + 1.2) < 1e-12 and abs(gl[0] - 1.0) < 1e-12
    print("season17 self-check OK: bar finder with tolerances, 17:00 ET rolls (DST, Fri x3), gotobi shift, turn-of-month dates, greedy de-dup, bid/ask fills")


def fills(B, e, x, R):
    nl = (B["bid_c"][x] - B["ask_o"][e]) / R
    ns = (B["bid_o"][e] - B["ask_c"][x]) / R
    gl = (B["mid_c"][x] - B["mid_o"][e]) / R
    return nl, ns, gl


# ------------------------------------------------------------------ candidates and named effects
def candidates(inst, days):
    """Scan candidates: U0..U23 (UTC hour, UTC weekday Mon-Fri), L0..L23 (local-clock hour, local weekday Mon-Fri),
    D0..D4 (trading day Mon..Fri = [17:00 ET previous calendar day, 17:00 ET), no financing roll inside)."""
    wk = [d for d in days if d.weekday() < 5]
    C = {}
    for h in range(24):
        s = np.array([umin(d, "UTC", h, 0) for d in wk]); C[f"U{h:02d}"] = (wk, s, s + 60, 10, 15)
    tz = LOCAL_TZ[inst]
    for h in range(24):
        s = np.array([umin(d, tz, h, 0) for d in wk]); e = np.array([umin(d + timedelta(days=h == 23), tz, (h + 1) % 24, 0) for d in wk])
        C[f"L{h:02d}"] = (wk, s, e, 10, 15)
    for wd in range(5):
        dd = [d for d in wk if d.weekday() == wd]
        C[f"D{wd}"] = (dd, np.array([umin(d - timedelta(days=1), ET, 17, 0) for d in dd]), np.array([umin(d, ET, 17, 0) for d in dd]), 90, 90)
    return C


NAMED = {
    "N01_XAU_asia_long": ("XAU/USD", 1, "XAU long 19:00 ET (previous evening) -> 03:00 ET, Mon-Fri sessions (gold Asian-session drift)"),
    "N02_XAU_ny_short": ("XAU/USD", -1, "XAU short 08:20 -> 13:30 ET (COMEX day session), Mon-Fri (gold New York-session decline)"),
    "N03_SPX_overnight_long": ("SPX500/USD", 1, "SPX500 long 16:00 ET -> 09:30 ET next weekday (overnight drift), financing charged"),
    "N04_NAS_overnight_long": ("NAS100/USD", 1, "NAS100 long 16:00 ET -> 09:30 ET next weekday, financing charged"),
    "N05_SPX_intraday_long": ("SPX500/USD", 1, "SPX500 long 09:30 -> 16:00 ET, Mon-Fri (intraday half of the split)"),
    "N06_NAS_intraday_long": ("NAS100/USD", 1, "NAS100 long 09:30 -> 16:00 ET, Mon-Fri"),
    "N07_SPX_monday_short": ("SPX500/USD", -1, "SPX500 short Monday 09:30 -> 16:00 ET (Monday effect)"),
    "N08_SPX_friday_long": ("SPX500/USD", 1, "SPX500 long Friday 09:30 -> 16:00 ET (Friday effect)"),
    "N09_SPX_tom_long": ("SPX500/USD", 1, "SPX500 long 16:00 ET on the 2nd-to-last trading day -> 16:00 ET on the 3rd trading day of the next month (days -1..+3), financing charged"),
    "N10_NAS_tom_long": ("NAS100/USD", 1, "NAS100 turn-of-month long as N09"),
    "N11_JPY_gotobi_long": ("USD/JPY", 1, "USD/JPY long 09:00 -> 09:55 JST (00:00 -> 00:55 UTC) on gotobi days (5/10/15/20/25/month end, moved to the previous business day)"),
    "N12_NAS_monday_short": ("NAS100/USD", -1, "NAS100 short Monday 09:30 -> 16:00 ET"),
    "N13_NAS_friday_long": ("NAS100/USD", 1, "NAS100 long Friday 09:30 -> 16:00 ET"),
}
# always-long comparator per named effect (unpaired, same instrument, same evaluation window): the D all-weekday long, the regular
# session long on all weekdays, or the same clock on non-gotobi weekdays
NAMED_CMP = {"N01_XAU_asia_long": "Dall", "N02_XAU_ny_short": "Dall", "N03_SPX_overnight_long": "Dall", "N04_NAS_overnight_long": "Dall",
             "N05_SPX_intraday_long": "Dall", "N06_NAS_intraday_long": "Dall", "N07_SPX_monday_short": "N05_SPX_intraday_long",
             "N08_SPX_friday_long": "N05_SPX_intraday_long", "N09_SPX_tom_long": "Dall", "N10_NAS_tom_long": "Dall",
             "N11_JPY_gotobi_long": "X11_JPY_nongotobi", "N12_NAS_monday_short": "N06_NAS_intraday_long", "N13_NAS_friday_long": "N06_NAS_intraday_long"}


def named_windows(inst, days, bizdays):
    W = {}
    wk = [d for d in days if d.weekday() < 5]
    nxt = {d: n for d, n in zip(sorted(bizdays), sorted(bizdays)[1:])}
    for nm, (ins, side, _) in NAMED.items():
        if ins != inst:
            continue
        if "asia" in nm:
            W[nm] = (wk, [umin(d - timedelta(days=1), ET, 19, 0) for d in wk], [umin(d, ET, 3, 0) for d in wk], 15, 15)
        elif "ny_short" in nm:
            W[nm] = (wk, [umin(d, ET, 8, 20) for d in wk], [umin(d, ET, 13, 30) for d in wk], 15, 15)
        elif "overnight" in nm:
            dd = [d for d in wk if d in nxt]
            W[nm] = (dd, [umin(d, ET, 16, 0) for d in dd], [umin(nxt[d], ET, 9, 30) for d in dd], 30, 30)
        elif "intraday" in nm or "monday" in nm or "friday" in nm:
            dd = [d for d in wk if ("monday" not in nm or d.weekday() == 0) and ("friday" not in nm or d.weekday() == 4)]
            W[nm] = (dd, [umin(d, ET, 9, 30) for d in dd], [umin(d, ET, 16, 0) for d in dd], 15, 15)
        elif "tom" in nm:
            P = tom_pairs(bizdays)
            W[nm] = ([a for a, _ in P], [umin(a, ET, 16, 0) for a, _ in P], [umin(b, ET, 16, 0) for _, b in P], 30, 30)
        elif "gotobi" in nm:
            g = gotobi_dates(days[0], days[-1], bizdays)
            W[nm] = (sorted(g), [umin(d, "UTC", 0, 0) for d in sorted(g)], [umin(d, "UTC", 0, 55) for d in sorted(g)], 10, 10)
            ng = [d for d in wk if d not in g]
            W["X11_JPY_nongotobi"] = (ng, [umin(d, "UTC", 0, 0) for d in ng], [umin(d, "UTC", 0, 55) for d in ng], 10, 10)
    return W


# ------------------------------------------------------------------ build
def check_reg():
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    cur = reg["amendments"][-1]["code_sha256"] if reg.get("amendments") else reg["code_sha256"]
    assert cur["season17.py"] == CODE["season17.py"], "season17.py changed after registration (amend first)"


def trades(B, name, spec, rm, rcum):
    """Amendment 1: 1R = 1.5 ATR(M5) of the bar before entry x sqrt(window length / 5 min) (equal risk per expected window range);
    spread rule on the entry bar's own open quotes; a roll at the exact exit time (close of the last bar) is not held."""
    dd, s, e_, ti, to = spec
    e, x = find_bars(B["t"], s, e_, ti, to)
    ok = e >= 0
    e, x, L = e[ok], x[ok], (np.asarray(e_, np.int64) - np.asarray(s, np.int64))[ok]
    R = POLICY["k"] * B["atr"][e - 1] * np.sqrt(L / 5.0)
    good = np.isfinite(R) & (R > 0)
    e, x, R = e[good], x[good], R[good]
    nl, ns, gl = fills(B, e, x, R)
    nt = nights(rm, rcum, B["t"][e], B["t"][x] + 4)
    return pd.DataFrame({"cand": name, "day": day_of(B["t"][e]), "e": e, "x": x, "nl": nl, "ns": ns, "gl": gl,
                         "spr": (B["ask_o"][e] - B["bid_o"][e]) / R, "fin_u": B["mid_o"][e] * nt / 365.0 / R, "nights": nt})


def build(inst):
    check_reg()
    t0 = time.time()
    m1, src = nt12.load_m1c(inst)
    B = nt12.frame(inst, m1, "M5", nt12.h1(inst, m1))
    t = B["t"]
    d0 = datetime.utcfromtimestamp(int(t[0]) * 60).date() + timedelta(days=1); d1 = datetime.utcfromtimestamp(int(t[-1]) * 60).date() - timedelta(days=1)
    days = [d0 + timedelta(days=i) for i in range((d1 - d0).days + 1)]
    # business day: a Mon-Fri date with M5 bars at >= 50% of the 09:00-16:00 ET grid (instrument's own calendar)
    biz = set()
    for d in days:
        if d.weekday() < 5:
            a, b = umin(d, ET, 9, 0), umin(d, ET, 16, 0)
            if np.searchsorted(t, b) - np.searchsorted(t, a) >= 0.5 * (b - a) / 5:
                biz.add(d)
    rm, rcum = roll_minutes(d0 - timedelta(days=7), d1 + timedelta(days=7))
    C = candidates(inst, days) | named_windows(inst, days, biz)
    T = pd.concat([trades(B, nm, spec, rm, rcum) for nm, spec in C.items()], ignore_index=True)
    T["inst"] = inst
    T.to_pickle(os.path.join(OUT, f"tr_{TAG(inst)}.pkl"))
    print(json.dumps(dict(inst=inst, m1=src, rows=len(T), cands=len(C), bizdays=len(biz), secs=round(time.time() - t0))), flush=True)


# ------------------------------------------------------------------ run
def dk(s):
    return year_start_day(int(s[:4])) if s.endswith("-01-01") else int(day_of(np.datetime64(s, "m").astype(np.int64)))


def span(a, b):
    return dk(a), dk(b)


def side_net(X, side, rate=FIN_BASE, spread_mult=1.0):
    net = np.where(side > 0, X.nl, X.ns) - rate * X.fin_u
    if spread_mult != 1.0:
        g = side * X.gl
        net = g - spread_mult * (g - np.where(side > 0, X.nl, X.ns)) - rate * X.fin_u
    return net.to_numpy() if hasattr(net, "to_numpy") else net


def stats(X, side, lo, hi, nboot, rng, cmp=None, seed=17):
    """X: trades of one or more windows (columns side or scalar side). cmp: comparator long-net rows (day, net) or None."""
    m = ((X.day >= lo) & (X.day < hi)).to_numpy()
    X = X[m].reset_index(drop=True)
    sd = X.side.to_numpy() if "side" in X else np.full(len(X), side)
    if len(X) < 20:
        return None
    net = side_net(X, sd); mir = side_net(X, -sd); day = X.day.to_numpy(); gross = sd * X.gl.to_numpy()
    if cmp is not None:
        c = cmp[(cmp.day >= lo) & (cmp.day < hi)]
        vals = np.r_[net, c.net.to_numpy()]; grp = np.r_[np.zeros(len(net), bool), np.ones(len(c), bool)]; dd = np.r_[day, c.day.to_numpy()]
    else:
        vals, grp, dd = net, np.zeros(len(net), bool), day

    def stat(ix):
        v, g = vals[ix], grp[ix]
        a = v[~g]
        return np.array([a.mean() if len(a) else np.nan, (a > 0).mean() if len(a) else np.nan,
                         (a.mean() - v[g].mean()) if g.any() and (~g).any() else np.nan])
    T0 = stat(np.arange(len(vals)))
    bt = day_boot(dd, np.arange(dd.min(), dd.max() + 1), stat, nboot, seed=seed)
    ci = lambda j: [float(T0[j]), float(np.nanpercentile(bt[:, j], 2.5)), float(np.nanpercentile(bt[:, j], 97.5))]
    flips = rng.random((NSIDE, len(net))) < 0.5
    rs = np.where(flips, mir[None, :], net[None, :]).mean(1)
    o = dict(trades=int(len(X)), trades_per_year=float(len(X) / ((min(hi, int(X.day.max()) + 1) - lo) / 365.25)), net_per_trade=ci(0), hit=ci(1),
             gross_per_trade=float(gross.mean()), spread_cost=float((gross - (net + FIN_BASE * X.fin_u.to_numpy())).mean()),
             fin_cost=float(FIN_BASE * X.fin_u.mean()),
             net_fin0=float(side_net(X, sd, 0.0).mean()), net_fin6=float(side_net(X, sd, 0.06).mean()), net_spread15=float(side_net(X, sd, FIN_BASE, 1.5).mean()),
             se=float(np.nanstd(bt[:, 0])), mde=float(2.8 * np.nanstd(bt[:, 0])), p_le0=float((np.sum(bt[:, 0] <= 0) + 1) / (len(bt) + 1)),
             side=dict(mean=float(rs.mean()), p=float((np.sum(rs >= T0[0]) + 1) / (NSIDE + 1))))
    if cmp is not None:
        o["cmp_long"] = float(vals[grp].mean()); o["delta_vs_long"] = ci(2); o["p_cmp"] = float((np.sum(bt[:, 2] <= 0) + 1) / (len(bt) + 1))
    return o


def per_year(X, side, rng, nboot=NBOOT_SMALL):
    out = {}
    for y in range(2018, 2027):
        s = stats(X, side, year_start_day(y), year_start_day(y + 1), nboot, rng)
        if s:
            out[y] = dict(trades=s["trades"], net_per_trade=s["net_per_trade"])
    return out


def run():
    check_reg()
    t0 = time.time()
    rng = np.random.default_rng(1717)
    T = pd.concat([pd.read_pickle(os.path.join(OUT, f"tr_{TAG(i)}.pkl")) for i in INSTS], ignore_index=True)
    T = T[T.spr <= SPR_R].reset_index(drop=True)          # spread rule at the bar before entry (declared; applied before selection)
    sl, sh = span(*SEL); vl, vh = span(*VAL); dl, dh = span(*DEV); wl, wh = span(*W23)
    res = dict(code=CODE, note="development evidence; 2023+ is a development window, not a holdout; nothing qualified")

    # ---- scan and selection (2018-2020 only)
    scan = []
    for inst in INSTS:
        Ti = T[(T.inst == inst) & T.cand.str.match(r"^[ULD]\d")]
        S = Ti[(Ti.day >= sl) & (Ti.day < sh)]
        g = S.groupby("cand").gl
        st = pd.DataFrame({"n": g.size(), "mean": g.mean(), "sd": g.std()})
        st["t"] = st["mean"] / st["sd"] * np.sqrt(st["n"])
        st["elig"] = st.n >= MIN_N
        piv = S.pivot_table(index="day", columns="cand", values="gl")
        st = st.loc[[c for c in st.index if c in piv.columns]]
        corr = piv[st.index].corr(min_periods=MIN_N).fillna(0).to_numpy()
        V = Ti[(Ti.day >= vl) & (Ti.day < vh)]; W = Ti[(Ti.day >= wl) & (Ti.day < wh)]
        for k, c in enumerate(st.index):
            sd = 1 if st.loc[c, "mean"] > 0 else -1
            v = V[V.cand == c]; w = W[W.cand == c]
            vnet = side_net(v, sd); wnet = side_net(w, sd)
            scan.append(dict(inst=inst, cand=c, k=k, n_sel=int(st.loc[c, "n"]), mean_sel=float(st.loc[c, "mean"]), t_sel=float(st.loc[c, "t"]),
                             elig=bool(st.loc[c, "elig"]), side=sd, n_val=len(v), gross_val=float((sd * v.gl).mean()) if len(v) else np.nan,
                             net_val=float(vnet.mean()) if len(v) else np.nan, n_23=len(w), net_23=float(wnet.mean()) if len(w) else np.nan,
                             sum_val=float(vnet.sum()), sum_23=float(wnet.sum())))
            de.log_trial({"exp": EXP, "stage": "scan", "inst": inst, "cand": c, "t_sel": float(st.loc[c, "t"]), "mode": "dev",
                          "season17_sha256": CODE["season17.py"]})
        res.setdefault("_corr", {})[inst] = (list(st.index), corr)
    SC = pd.DataFrame(scan)
    SC["val_pass"] = (SC.gross_val > 0) & (SC.net_val > 0) & (SC.n_val >= 20)
    corr_by = res.pop("_corr")
    sel = []
    for inst in INSTS:
        names, corr = corr_by[inst]
        s = SC[SC.inst == inst].set_index("cand").loc[names]
        order = list(np.argsort(-np.abs(s.t_sel.to_numpy()), kind="stable"))
        ch = greedy(order, s.elig.to_numpy(), corr)
        sel += [(inst, names[c]) for c in ch]
    SC["selected"] = [(r.inst, r.cand) in sel for r in SC.itertuples()]
    n_scan = int(SC.elig.sum())
    res["scan"] = dict(candidates_scanned=n_scan, per_instrument={i: int(SC[(SC.inst == i)].elig.sum()) for i in INSTS},
                       abs_t_gt2=int((SC.elig & (SC.t_sel.abs() > 2)).sum()), expected_abs_t_gt2_under_null=float(0.0455 * n_scan),
                       abs_t_gt3=int((SC.elig & (SC.t_sel.abs() > 3)).sum()),
                       sign_kept_in_val_all=float((SC[SC.elig].gross_val > 0).mean()),
                       sign_kept_in_val_abs_t_gt2=float((SC[SC.elig & (SC.t_sel.abs() > 2)].gross_val > 0).mean()),
                       val_pass_rate_all=float(SC[SC.elig].val_pass.mean()))
    SC.to_csv(os.path.join(OUT, "scan.csv"), index=False)

    # ---- selection-adjusted null: random order instead of |t| order, same de-dup, side, validation filter (1000 draws)
    def proc(chosen):
        X = SC.set_index(["inst", "cand"]).loc[chosen]
        surv = X[X.val_pass]
        val_all = X.sum_val.sum() / max(X.n_val.sum(), 1)
        w23 = surv.sum_23.sum() / surv.n_23.sum() if len(surv) and surv.n_23.sum() else np.nan
        return val_all, w23, len(surv)
    act = proc(sel)
    null = []
    for _ in range(NSEL):
        ch = []
        for inst in INSTS:
            names, corr = corr_by[inst]
            s = SC[SC.inst == inst].set_index("cand").loc[names]
            ch += [(inst, names[c]) for c in greedy(list(rng.permutation(len(names))), s.elig.to_numpy(), corr)]
        null.append(proc(ch))
    null = np.array(null, float)
    res["procedure"] = dict(selected=len(sel), survivors=act[2], val_net_all_selected=act[0], w23_net_survivors=act[1],
                            null_val_mean=float(np.nanmean(null[:, 0])), null_val_q=[float(np.nanquantile(null[:, 0], q)) for q in (0.025, 0.975)],
                            p_val=float((np.sum(null[:, 0] >= act[0]) + 1) / (NSEL + 1)),
                            null_w23_mean=float(np.nanmean(null[:, 1])), null_w23_q=[float(np.nanquantile(null[:, 1], q)) for q in (0.025, 0.975)],
                            p_w23=float((np.nansum(null[:, 1] >= act[1]) + 1) / (np.isfinite(null[:, 1]).sum() + 1)) if np.isfinite(act[1]) else None,
                            null_survivors_mean=float(null[:, 2].mean()))

    # per-window selection null: 2023+ net/trade of eligible candidates that pass the same validation filter (all instruments)
    pool23 = SC[SC.elig & SC.val_pass & (SC.n_23 >= 20)].net_23.to_numpy()

    def comparator(inst, cand):
        Ti = T[T.inst == inst]
        if cand[0] in "UL":
            c = Ti[Ti.cand.str.startswith(cand[0]) & Ti.cand.str.match(r"^[UL]\d")]
            c = c.assign(net=c.nl).groupby("day", as_index=False).net.mean()
        elif cand[0] == "D" or NAMED_CMP.get(cand) == "Dall":
            c = Ti[Ti.cand.str.match(r"^D\d")].assign(net=lambda z: z.nl - FIN_BASE * z.fin_u)[["day", "net"]]
        else:
            c = Ti[Ti.cand == NAMED_CMP[cand]].assign(net=lambda z: z.nl - FIN_BASE * z.fin_u)[["day", "net"]]
        return c.reset_index(drop=True)

    WIN = {"val2021_22": (vl, vh), "w2023": (wl, wh)} | {c: span(a, b) for c, (a, b) in CRISES.items()}
    out = {}
    for inst, cand in sel:
        r = SC[(SC.inst == inst) & (SC.cand == cand)].iloc[0]
        X = T[(T.inst == inst) & (T.cand == cand)]
        cmp = comparator(inst, cand)
        o = dict(inst=inst, cand=cand, side=int(r.side), t_sel=float(r.t_sel), n_sel=int(r.n_sel), gross_sel=float(r.side * r.mean_sel),
                 val_pass=bool(r.val_pass), gross_val=float(r.gross_val), net_val=float(r.net_val))
        for w, (lo, hi) in WIN.items():
            s = stats(X, r.side, lo, hi, NBOOT_SMALL, rng, cmp)
            if s:
                if w == "w2023":
                    s["p_sel"] = float((np.sum(pool23 >= s["net_per_trade"][0]) + 1) / (len(pool23) + 1))
                o[w] = s
        o["per_year"] = per_year(X, r.side, rng)
        out[f"{TAG(inst)}:{cand}"] = o
        de.log_trial({"exp": EXP, "stage": "selected", "inst": inst, "cand": cand, "val_pass": bool(r.val_pass),
                      "net_w2023": o.get("w2023", {}).get("net_per_trade", [None])[0], "mode": "devwindow", "season17_sha256": CODE["season17.py"]})
        print(inst, cand, r.side, round(r.t_sel, 2), "val", r.val_pass, round(r.net_val, 3), "w23", o.get("w2023", {}).get("net_per_trade"), flush=True)
    keys = [k for k in out if "w2023" in out[k]]
    for key, get in (("p_le0", lambda o: o["p_le0"]), ("p_side", lambda o: o["side"]["p"]), ("p_sel", lambda o: o["p_sel"]), ("p_cmp", lambda o: o["p_cmp"])):
        adj = nt12.holm([get(out[k]["w2023"]) for k in keys] + [1.0] * (len(sel) - len(keys)))   # Holm over all selected windows
        for k, a in zip(keys, adj):
            out[k]["w2023"][f"holm_{key}"] = float(a)
    for k, o in out.items():
        if not o["val_pass"]:
            o["disposition"] = "DROPPED (failed validation 2021-22)"; continue
        z = o.get("w2023")
        if z is None:
            o["disposition"] = "INCONCLUSIVE (no 2023+ trades)"; continue
        sup = z["net_per_trade"][1] > 0 and all(z[f"holm_{p}"] < 0.05 for p in ("p_le0", "p_side", "p_sel", "p_cmp"))
        o["disposition"] = "SUPPORTED (development only)" if sup else ("REJECTED" if z["net_per_trade"][2] < 0 else "INCONCLUSIVE")
    res["selected"] = out
    # pooled frozen survivors
    surv = [(o["inst"], o["cand"], o["side"]) for o in out.values() if o["val_pass"]]
    if surv:
        P = pd.concat([T[(T.inst == i) & (T.cand == c)].assign(side=s) for i, c, s in surv], ignore_index=True)
        res["pooled_survivors"] = {w: stats(P, None, lo, hi, NBOOT, rng) for w, (lo, hi) in WIN.items()}
        res["pooled_survivors"]["per_year"] = per_year(P, None, rng)

    # ---- named effects (declared side, no selection), dev 2018-22 and 2023+
    NW = {"dev": (dl, dh), "w2023": (wl, wh)} | {c: span(a, b) for c, (a, b) in CRISES.items()}
    nm_out = {}
    for nm, (inst, side, desc) in NAMED.items():
        X = T[(T.inst == inst) & (T.cand == nm)]
        cmp = comparator(inst, nm)
        o = dict(inst=inst, side=side, desc=desc)
        for w, (lo, hi) in NW.items():
            s = stats(X, side, lo, hi, NBOOT if w in ("dev", "w2023") else NBOOT_SMALL, rng, cmp)
            if s:
                o[w] = s
        o["per_year"] = per_year(X, side, rng)
        nm_out[nm] = o
        for w in ("dev", "w2023"):
            de.log_trial({"exp": EXP, "stage": "named", "variant": nm, "window": w, "net_per_trade": o[w]["net_per_trade"][0] if w in o else None,
                          "mode": "dev" if w == "dev" else "devwindow", "season17_sha256": CODE["season17.py"]})
        print(nm, {w: o[w]["net_per_trade"] for w in ("dev", "w2023") if w in o}, flush=True)
    for w in ("dev", "w2023"):
        for key, get in (("p_le0", lambda o: o["p_le0"]), ("p_side", lambda o: o["side"]["p"]), ("p_cmp", lambda o: o["p_cmp"])):
            ks = list(NAMED)
            adj = nt12.holm([get(nm_out[k][w]) if w in nm_out[k] else 1.0 for k in ks])
            for k, a in zip(ks, adj):
                if w in nm_out[k]:
                    nm_out[k][w][f"holm_{key}"] = float(a)
    for k, o in nm_out.items():
        ws = [o.get("dev"), o.get("w2023")]
        if any(z is None for z in ws):
            o["disposition"] = "INCONCLUSIVE (missing window)"; continue
        sup = all(z["net_per_trade"][1] > 0 and all(z[f"holm_{p}"] < 0.05 for p in ("p_le0", "p_side", "p_cmp")) for z in ws)
        rej = all(z["net_per_trade"][2] < 0 for z in ws)
        o["disposition"] = "SUPPORTED (development only)" if sup else ("REJECTED" if rej else "INCONCLUSIVE")
    res["named"] = nm_out
    res["secs"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    print("done", res["secs"], json.dumps(res["procedure"], default=float), flush=True)
    print({k: o["disposition"] for k, o in out.items()}, {k: o["disposition"] for k, o in nm_out.items()}, flush=True)


def register(amend=None):
    f = os.path.join(HERE, "prereg.json")
    if amend:
        reg = json.load(open(f))
        reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=amend, code_sha256=CODE))
        json.dump(reg, open(f, "w"), indent=1); print("amended"); return
    assert not os.path.exists(f), "prereg.json exists (use amend)"
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="season17: directional intraday return seasonality (hour-of-day, day-of-week, named calendar effects) after costs; queue v2 item 17, issue 310",
        before_registration="Nothing computed on market returns before this file (coverage counts only: out/coverage.json; synthetic self-checks). "
                            "Prior knowledge: orb15 (always-long last hour negative after costs; costs 0.11-0.13 R/trade for intraday holds), "
                            "pairs16, mw6 (financing dominant for multi-day holds). Literature: overnight vs intraday split (Cliff, Cooper & Gulen 2008; "
                            "Kelly & Clark 2011), turn-of-month (Lakonishok & Smidt 1988), weekend/Monday effect (French 1980), gold Asia/NY "
                            "pattern (practitioner literature, e.g. Bloomberg 2015-2020 'gold falls in NY hours'), gotobi (Bessho, Ikeda, Kakushadze et al.).",
        declared="Development evidence only. No test ledger, nothing qualified. 2023+ is a development window (inspected for other questions before), "
                 "not a holdout. Binding confirmation for any survivor is prospective (issue 313) or post-2026-10-07 data.",
        evaluator=dict(version="v2", digest=de.CODE_SHA, note="validate.day_boot/year_start_day/day_of, de_v2.log_trial, labels_v2.POLICY imported unchanged"),
        data="engine/cache M1 bid/ask via nt12.load_m1c (cut 2026-10-07T18:30 UTC); M5 bid/ask/mid by bars.resample; ATR(M5) from de_v2.supertrend (nt12.frame)",
        instruments=INSTS,
        coverage="All 9 instruments have M1 bid/ask from 2018-01-01 to 2026-10-07 (out/coverage.json). XAG and NATGAS have ~25-45% fewer bars in 2018-2019. "
                 "BTC/USD (OANDA CFD) has only 4% weekend bars, so BTC is treated like the others: Mon-Fri windows only; weekend bars are excluded "
                 "(declared; BTC weekend seasonality not tested).",
        scan_candidates=dict(
            U="U00..U23: one UTC hour [h:00, h+1:00), Mon-Fri by UTC date",
            L="L00..L23: one local-clock hour, DST-aware (America/New_York for all instruments except EUR/USD: Europe/London), Mon-Fri by local date",
            D="D0..D4: trading day Mon..Fri = [17:00 ET of the previous calendar day, 17:00 ET), i.e. the CFD trading day between financing rolls",
            count="51 per instrument x 9 = 459 nominal; the registered scan size is the number with >= 100 selection-period trades (reported)",
            note="U and L hours coincide for half the year (ET is UTC-4/-5); de-duplication below removes near-identical picks"),
        trading_rule="Side = sign of the selection-period mean gross return. Entry at the open of the first M5 bar in [start, start + tol_in) "
                     "(long ask, short bid); exit at the close of the last M5 bar with t < end and t >= end - tol_out (long bid, short ask). "
                     "tol_in/tol_out = 10/15 min for 1-hour windows, 90/90 for D windows, 15/15 for named sessions, 30/30 for overnight and turn-of-month, "
                     "10/10 for gotobi. Equal cash risk: 1R = 1.5 ATR(M5) of the bar before entry (labels_v2 POLICY k); results in R. No stop "
                     "(time exit only). Spread rule: ask_c - bid_c of the bar before entry <= 0.2 R (applied before selection). "
                     "Financing (mw6): 3% p.a. of notional (mid at entry) on long and short per 17:00 ET roll held, Friday roll x3; sensitivity 0% and 6%. "
                     "Scan windows (U/L/D) never span a roll except a U/L hour that contains 17:00 ET.",
        selection=dict(
            period="2018-01-01 .. 2020-12-31 (trading-day key, 22:00 UTC rollover)",
            statistic="t = mean / sd * sqrt(n) of the per-trade gross mid return in R (iid t, declared), per candidate; eligible iff n >= 100",
            procedure=f"per instrument, order eligible candidates by |t| descending; greedily take the next candidate unless its per-day gross series "
                      f"(2018-2020) correlates |r| > {CORR_MAX} with an already chosen one (pairwise, >= 100 common days); stop at K = {K}",
            validation="2021-01-01 .. 2022-12-31: survivor iff gross mean (side-signed) > 0 AND net mean R/trade > 0 (point estimates), n >= 20. "
                       "Survivors are frozen (window, side). 2023+ is reported as a development window."),
        named_effects={k: v[2] for k, v in NAMED.items()},
        named_comparators=NAMED_CMP,
        nulls=dict(
            selection_adjusted="(a) procedure level: 1000 draws of the same procedure with a random candidate order instead of |t| order (same eligibility, "
                               "de-dup, K, side rule and validation filter); compared statistics: pooled 2021-22 net R/trade of all selected windows and pooled "
                               "2023+ net R/trade of survivors; p = share of draws >= actual. (b) per window: the 2023+ net R/trade of all eligible candidates "
                               "(all instruments) that pass the same validation filter; p = share >= this window's.",
            random_side="per trade, the actual or the opposite-side net outcome by a fair coin, 1000 draws; p = share with mean >= actual",
            always_long="unpaired comparator, same instrument and evaluation window: U/L windows vs the per-day mean long net over all 24 hourly "
                        "windows of the same clock; D windows vs long net over all D windows; named effects per named_comparators. "
                        "Delta bootstrapped jointly by day; p = share of replicates with delta <= 0."),
        windows=dict(selection="2018-2020", validation="2021-2022", w2023="2023-01-01 .. 2026-10-07 (development window)",
                     named_dev="2018-2022", crisis="abs11 windows 2020H1, 2022H1, 2025Q4-26Q1 (stress, reported only)"),
        metrics="trades, trades/year, net R/trade [95% CI], hit rate, gross, spread cost, financing cost, net at 0%/6% financing and at 1.5x spread, "
                "moving-block day bootstrap (validate.day_boot, block 5; 1000 reps pooled and named dev/2023+, 300 per selected window, crisis, year), "
                "MDE = 2.8 x bootstrap SE, per-year net R/trade with CIs",
        decision_rule=dict(
            selected_windows="DROPPED iff it fails validation. A frozen window is SUPPORTED (development evidence only, eligible to propose a shadow "
                             "registration under issue 313) iff in 2023+: net R/trade 95% CI lower bound > 0 AND Holm-adjusted (over all selected "
                             "windows) p < 0.05 for each of: R/trade <= 0, random side, per-window selection null, always-long comparator. "
                             "REJECTED iff the 2023+ CI upper bound < 0. Otherwise INCONCLUSIVE (with MDE).",
            named="As orb15: SUPPORTED iff in BOTH dev 2018-2022 and 2023+: CI lower bound > 0, Holm-adjusted (13 named) p < 0.05 for R/trade <= 0, "
                  "random side and always-long comparator. REJECTED iff CI upper bound < 0 in both. Otherwise INCONCLUSIVE.",
            procedure="The procedure-level selection null is reported; a procedure p_w23 >= 0.05 means the |t| ranking adds nothing over random picks."),
        budget=dict(scan_candidates_nominal=51 * 9, K=K, max_selected=K * 9, named=len(NAMED), tuned_hyperparameters=0,
                    fixed_constants=dict(K=K, CORR_MAX=CORR_MAX, MIN_N=MIN_N, SPR_R=SPR_R, FIN_BASE=FIN_BASE, R_k=POLICY["k"])),
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
