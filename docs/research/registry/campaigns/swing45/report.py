"""swing45 report tables from out/results.json (no new outcomes)."""
import json, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "out", "results.json")))["cells"]
RES = ("M1", "M5", "M15", "M30", "H1", "H4", "D")
TRIG = ("down2", "down3", "down4", "down5", "rsi5", "rsi10", "rsi25")


def cell(unit, rs, tg, f, side, w):
    if rs == "D":
        return R.get(f"indices_D_{tg}_daily_long_{w}", {})
    return R.get(f"{unit}_{rs}_{tg}_{f}_{side}_{w}", {})


def fmt(s):
    if s.get("n", 0) < 5:
        return f"n {s.get('n', 0)}"
    sh = s.get("spread_share")
    return (f"n {s['n']}, gross {s['gross']:+.2f}, excess {s['excess']:+.2f} [{s['ci_excess'][0]:+.2f},{s['ci_excess'][1]:+.2f}], "
            f"net {s['net']:+.2f}, hit {s['hit_gross']:.2f}, held {s['bars_held']:.1f}, spread {s['spread_cost']:.2f}"
            f" ({sh:.2f} of |gross|)" + (f", holm p {s['holm_p']:.3f}" if "holm_p" in s else "") +
            f", MDE80 {s['mde80_excess']:.2f}, tpd {s['trades_per_day_per_inst']:.2f}")


def table(unit="indices", side="long"):
    for rs in RES:
        fs = ("daily",) if rs == "D" else ("bar", "daily")
        cs = [(tg, f) for tg in TRIG for f in fs]
        key = lambda c: min(cell(unit, rs, *c, side, "dev").get("excess", -1e9), cell(unit, rs, *c, side, "w2023").get("excess", -1e9))
        srt = sorted(cs, key=key)
        best, med = srt[-1], srt[len(srt) // 2]
        print(f"## {rs}")
        for lab, (tg, f) in (("best", best), ("median", med)):
            for w in ("dev", "w2023"):
                print(f"  {lab} {tg}/{f} {w}: {fmt(cell(unit, rs, tg, f, side, w))}")


def counts():
    for w in ("dev", "w2023"):
        ks = [k for k in R if k.startswith("indices_") and k.endswith(f"_long_{w}") and "_D_" not in k]
        ex = [R[k] for k in ks]
        print(w, "cells", len(ks), "excess>0", sum(s["excess"] > 0 for s in ex), "CI>0", sum(s["ci_excess"][0] > 0 for s in ex),
              "CI<0", sum(s["ci_excess"][1] < 0 for s in ex), "holm pass", sum(s.get("holm_pass", False) for s in ex),
              "net>0", sum(s["net"] > 0 for s in ex))
        for s, k in sorted(zip(ex, ks), key=lambda z: z[0]["holm_p"])[:6]:
            print("  ", k, f"excess {s['excess']:+.2f} se {s['se_excess']:.2f} p {s['p_one_sided']:.4f} holm {s['holm_p']:.3f} net {s['net']:+.2f}")


def per_res_summary(unit="indices", side="long"):
    print(f"# {unit} {side}: median over cells (trigger x filter) of excess / net / spread share")
    for rs in RES:
        fs = ("daily",) if rs == "D" else ("bar", "daily")
        for w in ("dev", "w2023"):
            ss = [cell(unit, rs, tg, f, side, w) for tg in TRIG for f in fs]
            ss = [s for s in ss if s.get("n", 0) >= 5]
            md = lambda k: float(np.median([s[k] for s in ss])) if ss else float("nan")
            print(f"  {rs} {w}: excess {md('excess'):+.2f} gross {md('gross'):+.2f} net {md('net'):+.2f} spread {md('spread_cost'):.2f}"
                  f" share {md('spread_share'):.2f} |gross| {md('abs_gross'):.1f} hit {md('hit_gross'):.2f} held {md('bars_held'):.1f}"
                  f" MDE80 {md('mde80_excess'):.2f} CI>0 {sum(s['ci_excess'][0] > 0 for s in ss)}/{len(ss)} CI<0 {sum(s['ci_excess'][1] < 0 for s in ss)}")


def units():
    for u in sorted({k.split("_M")[0].split("_H")[0] for k in R if not k.startswith("indices")}):
        for rs in RES[:-1]:
            ss = {w: [R.get(f"{u}_{rs}_{tg}_{f}_long_{w}", {}) for tg in TRIG for f in ("bar", "daily")] for w in ("dev", "w2023")}
            line = []
            for w in ("dev", "w2023"):
                v = [s for s in ss[w] if s.get("n", 0) >= 5]
                line.append(f"{w} ex med {np.median([s['excess'] for s in v]):+.2f} net med {np.median([s['net'] for s in v]):+.2f} "
                            f"CI>0 {sum(s['ci_excess'][0] > 0 for s in v)} CI<0 {sum(s['ci_excess'][1] < 0 for s in v)}")
            print(u, rs, " | ".join(line))


if __name__ == "__main__":
    {"table": table, "counts": counts, "summary": per_res_summary, "units": units,
     "short": lambda: (per_res_summary("indices", "short"), table("indices", "short")),
     "t6": lambda: (per_res_summary("trading6"), table("trading6"))}[sys.argv[1]]()
