"""Evaluator v2, corrections D1 and D2 applied to the PUBLISHED A-D results ("correction v2", not a new test).

D1: recompute only meanR_optimistic (the optimistic intrabar bound) of every published row with labels_v2. The trade
sets are rebuilt from the frozen configurations on exactly the scored data (M1 capped at the ledger's data_to), and the
pessimistic numbers must reproduce the published ones exactly; no ledger, no verdict, no selection.
D2: the WTI E / E_novol disposition "rejected" becomes "undefined: E unavailable (never fitted); no verdict".

  python correct_v2.py      writes out/corrections_v2.{json,md}
"""
import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.environ["ENGINE_TRIALS"] = os.path.join(OUT, "corrections_trials.jsonl")
ENGINE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ENGINE)
import numpy as np
import ladder, de, gate, de_v2
from bars import load_m1
from validate import year_start_day

RES = os.path.join(ENGINE, "results")
UNTIL = {"WTICO/USD": "2026-10-07T18:39", "XAU/USD": "2026-10-07T20:28"}  # ledger data_to + 1 minute


def opt_v2(B):
    from labels_v2 import simulate, POLICY
    n = len(B["t"]); idx = np.arange(n)
    return {s: simulate(B, idx, np.full(n, s), B["atr"], B["flip"], POLICY, optimistic=True) for s in (1, -1)}


def row(name, pub, T_i, T_s, O, O2):
    pess = ladder.look(O[False], T_i, T_s, "net_R"); o1 = ladder.look(O[True], T_i, T_s, "net_R"); o2 = ladder.look(O2, T_i, T_s, "net_R")
    r = dict(row=name, trades=int(len(T_i)), meanR=float(pess.mean()), meanR_optimistic_v1=float(o1.mean()),
             meanR_optimistic_v2=float(o2.mean()), changed_trades=int((~np.isclose(o1, o2)).sum()))
    r["reproduces_published"] = dict(trades=pub["trades"] == r["trades"], meanR=abs(pub["meanR"] - r["meanR"]) < 1e-9,
                                     meanR_optimistic=abs(pub["meanR_optimistic"] - r["meanR_optimistic_v1"]) < 1e-9)
    assert all(r["reproduces_published"].values()), r
    return r


def ac():
    fz = json.load(open(os.path.join(ENGINE, "frozen.json")))
    pub = {r["variant"]: r for r in json.load(open(os.path.join(RES, "test.json")))["rows"]}
    m1, B = ladder.build(UNTIL["WTICO/USD"])
    O = ladder.outcomes(B); O2 = opt_v2(B)
    lo, hi = year_start_day(2023), int(B["day"][-1]) + 1
    T = ladder.a_trades(B, O, lo, hi)
    L = gate.day_layer(m1)
    rk = ladder.gate_ranks(L, fz["B"]["lr"])
    keep = {"A": np.ones(len(T["i"]), bool), "B": ladder.rank_at(L, rk, T["day"]) >= fz["B"]["q"],
            "C": ladder.c_mask(T, {k: tuple(v) for k, v in fz["C"]["thresholds"].items()})}
    return [dict(source="results/test.json", **row(v, pub[v], T["i"][k], T["s"][k], O, O2)) for v, k in keep.items()]


def d(inst):
    f = inst.replace("/", "_")
    fz = json.load(open(de.FROZEN))[inst]
    res = json.load(open(os.path.join(RES, f"de_test_{f}.json")))
    pub = {r["variant"]: r for r in res["rows"]}
    m1 = load_m1(inst, UNTIL[inst]); B = de.build(inst, m1); O = ladder.outcomes(B); O2 = opt_v2(B)
    L = de.gate_layer(m1); GS = de.gate_states(B, L, fz["gate"]); dcfg = de.as_cfg(fz["d_cfg"])
    lo = year_start_day(2023)
    te = lambda T: de.sel(T, T["day"] >= lo)
    fi = np.where(B["flip"] != 0)[0]
    fi = fi[np.where(B["flip"][fi] > 0, O[False][1]["ok"][fi], O[False][-1]["ok"][fi])]
    sets = {"A: every flip, immediate (frozen baseline)": te(de.a_trades(B, O, fi)),
            "D-nogate: same follower, always on": te(de.trades(B, O, de.run_d(B, O, GS, (("none", None), dcfg[1], dcfg[2]))["entries"])),
            "D-imm: same gate, enter at discovery": te(de.trades(B, O, de.run_d(B, O, GS, (dcfg[0], "imm", dcfg[2]))["entries"])),
            "D: frozen": te(de.trades(B, O, de.run_d(B, O, GS, dcfg)["entries"]))}
    rows = [dict(source=f"results/de_test_{f}.json", inst=inst, **row(k, pub[k], T["i"], T["s"], O, O2)) for k, T in sets.items()]
    disp = {}
    for e in ("E", "E_novol"):
        er = res["e_rows"].get(e, {})
        old = res["verdicts"].get(e, "")
        if er.get("unavailable"):  # D2
            disp[e] = dict(published=old, correction_v2=f"undefined: E unavailable ({er['unavailable']}); E was never fitted, no test of E, no verdict")
        else:
            disp[e] = dict(published=old, correction_v2="unchanged (E was fitted; the no-trade policy was scored)")
    return rows, {inst: disp}


def main():
    rows = ac()
    disp = {}
    for inst in ("WTICO/USD", "XAU/USD"):
        r, dd = d(inst); rows += r; disp.update(dd)
    amb = {r["variant"]: r for r in json.load(open(os.path.join(ENGINE, "audit", "v1", "out", "ambiguity.json")))}
    xref = {"A": "A (test)", "B": "B (test)", "C": "C (test)", "D: frozen": "D (test)", "D-nogate: same follower, always on": "D_nogate (test)"}
    for r in rows:
        k = xref.get(r["row"])
        if k and (r["source"] == "results/test.json" or (r.get("inst") == "WTICO/USD" and r["row"] != "A")):
            r["audit_admissible_bound"] = amb[k]["adm"]["meanR"]
            r["matches_audit_admissible"] = abs(amb[k]["adm"]["meanR"] - r["meanR_optimistic_v2"]) < 1e-9
    res = dict(label="correction v2 (D1, D2); not a new test", evaluator=de_v2.EVALUATOR_VERSION, code_sha256=de_v2.CODE_SHA,
               code_files_sha256=de_v2.CODE_FILES_SHA, rows=rows, dispositions=disp)
    json.dump(res, open(os.path.join(OUT, "corrections_v2.json"), "w"), indent=1, default=float)
    md = ["## Correction v2 of the published A-D results (D1 bound field, D2 disposition; not a new test)", "",
          "| Source | Row | Trades | R/trade (unchanged) | optimistic bound published (v1) | optimistic bound correction v2 | trades whose bound changed | = audit admissible bound |",
          "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        src = r["source"].replace("results/", "") + (f" {r['inst']}" if "inst" in r else "")
        md.append(f"| {src} | {r['row']} | {r['trades']} | {r['meanR']:+.3f} | {r['meanR_optimistic_v1']:+.3f} | {r['meanR_optimistic_v2']:+.3f} | "
                  f"{r['changed_trades']} | {('yes' if r['matches_audit_admissible'] else 'NO') if 'matches_audit_admissible' in r else '-'} |")
    md += ["", "Dispositions:", ""]
    for inst, dd in disp.items():
        for e, x in dd.items():
            md.append(f"- {inst} {e}: published \"{x['published'][:60]}...\" -> correction v2: {x['correction_v2']}")
    open(os.path.join(OUT, "corrections_v2.md"), "w").write("\n".join(md) + "\n")
    print("\n".join(md))


if __name__ == "__main__":
    main()
