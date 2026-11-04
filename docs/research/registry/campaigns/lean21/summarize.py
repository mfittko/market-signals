import json, os, sys
R = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "results.json")))
f = lambda x: "-" if x is None else f"{x:+.3f}"
def cell(s):
    if not s or s.get("n", 0) == 0:
        return "n=0"
    return f"n={s['n']} d={s['n_days']} cont={s['cont']:.3f} R={f(s['netR'])} [{f(s['ci'][0])},{f(s['ci'][1])}] mde={s['mde80']:.3f}"
def dd(s):
    return "-" if s.get("diff") is None else f"{f(s['diff'])} [{f(s['ci'][0])},{f(s['ci'][1])}]"
for u, byh in R["results"].items():
    for h, byw in byh.items():
        print(f"== {u} {h}  verdict={R['decision'][f'{u}|{h}']['verdict']} p_holm={R['decision'][f'{u}|{h}'].get('p_holm')}")
        for w in ("dev", "w2023"):
            r = byw.get(w)
            if not r:
                continue
            print(f"  {w} MAIN {cell(r['main'])}")
            print(f"     B1 {cell(r['B1'])} | B2 {cell(r['B2'])} | B3 {cell(r['B3'])}")
            print(f"     diff B1 {dd(r['diff_B1'])} B2 {dd(r['diff_B2'])} B3 {dd(r['diff_B3'])} rand {dd(r['diff_random'])} randR {f(r['diff_random'].get('random_side_netR'))}")
            print(f"     surv(NA) {cell(r['survivorship_NOT_available_at_decision'])} | crossed {cell(r['crossed_day_already_big'])}")
            for k, s in r["sens"].items():
                print(f"     k={k} main {cell(s['main'])} diffB1 {dd(s['diff_B1'])}")
        for w in ("2020H1", "2022H1", "2025Q4_26Q1"):
            if w in byw:
                print(f"  {w} MAIN {cell(byw[w]['main'])}")
