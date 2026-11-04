"""Write fm2/prereg.json (refuses to overwrite). python register.py [amend "reason"]"""
import os, sys, json, time, hashlib, subprocess
HERE = os.path.dirname(os.path.abspath(__file__))
P = os.path.join(HERE, "prereg.json")
sha = lambda f: hashlib.sha256(open(os.path.join(HERE, f), "rb").read()).hexdigest()
hashes = {f: sha(f) for f in ("fm2.py", "infer.py", "register.py", "embed.py", "summarize.py")}
hashes["ablate4/run.py"] = hashlib.sha256(open(os.path.join(HERE, "..", "ablate4", "run.py"), "rb").read()).hexdigest()
hashes["bench1/bench.py"] = hashlib.sha256(open(os.path.join(HERE, "..", "bench1", "bench.py"), "rb").read()).hexdigest()
freeze = lambda v: subprocess.run([os.path.join(HERE, v, "bin", "pip"), "freeze"], capture_output=True, text=True).stdout.split()
pick = lambda v, keys: [x for x in freeze(v) if x.split("==")[0].lower() in keys]
if len(sys.argv) > 2 and sys.argv[1] == "amend":
    reg = json.load(open(P))
    reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=sys.argv[2], code_sha256=hashes))
    reg["code_sha256"] = hashes
    json.dump(reg, open(P, "w"), indent=1); sys.exit()
assert not os.path.exists(P), "prereg.json exists; amend instead"
reg = dict(
    created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    title="fm2: zero-shot time-series foundation models as scorers of the side-free big-move target T2 on P3 (#310 queue item 2, retargeted)",
    before_registration="No real-data scoring before this file. Done before: venv installs; export of P3 rows/labels/mid closes "
                        "(fm2.py export, no model run); inference timing on a synthetic random walk only (out/syn_*.npz).",
    question="Does a zero-shot pretrained forecaster add ranking skill for T2 beyond session seasonality (time of day) and volatility "
             "state, and beyond hgb_eng?",
    population="P3 of ablate4 (run.py p3_rows, unchanged): every M5 bar closing on :00/:30 UTC in [07:00, 20:30] UTC, spread <= 0.2 R, "
               "finite ATR, uncensored. WTICO/USD primary; XAU/USD only if time permits.",
    subsample="Compute budget: every 2nd cadence point = only P3 rows whose bar closes on :00 UTC (hourly), for ALL models and ALL "
              "baselines (one evaluation row set). Rows need >= 512 bars of history. Rule fixed before scoring.",
    subsample_rule_code="hourly",
    target="T2 = mid high/low over bars i+1..i+72 reaches close_i +/- 6.0*ATR_i (KX=6.0 fixed by ablate4's 2018 base-rate rule). "
           "T3 (direction of first 6-ATR passage vs row side, rows with T2=1) as a cheap sanity check only.",
    models=dict(
        bolt_small="amazon/chronos-bolt-small @ 772f3d25d38aec6d914c8949dab4462e2d46f5d8 (chronos-forecasting 2.3.2, MPS); quantiles",
        bolt_base="amazon/chronos-bolt-base @ 5d9f166d69f47aef3401367a7b842e78fe97b121 (chronos-forecasting 2.3.2, MPS); quantiles",
        chronos_t5_small="amazon/chronos-t5-small @ a971ba21945c4f1796b17a91fe69214b5f4ad472 (chronos-forecasting 2.3.2, MPS); 20 sample paths",
        chronos2="amazon/chronos-2 @ 29ec3766d36d6f73f0696f85560a422f50e8498c (chronos-forecasting 2.3.2, MPS); quantiles; added beyond the "
                 "queue list because it installs with the same package",
        timesfm25="google/timesfm-2.5-200m-pytorch @ 1d952420fba87f3c6dee4f240de0f1a0fbc790e3 (timesfm 3.0.2, torch CPU, no torch.compile; "
                  "continuous quantile head, normalize_inputs, infer_is_positive=False because WTI traded below zero); quantiles",
        moirai11_small="Salesforce/moirai-1.1-R-small @ 0c24ab99db2c1a70ea2a0fc03bf113329772ac64 (uni2ts 2.0.0, torch 2.4.1 CPU, patch_size 32 "
                       "fixed, no auto patch search); 100 sample paths",
        failed="none at registration (all six installed and ran on the synthetic timing input)"),
    input="Univariate trailing context of 512 M5 mid closes ending at the decision bar's close (inclusive); raw levels (no log returns: "
          "WTI went negative in April 2020; every model scales internally). Horizon 72 bars. Chronos-t5/Bolt horizon > 64 is extended "
          "by the library's own autoregression (vendor warns quality may degrade). Seeds 0.",
    scores=dict(
        s_main_samples="mean over sample paths of max_h |x_h - c_i| / ATR_i (close-only paths: approximates the first-passage/excursion "
                       "event; ignores intrabar highs/lows that the label uses)",
        s_main_quantiles="max_h max(q90_h - c_i, c_i - q10_h) / ATR_i. Marginal quantiles only: this is a SPREAD PROXY, not a joint path "
                         "or first-passage distribution (auditor addendum section 8).",
        s_p6="sample models only (secondary): share of sample paths with max |dev| >= 6 ATR",
        s_dir="(median_72 - c_i)/ATR_i, side-signed, for the T3 sanity check only",
        primary="s_main per model; secondaries are reported but are not the comparison"),
    baselines="On identical rows and folds: hgb_eng (bench1 hgb_head on ENG, unchanged), lr_tod (time-of-day/week group of ablate4 "
              "diag_t2), lr_vol (volatility-state group), lr_todvol (both). LR = de_v2.e2_lr_fit (standardized L2, C=0.1, day weights).",
    stacking="stack_<model> = same LR on todvol + log(s_main); stack_allfm = todvol + log(s_main) of every model. Fitted only on the V4 "
             "fit rows (label end < test start - 6 months - 5 days), as for the baselines. FM scores themselves are zero-shot (no fit).",
    folds="test years 2020, 2021, 2022 (pooled = dev 2020-22) and 2023-01-01..newest = DEVELOPMENT window (inspected before, never a "
          "holdout). No test ledger, no entries, no verdicts.",
    report="AUC per fold and pooled with day-cluster bootstrap 95% CI; paired AUC differences (day bootstrap) of each s_main and stack vs "
           "hgb_eng, lr_tod and lr_todvol; Brier/log loss vs base rate and decile-ish reliability with Wilson CIs and support for the "
           "LR models (stacked and baselines); inference ms/row; T3 AUC of s_dir.",
    decision_rule="A model adds something only if stack_<model> - lr_todvol has a pooled paired CI above 0 in dev 2020-22 AND the same "
                  "sign in 2023+. Six models = six chances: a single marginal CI above 0 is reported as such, with the multiplicity.",
    budget=dict(models=6, scores_primary=6, scores_secondary=2 + 6, baselines=4, stacks=7, folds=4, context_lengths=1, horizons=1,
                hyperparameters="none tuned"),
    provenance="see out/REPORT notes: training corpora are public/synthetic (Chronos corpus + KernelSynth; Chronos-Bolt/2 add more; "
               "TimesFM: Google Trends, Wiki pageviews, synthetic, public benchmarks; Moirai: LOTSA). OANDA WTI/XAU M5 quotes are not "
               "known to be in any corpus; daily/monthly commodity or macro series (e.g. M4 finance, FRED) may be. Checkpoints released "
               "2024-03 .. 2025-10, i.e. inside the 2023+ window: overlap with same-period market data at other frequencies cannot be "
               "excluded.",
    venvs=dict(chronos=pick(".venv", {"chronos-forecasting", "torch", "transformers", "numpy"}),
               timesfm=pick(".venv_timesfm", {"timesfm", "torch", "numpy"}),
               moirai=pick(".venv_moirai", {"uni2ts", "torch", "numpy", "gluonts"}),
               eval="audit/bench1/.venv (python 3.14, torch 2.14.1, scikit-learn 1.9.1), unchanged"),
    code_sha256=hashes)
json.dump(reg, open(P, "w"), indent=1)
print("registered", reg["created"])
