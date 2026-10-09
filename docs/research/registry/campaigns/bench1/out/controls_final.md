# bench1 planted-drift controls (final seeds): 380 realizations, fatal 0

Supported = qualified under evaluator v2 V4 (Bonferroni k=3). Bin = realized economic value (oracle-policy R/trade, control test window 2020-2022).
hgb_base(v2) = the v2 audit's HGB on the existing E features for the same realizations (from audit/v2/out).

| economic value bin | n | lr_base | lr_eng | hgb_eng | mr_lr | ts_lr | tscomb_lr | tscomb_hgb | oracle | hgb_base(v2) | oracle POLICY ceiling |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [-inf, +0.00) | 60 | 0/60 (-0.00-0.06) | 0/60 (-0.00-0.06) | 0/60 (-0.00-0.06) | 0/60 (-0.00-0.06) | 0/60 (-0.00-0.06) | 0/60 (-0.00-0.06) | 0/60 (-0.00-0.06) | 0/60 (-0.00-0.06) | 0/60 (-0.00-0.06) | 0/60 (-0.00-0.06) |
| [+0.00, +0.05) | 36 | 0/36 (0.00-0.10) | 0/36 (0.00-0.10) | 0/36 (0.00-0.10) | 0/36 (0.00-0.10) | 0/36 (0.00-0.10) | 0/36 (0.00-0.10) | 0/36 (0.00-0.10) | 0/36 (0.00-0.10) | 0/36 (0.00-0.10) | 0/36 (0.00-0.10) |
| [+0.05, +0.10) | 23 | 0/23 (-0.00-0.14) | 0/23 (-0.00-0.14) | 0/23 (-0.00-0.14) | 0/23 (-0.00-0.14) | 0/23 (-0.00-0.14) | 0/23 (-0.00-0.14) | 0/23 (-0.00-0.14) | 0/23 (-0.00-0.14) | 0/23 (-0.00-0.14) | 0/23 (-0.00-0.14) |
| [+0.10, +0.20) | 50 | 0/50 (0.00-0.07) | 0/50 (0.00-0.07) | 0/50 (0.00-0.07) | 0/50 (0.00-0.07) | 0/50 (0.00-0.07) | 0/50 (0.00-0.07) | 0/50 (0.00-0.07) | 6/50 (0.06-0.24) | 0/50 (0.00-0.07) | 7/50 (0.07-0.26) |
| [+0.20, +0.40) | 80 | 5/80 (0.03-0.14) | 4/80 (0.02-0.12) | 6/80 (0.03-0.15) | 0/80 (-0.00-0.05) | 0/80 (-0.00-0.05) | 0/80 (-0.00-0.05) | 1/80 (0.00-0.07) | 50/80 (0.52-0.72) | 5/80 (0.03-0.14) | 72/80 (0.81-0.95) |
| [+0.40, +inf) | 91 | 28/91 (0.22-0.41) | 25/91 (0.19-0.37) | 19/91 (0.14-0.30) | 3/91 (0.01-0.09) | 0/91 (0.00-0.04) | 6/91 (0.03-0.14) | 10/91 (0.06-0.19) | 52/91 (0.47-0.67) | 21/91 (0.16-0.33) | 91/91 (0.96-1.00) |

False qualification (k=3; k=1/k=5 counts in brackets):

- null: lr_base 0/20 (-0.00-0.16) [0/0]; lr_eng 0/20 (-0.00-0.16) [0/0]; hgb_eng 0/20 (-0.00-0.16) [0/0]; mr_lr 0/20 (-0.00-0.16) [0/0]; ts_lr 0/20 (-0.00-0.16) [0/0]; tscomb_lr 0/20 (-0.00-0.16) [0/0]; tscomb_hgb 0/20 (-0.00-0.16) [0/0]; oracle 0/20 (-0.00-0.16) [0/0]
- null_hidden: lr_base 0/20 (-0.00-0.16) [0/0]; lr_eng 1/20 (0.01-0.24) [1/1]; hgb_eng 0/20 (-0.00-0.16) [0/0]; mr_lr 1/20 (0.01-0.24) [1/1]; ts_lr 0/20 (-0.00-0.16) [1/0]; tscomb_lr 0/20 (-0.00-0.16) [0/0]; tscomb_hgb 0/20 (-0.00-0.16) [0/0]; oracle 17/20 (0.64-0.95) [17/17]

Mean unconditional test AUC of the test model (arm label, test rows 2020-2022):

| bin | lr_base | lr_eng | hgb_eng | mr_lr | ts_lr | tscomb_lr | tscomb_hgb | oracle |
|---|---|---|---|---|---|---|---|---|
| -inf | 0.521 | 0.515 | 0.503 | 0.490 | 0.515 | 0.515 | 0.505 | 0.523 |
| +0.00 | 0.523 | 0.516 | 0.502 | 0.491 | 0.517 | 0.517 | 0.504 | 0.528 |
| +0.05 | 0.527 | 0.521 | 0.502 | 0.493 | 0.518 | 0.518 | 0.506 | 0.545 |
| +0.10 | 0.531 | 0.522 | 0.507 | 0.496 | 0.516 | 0.517 | 0.507 | 0.548 |
| +0.20 | 0.542 | 0.533 | 0.522 | 0.506 | 0.518 | 0.522 | 0.512 | 0.566 |
| +0.40 | 0.561 | 0.551 | 0.539 | 0.521 | 0.519 | 0.532 | 0.529 | 0.558 |
| null | 0.521 | 0.513 | 0.500 | 0.495 | 0.518 | 0.517 | 0.503 | 0.500 |
| null_hidden | 0.550 | 0.541 | 0.520 | 0.522 | 0.520 | 0.527 | 0.512 | 0.584 |

First failing stage per bin (support -> calibration slope CI -> threshold gate -> qualification):

- +0.05: lr_base {'calibration': 20, 'qual: inconclusive': 1, 'qual: rejected': 2}; lr_eng {'calibration': 22, 'qual: inconclusive': 1}; hgb_eng {'calibration': 23}; mr_lr {'calibration': 17, 'qual: inconclusive': 4, 'qual: rejected': 2}; ts_lr {'calibration': 23}; tscomb_lr {'calibration': 23}; tscomb_hgb {'calibration': 22, 'qual: inconclusive': 1}; oracle {'calibration': 14, 'qual: inconclusive': 8, 'threshold: gate': 1}
- +0.10: lr_base {'qual: rejected': 3, 'calibration': 39, 'qual: inconclusive': 8}; lr_eng {'calibration': 44, 'qual: inconclusive': 6}; hgb_eng {'calibration': 48, 'qual: rejected': 1, 'qual: inconclusive': 1}; mr_lr {'calibration': 38, 'qual: rejected': 3, 'qual: inconclusive': 9}; ts_lr {'calibration': 50}; tscomb_lr {'calibration': 49, 'qual: inconclusive': 1}; tscomb_hgb {'calibration': 49, 'qual: inconclusive': 1}; oracle {'calibration': 34, 'qualified': 6, 'threshold: gate': 3, 'qual: inconclusive': 7}
- +0.20: lr_base {'calibration': 53, 'qual: inconclusive': 21, 'qualified': 5, 'threshold: gate': 1}; lr_eng {'calibration': 54, 'qual: inconclusive': 22, 'qualified': 4}; hgb_eng {'calibration': 60, 'qualified': 6, 'qual: inconclusive': 14}; mr_lr {'calibration': 60, 'qual: inconclusive': 15, 'qual: rejected': 5}; ts_lr {'calibration': 77, 'qual: inconclusive': 3}; tscomb_lr {'calibration': 74, 'qual: inconclusive': 6}; tscomb_hgb {'calibration': 75, 'qualified': 1, 'qual: inconclusive': 4}; oracle {'qualified': 50, 'calibration': 24, 'threshold: gate': 5, 'qual: inconclusive': 1}
- +0.40: lr_base {'qualified': 28, 'calibration': 33, 'qual: inconclusive': 28, 'threshold: gate': 1, 'support': 1}; lr_eng {'calibration': 43, 'qual: inconclusive': 21, 'threshold: gate': 1, 'qualified': 25, 'support': 1}; hgb_eng {'calibration': 48, 'qual: inconclusive': 20, 'qualified': 19, 'threshold: gate': 3, 'support': 1}; mr_lr {'calibration': 54, 'qual: inconclusive': 33, 'qualified': 3, 'support': 1}; ts_lr {'calibration': 87, 'qual: inconclusive': 3, 'support': 1}; tscomb_lr {'calibration': 72, 'qualified': 6, 'qual: inconclusive': 12, 'support': 1}; tscomb_hgb {'calibration': 64, 'qual: inconclusive': 15, 'threshold: gate': 1, 'qualified': 10, 'support': 1}; oracle {'qualified': 52, 'calibration': 23, 'threshold: gate': 15, 'support': 1}

Per cell (supported lr_base/lr_eng/hgb_eng/mr_lr/ts_lr/tscomb_lr/tscomb_hgb/oracle): subset 0.1 econ +0.269: 0/0/0/0/0/0/0/0 of 20; interaction 0.04 econ +0.006: 0/0/0/0/0/0/0/0 of 20; interaction 0.02 econ -0.058: 0/0/0/0/0/0/0/0 of 20; subset 0.065 econ +0.115: 0/0/0/0/0/0/0/0 of 20; subset 0.04 econ -0.001: 0/0/0/0/0/0/0/0 of 20; linear 0.065 econ +0.115: 0/0/0/0/0/0/0/1 of 20; null 0.0 econ -0.116: 0/0/0/0/0/0/0/0 of 20; interaction 0.065 econ +0.104: 0/0/0/0/0/0/0/0 of 20; linear 0.02 econ -0.056: 0/0/0/0/0/0/0/0 of 20; null_hidden 0.16 econ +0.035: 0/1/0/1/0/0/0/17 of 20; linear 0.04 econ +0.017: 0/0/0/0/0/0/0/0 of 20; interaction 0.1 econ +0.216: 0/0/0/0/0/0/0/14 of 20; linear 0.1 econ +0.248: 0/2/1/0/0/0/0/12 of 20; interaction 0.16 econ +0.312: 1/0/2/0/0/0/0/19 of 20; linear 0.16 econ +0.409: 11/6/6/0/0/0/2/19 of 20; linear 0.25 econ +0.615: 13/13/12/3/0/1/8/15 of 20; interaction 0.25 econ +0.459: 7/7/4/0/0/5/0/18 of 20; subset 0.25 econ +0.905: 1/1/0/0/0/0/1/7 of 20; subset 0.16 econ +0.542: 0/0/0/0/0/0/0/3 of 20

Mean seconds per realization and learner (1 thread): lr_base 1.0, lr_eng 0.9, hgb_eng 2.2, mr_lr 6.7, ts_lr 151.1, tscomb_lr 0.8, tscomb_hgb 19.0, oracle 1.2; whole realization 192 s.

