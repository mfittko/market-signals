# bench1 planted-drift controls (dev seeds): 57 realizations, fatal 0

Supported = qualified under evaluator v2 V4 (Bonferroni k=3). Bin = realized economic value (oracle-policy R/trade, control test window 2020-2022).
hgb_base(v2) = the v2 audit's HGB on the existing E features for the same realizations (from audit/v2/out).

| economic value bin | n | lr_base | lr_eng | hgb_eng | mr_lr | ts_lr | tscomb_lr | tscomb_hgb | oracle | hgb_base(v2) | oracle POLICY ceiling |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [-inf, +0.00) | 10 | 0/10 (-0.00-0.28) | 0/10 (-0.00-0.28) | 0/10 (-0.00-0.28) | 0/10 (-0.00-0.28) | 0/10 (-0.00-0.28) | 0/10 (-0.00-0.28) | 0/10 (-0.00-0.28) | 0/10 (-0.00-0.28) | 0/10 (-0.00-0.28) | 0/10 (-0.00-0.28) |
| [+0.00, +0.05) | 4 | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 1/4 (0.05-0.70) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) |
| [+0.05, +0.10) | 4 | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) |
| [+0.10, +0.20) | 7 | 0/7 (0.00-0.35) | 0/7 (0.00-0.35) | 0/7 (0.00-0.35) | 0/7 (0.00-0.35) | 0/7 (0.00-0.35) | 0/7 (0.00-0.35) | 0/7 (0.00-0.35) | 2/7 (0.08-0.64) | 0/7 (0.00-0.35) | 1/7 (0.03-0.51) |
| [+0.20, +0.40) | 12 | 1/12 (0.01-0.35) | 0/12 (0.00-0.24) | 1/12 (0.01-0.35) | 0/12 (0.00-0.24) | 0/12 (0.00-0.24) | 0/12 (0.00-0.24) | 0/12 (0.00-0.24) | 6/12 (0.25-0.75) | 1/12 (0.01-0.35) | 11/12 (0.65-0.99) |
| [+0.40, +inf) | 14 | 3/14 (0.08-0.48) | 2/14 (0.04-0.40) | 5/14 (0.16-0.61) | 0/14 (0.00-0.22) | 0/14 (0.00-0.22) | 0/14 (0.00-0.22) | 1/14 (0.01-0.31) | 7/14 (0.27-0.73) | 4/14 (0.12-0.55) | 14/14 (0.78-1.00) |

False qualification (k=3; k=1/k=5 counts in brackets):

- null: lr_base 0/3 (0.00-0.56) [0/0]; lr_eng 0/3 (0.00-0.56) [0/0]; hgb_eng 0/3 (0.00-0.56) [0/0]; mr_lr 0/3 (0.00-0.56) [0/0]; ts_lr 0/3 (0.00-0.56) [0/0]; tscomb_lr 0/3 (0.00-0.56) [0/0]; tscomb_hgb 0/3 (0.00-0.56) [0/0]; oracle 0/3 (0.00-0.56) [0/0]
- null_hidden: lr_base 0/3 (0.00-0.56) [0/0]; lr_eng 0/3 (0.00-0.56) [0/0]; hgb_eng 0/3 (0.00-0.56) [0/0]; mr_lr 0/3 (0.00-0.56) [1/0]; ts_lr 0/3 (0.00-0.56) [0/0]; tscomb_lr 0/3 (0.00-0.56) [0/0]; tscomb_hgb 0/3 (0.00-0.56) [0/0]; oracle 2/3 (0.21-0.94) [2/2]

Mean unconditional test AUC of the test model (arm label, test rows 2020-2022):

| bin | lr_base | lr_eng | hgb_eng | mr_lr | ts_lr | tscomb_lr | tscomb_hgb | oracle |
|---|---|---|---|---|---|---|---|---|
| -inf | 0.521 | 0.517 | 0.501 | 0.486 | 0.513 | 0.515 | 0.507 | 0.530 |
| +0.00 | 0.529 | 0.521 | 0.499 | 0.491 | 0.521 | 0.521 | 0.504 | 0.535 |
| +0.05 | 0.533 | 0.522 | 0.509 | 0.486 | 0.519 | 0.519 | 0.502 | 0.551 |
| +0.10 | 0.527 | 0.527 | 0.513 | 0.498 | 0.522 | 0.523 | 0.512 | 0.540 |
| +0.20 | 0.540 | 0.534 | 0.519 | 0.503 | 0.522 | 0.526 | 0.518 | 0.567 |
| +0.40 | 0.556 | 0.546 | 0.543 | 0.524 | 0.517 | 0.529 | 0.528 | 0.558 |
| null | 0.522 | 0.514 | 0.498 | 0.495 | 0.518 | 0.516 | 0.502 | 0.500 |
| null_hidden | 0.543 | 0.536 | 0.514 | 0.522 | 0.515 | 0.526 | 0.505 | 0.584 |

First failing stage per bin (support -> calibration slope CI -> threshold gate -> qualification):

- +0.05: lr_base {'calibration': 3, 'qual: rejected': 1}; lr_eng {'calibration': 4}; hgb_eng {'calibration': 4}; mr_lr {'qual: inconclusive': 1, 'calibration': 3}; ts_lr {'calibration': 4}; tscomb_lr {'calibration': 4}; tscomb_hgb {'calibration': 4}; oracle {'calibration': 1, 'qual: inconclusive': 2, 'threshold: gate': 1}
- +0.10: lr_base {'calibration': 2, 'qual: rejected': 2, 'qual: inconclusive': 3}; lr_eng {'calibration': 5, 'qual: inconclusive': 2}; hgb_eng {'calibration': 7}; mr_lr {'calibration': 2, 'qual: inconclusive': 3, 'qual: rejected': 2}; ts_lr {'calibration': 6, 'qual: inconclusive': 1}; tscomb_lr {'calibration': 6, 'qual: inconclusive': 1}; tscomb_hgb {'calibration': 7}; oracle {'qual: inconclusive': 2, 'calibration': 1, 'qualified': 2, 'threshold: gate': 2}
- +0.20: lr_base {'calibration': 7, 'qual: inconclusive': 4, 'qualified': 1}; lr_eng {'calibration': 8, 'qual: inconclusive': 4}; hgb_eng {'qual: inconclusive': 1, 'calibration': 10, 'qualified': 1}; mr_lr {'qual: inconclusive': 3, 'calibration': 8, 'qual: rejected': 1}; ts_lr {'calibration': 12}; tscomb_lr {'calibration': 12}; tscomb_hgb {'qual: inconclusive': 3, 'calibration': 9}; oracle {'calibration': 4, 'qualified': 6, 'threshold: gate': 2}
- +0.40: lr_base {'qual: inconclusive': 7, 'qualified': 3, 'calibration': 4}; lr_eng {'calibration': 9, 'qual: inconclusive': 3, 'qualified': 2}; hgb_eng {'qualified': 5, 'qual: inconclusive': 2, 'calibration': 7}; mr_lr {'calibration': 6, 'qual: inconclusive': 8}; ts_lr {'calibration': 13, 'qual: inconclusive': 1}; tscomb_lr {'calibration': 11, 'qual: inconclusive': 3}; tscomb_hgb {'qual: inconclusive': 3, 'qualified': 1, 'calibration': 10}; oracle {'qualified': 7, 'calibration': 2, 'threshold: gate': 5}

Per cell (supported lr_base/lr_eng/hgb_eng/mr_lr/ts_lr/tscomb_lr/tscomb_hgb/oracle): interaction 0.02 econ -0.041: 0/0/0/0/0/0/0/0 of 3; null 0.0 econ -0.154: 0/0/0/0/0/0/0/0 of 3; interaction 0.04 econ +0.012: 0/0/0/0/0/0/0/0 of 3; linear 0.02 econ -0.106: 0/0/0/0/0/0/0/0 of 3; linear 0.04 econ -0.039: 0/0/0/0/0/0/0/0 of 3; interaction 0.065 econ +0.104: 0/0/0/0/0/0/0/0 of 3; linear 0.065 econ +0.064: 0/0/0/0/0/0/0/1 of 3; linear 0.1 econ +0.196: 0/0/0/0/0/0/0/2 of 3; interaction 0.1 econ +0.224: 0/0/0/0/0/0/0/2 of 3; null_hidden 0.16 econ +0.024: 0/0/0/0/0/0/0/2 of 3; interaction 0.16 econ +0.342: 0/0/0/0/0/0/0/2 of 3; linear 0.16 econ +0.378: 1/0/2/0/0/0/0/3 of 3; linear 0.25 econ +0.626: 3/2/3/0/0/0/1/3 of 3; interaction 0.25 econ +0.493: 0/0/1/0/0/0/0/3 of 3; subset 0.16 econ +0.581: 0/0/0/0/0/0/0/0 of 3; subset 0.1 econ +0.353: 0/0/0/0/0/0/0/0 of 3; subset 0.25 econ +0.939: 0/0/0/0/0/0/0/0 of 3; subset 0.04 econ +0.084: 0/0/0/0/0/0/0/0 of 3; subset 0.065 econ +0.181: 0/0/0/0/0/0/0/0 of 3

Mean seconds per realization and learner (1 thread): lr_base 0.9, lr_eng 0.7, hgb_eng 1.9, mr_lr 8.1, ts_lr 135.0, tscomb_lr 0.6, tscomb_hgb 16.4, oracle 1.1; whole realization 172 s.

