"""Writes audit/bench1/prereg.json (timestamp, design, budget, code hashes). Refuses to overwrite; amendments append."""
import os, sys, json, time, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
sys.argv = [sys.argv[0], "register"] + sys.argv[1:]
import bench as bm

P = os.path.join(HERE, "prereg.json")
sha = lambda f: hashlib.sha256(open(os.path.join(HERE, f), "rb").read()).hexdigest()
hashes = dict(evaluator=bm.de.CODE_SHA, evaluator_files=bm.de.CODE_FILES_SHA, selected_json=sha("../v2/selected.json"),
              **{f: sha(f) for f in ("bench.py", "real.py", "register.py", "summarize.py") if os.path.exists(os.path.join(HERE, f))},
              ts2vec_src_commit=bm.CODE["ts2vec_src"])
if len(sys.argv) > 2 and sys.argv[2] == "amend":
    reg = json.load(open(P))
    reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=sys.argv[3], code_sha256=hashes))
    reg["code_sha256"] = hashes
    json.dump(reg, open(P, "w"), indent=1)
    sys.exit()
assert not os.path.exists(P), "prereg.json exists; amend instead"
reg = dict(
    created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    title="bench1: representation benchmark on the frozen D population, evaluator v2 (V4) unchanged (#310 item 1)",
    before_registration="Plumbing only: bench check (causality) and one control probe (linear 0.16, dev seed 1001) to time the "
                        "pipeline and confirm that lr_base reproduces the v2 V4 record exactly (same cut, slope CI, trades, mean R, "
                        "verdict). After the probe the LR-head C grid was widened from (1e-3, 1e-2, 1e-1) to (1e-4 .. 1e-1) because "
                        "validation picked the grid edge; nothing else changed. No real-data scoring before this file.",
    evaluator="de_v2.py + labels_v2.py, E stage V4 (audit/v2/selected.json): one model fit on rows exiting before test - 6 months - "
              "5 days; Platt calibration with episode-clustered slope CI guard (unavailable unless CI > 0) and coverage-quantile "
              "threshold (q in 0.5/0.35/0.2/0.1, >= 30 policy trades, gate vs unselected D) pooled over the last 6 months; "
              "support guard fit >= 200, cal >= 100",
    population="identical candidates for every learner: de_v2.candidates of the D configuration (confirmed, spread <= 0.2 R, inside "
               "the window), restricted to rows where every representation is finite (shared ok mask)",
    labels="y = arm (+1R before the stop within H, 308 contract), episode weights 1/n_rows_in_episode, bid/ask fills, POLICY k=1.5 m=1 T=3 H=72",
    learners=dict(
        lr_base="frozen E learner (standardized L2 LR C=0.1, episode weights) on BASEF+VOLF (reproduction)",
        lr_eng="same LR (C=0.1, no tuning) on ENG",
        hgb_eng="HistGradientBoostingClassifier on ENG: " + json.dumps(bm.HGB_KW) + f", max_iter {bm.HGB_MAX_ITER}; iteration count = argmin "
                "weighted log loss on the chronologically last 20% of fit-row days (5-day embargo), then refit on all fit rows; "
                "no estimator-internal random split",
        mr_lr=f"aeon MiniRocket {json.dumps(bm.MR_KW)} on the side-signed ATR-normalized M5 return window (L={bm.L_SEQ}) + CTX; LR head, C chosen "
              f"from {bm.C_GRID} on the same chronological validation split, refit on all fit rows",
        ts_lr=f"official TS2Vec (commit {bm.CODE['ts2vec_src']}), CPU, {json.dumps(bm.TS_KW)}, n_iters by the official default rule, torch/numpy "
              f"seed {bm.TS_SEED}; input = 4-channel trailing window (return, range, spread, activity), L={bm.L_SEQ}, per-channel scaler and "
              "encoder fitted on the fit-row windows only; embedding = encode(window, encoding_window='full_series') of the trailing "
              "window that ends at the decision bar; head LR (C grid as mr_lr) on embedding + CTX",
        tscomb_lr="TS2Vec embedding + ENG, LR head (C grid)", tscomb_hgb="TS2Vec embedding + ENG, HGB head (as hgb_eng)",
        oracle="controls only: the planted driver g as raw score"),
    features=dict(ENG=bm.ENG, CTX=bm.CTX, controls_extra=["c1", "c2"],
                  ENG_definition="r_k = side x (close_t - close_{t-k}) / ATR_t, k in 1,3,6,12,36,72; body, with-side and against-side wick, "
                                 "range, 3-bar mean range (/ATR); log ratios of 12- and 48-bar to 288-bar realized vol (std of absolute M5 close changes, 0.01 ATR floor), log 288-bar vol / ATR, log "
                                 "ATR/max(abs(price), 1), ATR ratio; spread (R units) and its change vs the 12-bar mean; log volume (1 and 12-bar mean) minus "
                                 "the median at the same time of day over the prior 20 sessions; time-of-day and weekday sin/cos, log bars since "
                                 "session open, side x (close - session open)/ATR, side x position in the prior session range"),
    augmentation_note="TS2Vec uses its official random cropping and timestamp masking; both keep temporal order and sign (no "
                      "reversal or permutation); windows are side-signed so 'with trend' has one direction",
    leakage="bench.py check: ENG and windows unchanged under post-cut perturbation, planted next-bar leak detected, TS2Vec embeddings "
            "of pre-cut windows unchanged and later windows change them; every scaler/transform/encoder/head is fitted inside fitter(mask) "
            "on the V4 fit rows only (rows exiting before test - 6 months - 5 days)",
    budget=dict(learners=7, oracle=1, feature_sets=["BASEF+VOLF", "ENG", "MiniRocket+CTX", "TS2Vec+CTX", "TS2Vec+ENG"], lookbacks=[bm.L_SEQ],
                lookback_count=1, engineered_lags="fixed (1,3,6,12,36,72), vol scales (12,48,288)", seeds=dict(minirocket=1, ts2vec=1, hgb=1),
                hyperparameters=dict(lr_head_C=list(bm.C_GRID), hgb="fixed params, iterations chosen chronologically (1..300)",
                                     ts2vec="official defaults, not tuned", minirocket="official defaults, not tuned"),
                thresholds="V4 coverage grid (4 values) inside the evaluator, unchanged", instruments=["WTICO/USD"],
                xau="scoped comparison only if time permits; not registered as a result"),
    controls=dict(harness="audit/v1/controls.py plant() and grid (19 cells), CFG_X population, calendar test 2020-01-01..2022-12-30, "
                          "V4 only; every record carries evaluator and bench SHA-256",
                  seeds=dict(dev=[1001, 1002, 1003], final=list(range(2001, 2041))),
                  dev_use="plumbing and gross failure only; amendments only before the final run",
                  tables="supported rate (k=3) per realized economic-value bin vs the oracle score and the oracle-policy ceiling; false "
                         "qualification on null and null_hidden (Wilson); first failing stage; unconditional test AUC per learner per bin"),
    real=dict(inst="WTICO/USD", populations=dict(frozenD="WTI frozen D (fired 0.9, brk, 48)", cfgX="XAU frozen D on WTI (none, h1, 12) = control population"),
              folds="purged walk-forward test years 2020, 2021, 2022 (gate and learners fitted before each year) + 2023-01-01..newest as a "
                    "DEVELOPMENT window (inspected 13+ times; never a holdout); no test ledger, no verdicts",
              report="raw AUC by window and side, calibration with support, risk-vs-coverage at the V4 quantile cuts, registered D+E net R "
                     "with 5-day moving-block day bootstrap CIs, cost sensitivity (extra cost 0/0.02/0.05/0.10 R per trade), paired "
                     "differences vs unselected D and vs LR on the same features"),
    code_sha256=hashes,
    versions=open(os.path.join(HERE, "bench_venv_freeze.txt")).read().split("\n"),
    environment_note="separate venv audit/bench1/.venv (numpy 2.3.5, scipy 1.17.1: numba/aeon require numpy < 2.4; the engine venv "
                     "stays on numpy 2.5.3). Reproduction check: lr_base equals the v2 V4 control record bit for bit on the probe.",
)
json.dump(reg, open(P, "w"), indent=1)
print("registered", reg["created"])
