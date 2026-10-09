# Evaluator v2 E redesign on the audit controls (final seeds; 760 realizations, fatal 0)

Supported = qualified under the registered rule (Bonferroni k=3). Bins: realized economic value (oracle-policy R/trade on the control test window).

## V1

| economic value bin | realizations | LR | HGB | oracle score | LR+HGB pooled | oracle POLICY (ceiling) | LR/HGB/oracle k=1 | k=5 |
|---|---|---|---|---|---|---|---|---|
| [-inf, +0.00) | 132 | 0/132 (0.00-0.03) | 0/132 (0.00-0.03) | 0/132 (0.00-0.03) | 0.000 | 0/132 (0.00-0.03) | 0/0/0 | 0/0/0 |
| [+0.00, +0.05) | 60 | 0/60 (-0.00-0.06) | 0/60 (-0.00-0.06) | 0/60 (-0.00-0.06) | 0.000 | 0/60 (-0.00-0.06) | 0/0/0 | 0/0/0 |
| [+0.05, +0.10) | 56 | 0/56 (0.00-0.06) | 0/56 (0.00-0.06) | 2/56 (0.01-0.12) | 0.000 | 0/56 (0.00-0.06) | 0/0/3 | 0/0/2 |
| [+0.10, +0.20) | 93 | 0/93 (0.00-0.04) | 0/93 (0.00-0.04) | 23/93 (0.17-0.34) | 0.000 | 20/93 (0.14-0.31) | 0/1/29 | 0/0/18 |
| [+0.20, +0.40) | 152 | 20/152 (0.09-0.19) | 15/152 (0.06-0.16) | 107/152 (0.63-0.77) | 0.115 | 138/152 (0.85-0.94) | 23/22/110 | 20/15/105 |
| [+0.40, +inf) | 187 | 66/187 (0.29-0.42) | 70/187 (0.31-0.45) | 152/187 (0.75-0.86) | 0.364 | 187/187 (0.98-1.00) | 76/75/152 | 62/69/152 |

False qualification (k=3; k=1 / k=5 counts in brackets):

- null: lr 0/40 (-0.00-0.09) [0/0]; hgb 0/40 (-0.00-0.09) [0/0]; oracle 0/40 (-0.00-0.09) [0/0]
- null_hidden: lr 1/40 (0.00-0.13) [3/0]; hgb 0/40 (-0.00-0.09) [0/0]; oracle 38/40 (0.83-0.99) [38/38]

First failing stage (planted controls, by bin; learner loss = oracle score qualified but learner not):

- [+0.05, +0.10): lr {'calibration': 42, 'qualification: inconclusive': 9, 'threshold: gate': 3, 'qualification: rejected': 2}; hgb {'qualification: rejected': 1, 'qualification: inconclusive': 4, 'threshold: gate': 4, 'calibration': 47}; oracle {'calibration': 29, 'qualification: inconclusive': 17, 'threshold: gate': 8, 'qualified': 2}; learner loss LR 2, HGB 2
- [+0.10, +0.20): lr {'threshold: gate': 10, 'calibration': 62, 'qualification: rejected': 7, 'qualification: inconclusive': 14}; hgb {'calibration': 83, 'qualification: rejected': 1, 'qualification: inconclusive': 5, 'threshold: gate': 4}; oracle {'qualification: inconclusive': 17, 'calibration': 40, 'qualified': 23, 'threshold: gate': 13}; learner loss LR 23, HGB 23
- [+0.20, +0.40): lr {'qualification: inconclusive': 44, 'calibration': 77, 'qualified': 20, 'threshold: gate': 8, 'qualification: rejected': 3}; hgb {'calibration': 103, 'qualified': 15, 'qualification: inconclusive': 23, 'threshold: gate': 9, 'qualification: rejected': 2}; oracle {'qualified': 107, 'calibration': 32, 'threshold: gate': 9, 'qualification: rejected': 1, 'qualification: inconclusive': 3}; learner loss LR 87, HGB 93
- [+0.40, +inf): lr {'qualified': 66, 'qualification: inconclusive': 63, 'calibration': 54, 'threshold: gate': 4}; hgb {'qualified': 70, 'calibration': 78, 'qualification: inconclusive': 34, 'qualification: < 2 trades': 1, 'threshold: gate': 4}; oracle {'qualified': 152, 'calibration': 23, 'qualification: inconclusive': 7, 'threshold: gate': 4, 'qualification: rejected': 1}; learner loss LR 88, HGB 83

Per cell (supported LR/HGB/oracle): null 0.0 econ -0.120: 0/0/0 of 40; null_hidden 0.16 econ +0.050: 1/0/38 of 40; linear 0.02 econ -0.057: 0/0/0 of 40; linear 0.04 econ +0.019: 0/0/0 of 40; linear 0.065 econ +0.115: 0/0/7 of 40; linear 0.1 econ +0.243: 8/5/35 of 40; linear 0.16 econ +0.420: 30/24/39 of 40; linear 0.25 econ +0.626: 32/35/40 of 40; interaction 0.02 econ -0.066: 0/0/0 of 40; interaction 0.04 econ -0.004: 0/0/0 of 40; interaction 0.065 econ +0.096: 0/0/1 of 40; interaction 0.1 econ +0.212: 0/1/30 of 40; interaction 0.16 econ +0.311: 1/3/39 of 40; interaction 0.25 econ +0.455: 10/12/40 of 40; subset 0.04 econ -0.000: 0/0/0 of 40; subset 0.065 econ +0.116: 0/0/0 of 40; subset 0.1 econ +0.279: 0/0/4 of 40; subset 0.16 econ +0.526: 0/0/19 of 40; subset 0.25 econ +0.895: 5/5/30 of 40

## V2

| economic value bin | realizations | LR | HGB | oracle score | LR+HGB pooled | oracle POLICY (ceiling) | LR/HGB/oracle k=1 | k=5 |
|---|---|---|---|---|---|---|---|---|
| [-inf, +0.00) | 132 | 0/132 (0.00-0.03) | 0/132 (0.00-0.03) | 0/132 (0.00-0.03) | 0.000 | 0/132 (0.00-0.03) | 0/0/0 | 0/0/0 |
| [+0.00, +0.05) | 60 | 0/60 (-0.00-0.06) | 0/60 (-0.00-0.06) | 0/60 (-0.00-0.06) | 0.000 | 0/60 (-0.00-0.06) | 0/0/0 | 0/0/0 |
| [+0.05, +0.10) | 56 | 0/56 (0.00-0.06) | 0/56 (0.00-0.06) | 2/56 (0.01-0.12) | 0.000 | 0/56 (0.00-0.06) | 0/0/4 | 0/0/2 |
| [+0.10, +0.20) | 93 | 0/93 (0.00-0.04) | 0/93 (0.00-0.04) | 25/93 (0.19-0.37) | 0.000 | 20/93 (0.14-0.31) | 0/1/31 | 0/0/20 |
| [+0.20, +0.40) | 152 | 20/152 (0.09-0.19) | 15/152 (0.06-0.16) | 112/152 (0.66-0.80) | 0.115 | 138/152 (0.85-0.94) | 23/22/116 | 20/15/110 |
| [+0.40, +inf) | 187 | 66/187 (0.29-0.42) | 69/187 (0.30-0.44) | 154/187 (0.76-0.87) | 0.361 | 187/187 (0.98-1.00) | 76/74/154 | 62/69/154 |

False qualification (k=3; k=1 / k=5 counts in brackets):

- null: lr 0/40 (-0.00-0.09) [0/0]; hgb 0/40 (-0.00-0.09) [0/0]; oracle 0/40 (-0.00-0.09) [0/0]
- null_hidden: lr 2/40 (0.01-0.17) [4/1]; hgb 0/40 (-0.00-0.09) [0/0]; oracle 38/40 (0.83-0.99) [38/38]

First failing stage (planted controls, by bin; learner loss = oracle score qualified but learner not):

- [+0.05, +0.10): lr {'calibration': 42, 'qualification: inconclusive': 11, 'qualification: rejected': 3}; hgb {'qualification: rejected': 1, 'qualification: inconclusive': 8, 'calibration': 47}; oracle {'calibration': 29, 'qualification: inconclusive': 25, 'qualified': 2}; learner loss LR 2, HGB 2
- [+0.10, +0.20): lr {'qualification: inconclusive': 21, 'calibration': 62, 'qualification: rejected': 10}; hgb {'calibration': 83, 'qualification: rejected': 4, 'qualification: inconclusive': 6}; oracle {'qualification: inconclusive': 26, 'calibration': 40, 'qualified': 25, 'threshold: gate': 2}; learner loss LR 25, HGB 25
- [+0.20, +0.40): lr {'qualification: inconclusive': 51, 'calibration': 77, 'qualified': 20, 'qualification: rejected': 3, 'threshold: gate': 1}; hgb {'calibration': 103, 'qualified': 15, 'qualification: inconclusive': 29, 'threshold: gate': 2, 'qualification: rejected': 3}; oracle {'qualified': 112, 'calibration': 32, 'threshold: gate': 1, 'qualification: rejected': 2, 'qualification: inconclusive': 5}; learner loss LR 92, HGB 97
- [+0.40, +inf): lr {'qualified': 66, 'qualification: inconclusive': 63, 'calibration': 54, 'threshold: gate': 4}; hgb {'qualified': 69, 'calibration': 78, 'qualification: inconclusive': 32, 'threshold: gate': 7, 'qualification: < 2 trades': 1}; oracle {'qualified': 154, 'calibration': 23, 'threshold: gate': 2, 'qualification: inconclusive': 7, 'qualification: rejected': 1}; learner loss LR 90, HGB 87

Per cell (supported LR/HGB/oracle): null 0.0 econ -0.120: 0/0/0 of 40; null_hidden 0.16 econ +0.050: 2/0/38 of 40; linear 0.02 econ -0.057: 0/0/0 of 40; linear 0.04 econ +0.019: 0/0/0 of 40; linear 0.065 econ +0.115: 0/0/9 of 40; linear 0.1 econ +0.243: 8/5/35 of 40; linear 0.16 econ +0.420: 31/24/39 of 40; linear 0.25 econ +0.626: 31/34/40 of 40; interaction 0.02 econ -0.066: 0/0/0 of 40; interaction 0.04 econ -0.004: 0/0/0 of 40; interaction 0.065 econ +0.096: 0/0/1 of 40; interaction 0.1 econ +0.212: 0/1/35 of 40; interaction 0.16 econ +0.311: 1/3/39 of 40; interaction 0.25 econ +0.455: 10/11/39 of 40; subset 0.04 econ -0.000: 0/0/0 of 40; subset 0.065 econ +0.116: 0/0/0 of 40; subset 0.1 econ +0.279: 0/0/4 of 40; subset 0.16 econ +0.526: 0/0/21 of 40; subset 0.25 econ +0.895: 5/6/31 of 40

## V3

| economic value bin | realizations | LR | HGB | oracle score | LR+HGB pooled | oracle POLICY (ceiling) | LR/HGB/oracle k=1 | k=5 |
|---|---|---|---|---|---|---|---|---|
| [-inf, +0.00) | 132 | 0/132 (0.00-0.03) | 0/132 (0.00-0.03) | 0/132 (0.00-0.03) | 0.000 | 0/132 (0.00-0.03) | 0/0/0 | 0/0/0 |
| [+0.00, +0.05) | 60 | 0/60 (-0.00-0.06) | 0/60 (-0.00-0.06) | 1/60 (0.00-0.09) | 0.000 | 0/60 (-0.00-0.06) | 0/0/1 | 0/0/1 |
| [+0.05, +0.10) | 56 | 0/56 (0.00-0.06) | 0/56 (0.00-0.06) | 5/56 (0.04-0.19) | 0.000 | 0/56 (0.00-0.06) | 0/0/7 | 0/0/4 |
| [+0.10, +0.20) | 93 | 0/93 (0.00-0.04) | 1/93 (0.00-0.06) | 34/93 (0.27-0.47) | 0.005 | 20/93 (0.14-0.31) | 1/2/43 | 0/0/29 |
| [+0.20, +0.40) | 152 | 26/152 (0.12-0.24) | 23/152 (0.10-0.22) | 128/152 (0.78-0.89) | 0.161 | 138/152 (0.85-0.94) | 31/35/134 | 25/22/125 |
| [+0.40, +inf) | 187 | 68/187 (0.30-0.43) | 89/187 (0.41-0.55) | 168/187 (0.85-0.93) | 0.420 | 187/187 (0.98-1.00) | 85/97/168 | 64/89/168 |

False qualification (k=3; k=1 / k=5 counts in brackets):

- null: lr 0/40 (-0.00-0.09) [0/0]; hgb 0/40 (-0.00-0.09) [0/0]; oracle 0/40 (-0.00-0.09) [0/0]
- null_hidden: lr 4/40 (0.04-0.23) [7/2]; hgb 0/40 (-0.00-0.09) [0/0]; oracle 40/40 (0.91-1.00) [40/40]

First failing stage (planted controls, by bin; learner loss = oracle score qualified but learner not):

- [+0.05, +0.10): lr {'qualification: inconclusive': 30, 'qualification: rejected': 25, 'threshold: gate': 1}; hgb {'qualification: rejected': 22, 'qualification: inconclusive': 25, 'threshold: gate': 7, 'qualification: < 2 trades': 2}; oracle {'threshold: gate': 7, 'qualification: inconclusive': 41, 'qualified': 5, 'qualification: rejected': 3}; learner loss LR 5, HGB 5
- [+0.10, +0.20): lr {'qualification: inconclusive': 55, 'qualification: rejected': 31, 'threshold: gate': 7}; hgb {'qualification: inconclusive': 49, 'threshold: gate': 17, 'qualification: rejected': 25, 'qualified': 1, 'calibration': 1}; oracle {'qualification: inconclusive': 45, 'qualified': 34, 'threshold: gate': 8, 'qualification: rejected': 6}; learner loss LR 34, HGB 33
- [+0.20, +0.40): lr {'qualification: inconclusive': 96, 'qualified': 26, 'qualification: rejected': 14, 'threshold: gate': 16}; hgb {'qualification: inconclusive': 99, 'qualified': 23, 'threshold: gate': 23, 'qualification: < 2 trades': 1, 'qualification: rejected': 6}; oracle {'qualified': 128, 'threshold: gate': 4, 'qualification: rejected': 11, 'qualification: inconclusive': 9}; learner loss LR 102, HGB 105
- [+0.40, +inf): lr {'qualified': 68, 'qualification: inconclusive': 109, 'threshold: gate': 8, 'qualification: rejected': 2}; hgb {'qualified': 89, 'qualification: < 2 trades': 2, 'qualification: inconclusive': 74, 'threshold: gate': 22}; oracle {'qualified': 168, 'threshold: gate': 2, 'qualification: inconclusive': 12, 'qualification: rejected': 5}; learner loss LR 101, HGB 83

Per cell (supported LR/HGB/oracle): null 0.0 econ -0.120: 0/0/0 of 40; null_hidden 0.16 econ +0.050: 4/0/40 of 40; linear 0.02 econ -0.057: 0/0/0 of 40; linear 0.04 econ +0.019: 0/0/0 of 40; linear 0.065 econ +0.115: 0/0/21 of 40; linear 0.1 econ +0.243: 10/8/40 of 40; linear 0.16 econ +0.420: 36/32/40 of 40; linear 0.25 econ +0.626: 31/35/40 of 40; interaction 0.02 econ -0.066: 0/0/0 of 40; interaction 0.04 econ -0.004: 0/0/0 of 40; interaction 0.065 econ +0.096: 0/0/2 of 40; interaction 0.1 econ +0.212: 0/1/38 of 40; interaction 0.16 econ +0.311: 2/5/40 of 40; interaction 0.25 econ +0.455: 10/11/39 of 40; subset 0.04 econ -0.000: 0/0/0 of 40; subset 0.065 econ +0.116: 0/0/0 of 40; subset 0.1 econ +0.279: 0/0/12 of 40; subset 0.16 econ +0.526: 0/0/31 of 40; subset 0.25 econ +0.895: 5/21/33 of 40

## V4

| economic value bin | realizations | LR | HGB | oracle score | LR+HGB pooled | oracle POLICY (ceiling) | LR/HGB/oracle k=1 | k=5 |
|---|---|---|---|---|---|---|---|---|
| [-inf, +0.00) | 132 | 0/132 (0.00-0.03) | 0/132 (0.00-0.03) | 0/132 (0.00-0.03) | 0.000 | 0/132 (0.00-0.03) | 0/0/0 | 0/0/0 |
| [+0.00, +0.05) | 60 | 0/60 (-0.00-0.06) | 0/60 (-0.00-0.06) | 1/60 (0.00-0.09) | 0.000 | 0/60 (-0.00-0.06) | 0/0/1 | 0/0/1 |
| [+0.05, +0.10) | 56 | 0/56 (0.00-0.06) | 0/56 (0.00-0.06) | 1/56 (0.00-0.09) | 0.000 | 0/56 (0.00-0.06) | 0/0/3 | 0/0/1 |
| [+0.10, +0.20) | 93 | 0/93 (0.00-0.04) | 0/93 (0.00-0.04) | 20/93 (0.14-0.31) | 0.000 | 20/93 (0.14-0.31) | 1/0/24 | 0/0/15 |
| [+0.20, +0.40) | 152 | 8/152 (0.03-0.10) | 9/152 (0.03-0.11) | 96/152 (0.55-0.70) | 0.056 | 138/152 (0.85-0.94) | 14/9/97 | 8/9/94 |
| [+0.40, +inf) | 187 | 56/187 (0.24-0.37) | 51/187 (0.21-0.34) | 107/187 (0.50-0.64) | 0.286 | 187/187 (0.98-1.00) | 72/62/107 | 52/50/107 |

False qualification (k=3; k=1 / k=5 counts in brackets):

- null: lr 0/40 (-0.00-0.09) [0/0]; hgb 0/40 (-0.00-0.09) [0/0]; oracle 0/40 (-0.00-0.09) [0/0]
- null_hidden: lr 0/40 (-0.00-0.09) [0/0]; hgb 0/40 (-0.00-0.09) [1/0]; oracle 33/40 (0.68-0.91) [33/33]

First failing stage (planted controls, by bin; learner loss = oracle score qualified but learner not):

- [+0.05, +0.10): lr {'calibration': 49, 'qualification: rejected': 5, 'qualification: inconclusive': 2}; hgb {'calibration': 52, 'qualification: rejected': 3, 'qualification: inconclusive': 1}; oracle {'calibration': 32, 'qualification: inconclusive': 21, 'qualified': 1, 'threshold: gate': 2}; learner loss LR 1, HGB 1
- [+0.10, +0.20): lr {'qualification: inconclusive': 19, 'calibration': 67, 'qualification: rejected': 7}; hgb {'calibration': 81, 'threshold: gate': 2, 'qualification: inconclusive': 5, 'qualification: rejected': 5}; oracle {'calibration': 53, 'qualified': 20, 'qualification: inconclusive': 14, 'threshold: gate': 6}; learner loss LR 20, HGB 20
- [+0.20, +0.40): lr {'calibration': 90, 'qualification: inconclusive': 51, 'qualification: rejected': 2, 'qualified': 8, 'threshold: gate': 1}; hgb {'calibration': 118, 'qualification: inconclusive': 20, 'qualified': 9, 'threshold: gate': 2, 'qualification: rejected': 3}; oracle {'calibration': 45, 'qualified': 96, 'qualification: inconclusive': 1, 'threshold: gate': 10}; learner loss LR 88, HGB 87
- [+0.40, +inf): lr {'qualified': 56, 'qualification: inconclusive': 68, 'calibration': 59, 'threshold: gate': 3, 'support': 1}; hgb {'qualified': 51, 'calibration': 88, 'qualification: inconclusive': 43, 'threshold: gate': 4, 'support': 1}; oracle {'qualified': 107, 'calibration': 39, 'threshold: gate': 40, 'support': 1}; learner loss LR 56, HGB 67

Per cell (supported LR/HGB/oracle): null 0.0 econ -0.120: 0/0/0 of 40; null_hidden 0.16 econ +0.050: 0/0/33 of 40; linear 0.02 econ -0.057: 0/0/0 of 40; linear 0.04 econ +0.019: 0/0/0 of 40; linear 0.065 econ +0.115: 0/0/6 of 40; linear 0.1 econ +0.243: 0/1/26 of 40; linear 0.16 econ +0.420: 24/19/35 of 40; linear 0.25 econ +0.626: 27/30/33 of 40; interaction 0.02 econ -0.066: 0/0/0 of 40; interaction 0.04 econ -0.004: 0/0/0 of 40; interaction 0.065 econ +0.096: 0/0/2 of 40; interaction 0.1 econ +0.212: 0/0/31 of 40; interaction 0.16 econ +0.311: 1/2/37 of 40; interaction 0.25 econ +0.455: 10/3/38 of 40; subset 0.04 econ -0.000: 0/0/0 of 40; subset 0.065 econ +0.116: 0/0/0 of 40; subset 0.1 econ +0.279: 0/0/1 of 40; subset 0.16 econ +0.526: 0/0/5 of 40; subset 0.25 econ +0.895: 2/5/11 of 40

## Registered selection

Null bound (audit level): Wilson upper 0.088 (0/40).
Ineligible: {'V1': ['null_hidden/lr'], 'V2': ['null_hidden/lr'], 'V3': ['null_hidden/lr']}.
Sort keys (pooled LR+HGB [0.10,0.20), oracle [0.10,0.20), pooled [0.20,0.40), pooled [0.40,inf), -index): V1 (0.0, 0.247, 0.115, 0.364, 0); V2 (0.0, 0.269, 0.115, 0.361, -1); V3 (0.005, 0.366, 0.161, 0.42, -2); V4 (0.0, 0.215, 0.056, 0.286, -3)
Selected: V4.
