"""Evaluator audit v1, item 2 (+ #310 addendum item 1): hand-auditable trace sample and the XAU calibration diagnosis.

Development diagnostic. Reads already-scored data; writes no ledger entry and no verdict.
  1. Rebuild the frozen E of XAU/USD from dev data only (< 2023) and compare with frozen_de.json (coefficients, scaling,
     Platt) -> establishes which rows the model and the calibrator were fit on and that inference uses the same score type.
  2. Class order, feature order, side signs, label maturity checks.
  3. Raw score vs calibrated probability by window (fit in-sample, cal 2022 Q3, thr 2022 Q4, test 2023+), quarterly raw AUC,
     day-block bootstrap of the Platt slope on the calibration window.
  4. Abstention decomposition for E on WTI and XAU.
  5. Trace sample with immutable IDs (instrument|M5 start UTC|side), source M1 candles to net R, recomputed independently.

  python calib_trace.py     writes out/calibration.json, out/calibration.md, out/trace.jsonl, out/trace.md
"""
import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.environ["ENGINE_TRIALS"] = os.path.join(OUT, "diag_trials.jsonl")
ENGINE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ENGINE); sys.path.insert(0, HERE)
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
import de
from bars import iso
from labels import POLICY
from validate import day_of, year_start_day, day_boot, ci
from fixtures import ref_one

FZ = json.load(open(de.FROZEN))
REASON = {1: "STOP", 2: "TARGET", 3: "FLIP", 4: "TIME"}
STATE = {0: "none", 1: "WAIT", 2: "REJ_SPREAD", 3: "REJ_BUSY", 4: "ENTER", 5: "HOLD", 6: "EXPIRED"}


def auc(y, s):
    return float(roc_auc_score(y, s)) if 0 < y.sum() < len(y) else float("nan")


def raw_z(M, X):
    return (X - np.array(M["mean"])) / np.array(M["scale"]) @ np.array(M["coef"]) + M["b"]


def popul(inst, until):
    fz = FZ[inst]
    m1, B, O, L = de.prep(inst, until)
    GS = de.gate_states(B, L, fz["gate"])
    cfg = de.as_cfg(fz["d_cfg"])
    R = de.run_d(B, O, GS, cfg)
    F = de.e_features(B, GS, R["ep"])
    C = de.candidates(B, O, R, cfg[2])
    return m1, B, O, L, GS, cfg, R, F, C


def windows(B, C):
    q3, q4 = (int(day_of(np.datetime64(d, "m").astype(np.int64))) for d in ("2022-07-01", "2022-10-01"))
    return de.e_windows(C, int(B["day"][0]), q3, q4, year_start_day(2023)) + (q3, q4)


def calibration(inst):
    out = dict(inst=inst)
    fz = FZ[inst]
    # (1) refit from dev data only and compare with the frozen artifact
    m1, B, O, L, GS, cfg, R, F, C = popul(inst, de.DEV_END)
    fit, cal, thr, q3, q4 = windows(B, C)
    cols = de.BASEF + de.VOLF
    X = de.e_matrix(F, cols, C["i"]); ok = np.isfinite(X).all(1)
    out["rows"] = dict(fit=int((fit & ok).sum()), cal=int((cal & ok).sum()), thr=int((thr & ok).sum()))
    E = fz["E"]["E"]
    if "unavailable" in E:
        out["frozen"] = E["unavailable"]
        out["cause"] = ("insufficient evidence: the calibration window (2022 Q3) holds only "
                        f"{out['rows']['cal']} candidate rows (< 100 required), because the frozen D (fired gate + day-range break) "
                        "produces few candidates; E is undefined (no support), not a calibrated model with zero entries")
        return out, None
    assert E["cols"] == cols, "feature order differs from BASEF + VOLF"
    M = de.e_fit(X[fit & ok], C["y"][fit & ok], C["w"][fit & ok], X[cal & ok], C["y"][cal & ok])
    lr = LogisticRegression(C=0.1, max_iter=3000).fit((X[fit & ok] - M["mean"]) / np.array(M["scale"]), C["y"][fit & ok], sample_weight=C["w"][fit & ok])
    out["class_order"] = dict(model=[int(c) for c in lr.classes_], positive_label="y_arm = 1 (reached +1R before the stop within 72 bars)")
    out["refit_matches_frozen"] = dict(
        mean=float(np.max(np.abs(np.array(M["mean"]) - E["model"]["mean"]))), scale=float(np.max(np.abs(np.array(M["scale"]) - E["model"]["scale"]))),
        coef=float(np.max(np.abs(np.array(M["coef"]) - E["model"]["coef"]))), b=abs(M["b"] - E["model"]["b"]),
        platt=float(np.max(np.abs(np.array(M["platt"]) - E["model"]["platt"]))))
    out["frozen_platt"] = E["model"]["platt"]
    out["p_star"] = E["p_star"]; out["thr_window_best"] = E["thr_window_best"]
    # label maturity: every fit/cal row's label (exit) lies before the next window starts minus the embargo
    out["label_maturity"] = dict(fit_exit_max=str(np.datetime64(int(C["exit_day"][fit].max()), "D")), cal_start=str(np.datetime64(q3, "D")),
                                 cal_exit_max=str(np.datetime64(int(C["exit_day"][cal].max()), "D")), thr_start=str(np.datetime64(q4, "D")),
                                 embargo_days=de.EMB, censored_rows_in_fit=int((~np.isfinite(C["net"][fit])).sum()))
    # side signs: side-aligned features flip sign with the side; the label is computed from the side's exit quotes
    i0 = C["i"][0]
    out["side_sign_check"] = dict(ext_long=float((B["mid_c"][i0] - B["ema"][i0]) / B["atr"][i0]), ext_feature=float(F["ext"][i0]), side=int(B["trend"][i0]))
    # (2) the frozen model on every window, raw vs calibrated, using the FROZEN artifact (not the refit)
    _, Bf, Of, Lf, GSf, _, Rf, Ff, Cf = popul(inst, None)
    Xf = de.e_matrix(Ff, cols, Cf["i"]); okf = np.isfinite(Xf).all(1)
    zf = np.full(len(Cf["i"]), np.nan); zf[okf] = raw_z(E["model"], Xf[okf])
    pc = 1 / (1 + np.exp(-(E["model"]["platt"][0] * zf + E["model"]["platt"][1])))
    q3d, q4d, t0 = q3, q4, year_start_day(2023)
    W = {"fit (in-sample)": (Cf["exit_day"] < q3d - de.EMB) & okf, "cal 2022Q3": (Cf["day"] >= q3d) & (Cf["exit_day"] < q4d - de.EMB) & okf,
         "thr 2022Q4": (Cf["day"] >= q4d) & (Cf["exit_day"] < t0 - de.EMB) & okf, "test 2023+ (diagnostic)": (Cf["day"] >= t0) & okf}
    tab = {}
    for name, m in W.items():
        y = Cf["y"][m]; z = zf[m]
        pl = LogisticRegression(C=1e6, max_iter=1000).fit(z[:, None], y)
        qs = np.quantile(z, [0.2, 0.4, 0.6, 0.8])
        qb = np.searchsorted(qs, z)
        tab[name] = dict(n=int(m.sum()), base=float(y.mean()), auc_raw=auc(y, z), auc_cal=auc(y, pc[m]),
                         platt_slope_if_fit_here=float(pl.coef_[0][0]),
                         raw_quintiles=[dict(q=int(k + 1), n=int((qb == k).sum()), mean_z=float(z[qb == k].mean()), mean_p_cal=float(pc[m][qb == k].mean()),
                                             obs_arm=float(y[qb == k].mean()), mean_net_R=float(Cf["net"][m][qb == k].mean())) for k in range(5)],
                         by_side={int(s): dict(n=int((Cf["s"][m] == s).sum()), auc_raw=auc(y[Cf["s"][m] == s], z[Cf["s"][m] == s])) for s in (1, -1)})
    out["windows"] = tab
    # Platt slope uncertainty on the calibration window: day-block bootstrap (5-day blocks) of the refit slope
    mc = W["cal 2022Q3"]
    yc, zc, dc = Cf["y"][mc], zf[mc], Cf["day"][mc]

    def slope(ix):
        yy = yc[ix]
        if yy.min() == yy.max():
            return np.nan
        return LogisticRegression(C=1e6, max_iter=1000).fit(zc[ix][:, None], yy).coef_[0][0]
    bs = day_boot(dc, np.unique(dc), slope, reps=500, block=5, seed=3)
    out["cal_slope_boot"] = dict(point=float(slope(np.arange(len(yc)))), ci95=ci(bs), share_negative=float(np.mean(bs < 0)))
    # quarterly raw AUC of the frozen raw score
    qtr = {}
    yrs = np.datetime64("1970-01-01") + Cf["day"].astype("timedelta64[D]")
    qkey = np.array([f"{str(d)[:4]}Q{(int(str(d)[5:7]) - 1) // 3 + 1}" for d in yrs])
    for k in sorted(set(qkey[okf])):
        m = (qkey == k) & okf
        if m.sum() >= 200:
            qtr[k] = dict(n=int(m.sum()), auc_raw=auc(Cf["y"][m], zf[m]))
    out["quarterly_auc_raw"] = qtr
    return out, (Bf, Of, GSf, Rf, Ff, Cf, zf, pc, cols, E)


def trace(inst, m1, B, O, GS, R, F, C, z, pc, cols, E, lo_day, hi_day, picks):
    """Pick representative rows inside [lo_day, hi_day) and export the full chain."""
    first = np.searchsorted(m1["t"], B["t"])
    st = R["state"]; rows = []
    s_all = B["trend"]
    xb = {s: O[False][s] for s in (1, -1)}
    zbar = np.full(len(B["t"]), np.nan); pbar = np.full(len(B["t"]), np.nan)
    zbar[C["i"]] = z; pbar[C["i"]] = pc
    pstar = None if E is None else E["p_star"]
    ep_disc = {}
    for i in np.where(R["ep"] >= 0)[0]:
        ep_disc.setdefault(R["ep"][i], i)
    for label, i in picks:
        s = int(s_all[i]); sim = xb[s]
        e = i + 1
        exit_bar = int(sim["exit_bar"][i])
        ref = ref_one(B, int(i), s, B["atr"][i], B["flip"], POLICY, "pess")
        src = lambda b: [dict(t=str(iso(m1["t"][k])), bid=[m1[f"bid_{x}"][k] for x in "ohlc"], ask=[m1[f"ask_{x}"][k] for x in "ohlc"])
                         for k in range(first[b], first[b + 1] if b + 1 < len(first) else len(m1["t"]))]
        R1 = POLICY["k"] * B["atr"][i]
        entry = float(sim["entry"][i]) * s
        rec = dict(
            row_id=f"{inst}|M5|{iso(B['t'][i])}|{'+1' if s > 0 else '-1'}", category=label,
            episode_id=f"{inst}|disc={iso(B['t'][ep_disc[R['ep'][i]]])}|{'+1' if s > 0 else '-1'}" if R["ep"][i] >= 0 else None,
            decision_bar=dict(start=str(iso(B["t"][i])), close_utc=str(iso(B["t"][i] + 5)), mid_c=B["mid_c"][i], bid_c=B["bid_c"][i], ask_c=B["ask_c"][i],
                              atr=B["atr"][i], ema20=B["ema"][i], supertrend=B["st"][i], trend=s, tr_H1=int(B["tr_H1"][i]), tr_M15=int(B["tr_M15"][i]),
                              source_m1=src(i)),
            D_state=STATE[int(st[i])], spread_R=float(B["spr"][i]), spread_ok=bool(B["spr"][i] <= de.SPR_MAX),
            features={c: float(F[c][i]) for c in cols},
            E=None if E is None else dict(standardized=[float(v) for v in (np.array([F[c][i] for c in cols]) - E["model"]["mean"]) / np.array(E["model"]["scale"])],
                                          raw_z=float(zbar[i]), p_raw=float(1 / (1 + np.exp(-zbar[i]))), platt=E["model"]["platt"], p_cal=float(pbar[i]),
                                          p_star=pstar, threshold_result="accept" if (pstar is not None and pbar[i] >= pstar) else "reject"),
            label=dict(y_arm=bool(sim["arm"][i]), y_runner=bool(sim["runner"][i]), ambiguous=bool(sim["amb"][i])),
            fill=dict(entry_bar=str(iso(B["t"][e])), entry_component="ask_o" if s > 0 else "bid_o", entry=entry, R_price=R1,
                      stop0=entry - s * R1, milestone=entry + s * POLICY["m"] * R1, target=entry + s * POLICY["T"] * R1,
                      breakeven_stop=entry, stop_trigger_side="bid" if s > 0 else "ask", entry_bar_m1=src(e)),
            events=dict(milestone_touched=None if sim["arm_bar"][i] < 0 else str(iso(B["t"][e + sim["arm_bar"][i]])),
                        modification_requested=None if sim["arm_bar"][i] < 0 else str(iso(B["t"][e + sim["arm_bar"][i]] + 5)),
                        modification_effective=None if sim["arm_bar"][i] < 0 else str(iso(B["t"][min(e + sim["arm_bar"][i] + 1, len(B["t"]) - 1)])),
                        exit_bar=str(iso(B["t"][exit_bar])), exit_reason=REASON.get(int(sim["reason"][i]), "?"),
                        exit_price=entry + s * float(sim["net_R"][i]) * R1, exit_component="bid" if s > 0 else "ask", exit_bar_m1=src(exit_bar)),
            net_R=float(sim["net_R"][i]), hand_check=dict(formula="side * (exit - entry) / R", ref_one_net_R=ref["net_R"],
                                                         equal=bool(np.isclose(ref["net_R"], sim["net_R"][i], atol=1e-12))))
        rows.append(rec)
    return rows


def pick(B, O, R, C, lo_day, hi_day, rng):
    st = R["state"]; inw = (B["day"] >= lo_day) & (B["day"] < hi_day)
    s = B["trend"]
    look = lambda key, i: np.where(s[i] > 0, O[False][1][key][i], O[False][-1][key][i])
    ent = np.where((st == 4) & inw)[0]
    out = []

    def add(label, cand):
        cand = [int(c) for c in cand if c not in [p for _, p in out]]
        if cand:
            out.append((label, int(rng.choice(cand))))
    add("accepted long, milestone + runner target", [i for i in ent if s[i] > 0 and look("runner", i)])
    add("accepted short, milestone + runner target", [i for i in ent if s[i] < 0 and look("runner", i)])
    add("accepted long, milestone then breakeven stop", [i for i in ent if s[i] > 0 and look("arm", i) and look("reason", i) == 1])
    add("accepted short, stop loss", [i for i in ent if s[i] < 0 and look("reason", i) == 1 and not look("arm", i)])
    add("accepted, timeout (72 bars)", [i for i in ent if look("reason", i) == 4])
    add("accepted, opposite-flip exit", [i for i in ent if look("reason", i) == 3])
    amb = [i for i in np.where(inw)[0] if look("amb", i) and B["trend"][i] != 0 and R["ep"][i] >= 0]
    add("ambiguous bar (both barriers inside one M5 bar)", amb)
    add("rejected: spread > 0.2 R", np.where((st == 2) & inw)[0])
    add("rejected: position busy", np.where((st == 3) & inw)[0])
    add("waiting: no confirmation yet", np.where((st == 1) & inw & (s < 0))[0])
    return out


def main():
    rng = np.random.default_rng(308)
    res, traces = {}, []
    for inst in ("XAU/USD", "WTICO/USD"):
        cal, ctx = calibration(inst)
        res[inst] = cal
        if ctx is None:  # WTI: E undefined; trace D only
            m1, B, O, L, GS, cfg, R, F, C = popul(inst, None)
            z = np.full(len(C["i"]), np.nan); pc = z.copy(); E = None
        else:
            B, O, GS, R, F, C, z, pc, cols, E = ctx
            m1 = de.load_m1(inst, None)
        lo, hi = year_start_day(2021), year_start_day(2023)  # trace on dev data
        traces += trace(inst, m1, B, O, GS, R, F, C, z, pc, de.BASEF + de.VOLF, E, lo, hi, pick(B, O, R, C, lo, hi, rng))
    json.dump(res, open(os.path.join(OUT, "calibration.json"), "w"), indent=1, default=float)
    with open(os.path.join(OUT, "trace.jsonl"), "w") as f:
        for r in traces:
            f.write(json.dumps(r, default=float) + "\n")
    md = ["| row_id | category | D state | side | entry (component) | stop0 / milestone / target | label y_arm / runner / amb | exit (reason, component) | net R | ref==harness | raw z | p_cal | p* | threshold |", "|" + "---|" * 14]
    for r in traces:
        E = r["E"] or {}
        f = r["fill"]
        md.append(f"| {r['row_id']} | {r['category']} | {r['D_state']} | {r['decision_bar']['trend']:+d} | {f['entry']:.3f} ({f['entry_component']}) | "
                  f"{f['stop0']:.3f} / {f['milestone']:.3f} / {f['target']:.3f} | {r['label']['y_arm']} / {r['label']['y_runner']} / {r['label']['ambiguous']} | "
                  f"{r['events']['exit_price']:.3f} ({r['events']['exit_reason']}, {r['events']['exit_component']}) | {r['net_R']:+.3f} | {r['hand_check']['equal']} | "
                  f"{E.get('raw_z', float('nan')):+.3f} | {E.get('p_cal', float('nan')):.3f} | {E.get('p_star', '-')} | {E.get('threshold_result', '-')} |")
    open(os.path.join(OUT, "trace.md"), "w").write("\n".join(md) + "\n")
    print("\n".join(md))
    print(json.dumps({k: {x: v[x] for x in v if x not in ("windows", "quarterly_auc_raw")} for k, v in res.items()}, indent=1, default=float))
    for k, v in res.items():
        for w, t in v.get("windows", {}).items():
            print(k, w, {x: t[x] for x in ("n", "base", "auc_raw", "auc_cal", "platt_slope_if_fit_here")}, t["by_side"])
            for q in t["raw_quintiles"]:
                print("   ", q)
        print(k, "quarterly", v.get("quarterly_auc_raw"))


if __name__ == "__main__":
    main()
