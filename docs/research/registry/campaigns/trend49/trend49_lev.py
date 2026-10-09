"""trend49 amendment 2: leverage and margin close-out simulation. Descriptive, hindsight-selected episodes, not a test.
CFD cost version only. trend49.py is imported unchanged (rules, timing, spreads, T-bill basis, episodes).

  python trend49_lev.py check       synthetic fixtures (close-out threshold, gap fill, sizing, no lookahead)
  python trend49_lev.py register    write amendment2.json with this file's sha256 (refuses to overwrite)
  python trend49_lev.py run         out/lev.json, out/lev_tables.md, trials.jsonl rows (posthoc true)
"""
import os, sys, json, time, sqlite3
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import trend49 as E  # noqa: E402

T = E.T
LEVS = ["1x", "3x", "10x", "VT20"]
VT, RV_N = 0.20, 20
CLOSEOUT = 0.5            # positions closed when equity <= 50% of required margin
ESMA_CAP = {"XAU_USD": 20, "NAS100_USD": 20, "SPX500_USD": 20, "XAG_USD": 10, "WTICO_USD": 10, "NATGAS_USD": 10}
SPEC = {
    "label": "amendment 2, descriptive, hindsight-selected episodes, not a test; registered before any leveraged result was computed",
    "cost_version": "CFD only: half median spread per side on every unit change (entry, exit, resize, close-out, window end); "
                    "financing on full notional |units| x close per calendar day to the next bar, long basis+2.5%, short 2.5%-basis",
    "leverage": {"1x/3x/10x": "at each entry or direction change, units = L x equity at the fill / open price; units held fixed until the next change",
                 "VT20": "daily resize at the open to min(20% / rv20, ESMA cap) x equity; rv20 = std of the last 20 close-to-close returns up to the previous close, x sqrt(261); no position until 20 returns exist"},
    "esma_cap": ESMA_CAP,
    "margin": "required margin = |units| x price / ESMA cap; close-out when equity <= 50% of required margin. Checked at the open (old position, fill at the open) "
              "and intraday on the low (long) or high (short), fill at the threshold price; equity floored at 0 (negative balance protection)",
    "reentry": {"with": "after a close-out the rule re-enters only when its target changes to a new non-zero direction and equity > 0; BH has no new signal and stays flat",
                "without": "after the first close-out the account stays flat to the end of the run"},
    "runs": "each window and each episode leg is a fresh account with equity 1 at the first bar's open; window end charges the exit spread",
    "episodes": "amendment 1 leg dates from out/episodes_amended.json: entry at the open of the bar after the leg start close, end at the leg extreme close",
    "basis": "FRED DTB3 annual averages from out/DTB3.csv (public CSV fetched 2026-10-09, 2017-01-03..2026-10-07); trend49.TBILL for earlier years",
    "metrics": "final equity multiple, CAGR (261 bars/yr), max drawdown of daily close equity, close-outs, financing paid (sum, % of starting equity); per episode equity multiple (operator window dates)",
}


def load(inst):
    db = sqlite3.connect(f"file:{T.DB}?mode=ro", uri=True)
    d = pd.read_sql("SELECT time, o, h, l, c FROM daily WHERE instrument=? ORDER BY time", db, params=(inst,))
    d["date"] = (pd.to_datetime(d["time"]) + pd.Timedelta(days=1)).dt.normalize()
    d = d[d["date"].dt.dayofweek < 5].drop_duplicates("date", keep="last").set_index("date")
    return d[["o", "h", "l", "c"]].astype(float)


def fred_basis():
    f = pd.read_csv(os.path.join(E.OUT, "DTB3.csv"), na_values=".").dropna()
    y = f.groupby(f["observation_date"].str[:4].astype(int))["DTB3"].mean()
    return {**E.TBILL, **{int(k): round(float(v), 2) for k, v in y.items()}}


def simulate(d, rule, lev, cap, side, a, b, reentry=True, basis=E.TBILL):
    tgt = E.target(d["c"], rule).values
    rv = (d["c"].pct_change().rolling(RV_N).std() * np.sqrt(T.ANN)).values
    idx = d.index
    j0, j1 = idx.searchsorted(pd.Timestamp(a)), idx.searchsorted(pd.Timestamp(b), side="right")
    O, H, L, C = (d[k].values for k in "ohlc")
    eq, u, ref, fin_paid, co, blocked, dead = 1.0, 0.0, 0.0, 0.0, 0, None, False
    path = []

    def closeout(fill):
        nonlocal eq, u, co, blocked, dead
        eq += u * (fill - ref) - abs(u) * fill * side
        blocked, dead = np.sign(u), not reentry
        u, co = 0.0, co + 1
        eq = max(eq, 0.0)

    for j in range(j0, j1):
        o, h, l, c = O[j], H[j], L[j], C[j]
        if u != 0 and eq + u * (o - ref) <= CLOSEOUT * abs(u) * o / cap:      # gap through the threshold: fill at the open
            closeout(o)
        elif u != 0:
            eq += u * (o - ref)
        ref = o
        want = tgt[j - 1] if j > 0 else 0.0
        if blocked is not None and want != blocked:                         # any change of target is a new signal
            blocked = None
        d_ = 0.0 if (dead or blocked is not None or eq <= 0) else want
        if lev == "VT20":
            lv = min(VT / rv[j - 1], cap) if j > 0 and np.isfinite(rv[j - 1]) and rv[j - 1] > 0 else 0.0
            nu = d_ * lv * eq / o
        else:
            nu = u if np.sign(u) == d_ else d_ * float(lev[:-1]) * eq / o
        eq -= abs(nu - u) * o * side
        u = nu
        if u > 0:
            p = (u * ref - eq) / (u * (1 - CLOSEOUT / cap))
            if l <= p:
                closeout(p)
        elif u < 0:
            q = -u
            p = (eq + q * ref) / (q * (1 + CLOSEOUT / cap))
            if h >= p:
                closeout(p)
        if u != 0:
            eq += u * (c - ref)
            ref = c
            days = (idx[j + 1] - idx[j]).days if j + 1 < len(idx) else 1
            bb = basis[idx[j].year] / 100
            fin = abs(u) * c * (bb + E.MARKUP if u > 0 else E.MARKUP - bb) * days / 365
            eq -= fin
            fin_paid += fin
        eq = max(eq, 0.0)
        path.append(eq)
    eq = max(eq - abs(u) * C[j1 - 1] * side, 0.0)
    path[-1] = eq
    p = np.array(path)
    n = len(p)
    return {"mult": float(eq), "cagr": float(eq ** (T.ANN / n) - 1) if eq > 0 else -1.0,
            "maxdd": float((p / np.maximum.accumulate(np.r_[1.0, p])[1:] - 1).min()),
            "closeouts": co, "fin_pct": float(100 * fin_paid), "days": n}


def check():
    idx = pd.bdate_range("2020-01-01", periods=300)
    flat = pd.DataFrame({"o": 100.0, "h": 100.0, "l": 100.0, "c": 100.0}, index=idx)
    z = {y: 0.0 for y in E.TBILL}
    r = simulate(flat, "BH", "1x", 20, 0.0, "2020-01-01", "2030-01-01", basis=z)
    assert abs(r["mult"] - (1 - sum((idx[k + 1] - idx[k]).days for k in range(1, 299)) / 365 * 0.025 - 0.025 / 365)) < 1e-9
    # close-out at the threshold: 10x on cap 10 -> equity at fill = 50% of margin
    dd = flat.copy()
    dd.iloc[150, dd.columns.get_loc("l")] = 90.0
    r = simulate(dd, "BH", "10x", 10, 0.0, "2020-01-01", "2030-01-01", basis={y: -2.5 for y in E.TBILL})
    p = (0.1 * 100 - 1) / (0.1 * 0.95)
    assert r["closeouts"] == 1 and abs(r["mult"] - 0.5 * 0.1 * p / 10) < 1e-9, r
    r2 = simulate(dd, "BH", "3x", 10, 0.0, "2020-01-01", "2030-01-01", basis={y: -2.5 for y in E.TBILL})
    assert r2["closeouts"] == 0 and abs(r2["mult"] - 1) < 1e-9
    # gap through the threshold fills at the open
    dg = flat.copy()
    dg.iloc[150:, :] = 80.0
    r3 = simulate(dg, "BH", "10x", 10, 0.0, "2020-01-01", "2030-01-01", basis={y: -2.5 for y in E.TBILL})
    assert r3["closeouts"] == 1 and r3["mult"] == 0.0
    # short close-out on the high
    up = flat.copy()
    up.iloc[:260, :] = np.linspace(150, 100, 260)[:, None]
    up.iloc[280, up.columns.get_loc("h")] = 120.0
    rs = simulate(up, "TS12", "10x", 10, 0.0, "2020-12-01", "2030-01-01", basis={y: 2.5 for y in E.TBILL})
    assert rs["closeouts"] == 1, rs
    # no lookahead: changing prices after a date leaves the path up to it unchanged
    rng = np.random.default_rng(1)
    cc = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, 600)))
    i2 = pd.bdate_range("2018-01-01", periods=600)
    dr = pd.DataFrame({"o": cc, "h": cc * 1.005, "l": cc * 0.995, "c": cc}, index=i2)
    dr2 = dr.copy(); dr2.iloc[500:] *= 2
    for lv in LEVS:
        a1 = simulate(dr, "TS6", lv, 20, 1e-4, "2019-01-01", str(i2[499].date()))
        a2 = simulate(dr2, "TS6", lv, 20, 1e-4, "2019-01-01", str(i2[499].date()))
        assert a1 == a2, lv
    print("check ok")


def register():
    f = os.path.join(HERE, "amendment2.json")
    if os.path.exists(f):
        sys.exit("amendment2.json exists")
    body = {"created": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "exp": E.EXP,
            "code_sha256": {"trend49_lev.py": T.sha(os.path.abspath(__file__)), "trend49.py": T.sha(os.path.join(HERE, "trend49.py"))},
            "basis_values": fred_basis(),
            "before_registration": "The registered trend49 run and amendment 1 (post-output episode legs, trend49_amend.py) were already computed and posted. "
                                   "No leveraged or margin result was computed before this file. Only the synthetic check ran.",
            **SPEC}
    json.dump(body, open(f, "w"), indent=1)
    print("registered", f)


def run():
    sp = T.spreads_bps()
    basis = fred_basis()
    legs = json.load(open(os.path.join(E.OUT, "episodes_amended.json")))
    res = {"label": SPEC["label"], "basis": basis, "cells": {}, "episodes": {}}
    trials, ts = [], time.strftime("%Y-%m-%dT%H:%M:%S")
    for i in E.INSTS:
        d = load(i)
        side = sp[i]["median_spread_bps"] / 2 / 1e4
        cap = ESMA_CAP[i]
        for rule in E.RULES:
            for lv in LEVS:
                for re_ in (True, False):
                    for wn, (a, b) in E.WINDOWS.items():
                        r = simulate(d, rule, lv, cap, side, a, b, re_, basis)
                        res["cells"][f"{i}|{rule}|{lv}|{wn}|{'re' if re_ else 'nore'}"] = r
                        trials.append({"ts": ts, "exp": E.EXP, "posthoc": True, "descriptive": True, "amendment": 1, "inst": i,
                                       "tf": "D", "cell": f"{rule}|{lv}|{'re' if re_ else 'nore'}", "window": wn, **r})
                    for name, ei, _, _ in E.EPISODES:
                        if ei == i:
                            lg = legs[name]["BH"]
                            a = d.index[d.index.searchsorted(pd.Timestamp(lg["leg_start"]), side="right")]
                            res["episodes"][f"{name}|{rule}|{lv}|{'re' if re_ else 'nore'}"] = simulate(d, rule, lv, cap, side, a, lg["leg_end"], re_, basis)
    json.dump(res, open(os.path.join(E.OUT, "lev.json"), "w"), indent=1)
    with open(os.path.join(E.ENG, "trials.jsonl"), "a") as fh:
        for t in trials:
            fh.write(json.dumps(t) + "\n")
    m = lambda x: f"{x:.2f}" if x < 10 else f"{x:.1f}"
    Lines = []
    for wn in E.WINDOWS:
        Lines += [f"\n### {wn}, with re-entry: equity multiple / CAGR / max DD / close-outs / financing paid (% of start)\n",
                  "| inst | rule | 1x | 3x | 10x | VT20 |", "|---|---|---|---|---|---|"]
        for i in E.INSTS:
            for rule in E.RULES:
                cells = []
                for lv in LEVS:
                    r = res["cells"][f"{i}|{rule}|{lv}|{wn}|re"]
                    cells.append(f"{m(r['mult'])} / {100 * r['cagr']:+.0f}% / {100 * r['maxdd']:.0f}% / {r['closeouts']} / {r['fin_pct']:.0f}%")
                Lines.append(f"| {i} | {rule} | " + " | ".join(cells) + " |")
        Lines += [f"\n### {wn}, cells where no re-entry changes the result: multiple with re-entry -> without\n"]
        diff = []
        for i in E.INSTS:
            for rule in E.RULES:
                for lv in LEVS:
                    a1, a2 = res["cells"][f"{i}|{rule}|{lv}|{wn}|re"], res["cells"][f"{i}|{rule}|{lv}|{wn}|nore"]
                    if abs(a1["mult"] - a2["mult"]) > 1e-9:
                        diff.append(f"{i} {rule} {lv}: {m(a1['mult'])} -> {m(a2['mult'])}")
        Lines.append("; ".join(diff) if diff else "none")
    Lines += ["\n### Episode legs (amendment 1 dates, fresh account at the leg start, with re-entry): equity multiple, close-outs in brackets\n",
              "| episode | rule | 1x | 3x | 10x | VT20 | 10x without re-entry |", "|---|---|---|---|---|---|---|"]
    for name, ei, a, b in E.EPISODES:
        for rule in E.RULES:
            cs = [res["episodes"][f"{name}|{rule}|{lv}|re"] for lv in LEVS]
            nr = res["episodes"][f"{name}|{rule}|10x|nore"]
            Lines.append(f"| {name} | {rule} | " + " | ".join(f"{m(x['mult'])} ({x['closeouts']})" for x in cs) + f" | {m(nr['mult'])} ({nr['closeouts']}) |")
    open(os.path.join(E.OUT, "lev_tables.md"), "w").write("\n".join(Lines) + "\n")
    print("\n".join(Lines))
    print(f"\n{len(trials)} trial rows appended")


if __name__ == "__main__":
    {"check": check, "register": register, "run": run}[sys.argv[1]]()
