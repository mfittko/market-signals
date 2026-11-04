"""Evaluator audit v1, item 1 summary: detection / false-qualification / inconclusive rates with Wilson 95% intervals.

  python power.py [final|dev]     reads out/controls_<set>.jsonl, writes out/power_<set>.{json,md}
"""
import os, sys, json
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
LEARNERS = ("lr", "hgb", "oracle")
OUTCOMES = ("supported", "inconclusive", "rejected", "abstain", "error")


def wilson(k, n, z=1.96):
    if n == 0:
        return [float("nan")] * 2
    p = k / n; den = 1 + z * z / n; c = (p + z * z / (2 * n)) / den
    hw = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return [float(c - hw), float(c + hw)]


def rates(rs, name):
    v = [r.get(name, {}).get("verdict", "error") for r in rs]
    n = len(v)
    return {o: dict(k=v.count(o), rate=v.count(o) / n if n else float("nan"), ci=wilson(v.count(o), n)) for o in OUTCOMES}


def cause(rs, name):
    """Where the pipeline lost the planted effect, per realization (first failing layer)."""
    out = {}
    for r in rs:
        x = r.get(name, {})
        v = x.get("verdict")
        if v == "supported":
            c = "qualified"
        elif x.get("platt_slope", 1) <= 0:
            c = "calibration: Platt slope <= 0 (ranking inverted)"
        elif v == "abstain":
            c = "threshold: " + x.get("abstain_cause", "")
        elif v in ("inconclusive", "rejected"):
            c = "qualification/power: " + v
        else:
            c = v or "error"
        out[c] = out.get(c, 0) + 1
    return out


def main(which):
    rs = [json.loads(l) for l in open(os.path.join(OUT, f"controls_{which}.jsonl"))]
    fatal = [r for r in rs if "fatal" in r]
    rs = [r for r in rs if "fatal" not in r]
    cells = {}
    for r in rs:
        cells.setdefault((r["kind"], r["mu"]), []).append(r)
    tab = []
    for (kind, mu), g in sorted(cells.items(), key=lambda kv: (["null", "null_hidden", "linear", "interaction", "subset"].index(kv[0][0]), kv[0][1])):
        e = np.array([x["econ"]["meanR"] for x in g], float); dR = np.array([x["econ"]["dR_vs_D"] for x in g], float)
        row = dict(kind=kind, mu=mu, n=len(g), econ_meanR=float(np.nanmean(e)), econ_sd=float(np.nanstd(e)), econ_dR_vs_D=float(np.nanmean(dR)),
                   D_meanR=float(np.mean([x["D"]["meanR"] for x in g])), label_gap=float(np.nanmean([x["label_gap"] for x in g])),
                   test_rows=float(np.mean([x["rows"]["test"] for x in g])), test_episodes=float(np.mean([x["rows"]["test_episodes"] for x in g])),
                   D_trades=float(np.mean([x["D"]["trades"] for x in g])),
                   cfgW_e_available=float(np.mean([x["cfgW"]["e_available"] for x in g])), cfgW_cal_rows=float(np.mean([x["cfgW"]["cal"] for x in g])))
        for L in LEARNERS:
            row[L] = dict(rates=rates(g, L), cause=cause(g, L),
                          auc_raw_test=float(np.nanmean([x.get(L, {}).get("auc_raw_test", np.nan) for x in g])),
                          platt_neg=float(np.mean([x.get(L, {}).get("platt_slope", 1) <= 0 for x in g])),
                          entered=float(np.mean([x.get(L, {}).get("trades", 0) > 0 for x in g])))
        tab.append(row)
    # pooled power curve over the planted controls, binned by the realized economic value (oracle policy R/trade)
    bins = [-np.inf, 0.0, 0.05, 0.1, 0.2, 0.4, np.inf]
    curve = []
    planted = [r for r in rs if r["kind"] in ("linear", "interaction", "subset")]
    for a, b in zip(bins[:-1], bins[1:]):
        g = [r for r in planted if a <= r["econ"]["meanR"] < b]
        if g:
            curve.append(dict(econ_bin=[a, b], n=len(g), **{L: rates(g, L)["supported"] for L in LEARNERS},
                              inconclusive_lr=rates(g, "lr")["inconclusive"], abstain_lr=rates(g, "lr")["abstain"]))
    res = dict(cells=tab, curve=curve, fatal=len(fatal), n=len(rs))
    json.dump(res, open(os.path.join(OUT, f"power_{which}.json"), "w"), indent=1, default=float)
    pc = lambda d: f"{d['k']}/{n} ({d['ci'][0]:.2f}-{d['ci'][1]:.2f})"
    md = ["| Control | mu | seeds | economic value: oracle-policy R/trade (sd) | dR vs D | D R/trade | test rows / episodes | "
          "LR supported | LR inconcl. | LR rejected | LR abstain | HGB supported | HGB inconcl. | HGB abstain | Oracle-score supported | Oracle abstain | "
          "LR / HGB test raw AUC | WTI-frozen-D E available |", "|" + "---|" * 18]
    for r in tab:
        n = r["n"]
        md.append(f"| {r['kind']} | {r['mu']} | {n} | {r['econ_meanR']:+.3f} ({r['econ_sd']:.3f}) | {r['econ_dR_vs_D']:+.3f} | {r['D_meanR']:+.3f} | "
                  f"{r['test_rows']:.0f} / {r['test_episodes']:.0f} | {pc(r['lr']['rates']['supported'])} | {pc(r['lr']['rates']['inconclusive'])} | "
                  f"{pc(r['lr']['rates']['rejected'])} | {pc(r['lr']['rates']['abstain'])} | {pc(r['hgb']['rates']['supported'])} | "
                  f"{pc(r['hgb']['rates']['inconclusive'])} | {pc(r['hgb']['rates']['abstain'])} | {pc(r['oracle']['rates']['supported'])} | "
                  f"{pc(r['oracle']['rates']['abstain'])} | {r['lr']['auc_raw_test']:.3f} / {r['hgb']['auc_raw_test']:.3f} | "
                  f"{r['cfgW_e_available']:.2f} (cal rows {r['cfgW_cal_rows']:.0f}) |")
    md += ["", "Pooled planted controls by realized economic value (oracle-policy R/trade on the control test window):", "",
           "| economic value bin | realizations | LR supported | HGB supported | Oracle-score supported | LR inconclusive | LR abstain |", "|---|---|---|---|---|---|---|"]
    for c in curve:
        n = c["n"]
        md.append(f"| [{c['econ_bin'][0]:+.2f}, {c['econ_bin'][1]:+.2f}) | {n} | {pc(c['lr'])} | {pc(c['hgb'])} | {pc(c['oracle'])} | "
                  f"{pc(c['inconclusive_lr'])} | {pc(c['abstain_lr'])} |")
    md += ["", "First failing layer per realization (planted controls, LR / HGB / oracle):", ""]
    for r in tab:
        md.append(f"- {r['kind']} mu={r['mu']}: LR {r['lr']['cause']}; HGB {r['hgb']['cause']}; oracle {r['oracle']['cause']}")
    open(os.path.join(OUT, f"power_{which}.md"), "w").write("\n".join(md) + "\n")
    print("\n".join(md)); print("fatal", len(fatal), "n", len(rs))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "final")
