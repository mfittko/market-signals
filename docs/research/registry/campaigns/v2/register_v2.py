"""Writes audit/v2/prereg.json (once) or appends an amendment (python register_v2.py amend "reason").
Records the timestamp and the SHA-256 of the evaluator code and of the control harness."""
import os, sys, json, time, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(os.path.dirname(HERE))
os.environ.setdefault("ENGINE_TRIALS", os.path.join(HERE, "out", "controls_v2_trials.jsonl"))
sys.path.insert(0, ENGINE)
import de_v2

PATH = os.path.join(HERE, "prereg.json")
sha = lambda f: hashlib.sha256(open(os.path.join(HERE, f), "rb").read()).hexdigest()


def hashes():
    return {"evaluator": de_v2.CODE_SHA, "evaluator_files": de_v2.CODE_FILES_SHA,
            **{f: sha(f) for f in ("controls_v2.py", "fixtures_v2.py", "register_v2.py")}}


PREREG = dict(
    title="Evaluator v2: corrections D1-D4 and a registered E redesign, validated on the audit v1 positive controls",
    corrections={
        "D1": "labels_v2.simulate(optimistic=True): a bar that touches the arm level and stop0 (no gap) ends at stop0, or at the "
              "runner target if the high reached it; fixture F8 must pass (audit/v2/fixtures_v2.py)",
        "D2": "an E that was never fitted (or is otherwise unavailable) is reported 'undefined: E unavailable; no verdict', never 'rejected'",
        "D3": "every trial, ledger, control and frozen record carries evaluator='v2' and code_sha256 (digest over de_v2.CODE_FILES)",
        "D4": "support guard (fit >= 200, calibration >= 100 rows) runs before any E fit",
    },
    e_redesign=dict(
        common=["learner unchanged (standardized L2 LR, C=0.1, episode weights; HGB comparator; oracle = planted driver)",
                "accept rule: raw-score cutoff at the (1-q) quantile of the pooled threshold-window candidate scores, "
                "q in E2_QGRID (0.5, 0.35, 0.2, 0.1); minimum coverage 0.10; q* = max window mean R among q with >= 30 policy trades",
                "calibration never changes the accept rule; it can only make E unavailable",
                "qualification: de.verdict (lower CI of mean R > MUE 0.05, lower CI of increment vs D > 0, tail <= 2%, runner "
                "retention >= 0.8, n >= max(100, 30/yr)) with Bonferroni k = number of verdicts issued in the look; references "
                "without a verdict are not counted. Campaign D-E look: D, E, E_novol -> k = 3 (v1 used 5). Controls use k = 3; "
                "k = 1 and k = 5 are reported as sensitivity only"],
        variants=de_v2.E2_VARIANTS,
        windows={"crossfit": "quarterly blocks over the last 8 quarters before the test; each block scored by a model fit on rows "
                             "exiting before the block - 5 days (blocks with < 200 fit rows skipped); scores standardized per model; "
                             "calibration and threshold pooled over scored blocks; test model fit on all rows exiting before test - 5 days",
                 "split6": "one model fit on rows exiting before test - 6 months - 5 days; calibration and threshold pooled over the last 6 months"},
        gates={"abs": "window mean R at q* > 0", "vsD": "window mean R at q* > mean R of D (no selection) in the same window"},
        calib={"platt_ci": "Platt; unavailable unless the episode-clustered 95% CI of the slope is above 0",
               "isotonic": "isotonic non-decreasing; unavailable only if constant"},
        budget="4 variants (V1-V4), no others; all logged in out/controls_v2_*.jsonl"),
    validation=dict(
        controls="audit/v1/controls.py grid, planting, calendar (test 2020-01-01..2022-12-30), D configuration CFG_X, features "
                 "BASEF+VOLF+[c1,c2]",
        seeds={"dev": [1001, 1002, 1003], "final": "2001..2040, run once for the final table"},
        dev_use="design check only (plumbing, timing, gross failure); amendments allowed only before the final run, each "
                "appended with timestamp, reason and new hashes",
        tables=["supported rate per realized economic-value bin (oracle-policy R/trade): [-inf,0), [0,0.05), [0.05,0.10), "
                "[0.10,0.20), [0.20,0.40), [0.40,inf) per learner per variant, Wilson 95%",
                "false qualification on null and null_hidden per learner per variant, Wilson 95% (upper bound reported)",
                "first failing stage: support -> calibration -> threshold (support / gate) -> qualification -> qualified; "
                "learner loss = oracle-score supported minus learner supported; multiplicity effect via k = 1 / 5; "
                "qualification ceiling = verdict of the oracle POLICY itself"]),
    selection_rule=("Eligible: on the final seeds, supported (k=3) count is 0/40 for LR and for HGB on both null and null_hidden, "
                    "and 0/40 for the oracle score on null (oracle on null_hidden sees the hidden driver: a true positive); this "
                    "is the audit's level (0/40, Wilson upper 0.088). Among eligible variants: maximize the pooled LR+HGB supported "
                    "rate in the [0.10, 0.20) economic-value bin; ties broken by oracle-score supported rate in [0.10, 0.20), then "
                    "pooled LR+HGB in [0.20, 0.40), then in [0.40, inf), then the lower variant number. If no variant is eligible, "
                    "no E-v2 is selected and E stays unavailable in evaluator v2."),
    rules="synthetic/planted controls only; nothing scored on 2023-01-01+; v1 code, ledgers and frozen files untouched",
)

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "amend":
        reg = json.load(open(PATH))
        reg["amendments"].append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=sys.argv[2], code_sha256=hashes()))
        reg["code_sha256"] = hashes()
    else:
        assert not os.path.exists(PATH), "already registered; use amend"
        reg = dict(created=time.strftime("%Y-%m-%dT%H:%M:%S%z"), **PREREG, code_sha256=hashes(), amendments=[])
    json.dump(reg, open(PATH, "w"), indent=1, default=float)
    print(json.dumps(reg["code_sha256"], indent=1))
