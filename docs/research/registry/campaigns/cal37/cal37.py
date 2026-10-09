"""cal37: calendar effects in stock-index CFDs on daily mid bars.
H1 turn of the month (Lakonishok and Smidt 1988; McConnell and Xu 2008), H2 pre-FOMC drift (Lucca and Moench 2015),
H3 pre-holiday (US exchange holidays). Data: audit/tsmom36/daily.db (read-only), fomc_dates.json (fomc_parse.py),
history.db read-only for the SPX500 intraday FOMC secondary.

  python cal37.py check      synthetic fixtures (TOM labelling, holiday rules, pre-holiday mapping, bootstrap stats)
  python cal37.py describe   event counts per hypothesis and window (no returns)
  python cal37.py register   write prereg.json (refuses to overwrite)
  python cal37.py run        primaries + secondaries -> out/results.json, trials.jsonl rows
"""
import os, sys, json, time, hashlib, sqlite3, datetime as dt
from zoneinfo import ZoneInfo
import numpy as np
import pandas as pd
from pandas.tseries.holiday import (AbstractHolidayCalendar, Holiday, USMartinLutherKingJr, USPresidentsDay, GoodFriday,
                                    USMemorialDay, USLaborDay, USThanksgivingDay, nearest_workday, sunday_to_monday)

HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out")
DB = os.path.join(ENG, "audit", "tsmom36", "daily.db")
HIST = os.path.join(ENG, "..", "history.db")
SPREADS = os.path.join(ENG, "audit", "tsmom36", "out", "spreads.json")
EXP = "cal37"
INDICES = ["SPX500_USD", "NAS100_USD", "US30_USD", "DE30_EUR", "UK100_GBP", "JP225_USD", "AU200_AUD", "HK33_HKD"]
US3 = ["SPX500_USD", "NAS100_USD", "US30_USD"]
WINDOWS = {"dev": ("2005-01-01", "2022-12-31"), "w2023": ("2023-01-01", "2100-01-01")}
NBOOT, SEED, ALPHA = 1000, 37, 0.05
FIN = 0.03                # CFD financing per year on |notional|, charged per calendar night (assumption)
FLAT_SIDE_BPS = 2.0       # cost per side where candles_ba has no spread
ET = ZoneInfo("America/New_York")
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()


# ------------------------------------------------------------------ data
def load():
    """Daily mid closes per index on its own trading dates (bar close date; weekend stubs dropped, as tsmom36)."""
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    q = f"SELECT instrument, time, c FROM daily WHERE instrument IN ({','.join('?' * len(INDICES))})"
    d = pd.read_sql(q, db, params=INDICES)
    d["date"] = (pd.to_datetime(d["time"]) + pd.Timedelta(days=1)).dt.normalize()
    d = d[d["date"].dt.dayofweek < 5]
    return {i: g.set_index("date")["c"].sort_index() for i, g in d.groupby("instrument")}


def fomc_dates():
    return pd.DatetimeIndex(json.load(open(os.path.join(HERE, "fomc_dates.json")))["dates"])


class NYSE(AbstractHolidayCalendar):
    # regular NYSE full-day holidays. New Year on a Saturday is not observed on the Friday (NYSE rule).
    rules = [Holiday("NewYear", month=1, day=1, observance=sunday_to_monday), USMartinLutherKingJr, USPresidentsDay,
             GoodFriday, USMemorialDay, Holiday("Juneteenth", month=6, day=19, start_date="2022-01-01", observance=nearest_workday),
             Holiday("July4", month=7, day=4, observance=nearest_workday), USLaborDay, USThanksgivingDay,
             Holiday("Christmas", month=12, day=25, observance=nearest_workday)]


def us_holidays(a="2004-01-01", b="2026-12-31"):
    h = NYSE().holidays(a, b)
    return h[h.dayofweek < 5]


def pre_holiday_days(hol):
    """Last NYSE trading day (weekday, not a holiday) strictly before each holiday; deduplicated."""
    hs = set(hol)
    out = set()
    for h in hol:
        p = h - pd.Timedelta(days=1)
        while p.dayofweek >= 5 or p in hs:
            p -= pd.Timedelta(days=1)
        out.add(p)
    return pd.DatetimeIndex(sorted(out))


def tom_labels(dates):
    """For an instrument's own trading dates: TOM flag (last trading day of month, first three of the next) and the
    block key (the 'turn' month: the last day of month m belongs to m+1, so each TOM window sits in one block).
    The TOM trade is long from the close of the second-to-last day to the close of day +3: its returns are days -1,+1,+2,+3."""
    s = pd.Series(dates, index=dates)
    per = dates.to_period("M")
    g = s.groupby(per)
    from_end = g.cumcount(ascending=False).values + 1         # 1 = last trading day of month
    from_start = g.cumcount().values + 1                      # 1 = first trading day
    tom = (from_end == 1) | (from_start <= 3)
    key = np.where(from_end == 1, (per + 1).astype(str), per.astype(str))
    return pd.DataFrame({"tom": tom, "key": key, "from_end": from_end, "from_start": from_start}, index=dates)


# ------------------------------------------------------------------ statistics
def block_sums(r, ev, key, keys):
    """Per-block event/other sums and counts aligned to the union key list."""
    df = pd.DataFrame({"r": r.values, "ev": ev, "key": key})
    ix = pd.Index(keys)
    es = df[df.ev].groupby("key")["r"].agg(["sum", "count"]).reindex(ix, fill_value=0)
    os_ = df[~df.ev].groupby("key")["r"].agg(["sum", "count"]).reindex(ix, fill_value=0)
    return np.vstack([es["sum"], es["count"], os_["sum"], os_["count"]]).astype(float)   # 4 x K


def boot_pooled(parts, keys, nboot=NBOOT, seed=SEED):
    """parts: list of 4xK block-sum arrays (one per instrument), equal weight. Resamples months jointly for all
    instruments. Returns point (event mean, diff) and bootstrap draws of both, in return units."""
    K = len(keys)
    rng = np.random.default_rng(seed)
    C = np.vstack([np.bincount(rng.integers(0, K, K), minlength=K) for _ in range(nboot)]).astype(float)  # B x K
    def stat(W):
        evm, dif = [], []
        for P in parts:
            em = (W @ P[0]) / (W @ P[1])
            om = (W @ P[2]) / (W @ P[3])
            evm.append(em); dif.append(em - om)
        return np.nanmean(np.array(evm), axis=0), np.nanmean(np.array(dif), axis=0)
    pe, pd_ = stat(np.ones((1, K)))
    be, bd = stat(C)
    return float(pe[0]), float(pd_[0]), be, bd


def pval(b):
    b = b[~np.isnan(b)]
    return min(1.0, 2 * (min((b <= 0).sum(), (b >= 0).sum()) + 1) / (len(b) + 1))


def ci(b, level=0.95):
    b = b[~np.isnan(b)]
    a = (1 - level) / 2
    return [float(np.quantile(b, a)), float(np.quantile(b, 1 - a))]


def holm(ps):
    """Holm step-down: adjusted p and the per-hypothesis CI level 1 - alpha/(m - rank)."""
    m = len(ps)
    order = np.argsort(ps)
    adj, lvl, run = [0.0] * m, [0.0] * m, 0.0
    for k, j in enumerate(order):
        run = max(run, min(1.0, (m - k) * ps[j]))
        adj[j] = run
        lvl[j] = 1 - ALPHA / (m - k)
    return adj, lvl


# ------------------------------------------------------------------ events
def daily_returns(c):
    r = c.pct_change().dropna()
    return r


def events_for(inst, c, hyp, fomc, preh):
    """Event flag, block key and event windows (start close date, end close date) per instrument."""
    r = daily_returns(c)
    if hyp == "H1":
        lab = tom_labels(r.index)
        ev, key = lab["tom"].values, lab["key"].values
        win = []
        dates = c.index
        for k, g in lab[lab.tom].groupby("key"):
            first = g.index.min()
            start = dates[dates.get_loc(first) - 1]
            win.append((k, start, g.index.max(), g.index))
    else:
        days = fomc if hyp == "H2" else preh
        ev = r.index.isin(days)
        key = r.index.to_period("M").astype(str).values
        dates = c.index
        win = [(str(d.to_period("M")), dates[dates.get_loc(d) - 1], d, pd.DatetimeIndex([d])) for d in r.index[ev]]
    return r, ev, key, win


def net_events(c, win, side_bps):
    """Per-event gross and net return in bps: compound over the held days, minus a round trip (2 x side cost),
    minus financing per calendar night."""
    g, n, ends = [], [], []
    for _, start, end, _days in win:
        gr = c.loc[end] / c.loc[start] - 1
        nights = (end - start).days
        g.append(gr * 1e4)
        n.append(gr * 1e4 - 2 * side_bps - nights * FIN / 365 * 1e4)
        ends.append(end)
    return pd.DataFrame({"gross": g, "net": n}, index=pd.DatetimeIndex(ends))


def side_costs():
    sp = json.load(open(SPREADS))
    return {i: (sp[i]["median_spread_bps"] / 2 if i in sp else FLAT_SIDE_BPS) for i in INDICES}


def analyse(closes, insts, hyp, window, fomc, preh, costs, seed=SEED):
    a, b = WINDOWS[window]
    parts, keysets, nets, n_ev = [], set(), [], {}
    per = {}
    for i in insts:
        r, ev, key, win = events_for(i, closes[i], hyp, fomc, preh)
        m = (r.index >= a) & (r.index <= b)
        per[i] = (r[m], ev[m], key[m])
        keysets |= set(key[m])
        wm = [w for w in win if a <= str(w[2].date()) <= b]
        ne = net_events(closes[i], wm, costs[i])
        nets.append(ne)
        n_ev[i] = len(wm)
    keys = sorted(keysets)
    for i in insts:
        parts.append(block_sums(*per[i], keys))
    pe, pdf, be, bd = boot_pooled(parts, keys, seed=seed)
    yrs = (min(pd.Timestamp(b), max(n.index.max() for n in nets if len(n))) - pd.Timestamp(a)).days / 365.25
    netm = float(np.mean([n["net"].mean() for n in nets]))
    grossm = float(np.mean([n["gross"].mean() for n in nets]))
    ev_per_year = float(np.mean(list(n_ev.values()))) / yrs
    # yearly stability of the difference (point estimates, pooled equal weight)
    yearly = {}
    for y in sorted({d.year for i in insts for d in per[i][0].index}):
        ds = []
        for i in insts:
            rr, ee, _ = per[i]
            ym = rr.index.year == y
            if ee[ym].any() and (~ee[ym]).any():
                ds.append(rr[ym][ee[ym]].mean() - rr[ym][~ee[ym]].mean())
        if ds:
            yearly[y] = float(np.mean(ds) * 1e4)
    return {"insts": insts, "n_events": n_ev, "n_event_days": int(sum(per[i][1].sum() for i in insts)),
            "n_other_days": int(sum((~per[i][1]).sum() for i in insts)),
            "event_mean_bps": pe * 1e4, "event_mean_ci": [x * 1e4 for x in ci(be)],
            "diff_bps": pdf * 1e4, "diff_ci": [x * 1e4 for x in ci(bd)], "p": pval(bd),
            "boot_sd_diff_bps": float(np.nanstd(bd) * 1e4), "mde80_bps": float(2.8 * np.nanstd(bd) * 1e4),
            "event_gross_bps": grossm, "event_net_bps": netm, "events_per_year": ev_per_year,
            "net_annual_pct": netm * ev_per_year / 100, "yearly_diff_bps": yearly,
            "years_pos": int(sum(v > 0 for v in yearly.values())), "years": len(yearly), "_bd": bd}


# ------------------------------------------------------------------ intraday FOMC (SPX500, 2018+)
def intraday_fomc(fomc):
    """Pre-announcement window: P(14:00 ET on the previous NYSE trading day) -> P(13:59 ET on the statement day),
    P(t) = mid open of the M1 bar starting at t. Post window 13:59 -> 16:59 ET. Comparison: the same pre window on
    all other NYSE trading days."""
    db = sqlite3.connect(f"file:{os.path.abspath(HIST)}?mode=ro", uri=True)
    q = ("SELECT time, (bid_o + ask_o) / 2 AS o FROM candles_ba WHERE instrument='SPX500/USD' AND granularity='M1' "
         "AND time >= '2018-01-01' AND substr(time, 12, 2) IN ('17','18','19','20','21','22')")
    d = pd.read_sql(q, db)
    t = pd.to_datetime(d["time"].str[:19]).dt.tz_localize("UTC").dt.tz_convert(ET)
    px = pd.Series(d["o"].values, index=t.dt.tz_localize(None))
    hol = set(us_holidays("2017-12-01", "2026-12-31"))
    tdays = [x for x in pd.bdate_range("2018-01-02", px.index.max().normalize()) if x not in hol]
    rows = []
    for prev, day in zip(tdays[:-1], tdays[1:]):
        p0 = px.get(prev + pd.Timedelta(hours=14))
        p1 = px.get(day + pd.Timedelta(hours=13, minutes=59))
        p2 = px.get(day + pd.Timedelta(hours=16, minutes=59))
        if p0 is None or p1 is None:
            continue
        rows.append({"date": day, "pre": p1 / p0 - 1, "post": (p2 / p1 - 1) if p2 is not None else np.nan})
    df = pd.DataFrame(rows).set_index("date")
    df["ev"] = df.index.isin(fomc)
    out = {"n_fomc_2018plus": int(df.index.isin(fomc).sum()),
           "fomc_dates_missing_price": [str(x.date()) for x in fomc if x >= pd.Timestamp("2018-01-01") and x <= df.index.max() and x not in df.index]}
    for wn, (a, b) in {"dev2018": ("2018-01-01", "2022-12-31"), "w2023": WINDOWS["w2023"]}.items():
        x = df.loc[a:b]
        key = x.index.to_period("M").astype(str).values
        keys = sorted(set(key))
        P = block_sums(x["pre"], x["ev"].values, key, keys)
        pe, pdf, be, bd = boot_pooled([P], keys, seed=SEED)
        out[wn] = {"n_events": int(x.ev.sum()), "n_other": int((~x.ev).sum()),
                   "pre_event_mean_bps": pe * 1e4, "pre_event_ci": [v * 1e4 for v in ci(be)],
                   "pre_diff_bps": pdf * 1e4, "pre_diff_ci": [v * 1e4 for v in ci(bd)], "p": pval(bd),
                   "post_event_mean_bps": float(x.loc[x.ev, "post"].mean() * 1e4),
                   "post_other_mean_bps": float(x.loc[~x.ev, "post"].mean() * 1e4)}
    return out


# ------------------------------------------------------------------ commands
def check():
    # TOM labelling on a synthetic calendar: Jan 2021 weekdays + Feb 2021 weekdays
    dates = pd.bdate_range("2021-01-04", "2021-02-26")
    lab = tom_labels(dates)
    tom = list(lab.index[lab.tom].strftime("%m-%d"))
    assert tom == ["01-04", "01-05", "01-06", "01-29", "02-01", "02-02", "02-03", "02-26"], tom
    assert lab.loc["2021-01-29", "key"] == "2021-02" and lab.loc["2021-02-01", "key"] == "2021-02"
    assert lab.loc["2021-01-28", "key"] == "2021-01" and not lab.loc["2021-01-28", "tom"]
    # TOM window: start = close of the second-to-last trading day, 4 return days
    c = pd.Series(np.arange(1, len(dates) + 1, dtype=float), index=dates)
    _, ev, key, win = events_for("X", c, "H1", None, None)
    w = [x for x in win if x[0] == "2021-02"][0]
    assert str(w[1].date()) == "2021-01-28" and str(w[2].date()) == "2021-02-03" and len(w[3]) == 4, w
    # NYSE holidays: known lists
    h19 = set(us_holidays("2019-01-01", "2019-12-31").strftime("%m-%d"))
    assert h19 == {"01-01", "01-21", "02-18", "04-19", "05-27", "07-04", "09-02", "11-28", "12-25"}, h19
    h22 = set(us_holidays("2022-01-01", "2022-12-31").strftime("%m-%d"))
    assert h22 == {"01-17", "02-21", "04-15", "05-30", "06-20", "07-04", "09-05", "11-24", "12-26"}, h22  # 2022-01-01 Sat: not observed
    h15 = set(us_holidays("2015-07-01", "2015-07-31").strftime("%m-%d"))
    assert h15 == {"07-03"}, h15
    ph = set(pre_holiday_days(us_holidays("2019-01-01", "2019-12-31")).strftime("%m-%d"))
    assert ph == {"12-31", "01-18", "02-15", "04-18", "05-24", "07-03", "08-30", "11-27", "12-24"}, ph
    # FOMC event = bar whose close date is the statement date; window start = previous own bar close
    c2 = pd.Series([1.0, 1.0, 1.1, 1.1], index=pd.DatetimeIndex(["2024-03-18", "2024-03-19", "2024-03-20", "2024-03-21"]))
    r, ev, key, win = events_for("X", c2, "H2", pd.DatetimeIndex(["2024-03-20"]), None)
    assert list(r.index[ev].strftime("%m-%d")) == ["03-20"] and str(win[0][1].date()) == "2024-03-19"
    ne = net_events(c2, win, 1.0)
    assert abs(ne["gross"].iloc[0] - 1000) < 1e-6 and abs(ne["net"].iloc[0] - (1000 - 2 - 0.03 / 365 * 1e4)) < 1e-6
    # bootstrap: planted +10 bps on event days, other days 0 -> diff exactly 10 bps, CI degenerate at 10
    idx = pd.bdate_range("2010-01-01", "2012-12-31")
    rr = pd.Series(0.0, index=idx)
    lab = tom_labels(idx)
    rr[lab.tom.values] = 0.001
    P = block_sums(rr, lab.tom.values, lab.key.values, sorted(set(lab.key)))
    pe, pdf, be, bd = boot_pooled([P, P], sorted(set(lab.key)))
    assert abs(pdf - 0.001) < 1e-12 and abs(ci(bd)[0] - 0.001) < 1e-12 and pval(bd) < 0.01
    adj, lvl = holm([0.01, 0.04, 0.03])
    assert np.allclose(adj, [0.03, 0.06, 0.06]) and np.allclose(lvl, [1 - 0.05 / 3, 1 - 0.05 / 1, 1 - 0.05 / 2])
    print("check ok")


def describe():
    closes = load()
    fomc, preh = fomc_dates(), pre_holiday_days(us_holidays())
    out = {"starts": {i: str(c.index.min().date()) for i, c in closes.items()},
           "last": {i: str(c.index.max().date()) for i, c in closes.items()}, "counts": {}}
    for wn, (a, b) in WINDOWS.items():
        for i in INDICES:
            for h in ("H1", "H2", "H3"):
                _, ev, _, win = events_for(i, closes[i], h, fomc, preh)
                out["counts"][f"{h}|{i}|{wn}"] = sum(a <= str(w[2].date()) <= b for w in win)
    # FOMC / pre-holiday dates without an SPX500 bar
    spx = closes["SPX500_USD"].index
    out["fomc_missing_spx"] = [str(d.date()) for d in fomc if d <= spx.max() and d not in spx]
    out["preholiday_missing_spx"] = [str(d.date()) for d in preh if pd.Timestamp("2005") <= d <= spx.max() and d not in spx]
    out["us_holidays_2005_2026"] = len(us_holidays("2005-01-01", "2026-12-31"))
    out["side_cost_bps"] = side_costs()
    os.makedirs(OUT, exist_ok=True)
    json.dump(out, open(os.path.join(OUT, "describe.json"), "w"), indent=1)
    print(json.dumps(out, indent=1))


def register():
    f = os.path.join(HERE, "prereg.json")
    if os.path.exists(f):
        sys.exit("prereg.json exists")
    body = json.load(open(os.path.join(HERE, "prereg_body.json")))
    body = {"created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "sha256": {n: sha(os.path.join(HERE, n)) for n in ("cal37.py", "fomc_parse.py", "fomc_dates.json")}, **body}
    json.dump(body, open(f, "w"), indent=1)
    print("registered", f)


def run():
    closes = load()
    fomc, preh = fomc_dates(), pre_holiday_days(us_holidays())
    costs = side_costs()
    prim = {"H1": INDICES, "H2": ["SPX500_USD"], "H3": ["SPX500_USD"]}
    res, trials = {"primary": {}, "secondary": {}}, []
    ts = time.strftime("%Y-%m-%dT%H:%M:%S")
    for wn in WINDOWS:
        cells = {h: analyse(closes, ins, h, wn, fomc, preh, costs) for h, ins in prim.items()}
        hs = list(cells)
        adj, lvl = holm([cells[h]["p"] for h in hs])
        for h, pa, lv in zip(hs, adj, lvl):
            c = cells[h]
            c["holm_p"], c["holm_level"] = pa, lv
            c["holm_ci"] = [x * 1e4 for x in ci(c.pop("_bd"), lv)]
            c["pass_window"] = bool(pa < ALPHA and c["diff_bps"] > 0 and c["holm_ci"][0] > 0)
        res["primary"][wn] = cells
    res["verdict"] = {h: ("PASS" if all(res["primary"][w][h]["pass_window"] for w in WINDOWS) else "FAIL") for h in prim}
    # secondary: each index alone, each hypothesis
    for wn in WINDOWS:
        for h in ("H1", "H2", "H3"):
            for i in INDICES:
                c = analyse(closes, [i], h, wn, fomc, preh, costs)
                c.pop("_bd")
                res["secondary"][f"{h}|{i}|{wn}"] = c
    # secondary: H1 by TOM day position, pooled (each day alone vs non-TOM days)
    pos = {}
    for wn, (a, b) in WINDOWS.items():
        for name, sel in {"d-1": lambda L: L.from_end == 1, "d+1": lambda L: L.from_start == 1,
                          "d+2": lambda L: L.from_start == 2, "d+3": lambda L: L.from_start == 3}.items():
            parts, keys, per = [], set(), []
            for i in INDICES:
                r = daily_returns(closes[i])
                lab = tom_labels(r.index)
                m = (r.index >= a) & (r.index <= b)
                keep = m & (sel(lab).values | ~lab.tom.values)
                per.append((r[keep], sel(lab).values[keep], lab.key.values[keep]))
                keys |= set(lab.key.values[keep])
            keys = sorted(keys)
            pe, pdf, be, bd = boot_pooled([block_sums(*p, keys) for p in per], keys)
            pos[f"{name}|{wn}"] = {"event_mean_bps": pe * 1e4, "diff_bps": pdf * 1e4, "diff_ci": [x * 1e4 for x in ci(bd)]}
    res["secondary_tom_position"] = pos
    res["intraday_fomc_spx"] = intraday_fomc(fomc)
    res["side_cost_bps"] = costs
    os.makedirs(OUT, exist_ok=True)
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    for wn in WINDOWS:
        for h, c in res["primary"][wn].items():
            trials.append({"ts": ts, "exp": EXP, "unit": "pooled8" if h == "H1" else "SPX500_USD", "tf": "D", "cell": h,
                           "window": wn, "primary": True, "n_events": sum(c["n_events"].values()),
                           "diff_bps": c["diff_bps"], "diff_ci": c["diff_ci"], "holm_p": c["holm_p"],
                           "net_bps": c["event_net_bps"], "mde80_bps": c["mde80_bps"]})
    for k, c in res["secondary"].items():
        h, i, wn = k.split("|")
        trials.append({"ts": ts, "exp": EXP, "unit": i, "tf": "D", "cell": h, "window": wn, "primary": False,
                       "n_events": c["n_events"][i], "diff_bps": c["diff_bps"], "diff_ci": c["diff_ci"], "p": c["p"],
                       "net_bps": c["event_net_bps"], "mde80_bps": c["mde80_bps"]})
    for wn in ("dev2018", "w2023"):
        c = res["intraday_fomc_spx"][wn]
        trials.append({"ts": ts, "exp": EXP, "unit": "SPX500_USD", "tf": "M1", "cell": "H2_pre14", "window": wn,
                       "primary": False, "n_events": c["n_events"], "diff_bps": c["pre_diff_bps"], "diff_ci": c["pre_diff_ci"], "p": c["p"]})
    with open(os.path.join(ENG, "trials.jsonl"), "a") as f:
        for t in trials:
            f.write(json.dumps(t, default=float) + "\n")
    print("verdict", res["verdict"])


if __name__ == "__main__":
    {"check": check, "describe": describe, "register": register, "run": run}[sys.argv[1]]()
