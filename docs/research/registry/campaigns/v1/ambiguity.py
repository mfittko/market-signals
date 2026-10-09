"""Evaluator audit v1, item 3b: intrabar-ordering bounds for A-C and D on WTICO/USD (development diagnostic).

Recomputes the frozen trade sets on already-scored data WITHOUT the ledger and WITHOUT a verdict (deterministic
reproduction check against results/test.json and results/de_test_WTICO_USD.json), then reports per variant:
  pess      harness result (stop first; the published number)
  hopt      harness optimistic bound (labels.simulate optimistic=True; contains the inadmissible path of fixture F8)
  adm       admissible optimistic bound (fixtures.ref_one mode adm)
  m1        ambiguous M5 bars resolved with the M1 bid/ask sub-bars (finer data that exists in history.db)
with moving-block day-bootstrap 95% intervals (and Bonferroni k=5 for D, as in de.final), plus whether any admissible
ordering can move a disposition across the 0.05 R minimum useful effect.

  python ambiguity.py      writes out/ambiguity.json and out/ambiguity.md
"""
import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.environ["ENGINE_TRIALS"] = os.path.join(OUT, "diag_trials.jsonl")
ENGINE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ENGINE); sys.path.insert(0, HERE)
import numpy as np
import ladder, de, gate
from labels import POLICY
from validate import year_start_day, day_boot, ci
from fixtures import ref_one

MUE = 0.05


def m1_first(m1, B):
    b5 = m1["t"] // 5
    u, first = np.unique(b5, return_index=True)
    assert np.array_equal(u * 5, B["t"])
    return first


def bounds(B, M1, first, i, s, flip, O):
    pess = ladder.look(O[False], i, s, "net_R"); hopt = ladder.look(O[True], i, s, "net_R")
    amb = ladder.look(O[False], i, s, "amb")
    adm, m1r, chk, chko, resid, inadm = pess.copy(), pess.copy(), 0, 0, 0, 0
    for k in range(len(i)):
        rp = ref_one(B, int(i[k]), int(s[k]), B["atr"][i[k]], flip, POLICY, "pess")
        chk += not np.isclose(rp["net_R"], pess[k], atol=1e-12)
        if amb[k] or rp["amb"]:
            ro = ref_one(B, int(i[k]), int(s[k]), B["atr"][i[k]], flip, POLICY, "hopt")
            chko += not np.isclose(ro["net_R"], hopt[k], atol=1e-12)
            ra = ref_one(B, int(i[k]), int(s[k]), B["atr"][i[k]], flip, POLICY, "adm")
            rm = ref_one(B, int(i[k]), int(s[k]), B["atr"][i[k]], flip, POLICY, "m1", M1, first)
            adm[k], m1r[k] = ra["net_R"], rm["net_R"]
            resid += rm["m1_residual"]; inadm += not np.isclose(ra["net_R"], hopt[k], atol=1e-12)
        else:
            chko += not np.isclose(hopt[k], pess[k], atol=1e-12)
    return dict(pess=pess, hopt=hopt, adm=adm, m1=m1r, amb=amb), dict(ref_mismatch_pess=int(chk), ref_mismatch_hopt=int(chko),
                                                                      m1_residual_ambiguous=int(resid), hopt_inadmissible=int(inadm))


def summarize(name, day, all_days, V, info, k=1):
    out = dict(variant=name, trades=int(len(day)), ambiguity=float(V["amb"].mean()), **info)
    for key in ("pess", "hopt", "adm", "m1"):
        x = V[key]
        bs = day_boot(day, all_days, lambda ix: x[ix].mean(), 2000)
        out[key] = dict(meanR=float(x.mean()), ci95=ci(bs), ci_bonf=ci(bs, (2.5 / k, 100 - 2.5 / k)))
    lo = min(out[k_]["ci_bonf"][0] for k_ in ("pess", "adm", "m1")); hi = max(out[k_]["ci_bonf"][1] for k_ in ("pess", "adm", "m1"))
    out["range_bonf"] = [lo, hi]
    disp = lambda c: "supported-side" if c[0] > MUE else ("rejected-side" if c[1] < MUE else "inconclusive")
    out["disposition_by_bound"] = {k_: disp(out[k_]["ci_bonf"]) for k_ in ("pess", "adm", "m1")}
    out["can_change"] = len(set(out["disposition_by_bound"].values())) > 1
    return out


def ac(window):
    fz = json.load(open(os.path.join(ENGINE, "frozen.json")))
    m1, B = ladder.build(ladder.DEV_END if window == "dev" else None)
    O = ladder.outcomes(B)
    first = m1_first(m1, B)
    if window == "test":
        lo_day, hi_day = year_start_day(2023), int(B["day"][-1]) + 1
    else:
        lo_day, hi_day = year_start_day(2019), year_start_day(2023)
    T = ladder.a_trades(B, O, lo_day, hi_day)
    _, _, all_days = ladder.window_bars(B, lo_day, hi_day)
    rows = []
    sets = {"A": np.ones(len(T["i"]), bool)}
    if window == "test":
        L = gate.day_layer(m1)
        rk = ladder.gate_ranks(L, fz["B"]["lr"])
        sets["B"] = ladder.rank_at(L, rk, T["day"]) >= fz["B"]["q"]
        sets["C"] = ladder.c_mask(T, {k: tuple(v) for k, v in fz["C"]["thresholds"].items()})
    for name, keep in sets.items():
        V, info = bounds(B, m1, first, T["i"][keep], T["s"][keep], B["flip"], O)
        rows.append(summarize(f"{name} ({window})", T["day"][keep], all_days, V, info))
    return rows


def d(window):
    inst = "WTICO/USD"
    fz = json.load(open(de.FROZEN))[inst]
    m1, B, O, L = de.prep(inst, de.DEV_END if window == "dev" else None)
    first = m1_first(m1, B)
    GS = de.gate_states(B, L, fz["gate"])
    if window == "test":
        lo_day, hi_day = year_start_day(2023), int(B["day"][-1]) + 1
    else:
        lo_day, hi_day = year_start_day(2019), year_start_day(2023)
    _, _, all_days = de.window_bars(B, lo_day, hi_day)
    rows = []
    for name, cfg in (("D", de.as_cfg(fz["d_cfg"])), ("D_nogate", (("none", None), fz["d_cfg"][1], fz["d_cfg"][2]))):
        R = de.run_d(B, O, GS, cfg)
        T = de.trades(B, O, R["entries"])
        T = de.sel(T, (T["day"] >= lo_day) & (T["day"] < hi_day))
        V, info = bounds(B, m1, first, T["i"], T["s"], B["flip"], O)
        rows.append(summarize(f"{name} ({window})", T["day"], all_days, V, info, k=5))
    return rows


def main():
    rows = ac("test") + d("test") + ac("dev") + d("dev")
    pub = {"A (test)": json.load(open(os.path.join(ENGINE, "results", "test.json")))["rows"][0],
           "B (test)": json.load(open(os.path.join(ENGINE, "results", "test.json")))["rows"][1],
           "C (test)": json.load(open(os.path.join(ENGINE, "results", "test.json")))["rows"][2]}
    dt = json.load(open(os.path.join(ENGINE, "results", "de_test_WTICO_USD.json")))
    pub["D (test)"] = next(r for r in dt["rows"] if r["variant"] == "D: frozen")
    pub["D_nogate (test)"] = next(r for r in dt["rows"] if r["variant"].startswith("D-nogate"))
    for r in rows:
        p = pub.get(r["variant"])
        if p:
            r["reproduces_published"] = dict(trades=p["trades"] == r["trades"], meanR=abs(p["meanR"] - r["pess"]["meanR"]) < 1e-9,
                                             meanR_optimistic=abs(p["meanR_optimistic"] - r["hopt"]["meanR"]) < 1e-9,
                                             ambiguity=abs(p["ambiguity"] - r["ambiguity"]) < 1e-12)
    json.dump(rows, open(os.path.join(OUT, "ambiguity.json"), "w"), indent=1, default=float)
    c = lambda v: f"[{v[0]:+.3f}, {v[1]:+.3f}]"
    md = ["| Variant | Trades | Ambiguous | pess R/trade [CI] | harness opt | admissible opt [CI] | M1-resolved [CI] | range (Bonf for D) | can change disposition | ref==harness | M1 residual amb | inadmissible hopt | reproduces published |",
          "|" + "---|" * 13]
    for r in rows:
        md.append(f"| {r['variant']} | {r['trades']} | {r['ambiguity']:.3f} | {r['pess']['meanR']:+.3f} {c(r['pess']['ci95'])} | {r['hopt']['meanR']:+.3f} | "
                  f"{r['adm']['meanR']:+.3f} {c(r['adm']['ci95'])} | {r['m1']['meanR']:+.3f} {c(r['m1']['ci95'])} | {c(r['range_bonf'])} | "
                  f"{'yes' if r['can_change'] else 'no'} ({', '.join(f'{k}: {v}' for k, v in r['disposition_by_bound'].items())}) | "
                  f"{'yes' if r['ref_mismatch_pess'] == 0 and r['ref_mismatch_hopt'] == 0 else 'NO'} | {r['m1_residual_ambiguous']} | {r['hopt_inadmissible']} | "
                  f"{json.dumps(r.get('reproduces_published', '-'))} |")
    open(os.path.join(OUT, "ambiguity.md"), "w").write("\n".join(md) + "\n")
    print("\n".join(md))


if __name__ == "__main__":
    main()
