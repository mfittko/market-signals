> Superseded by (2026-10-09): the "Build next" recommendation.
> The volatility-and-time big-move target replicates on 2018-2026 data but acts as a session clock relative to ATR, and it misses price-scale big moves ([alert7](../registry/campaigns/alert7/)).
> Richer models and foundation models add nothing over the volatility-and-time logistic regression ([bench1](../registry/campaigns/bench1/), [fm2](../registry/campaigns/fm2/)).
> The direction verdict below still holds.
> The body below is the original note.

# Model lab: local models vs base rate vs TypeSafe Jev

Date: 2026-10-07. Data: a copy of data/candles.db, covering 2026-07-20 to 2026-10-07 (about 11 weeks).

## Verdict

1. **Direction: no edge.** No local model and no Jev prompt predicts long vs short better than chance on held-out time. This holds at M1, M5, M15 and H1, and at horizons of 3, 6 and 12 bars.
   - "Direction given a big move" failed the walk-forward in 129 of 132 setups. Its test finalist scored -1.3% skill with AUC 0.47.
   - The 3-class finalists hit 0.46 to 0.52 on test, with negative mean edge.
2. **Move size: a real but small edge.** The big-move models beat the base rate on held-out time.
   - At M5 over 3 bars, test AUC is about 0.60 on all three pairs, and every interval excludes 0.5. Skill is +1.8% to +2.1%, and every interval is above zero.
   - WTI M15 over 3 bars reaches AUC 0.655 [0.625, 0.708].
   - The edge is volatility clustering plus time of day. A volatility+time-only logistic regression matches the full model.
3. **The 3-class skill is all magnitude.** A direction-free control matches or beats every 3-class finalist. The control splits the big-move probability evenly between long and short.
4. **Jev.**
   - The production prompt is miscalibrated: log loss is 42% to 54% worse than the base rate on 300 new test bars per pair.
   - Its directional hit rate is 51.7% (228 of 441) on the new bars and 56% (105 of 187) on the seed-2 bars. Pooled, that is 53% [49%, 57%], so it cannot be told apart from 50%.
   - composite-3 sits at the base rate.
   - As a big-move scorer, Jev gets AUC 0.50 to 0.59. The local model gets about 0.60 on the same bars, with log loss lower by 0.09 to 0.28 nats per bar, and every interval excludes zero.

**Build next:** a "volatility ahead" big-move probability over the next 3 to 6 bars. Use logistic regression or LightGBM on about 10 volatility and time features, retrained weekly. Drop long/short/no_trade as a trading signal. Keep supertrend and the existing confirmation rules for direction. Skip further Jev prompt work and the sequence model for direction.

## Method

- **Features (33):** the numeric values behind the jevState buckets, plus momentum over 1, 3, 10 and 30 bars, EMA20 slope, volatility regime, hour and session, weekday, and the M15/H1/H4 supertrend. "live" means the 17 features that match Jev's inputs.
- **Labels:** the harness label (window, ATR14, 0.5 ATR threshold). The threshold scales by sqrt(h/3) for 6 and 12 bars.
- **Timeframes:** M1 and M5 are stored. M15 and H1 are resampled from M5 with the production resampleCandles.
- **No lookahead:** three assertions, all passed on every dataset.
  - The window ends at the sampled bar.
  - The indicator summary's timestamp equals the sampled bar.
  - Scrambling every later bar leaves the features unchanged.
- **Split, strictly by time and purged by the horizon:**
  - train 0% to 55%, validation 55% to 70%; models and hyperparameters are chosen on validation only;
  - walk-forward ranking on three rolling folds: 70-75%, 75-80% and 80-85%;
  - test is the newest 15%, scored once per frozen finalist.
- **Intervals:** moving-block bootstrap with 48-row blocks. The Jev and seed-2 comparisons use a paired bootstrap.
- **Multiple testing:**
  - The search covered 396 setups and 1188 configurations. 88 of 396 had a walk-forward interval above zero; the shuffled-label rerun gave 0 of 396, with a maximum skill of 2.3%.
  - By target: 50 of 132 big-move setups passed, 35 of 132 3-class setups, and 3 of 132 direction-given-big setups.
  - 5 of 13 frozen finalists held up on test, and all 5 are big-move setups.
- **Jev:** 1803 new calls. No call failed.

## Ranked finalists (test slice)

| # | Setup | Walk-forward skill [gain CI] | Test skill [gain CI] | Test AUC [CI] | Hit / edge | Volatility+time only | Shuffled | Magnitude only |
|---|---|---|---|---|---|---|---|---|
| 1 | WTI M15 big 3 bars, all features, LightGBM | +4.3% [0.013, 0.039] | +4.96% [0.022, 0.051] | 0.655 [0.625, 0.708] | | +5.70% | +0.59% | |
| 2 | EUR M5 big 3 bars, all, LightGBM | +1.9% [0.007, 0.019] | +2.12% [0.008, 0.021] | 0.604 [0.572, 0.633] | | +1.08% | -0.18% | |
| 3 | WTI M5 big 3 bars, all, LightGBM | +0.8% [-0.006, 0.017] | +2.01% [0.006, 0.023] | 0.596 [0.562, 0.627] | | +1.67% | -0.57% | |
| 4 | EUR M5 big 6 bars, all, LightGBM | +2.3% [0.008, 0.024] | +1.89% [0.007, 0.019] | 0.593 [0.564, 0.621] | | +1.59% | -0.50% | |
| 5 | XAU M5 big 3 bars, all, LightGBM | +0.9% [0.001, 0.010] | +1.77% [0.007, 0.016] | 0.595 [0.569, 0.624] | | +1.49% | -0.10% | |
| 6 | EUR M15 big 12 bars, all, logreg | +9.2% [0.034, 0.088] | +4.41% [-0.001, 0.066] | 0.636 [0.566, 0.738] | | +5.78% | -0.09% | |
| 7 | XAU M15 big 3 bars, all, LightGBM | +5.6% [0.020, 0.057] | +1.93% [-0.012, 0.038] | 0.601 [0.547, 0.664] | | +2.76% | -2.34% | |
| 8 | EUR M15 3-class 12 bars, all, logreg | +6.3% [0.033, 0.099] | +2.46% [-0.009, 0.072] | | 0.481 / -0.171 | +4.09% | +0.28% | +2.31% |
| 9 | XAU M5 3-class 3 bars, all, LightGBM | +0.7% [0.003, 0.013] | +0.55% [0.000, 0.012] | | 0.471 / -0.080 | +0.48% | -0.09% | +1.01% |
| 10 | EUR M5 3-class 3 bars, live, LightGBM | +0.8% [0.004, 0.014] | +0.45% [-0.002, 0.011] | | 0.516 / -0.043 | +0.37% | -0.06% | +0.67% |
| 11 | WTI M5 3-class 3 bars, live, LightGBM | +0.8% [-0.000, 0.018] | +0.35% [-0.003, 0.012] | | 0.459 / -0.127 | +1.35% | -0.17% | +0.64% |
| 12 | XAU M1 3-class 12 bars, live, LightGBM | +0.3% [0.001, 0.006] | +0.10% [-0.002, 0.003] | | 0.522 / +0.067 | +0.07% | -0.02% | +0.07% |
| 13 | XAU M5 direction given big, 3 bars, all, LightGBM | +0.9% [0.001, 0.011] | -1.30% [-0.017, -0.002] | 0.470 [0.426, 0.517] | | -0.98% | -0.03% | |

## Jev on the same 300 test bars per pair (M5, 3 bars)

| Pair | Target | Model skill / AUC | Jev production skill / AUC | Jev composite-3 skill / AUC | Model minus Jev production log loss [CI] | Jev production hit (calls) |
|---|---|---|---|---|---|---|
| WTI | 3-class | +0.56% | -54.2% | -0.11% | -0.593 [-0.802, -0.402] | 0.532 (154), edge -0.033 |
| XAU | 3-class | -0.27% | -42.5% | -0.87% | -0.466 [-0.630, -0.307] | 0.536 (151), edge +0.056 |
| EUR | 3-class | +0.71% | -48.2% | -0.15% | -0.532 [-0.694, -0.377] | 0.478 (136), edge -0.057 |
| WTI | big move | +3.27% / 0.606 | -21.2% / 0.496 | -17.3% / 0.593 | -0.167 [-0.237, -0.100] | |
| XAU | big move | +1.87% / 0.596 | -12.7% / 0.577 | -42.3% / 0.531 | -0.092 [-0.154, -0.034] | |
| EUR | big move | +2.15% / 0.609 | -14.7% / 0.543 | -22.5% / 0.495 | -0.115 [-0.182, -0.049] | |

Against composite-3 on the 3-class target, the model differs by -0.007 to -0.009 nats, and every interval spans zero.

## Seed-2 bars (chunked walk-forward, 117 to 120 bars per pair; values are log loss)

| Pair | Base rate | Best local model | Jev production | Local minus base rate [CI] | Jev minus base rate [CI] | Jev hit (calls) |
|---|---|---|---|---|---|---|
| WTI | 1.112 | 1.124 | 1.526 | +0.012 [-0.029, 0.061] | +0.414 [0.203, 0.627] | 0.559 (59) |
| XAU | 1.097 | 1.056 | 1.652 | -0.041 [-0.080, -0.001] | +0.555 [0.225, 0.935] | 0.525 (61) |
| EUR | 1.097 | 1.128 | 1.546 | +0.031 [0.006, 0.056] | +0.449 [0.234, 0.677] | 0.597 (67) |

## Calibration and top features

- **EUR M5 big-move calibration bands** (mean predicted against observed): 0.315 vs 0.288, 0.407 vs 0.424, 0.593 vs 0.576, 0.685 vs 0.712.
- **3-class calibration:** 0.307 vs 0.305 and 0.392 vs 0.397. These probabilities never leave 0.2 to 0.5.
- **Big-move features:** hour and session, volume ratio, ATR regime, ATR%.
- **3-class features:** volume ratio, distance to VWAP and EMA, bars since flip. They work through magnitude only.

## Caveats

- 11 weeks of data; each held-out slice is about 11 days.
- H1 is underpowered.
- EUR/USD has no stored M1 data.
- Tuning was kept small, and XGBoost, CatBoost and Optuna were skipped.
- The shuffled-label null is lenient because it breaks the time structure.
