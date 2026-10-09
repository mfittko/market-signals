"""Markdown tables from out/<inst>.json:  python summarize.py WTICO_USD"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(HERE, "out", sys.argv[1] + ".json")))
L = ("lr_base", "lr_eng", "hgb_eng"); T = ("T1", "T2", "T3", "T4")
f = lambda x: "-" if x is None or x != x else f"{x:.3f}"
ci = lambda c: "" if not c or c[0] != c[0] else f" [{c[0]:+.3f}, {c[1]:+.3f}]"
print(f"# {d['inst']}  KX={d['kx']} (2018 base rates {d['kx_rates_2018']})  data {d['data_first']}..{d['data_last']}\n")
pops = list(d["pooled"]["dev"])
print("## Raw AUC by fold (lr_eng / hgb_eng / lr_base); pooled with day-bootstrap CI\n")
print("| Pop | Target | " + " | ".join(d["folds"]) + " | pooled 2019-22 hgb [CI] | 2023+ hgb [CI] | base dev | n dev |")
print("|---|---|" + "---|" * (len(d["folds"]) + 4))
for p in pops:
    for t in T:
        cells = []
        for y, fr in d["folds"].items():
            c = fr[p]["cells"]
            cells.append("/".join(f(c[f"{t}/{n}"].get("auc")) for n in ("lr_eng", "hgb_eng", "lr_base")))
        a = d["pooled"]["dev"][p][f"{t}/hgb_eng"]; b = d["pooled"]["w23"][p][f"{t}/hgb_eng"]
        print(f"| {p} | {t} | " + " | ".join(cells) + f" | {f(a.get('auc'))}{ci(a.get('auc_ci'))} | {f(b.get('auc'))}{ci(b.get('auc_ci'))} | {f(a.get('base'))} | {a.get('n', '-')} |")
print("\n## Pooled AUC all learners (dev | 2023+)\n")
print("| Pop | Target | " + " | ".join(L) + " |\n|---|---|---|---|---|")
for p in pops:
    for t in T:
        row = []
        for n in L:
            a = d["pooled"]["dev"][p][f"{t}/{n}"]; b = d["pooled"]["w23"][p][f"{t}/{n}"]
            row.append(f"{f(a.get('auc'))}{ci(a.get('auc_ci'))} / {f(b.get('auc'))}{ci(b.get('auc_ci'))}")
        print(f"| {p} | {t} | " + " | ".join(row) + " |")
print("\n## T4 Spearman(score, net R) by fold, hgb_eng / lr_eng\n")
for p in pops:
    print(p, {y: "/".join(f(fr[p]["cells"][f"T4/{n}"].get("spearman_netR")) for n in ("hgb_eng", "lr_eng")) for y, fr in d["folds"].items()})
print("\n## Diagnostic calibration (hgb_eng, Platt on V4 pool): Brier vs base, top-quintile mean p vs observed (n)\n")
for p in pops:
    for t in T:
        out = []
        for y, fr in d["folds"].items():
            c = fr[p]["cells"][f"{t}/hgb_eng"].get("cal")
            if not c:
                out.append(f"{y}: -"); continue
            s = c["scores"]; top = c["rel"][-1]
            out.append(f"{y}: brier {s['brier']:.4f} vs {s['brier_base']:.4f}, slope {c['platt']['slope']:.2f}, top p {top.get('mean_p', float('nan')):.2f} obs {top.get('obs', float('nan')):.2f} (n {top['n']})")
        print(f"- {p} {t}: " + "; ".join(out))
print("\n## V4 cause by fold (entry-capable)\n")
for p in pops:
    if p == "P3":
        continue
    for t in T:
        print(f"- {p} {t}: " + "; ".join(f"{y}: " + ", ".join(f"{n}={fr[p]['cells'][f'{t}/{n}'].get('cause')}" + (f"({fr[p]['cells'][f'{t}/{n}'].get('trades')}tr {f(fr[p]['cells'][f'{t}/{n}'].get('meanR'))})" if fr[p]['cells'][f'{t}/{n}'].get('trades') else "") for n in L) for y, fr in d["folds"].items()))
print("\n## Net R (entry-capable): unselected population policy, registered V4, coverage curve q=0.2 and q=0.5 (hgb_eng / lr_eng)\n")
for part in ("dev", "w23"):
    print(f"\n### {part}\n")
    print("| Pop | Unselected D-policy R/trade [CI] (n) | Target | Learner | Registered (n) | q=0.5 R [CI] vs D [CI] (n) | q=0.2 R [CI] vs D [CI] (n) | q=0.2 at +0.05R cost |")
    print("|---|---|---|---|---|---|---|---|")
    for p in pops:
        po = d["pooled"][part][p]
        if "D" not in po:
            continue
        D = po["D"]
        for t in T:
            for n in ("hgb_eng", "lr_eng", "lr_base"):
                o = po[f"{t}/{n}"]; r = o.get("registered")
                reg = f"{f(r['meanR'])}{ci(r['ci'])} ({r['trades']})" if r else "-"
                cv = o.get("coverage", {})
                g = lambda q: (f"{f(cv[q].get('meanR'))}{ci(cv[q].get('ci'))} vs {f(cv[q]["vs_D"][0])}{ci(cv[q]["vs_D"][1])} ({cv[q]["trades"]}; D same folds {f(cv[q]["D_same_folds"]["meanR"])})" if q in cv and "meanR" in cv[q] else "-")
                cost = f(cv["0.2"]["cost"]["0.05"][0]) if "0.2" in cv and "cost" in cv["0.2"] else "-"
                print(f"| {p} | {f(D['meanR'])}{ci(D['ci'])} ({D['trades']}) | {t} | {n} | {reg} | {g('0.5')} | {g('0.2')} | {cost} |")
