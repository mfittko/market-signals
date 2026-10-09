"""tsmom36: diversified slow time-series momentum on OANDA daily mid candles (Moskowitz, Ooi and Pedersen 2012;
Hurst, Ooi and Pedersen 2017). Data: audit/tsmom36/daily.db (fetch.py). history.db is opened read-only for spreads.

  python tsmom36.py check      synthetic fixtures (timing / no lookahead, vol scaling, cap, eligibility)
  python tsmom36.py describe   universe, start dates, eligibility counts, dev window start, spreads (no strategy returns)
  python tsmom36.py register   write prereg.json (refuses to overwrite)
  python tsmom36.py run        all strategies -> out/results.json, trials.jsonl rows
"""
import os, sys, json, time, hashlib, sqlite3
import numpy as np
import pandas as pd
from arch.bootstrap import MovingBlockBootstrap

HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out")
DB = os.path.join(HERE, "daily.db")
HIST = os.path.join(ENG, "..", "history.db")
EXP = "tsmom36"
ANN = 261                 # trading days per year (MOP 2012)
TARGET_VOL = 0.40
CAP = 3.0
VOL_COM = 60              # EW variance, center of mass 60 days (MOP 2012: delta/(1-delta) = 60)
MIN_HIST = 300
LOOKBACKS = (63, 126, 252)
PRIMARY_LB = 252
BLOCK, NBOOT, SEED = 20, 1000, 36
FIN = 0.03                # CFD financing, share of |notional| per year, long and short (assumption)
FLAT_SIDE_BPS = 2.0       # cost per side for instruments without candles_ba
DEV_END = "2022-12-31"
W2_START = "2023-01-01"
TRADE6 = ["WTICO_USD", "XAU_USD", "XAG_USD", "NATGAS_USD", "SPX500_USD", "EUR_USD"]
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()


# ------------------------------------------------------------------ data
def load():
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    d = pd.read_sql("SELECT instrument, cls, time, c FROM daily", db)
    # OANDA time = bar open (17:00 New York); the bar closes 24 h later -> trading date = close date (UTC)
    d["date"] = (pd.to_datetime(d["time"]) + pd.Timedelta(days=1)).dt.normalize()
    # early years carry weekend stub bars (open Friday 17:00 NY); drop Saturday/Sunday close dates
    d = d[d["date"].dt.dayofweek < 5]
    close = d.pivot_table(index="date", columns="instrument", values="c").sort_index()
    cls = d.drop_duplicates("instrument").set_index("instrument")["cls"].to_dict()
    return close, cls


def positions(close, lb, eligible_hist=MIN_HIST):
    """Per-instrument target weight w[m, i] decided at month-end date m (close of m), using only closes <= m.
    Each instrument uses its own bar history (no fill across its missing days)."""
    sig, vol, nb = {}, {}, {}
    for i in close.columns:
        c = close[i].dropna()
        r = c.pct_change()
        v = np.sqrt(r.ewm(com=VOL_COM, min_periods=VOL_COM).var() * ANN)
        sig[i] = np.sign(c / c.shift(lb) - 1)
        vol[i] = v
        nb[i] = pd.Series(np.arange(1, len(c) + 1), index=c.index)
    idx = close.index
    S = pd.DataFrame(sig).reindex(idx).ffill()
    V = pd.DataFrame(vol).reindex(idx).ffill()
    N = pd.DataFrame(nb).reindex(idx).ffill()
    me = idx.to_series().groupby(idx.to_period("M")).max().values        # last union trading date per month
    w = (S * np.minimum(TARGET_VOL / V, CAP)).loc[me]
    ok = (N.loc[me] >= eligible_hist) & w.notna() & V.loc[me].gt(0)
    return w.where(ok)                                                    # NaN = not eligible


def daily_weights(close, w):
    """Weight held during each union date's return (close[t-1] -> close[t]).
    Decision at month-end m, trade at the close of the next union date m+1, so returns from date m+2 on carry it.
    Portfolio weight = w / (number eligible at m) (equal risk weight)."""
    idx = close.index
    pos = idx.get_indexer(w.index)
    n = w.notna().sum(axis=1).replace(0, np.nan)
    W = w.div(n, axis=0).fillna(0.0)
    W.index = idx[np.minimum(pos + 2, len(idx) - 1)]                      # first return date that carries it
    W = W[~W.index.duplicated(keep="last")]
    return W.reindex(idx).ffill().fillna(0.0), n


def returns_matrix(close):
    # return on a union date = close change since the instrument's previous available close; 0 on its missing days
    return close.ffill().pct_change().where(close.notna()).fillna(0.0)


def port_returns(close, lb, insts=None, spreads=None):
    c = close if insts is None else close[insts]
    if isinstance(lb, tuple):                                             # equal-weight blend of lookbacks
        ws = [positions(c, l) for l in lb]
        w = sum(x.fillna(0) for x in ws) / len(ws)
        w = w.where(ws[-1].notna())
    else:
        w = positions(c, lb)
    W, n = daily_weights(c, w)
    R = returns_matrix(c)
    gross = (W * R).sum(axis=1)
    out = pd.DataFrame({"gross": gross, "n": n.reindex(W.index).ffill()})
    if spreads is not None:
        side = pd.Series({i: spreads.get(i, FLAT_SIDE_BPS) for i in c.columns}) / 1e4
        turn = W.diff().abs().fillna(W.abs())
        out["cost_spread"] = (turn * side).sum(axis=1)
        out["cost_fin"] = W.abs().sum(axis=1) * FIN / ANN
        out["net"] = out["gross"] - out["cost_spread"] - out["cost_fin"]
    return out, W


# ------------------------------------------------------------------ stats
def sharpe(x):
    x = np.asarray(x)
    s = x.std(ddof=1)
    return float(x.mean() / s * np.sqrt(ANN)) if s > 0 else np.nan


def boot_ci(x, fn=sharpe):
    bs = MovingBlockBootstrap(BLOCK, np.asarray(x), seed=SEED)
    vals = bs.apply(lambda a: np.array([fn(a)]), NBOOT)[:, 0]
    return [float(np.nanpercentile(vals, 2.5)), float(np.nanpercentile(vals, 97.5))], float(np.nanstd(vals))


def maxdd(x):
    eq = np.cumprod(1 + np.asarray(x))
    return float((eq / np.maximum.accumulate(eq) - 1).min())


def summarize(r, net=None, spx=None):
    ci, sd = boot_ci(r.values)
    o = {"days": int(len(r)), "start": str(r.index[0].date()), "end": str(r.index[-1].date()),
         "ann_ret": float(r.mean() * ANN), "ann_vol": float(r.std(ddof=1) * np.sqrt(ANN)),
         "sharpe": sharpe(r), "sharpe_ci": ci, "sharpe_boot_sd": sd, "mde80_sharpe": 2.8 * sd,
         "maxdd": maxdd(r)}
    if net is not None:
        o["net_sharpe"] = sharpe(net)
        o["net_sharpe_ci"] = boot_ci(net.values)[0]
        o["net_ann_ret"] = float(net.mean() * ANN)
    if spx is not None:
        o["corr_spx_bh"] = float(np.corrcoef(r.values, spx.reindex(r.index).fillna(0).values)[0, 1])
    return o


# ------------------------------------------------------------------ inputs that are not outcomes
def spreads_bps():
    """Median relative M1 close spread (ask - bid) / mid, all hours, 2018+, from history.db (read-only).
    Cost per side = half the spread (trade from mid)."""
    f = os.path.join(OUT, "spreads.json")
    if os.path.exists(f):
        return json.load(open(f))
    db = sqlite3.connect(f"file:{os.path.abspath(HIST)}?mode=ro", uri=True)
    res = {}
    for (inst,) in db.execute("SELECT DISTINCT instrument FROM candles_ba WHERE granularity='M1'").fetchall():
        a = np.array(db.execute("SELECT bid_c, ask_c FROM candles_ba WHERE instrument=? AND granularity='M1'",
                                (inst,)).fetchall())
        res[inst.replace("/", "_")] = {"median_spread_bps": float(np.median((a[:, 1] - a[:, 0]) / ((a[:, 1] + a[:, 0]) / 2)) * 1e4),
                                       "n": int(len(a))}
    os.makedirs(OUT, exist_ok=True)
    json.dump(res, open(f, "w"), indent=1)
    return res


def dev_start(close):
    w = positions(close, PRIMARY_LB)
    n = w.notna().sum(axis=1)
    yrs = n.groupby(n.index.year).min()
    return int(yrs[yrs >= 10].index.min()), n


def describe():
    close, cls = load()
    rows = {}
    for i in close.columns:
        c = close[i].dropna()
        r = c.pct_change().abs()
        gaps = c.index.to_series().diff().dt.days
        rows[i] = {"cls": cls[i], "first": str(c.index[0].date()), "last": str(c.index[-1].date()), "bars": int(len(c)),
                   "abs_ret_gt_20pct": int((r > 0.2).sum()), "gaps_gt_5d": int((gaps > 5).sum())}
    y0, n = dev_start(close)
    sp = spreads_bps()
    d = {"instruments": rows, "dev_start_year": y0,
         "eligible_per_year_min": {int(k): int(v) for k, v in n.groupby(n.index.year).min().items()},
         "spreads": sp}
    os.makedirs(OUT, exist_ok=True)
    json.dump(d, open(os.path.join(OUT, "describe.json"), "w"), indent=1)
    print(json.dumps(d, indent=1))


# ------------------------------------------------------------------ fixtures
def check():
    idx = pd.bdate_range("2010-01-01", "2013-12-31")
    rng = np.random.default_rng(0)
    # A: no lookahead. Huge jump on the trade date m+1 (before the trade fills at its close) must not be earned.
    p = 100 * np.exp(np.cumsum(rng.normal(0.0005, 0.01, len(idx))))
    close = pd.DataFrame({"A": p, "B": p[::-1].copy()}, index=idx)
    w = positions(close, 252)
    W, n = daily_weights(close, w)
    m = w.dropna().index[5]
    k = idx.get_loc(m)
    assert W.index[k + 2] == idx[k + 2] and np.allclose(W.iloc[k + 2].values, (w.loc[m] / n.loc[m]).values)
    # weight carried on date m+1 is the previous decision, not the new one
    prev = w.dropna().index[4]
    assert np.allclose(W.iloc[k + 1].values, (w.loc[prev] / n.loc[prev]).values)
    # B: changing prices after m does not change the decision at m
    c2 = close.copy(); c2.iloc[k + 1:] *= 3
    assert np.allclose(positions(c2, 252).loc[m].values, w.loc[m].values)
    # C: vol scaling and cap. Constant-vol series: |w| = 0.4 / vol; tiny vol -> cap 3
    r = rng.normal(0, 0.02, len(idx)); r2 = rng.normal(0, 0.001, len(idx))
    cl = pd.DataFrame({"hi": 100 * np.cumprod(1 + r), "lo": 100 * np.cumprod(1 + r2)}, index=idx)
    ww = positions(cl, 252).dropna()
    assert abs(ww["hi"].abs().median() - 0.4 / (0.02 * np.sqrt(ANN))) < 0.15 and (ww["lo"].abs() == CAP).all()
    # D: eligibility needs 300 own bars
    cl2 = cl.copy(); cl2.iloc[:400, 1] = np.nan
    ww2 = positions(cl2, 252)
    first = cl2["lo"].first_valid_index()
    assert ww2["lo"].loc[: idx[idx.get_loc(first) + 298]].isna().all()
    # E: planted trend -> positive Sharpe; pure noise -> near zero
    tr = pd.DataFrame({f"t{j}": 100 * np.cumprod(1 + rng.normal(0.001 * (1 if j % 2 else -1), 0.01, len(idx))) for j in range(6)}, index=idx)
    assert sharpe(port_returns(tr, 252)[0]["gross"].iloc[300:]) > 1
    print("check ok")


# ------------------------------------------------------------------ registration and run
def register():
    f = os.path.join(HERE, "prereg.json")
    if os.path.exists(f):
        sys.exit("prereg.json exists")
    body = json.load(open(os.path.join(HERE, "prereg_body.json")))
    body = {"created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "code_sha256": {"tsmom36.py": sha(os.path.join(HERE, "tsmom36.py")), "fetch.py": sha(os.path.join(HERE, "fetch.py"))},
            **body}
    json.dump(body, open(f, "w"), indent=1)
    print("registered", f)


def run():
    close, cls = load()
    y0, _ = dev_start(close)
    sp = {k: v["median_spread_bps"] / 2 for k, v in spreads_bps().items()}   # half spread per side
    windows = {"dev": (f"{y0}-01-01", DEV_END), "w2023": (W2_START, "2100-01-01")}
    spx = returns_matrix(close)["SPX500_USD"]
    res, trials = {"dev_start_year": y0, "cells": {}}, []
    groups = {"all": None, "trade6": TRADE6}
    for c in sorted(set(cls.values())):
        groups[c] = [i for i in close.columns if cls[i] == c]
    for g, insts in groups.items():
        for lb in LOOKBACKS + (LOOKBACKS,):
            lbn = "blend" if isinstance(lb, tuple) else str(lb)
            pr, W = port_returns(close, lb, insts, sp)
            for wn, (a, b) in windows.items():
                x = pr.loc[a:b]
                cell = summarize(x["gross"], x["net"], spx)
                cell["n_eligible_mean"] = float(x["n"].mean())
                cell["yearly_gross"] = {int(k): float(v) for k, v in (1 + x["gross"]).groupby(x.index.year).prod().sub(1).items()}
                cell["cost_spread_ann"] = float(x["cost_spread"].mean() * ANN)
                cell["cost_fin_ann"] = float(x["cost_fin"].mean() * ANN)
                key = f"{g}|lb{lbn}|{wn}"
                res["cells"][key] = cell
                primary = g == "all" and lb == PRIMARY_LB
                trials.append({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "exp": EXP, "unit": g, "tf": "D",
                               "cell": f"lb{lbn}", "window": wn, "primary": primary, "n": cell["days"],
                               "sharpe": cell["sharpe"], "sharpe_ci": cell["sharpe_ci"], "net_sharpe": cell["net_sharpe"],
                               "ann_ret": cell["ann_ret"], "ann_vol": cell["ann_vol"], "mde80_sharpe": cell["mde80_sharpe"]})
                print(key, round(cell["sharpe"], 3), [round(v, 3) for v in cell["sharpe_ci"]], round(cell["net_sharpe"], 3), flush=True)
            if g == "all" and lb == PRIMARY_LB:
                pr.to_csv(os.path.join(OUT, "primary_daily.csv"))
    # buy-and-hold SPX500 reference
    for wn, (a, b) in windows.items():
        s = spx.loc[a:b]
        res["cells"][f"spx_bh|{wn}"] = {"sharpe": sharpe(s), "ann_ret": float(s.mean() * ANN), "maxdd": maxdd(s)}
    pv = [res["cells"][f"all|lb{PRIMARY_LB}|{w}"]["sharpe_ci"][0] > 0 for w in windows]
    res["verdict"] = "PASS" if all(pv) else "FAIL"
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1)
    with open(os.path.join(ENG, "trials.jsonl"), "a") as f:
        for t in trials:
            f.write(json.dumps(t) + "\n")
    print("verdict", res["verdict"])


if __name__ == "__main__":
    {"check": check, "describe": describe, "register": register, "run": run}[sys.argv[1]]()
