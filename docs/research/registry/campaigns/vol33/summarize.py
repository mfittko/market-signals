"""Print vol33 tables from out/results.json -> out/report.txt."""
import os, json
HERE = os.path.dirname(os.path.abspath(__file__))
Z = json.load(open(os.path.join(HERE, "out", "results.json")))
f = lambda x: "   -  " if x is None else f"{x:+.3f}"
c = lambda d: f"[{d['ci'][0]:+.3f},{d['ci'][1]:+.3f}]" if d and d.get("ci") else "[   -   ]"
L = [f"VERDICT (WTI M5, H1 top 1% / H2 top 2%, gross, Holm over 2): {Z['verdict']}"]
for k, v in Z["primary"].items():
    L.append(f"  {k}: " + " | ".join(f"{w} p {v[w]['p_one']:.3f} holm {v[w]['p_holm']:.3f} lb {v[w]['lb_holm']:+.3f}"
                                      for w in ("dev", "w2023")) + f" PASS {v['PASS']}")
KS = ["H1q99.0", "H2q98.0", "FADEALL", "H1q99.5", "H1q95.0", "H2q99.5", "H2q95.0"]
L += ["", "signals before the one-trade filter dev/2023+ (" + ", ".join(KS) + ")"]
for r in Z["results"]:
    L.append(f"{r['inst']:11s} {r['tf']:3s} " + "  ".join(f"{r['signals'][k]['dev']}/{r['signals'][k]['w2023']}" for k in KS))
L += ["", "== trades: n, gross [CI], MDE80, p, net [CI], hit, per day, longs, median spread/R"]
for k in KS:
    L.append(f"-- {k}")
    for r in Z["results"]:
        for w in ("dev", "w2023"):
            x = r[w][k]; g, n = x["gross"], x["net"]
            if g["n"] < 2:
                L.append(f"{r['inst']:11s} {r['tf']:3s} {w:5s} n {g['n']}"); continue
            L.append(f"{r['inst']:11s} {r['tf']:3s} {w:5s} n {g['n']:6d} {f(g['mean'])} {c(g)} {g['mde80']:.3f} p {g['p_one']:.3f} "
                     f"net {f(n['mean'])} {c(n)} hit {g['hit']:.3f} {x['per_day']:.2f}/d L {x['longs']} spr {x['spr_med']:.3f}")
L += ["", "== H1 (top 1%) minus all fast-move fades, gross diff [CI] MDE80"]
for r in Z["results"]:
    L.append(f"{r['inst']:11s} {r['tf']:3s} " + " | ".join(
        f"{w} {f(r[w]['H1_minus_FADEALL'] and r[w]['H1_minus_FADEALL']['diff'])} {c(r[w]['H1_minus_FADEALL'])}" for w in ("dev", "w2023")))
L += ["", "== H3 range ratio spike/normal (hour-matched): q: n_spike ratio [CI]"]
for r in Z["results"]:
    for w in ("dev", "w2023"):
        L.append(f"{r['inst']:11s} {r['tf']:3s} {w:5s} " + " | ".join(
            f"{q} {h['n_spike']:6d} {h['ratio']:.3f} [{h['ci'][0]:.3f},{h['ci'][1]:.3f}]" for q, h in r["H3"][w].items()))
open(os.path.join(HERE, "out", "report.txt"), "w").write("\n".join(L) + "\n")
print("\n".join(L))
