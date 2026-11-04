"""bench1 control and real-data tables.

  python summarize.py controls dev|final     -> out/controls_<set>.md/.json
  python summarize.py real                   -> out/real.md (from out/real_<pop>.json)
"""
import os, sys, json
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "v1"))
from power import wilson  # audit v1 helper

LEARNERS = ("lr_base", "lr_eng", "hgb_eng", "mr_lr", "ts_lr", "tscomb_lr", "tscomb_hgb", "oracle")
BINS = [-np.inf, 0.0, 0.05, 0.1, 0.2, 0.4, np.inf]


def sup(x, k="3"):
    return (x or {}).get("verdict", {}).get(k) == "supported"


def stage(x):
    c = (x or {}).get("cause", "error")
    if c == "available":
        v = x.get("verdict", {}).get("3")
        return "qualified" if v == "supported" else ("qual: " + v if v in ("inconclusive", "rejected") else "qual: < 2 trades")
    for p in ("support", "calibration", "threshold: support", "threshold: gate"):
        if c.startswith(p):
            return p
    return "error"


def fr(k, n):
    lo, hi = wilson(k, n)
    return f"{k}/{n} ({lo:.2f}-{hi:.2f})"


def controls(which):
    rs = [json.loads(l) for l in open(os.path.join(OUT, f"controls_{which}.jsonl"))]
    fatal = [r for r in rs if "fatal" in r]; rs = [r for r in rs if "fatal" not in r]
    v2 = {}
    p2 = os.path.join(os.path.dirname(HERE), "v2", "out", f"controls_v2_{which}.jsonl")
    if os.path.exists(p2):
        for l in open(p2):
            r = json.loads(l)
            v2[(r["kind"], r["mu"], r["seed"])] = r
    planted = [r for r in rs if r["kind"] in ("linear", "interaction", "subset")]
    md = [f"# bench1 planted-drift controls ({which} seeds): {len(rs)} realizations, fatal {len(fatal)}", "",
          "Supported = qualified under evaluator v2 V4 (Bonferroni k=3). Bin = realized economic value (oracle-policy R/trade, control test window 2020-2022).",
          "hgb_base(v2) = the v2 audit's HGB on the existing E features for the same realizations (from audit/v2/out).", ""]
    cols = list(LEARNERS) + ["hgb_base(v2)"]
    md += ["| economic value bin | n | " + " | ".join(cols) + " | oracle POLICY ceiling |", "|---|---|" + "---|" * (len(cols) + 1)]
    res = dict(n=len(rs), fatal=len(fatal), bins=[], nulls={}, auc={}, stages={})
    getv2 = lambda r: v2.get((r["kind"], r["mu"], r["seed"]), {}).get("hgb", {}).get("V4")
    for a, b in zip(BINS[:-1], BINS[1:]):
        g = [r for r in planted if a <= r["econ"]["meanR"] < b]
        if not g:
            continue
        n = len(g)
        cnt = {L: sum(sup(r.get(L)) for r in g) for L in LEARNERS}
        cnt["hgb_base(v2)"] = sum(sup(getv2(r)) for r in g)
        ceil = sum(r["econ"]["verdict"]["3"] == "supported" for r in g)
        md.append(f"| [{a:+.2f}, {b:+.2f}) | {n} | " + " | ".join(fr(cnt[L], n) for L in cols) + f" | {fr(ceil, n)} |")
        res["bins"].append(dict(bin=[a, b], n=n, supported=cnt, ceiling=ceil))
        res["auc"][f"{a:+.2f}"] = {L: float(np.nanmean([r.get(L, {}).get("auc_test", np.nan) for r in g])) for L in LEARNERS}
        st = {}
        for L in LEARNERS:
            d = {}
            for r in g:
                s = stage(r.get(L)); d[s] = d.get(s, 0) + 1
            st[L] = d
        res["stages"][f"{a:+.2f}"] = st
    md += ["", "False qualification (k=3; k=1/k=5 counts in brackets):", ""]
    for kind in ("null", "null_hidden"):
        g = [r for r in rs if r["kind"] == kind]
        if not g:
            continue
        res["nulls"][kind] = {L: sum(sup(r.get(L)) for r in g) for L in LEARNERS}
        md.append(f"- {kind}: " + "; ".join(f"{L} {fr(sum(sup(r.get(L)) for r in g), len(g))} [{sum(sup(r.get(L), '1') for r in g)}/{sum(sup(r.get(L), '5') for r in g)}]"
                                           for L in LEARNERS))
        res["auc"][kind] = {L: float(np.nanmean([r.get(L, {}).get("auc_test", np.nan) for r in g])) for L in LEARNERS}
    md += ["", "Mean unconditional test AUC of the test model (arm label, test rows 2020-2022):", "",
           "| bin | " + " | ".join(LEARNERS) + " |", "|---|" + "---|" * len(LEARNERS)]
    for k, d in res["auc"].items():
        md.append(f"| {k} | " + " | ".join(f"{d[L]:.3f}" for L in LEARNERS) + " |")
    md += ["", "First failing stage per bin (support -> calibration slope CI -> threshold gate -> qualification):", ""]
    for k, st in res["stages"].items():
        if float(k) >= 0.05:
            md.append(f"- {k}: " + "; ".join(f"{L} {st[L]}" for L in LEARNERS))
    cells = {}
    for r in rs:
        c = cells.setdefault(f"{r['kind']} {r['mu']}", dict(n=0, econ=[], **{L: 0 for L in LEARNERS}))
        c["n"] += 1; c["econ"].append(r["econ"]["meanR"])
        for L in LEARNERS:
            c[L] += sup(r.get(L))
    md += ["", "Per cell (supported " + "/".join(LEARNERS) + "): " + "; ".join(
        f"{k} econ {np.nanmean(c['econ']):+.3f}: " + "/".join(str(c[L]) for L in LEARNERS) + f" of {c['n']}" for k, c in cells.items())]
    secs = {L: float(np.mean([r.get(L, {}).get("secs", np.nan) for r in rs])) for L in LEARNERS}
    md += ["", "Mean seconds per realization and learner (1 thread): " + ", ".join(f"{L} {v:.1f}" for L, v in secs.items()) +
           f"; whole realization {np.mean([r['secs'] for r in rs]):.0f} s.", ""]
    if fatal:
        md += ["Fatal: " + "; ".join(f"{r['kind']} {r['mu']} {r['seed']}: {r['fatal']}" for r in fatal), ""]
    errs = [(r["kind"], r["mu"], r["seed"], L, r[L].get("error")) for r in rs for L in LEARNERS if r.get(L, {}).get("cause") == "error"]
    if errs:
        md += [f"Learner errors ({len(errs)}): " + "; ".join(map(str, errs[:10])), ""]
    open(os.path.join(OUT, f"controls_{which}.md"), "w").write("\n".join(md) + "\n")
    json.dump(res, open(os.path.join(OUT, f"controls_{which}_summary.json"), "w"), indent=1, default=float)
    print("\n".join(md))


def real():
    md = ["# bench1 real WTICO/USD M5 (development evidence; 2023+ is a development window, not a holdout)", ""]
    c2 = lambda v: f"[{v[0]:+.3f}, {v[1]:+.3f}]"
    for pop in ("frozenD", "cfgX"):
        f = os.path.join(OUT, f"real_{pop}.json")
        if not os.path.exists(f):
            md += [f"## {pop}: not run", ""]; continue
        R = json.load(open(f))
        md += [f"## Population {pop}: D {R['cfg']}, data to {R['data_last']}", ""]
        md += ["| fold | rows ok/cand | test rows | D trades, R/trade | " + " | ".join(LEARNERS[:-1]) + " |", "|---|---|---|---|" + "---|" * 7]
        for y, F in R["folds"].items():
            cell = lambda x: (f"{x['cause'].split(':')[0]}; AUC {x.get('auc_test', float('nan')):.3f}" +
                              (f"; {x.get('trades')} tr {x.get('meanR', float('nan')):+.3f}" if x.get("trades") is not None else ""))
            D = F["D"]
            md.append(f"| {y} | {F['rows']['ok']}/{F['rows']['candidates']} | {F['rows']['test']} | {D['trades']}, "
                      f"{(D['meanR'] if D['meanR'] is not None else float('nan')):+.3f} | " + " | ".join(cell(F["learners"][L]) for L in LEARNERS[:-1]) + " |")
        md.append("")
        for part, lab in (("dev", "walk-forward 2020-2022 (out of fold)"), ("w23", "2023-01-01..newest development window")):
            P = R[part]
            md += [f"### {lab}", "", f"Unselected D: {P['D']['trades']} trades, {P['D']['meanR']:+.3f} R/trade {c2(P['D']['ci'])}", "",
                   "| learner | registered V4 D+E | AUC by fold | q=0.5 | q=0.35 | q=0.2 | q=0.1 | calib (Brier vs base, n) |", "|---|---|---|---|---|---|---|---|"]
            for L in LEARNERS[:-1]:
                o = P.get(L, {})
                reg = o.get("registered")
                regs = f"{reg['trades']} tr ({reg['folds_available']} folds) {reg['meanR']:+.3f} {c2(reg['ci'])}; vs D {reg['vs_D'][0]:+.3f} {c2(reg['vs_D'][1])}" if reg else "unavailable in every fold"
                cov = []
                for q in ("0.5", "0.35", "0.2", "0.1"):
                    c = o.get("coverage", {}).get(q)
                    cov.append(f"{c['trades']} tr {c['meanR']:+.3f} {c2(c['ci'])}; vs D {c['vs_D'][0]:+.3f} {c2(c['vs_D'][1])}" if c and "meanR" in c else "-")
                cal = o.get("calibration", {}).get("all", {}).get("scores")
                cals = f"{cal['brier']:.4f} vs {cal['brier_base']:.4f}, n {cal['n']}" if cal else "-"
                aucs = ", ".join(f"{k}: {v:.3f}" for k, v in o.get("auc_by_fold", {}).items())
                md.append(f"| {L} | {regs} | {aucs} | " + " | ".join(cov) + f" | {cals} |")
            md += ["", "Paired differences at q=0.2 (R/trade, day-block bootstrap 95% CI): " +
                   "; ".join(f"{k}: {v[0]:+.3f} {c2(v[1])}" for k, v in P.get("paired_q0.2", {}).items()), ""]
            md.append("Calibration reliability (pooled test rows, Platt from each fold's pooled window; slope-guard failures included as fitted):")
            for L in LEARNERS[:-1]:
                rel = P.get(L, {}).get("calibration", {}).get("all", {}).get("rel")
                if rel:
                    md.append(f"- {L}: " + ", ".join(f"{b['band']} n={b['n']}" + (f" p={b['mean_p']:.2f} obs={b['obs']:.2f}" if b["n"] else "") for b in rel))
            md += ["", "Cost sensitivity at q=0.2 (R/trade and lower CI after an extra cost per trade of 0/0.02/0.05/0.10 R): " + "; ".join(
                f"{L} " + "/".join(f"{v[0]:+.3f}({v[1]:+.3f})" for v in P[L]["coverage"]["0.2"]["cost"].values())
                for L in LEARNERS[:-1] if P.get(L, {}).get("coverage", {}).get("0.2", {}).get("cost")), ""]
    open(os.path.join(OUT, "real.md"), "w").write("\n".join(md) + "\n")
    print("\n".join(md))


if __name__ == "__main__":
    controls(sys.argv[2]) if sys.argv[1] == "controls" else real()
