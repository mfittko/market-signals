"""Ladder steps A-C on WTICO/USD M5.

  python ladder.py dev     develop on 2018-2022 only (M1 truncated at 2023-01-01), walk-forward 2019-2022,
                           writes results/dev.{json,md} and frozen.json (the variants frozen for the test)
  python ladder.py final   score 2023-01-01..newest ONCE per frozen variant (refuses a second run, refuses
                           if WTI has not caught up), writes results/test.{json,md}

A: every production supertrend flip (computeSupertrend/detectFlips on mid M5), frozen policy (labels.POLICY).
B: A on days where the spike 4 day-layer gate is armed (trailing rank of P(big day) >= q).
C: A filtered by chop / entry-geometry rules, thresholds set on earlier years only.
"""
import sys, os, json, subprocess, itertools, time
import numpy as np
import pandas as pd
from bars import load_m1, resample, coverage, iso
from labels import simulate, POLICY
from nulls import BarIndex, circular, subset
from validate import day_of, year_start_day, wf_folds, day_boot, ci, log_trial, trial_count, config_hash
import gate

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "results")
INST = "WTICO/USD"
DEV_END, DEV_YEARS = "2023-01-01", [int(y) for y in os.environ.get("LADDER_YEARS", "2019,2020,2021,2022").split(",")]
NWIN, EMB, MINCOV = 12, 5, 0.25
QB = [0.5, 0.6, 0.7, 0.8, 0.9]
# rule: (feature, keep direction, candidate keep-quantiles on the training trades; None = rule off)
CRULES = [("de", "ge", [None, 0.25, 0.5]), ("ovl", "le", [None, 0.75, 0.5]), ("ext", "le", [None, 0.75, 0.5]),
          ("dinv", "le", [None, 0.75, 0.5]), ("spr", "le", [None, 0.75, 0.5])]
NBOOT, NNULL, NSUB = 2000, 500, 2000


# ------------------------------------------------------------------ data
def build(until=None):
    m1 = load_m1(INST, until)
    B = resample(m1, "M5")
    tag = f"{len(B['t'])}_{int(B['t'][-1])}"
    pin, pout = os.path.join(HERE, "cache", f"m5mid_{tag}.csv"), os.path.join(HERE, "cache", f"flips_{tag}.csv")
    if not os.path.exists(pout):
        pd.DataFrame({"time": B["t"], "open": B["mid_o"], "high": B["mid_h"], "low": B["mid_l"], "close": B["mid_c"]}).to_csv(pin, index=False)
        subprocess.run(["node", os.path.join(HERE, "flips.mjs"), pin, pout], check=True)
    fl = pd.read_csv(pout)
    for k in ("trend", "flip", "atr", "st"):
        B[k] = fl[k].to_numpy(float)
    B["flip"] = np.nan_to_num(B["flip"]).astype(int)
    c, h, l = (pd.Series(B["mid_" + k]) for k in "chl")
    B["de"] = ((c - c.shift(NWIN)).abs() / c.diff().abs().rolling(NWIN).sum()).to_numpy()
    inter = (np.minimum(h, h.shift()) - np.maximum(l, l.shift())).clip(lower=0)
    union = np.maximum(h, h.shift()) - np.minimum(l, l.shift())
    B["ovl"] = (inter / union).rolling(NWIN).mean().to_numpy()
    B["ema"] = c.ewm(span=20, adjust=False).mean().to_numpy()
    B["day"] = day_of(B["t"])
    return m1, B


def check_features_causal(B, until):
    """Recompute the C features with every bar after a cut perturbed; rows up to the cut must not change."""
    m1 = load_m1(INST, until)
    cut = len(B["t"]) // 2
    tcut = B["t"][cut] + 5
    late = m1["t"] >= tcut
    noise = np.random.default_rng(3).normal(1, 0.02, late.sum())
    for k in ("bid_o", "bid_h", "bid_l", "bid_c", "ask_o", "ask_h", "ask_l", "ask_c"):
        m1[k][late] *= noise
    B2 = resample(m1, "M5")
    c, h, l = (pd.Series(B2["mid_" + k]) for k in "chl")
    de2 = ((c - c.shift(NWIN)).abs() / c.diff().abs().rolling(NWIN).sum()).to_numpy()
    ema2 = c.ewm(span=20, adjust=False).mean().to_numpy()
    assert np.allclose(de2[:cut + 1], B["de"][:cut + 1], equal_nan=True) and np.allclose(ema2[:cut + 1], B["ema"][:cut + 1])
    return True


def feats(B, i, s):
    a = B["atr"][i]
    return {"de": B["de"][i], "ovl": B["ovl"][i], "ext": s * (B["mid_c"][i] - B["ema"][i]) / a,
            "dinv": s * (B["mid_c"][i] - B["st"][i]) / a, "spr": (B["ask_c"][i] - B["bid_c"][i]) / (POLICY["k"] * a)}


def outcomes(B):
    n = len(B["t"]); idx = np.arange(n)
    return {opt: {s: simulate(B, idx, np.full(n, s), B["atr"], B["flip"], POLICY, optimistic=opt) for s in (1, -1)}
            for opt in (False, True)}


def look(O, i, s, key):
    return np.where(s > 0, O[1][key][i], O[-1][key][i])


# ------------------------------------------------------------------ variants
def a_trades(B, O, lo_day, hi_day):
    i = np.where(B["flip"] != 0)[0]
    s = B["flip"][i]
    m = (B["day"][i] >= lo_day) & (B["day"][i] < hi_day) & look(O[False], i, s, "ok")
    i, s = i[m], s[m]
    T = {"i": i, "s": s, "day": B["day"][i], "net": look(O[False], i, s, "net_R"), "net_opt": look(O[True], i, s, "net_R"),
         "arm": look(O[False], i, s, "arm"), "runner": look(O[False], i, s, "runner"), "amb": look(O[False], i, s, "amb"),
         "reason": look(O[False], i, s, "reason")}
    T["exit_day"] = B["day"][np.clip(look(O[False], i, s, "exit_bar"), 0, len(B["t"]) - 1)]
    T.update(feats(B, i, s))
    return T


def c_thresholds(T, m, combo):
    th = {}
    for (f, d, _), q in zip(CRULES, combo):
        if q is not None:
            th[f] = (d, float(np.nanquantile(T[f][m], 1 - q if d == "ge" else q)))
    return th


def c_mask(T, th):
    k = np.ones(len(T["i"]), bool)
    for f, (d, v) in th.items():
        k &= (T[f] >= v) if d == "ge" else (T[f] <= v)
    return k


def objective(net, keep, ntrain):
    return float(net[keep].mean()) if keep.sum() >= MINCOV * ntrain and keep.any() else -np.inf


def choose_c(T, train, fold, mode):
    best = None
    for combo in itertools.product(*[r[2] for r in CRULES]):
        th = c_thresholds(T, train, combo)
        keep = train & c_mask(T, th)
        obj = objective(T["net"], keep, train.sum())
        log_trial({"exp": "ladder-wti-m5", "mode": mode, "variant": "C", "fold": fold, "combo": list(combo),
                   "thresholds": th, "train_trades": int(train.sum()), "kept": int(keep.sum()), "train_meanR": obj})
        if best is None or obj > best[0]:
            best = (obj, combo, th)
    return best


def gate_ranks(L, M):
    return gate.trailing_rank(gate.score(L, M))


def rank_at(L, rk, day):
    p = np.clip(np.searchsorted(L["day"], day), 0, len(L["day"]) - 1)
    return np.where(L["day"][p] == day, rk[p], np.nan)


def choose_q(T, rank, train, fold, mode):
    best = None
    for q in QB:
        keep = train & (rank >= q)
        obj = objective(T["net"], keep, train.sum())
        log_trial({"exp": "ladder-wti-m5", "mode": mode, "variant": "B", "fold": fold, "q": q,
                   "train_trades": int(train.sum()), "kept": int(keep.sum()), "train_meanR": obj})
        if best is None or obj > best[0]:
            best = (obj, q)
    return best


# ------------------------------------------------------------------ metrics
def maxdd(r):
    cum = np.r_[0, np.cumsum(r)]
    return float(np.max(np.maximum.accumulate(cum) - cum))


def summarize(T, keep, all_days, X, O, lo_i, hi_i, donor_days, rng, name):
    net = T["net"]
    r = net[keep]
    out = dict(variant=name, trades=int(keep.sum()), coverage=float(keep.mean()), meanR=float(r.mean()), totalR=float(r.sum()),
               maxddR=maxdd(r), p_arm=float(T["arm"][keep].mean()),
               p_runner=float(T["runner"][keep].sum() / max(1, T["arm"][keep].sum())),
               loser_share=float((r < 0).mean()), ambiguity=float(T["amb"][keep].mean()),
               meanR_optimistic=float(T["net_opt"][keep].mean()),
               avoided_losers=int((~keep & (net < 0)).sum()), avoided_losers_R=float(net[~keep & (net < 0)].sum()),
               blocked_winners=int((~keep & (net > 0)).sum()), blocked_winners_R=float(net[~keep & (net > 0)].sum()))
    km = lambda ix: net[ix][keep[ix]].mean() if keep[ix].any() else np.nan
    bm = day_boot(T["day"], all_days, km, NBOOT)
    out["meanR_ci"] = ci(bm)
    out["totalR_ci"] = ci(day_boot(T["day"], all_days, lambda ix: net[ix][keep[ix]].sum(), NBOOT))
    if name != "A":
        out["dR_vs_A"] = float(r.mean() - net.mean())
        out["dR_vs_A_ci"] = ci(day_boot(T["day"], all_days, lambda ix: km(ix) - net[ix].mean(), NBOOT))
        ls = lambda ix: (net[ix][keep[ix]] < 0).mean() - (net[ix] < 0).mean()
        out["dLoser_vs_A"] = float((r < 0).mean() - (net < 0).mean())
        out["dLoser_vs_A_ci"] = ci(day_boot(T["day"], all_days, ls, NBOOT))
        sub = [subset(len(net), int(keep.sum()), rng) for _ in range(NSUB)]
        sm = np.array([net[s].mean() for s in sub]); sl = np.array([(net[s] < 0).mean() for s in sub])
        out["subset_null_meanR_95"] = ci(sm); out["subset_null_p_meanR"] = float((sm >= r.mean()).mean())
        out["subset_null_loser_95"] = ci(sl); out["subset_null_p_loser"] = float((sl <= (r < 0).mean()).mean())
    # execution-matched time-shift nulls on the variant's own entries (same side, policy, costs)
    iv, sv = T["i"][keep], T["s"][keep]
    tn, cn, fill = [], [], []
    for b in range(NNULL):
        j = X.same_tod(iv, rng, donor_days=donor_days)
        ok = j >= 0
        rr = look(O[False], j[ok], sv[ok], "net_R"); okk = look(O[False], j[ok], sv[ok], "ok")
        tn.append(np.nanmean(rr[okk])); fill.append(ok.mean())
        jc = circular(iv, lo_i, hi_i, rng)
        rc = look(O[False], jc, sv, "net_R"); okc = look(O[False], jc, sv, "ok")
        cn.append(np.nanmean(rc[okc]))
    tn, cn = np.array(tn), np.array(cn)
    out["null_tod_meanR"] = float(tn.mean()); out["null_tod_fill"] = float(np.mean(fill))
    out["vs_null_tod_ci"] = ci(bm[:NNULL] - tn[:len(bm[:NNULL])])
    out["null_circ_meanR"] = float(cn.mean())
    out["vs_null_circ_ci"] = ci(bm[:NNULL] - cn[:len(bm[:NNULL])])
    return out


def table(rows):
    f = lambda x, p=3: f"{x:+.{p}f}" if isinstance(x, float) else str(x)
    c2 = lambda v: f"[{v[0]:+.3f}, {v[1]:+.3f}]"
    hdr = ("| Variant | Trades | Cov | R/trade [CI] | Total R [CI] | MaxDD R | p_arm | p_runner | Losers | "
           "Avoided losers (R) | Blocked winners (R) | dR/trade vs A [CI] | dLoser vs A [CI] | Subset-null p (R / losers) | "
           "vs same-tod null [CI] | vs circular null [CI] |")
    out = [hdr, "|" + "|".join(["---"] * (hdr.count("|") - 1)) + "|"]
    for r in rows:
        out.append("| " + " | ".join([
            r["variant"], str(r["trades"]), f"{r['coverage']:.2f}", f"{r['meanR']:+.3f} {c2(r['meanR_ci'])}",
            f"{r['totalR']:+.1f} [{r['totalR_ci'][0]:+.1f}, {r['totalR_ci'][1]:+.1f}]", f"{r['maxddR']:.1f}",
            f"{r['p_arm']:.3f}", f"{r['p_runner']:.3f}", f"{r['loser_share']:.3f}",
            f"{r['avoided_losers']} ({r['avoided_losers_R']:+.1f})", f"{r['blocked_winners']} ({r['blocked_winners_R']:+.1f})",
            f"{r['dR_vs_A']:+.3f} {c2(r['dR_vs_A_ci'])}" if "dR_vs_A" in r else "-",
            f"{r['dLoser_vs_A']:+.3f} {c2(r['dLoser_vs_A_ci'])}" if "dLoser_vs_A" in r else "-",
            f"{r['subset_null_p_meanR']:.3f} / {r['subset_null_p_loser']:.3f}" if "subset_null_p_meanR" in r else "-",
            f"{r['meanR'] - r['null_tod_meanR']:+.3f} {c2(r['vs_null_tod_ci'])}",
            f"{r['meanR'] - r['null_circ_meanR']:+.3f} {c2(r['vs_null_circ_ci'])}"]) + " |")
    return "\n".join(out)


def window_bars(B, lo_day, hi_day):
    w = np.where((B["day"] >= lo_day) & (B["day"] < hi_day))[0]
    return w[0], w[-1] + 1, np.unique(B["day"][w])


# ------------------------------------------------------------------ modes
def dev():
    t0 = time.time()
    m1, B = build(DEV_END)
    assert B["t"][-1] < np.datetime64(DEV_END, "m").astype(np.int64)
    check_features_causal(B, DEV_END)
    O = outcomes(B)
    lo_day, hi_day = year_start_day(DEV_YEARS[0]), year_start_day(DEV_YEARS[-1] + 1)
    Tall = a_trades(B, O, int(B["day"][0]), hi_day)  # 2018 included: training rows for the first fold
    ev = (Tall["day"] >= lo_day)
    L = gate.day_layer(m1)
    log_trial({"exp": "ladder-wti-m5", "mode": "dev", "variant": "A", "policy": POLICY, "trades": int(ev.sum())})
    # walk-forward B and C
    keepB = np.zeros(len(Tall["i"]), bool); keepC = keepB.copy(); rankB = np.full(len(keepB), np.nan)
    folds, armed_days = [], []
    for y, tr, te in wf_folds(Tall["day"], Tall["exit_day"], DEV_YEARS, EMB):
        M = gate.fit(L, L["day"] < year_start_day(y) - EMB)
        rk = gate_ranks(L, M)
        rank = rank_at(L, rk, Tall["day"])
        ob, q = choose_q(Tall, rank, tr & np.isfinite(rank), y, "dev")
        keepB[te] = rank[te] >= q; rankB[te] = rank[te]
        dy = (L["day"] >= year_start_day(y)) & (L["day"] < year_start_day(y + 1))
        armed_days.append(L["day"][dy & (rk >= q)])
        oc, combo, th = choose_c(Tall, tr, y, "dev")
        keepC[te] = c_mask(Tall, th)[te]
        folds.append(dict(year=y, train_trades=int(tr.sum()), B_q=q, B_train_meanR=ob, B_gate_days=int(len(armed_days[-1])),
                          B_lr=M, C_combo=list(combo), C_thresholds=th, C_train_meanR=oc))
    T = {k: v[ev] for k, v in Tall.items()}
    keepB, keepC, rankB = keepB[ev], keepC[ev], rankB[ev]
    lo_i, hi_i, all_days = window_bars(B, lo_day, hi_day)
    X = BarIndex(B["t"]); rng = np.random.default_rng(11)
    rows = [summarize(T, np.ones(len(T["i"]), bool), all_days, X, O, lo_i, hi_i, None, rng, "A"),
            summarize(T, keepB, all_days, X, O, lo_i, hi_i, np.concatenate(armed_days), rng, "B"),
            summarize(T, keepC, all_days, X, O, lo_i, hi_i, None, rng, "C")]
    # per-year A/B/C R per trade (stability)
    yrs = {}
    for y in DEV_YEARS:
        m = (T["day"] >= year_start_day(y)) & (T["day"] < year_start_day(y + 1))
        yrs[y] = {v: [int((m & k).sum()), float(T["net"][m & k].mean()) if (m & k).any() else None]
                  for v, k in (("A", np.ones(len(m), bool)), ("B", keepB), ("C", keepC))}
    # exit reasons for A
    reasons = {n: float((T["reason"] == c).mean()) for n, c in (("stop", 1), ("target", 2), ("flip", 3), ("time", 4))}
    # freeze for the test: B = LR on all dev days + q chosen on the pooled out-of-fold rows; C = combo on all dev trades
    Mf = gate.fit(L, L["day"] < year_start_day(2023) - EMB)
    obq, qf = choose_q(T, rankB, np.isfinite(rankB), "freeze", "freeze")
    trf = Tall["exit_day"] < year_start_day(2023) - EMB
    ocf, combof, thf = choose_c(Tall, trf, "freeze", "freeze")
    frozen = {"inst": INST, "gran": "M5", "policy": POLICY, "A": {}, "B": {"q": qf, "lr": Mf, "rank_n": 252, "rank_minn": 126},
              "C": {"combo": list(combof), "thresholds": thf, "nwin": NWIN}, "frozen_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    json.dump(frozen, open(os.path.join(HERE, "frozen.json"), "w"), indent=1)
    res = dict(window=f"{DEV_YEARS[0]}-01-01..{DEV_END} (walk-forward out-of-fold)", m1_rows=int(len(m1["t"])),
               m5_bars=int(len(B["t"])), data_last=str(iso(B["t"][-1])), rows=rows, folds=folds, per_year=yrs,
               A_exit_reasons=reasons, ambiguity_A=rows[0]["ambiguity"], trials=trial_count(),
               trials_dev=trial_count(mode="dev") + trial_count(mode="freeze"),
               frozen_hash={v: config_hash({"policy": POLICY, v: frozen[v]}) for v in "ABC"}, secs=round(time.time() - t0))
    os.makedirs(RES, exist_ok=True)
    json.dump(res, open(os.path.join(RES, "dev.json"), "w"), indent=1, default=float)
    md = f"# Ladder A-C, WTICO/USD M5, development years\n\nWindow: {res['window']}. Data to {res['data_last']}.\n\n" + table(rows)
    open(os.path.join(RES, "dev.md"), "w").write(md + "\n")
    print(md); print(json.dumps({k: res[k] for k in ("per_year", "A_exit_reasons", "trials", "trials_dev", "secs")}, default=float))
    for f in folds:
        print(f["year"], "B q", f["B_q"], "gate days", f["B_gate_days"], "C", f["C_combo"])
    print("frozen", frozen["B"]["q"], frozen["C"]["combo"])


def final():
    n, _, tmax = coverage(INST)
    newest = np.datetime64(tmax[:16], "m")
    if newest < np.datetime64("now", "m") - np.timedelta64(4, "D"):
        sys.exit(f"WTI has not caught up: newest M1 bar {tmax}. Not scoring the test.")
    frozen = json.load(open(os.path.join(HERE, "frozen.json")))
    hashes = {v: config_hash({"policy": frozen["policy"], v: frozen[v]}) for v in "ABC"}
    ledger = os.path.join(HERE, "test_ledger.jsonl")
    done = set()
    if os.path.exists(ledger):
        done = {json.loads(l)["hash"] for l in open(ledger)}
    todo = [v for v in "ABC" if hashes[v] not in done]
    if not todo:
        sys.exit("All frozen variants were already scored on the test. Refusing a second look.")
    for v in todo:  # record the look before computing, so a crash cannot turn into a retry
        with open(ledger, "a") as f:
            f.write(json.dumps({"variant": v, "hash": hashes[v], "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "data_to": tmax}) + "\n")
    m1, B = build(None)
    O = outcomes(B)
    lo_day, hi_day = year_start_day(2023), int(B["day"][-1]) + 1
    T = a_trades(B, O, lo_day, hi_day)
    L = gate.day_layer(m1)
    rk = gate_ranks(L, frozen["B"]["lr"])
    keepB = rank_at(L, rk, T["day"]) >= frozen["B"]["q"]
    keepC = c_mask(T, {k: tuple(v) for k, v in frozen["C"]["thresholds"].items()})
    armed = L["day"][(L["day"] >= lo_day) & (rk >= frozen["B"]["q"])]
    lo_i, hi_i, all_days = window_bars(B, lo_day, hi_day)
    X = BarIndex(B["t"]); rng = np.random.default_rng(23)
    rows = [summarize(T, np.ones(len(T["i"]), bool), all_days, X, O, lo_i, hi_i, None, rng, "A")]
    if "B" in todo:
        rows.append(summarize(T, keepB, all_days, X, O, lo_i, hi_i, armed, rng, "B"))
    if "C" in todo:
        rows.append(summarize(T, keepC, all_days, X, O, lo_i, hi_i, None, rng, "C"))
    res = dict(window=f"2023-01-01..{iso(B['t'][-1])}", rows=rows, hashes=hashes, scored=todo)
    json.dump(res, open(os.path.join(RES, "test.json"), "w"), indent=1, default=float)
    md = f"# Ladder A-C, WTICO/USD M5, test (scored once)\n\nWindow: {res['window']}.\n\n" + table(rows)
    open(os.path.join(RES, "test.md"), "w").write(md + "\n")
    print(md)


if __name__ == "__main__":
    {"dev": dev, "final": final}[sys.argv[1]]()
