# Evaluator v2 E redesign on the audit controls (dev seeds; 57 realizations, fatal 0)

Supported = qualified under the registered rule (Bonferroni k=3). Bins: realized economic value (oracle-policy R/trade on the control test window).

## V1

| economic value bin | realizations | LR | HGB | oracle score | LR+HGB pooled | oracle POLICY (ceiling) | LR/HGB/oracle k=1 | k=5 |
|---|---|---|---|---|---|---|---|---|
| [-inf, +0.00) | 10 | 0/10 (-0.00-0.28) | 0/10 (-0.00-0.28) | 0/10 (-0.00-0.28) | 0.000 | 0/10 (-0.00-0.28) | 0/0/0 | 0/0/0 |
| [+0.00, +0.05) | 4 | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0.000 | 0/4 (0.00-0.49) | 0/0/0 | 0/0/0 |
| [+0.05, +0.10) | 4 | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0.000 | 0/4 (0.00-0.49) | 0/0/0 | 0/0/0 |
| [+0.10, +0.20) | 7 | 1/7 (0.03-0.51) | 1/7 (0.03-0.51) | 2/7 (0.08-0.64) | 0.143 | 1/7 (0.03-0.51) | 1/1/2 | 1/1/2 |
| [+0.20, +0.40) | 12 | 2/12 (0.05-0.45) | 1/12 (0.01-0.35) | 3/12 (0.09-0.53) | 0.125 | 11/12 (0.65-0.99) | 2/1/3 | 2/1/3 |
| [+0.40, +inf) | 14 | 4/14 (0.12-0.55) | 4/14 (0.12-0.55) | 5/14 (0.16-0.61) | 0.286 | 14/14 (0.78-1.00) | 5/6/5 | 4/4/5 |

False qualification (k=3; k=1 / k=5 counts in brackets):

- null: lr 0/3 (0.00-0.56) [0/0]; hgb 0/3 (0.00-0.56) [0/0]; oracle 0/3 (0.00-0.56) [0/0]
- null_hidden: lr 0/3 (0.00-0.56) [0/0]; hgb 0/3 (0.00-0.56) [0/0]; oracle 2/3 (0.21-0.94) [2/2]

First failing stage (planted controls, by bin; learner loss = oracle score qualified but learner not):

- [+0.05, +0.10): lr {'calibration': 3, 'qualification: rejected': 1}; hgb {'calibration': 4}; oracle {'qualification: inconclusive': 1, 'calibration': 1, 'qualification: < 2 trades': 1, 'threshold: gate': 1}; learner loss LR 0, HGB 0
- [+0.10, +0.20): lr {'qualified': 1, 'qualification: inconclusive': 2, 'calibration': 3, 'qualification: rejected': 1}; hgb {'calibration': 6, 'qualified': 1}; oracle {'qualified': 2, 'qualification: < 2 trades': 1, 'calibration': 3, 'threshold: gate': 1}; learner loss LR 1, HGB 1
- [+0.20, +0.40): lr {'calibration': 5, 'qualified': 2, 'threshold: gate': 2, 'qualification: inconclusive': 3}; hgb {'calibration': 10, 'qualified': 1, 'qualification: inconclusive': 1}; oracle {'calibration': 3, 'qualified': 3, 'qualification: < 2 trades': 4, 'threshold: gate': 2}; learner loss LR 1, HGB 2
- [+0.40, +inf): lr {'qualification: inconclusive': 5, 'qualified': 4, 'calibration': 5}; hgb {'qualified': 4, 'qualification: inconclusive': 5, 'qualification: rejected': 1, 'calibration': 4}; oracle {'qualified': 5, 'qualification: < 2 trades': 3, 'calibration': 2, 'qualification: inconclusive': 3, 'threshold: gate': 1}; learner loss LR 1, HGB 1

Per cell (supported LR/HGB/oracle): linear 0.02 econ -0.106: 0/0/0 of 3; null 0.0 econ -0.154: 0/0/0 of 3; linear 0.04 econ -0.039: 0/0/0 of 3; linear 0.1 econ +0.196: 1/1/2 of 3; linear 0.065 econ +0.064: 0/0/0 of 3; null_hidden 0.16 econ +0.024: 0/0/2 of 3; interaction 0.02 econ -0.041: 0/0/0 of 3; interaction 0.04 econ +0.012: 0/0/0 of 3; interaction 0.065 econ +0.104: 0/0/0 of 3; linear 0.16 econ +0.378: 2/2/3 of 3; linear 0.25 econ +0.626: 3/3/3 of 3; interaction 0.1 econ +0.224: 0/0/1 of 3; subset 0.04 econ +0.084: 0/0/0 of 3; subset 0.065 econ +0.181: 0/0/0 of 3; interaction 0.16 econ +0.342: 0/0/0 of 3; interaction 0.25 econ +0.493: 1/0/1 of 3; subset 0.1 econ +0.353: 0/0/0 of 3; subset 0.16 econ +0.581: 0/0/0 of 3; subset 0.25 econ +0.939: 0/0/0 of 3

## V2

| economic value bin | realizations | LR | HGB | oracle score | LR+HGB pooled | oracle POLICY (ceiling) | LR/HGB/oracle k=1 | k=5 |
|---|---|---|---|---|---|---|---|---|
| [-inf, +0.00) | 10 | 0/10 (-0.00-0.28) | 0/10 (-0.00-0.28) | 0/10 (-0.00-0.28) | 0.000 | 0/10 (-0.00-0.28) | 0/0/0 | 0/0/0 |
| [+0.00, +0.05) | 4 | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0.000 | 0/4 (0.00-0.49) | 0/0/0 | 0/0/0 |
| [+0.05, +0.10) | 4 | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0.000 | 0/4 (0.00-0.49) | 0/0/0 | 0/0/0 |
| [+0.10, +0.20) | 7 | 1/7 (0.03-0.51) | 1/7 (0.03-0.51) | 2/7 (0.08-0.64) | 0.143 | 1/7 (0.03-0.51) | 1/1/2 | 1/1/2 |
| [+0.20, +0.40) | 12 | 2/12 (0.05-0.45) | 1/12 (0.01-0.35) | 3/12 (0.09-0.53) | 0.125 | 11/12 (0.65-0.99) | 2/1/4 | 2/1/3 |
| [+0.40, +inf) | 14 | 4/14 (0.12-0.55) | 4/14 (0.12-0.55) | 5/14 (0.16-0.61) | 0.286 | 14/14 (0.78-1.00) | 5/6/5 | 4/4/5 |

False qualification (k=3; k=1 / k=5 counts in brackets):

- null: lr 0/3 (0.00-0.56) [0/0]; hgb 0/3 (0.00-0.56) [0/0]; oracle 0/3 (0.00-0.56) [0/0]
- null_hidden: lr 0/3 (0.00-0.56) [0/0]; hgb 0/3 (0.00-0.56) [0/0]; oracle 2/3 (0.21-0.94) [2/2]

First failing stage (planted controls, by bin; learner loss = oracle score qualified but learner not):

- [+0.05, +0.10): lr {'calibration': 3, 'qualification: rejected': 1}; hgb {'calibration': 4}; oracle {'qualification: inconclusive': 2, 'calibration': 1, 'qualification: < 2 trades': 1}; learner loss LR 0, HGB 0
- [+0.10, +0.20): lr {'qualified': 1, 'qualification: inconclusive': 2, 'calibration': 3, 'qualification: rejected': 1}; hgb {'calibration': 6, 'qualified': 1}; oracle {'qualified': 2, 'qualification: < 2 trades': 1, 'calibration': 3, 'qualification: inconclusive': 1}; learner loss LR 1, HGB 1
- [+0.20, +0.40): lr {'calibration': 5, 'qualified': 2, 'qualification: inconclusive': 5}; hgb {'calibration': 10, 'qualified': 1, 'qualification: inconclusive': 1}; oracle {'calibration': 3, 'qualified': 3, 'qualification: < 2 trades': 4, 'qualification: inconclusive': 1, 'qualification: rejected': 1}; learner loss LR 1, HGB 2
- [+0.40, +inf): lr {'qualification: inconclusive': 5, 'qualified': 4, 'calibration': 5}; hgb {'qualified': 4, 'qualification: inconclusive': 4, 'threshold: gate': 1, 'qualification: rejected': 1, 'calibration': 4}; oracle {'qualified': 5, 'qualification: < 2 trades': 3, 'calibration': 2, 'qualification: inconclusive': 4}; learner loss LR 1, HGB 1

Per cell (supported LR/HGB/oracle): linear 0.02 econ -0.106: 0/0/0 of 3; null 0.0 econ -0.154: 0/0/0 of 3; linear 0.04 econ -0.039: 0/0/0 of 3; linear 0.1 econ +0.196: 1/1/2 of 3; linear 0.065 econ +0.064: 0/0/0 of 3; null_hidden 0.16 econ +0.024: 0/0/2 of 3; interaction 0.02 econ -0.041: 0/0/0 of 3; interaction 0.04 econ +0.012: 0/0/0 of 3; interaction 0.065 econ +0.104: 0/0/0 of 3; linear 0.16 econ +0.378: 2/2/3 of 3; linear 0.25 econ +0.626: 3/3/3 of 3; interaction 0.1 econ +0.224: 0/0/1 of 3; subset 0.04 econ +0.084: 0/0/0 of 3; subset 0.065 econ +0.181: 0/0/0 of 3; interaction 0.16 econ +0.342: 0/0/0 of 3; interaction 0.25 econ +0.493: 1/0/1 of 3; subset 0.1 econ +0.353: 0/0/0 of 3; subset 0.16 econ +0.581: 0/0/0 of 3; subset 0.25 econ +0.939: 0/0/0 of 3

## V3

| economic value bin | realizations | LR | HGB | oracle score | LR+HGB pooled | oracle POLICY (ceiling) | LR/HGB/oracle k=1 | k=5 |
|---|---|---|---|---|---|---|---|---|
| [-inf, +0.00) | 10 | 0/10 (-0.00-0.28) | 0/10 (-0.00-0.28) | 0/10 (-0.00-0.28) | 0.000 | 0/10 (-0.00-0.28) | 0/0/1 | 0/0/0 |
| [+0.00, +0.05) | 4 | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 1/4 (0.05-0.70) | 0.000 | 0/4 (0.00-0.49) | 0/0/1 | 0/0/0 |
| [+0.05, +0.10) | 4 | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 1/4 (0.05-0.70) | 0.000 | 0/4 (0.00-0.49) | 0/0/1 | 0/0/1 |
| [+0.10, +0.20) | 7 | 1/7 (0.03-0.51) | 1/7 (0.03-0.51) | 2/7 (0.08-0.64) | 0.143 | 1/7 (0.03-0.51) | 1/1/2 | 1/1/2 |
| [+0.20, +0.40) | 12 | 2/12 (0.05-0.45) | 2/12 (0.05-0.45) | 4/12 (0.14-0.61) | 0.167 | 11/12 (0.65-0.99) | 2/2/5 | 2/2/4 |
| [+0.40, +inf) | 14 | 4/14 (0.12-0.55) | 6/14 (0.21-0.67) | 5/14 (0.16-0.61) | 0.357 | 14/14 (0.78-1.00) | 6/8/5 | 4/5/5 |

False qualification (k=3; k=1 / k=5 counts in brackets):

- null: lr 0/3 (0.00-0.56) [0/0]; hgb 0/3 (0.00-0.56) [0/0]; oracle 0/3 (0.00-0.56) [0/0]
- null_hidden: lr 0/3 (0.00-0.56) [0/0]; hgb 0/3 (0.00-0.56) [0/0]; oracle 3/3 (0.44-1.00) [3/3]

First failing stage (planted controls, by bin; learner loss = oracle score qualified but learner not):

- [+0.05, +0.10): lr {'qualification: inconclusive': 1, 'qualification: rejected': 3}; hgb {'qualification: inconclusive': 2, 'threshold: gate': 2}; oracle {'qualification: inconclusive': 2, 'qualified': 1, 'qualification: < 2 trades': 1}; learner loss LR 1, HGB 1
- [+0.10, +0.20): lr {'qualified': 1, 'qualification: inconclusive': 4, 'qualification: rejected': 2}; hgb {'qualification: inconclusive': 1, 'qualified': 1, 'threshold: gate': 3, 'qualification: rejected': 2}; oracle {'qualified': 2, 'qualification: < 2 trades': 3, 'qualification: inconclusive': 2}; learner loss LR 1, HGB 1
- [+0.20, +0.40): lr {'qualification: inconclusive': 9, 'qualified': 2, 'threshold: gate': 1}; hgb {'qualification: inconclusive': 6, 'qualified': 2, 'threshold: gate': 3, 'qualification: rejected': 1}; oracle {'qualified': 4, 'qualification: < 2 trades': 6, 'qualification: inconclusive': 1, 'qualification: rejected': 1}; learner loss LR 2, HGB 2
- [+0.40, +inf): lr {'qualification: inconclusive': 10, 'qualified': 4}; hgb {'qualified': 6, 'qualification: inconclusive': 5, 'threshold: gate': 1, 'qualification: rejected': 2}; oracle {'qualified': 5, 'qualification: < 2 trades': 5, 'qualification: inconclusive': 4}; learner loss LR 1, HGB 1

Per cell (supported LR/HGB/oracle): linear 0.02 econ -0.106: 0/0/0 of 3; null 0.0 econ -0.154: 0/0/0 of 3; linear 0.04 econ -0.039: 0/0/0 of 3; linear 0.1 econ +0.196: 1/1/3 of 3; linear 0.065 econ +0.064: 0/0/2 of 3; null_hidden 0.16 econ +0.024: 0/0/3 of 3; interaction 0.02 econ -0.041: 0/0/0 of 3; interaction 0.04 econ +0.012: 0/0/0 of 3; interaction 0.065 econ +0.104: 0/0/0 of 3; linear 0.16 econ +0.378: 2/3/3 of 3; linear 0.25 econ +0.626: 3/3/3 of 3; interaction 0.1 econ +0.224: 0/0/1 of 3; subset 0.04 econ +0.084: 0/0/0 of 3; subset 0.065 econ +0.181: 0/0/0 of 3; interaction 0.16 econ +0.342: 0/0/0 of 3; interaction 0.25 econ +0.493: 1/0/1 of 3; subset 0.1 econ +0.353: 0/0/0 of 3; subset 0.16 econ +0.581: 0/1/0 of 3; subset 0.25 econ +0.939: 0/1/0 of 3

## V4

| economic value bin | realizations | LR | HGB | oracle score | LR+HGB pooled | oracle POLICY (ceiling) | LR/HGB/oracle k=1 | k=5 |
|---|---|---|---|---|---|---|---|---|
| [-inf, +0.00) | 10 | 0/10 (-0.00-0.28) | 0/10 (-0.00-0.28) | 0/10 (-0.00-0.28) | 0.000 | 0/10 (-0.00-0.28) | 0/0/0 | 0/0/0 |
| [+0.00, +0.05) | 4 | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 1/4 (0.05-0.70) | 0.000 | 0/4 (0.00-0.49) | 0/0/1 | 0/0/0 |
| [+0.05, +0.10) | 4 | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0/4 (0.00-0.49) | 0.000 | 0/4 (0.00-0.49) | 0/0/0 | 0/0/0 |
| [+0.10, +0.20) | 7 | 0/7 (0.00-0.35) | 0/7 (0.00-0.35) | 2/7 (0.08-0.64) | 0.000 | 1/7 (0.03-0.51) | 1/0/2 | 0/0/2 |
| [+0.20, +0.40) | 12 | 1/12 (0.01-0.35) | 1/12 (0.01-0.35) | 6/12 (0.25-0.75) | 0.083 | 11/12 (0.65-0.99) | 2/1/6 | 1/1/6 |
| [+0.40, +inf) | 14 | 3/14 (0.08-0.48) | 4/14 (0.12-0.55) | 7/14 (0.27-0.73) | 0.250 | 14/14 (0.78-1.00) | 3/4/7 | 3/3/7 |

False qualification (k=3; k=1 / k=5 counts in brackets):

- null: lr 0/3 (0.00-0.56) [0/0]; hgb 0/3 (0.00-0.56) [0/0]; oracle 0/3 (0.00-0.56) [0/0]
- null_hidden: lr 0/3 (0.00-0.56) [0/0]; hgb 0/3 (0.00-0.56) [0/0]; oracle 2/3 (0.21-0.94) [2/2]

First failing stage (planted controls, by bin; learner loss = oracle score qualified but learner not):

- [+0.05, +0.10): lr {'calibration': 3, 'qualification: rejected': 1}; hgb {'calibration': 4}; oracle {'qualification: inconclusive': 2, 'calibration': 1, 'threshold: gate': 1}; learner loss LR 0, HGB 0
- [+0.10, +0.20): lr {'qualification: inconclusive': 3, 'calibration': 2, 'qualification: rejected': 2}; hgb {'calibration': 6, 'qualification: inconclusive': 1}; oracle {'qualified': 2, 'qualification: inconclusive': 2, 'calibration': 1, 'threshold: gate': 2}; learner loss LR 2, HGB 2
- [+0.20, +0.40): lr {'calibration': 7, 'qualified': 1, 'qualification: inconclusive': 4}; hgb {'calibration': 8, 'qualified': 1, 'qualification: inconclusive': 3}; oracle {'calibration': 4, 'qualified': 6, 'threshold: gate': 2}; learner loss LR 5, HGB 5
- [+0.40, +inf): lr {'qualification: inconclusive': 7, 'qualified': 3, 'calibration': 4}; hgb {'qualified': 4, 'qualification: inconclusive': 4, 'threshold: gate': 1, 'calibration': 5}; oracle {'qualified': 7, 'calibration': 2, 'threshold: gate': 5}; learner loss LR 4, HGB 3

Per cell (supported LR/HGB/oracle): linear 0.02 econ -0.106: 0/0/0 of 3; null 0.0 econ -0.154: 0/0/0 of 3; linear 0.04 econ -0.039: 0/0/0 of 3; linear 0.1 econ +0.196: 0/0/2 of 3; linear 0.065 econ +0.064: 0/0/1 of 3; null_hidden 0.16 econ +0.024: 0/0/2 of 3; interaction 0.02 econ -0.041: 0/0/0 of 3; interaction 0.04 econ +0.012: 0/0/0 of 3; interaction 0.065 econ +0.104: 0/0/0 of 3; linear 0.16 econ +0.378: 1/2/3 of 3; linear 0.25 econ +0.626: 3/2/3 of 3; interaction 0.1 econ +0.224: 0/0/2 of 3; subset 0.04 econ +0.084: 0/0/0 of 3; subset 0.065 econ +0.181: 0/0/0 of 3; interaction 0.16 econ +0.342: 0/0/2 of 3; interaction 0.25 econ +0.493: 0/1/3 of 3; subset 0.1 econ +0.353: 0/0/0 of 3; subset 0.16 econ +0.581: 0/0/0 of 3; subset 0.25 econ +0.939: 0/0/0 of 3

## Registered selection

Null bound (audit level): Wilson upper 0.088 (0/40).
Ineligible: none.
Sort keys (pooled LR+HGB [0.10,0.20), oracle [0.10,0.20), pooled [0.20,0.40), pooled [0.40,inf), -index): V1 (0.143, 0.286, 0.125, 0.286, 0); V2 (0.143, 0.286, 0.125, 0.286, -1); V3 (0.143, 0.286, 0.167, 0.357, -2); V4 (0.0, 0.286, 0.083, 0.25, -3)
Selected: V3.
