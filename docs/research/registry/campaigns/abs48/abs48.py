"""abs48: abs11 A1 big-day model rescored on the REMAINING move after the alert (assessment-time excursion, 5 min latency).

Reuses abs11 unchanged (imported): 30-min bars, features, T1, the walk-forward A1 LR and its rv/tod baselines.
Only the outcome, the frozen dev operating point and the metrics are new.

  python abs48.py check           synthetic self-checks
  python abs48.py run             -> out/<TAG>.json per instrument + out/pooled.json
"""
import os, sys, json, time, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
sys.path.insert(0, ENG)
sys.path.insert(0, os.path.join(ENG, "audit", "abs11"))
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import bars as BR  # noqa: E402
import de_v2 as de  # noqa: E402
import abs11 as A  # noqa: E402

EXP = "abs48"
LAT = 5                      # minutes notification latency
RATES = (2, 4)               # alerts per instrument per month; 2 is the registered operating point
SEED = 48
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"abs48.py": sha(os.path.join(HERE, "abs48.py")), "abs11.py": A.CODE["abs11.py"], "bars.py": A.CODE["bars.py"],
        "evaluator": de.CODE_SHA}


# ------------------------------------------------------------------ pure helpers (covered by `check`)
def suffix_ext(day, h, l):
    """Per M1 bar: max high / min low from this bar to the last bar of its session."""
    s = pd.DataFrame({"d": day[::-1], "h": h[::-1], "l": l[::-1]}).groupby("d")
    return s["h"].cummax().to_numpy()[::-1], s["l"].cummin().to_numpy()[::-1]


def remaining(t1, d1, o1, sh, sl, tq, dq, lat=LAT):
    """Entry = first M1 bar opening at or after tq + lat in the same session; M_rem % from its open to session end.
    Returns (entry index or -1, M_rem %, entry time); M_rem = 0 when no entry bar is left in the session."""
    e = np.searchsorted(t1, tq + lat, "left")
    ok = (e < len(t1)) & (d1[np.minimum(e, len(t1) - 1)] == dq)
    e = np.where(ok, e, -1); ee = np.maximum(e, 0)
    P = o1[ee]
    m = 100 * np.maximum(sh[ee] / P - 1, 1 - sl[ee] / P)
    return e, np.where(ok, m, 0.0), np.where(ok, t1[ee], np.nan)


def first_cross(t1, d1, h1, l1, O_by_day, T1):
    """Per session: end time (minutes) of the first M1 bar whose excursion from the session open reaches T1 (NaN if never)."""
    g = pd.DataFrame({"d": d1, "h": h1, "l": l1}).groupby("d")
    H = g["h"].cummax().to_numpy(); L = g["l"].cummin().to_numpy()
    O = O_by_day.reindex(d1).to_numpy()
    hit = 100 * np.maximum(H - O, O - L) / O >= T1
    return pd.Series(np.where(hit, t1 + 1.0, np.nan)).groupby(d1).min()


def check():
    # two sessions: day 0 bars at t=0..4, day 1 bars at t=1440..1442
    t1 = np.array([0, 1, 2, 3, 4, 1440, 1441, 1442]); d1 = (t1 + 120) // 1440
    o1 = np.array([100, 100, 101, 102, 100, 50, 50, 50.0]); h1 = o1 + np.array([0, 1, 5, 0, 0, 0, 1, 0.0]); l1 = o1 - np.array([0, 0, 0, 0, 3, 0, 0, 0.0])
    sh, sl = suffix_ext(d1, h1, l1)
    assert list(sh[:5]) == [106, 106, 106, 102, 100] and list(sl[:5]) == [97, 97, 97, 97, 97] and sh[5] == 51 and sl[7] == 50
    e, m, te = remaining(t1, d1, o1, sh, sl, np.array([0, 0, 3, 1440, 1440]), np.array([0, 0, 0, 1, 1]), lat=2)
    # tq=0 -> entry bar t=2 (o 101): max(106/101-1, 1-97/101); tq=3 -> t=5 not in session -> no entry
    assert e[0] == 2 and abs(m[0] - 100 * max(106 / 101 - 1, 1 - 97 / 101)) < 1e-12 and e[2] == -1 and m[2] == 0 and e[3] == 7 and m[3] == 0
    assert te[0] == 2 and np.isnan(te[2])
    fc = first_cross(t1, d1, h1, l1, pd.Series({0: 100.0, 1: 50.0}), 2.0)
    assert fc[0] == 3.0 and fc[1] == 1442.0  # day 0: bar t=2 high 106 (6% >= 2) ends at 3; day 1: bar 1441 high 51 (2%) ends at 1442
    print("abs48 self-check OK: suffix extremes, latency entry, remaining excursion, no-entry rows, first crossing")


# ------------------------------------------------------------------ per instrument
def m1_mid(inst, t_end):
    m = BR.load_m1(inst)
    k = m["t"] < t_end
    mid = lambda f: (m[f"bid_{f}"][k] + m[f"ask_{f}"][k]) / 2
    return m["t"][k].astype(np.int64), mid("o"), mid("h"), mid("l")


def rows(inst):
    reg = json.load(open(os.path.join(ENG, "audit", "abs11", "prereg.json")))
    T1, T2 = reg["thresholds"][inst]["T1"], reg["thresholds"][inst]["T2"]
    stress = A.stress_table()
    R, Vo, _, D = A.build(inst, T1, T2, stress)
    # abs11 A1 intraday population and walk-forward scores (same call as abs11.run; HGB not needed)
    m1 = R["valid"] & R["fin"] & (R["exc_so"] < T1)
    i1 = np.flatnonzero(m1)
    d1 = R["day"][i1]; y1 = R["yday"][i1]; X1 = R["X"][i1]
    inv = np.unique(d1, return_inverse=True)[1]; w1 = 1.0 / np.bincount(inv)[inv]
    P1, _ = A.walk(d1, X1, y1, w1, A.F_ALL, A.BASE, hgb=False)
    # open model (secondary): rows at 22:00 UTC
    yo = Vo["y"].to_numpy(); do = Vo.index.to_numpy(); Xo = Vo[A.F_OPEN].to_numpy()
    Po, _ = A.walk(do, Xo, yo, np.ones(len(yo)), A.F_OPEN, A.BASE_OPEN, hgb=False)
    # M1 remaining move after latency
    t_end = int(R["t"].max()) + A.STEP
    t, o, h, l = m1_mid(inst, t_end)
    dm = (t + 120) // 1440
    sh, sl = suffix_ext(dm, h, l)
    tq = R["tc"][i1].astype(np.int64)
    e, mrem, te = remaining(t, dm, o, sh, sl, tq, d1)
    exc_so = R["exc_so"][i1]
    fc = first_cross(t, dm, h, l, D.O, T1)
    tcross = fc.reindex(d1).to_numpy()
    to = (do * 1440 - 120).astype(np.int64)
    eo, mo, _ = remaining(t, dm, o, sh, sl, to, do)
    return dict(inst=inst, T1=T1, d=d1, tq=tq, te=te, yday=y1, exc_so=exc_so, mrem=mrem, noentry=e < 0,
                y_pri=(mrem >= T1 - exc_so).astype(int), y_half=(mrem >= T1 / 2).astype(int), tcross=tcross,
                lr=P1["lr"], base_rv=P1["base_rv"], base_tod=P1["base_tod"], moved=exc_so / T1,
                open=dict(d=do, y_pri=(mo >= T1).astype(int), y_half=(mo >= T1 / 2).astype(int), mrem=mo,
                          lr=Po["lr"], base_rv=Po["base_rv"], base_tod=Po["base_tod"]),
                sess=dict(days=D.index[D.valid].to_numpy(), big=(D.exc[D.valid] >= T1).to_numpy()),
                last_day=int(R["day"].max()))


SCORES = ("lr", "base_rv", "base_tod", "moved")


def windows(last_day):
    W = A.windows(last_day)
    return {"dev": W["dev"], "w2023": W["w2023"]}


def alerts(r, rate, W):
    """Frozen threshold: rate x dev months-th largest per-session max score on dev 2019-2022; first row per session >= thr."""
    p = np.where(np.isfinite(r["lr"]), r["lr"], -1.0)
    lo, hi = W["dev"]; m = (r["d"] >= lo) & (r["d"] < hi) & np.isfinite(r["lr"])
    thr = A.day_thr(r["d"][m], p[m], round(rate * (hi - lo) / 30.44))
    return thr, A.first_per_day(r["d"], p, thr)


def op_stats(rs, rate, W, w, ykey):
    """Pooled (list of instrument dicts) or single operating-point counts in window w."""
    lo, hi = W[w]
    n_al = hits = big = caught = ev = ev_caught = rows_n = rows_pos = sess = 0
    mrem_al, mrem_all, lead, yday_hits = [], [], [], 0
    for r in rs:
        _, al = r["_al"][rate]
        ok = np.isfinite(r["lr"]) & (r["d"] >= lo) & (r["d"] < hi)
        a = al & ok; y = r[ykey]
        n_al += int(a.sum()); hits += int(y[a].sum()); yday_hits += int(r["yday"][a].sum())
        rows_n += int(ok.sum()); rows_pos += int(y[ok].sum())
        sm = (r["sess"]["days"] >= lo) & (r["sess"]["days"] < hi)
        sess += int(sm.sum()); big += int(r["sess"]["big"][sm].sum())
        caught += len(np.unique(r["d"][a & (y == 1) & (r["yday"] == 1)]))
        evd = np.unique(r["d"][ok & (y == 1)]); ev += len(evd)
        ev_caught += len(np.unique(r["d"][a & (y == 1)]))
        mrem_al += list(r["mrem"][a]); mrem_all += list(r["mrem"][ok])
        bd = a & (r["yday"] == 1)
        lead += list((r["tcross"][bd] - r["te"][bd]) / 60)
    lead = np.array(lead, float); lead = lead[np.isfinite(lead)]
    months = sum((hi - lo) for _ in rs) / 30.44
    return dict(alerts=n_al, per_month=n_al / months, sessions=sess, big_sessions=big,
                recall_big=caught / big if big else None, caught_big=caught,
                precision=hits / n_al if n_al else None, precision_ci=A.wilson(hits, n_al),
                base_row=rows_pos / rows_n if rows_n else None, base_session_big=big / sess if sess else None,
                event_sessions=ev, recall_event_sessions=ev_caught / ev if ev else None,
                abs11_precision_same_alerts=yday_hits / n_al if n_al else None,
                mean_rem_pct_alerts=float(np.mean(mrem_al)) if mrem_al else None, median_rem_pct_alerts=float(np.median(mrem_al)) if mrem_al else None,
                mean_rem_pct_all_rows=float(np.mean(mrem_all)) if mrem_all else None,
                lead_h_median_bigday_alerts=float(np.median(lead)) if len(lead) else None,
                lead_share_crossed_before_entry=float((lead <= 0).mean()) if len(lead) else None, lead_n=int(len(lead)))


def auc_block(rs, W, w, ykey, rng, key=None):
    lo, hi = W[w]
    cat = lambda f: np.concatenate([f(r) for r in rs])
    sel = lambda r: (r if key is None else r[key])
    ok = cat(lambda r: np.isfinite(sel(r)["lr"]) & (sel(r)["d"] >= lo) & (sel(r)["d"] < hi))
    y = cat(lambda r: sel(r)[ykey])[ok]; d = cat(lambda r: sel(r)["d"])[ok]
    out = {"n": int(ok.sum()), "pos": int(y.sum())}
    for s in SCORES:
        if key is not None and s == "moved":
            continue
        out[s] = A.auc_ci(y, cat(lambda r: sel(r)[s])[ok], d, rng)
    bases = {k: v[0] for k, v in out.items() if k in ("base_rv", "base_tod", "moved")}
    bb = max(bases, key=bases.get)
    out["best_baseline"] = bb; out["auc_ok"] = bool(out["lr"][1] > bases[bb])
    return out


def run():
    t0 = time.time()
    assert json.load(open(os.path.join(HERE, "prereg.json")))["code_sha256"]["abs48.py"] == CODE["abs48.py"], "abs48.py changed after registration"
    rs = []
    for inst in A.INSTS:
        r = rows(inst); W = windows(r["last_day"])
        r["_al"] = {k: alerts(r, k, W) for k in RATES}
        rs.append(r); print("rows", inst, len(r["d"]), "noentry", int(r["noentry"].sum()), round(time.time() - t0), flush=True)
    W = windows(max(r["last_day"] for r in rs))
    rng = np.random.default_rng(SEED)
    res = {"code": CODE, "pooled": {}, "per_inst": {}}
    for label, group in [("pooled", rs)] + [(r["inst"], [r]) for r in rs]:
        blk = {}
        for yk in ("y_pri", "y_half"):
            for w in W:
                c = {"auc": auc_block(group, W, w, yk, rng), "auc_open": auc_block(group, W, w, yk, rng, key="open")}
                for k in RATES:
                    c[f"op_{k}pm"] = op_stats(group, k, W, w, yk)
                blk[f"{yk}_{w}"] = c
                for k in RATES:
                    o = c[f"op_{k}pm"]
                    de.log_trial({"exp": EXP, "inst": label, "outcome": yk, "window": w, "op": f"{k}pm", "auc_lr": c["auc"]["lr"][0],
                                  "auc_lr_lo": c["auc"]["lr"][1], "best_baseline": c["auc"]["best_baseline"],
                                  "best_baseline_auc": c["auc"][c["auc"]["best_baseline"]][0], "precision": o["precision"],
                                  "recall_big": o["recall_big"], "base_row": o["base_row"], "per_month": o["per_month"],
                                  "mode": "dev" if w == "dev" else "devwindow2023", "abs48_sha256": CODE["abs48.py"]})
        if len(group) == 1:
            blk["thresholds"] = {k: group[0]["_al"][k][0] for k in RATES}; blk["T1"] = group[0]["T1"]
            blk["noentry_rows"] = int(group[0]["noentry"].sum()); blk["rows"] = int(len(group[0]["d"]))
        dec = {}
        for w in W:
            c = blk[f"y_pri_{w}"]; o = c["op_2pm"]; a = c["auc"]
            dec[w] = dict(recall_ok=o["recall_big"] is not None and o["recall_big"] >= 0.5,
                          precision_ok=o["precision"] is not None and o["precision"] >= 2 * o["base_row"], auc_ok=a["auc_ok"])
        blk["decision"] = dict(windows=dec, PASS=bool(all(all(v.values()) for v in dec.values())))
        (res["pooled"] if label == "pooled" else res["per_inst"]).update(blk if label == "pooled" else {label: blk})
        print("done", label, blk["decision"]["PASS"], round(time.time() - t0), flush=True)
    res["secs"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(OUT, "result.json"), "w"), indent=1, default=float)
    print("PASS (pooled, primary):", res["pooled"]["decision"]["PASS"])


if __name__ == "__main__":
    MODE = sys.argv[1] if len(sys.argv) > 1 else ""
    if MODE == "check":
        check()
    elif MODE == "run":
        run()
