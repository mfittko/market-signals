# Volatility and big days

Question: can we tell in advance when a big move is coming, without knowing its direction?

Answer: partly. Volatility and session timing are learnable. A target measured relative to ATR mostly learns the session clock. A target measured in % of price ranks big days well (AUC 0.78 to 0.90) but has not met its registered recall bar. The forecast never gives direction.

## Two targets

| Target | Definition | Learnability | Product fit |
|---|---|---|---|
| T2, relative | Side-free excursion over 72 M5 bars of at least 6 ATR | AUC 0.70 to 0.81 ([ablate4]); 0.757 to 0.866 on six instruments ([alert7]) | Poor. It fires before quiet sessions open, where 6 ATR of a tiny ATR is easy. Recall of the largest moves in % of price is 5 to 22% ([alert7]). |
| A1, absolute | Today's excursion from the 22:00 UTC open reaches the instrument's 2018-22 q90 in % of price (for example WTI 5.38%, XAU 1.82%) | AUC 0.779 to 0.862 dev and 0.783 to 0.900 2023+ ([abs11]) | Better. Lead time is 6.5 to 15.8 hours and 62 to 87% of the move is still ahead in 2023+ ([abs11]). |

The T2 model is a 12-coefficient logistic regression on time of day and volatility state. Time of day alone reaches AUC 0.743 on WTI dev; foundation models and retrieval do not add to it ([fm2]). The external review asked to stop shipping T2 as a big-move alert and to register an absolute target measured from the assessment time ([external-review.md](../external-review.md#models-and-targets)).

## The absolute target in detail

- abs11 failed its registered rule mainly on recall at 2 alerts per month. Calibration was within +/-0.05 in every dev year. In the 2020H1 crisis recall was 0.69 to 0.92 ([abs11]).
- abs48 scored the move still ahead after the alert. Pooled AUC is 0.856 [0.846, 0.866] dev and 0.864 [0.854, 0.875] 2023+, against 0.807 and 0.815 for realized volatility, 0.740 and 0.748 for "already moved", and 0.60 to 0.62 for time of day ([abs48]).
- Precision is 0.83 and 0.79 against base rates of 0.165 and 0.146. Dev recall is 0.454, below the 0.5 bar; 2023+ recall is 0.558 ([abs48]).
- At 4 alerts per month (not registered) recall and precision pass in both windows. The frozen thresholds drift in 2023+: XAU fires 5.2 times per month, SPX 0.5 ([abs48]).
- Post-hoc: the two-sided outcome credits reversals. Only 0.56 and 0.51 of alerts see both the remaining move and the full threshold reached ([abs48]).

## What the forecast cannot do

- It gives no direction. The alert adds no direction information beyond "price already moved" ([lean21]).
- It does not improve trading on alert days. A tight-stop trailing policy on armed days loses more than on other days ([wave23]).
- As a stop-width or sizing overlay it does not qualify ([risk8]).
- Gating flips by volatility state does not separate chop from trend ([ladder], [mw6]).

## Earlier lab evidence (grade D)

Spike 4 (2026-10-07, EUR/USD, 2023-2024 test, not a clean holdout) found P(big day) at the open with AUC 0.77 from HAR volatility, continuation to the close of 48 to 52% at every checkpoint, and a realistic operating point of about 2 alerts per month with recall about 0.63 and precision about 0.45. A fixed probability cutoff gave 0 alerts in 2023, so cutoffs must be adaptive. The 2026 model lab on 11 weeks of `candles.db` found the same structure at bar level: the big-move edge is volatility clustering plus time of day. These were not preregistered; the campaigns above supersede them.

## Status

- The A1 model is the best attention signal we have. It is not qualified.
- Next: abs49, a registered 4-per-month operating point with quarterly trailing thresholds ([open-questions.md](../open-questions.md)).

<!-- campaign link definitions -->
[ablate4]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6050530948
[abs11]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6053999202
[abs48]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6085151801
[alert7]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6051635292
[fm2]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6051264073
[ladder]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6046831326
[lean21]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6059927619
[mw6]: https://github.com/mfittko/market-signals/issues/314#issuecomment-6051504954
[risk8]: https://github.com/mfittko/market-signals/issues/311#issuecomment-6051369045
[wave23]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6060307764
