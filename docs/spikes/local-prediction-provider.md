# Spike

## Question

Spike: replace the Jev provider in the console Prediction card with the local statistical model, and bind its updates to data updates instead of a paid click. Time box: one working session. Scope: (1) a local prediction provider in the engine (scripts/predictions.mjs) scoring per instrument/timeframe from exported research coefficients (data/research/engine/audit/alert7/out/artifact_<INST>_ns.json next-6h volatility gauge with parity fixtures; a calibrated direction model expected near 50/50 with interval; evidenced no-trade reasons such as spread > 0.2 R); (2) features computed in Node from the chart candles with a parity test against the Python fixtures; (3) recompute on each new closed candle in the engine cycle (free, no API key), store like existing runs, card refreshes from data updates with no Predict now click; (4) card shows direction ~50/50 with interval and 'no measurable direction edge', 6h volatility gauge, no-trade reason, trend state as context; Jev stays selectable but not default. Non-goals: entry permission, Go EntryGuard (issue 312), notifications, the big-day alert artifact. Evidence: https://github.com/mfittko/market-signals/issues/310 and https://github.com/mfittko/market-signals/issues/311. Epic https://github.com/mfittko/market-signals/issues/307; prototype ahead of 312.

## Approach

Branch `spike/local-prediction-provider`, run as a dev-loop local implementation under the relaxed `gates.spike` profile. Operator corrections received during the spike are folded in:

- Keep the existing card.
- Show news, but news never sets direction.
- Use only the no-trade reasons the no-trade study (`data/research/engine/audit/notrade12/out/report.txt`) measured as helpful.
- In the second round, replace the ATR-relative 6h gauge with the absolute big-day model from abs11 (https://github.com/mfittko/market-signals/issues/310#issuecomment-6053999202).
- In the second round, drop the news no-trade reason.
- In the second round, merge the notes into one short note.
- After the preview, make the card compact and show only relevant news.
- In the fourth round, replace the fixed near-50/50 direction with calibrated P(profit) per side from the pprofit20 artifacts, under a strict headline rule.

The first round's 6h gauge (alert7 `_ns` artifacts, 12 M5 features, parity 1e-13) is in commit 7f796cf. The second round removed it. The fixed direction constant (2023+ up share per instrument, `data/research/localpred/up_share.py`) is in commit 65feaa6. The fourth round removed it.

1. Provider. `scripts/local-predict.mjs` is the provider `local`. It produces four parts for the newest closed candle of the viewed instrument and timeframe:
   - **Big-day chance today (side-free).** This is the probability that today's session (22:00 UTC roll) moves T1 % or more from its open, from the abs11 A1 model ("is today becoming a big day").
     - T1 is preregistered per instrument: WTI 5.38%, XAU 1.82%, XAG 3.53%, NATGAS 7.19%, SPX500 2.48%, EUR/USD 0.94%.
     - `data/research/localpred/export_a1.py` (gitignored) exports the latest quarterly fit, cutoff 2026-09-26. It uses the abs11 code (`build`, `walk`, `de.e2_lr_fit`) unchanged.
     - The six artifacts are in `config/prediction-models/artifact_<INST>_A1_nostress.json`. Each holds the feature order, scaler, coefficients, intercept, identity calibrator, T1, cutoff and code hashes.
     - The export drops the cross-instrument `stress` feature. Serving it would need the five other instruments' 252-session history on every run. The variant is named `A1_nostress`.
     - The 16 features are ported to Node from 30-min mid bars: previous-session realized volatility (1, 5, 22 sessions), realized volatility so far and over the last 6h, excursion and move so far, share of T1, range so far against the same-slot median of 60 sessions, time of day, weekday, and opening gap.
     - Once the session has already moved T1 %, the card shows "reached" instead of a probability.
   - **P(profit) per side.** This is the calibrated probability that a long and a short entered at the next bar open is profitable after bid/ask costs under a fixed plan:
     - stop 1.5 x Wilder ATR14 = 1R
     - breakeven after +1R
     - target 3R
     - exit at an opposite supertrend flip or after 72 bars
     
     It comes with the mean net R of its P decile.
     - Source: `data/research/engine/audit/pprofit20` (`pp20.py`). The 8 artifacts whose calibration passed are copied unchanged into `config/prediction-models/`:
       - M5: WTICO/USD, XAU/USD, SPX500/USD, EUR/USD
       - M15: WTICO/USD, XAG/USD, SPX500/USD, EUR/USD
     - Model: logistic regression on 18 features plus side and side interactions (37 coefficients), Platt calibration, and an expected-R lookup by P decile per side.
     - `scripts/pprofit.mjs` ports the 18 features: spread / 1R, three time-of-day harmonics, Monday and Friday, realized volatility over 12 and 72 bars, ATR against its 1440-bar mean, the day range so far minus its time-of-day norm, and side-signed move from the day open, supertrend alignment, H1 alignment, distance to the supertrend line and a 3-bar burst.
     - Inputs are the bid/ask candles of the viewed timeframe, with mid = (bid + ask) / 2 per field, as in research. One full 5000-bar fetch per pair is cached in memory; later runs fetch the newest 10 bars.
     - Every other pair (XAG and NATGAS on M5, XAU and NATGAS on M15, other instruments, other timeframes) shows "no calibrated estimate".
   - **No-trade reasons.** Only the two the study measured as helpful:
     - The spread is wide: (ask close minus bid close) / (1.5 ATR) at the closed bar of the viewed timeframe is above 0.2. Bid and ask come from one small `price=BA` request to the existing candle feed.
     - Thin trading hour: the UTC hour of the bar close is in the fixed per-instrument list.
     - Chase and stretched-move filters (measured as harmful), H1 counter-trend (no effect) and the news caution (unvalidated) are not reasons.
   - **Trend.** The supertrend side on the viewed timeframe and whether H1 agrees. It is shown as context.
   - **News.** Headlines for the instrument from the engine news cache, within 6 hours.
     - The store has no relevance tagging, and its per-instrument feeds carry off-topic items. The preview showed "Cristiano Ronaldo pays tribute to Lionel Messi" on WTI.
     - A headline therefore counts as relevant only when it names a keyword from a fixed per-instrument list (`NEWS_KEYWORDS`: oil, crude, OPEC, Hormuz, EIA … for WTI and BCO; gold, bullion, Fed … for metals; LNG, Henry Hub … for NATGAS; S&P, Nasdaq, earnings … for indices; euro, ECB, dollar, Fed for EUR/USD). Matching is on whole words. Other instruments get no news line.
     - Every run stores the newest headline unchanged, with a `relevant` flag, and the newest relevant headline. Each carries id, escalation, published-at and available-at.
     - News never sets the side, a reason or a number.
2. Headline rule (operator-approved, strict; `headline()` in `scripts/local-predict.mjs`).
   - A side clears only when its expected R is at least +0.05 R and its interval lies above 0. If both sides clear, the higher expected R wins.
   - The headline is "Long" or "Short" only when a side clears and no measured no-trade reason fires.
   - Otherwise it is "Neutral" with one reason: the first measured reason (spread wide, thin hour), else "no side clears costs", else "no calibrated estimate".
   - There are no "leaning" labels.
   - The run stores P(long), P(short), the expected R and decile per side, the headline and its reason.
   - `probabilities.long` and `probabilities.short` hold P(profit). `probabilities.no_trade` is 1 for a Neutral headline.
3. Storage and updates.
   - `scripts/predictions.mjs` selects the provider with the new setting `predictionProvider`: `local` is the default, `typesafe-jev` is optional. `predictionActive` needs the toggle for both providers, and a TypeSafe key only for Jev.
   - Local runs use the `predictions` table with provider `local`. A new nullable `detail` column holds the structured parts. The column is added in place on existing databases.
   - A local run is valid until the next candle of its timeframe closes. Reuse returns only runs of the selected provider, and the same candle never gets a second local row.
   - The 30-min window (3600 bars, about 75 sessions) is backfilled once through `acquireWindow`. Later runs fetch only the tail.
   - Updates come from two places. The engine cycle (`runWatcherCycle`, after the alert path) refreshes every watched pair. The card asks again whenever the live feed shows a candle newer than its run covers. It retries every 15 s until the engine has the closed bar.
4. Card and settings.
   - After the operator preview, a local run has a compact layout in the same component. The Jev layout is unchanged.
   - The validity chip sits in the card header.
   - The first line is the headline with its reason, e.g. "Neutral · no side clears costs".
   - Two bars follow, recalculated on every closed candle, e.g. "Long now: 16% chance of profit (avg −0.17 R)" and "Short now: 17% chance of profit (avg −0.15 R)".
     - The bars carry a tooltip with the plan note: "Fixed plan: stop 1.5 ATR, breakeven at +1R, target 3R, out after 6 h. Mostly reflects spread and hour. Not an edge." The same note is the first muted line in Details.
     - A pair without an artifact shows "no calibrated estimate" instead of the bars, in the headline reason.
   - Next comes "Big-day chance today: 26% for ≥ 5.4% (usual 5%) · 2.8% so far". "Usual" is the training base rate.
   - Then "Trend: up, H1 agrees".
   - A warning line appears only when a reason fires, for example "Spread wide (1.15 of the stop distance, limit 0.2)" or "Thin trading hour (04:00 UTC)".
   - A "News: <escalation> · <age>: <headline>" line appears only for a relevant headline that is not routine.
   - "Details", collapsed by default, holds:
     - P and expected R per side with the decile, and the headline rule
     - the −0.1 R note as one muted line
     - the latest relevant headline, even when routine
     - all inputs in plain words
     - the candle and horizon footer
   - The three Jev bars, the subtitle, Predict now and the auto-update checkbox show only for Jev. History (local rows read "Neutral · L 16% / S 17%") and flip notifications are kept.
   - The settings card has a provider select. The Go allow-list accepts `predictionProvider`, and the `get_prediction` tool text describes both providers.
5. Parity.
   - `export_a1.py` writes a 30-min bar tail covering 75 valid sessions and the last 8 population rows for WTICO/USD and EUR/USD into `test/fixtures/local-predict-a1-parity.json` (371 KB). Each row has x, z, p and the excursion so far.
   - The export also refits the full abs11 model (with stress) walk-forward, so the cost of dropping stress is on record.
   - P(profit) fixtures are the pprofit20 parity exports (6000 bid/ask bars, 400 rows) for WTICO/USD M5, EUR/USD M5 and WTICO/USD M15. `data/research/localpred/trim_pp.mjs` (gitignored) compacts each to the last 3000 bars and 82 rows (about 250 KB each). The Node port gives identical results on the last 3000 bars as on all 6000, but drifts at 2000 bars (latr warm-up), so the trim is safe.
6. Running-app check.
   - Setup: a copy of the live engine database, the worktree engine on port 8797, a read-only review proxy and `next dev` on port 3100.
   - Driven with Playwright WebKit at desktop 1440x1000 and mobile 390x844, dark theme.
   - The live engine and console were not touched.

## Findings

- **Parity holds.**
  - Big day: Node features match the Python export to max |dx| 2.2e-16 (WTI) and 1.3e-15 (EUR/USD). p matches to max |dp| 1.5e-16 over 16 rows.
  - P(profit): features match to max |dx| 1.8e-13 (WTI M5), 1.5e-12 (EUR/USD M5) and 7.6e-14 (WTI M15). P matches to 3.2e-15 over 246 rows.
  - The test tolerance is 1e-9.
- **P(profit) has no serving skew.** On the live OANDA bid/ask feed (the last 5000 bars, as production reads them), P at the fixture rows equals the research P to below 5e-6 for all three fixtures. Research and production read the same bid/ask source. Script: `data/research/localpred/pp-skew.mjs` (gitignored).
- **No side clears costs anywhere.**
  - The best decile's expected R per artifact is at most −0.04 R, with one exception: SPX500 M15 long, top decile, +0.011 R.
  - Every value is below the +0.05 R bar. The artifacts also carry no interval for the lookup, so the strict rule cannot name a side even if a decile rose above +0.05 R.
  - The headline is Neutral everywhere. The live check gave WTI M5 at 10:00 local: long 16% (−0.17 R), short 17% (−0.15 R).
  - Discrimination is weak: walk-forward 2023+ AUC is 0.57 to 0.65 per side.
  - The number mostly reflects spread and hour, as the card says.
- **Research cadence.** On M5, research scored only the bars that close on a quarter hour. The card scores every closed bar, so the two M5 bars in between are not covered by research rows. M15 research scored every bar.
- **Dropping stress costs nothing measurable.** Walk-forward 2023+ AUC without and with stress:
  - WTI 0.900 / 0.900
  - XAU 0.838 / 0.839
  - XAG 0.829 / 0.830
  - NATGAS 0.787 / 0.783
  - SPX500 0.831 / 0.830
  - EUR/USD 0.792 / 0.792
- **The model is a research preview, not qualified.**
  - abs11 marked A1 FAIL on its preregistered operating rule for every instrument. At 2 alerts per month, recall or precision fell short in the 2023+ window, and SPX500 also failed its AUC bar.
  - Its AUC beats the volatility baseline (WTI 0.900 against 0.845 in 2023+).
  - Calibration-in-the-large by year runs mostly between 0 and +0.05 (WTI -0.03 to +0.05), so the shown chance leans slightly high.
  - The artifact status field says "display only".
- **Training and serving inputs agree closely.** On the live OANDA mid M30 feed at the fixture bar times:
  - p differs by at most 0.001 (WTI) and 0.002 (EUR/USD), except on the newest bar.
  - On the newest bar, the research data ended mid-bar: WTI 0.001, EUR/USD 0.017.
  - The largest feature gap is `rng_norm` (max 0.03). This is much tighter than the first round's 6h gauge (up to 0.029 on EUR/USD).
  - Script: `data/research/localpred/skew-a1.mjs` (gitignored).
- **The live values are plausible.** WTI at 07:15 UTC had moved 2.3% from the session open, and the model gave a 20% chance of reaching 5.4% (training base rate 5%). The fixture rows on 2026-10-07 afternoon gave 1% to 2%.
- **The window needs history storage lacks.**
  - The model needs 75 sessions of 30-min bars. The engine database held about 2600 M30 bars (57 sessions) per instrument.
  - The first run backfills 3600 bars in one feed request (the feed allows 5000), and later runs read the tail.
  - On H1 and H4 views, big day still refreshes only when the viewed candle closes.
- **The newest session counts as valid while it forms.** Research only kept sessions with at least 8 bars. Scores in the first 4 hours after 22:00 UTC therefore have no research rows behind them.
- **The spread reason fires often on M5.** The study blocked 55% to 61% of signals with it. Live WTI M5 showed 0.15 to 0.21 of the stop distance.
- **News is display and storage only.**
  - In the first round, escalated headlines were available in 68% of 30-minute windows for WTI, so the caution reason was not selective. It is removed.
  - News history starts in 2026-07 (2026-10-01 for NATGAS) and is unvalidated.
  - The stored id, escalation, published-at and available-at allow a later prospective study.
  - A test covers that news changes neither the side, the bars nor the big-day number.
- **Live-feed race.** Right after a candle closes, the engine can still lack the closed bar. The first run then returns the previous candle. The card now asks again every 15 s until its run covers the candle before the forming one.
  - In the running-app check of the compact card, the card moved from the 09:35 to the 09:40 local candle 65 s after the script started, without a click.
  - Screenshots (fourth round):
    - `docs/spikes/local-prediction-provider/prediction-card-desktop.png` (WTI M5: Neutral · no side clears costs, Long 16% / avg −0.17 R, Short 17% / avg −0.15 R, big day 31%, relevant news)
    - `docs/spikes/local-prediction-provider/prediction-card-mobile.png` (the same at 390 px)
    - `docs/spikes/local-prediction-provider/prediction-card-details-desktop.png` and `prediction-card-details-mobile.png` (Details open with the plan note)
    - `docs/spikes/local-prediction-provider/prediction-card-no-artifact-desktop.png` (XAG/USD M5, whose calibration failed: "Neutral · no calibrated estimate", no bars)
    - `docs/spikes/local-prediction-provider/settings-prediction-desktop.png` (provider select, local default)
  - In the compact layout the spread reason showed as a warning line, e.g. NATGAS M5 "Spread wide (1.15 of the stop distance, limit 0.2)". It now appears as the Neutral reason.
- **Behavior change for existing users.** A settings file with `predictionEnabled: '1'` and no `predictionProvider` now runs local. Jev users must pick Jev again.
- **Verification.**
  - `node --test test/local-predict.test.mjs`: 15 tests pass. They cover:
    - big-day and P(profit) parity
    - short window
    - reasons, news relevance and news input
    - the headline rule (Neutral below the bar, the interval required, reason precedence, the higher side wins)
    - P(profit) per side and news invariance
    - reached sessions
    - the no-artifact fallback
    - the bid/ask window cache
    - route provider selection with reuse and dedup
    - the engine-cycle hook and the table migration
  - `npm run verify`: 801 tests pass, plus the console typecheck.
  - `go test ./internal/api ./internal/tools`: pass.

## Recommendation

Graduate with a narrowed scope. Make the local provider the default as a description layer, not a predictor:

1. Keep the card as built:
   - the big-day chance (absolute %, side-free, marked as a research preview)
   - P(profit) per side with average R and the strict Neutral headline, where a calibrated artifact exists
   - the two study-backed no-trade reasons
   - the trend as context
   - the news line, as display only, for relevant headlines that are not routine
2. Treat the big-day number as unqualified until the silent shadow in https://github.com/mfittko/market-signals/issues/313 shows calibration and usefulness live. abs11 A1 failed its preregistered operating rule.
3. Port the A1 features to Go in https://github.com/mfittko/market-signals/issues/312 against the same fixture format: bars, features, z and p. Keep the `A1_nostress` variant unless shadow shows that stress matters.
4. Evaluate the stored news inputs once enough history exists, before news can become a reason.
5. Retire Jev or keep it hidden behind the setting.

Open questions for https://github.com/mfittko/market-signals/issues/312:

- Should the scorer read bid/ask M1 resampled to 30 minutes (exact research inputs), or OANDA mid M30? The measured drift is at most 0.002.
- Should the forming session score before it has 8 bars, or show "not yet" for the first 4 hours after 22:00 UTC?
- Should the pprofit20 artifacts carry a bootstrap interval per lookup decile? The strict headline rule needs one, and without it no side can ever be named.
- Should P(profit) on M5 be scored only at the research cadence (quarter-hour closes), or on every closed bar as now?
- Should the bid/ask window be persisted, so that a restart does not refetch 5000 bars per pair?
- Should the thin-hour lists and T1 move into the artifact format of https://github.com/mfittko/market-signals/issues/310, with a version and an evidence reference?
- Does a no-trade reason feed EntryGuard as a REJECTED reason code, or does it stay display-only until it is qualified?
- Should the card show the big-day chance only above its usual rate, or always?
- Should the news store tag relevance per instrument at ingest (replacing the fixed keyword lists), and should escalation get more than two levels?
