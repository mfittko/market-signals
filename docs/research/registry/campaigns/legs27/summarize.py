"""legs27 report: out/results.json -> out/report.txt"""
import os, json
HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "out", "results.json")))
f = lambda c: f"{c[0]:+.3f} [{c[1]:+.3f},{c[2]:+.3f}]"
p = lambda c: f"{c[0]:.3f} [{c[1]:.3f},{c[2]:.3f}]"
INS = ["WTICO_USD", "XAU_USD", "XAG_USD", "EUR_USD", "SPX500_USD", "NATGAS_USD"]
L = [f"legs27 verdict: {R['verdict']} (2023+ is a development window, not a holdout)", ""]
for m, v in R["primary"]["H1"].items():
    L.append(f"H1 PRIMARY WTI M5 N6 {m}: chop-clean P(clear) dev {f(v['dev'])} | 2023+ {f(v['w2023'])} | PASS={v['PASS']}")
v = R["primary"]["H2"]
L.append(f"H2 PRIMARY WTI L0.6: race_d dev {f(v['race_d']['dev'])} 2023+ {f(v['race_d']['w2023'])} PASS={v['race_PASS']} | "
         f"sess dev {f(v['sess']['dev'])} 2023+ {f(v['sess']['w2023'])} PASS={v['sess_PASS']}")
L.append("")
L.append("== H1 WTI M5 N6 per quintile: n | P(clear) | P(nodir) | mean |mv|/ATR | P(cont) | signed cont")
for m in ("er", "wick", "r2s"):
    for w in ("dev", "w2023"):
        c = R["h1"][f"WTICO_USD_M5_{m}_N6"][w]
        for q in range(5):
            L.append(f"{m:4s} {w:5s} Q{q + 1} n {c['n_q'][q]:7d} | {p(c['p_clear'][q])} | {p(c['p_nodir'][q])} | {c['mean_absatr'][q][0]:.3f} | "
                     f"{p(c['p_cont'][q])} | {f(c['mean_signed_cont'][q])}")
        L.append(f"{m:4s} {w:5s} chop-clean: clear {f(c['diff_clear'])} nodir {f(c['diff_nodir'])} cont {f(c['diff_cont'])} "
                 f"signed {f(c['diff_signed_cont'])}")
L.append("")
L.append("== H1 chop minus clean P(clear), all instruments / TF / N (dev | 2023+)")
for tf in ("M5", "M1", "M15"):
    for m in ("er", "wick", "r2s"):
        for ins in INS:
            row = []
            for N in (3, 6, 12):
                c = R["h1"].get(f"{ins}_{tf}_{m}_N{N}")
                if c:
                    row.append(f"N{N} {f(c['dev']['diff_clear'])} | {f(c['w2023']['diff_clear'])}")
            L.append(f"{tf} {m:4s} {ins:10s} " + "  ".join(row))
L.append("")
L.append("== H1 chop quintile continuation (M5 N6): P(cont) chop / clean, signed cont chop (dev | 2023+)")
for m in ("er", "wick", "r2s"):
    from legs27 import CHOP_Q, CLEAN_Q  # noqa: E402
    for ins in INS:
        c = R["h1"][f"{ins}_M5_{m}_N6"]
        L.append(f"{m:4s} {ins:10s} " + " | ".join(
            f"{w} cont {c[w]['p_cont'][CHOP_Q[m]][0]:.3f}/{c[w]['p_cont'][CLEAN_Q[m]][0]:.3f} signed {f(c[w]['mean_signed_cont'][CHOP_Q[m]])}"
            for w in ("dev", "w2023")))
L.append("")
L.append("== H2 M5: n (resolved) | P(race) vs null | race_d | P(counter) vs null | counter_d | sess | h12 | h48 | fade_net")
for ins in INS:
    for Lv in (0.3, 0.6, 1.0):
        for sub in ("all", "hindsight"):
            for w in ("dev", "w2023"):
                c = R["h2"].get(f"{ins}_L{Lv}_{sub}", {}).get(w)
                if not c:
                    continue
                L.append(f"{ins:10s} L{Lv} {sub:9s} {w:5s} n {c['n']:5d} ({c['n_resolved']:5d}) | {c['race'][0]:.3f} vs {c['race_null']:.3f} | "
                         f"{f(c['race_d'])} | {c['counter'][0]:.3f} vs {c['counter_null']:.3f} | {f(c['counter_d'])} | {f(c['sess'])} | "
                         f"{f(c['h12'])} | {f(c['h48'])} | {f(c['fade_net'])}")
open(os.path.join(HERE, "out", "report.txt"), "w").write("\n".join(L) + "\n")
print("\n".join(L))
