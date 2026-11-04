"""flow42: replicate flow29 (CL M5 aggressor imbalance reversal) on 2024-10-01 .. 2025-10-01, plus an
incremental test: does heavy flow add information beyond the same 3-bar price move?

Subcommands:
  bars        raw/*.dbn.zst -> out/bars_m1.parquet (flow29.build_m1, no outcomes)
  selfcheck   flow29 synthetic checks + H2 synthetic checks (no market data)
  run         H1, H2 and secondary -> out/results.json, out/f29_run_results.json, trials.jsonl rows

All bar building, imbalance, thresholds, outcome, OANDA alignment and bootstrap code is imported from
audit/flow29/flow29.py (unchanged). Only the H2 matching and the OANDA spread net are new here.
"""
import hashlib
import json
import os
import sqlite3
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
F29_DIR = os.path.join(os.path.dirname(HERE), "flow29")
sys.path.insert(0, F29_DIR)
import flow29 as f29  # noqa: E402
import validate  # noqa: E402  (on sys.path via flow29)

OUT = os.path.join(HERE, "out")
F29_BARS = os.path.join(F29_DIR, "out", "bars_m1.parquet")  # read-only
K, N = 3, 6
N_BINS, N_BINS_SEC = 10, 20
SEED = 42
YEARS = {"y2024": None, "y2025": F29_BARS}  # y2024 = 2024-10..2025-10 (new), y2025 = flow29's year


# ---------- reused trailing-quantile rule ----------
def trailing_q(day, x, q):
    """flow29.thresholds with its quantile set to q (same causal 20-trading-day rule)."""
    old = f29.Q
    try:
        f29.Q = q
        return f29.thresholds(day, x)[0]
    finally:
        f29.Q = old


# ---------- H2 frame ----------
def h2_frame(b, n_bins=N_BINS, n=N):
    atr = f29.wilder_atr(b)
    f = f29.frame(b, K, n, atr)
    c = b.c.to_numpy(); day = b.day.to_numpy()
    ok3 = f29.window_ok(b.open.to_numpy(), b.iid.to_numpy(), -K, 0)
    tt = np.arange(len(c))
    with np.errstate(invalid="ignore", divide="ignore"):
        x_all = np.where(ok3 & (atr > 0), (c - c[np.clip(tt - K, 0, None)]) / atr, np.nan)
    # fixed bins: trailing-20-day quantile edges of the signed 3-bar move (all valid bars, causal)
    edges = np.column_stack([trailing_q(day, x_all, j / n_bins) for j in range(1, n_bins)])
    bin_all = np.where(np.isfinite(x_all) & np.isfinite(edges).all(1), (x_all[:, None] >= edges).sum(1), -1)
    absI = np.abs(f29.imbalance(b, K))
    med_all = trailing_q(day, absI, 0.5)
    t = f.t.to_numpy()
    f["x"] = x_all[t]; f["bin"] = bin_all[t]
    f["hour"] = (f.tmin.to_numpy() // 60) % 24
    has = f.bin.to_numpy() >= 0
    f["heavy"] = f.event.to_numpy() & has
    f["ctrl"] = ~f.event.to_numpy() & has & np.isfinite(f.I.to_numpy()) & (np.abs(f.I.to_numpy()) < med_all[t])
    return f


def inc_test(f, reps=f29.REPS, seed=SEED):
    """D_inc = mean over heavy events of (continue - P(same direction | control bars in the same cell)),
    cell = (year, move bin, UTC hour). Heavy events with no control in their cell are dropped."""
    yr = f["yr"].to_numpy() if "yr" in f else np.zeros(len(f), int)
    cell = pd.factorize(pd.Series(yr).astype(str) + "|" + f.bin.astype(str) + "|" + f.hour.astype(str))[0]
    nc_cells = cell.max() + 1
    up = f.up.to_numpy().astype(float); heavy = f.heavy.to_numpy(); ctrl = f.ctrl.to_numpy()
    s = f.s.to_numpy(); cont = f.cont.to_numpy().astype(float)

    def stat(idx, detail=False):
        ci_ = idx[ctrl[idx]]
        n_c = np.bincount(cell[ci_], minlength=nc_cells)
        u_c = np.bincount(cell[ci_], weights=up[ci_], minlength=nc_cells)
        e = idx[heavy[idx]]
        e = e[n_c[cell[e]] > 0]
        if len(e) == 0:
            return np.nan
        rate = u_c[cell[e]] / n_c[cell[e]]
        base = np.where(s[e] > 0, rate, 1 - rate)
        d = float((cont[e] - base).mean())
        if detail:
            return d, len(e), float(cont[e].mean()), float(base.mean())
        return d

    d, n_matched, p_heavy, p_ctrl = stat(np.arange(len(f)), True)
    boot = validate.day_boot(f.day.to_numpy(), f.day.to_numpy(), stat, reps=reps, block=f29.BLOCK, seed=seed)
    boot = boot[np.isfinite(boot)]
    return {"n_heavy": int(heavy.sum()), "n_heavy_matched": n_matched, "n_ctrl": int(ctrl.sum()),
            "p_cont_heavy": p_heavy, "p_cont_ctrl_matched": p_ctrl, "d_inc": d, "ci95": validate.ci(boot),
            "se": float(boot.std()), "mde80": float(f29.Z_MDE * boot.std()), "n_days": int(len(np.unique(f.day)))}


# ---------- OANDA spread net (secondary) ----------
def oanda_ba(t0, t1, tf=5):
    con = sqlite3.connect(f"file:{f29.HISTORY}?mode=ro", uri=True)
    s = lambda m: pd.Timestamp(int(m) * 60, unit="s", tz="UTC").strftime("%Y-%m-%dT%H:%M")
    d = pd.read_sql("select time, bid_c, ask_c from candles_ba where instrument='WTICO/USD' and granularity='M1' "
                    "and time >= ? and time < ? order by time", con, params=(s(t0), s(t1)))
    con.close()
    tm = d.time.str[:16].to_numpy().astype("datetime64[m]").astype(np.int64)
    g = pd.DataFrame({"mid": (d.bid_c + d.ask_c).to_numpy() / 2, "sp": (d.ask_c - d.bid_c).to_numpy()}, index=tm)
    return g.groupby(tm // tf * tf).last()


def fade_net(f, ba, n=N, tf=5):
    e = f[f.event].reset_index(drop=True)
    a = ba.reindex(e.tmin.to_numpy()); z = ba.reindex(e.tmin.to_numpy() + n * tf)
    ok = np.isfinite(a.mid.to_numpy()) & np.isfinite(z.mid.to_numpy())
    s = e.s.to_numpy()[ok]; am = a.mid.to_numpy()[ok]; zm = z.mid.to_numpy()[ok]
    gross = -s * (zm - am)  # trade against the flow from bar close t to bar close t+n
    cost = (a.sp.to_numpy()[ok] + z.sp.to_numpy()[ok]) / 2  # half spread at entry + half at exit
    atr = e.atr.to_numpy()[ok]
    r = lambda v: float(np.nanmean(v))
    return {"n": int(ok.sum()), "gross_usd": r(gross), "spread_cost_usd": r(cost), "net_usd": r(gross - cost),
            "gross_bps": r(gross / am * 1e4), "net_bps": r((gross - cost) / am * 1e4),
            "gross_atr": r(gross / atr), "net_atr": r((gross - cost) / atr), "median_spread_usd": float(np.median(cost)),
            "hit_gross": float((gross > 0).mean()), "hit_net": float((gross - cost > 0).mean())}


# ---------- self-check (synthetic only) ----------
def synth(model, days=150, per=276, seed=3):
    """model 'price': flow pushes the bar's price, the next bars revert the 3-bar price move (flow adds nothing
    beyond price). model 'flow': same push, the reversal follows the 3-bar imbalance itself."""
    rng = np.random.default_rng(seed)
    n = days * per
    tmin = (np.arange(n) // per) * 1440 + (np.arange(n) % per) * 5
    buy = rng.integers(1, 50, n).astype(float); sell = rng.integers(1, 50, n).astype(float)
    I = (buy - sell) / (buy + sell)
    I3 = pd.Series(buy - sell).rolling(3).sum().fillna(0).to_numpy() / pd.Series(buy + sell).rolling(3).sum().bfill().to_numpy()
    eps = rng.normal(0, 0.02, n); c = np.empty(n); c[:4] = 70
    for t in range(4, n):
        rev = -0.12 * (c[t - 1] - c[t - 4]) if model == "price" else -0.004 * I3[t - 1] * (abs(I3[t - 1]) > 0.3)
        c[t] = c[t - 1] + 0.02 * I[t] + rev + eps[t]
    m1 = pd.DataFrame({"tmin": tmin, "o": c, "h": c, "l": c, "c": c, "vol_all": buy + sell, "buy": buy,
                       "sell": sell, "iid": 1, "iid_n": 1})
    return f29.grid(m1, 5)


def selfcheck():
    f29.selfcheck()
    b = synth("price")
    h1 = f29.test(f29.frame(b, K, N), reps=200)
    h2 = inc_test(h2_frame(b), reps=200)
    print("price-only model: H1 D", round(h1["diff"], 3), h1["ci95"], "| D_inc", round(h2["d_inc"], 3), h2["ci95"],
          "matched", h2["n_heavy_matched"], "/", h2["n_heavy"])
    assert h1["ci95"][1] < 0  # flow events reverse
    assert h2["ci95"][0] < 0 < h2["ci95"][1] and abs(h2["d_inc"]) < 0.03  # but not beyond the price move
    b = synth("flow")
    h2f = inc_test(h2_frame(b), reps=200)
    print("flow model: D_inc", round(h2f["d_inc"], 3), h2f["ci95"])
    assert h2f["ci95"][1] < 0
    # edges are causal: changing the last day's prices leaves earlier bins untouched
    b2 = b.copy(); last = b2.day == b2.day.max(); b2.loc[last, "c"] = b2.loc[last, "c"] * 1.5
    fa, fb = h2_frame(b), h2_frame(b2)
    keep = fa.day < fa.day.max() - 1
    assert (fa.bin[keep].to_numpy() == fb.bin[fb.day < fb.day.max() - 1].to_numpy()).all()
    print("flow42 selfcheck ok")


# ---------- bars / run ----------
def bars():
    f29.HERE, f29.OUT = HERE, OUT  # flow29.build_m1 reads HERE/raw and writes OUT
    f29.build_m1()


def run_f29_secondary():
    """flow29.run() unchanged on the new year's bars (its primary block reproduces H1 k=1/k=3; its secondary
    block gives N=3/12, M1, OANDA, absorption, ATR move, buy/sell). Output and trial rows are relabelled."""
    f29.OUT = OUT
    orig = validate.log_trial

    def relabel(rec, path=None):
        rec = dict(rec, exp="flow42", window="2024-10..2025-10", source="flow29.run")
        rec["f29_rule_decision"] = rec.pop("decision", None)
        rec["decision"] = None
        if rec.get("role") == "primary":
            rec["role"] = "flow29_rule_repeat"
        return orig(rec, path)

    validate.log_trial = relabel
    try:
        f29.run()
    finally:
        validate.log_trial = orig
    os.replace(os.path.join(OUT, "results.json"), os.path.join(OUT, "f29_run_results.json"))
    return json.load(open(os.path.join(OUT, "f29_run_results.json")))


def run():
    res = {"secondary": {}}
    sec = res["secondary"]
    f29r = run_f29_secondary()
    b5 = {}
    b5["y2024"] = f29.grid(pd.read_parquet(os.path.join(OUT, "bars_m1.parquet")), 5)
    b5["y2025"] = f29.grid(pd.read_parquet(F29_BARS), 5)
    # H1: flow29 k=3 test unchanged (same seed and bootstrap as flow29)
    h1 = f29r["primary"]["k3"]
    h1_pass = bool(h1["diff"] < 0 and h1["ci95"][1] < 0)
    res["H1"] = {**h1, "pass": h1_pass, "abs_ge_3pp": bool(abs(h1["diff"]) >= f29.MIN_PP)}
    # H2: incremental, per year and pooled
    fr = {}
    for y, b in b5.items():
        fr[y] = h2_frame(b).assign(yr=y)
        res.setdefault("H2", {})[y] = inc_test(fr[y])
    pooled = pd.concat([fr["y2024"], fr["y2025"]], ignore_index=True)
    res["H2"]["pooled"] = inc_test(pooled)
    h2p = res["H2"]["pooled"]
    res["H2"]["pass"] = bool(h2p["d_inc"] < 0 and h2p["ci95"][1] < 0
                             and res["H2"]["y2024"]["d_inc"] < 0 and res["H2"]["y2025"]["d_inc"] < 0)
    # secondary
    for y, b in b5.items():
        f = h2_frame(b, N_BINS_SEC).assign(yr=y)
        sec[f"H2_bins20_{y}"] = inc_test(f)
        fb = fr[y]
        sec[f"H2_x_mean_{y}"] = {"heavy_flow_signed_x": float((fb.s * fb.x)[fb.heavy].mean()),
                                 "heavy_share_in_extreme_bins": float(fb.bin[fb.heavy].isin([0, N_BINS - 1]).mean())}
        for n in (3, 12):
            sec[f"H2_N{n}_{y}"] = inc_test(h2_frame(b, N_BINS, n).assign(yr=y))
    for nm, side in (("buy", 1), ("sell", -1)):
        sec[f"H2_pooled_{nm}"] = inc_test(pooled.assign(heavy=pooled.heavy & (pooled.s == side)))
    b = b5["y2024"]; atr = f29.wilder_atr(b)
    ba = oanda_ba(int(b.tmin.iloc[0]), int(b.tmin.iloc[-1]) + 60)
    for k in (1, 3):
        sec[f"fade_net_oanda_k{k}"] = fade_net(f29.frame(b, k, N, atr), ba)
    res["f29_run_secondary"] = f29r["secondary"]
    res["f29_run_primary"] = f29r["primary"]
    res["bars"] = f29r["bars"]
    with open(os.path.join(OUT, "results.json"), "w") as fo:
        json.dump(res, fo, indent=1, default=float)
    sha = hashlib.sha256(open(__file__, "rb").read()).hexdigest()
    validate.log_trial({"exp": "flow42", "cell": "H1|M5|k3|N6", "unit": "CL.v.0", "window": "2024-10..2025-10",
                        "role": "primary", "decision": "PASS" if h1_pass else "FAIL",
                        **{x: h1[x] for x in ("n_events", "p_cont", "baseline", "diff", "ci95", "mde80")},
                        "flow42_sha256": sha})
    for key in ("y2024", "y2025", "pooled"):
        r = res["H2"][key]
        validate.log_trial({"exp": "flow42", "cell": f"H2|M5|k3|N6|{key}", "unit": "CL.v.0", "role": "primary",
                            "decision": ("PASS" if res["H2"]["pass"] else "FAIL") if key == "pooled" else None,
                            **{x: r[x] for x in ("n_heavy", "n_heavy_matched", "d_inc", "ci95", "mde80")},
                            "flow42_sha256": sha})
    for key, r in sec.items():
        if "d_inc" in r:
            validate.log_trial({"exp": "flow42", "cell": key, "unit": "CL.v.0", "role": "secondary", "decision": None,
                                "n_heavy_matched": r["n_heavy_matched"], "d_inc": r["d_inc"], "ci95": r["ci95"],
                                "flow42_sha256": sha})
    print(json.dumps({"H1": res["H1"], "H2": res["H2"]}, indent=1, default=float))


if __name__ == "__main__":
    {"bars": bars, "selfcheck": selfcheck, "run": run}[sys.argv[1]]()
