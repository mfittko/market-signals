"""flow29: does aggressor-side volume imbalance over the last 1 or 3 candles predict WTI direction?

Subcommands:
  bars        raw/*.dbn.zst (Databento GLBX.MDP3 trades, CL.v.0) -> out/bars_m1.parquet (no outcomes)
  selfcheck   synthetic checks of the statistic (no market data)
  run         primary + secondary tests -> out/results.json, trials.jsonl rows

Side convention (databento_dbn Side enum): 'B' = buy aggressor, 'A' = sell aggressor, 'N' = no side.
Signed volume = B size - A size. 'N' volume counts in total volume only in the 'vol_all' column; the
imbalance denominator is B + A (the prereg: 'N' excluded).
"""
import glob
import hashlib
import json
import os
import sqlite3
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ENGINE)
import validate  # noqa: E402  (day_of 22:00 UTC rollover, day_boot, log_trial)

OUT = os.path.join(HERE, "out")
HISTORY = os.path.join(os.path.dirname(ENGINE), "history.db")
KS, N_PRIMARY, NS_SECONDARY = (1, 3), 6, (3, 12)
Q, LOOKBACK_DAYS, GAP_MIN = 0.95, 20, 60
REPS, BLOCK, SEED = 1000, 5, 29
ALPHA, MIN_PP = 0.05, 0.03
ABSORB_ATR, ATR_N = 0.25, 10
Z_MDE = 2.2414 + 0.8416  # two-sided alpha 0.025 (Holm first step) + 80% power


# ---------- bars ----------
def build_m1():
    import databento as db
    parts, counts = [], {"trades": 0, "B": 0, "A": 0, "N": 0}
    for path in sorted(glob.glob(os.path.join(HERE, "raw", "*.dbn.zst"))):
        df = db.DBNStore.from_file(path).to_df(price_type="float", pretty_ts=False, map_symbols=False)
        df = df.reset_index()
        t = df["ts_event"].to_numpy(np.int64) // 60_000_000_000  # UTC minutes
        side = df["side"].astype(str).to_numpy()
        size = df["size"].to_numpy(np.int64)
        counts["trades"] += len(df)
        for s in "BAN":
            counts[s] += int((side == s).sum())
        g = pd.DataFrame({"tmin": t, "p": df["price"].to_numpy(float), "size": size,
                          "buy": np.where(side == "B", size, 0), "sell": np.where(side == "A", size, 0),
                          "iid": df["instrument_id"].to_numpy(np.int64)})
        parts.append(g.groupby("tmin", sort=True).agg(
            o=("p", "first"), h=("p", "max"), l=("p", "min"), c=("p", "last"), vol_all=("size", "sum"),
            buy=("buy", "sum"), sell=("sell", "sum"), iid=("iid", "last"), iid_n=("iid", "nunique")))
    m1 = pd.concat(parts)
    m1 = m1[~m1.index.duplicated(keep="first")].sort_index().reset_index()
    os.makedirs(OUT, exist_ok=True)
    m1.to_parquet(os.path.join(OUT, "bars_m1.parquet"))
    with open(os.path.join(OUT, "bars_summary.json"), "w") as f:
        json.dump({**counts, "m1_bars": len(m1), "first": int(m1.tmin.iloc[0]), "last": int(m1.tmin.iloc[-1]),
                   "instrument_ids": sorted(int(x) for x in m1.iid.unique())}, f, indent=1)
    print(json.dumps(counts))


def grid(m1, tf):
    """Full tf-minute grid. Empty bars: volume 0, close forward-filled. A bar is 'open' unless it lies in a
    run of bars without trades spanning >= GAP_MIN minutes (session breaks, weekends)."""
    b = m1.assign(g=m1.tmin // tf * tf).groupby("g").agg(
        o=("o", "first"), h=("h", "max"), l=("l", "min"), c=("c", "last"), buy=("buy", "sum"),
        sell=("sell", "sum"), vol_all=("vol_all", "sum"), iid=("iid", "last"), iid_n=("iid_n", "max"),
        iid_first=("iid", "first"))
    b.loc[b.iid_first != b.iid, "iid_n"] = 2
    full = np.arange(b.index[0], b.index[-1] + tf, tf)
    b = b.reindex(full)
    has = b.c.notna().to_numpy()
    b["c"] = b.c.ffill()
    for col in ("o", "h", "l"):
        b[col] = b[col].fillna(b.c)
    for col in ("buy", "sell", "vol_all"):
        b[col] = b[col].fillna(0)
    b["iid"] = b.iid.ffill()
    b["iid"] = np.where(b.iid_n.fillna(1).to_numpy() > 1, -1, b.iid.to_numpy())  # mixed-contract bar
    # closed runs: empty stretches of >= GAP_MIN minutes
    run_id = np.cumsum(has)
    empty_len = pd.Series(~has).groupby(run_id).transform("sum").to_numpy()
    b["open"] = has | (empty_len * tf < GAP_MIN)
    b["tmin"] = b.index.to_numpy(np.int64)
    b["day"] = validate.day_of(b.tmin.to_numpy())
    return b.reset_index(drop=True)


def wilder_atr(b, n=ATR_N):
    c = b.c.to_numpy(); h = b.h.to_numpy(); l = b.l.to_numpy(); iid = b.iid.to_numpy()
    pc = np.r_[c[0], c[:-1]]
    tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
    reset = np.r_[True, iid[1:] != iid[:-1]]
    tr[reset] = (h - l)[reset]  # no true range across a contract roll
    atr = np.empty_like(tr); atr[0] = tr[0]
    for i in range(1, len(tr)):
        atr[i] = atr[i - 1] + (tr[i] - atr[i - 1]) / n
    return atr


def window_ok(open_, iid, a, z):
    """ok[t] iff bars t+a..t+z (a <= 0 <= z) are open and share one valid contract id."""
    n = len(open_); ok = np.ones(n, bool)
    for j in range(a, z + 1):
        idx = np.arange(n) + j
        inb = (idx >= 0) & (idx < n)
        cl = np.clip(idx, 0, n - 1)
        ok &= inb & open_[cl] & (iid[cl] == iid) & (iid >= 0)
    return ok


def imbalance(b, k):
    s = (b.buy - b.sell).to_numpy(float); v = (b.buy + b.sell).to_numpy(float)
    cs, cv = np.r_[0, np.cumsum(s)], np.r_[0, np.cumsum(v)]
    n = len(s); t = np.arange(n); lo = np.clip(t - k + 1, 0, None)
    ss, vv = cs[t + 1] - cs[lo], cv[t + 1] - cv[lo]
    ok = window_ok(b.open.to_numpy(), b.iid.to_numpy(), -(k - 1), 0) & (vv > 0) & (t >= k - 1)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(ok, ss / vv, np.nan)


def thresholds(day, absI):
    """Per bar: 95th percentile of |I| over the previous LOOKBACK_DAYS trading days (days with valid |I|).
    NaN for bars in the first LOOKBACK_DAYS trading days."""
    valid = np.isfinite(absI)
    days = np.unique(day[valid]); thr_by_day = {}
    by = {d: absI[valid & (day == d)] for d in days}
    for i, d in enumerate(days):
        if i >= LOOKBACK_DAYS:
            thr_by_day[d] = np.quantile(np.concatenate([by[x] for x in days[i - LOOKBACK_DAYS:i]]), Q)
    return np.array([thr_by_day.get(d, np.nan) for d in day]), (days[LOOKBACK_DAYS] if len(days) > LOOKBACK_DAYS else None)


def frame(b, k, n, atr=None):
    """Rows = bars t with a valid outcome window (t..t+n open, one contract), after the first 20 days."""
    I = imbalance(b, k)
    thr, first_day = thresholds(b.day.to_numpy(), np.abs(I))
    c = b.c.to_numpy(); N = len(c)
    out_ok = window_ok(b.open.to_numpy(), b.iid.to_numpy(), 0, n)
    t = np.arange(N); cl = np.clip(t + n, 0, N - 1)
    move = np.where(out_ok, c[cl] - c, np.nan)
    keep = out_ok & (move != 0) & (b.day.to_numpy() >= (first_day if first_day is not None else np.inf))
    ev = keep & np.isfinite(I) & np.isfinite(thr) & (np.abs(I) >= thr) & (I != 0)
    f = pd.DataFrame({"t": t, "tmin": b.tmin.to_numpy(), "day": b.day.to_numpy(), "move": move, "I": I,
                      "thr": thr, "event": ev})[keep].reset_index(drop=True)
    f["up"] = f.move > 0
    f["s"] = np.sign(f.I.fillna(0)).astype(int)
    f["cont"] = np.where(f.event, np.sign(f.move) == f.s, False)
    if atr is not None:
        a = atr[f.t.to_numpy()]
        f["atr"] = np.where(a > 0, a, np.nan)
    return f


def stat_fn(up, event, s, cont):
    def stat(idx):
        p_up = up[idx].mean()
        e = idx[event[idx]]
        if len(e) == 0:
            return np.nan
        base = np.where(s[e] > 0, p_up, 1 - p_up)
        return float((cont[e] - base).mean())
    return stat


def test(f, reps=REPS):
    up, ev, s, cont = f.up.to_numpy(), f.event.to_numpy(), f.s.to_numpy(), f.cont.to_numpy().astype(float)
    stat = stat_fn(up, ev, s, cont)
    est = stat(np.arange(len(f)))
    boot = validate.day_boot(f.day.to_numpy(), f.day.to_numpy(), stat, reps=reps, block=BLOCK, seed=SEED)
    boot = boot[np.isfinite(boot)]
    p = max(2 * min((boot <= 0).mean(), (boot >= 0).mean()), 1 / len(boot))
    p_up = up.mean()
    return {"n_bars": int(len(f)), "n_events": int(ev.sum()), "n_buy_ev": int((ev & (s > 0)).sum()),
            "n_sell_ev": int((ev & (s < 0)).sum()), "p_cont": float(cont[ev].mean()) if ev.any() else None,
            "baseline": float(np.where(s[ev] > 0, p_up, 1 - p_up).mean()) if ev.any() else None,
            "p_up_all": float(p_up), "diff": est, "ci95": validate.ci(boot), "se": float(boot.std()),
            "mde80": float(Z_MDE * boot.std()), "p_boot": float(p), "n_days": int(len(np.unique(f.day)))}


def holm(ps):
    order = np.argsort(ps); m = len(ps); adj = np.empty(m); run = 0.0
    for r, i in enumerate(order):
        run = max(run, min(1.0, (m - r) * ps[i])); adj[i] = run
    return adj


def verdict(rows):
    adj = holm(np.array([r["p_boot"] for r in rows]))
    passes = []
    for r, a in zip(rows, adj):
        r["p_holm"] = float(a)
        r["pass"] = bool(a < ALPHA and abs(r["diff"]) >= MIN_PP)
        if r["pass"]:
            passes.append("CONTINUATION" if r["diff"] > 0 else "REVERSAL")
    return ("PASS " + "/".join(sorted(set(passes)))) if passes else "FAIL"


# ---------- secondary helpers ----------
def oanda_m5(t0, t1, tf):
    con = sqlite3.connect(f"file:{HISTORY}?mode=ro", uri=True)
    q = ("select time, close from candles where instrument='WTICO/USD' and granularity='M1' "
         "and time >= ? and time < ? order by time")
    s = lambda m: pd.Timestamp(int(m) * 60, unit="s", tz="UTC").strftime("%Y-%m-%dT%H:%M")
    d = pd.read_sql(q, con, params=(s(t0), s(t1)))
    con.close()
    tm = d.time.str[:16].to_numpy().astype("datetime64[m]").astype(np.int64)  # UTC minutes, unit-safe
    return pd.Series(d.close.to_numpy(float), index=tm).groupby(tm // tf * tf).last()


def oanda_rows(f, n, tf, oc):
    a = oc.reindex(f.tmin.to_numpy()).to_numpy(); z = oc.reindex(f.tmin.to_numpy() + n * tf).to_numpy()
    mv = z - a
    g = f.assign(move=mv)[np.isfinite(mv) & (mv != 0)].reset_index(drop=True)
    g["up"] = g.move > 0
    g["cont"] = np.where(g.event, np.sign(g.move) == g.s, False)
    return g


# ---------- self-check (synthetic only) ----------
def selfcheck():
    rng = np.random.default_rng(1)
    days, per = 60, 276
    n = days * per
    tmin = (np.arange(n) // per) * 1440 + (np.arange(n) % per) * 5 + 22 * 60 - 1440 * 0
    buy = rng.integers(1, 50, n).astype(float); sell = rng.integers(1, 50, n).astype(float)
    I = (buy - sell) / (buy + sell)

    def mk(beta):
        nxt = np.r_[0, I[:-1]]  # bar t's imbalance shifts bar t+1's return
        c = 70 + np.cumsum(rng.normal(0, 0.02, n) + beta * nxt)
        m1 = pd.DataFrame({"tmin": tmin, "o": c, "h": c, "l": c, "c": c, "vol_all": buy + sell, "buy": buy,
                           "sell": sell, "iid": 1, "iid_n": 1})
        return grid(m1, 5)

    r0 = test(frame(mk(0.0), 1, 6), reps=200)
    r1 = test(frame(mk(0.05), 1, 6), reps=200)
    rr = test(frame(mk(-0.05), 1, 6), reps=200)
    print("null", round(r0["diff"], 3), r0["ci95"], "planted", round(r1["diff"], 3), "reversal", round(rr["diff"], 3))
    assert abs(r0["diff"]) < 0.05 and r0["ci95"][0] < 0 < r0["ci95"][1]
    assert r1["diff"] > 0.1 and r1["ci95"][0] > 0
    assert rr["diff"] < -0.1 and rr["ci95"][1] < 0
    # roll guard: a contract change inside the outcome window drops the row
    b = mk(0.0); b.loc[100:, "iid"] = 2
    f = frame(b, 1, 6)
    assert not f.t.between(94, 99).any()
    assert list(holm(np.array([0.01, 0.04]))) == [0.02, 0.04]
    print("selfcheck ok")


# ---------- run ----------
def run():
    m1 = pd.read_parquet(os.path.join(OUT, "bars_m1.parquet"))
    res = {"primary": {}, "secondary": {}}
    b5 = grid(m1, 5); atr5 = wilder_atr(b5)
    rows = []
    for k in KS:
        r = test(frame(b5, k, N_PRIMARY))
        r["k"] = k; rows.append(r)
    res["verdict"] = verdict(rows)
    res["primary"] = {f"k{r['k']}": r for r in rows}
    sec = res["secondary"]
    for k in KS:
        for n in NS_SECONDARY:
            sec[f"M5_k{k}_N{n}"] = test(frame(b5, k, n))
    b1 = grid(m1, 1)
    for k in KS:
        sec[f"M1_k{k}_N6"] = test(frame(b1, k, 6))
    oc = oanda_m5(int(b5.tmin.iloc[0]), int(b5.tmin.iloc[-1]) + 60, 5)
    c5 = b5.c.to_numpy()
    for k in KS:
        f = frame(b5, k, N_PRIMARY, atr5)
        # absorption: price over the k imbalance bars moved < 0.25 ATR in the flow direction (or against it)
        t = f.t.to_numpy(); prior = c5[np.clip(t - k, 0, None)]
        okp = window_ok(b5.open.to_numpy(), b5.iid.to_numpy(), -k, 0)[t]
        flow_move = f.s.to_numpy() * (c5[t] - prior)
        absorbed = f.event.to_numpy() & okp & (flow_move < ABSORB_ATR * f.atr.to_numpy())
        pushed = f.event.to_numpy() & okp & ~absorbed
        p_up = f.up.mean()
        against = ~f.cont.to_numpy()
        base_against = np.where(f.s.to_numpy() > 0, 1 - p_up, p_up)
        ev = f.event.to_numpy()
        atr_move = f.s.to_numpy() * f.move.to_numpy() / f.atr.to_numpy()
        drift = (f.move / f.atr).mean()
        ab = test(f.assign(event=absorbed))
        sec[f"absorb_k{k}"] = {
            "n_absorbed": int(absorbed.sum()), "n_pushed": int(pushed.sum()),
            "p_against_absorbed": float(against[absorbed].mean()) if absorbed.any() else None,
            "base_against_absorbed": float(base_against[absorbed].mean()) if absorbed.any() else None,
            "p_against_pushed": float(against[pushed].mean()) if pushed.any() else None,
            "base_against_pushed": float(base_against[pushed].mean()) if pushed.any() else None,
            "absorbed_cont_minus_base": ab["diff"], "absorbed_ci95": ab["ci95"]}
        sec[f"atr_move_k{k}"] = {"mean_flow_signed_atr": float(np.nanmean(atr_move[ev])),
                                 "drift_adj": float(np.nanmean(atr_move[ev] - f.s.to_numpy()[ev] * drift)),
                                 "buy_ev": float(np.nanmean(atr_move[ev & (f.s.to_numpy() > 0)])),
                                 "sell_ev": float(np.nanmean(atr_move[ev & (f.s.to_numpy() < 0)]))}
        g = oanda_rows(f, N_PRIMARY, 5, oc)
        sec[f"oanda_k{k}_N6"] = test(g)
        # by direction (descriptive)
        for nm, m in (("buy", f.s > 0), ("sell", f.s < 0)):
            e = f.event & m
            sec[f"dir_k{k}_{nm}"] = {"n": int(e.sum()), "p_cont": float(f.cont[e].mean()),
                                     "base": float((p_up if nm == "buy" else 1 - p_up))}
        thr = f.thr[f.event]
        sec[f"thr_k{k}"] = {"median": float(thr.median()), "min": float(thr.min()), "max": float(thr.max()),
                            "share_events_absI_eq_1": float((f.I[f.event].abs() >= 1).mean())}
    res["bars"] = {"m5_open": int(b5.open.sum()), "m5_with_trades": int((b5.vol_all > 0).sum())}
    with open(os.path.join(OUT, "results.json"), "w") as fo:
        json.dump(res, fo, indent=1, default=float)
    sha = hashlib.sha256(open(__file__, "rb").read()).hexdigest()
    for r in rows:
        validate.log_trial({"exp": "flow29", "cell": f"M5|k{r['k']}|N6", "unit": "CL.v.0", "window": "2025-10..2026-10",
                            "decision": r["pass"], "role": "primary", **{x: r[x] for x in (
                                "n_events", "p_cont", "baseline", "diff", "ci95", "p_boot", "p_holm", "mde80")},
                            "flow29_sha256": sha})
    for key, r in sec.items():
        if "diff" in r:
            validate.log_trial({"exp": "flow29", "cell": key, "unit": "CL.v.0", "role": "secondary",
                                "decision": None, "n_events": r["n_events"], "diff": r["diff"], "ci95": r["ci95"],
                                "flow29_sha256": sha})
    validate.log_trial({"exp": "flow29", "cell": "DECISION", "unit": "CL.v.0", "tf": "M5", "decision": res["verdict"],
                        "flow29_sha256": sha})
    print(json.dumps({"verdict": res["verdict"], "primary": res["primary"]}, indent=1, default=float))


if __name__ == "__main__":
    {"bars": build_m1, "selfcheck": selfcheck, "run": run}[sys.argv[1]]()
