"""Evaluator v2 control summary and the registered selection rule.

  python power_v2.py dev|final     reads out/controls_v2_<set>.jsonl, writes out/power_v2_<set>.{json,md};
                                   'final' also applies prereg.json's selection rule and writes ../v2/selected.json
"""
import os, sys, json, time
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "audit", "v1"))
from power import wilson  # audit v1 helper

LEARNERS = ("lr", "hgb", "oracle")
VARIANTS = ("V1", "V2", "V3", "V4")
BINS = [-np.inf, 0.0, 0.05, 0.1, 0.2, 0.4, np.inf]
NULL_UPPER = wilson(0, 40)[1]  # the audit's level: 0/40


def sup(r, L, V, k="3"):
    return r.get(L, {}).get(V, {}).get("verdict", {}).get(k) == "supported"


def stage(x):
    c = x.get("cause", "error")
    if c == "available":
        v = x.get("verdict", {}).get("3")
        return "qualified" if v == "supported" else ("qualification: " + v if v in ("inconclusive", "rejected") else "qualification: < 2 trades")
    for p in ("support", "calibration", "threshold: support", "threshold: gate"):
        if c.startswith(p):
            return p
    return "error"


def frac(k, n):
    lo, hi = wilson(k, n)
    return dict(k=k, n=n, rate=k / n if n else float("nan"), ci=[lo, hi])


def main(which):
    rs = [json.loads(l) for l in open(os.path.join(OUT, f"controls_v2_{which}.jsonl"))]
    fatal = [r for r in rs if "fatal" in r]; rs = [r for r in rs if "fatal" not in r]
    planted = [r for r in rs if r["kind"] in ("linear", "interaction", "subset")]
    res = dict(n=len(rs), fatal=len(fatal), variants={})
    for V in VARIANTS:
        curve = []
        for a, b in zip(BINS[:-1], BINS[1:]):
            g = [r for r in planted if a <= r["econ"]["meanR"] < b]
            if not g:
                continue
            n = len(g)
            row = dict(bin=[a, b], n=n, **{L: frac(sum(sup(r, L, V) for r in g), n) for L in LEARNERS})
            row["pooled_lr_hgb"] = frac(sum(sup(r, L, V) for r in g for L in ("lr", "hgb")), 2 * n)
            row["k1"] = {L: sum(sup(r, L, V, "1") for r in g) for L in LEARNERS}
            row["k5"] = {L: sum(sup(r, L, V, "5") for r in g) for L in LEARNERS}
            row["oracle_policy_ceiling"] = frac(sum(r["econ"]["verdict"]["3"] == "supported" for r in g), n)
            row["stages"] = {L: {} for L in LEARNERS}
            for r in g:
                for L in LEARNERS:
                    s = stage(r.get(L, {}).get(V, {}))
                    row["stages"][L][s] = row["stages"][L].get(s, 0) + 1
            row["learner_loss"] = {L: sum(sup(r, "oracle", V) and not sup(r, L, V) for r in g) for L in ("lr", "hgb")}
            curve.append(row)
        nulls = {}
        for kind in ("null", "null_hidden"):
            g = [r for r in rs if r["kind"] == kind]
            nulls[kind] = {L: dict(k3=frac(sum(sup(r, L, V) for r in g), len(g)), k1=sum(sup(r, L, V, "1") for r in g),
                                   k5=sum(sup(r, L, V, "5") for r in g)) for L in LEARNERS}
        cells = {}
        for r in rs:
            c = cells.setdefault(f"{r['kind']} {r['mu']}", dict(n=0, econ=[], **{L: 0 for L in LEARNERS}))
            c["n"] += 1; c["econ"].append(r["econ"]["meanR"])
            for L in LEARNERS:
                c[L] += sup(r, L, V)
        for c in cells.values():
            c["econ"] = float(np.nanmean(c["econ"]))
        res["variants"][V] = dict(curve=curve, nulls=nulls, cells=cells)
    # selection (registered rule)
    elig = {}
    for V in VARIANTS:
        nu = res["variants"][V]["nulls"]
        bad = [f"{kind}/{L}" for kind in ("null", "null_hidden") for L in ("lr", "hgb") if nu[kind][L]["k3"]["k"] > 0]
        bad += ["null/oracle"] if nu["null"]["oracle"]["k3"]["k"] > 0 else []
        elig[V] = bad
    def key(V):
        cv = {tuple(c["bin"]): c for c in res["variants"][V]["curve"]}
        g = lambda b, f: f(cv[b]) if b in cv else 0.0
        return (g((0.1, 0.2), lambda c: c["pooled_lr_hgb"]["rate"]), g((0.1, 0.2), lambda c: c["oracle"]["rate"]),
                g((0.2, 0.4), lambda c: c["pooled_lr_hgb"]["rate"]), g((0.4, np.inf), lambda c: c["pooled_lr_hgb"]["rate"]), -VARIANTS.index(V))
    ok = [V for V in VARIANTS if not elig[V]]
    res["selection"] = dict(null_upper_bound=NULL_UPPER, ineligible={V: b for V, b in elig.items() if b},
                            keys={V: key(V) for V in VARIANTS}, selected=max(ok, key=key) if ok else None)
    json.dump(res, open(os.path.join(OUT, f"power_v2_{which}.json"), "w"), indent=1, default=float)
    md = write_md(res, which)
    open(os.path.join(OUT, f"power_v2_{which}.md"), "w").write(md)
    print(md)
    if which == "final":
        reg = json.load(open(os.path.join(HERE, "prereg.json")))
        sel = dict(variant=res["selection"]["selected"], selected_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"), rule=reg["selection_rule"],
                   prereg_created=reg["created"], code_sha256=reg["code_sha256"], ineligible=res["selection"]["ineligible"],
                   keys=res["selection"]["keys"])
        if sel["variant"]:
            json.dump(sel, open(os.path.join(HERE, "selected.json"), "w"), indent=1, default=float)
        print("SELECTED", sel["variant"])


def write_md(res, which):
    p = lambda d: f"{d['k']}/{d['n']} ({d['ci'][0]:.2f}-{d['ci'][1]:.2f})"
    md = [f"# Evaluator v2 E redesign on the audit controls ({which} seeds; {res['n']} realizations, fatal {res['fatal']})", "",
          "Supported = qualified under the registered rule (Bonferroni k=3). Bins: realized economic value (oracle-policy R/trade on the control test window).", ""]
    for V, x in res["variants"].items():
        md += [f"## {V}", "", "| economic value bin | realizations | LR | HGB | oracle score | LR+HGB pooled | oracle POLICY (ceiling) | LR/HGB/oracle k=1 | k=5 |",
               "|---|---|---|---|---|---|---|---|---|"]
        for c in x["curve"]:
            md.append(f"| [{c['bin'][0]:+.2f}, {c['bin'][1]:+.2f}) | {c['n']} | {p(c['lr'])} | {p(c['hgb'])} | {p(c['oracle'])} | "
                      f"{c['pooled_lr_hgb']['rate']:.3f} | {p(c['oracle_policy_ceiling'])} | {c['k1']['lr']}/{c['k1']['hgb']}/{c['k1']['oracle']} | "
                      f"{c['k5']['lr']}/{c['k5']['hgb']}/{c['k5']['oracle']} |")
        md += ["", "False qualification (k=3; k=1 / k=5 counts in brackets):", ""]
        for kind, d in x["nulls"].items():
            md.append(f"- {kind}: " + "; ".join(f"{L} {p(d[L]['k3'])} [{d[L]['k1']}/{d[L]['k5']}]" for L in LEARNERS))
        md += ["", "First failing stage (planted controls, by bin; learner loss = oracle score qualified but learner not):", ""]
        for c in x["curve"]:
            if c["bin"][0] >= 0.05:
                md.append(f"- [{c['bin'][0]:+.2f}, {c['bin'][1]:+.2f}): " + "; ".join(f"{L} {c['stages'][L]}" for L in LEARNERS) +
                          f"; learner loss LR {c['learner_loss']['lr']}, HGB {c['learner_loss']['hgb']}")
        md.append("")
        md += ["Per cell (supported LR/HGB/oracle): " + "; ".join(f"{k} econ {c['econ']:+.3f}: {c['lr']}/{c['hgb']}/{c['oracle']} of {c['n']}" for k, c in x["cells"].items()), ""]
    s = res["selection"]
    md += ["## Registered selection", "", f"Null bound (audit level): Wilson upper {s['null_upper_bound']:.3f} (0/40).",
           f"Ineligible: {s['ineligible'] or 'none'}.", "Sort keys (pooled LR+HGB [0.10,0.20), oracle [0.10,0.20), pooled [0.20,0.40), pooled [0.40,inf), -index): " +
           "; ".join(f"{V} {tuple(round(v, 3) for v in k)}" for V, k in s["keys"].items()), f"Selected: {s['selected']}.", ""]
    return "\n".join(md)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "final")
