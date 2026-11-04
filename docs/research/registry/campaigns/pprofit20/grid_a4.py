"""A4 grid summary: out/results_*_<TF>_H<H>_<tgt>.json (+ artifacts) -> out/report_horizons.txt"""
import os, json
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "NATGAS/USD", "SPX500/USD", "EUR/USD"]
f3 = lambda x: f"{x:+.3f}"
pc = lambda x: f"{100 * x:.1f}"


def best(dec):
    """Best supported decile by mean R: (decile, meanR, ci)."""
    s = [d for d in dec if d["n"] >= 1000]
    d = max(s, key=lambda d: d["meanR"])
    return d["decile"], d["meanR"], d["meanR_ci"]


L = ["# pprofit20 A4 horizons grid (development evidence; nothing qualified)", "",
     "Per cell: pass; per window (dev 2019-22 | 2023+) and side (L/S): AUC LR / spread-only, P10/P50/P90 (%), best supported decile "
     "mean R [95% day-block CI]. QUAL = deciles meeting mean R >= +0.05 with CI low > 0 (per window, and full-OOS artifact lookup).", ""]
hits = []
for tf in ("M5", "M1", "M15"):
    for h in (12, 48):
        for tg in ("plan", "up"):
            L.append(f"## {tf} H{h} {tg}")
            L.append("| inst | pass | window | side | n | base | mean R | AUC | AUC spr | P10/50/90 | max gap | best dec R [CI] |")
            L.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
            for inst in INSTS:
                tag = f"{inst.replace('/', '_')}_{tf}_H{h}_{tg}"
                f = os.path.join(OUT, f"results_{tag}.json")
                if not os.path.exists(f):
                    L.append(f"| {inst} | MISSING | | | | | | | | | | |"); continue
                r = json.load(open(f))
                for w, W in r["windows"].items():
                    for s in ("long", "short"):
                        e = W["lr"][s]; b = best(e["deciles"])
                        q = [d["decile"] for d in e["deciles"] if d["n"] >= 1000 and d["meanR"] >= 0.05 and d["meanR_ci"][0] > 0]
                        if q:
                            hits.append(f"{tf} H{h} {tg} {inst} {w} {s} deciles {q}")
                        L.append(f"| {inst} | {'PASS' if r['calib_pass'] else 'FAIL'} | {w} | {s} | {e['n']} | {pc(e['base'])} | {f3(e['meanR'])} | "
                                 f"{e['auc']:.3f} | {W['auc_spread_only'][s]:.3f} | {'/'.join(pc(x) for x in e['p_q'])} | {e['max_abs_gap']:.3f} | "
                                 f"d{b[0]} {f3(b[1])} [{f3(b[2][0])}, {f3(b[2][1])}] |")
                a = os.path.join(OUT, f"artifact_{tag}_pprofit20.json")
                if os.path.exists(a):
                    A = json.load(open(a))
                    for s in ("long", "short"):
                        E = A["expected_R"][s]
                        q = [d + 1 for d, (m, c) in enumerate(zip(E["meanR"], E["meanR_ci"])) if c and m >= 0.05 and c[0] > 0]
                        if q:
                            hits.append(f"{tf} H{h} {tg} {inst} artifact {s} deciles {q} ({A['status'][:40]})")
            L.append("")
L.insert(4, "QUAL hits: " + ("; ".join(hits) if hits else "none") + "\n")
open(os.path.join(OUT, "report_horizons.txt"), "w").write("\n".join(L) + "\n")
print(L[4])
