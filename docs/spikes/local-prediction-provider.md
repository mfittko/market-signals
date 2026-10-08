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

The first round's 6h gauge (alert7 `_ns` artifacts, 12 M5 features, parity 1e-13) is in commit 7f796cf. The second round removed it.

1. Provider. `scripts/local-predict.mjs` is the provider `local`. It produces four parts for the newest closed candle of the viewed instrument and timeframe:
   - **Big-day chance today (side-free).** This is the probability that today's session (22:00 UTC roll) moves T1 % or more from its open, from the abs11 A1 model ("is today becoming a big day").
     - T1 is preregistered per instrument: WTI 5.38%, XAU 1.82%, XAG 3.53%, NATGAS 7.19%, SPX500 2.48%, EUR/USD 0.94%.
     - `data/research/localpred/export_a1.py` (gitignored) exports the latest quarterly fit, cutoff 2026-09-26. It uses the abs11 code (`build`, `walk`, `de.e2_lr_fit`) unchanged.
     - The six artifacts are in `config/prediction-models/artifact_<INST>_A1_nostress.json`. Each holds the feature order, scaler, coefficients, intercept, identity calibrator, T1, cutoff and code hashes.
     - The export drops the cross-instrument `stress` feature. Serving it would need the five other instruments' 252-session history on every run. The variant is named `A1_nostress`.
     - The 16 features are ported to Node from 30-min mid bars: previous-session realized volatility (1, 5, 22 sessions), realized volatility so far and over the last 6h, excursion and move so far, share of T1, range so far against the same-slot median of 60 sessions, time of day, weekday, and opening gap.
     - Once the session has already moved T1 %, the card shows "reached" instead of a probability.
   - **Direction.** A constant with an interval, with no model. The value is the 2023+ up share of the eventual 6h direction on the 30-minute cadence. The interval is a Wilson 95% interval on n/12, because rows 30 minutes apart overlap.
     - WTI 49.9% (48.3 to 51.6), XAU 51.5% (49.9 to 53.1), XAG 49.8% (48.2 to 51.4), NATGAS 49.9% (48.2 to 51.6), SPX500 51.1% (49.5 to 52.7), EUR/USD 50.3% (48.7 to 51.9).
     - Source: `data/research/localpred/up_share.py` (gitignored).
   - **No-trade reasons.** Only the two the study measured as helpful:
     - The spread is wide: (ask close minus bid close) / (1.5 ATR) at the closed bar of the viewed timeframe is above 0.2. Bid and ask come from one small `price=BA` request to the existing candle feed.
     - Thin trading hour: the UTC hour of the bar close is in the fixed per-instrument list.
     - Chase and stretched-move filters (measured as harmful), H1 counter-trend (no effect) and the news caution (unvalidated) are not reasons.
   - **Trend.** The supertrend side on the viewed timeframe and whether H1 agrees. It is shown as context.
   - **News.** The newest headline for the instrument from the engine news cache, within 6 hours. The card shows it, and every run stores its id, escalation, published-at and available-at for a later study. It never sets the side, a reason or a number.
2. Headline rule (declared before any live run).
   - A side clears the margin only when its share is at least 0.5 + 0.05 and its interval lies wholly above 0.5.
   - The headline is Long or Short only when one side clears the margin and no reason fires. Otherwise it is No trade.
   - The bars show long = up share and short = 1 minus up share.
   - The no_trade bar is 1 when a reason fires. Otherwise it is 1 minus |up minus 0.5| / 0.05, the part of the margin the stronger side has not cleared.
   - With the measured shares the headline is always No trade, at about 70% to 100%.
3. Storage and updates.
   - `scripts/predictions.mjs` selects the provider with the new setting `predictionProvider`: `local` is the default, `typesafe-jev` is optional. `predictionActive` needs the toggle for both providers, and a TypeSafe key only for Jev.
   - Local runs use the `predictions` table with provider `local`. A new nullable `detail` column holds the structured parts. The column is added in place on existing databases.
   - A local run is valid until the next candle of its timeframe closes. Reuse returns only runs of the selected provider, and the same candle never gets a second local row.
   - The 30-min window (3600 bars, about 75 sessions) is backfilled once through `acquireWindow`. Later runs fetch only the tail.
   - Updates come from two places. The engine cycle (`runWatcherCycle`, after the alert path) refreshes every watched pair. The card asks again whenever the live feed shows a candle newer than its run covers. It retries every 15 s until the engine has the closed bar.
4. Card and settings.
   - `PredictionPanel.tsx` keeps its structure, styling, the three bars, history and flip notifications.
   - Under the headline there is one note: "Direction: no measurable edge (research). Signals in this system average about −0.1 R after costs; reasons below are measured filters, not buy signals." The reasons follow it.
   - The quality line reads "Big-day chance today: 20% for a move of 5.4% or more (usual 5%) · trend: supertrend up, H1 agrees". "Usual" is the training base rate.
   - A "News: <escalation> · <age>: <headline>" line follows.
   - Predict now and the auto-update checkbox show only for Jev.
   - The settings card has a provider select. The Go allow-list accepts `predictionProvider`, and the `get_prediction` tool text describes both providers.
5. Parity.
   - `export_a1.py` writes a 30-min bar tail covering 75 valid sessions and the last 8 population rows for WTICO/USD and EUR/USD into `test/fixtures/local-predict-a1-parity.json` (371 KB). Each row has x, z, p and the excursion so far.
   - The export also refits the full abs11 model (with stress) walk-forward, so the cost of dropping stress is on record.
6. Running-app check.
   - Setup: a copy of the live engine database, the worktree engine on port 8797, a read-only review proxy and `next dev` on port 3100.
   - Driven with Playwright WebKit at desktop 1440x1000 and mobile 390x844, dark theme.
   - The live engine and console were not touched.

## Findings

- **Parity holds.** Node features match the Python export to max |dx| 2.2e-16 (WTI) and 1.3e-15 (EUR/USD), and p matches to max |dp| 1.5e-16 over 16 rows. The test tolerance is 1e-9.
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
- **Direction carries no edge.**
  - All six up shares sit within 1.5 points of 50%.
  - XAU (51.5%) and SPX500 (51.1%) lean up but do not clear the 5-point margin.
  - The headline is always No trade.
- **The spread reason fires often on M5.** The study blocked 55% to 61% of signals with it. Live WTI M5 showed 0.15 to 0.21 of the stop distance.
- **News is display and storage only.**
  - In the first round, escalated headlines were available in 68% of 30-minute windows for WTI, so the caution reason was not selective. It is removed.
  - News history starts in 2026-07 (2026-10-01 for NATGAS) and is unvalidated.
  - The stored id, escalation, published-at and available-at allow a later prospective study.
  - A test covers that news changes neither the side, the bars nor the big-day number.
- **Live-feed race.** Right after a candle closes, the engine can still lack the closed bar. The first run then returns the previous candle. The card now asks again every 15 s until its run covers the candle before the forming one.
  - In the running-app check, the card moved from the 09:20 to the 09:25 local candle 85 s after the script started, without a click.
  - Screenshots:
    - `docs/spikes/local-prediction-provider/prediction-card-desktop.png` (WTI M5: big-day chance 20%, usual 5%, news line, Inputs open)
    - `docs/spikes/local-prediction-provider/prediction-card-mobile.png` (the same at 390 px)
    - `docs/spikes/local-prediction-provider/prediction-card-after-candle-desktop.png` (the next candle, updated automatically, 26%)
    - `docs/spikes/local-prediction-provider/prediction-card-no-artifact-desktop.png` (BCO/USD: no artifact, big day n/a, 50/50 "not measured")
    - `docs/spikes/local-prediction-provider/settings-prediction-desktop.png` (provider select, local default)
- **Behavior change for existing users.** A settings file with `predictionEnabled: '1'` and no `predictionProvider` now runs local. Jev users must pick Jev again.
- **Verification.**
  - `node --test test/local-predict.test.mjs`: 12 tests pass. They cover parity, short window, reasons, news input, the four parts, news invariance, reached sessions, unavailable model, bid/ask fetch, route provider selection with reuse and dedup, the engine-cycle hook, and the table migration.
  - `npm run verify`: 798 tests pass, plus the console typecheck.
  - `go test ./internal/api ./internal/tools`: pass.

## Recommendation

Graduate with a narrowed scope. Make the local provider the default as a description layer, not a predictor:

1. Keep the card as built:
   - the big-day chance (absolute %, side-free, marked as a research preview)
   - the measured near-50/50 direction with its interval
   - the two study-backed no-trade reasons
   - the trend as context
   - the news line, as display only
2. Treat the big-day number as unqualified until the silent shadow in https://github.com/mfittko/market-signals/issues/313 shows calibration and usefulness live. abs11 A1 failed its preregistered operating rule.
3. Port the A1 features to Go in https://github.com/mfittko/market-signals/issues/312 against the same fixture format: bars, features, z and p. Keep the `A1_nostress` variant unless shadow shows that stress matters.
4. Evaluate the stored news inputs once enough history exists, before news can become a reason.
5. Retire Jev or keep it hidden behind the setting.

Open questions for https://github.com/mfittko/market-signals/issues/312:

- Should the scorer read bid/ask M1 resampled to 30 minutes (exact research inputs), or OANDA mid M30? The measured drift is at most 0.002.
- Should the forming session score before it has 8 bars, or show "not yet" for the first 4 hours after 22:00 UTC?
- Should the thin-hour lists, the direction constants and T1 move into the artifact format of https://github.com/mfittko/market-signals/issues/310, with a version and an evidence reference?
- Does a no-trade reason feed EntryGuard as a REJECTED reason code, or does it stay display-only until it is qualified?
- Should the card show the big-day chance only above its usual rate, or always?
