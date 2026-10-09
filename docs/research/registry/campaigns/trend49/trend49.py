"""trend49: DESCRIPTIVE check, hindsight-selected episodes, not a test.
How much of named recent rallies a fixed daily trend rule keeps, net of CFD costs. No pass/fail verdict.

  python trend49.py check      synthetic fixtures (timing, no lookahead, cost arithmetic)
  python trend49.py register   write prereg.json with the script sha256 (refuses to overwrite)
  python trend49.py run        out/results.json, out/tables.md, trials.jsonl rows (posthoc true)
"""
import os, sys, json, time, sqlite3
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "tsmom36"))
import tsmom36 as T  # noqa: E402  (DB path, ANN, maxdd, spreads_bps, FLAT_SIDE_BPS, sha)

OUT = os.path.join(HERE, "out")
ENG = T.ENG
EXP = "trend49"
INSTS = ["XAG_USD", "XAU_USD", "NATGAS_USD", "NAS100_USD", "SPX500_USD", "WTICO_USD"]
RULES = ["TS12", "TS6", "SMA200", "BH"]
COSTS = ["gross", "cfd", "fut"]
WINDOWS = {"2018-22": ("2018-01-01", "2022-12-31"), "2023+": ("2023-01-01", "2100-01-01")}
MARKUP = 0.025            # OANDA financing markup per year: long basis + 2.5%, short basis - 2.5%
POST_PEAK_BARS = 126      # giveback horizon after the episode's price extreme
# Basis proxy: US 3-month T-bill, annual average of FRED series DTB3 (secondary market rate), percent.
# Values recalled, not fetched; 2026 is an estimate for Jan-Oct. All six instruments are USD-quoted.
TBILL = {2003: 1.01, 2004: 1.37, 2005: 3.15, 2006: 4.73, 2007: 4.36, 2008: 1.37, 2009: 0.15, 2010: 0.14,
         2011: 0.05, 2012: 0.09, 2013: 0.06, 2014: 0.03, 2015: 0.05, 2016: 0.32, 2017: 0.93, 2018: 1.94,
         2019: 2.06, 2020: 0.36, 2021: 0.04, 2022: 2.02, 2023: 5.07, 2024: 4.97, 2025: 4.07, 2026: 3.70}
EPISODES = [  # (name, instrument, start, end); dates chosen by the operator in hindsight
    ("XAG rally 2025-03..2026-02", "XAG_USD", "2025-03-01", "2026-02-28"),
    ("XAG fall 2026-03..2026-06", "XAG_USD", "2026-03-01", "2026-06-30"),
    ("XAU rally 2025-03..2026-02", "XAU_USD", "2025-03-01", "2026-02-28"),
    ("XAU fall 2026-03..2026-06", "XAU_USD", "2026-03-01", "2026-06-30"),
    ("NAS100 AI rally 2023-01..2026-10", "NAS100_USD", "2023-01-01", "2026-10-31"),
    ("NATGAS spike 2022-06..2022-09", "NATGAS_USD", "2022-06-01", "2022-09-30"),
    ("NATGAS spike 2025-10..2026-02", "NATGAS_USD", "2025-10-01", "2026-02-28"),
]
PREREG = {
    "label": "descriptive, hindsight-selected episodes, not a test",
    "question": "How much of the named rallies would a simple fixed trend rule have kept, net of real CFD costs?",
    "data": "audit/tsmom36/daily.db (OANDA daily mid, read-only); trading date = bar open + 24 h; weekend-close stubs dropped",
    "instruments": INSTS, "windows": WINDOWS,
    "rules": {"TS12": "sign of 252-bar return at the close; +1 long, -1 short",
              "TS6": "sign of 126-bar return at the close",
              "SMA200": "long 1 if close > 200-bar mean, else flat (long-only)",
              "BH": "long 1 always (comparison)",
              "timing": "decided at the daily close t, filled at the open of bar t+1, checked daily; the old position earns the gap close t -> open t+1",
              "size": "1 unit notional, no volatility scaling; returns are % of price"},
    "costs": {"gross": "mid, no costs",
              "cfd": "half median M1 spread per side (history.db via tsmom36.spreads_bps, fallback 2 bps) on |position change|, "
                     "plus financing on |position| per calendar day to the next bar: long basis+2.5%/yr, short 2.5%-basis per yr (negative = credit)",
              "fut": "spread only, no financing"},
    "basis_proxy": {"series": "US 3-month T-bill, FRED DTB3 annual average, percent (recalled, 2026 estimated)", "values": TBILL,
                    "caveat": "OANDA commodity CFD financing passes the futures term structure through; the flat proxy is approximate. "
                              "Index CFD dividend adjustments are not modelled."},
    "metrics": "per instrument, rule, cost and window: total and annualised return (compounded daily), max drawdown, "
               "position changes, time in market; per episode: buy-and-hold log move, rule log P&L / B&H log move over the episode "
               "and from start to the episode price extreme, and rule P&L from the extreme to extreme + 126 bars as share of the start-to-extreme move (giveback)",
    "episodes": EPISODES, "post_peak_bars": POST_PEAK_BARS,
    "window_start": "the position held at a window start is charged one entry spread",
}


def load(inst):
    db = sqlite3.connect(f"file:{T.DB}?mode=ro", uri=True)
    d = pd.read_sql("SELECT time, o, c FROM daily WHERE instrument=? ORDER BY time", db, params=(inst,))
    d["date"] = (pd.to_datetime(d["time"]) + pd.Timedelta(days=1)).dt.normalize()
    d = d[d["date"].dt.dayofweek < 5].drop_duplicates("date", keep="last").set_index("date")
    return d[["o", "c"]].astype(float)


def target(c, rule):
    """Position decided at the close of each bar, using closes <= that bar only."""
    if rule == "BH":
        return pd.Series(1.0, index=c.index)
    if rule == "SMA200":
        m = c.rolling(200).mean()
        return (c > m).astype(float).where(m.notna()).fillna(0.0)
    lb = {"TS12": 252, "TS6": 126}[rule]
    return np.sign(c / c.shift(lb) - 1).fillna(0.0)


def sim(d, rule, side, basis=TBILL):
    """Daily strategy frame. new = position held from the open of bar t (target of bar t-1); old = previous one."""
    c, o = d["c"], d["o"]
    new = target(c, rule).shift(1).fillna(0.0)
    old = new.shift(1).fillna(0.0)
    r = (c / c.shift(1) - 1).fillna(0.0)
    gap = (o / c.shift(1) - 1).fillna(0.0)
    gross = new * r + (old - new) * gap                 # exact when old == new
    spread = (new - old).abs() * side
    nxt = d.index.to_series().shift(-1).fillna(d.index[-1] + pd.Timedelta(days=1))
    days = (nxt - d.index.to_series()).dt.days
    b = pd.Series([basis[y] / 100 for y in d.index.year], index=d.index)
    rate = np.where(new > 0, b + MARKUP, np.where(new < 0, MARKUP - b, 0.0))
    fin = new.abs() * rate * days / 365
    return pd.DataFrame({"pos": new, "old": old, "c": c, "gross": gross, "fut": gross - spread,
                         "cfd": gross - spread - fin, "spread": spread, "fin": fin})


def window_stats(f, side, a, b):
    x = f.loc[a:b].copy()
    first = x.index[0]
    entry = abs(x["old"].iloc[0]) * side                # inherited position charged one entry spread
    yrs = len(x) / T.ANN
    o = {"days": int(len(x)), "start": str(first.date()), "end": str(x.index[-1].date()),
         "trades": int(((x["pos"] - x["old"]).abs() > 0).sum()), "time_in_market": float((x["pos"] != 0).mean()),
         "share_long": float((x["pos"] > 0).mean()), "share_short": float((x["pos"] < 0).mean()),
         "spread_cost_ann": float((x["spread"].sum() + entry) / yrs), "fin_cost_ann": float(x["fin"].sum() / yrs)}
    for k in COSTS:
        r = x[k].copy()
        if k != "gross":
            r.iloc[0] -= entry
        tot = float(np.prod(1 + r.values) - 1)
        o[k] = {"total": tot, "ann": float((1 + tot) ** (1 / yrs) - 1), "maxdd": T.maxdd(r.values)}
    return o


def episode(f, start, end):
    x = f.loc[start:end]
    i0 = f.index.get_loc(x.index[0])
    base = f["c"].iloc[i0 - 1]
    move = np.log(x["c"].iloc[-1] / base)
    sgn = np.sign(move)
    k = int(np.argmax(sgn * np.log(x["c"].values)))
    peak_date = x.index[k]
    to_peak = np.log(x["c"].iloc[k] / base)
    ip = f.index.get_loc(peak_date)
    after = f.iloc[ip + 1: ip + 1 + POST_PEAK_BARS]
    o = {"bh_move_pct": float(np.exp(move) - 1), "bh_to_extreme_pct": float(np.exp(to_peak) - 1),
         "extreme_date": str(peak_date.date()), "post_bars": int(len(after)),
         "bh_giveback_share": float(-np.log(after["c"].iloc[-1] / x["c"].iloc[k]) / to_peak) if len(after) else None}
    for k2 in COSTS:
        lr = np.log1p(f[k2])
        o[k2] = {"capture": float(lr.loc[x.index].sum() / move),
                 "capture_to_extreme": float(lr.loc[x.index[0]:peak_date].sum() / to_peak),
                 "giveback": float(-lr.loc[after.index].sum() / to_peak) if len(after) else None}
    o["time_in_market"] = float((x["pos"] != 0).mean())
    o["trades"] = int(((x["pos"] - x["old"]).abs() > 0).sum())
    return o


def check():
    idx = pd.bdate_range("2015-01-01", "2019-12-31")
    rng = np.random.default_rng(49)
    c = pd.Series(100 * np.exp(np.cumsum(rng.normal(0, 0.01, len(idx)))), index=idx)
    d = pd.DataFrame({"o": c.shift(1).fillna(100.0), "c": c})
    # A: decision at t ignores later prices
    for rule in ("TS12", "TS6", "SMA200"):
        t0 = target(c, rule)
        c2 = c.copy(); c2.iloc[600:] *= 5
        assert (target(c2, rule).iloc[:600] == t0.iloc[:600]).all(), rule
    # B: position held during bar t+1 equals the target decided at bar t
    f = sim(d, "TS12", 0.0)
    t0 = target(c, "TS12")
    assert (f["pos"].iloc[1:].values == t0.iloc[:-1].values).all()
    # C: buy-and-hold gross equals the close-to-close return; a jump on the fill bar's gap is earned by the old position
    fb = sim(d, "BH", 0.0)
    assert np.allclose(fb["gross"].iloc[2:], (c / c.shift(1) - 1).iloc[2:])
    # D: costs. Constant long, basis 0: financing = 2.5%/yr per calendar day; one flip costs 2 x side
    z = {y: 0.0 for y in TBILL}
    fl = sim(d, "BH", 0.0, z)
    assert abs(fl["fin"].iloc[5:10].sum() - 0.025 * 7 / 365) < 1e-12      # 5 bars spanning one weekend = 7 calendar days
    up = pd.Series(np.r_[np.linspace(100, 200, 300), np.linspace(200, 50, 300)], index=idx[:600])
    fs = sim(pd.DataFrame({"o": up, "c": up}), "TS12", 0.001, z)
    flips = fs.index[(fs["pos"] - fs["old"]).abs() == 2]
    assert len(flips) == 1 and abs(fs.loc[flips[0], "spread"] - 0.002) < 1e-12
    assert (fs.loc[fs["pos"] < 0, "fin"] > 0).all()                       # basis 0: short pays 2.5%
    print("check ok")


def register():
    f = os.path.join(HERE, "prereg.json")
    if os.path.exists(f):
        sys.exit("prereg.json exists")
    body = {"created": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "exp": EXP,
            "code_sha256": {"trend49.py": T.sha(os.path.abspath(__file__)), "tsmom36.py": T.sha(os.path.join(T.HERE, "tsmom36.py"))},
            "before_registration": "Only the synthetic check ran. No rule return on real data was computed for this campaign. "
                                   "The operator picked the episodes in hindsight after seeing the moves.",
            **PREREG}
    json.dump(body, open(f, "w"), indent=1, default=str)
    print("registered", f)


def pct(x):
    return f"{100 * x:+.1f}%"


def run():
    sp = T.spreads_bps()
    sides = {i: (sp[i]["median_spread_bps"] / 2 if i in sp else T.FLAT_SIDE_BPS) / 1e4 for i in INSTS}
    res = {"label": PREREG["label"], "side_bps": {i: s * 1e4 for i, s in sides.items()}, "cells": {}, "episodes": {}}
    frames = {}
    trials = []
    ts = time.strftime("%Y-%m-%dT%H:%M:%S")
    for i in INSTS:
        d = load(i)
        for rule in RULES:
            f = sim(d, rule, sides[i])
            frames[(i, rule)] = f
            for wn, (a, b) in WINDOWS.items():
                s = window_stats(f, sides[i], a, b)
                res["cells"][f"{i}|{rule}|{wn}"] = s
                trials.append({"ts": ts, "exp": EXP, "posthoc": True, "descriptive": True, "inst": i, "tf": "D",
                               "cell": rule, "window": wn, "days": s["days"], "trades": s["trades"],
                               "time_in_market": s["time_in_market"],
                               **{f"{k}_ann": s[k]["ann"] for k in COSTS}, **{f"{k}_total": s[k]["total"] for k in COSTS},
                               "maxdd_cfd": s["cfd"]["maxdd"]})
    for name, i, a, b in EPISODES:
        res["episodes"][name] = {"inst": i, **{rule: episode(frames[(i, rule)], a, b) for rule in RULES}}
        for rule in RULES:
            e = res["episodes"][name][rule]
            trials.append({"ts": ts, "exp": EXP, "posthoc": True, "descriptive": True, "inst": i, "tf": "D", "cell": rule,
                           "window": f"episode:{name}", "bh_move_pct": e["bh_move_pct"],
                           **{f"capture_{k}": e[k]["capture"] for k in COSTS}, "giveback_cfd": e["cfd"]["giveback"]})
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1)
    # tables
    L = []
    for wn in WINDOWS:
        L += [f"\n### {wn}: total (annualised) per cost version, max DD CFD, trades, time in market\n",
              "| inst | rule | gross | CFD | futures-style | max DD CFD | trades | in market | spread / fin cost per yr |",
              "|---|---|---|---|---|---|---|---|---|"]
        for i in INSTS:
            for rule in RULES:
                s = res["cells"][f"{i}|{rule}|{wn}"]
                cell = lambda k: f"{pct(s[k]['total'])} ({pct(s[k]['ann'])})"
                L.append(f"| {i} | {rule} | {cell('gross')} | {cell('cfd')} | {cell('fut')} | {pct(s['cfd']['maxdd'])} | "
                         f"{s['trades']} | {100 * s['time_in_market']:.0f}% | {100 * s['spread_cost_ann']:.2f}% / {100 * s['fin_cost_ann']:.2f}% |")
    L += ["\n### Episodes: share of the buy-and-hold log move captured (gross / CFD / futures-style), to the extreme, giveback\n",
          "| episode | B&H move (to extreme, date) | rule | capture gross / CFD / fut | capture to extreme CFD | giveback after extreme CFD (B&H) | trades | in market |",
          "|---|---|---|---|---|---|---|---|"]
    for name, e in res["episodes"].items():
        for rule in RULES:
            x = e[rule]
            gb = "n/a" if x["cfd"]["giveback"] is None else f"{100 * x['cfd']['giveback']:.0f}% ({100 * x['bh_giveback_share']:.0f}%, {x['post_bars']} bars)"
            L.append(f"| {name} | {pct(x['bh_move_pct'])} ({pct(x['bh_to_extreme_pct'])}, {x['extreme_date']}) | {rule} | "
                     f"{100 * x['gross']['capture']:.0f}% / {100 * x['cfd']['capture']:.0f}% / {100 * x['fut']['capture']:.0f}% | "
                     f"{100 * x['cfd']['capture_to_extreme']:.0f}% | {gb} | {x['trades']} | {100 * x['time_in_market']:.0f}% |")
    open(os.path.join(OUT, "tables.md"), "w").write("\n".join(L) + "\n")
    with open(os.path.join(ENG, "trials.jsonl"), "a") as fh:
        for t in trials:
            fh.write(json.dumps(t) + "\n")
    print("\n".join(L))
    print(f"\n{len(trials)} trial rows appended")


if __name__ == "__main__":
    {"check": check, "register": register, "run": run}[sys.argv[1]]()
