"""Tally of gross-ATR CI signs over all logged lead35 cells (lag condition and nolag control)."""
import json, os
R = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "results.json")))
tot = pos = neg = 0; both = []
for r in R["results"]:
    for key in r["dev"]:
        if key == "xcorr": continue
        for hk, c in r["dev"][key].items():
            if not hk.startswith("h") or "gross_atr" not in c: continue
            for w in ("dev", "w2023"):
                x = r[w][key][hk]
                if "gross_atr" not in x: continue
                tot += 1; lo, hi = x["gross_atr"]["ci"]; pos += lo > 0; neg += hi < 0
            d, e = r["dev"][key][hk], r["w2023"][key][hk]
            if "gross_atr" in d and "gross_atr" in e and d["gross_atr"]["ci"][0] > 0 and e["gross_atr"]["ci"][0] > 0:
                both.append((r["tf"], r["pair"], key, hk, round(d["gross_atr"]["mean"], 3), round(e["gross_atr"]["mean"], 3), round(d["net_atr"]["mean"], 2), round(e["net_atr"]["mean"], 2)))
print("cells", tot, "CI>0", pos, "CI<0", neg); print("CI>0 in both windows:", *both, sep="\n")
netpos = sum(1 for r in R["results"] for w in ("dev","w2023") for k,v in r[w].items() if k!="xcorr" for hk,c in v.items() if hk.startswith("h") and "net_atr" in c and c["net_atr"]["ci"][0] > 0)
print("net CI>0 cells", netpos)
