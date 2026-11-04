"""Evaluator audit v1, item 4: holdout lineage record, extracted from the campaign files (read-only).

Times in trials.jsonl, ledgers and frozen files are local time (+0200, the operator machine); GitHub times are UTC.
  python lineage.py     writes out/lineage.json
"""
import os, sys, json, hashlib, time
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
ENGINE = os.path.dirname(os.path.dirname(HERE))
TZ = "+0200"


def trials():
    groups, prereg = {}, []
    for line in open(os.path.join(ENGINE, "trials.jsonl")):
        r = json.loads(line)
        k = (r.get("exp"), r.get("mode"), r.get("inst"), r.get("version"))
        g = groups.setdefault(k, dict(exp=k[0], mode=k[1], inst=k[2], version=k[3], first=r["ts"], last=r["ts"], n=0))
        g["last"] = r["ts"]; g["n"] += 1
        if r.get("mode") == "prereg":
            prereg.append({x: r.get(x) for x in ("ts", "inst", "version", "e_label", "mue_R", "multiple_comparisons", "grid", "schedule")})
    return sorted(groups.values(), key=lambda g: g["first"]), prereg


def mtime(p):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(os.path.getmtime(os.path.join(ENGINE, p))))


def main():
    groups, prereg = trials()
    ledgers = {f: [json.loads(l) for l in open(os.path.join(ENGINE, f))] for f in ("test_ledger.jsonl", "test_ledger_de.jsonl")}
    files = {p: mtime(p) for p in ("ladder.py", "de.py", "labels.py", "fills.py", "validate.py", "nulls.py", "gate.py", "bars.py",
                                   "frozen.json", "frozen_de.json", "results/test.json", "results/de_test_WTICO_USD.json",
                                   "results/de_test_XAU_USD.json", "cache/dryrun_ledger.jsonl", "cache/dry.log")}
    github_utc = {"309 A-C verdict": "2026-10-07T20:50:05Z", "310 D-E interim": "2026-10-07T21:04:53Z",
                  "308 evaluator-audit addendum": "2026-10-07T21:36:47Z", "310 calibration/representation addendum": "2026-10-07T21:37:59Z"}
    fz = json.load(open(os.path.join(ENGINE, "frozen.json")))
    events = [
        ("harness code written (bars..sens)", files["bars.py"] + TZ),
        ("A-C dev + freeze (frozen.json)", fz["frozen_at"] + TZ),
        ("A-C single test look 2023-01-01..2026-10-07 (test_ledger.jsonl)", ledgers["test_ledger.jsonl"][0]["ts"] + TZ),
        ("A-C verdict posted (GitHub)", github_utc["309 A-C verdict"]),
        ("D-E preregistration v1 (trials.jsonl mode=prereg)", next(p["ts"] for p in prereg) + TZ),
        ("D-E preregistration v2 after v1 dev results (E label, p grid, windows)", next(p["ts"] for p in prereg if p["version"] == 2) + TZ),
        ("D-E dry run on 2022 dev data", files["cache/dry.log"] + TZ),
        ("de.py last modified (after the dry run, before the test look)", files["de.py"] + TZ),
        ("D-E single test look WTI (test_ledger_de.jsonl)", ledgers["test_ledger_de.jsonl"][0]["ts"] + TZ),
        ("D-E single test look XAU", ledgers["test_ledger_de.jsonl"][-1]["ts"] + TZ),
        ("D-E interim verdict posted (GitHub)", github_utc["310 D-E interim"]),
    ]
    feedback = [
        dict(source="A-C test look (C beats A by +0.19 R/trade but not the same-tod null: a spread/session effect)",
             decision="carried-forward spread rule SPR_MAX = 0.2 R for every later policy (de.py docstring: 'Carried constraint from 309')",
             affected="D-E candidate population and every D/E result on the SAME 2023-2026 window",
             note="the 0.208 threshold itself was set on dev data (frozen.json 20:01:59); adopting it as a hard rule was decided after the test look"),
        dict(source="A-C test look (B volatility gate adds nothing as a flip filter)",
             decision="D-E reuses the spike-4 gate as an episode opener with fired/armed variants; gate state split reported again",
             affected="D-E design (gate grid)", note="design feedback, not label fitting"),
        dict(source="D-E dev v1 results (E label net_R > 0, base 0.18)", decision="prereg v2: E label = arm, p grid 0.40-0.65, quarterly E windows",
             affected="E (dev only, before any D-E test look)", note="allowed on development data; the trial family includes v1 attempts"),
    ]
    looks = [dict(window="2023-01-01..2026-10-07", inst="WTICO/USD", variants=[r["variant"] for r in ledgers["test_ledger.jsonl"]] +
                  [r["variant"] for r in ledgers["test_ledger_de.jsonl"] if r["inst"] == "WTICO/USD"]),
             dict(window="2023-01-01..2026-10-07", inst="XAU/USD", variants=[r["variant"] for r in ledgers["test_ledger_de.jsonl"] if r["inst"] == "XAU/USD"])]
    gaps = ["ledger entries carry a config hash, timestamp and data_to, but no code version or code hash: which de.py scored the test cannot be "
            "proven after de.py changed between the dry run and the test look",
            "each campaign applies Bonferroni only inside its own instrument family (A-C: none; D-E: k=5); the 2023-2026 WTI window received "
            "8 frozen-variant looks across two campaigns, which no correction covers jointly",
            "trials.jsonl rows of D-E dev v1 carry no version field; they are counted in the dev trial total but cannot be separated from v2 rows"]
    res = dict(events=events, trial_groups=groups, preregistrations=prereg, ledgers=ledgers, file_mtimes_local=files, github_utc=github_utc,
               feedback_edges=feedback, looks_on_window=looks, gaps=gaps,
               classification=("2023-01-01..2026-10-07 is development evidence for WTICO/USD and XAU/USD in any further campaign: it has been "
                               "scored for 8 (WTI) and 5 (XAU) frozen variants, and the A-C test outcome shaped the D-E design that was then "
                               "scored on the same window. A positive claim needs data after 2026-10-07T18:38Z (WTI) / 20:27Z (XAU), "
                               "or prospective capture under #313, with the total comparison family registered."))
    json.dump(res, open(os.path.join(OUT, "lineage.json"), "w"), indent=1)
    for e in events:
        print(f"{e[1]}  {e[0]}")
    for g in groups:
        print(g)
    print(json.dumps(looks))


if __name__ == "__main__":
    main()
