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
- In the fourth round, replace the fixed near-50/50 direction with calibrated P(profit) per side from the pprofit20 artifacts, under a strict headline rule. Later amendments added decile intervals and isotonic-calibrated M1 artifacts.

The first round's 6h gauge (alert7 `_ns` artifacts, 12 M5 features, parity 1e-13) is in commit 7f796cf. The second round removed it. The fixed direction constant (2023+ up share per instrument, `data/research/localpred/up_share.py`) is in commit 65feaa6. The fourth round removed it.

1. Provider. `scripts/local-predict.mjs` is the provider `local`. It produces four parts for the newest closed candle of the viewed instrument and timeframe:
   - **Big-day chance today (side-free).** This is the probability that today's session (22:00 UTC roll) moves T1 % or more from its open, from the abs11 A1 model ("is today becoming a big day").
     - T1 is preregistered per instrument: WTI 5.38%, XAU 1.82%, XAG 3.53%, NATGAS 7.19%, SPX500 2.48%, EUR/USD 0.94%.
     - `data/research/localpred/export_a1.py` (gitignored) exports the latest quarterly fit, cutoff 2026-09-26. It uses the abs11 code (`build`, `walk`, `de.e2_lr_fit`) unchanged.
     - The six artifacts are in `config/prediction-models/artifact_<INST>_A1_nostress.json`. Each holds the feature order, scaler, coefficients, intercept, identity calibrator, T1, cutoff and code hashes.
     - The export drops the cross-instrument `stress` feature. Serving it would need the five other instruments' 252-session history on every run. The variant is named `A1_nostress`.
     - The 16 features are ported to Node from 30-min mid bars: previous-session realized volatility (1, 5, 22 sessions), realized volatility so far and over the last 6h, excursion and move so far, share of T1, range so far against the same-slot median of 60 sessions, time of day, weekday, and opening gap.
     - Once the session has already moved T1 %, the card shows "reached" instead of a probability.
   - **P(profit) per side, per horizon and target.** This is the calibrated probability that a long and a short entered at the next bar open is profitable after bid/ask costs. Since amendment A4 (operator horizons) each artifact is one cell: horizon H = 12 or 48 candles of the viewed timeframe, and one of two targets:
     - `up`: the price at the close of bar i + H is better than the entry after costs (long: bid close above the entry ask; short: ask close below the entry bid).
     - `plan`: a fixed plan ends net positive. Stop 1.5 x Wilder ATR14 = 1R, breakeven after +1R, target 3R, exit at an opposite supertrend flip or after H bars.

     Each cell comes with the mean net R of its P decile and a 95% day-block bootstrap interval per decile.
     - Source: `data/research/engine/audit/pprofit20` (`pp20.py`, preregistration `prereg_horizons.json`). The grid is 3 timeframes x 2 horizons x 2 targets x 6 instruments = 72 cells. Calibration is isotonic on M1 and Platt on M5 and M15, fixed per timeframe. 34 cells passed calibration; 2 of them (NATGAS M1 H12 and H48 plan) are degenerate (median P below 1%). `data/research/localpred/ship_a4.mjs` (gitignored) copies the remaining 32 unchanged into `config/prediction-models/artifact_<INST>_<TF>_H<H>_<target>_pprofit20.json`. The A1 to A3 artifacts (72-bar and 360-bar exits) are removed.
     - Shipped cells (`ok`), cells that failed calibration (`fail` or `-`) and degenerate cells:

       | Cell | WTI | XAU | XAG | NATGAS | SPX500 | EUR/USD |
       | --- | --- | --- | --- | --- | --- | --- |
       | M1 H12 up | ok | ok | - | ok | ok | ok |
       | M1 H12 plan | fail | ok | ok | degenerate | ok | ok |
       | M1 H48 up | ok | ok | - | - | - | fail |
       | M1 H48 plan | ok | ok | ok | degenerate | ok | ok |
       | M5 H12 up | ok | - | ok | ok | ok | ok |
       | M5 H12 plan | ok | ok | - | - | - | fail |
       | M5 H48 up | fail | - | - | - | - | ok |
       | M5 H48 plan | ok | ok | - | - | ok | ok |
       | M15 H12 up | fail | - | - | - | - | ok |
       | M15 H12 plan | fail | - | - | - | - | fail |
       | M15 H48 up | fail | - | - | - | - | fail |
       | M15 H48 plan | ok | - | ok | - | - | ok |

     - All cells use the same 18 features, so one feature row per closed bar scores every shipped cell of the pair. `ppModel(instrument, timeframe, horizon, target)` resolves one cell; `ppAvailable` says whether a pair has any.
     - M1 specifics: tod_norm has 1440 entries (5-minute slot values stored per minute), 1R = 1.5 x ATR14 of mid M1, latr over 1440 M1 bars, the M1 supertrend for st_al and dst, H1 alignment unchanged; at least about 1450 M1 bars of history (the fixture uses 2000).
     - Model: logistic regression on 18 features plus side and side interactions (37 coefficients), and an expected-R lookup by P decile per side (bisect-right on the edges). M5 and M15 use Platt calibration. M1 uses isotonic calibration: knots on the raw score, linear interpolation between them, clipped to the end values outside (numpy.interp semantics), so P can be exactly 0; the card shows "<1%" then. An empty decile carries no expected R or interval (XAG M1 has 3, EUR/USD M1 2, WTI M1 1 per side); the bar then shows its P with "avg R: n/a", and the side counts as not clearing costs.
     - `scripts/pprofit.mjs` ports the 18 features: spread / 1R, three time-of-day harmonics, Monday and Friday, realized volatility over 12 and 72 bars, ATR against its 1440-bar mean, the day range so far minus its time-of-day norm, and side-signed move from the day open, supertrend alignment, H1 alignment, distance to the supertrend line and a 3-bar burst.
     - Inputs are the bid/ask candles of the viewed timeframe, with mid = (bid + ask) / 2 per field, as in research. One full 5000-bar fetch per pair is cached in memory; later runs fetch the newest 10 bars.
     - A pair without any shipped cell (XAU, NATGAS and SPX500 on M15, other instruments, other timeframes) shows "no calibrated estimate". When a measured reason also fires, the headline names the reason and the card adds "Long/short: no calibrated estimate".
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
   - The rule runs per cell. Each cell in `detail.pprofit.cells` stores P, expected R, interval and decile per side, and its own headline and reason.
   - The first shipped cell in the order H12 up, H12 plan, H48 up, H48 plan is the default. Its values fill `detail.pprofit.long/short`, the stored `action`, `probabilities.long/short` and `horizonBars`. `probabilities.no_trade` is 1 for a Neutral headline.
3. Storage and updates.
   - `scripts/predictions.mjs` selects the provider with the new setting `predictionProvider`: `local` is the default, `typesafe-jev` is optional. `predictionActive` needs the toggle for both providers, and a TypeSafe key only for Jev.
   - Local runs use the `predictions` table with provider `local`. A new nullable `detail` column holds the structured parts. The column is added in place on existing databases.
   - A local run is valid until the next candle of its timeframe closes. Reuse returns only runs of the selected provider, and the same candle never gets a second local row.
   - The 30-min window (3600 bars, about 75 sessions) is backfilled once through `acquireWindow`. Later runs fetch only the tail.
   - Updates come from two places. The engine cycle (`runWatcherCycle`, after the alert path) refreshes every watched pair. The card asks again whenever the live feed shows a candle newer than its run covers. It retries every 15 s until the engine has the closed bar.
4. Card and settings.
   - After the operator preview, a local run has a compact layout in the same component. The Jev layout is unchanged.
   - Local runs have no validity chip, because they refresh on every closed candle. Jev keeps it in the card header.
   - The first line is the headline with its reason, e.g. "Neutral · no side clears costs".
   - An "Over" select lists the shipped cells of the pair, e.g. "12 candles (1 h) · price better", "12 candles (1 h) · trade plan", "48 candles (4 h) · trade plan" on WTI M5. The choice is remembered in the browser for every pair; an unavailable choice falls back to the first cell. The headline follows the chosen cell.
   - Two bars follow, recalculated on every closed candle, e.g. "Long now: 47% chance of profit (avg −0.13 R)" and "Short now: 48% chance of profit (avg −0.13 R)" for WTI M5 H12 up.
     - The bars carry a tooltip with the cell note, e.g. "Price after costs at the end of 12 candles: above the entry for long, below for short. Mostly reflects spread and hour. Not an edge." or "Fixed plan: stop 1.5 ATR, breakeven at +1R, target 3R, out after 48 candles. …". The same note is the first muted line in Details. The "long now" and "short now" input lines are hidden in Details, because the bars show the chosen cell.
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
     - History of the last 10 runs, collapsed, as the last item. Every run stays stored as forward evaluation data.
   - The three Jev bars, the subtitle, Predict now and the auto-update checkbox show only for Jev. Flip notifications are kept. Local history rows read "Neutral · L 16% / S 17%"; Jev keeps History below the card.
   - The settings card has a provider select. The Go allow-list accepts `predictionProvider`, and the `get_prediction` tool text describes both providers.
   - Long-short difference. pprofit20 (M5, 2023+) regressed the observed long-minus-short outcome on the predicted P(long) − P(short). The 95% interval of the slope contains 1 only for EUR/USD (0.91 [0.54, 1.26]) and SPX500 (0.63 [0.20, 1.10]). WTI is 0.04 [−0.45, 0.52], NATGAS −0.08, XAU 0.40 [0.06, 0.75] and XAG 0.36 [0.05, 0.70]. For every other instrument the card and the tooltip keep both numbers and add the muted line "Difference between sides not meaningful for this instrument." The list is one constant, `SIDE_DIFF_CALIBRATED` in `scripts/local-predict.mjs`; the engine sends the result to the console as `shield.shared`.
   - The A4 cells give the same picture with more spread: EUR/USD M5 and M15 slopes are 0.63 to 0.98, but XAG M5 H12 up is 0.89 [0.66, 1.13], and SPX500 is 0.33 to 0.63. The constant follows the M5 study for now.
5. Per-candle prediction in the chart tooltip.
   - `GET /api/predictions/series?instrument=&granularity=&from=&to=` (`predictionSeries` in `scripts/predictions.mjs`) returns one entry per closed candle of the window. Each entry has the candle time, the source, `computedAt`, the spread in R, the reasons (code and text) and, per shipped cell, P long, P short, expected R per side, the headline, its reason and `inSample`.
   - Source "live": a stored local run exists for the candle, and its detail is used unchanged. Runs stored before per-cell scores existed are recomputed instead.
   - Source "computed": `localSeries` in `scripts/local-predict.mjs` runs the same scorer as `localPredict`. It makes one pass over the chart window: supertrend ATR for the spread, `ppSeries` once for the bid/ask features, then `scoreCell` and `noTradeReasons` per candle. A test checks that this equals `localPredict` on the truncated window for two candles. The result goes into a new cache table `prediction_series`, keyed by instrument, timeframe, candle and model, with `computed_at` after the candle close. Later reads use the cache and fetch no bid/ask data. Computed rows stay out of the `predictions` table, so card history and reuse are unchanged.
   - A candle without its bid/ask bar is returned as "no bid/ask data for this candle" and is not cached. The forming candle, and a candle whose close is still in the future, are never scored.
   - The window is capped at the newest 500 closed candles (`SERIES_MAX`); the response says `capped: true` when the request covered more. The bid/ask window is the newest 5000 bars, so computed scores reach back about 3500 candles at most.
   - `inSample` is true when the candle starts before the cell artifact's `training_cutoff` (read as UTC). All shipped cells have the cutoff 2026-10-07T18:30 UTC, because the final fit uses all data; every candle before it is in-sample.
   - The engine needs predictions switched on (409 otherwise). It never calls a paid provider for the series, including when Jev is selected.
   - The Go proxy allow-list accepts `GET /predictions/series` only.
   - The instrument page fetches the series for the live window and fetches again when a new candle closes. The tooltip shows one line under the OHLC values for the card's chosen cell, e.g. "Prediction (12 candles · price better): Neutral · Long 46% · Short 47% · spread 0.12 of stop". An in-sample candle adds "(model trained on this period)". A pair without a shipped cell shows "Prediction: no calibrated estimate". The card's cell choice is shared through `platform/web/lib/prediction.ts`, and the chart follows a change without a reload.
6. Shield states (operator decision: the card is a shield against clearly wrong decisions, not trading advice).
   - `shieldState` in `scripts/local-predict.mjs` maps a P decile (artifact lookup) to a state:
     - red "Don't trade now": a measured no-trade reason fires (spread above 0.2 of stop, thin hour; this applies to both sides), or the decile is 1
     - orange "Costly now": decile 2 or 3
     - grey "Normal": decile 4 to 8
     - green "Low-cost moment" (renamed from "Good moment" after operator feedback): decile 9 or 10, and no reason fires
     - no calibrated estimate: red when a reason fires, else grey "Normal · no calibrated estimate"
   - EUR/USD and SPX500 (`SIDE_DIFF_CALIBRATED`): each side gets its own state from its own decile.
   - Every other instrument: one shared state for both sides (`shield.both`, `shield.shared = true`). Its decile is the mean of the two side deciles, rounded down (not the decile of the mean P; the two sides have different decile edges, so the mean P has no clean decile). Its avg R is the mean of the two decile avg R ("n/a" when either is empty). The note "applies to both sides; direction not measurable for this instrument" goes with it. The per-side states are still stored for the record.
   - Operator case that led to this: WTI M5 at 12:25 on 2026-10-08, a strong up bar, showed Long Normal and Short Good moment from a 2 pp P gap (Long 46%, Short 48%). That read as a short call. The shared state for that bar is now "Normal (avg −0.16 R)".
   - The why text is the reason ("spread wide (0.27 of stop)", "thin trading hour (04:00 UTC)") or the decile band for the pair ("bottom 10% of conditions for WTI M5", "usual conditions …", "top 20% of conditions …"). avg R is the decile's mean net R; "avg R n/a" for an empty decile or no estimate.
   - Every run stores both side states with decile, avg R and code, per cell (`detail.pprofit.cells[].shield`) and for the default cell (`detail.shield`, plus `long_state` and `short_state` in the inputs, or `state_both_sides` for a shared state). The series route recomputes the state from the stored deciles, so runs from before this change get it too.
   - Card, EUR/USD and SPX500: two lines replace the headline, "Long ● <State> · <why> · avg <R> R" and the same for Short. Every other instrument: one line "● <State> · <why> · avg <R> R" with the shared note below it, and no Long/Short lines. Dots use the CSS tokens `--bad`, `--warn`, `--muted` and `--good`. When a reason fires it is shown once above the state lines, which read "Don't trade now" without repeating it.
   - Details now opens with the strict rule result ("Trade: Neutral · no side clears costs", still computed and stored), then the Long/Short bars and the side-difference note.
   - Lean (Details only, never in the headline or the state lines). `config/prediction-models/lean_track_record.json` is an unchanged copy of the lean22 track record, keyed `<INST>_<TF>_H<H>_<target>`. `leanFor` in `scripts/local-predict.mjs` picks the side with the higher P of the chosen cell:
     - gap 0 (equal P, common on isotonic M1): no lean line
     - greyed when the gap is below 3 pp, below the cell's own `amendment_A1.grey_below_gap_pp` when that is higher (5 pp for WTI M5 H12 up and XAU M5 plan cells), or always when that value is null
     - text: "Lean: LONG (47% vs 45%) · <amendment_A1.label>", e.g. "right 51% of the time (50-51%) when the two sides end differently; both sides end the same 1% of the time, 2023+"
     - every run stores side, gap in pp, greyed flag and label per cell (`pprofit.cells[].lean`) and for the default cell (`detail.lean`)
   - Tooltip: the same rule. EUR/USD and SPX500 show "Long ● <State> (avg R) · Short ● <State> (avg R)"; every other instrument shows "● <State> (avg R) · applies to both sides; direction not measurable for this instrument". Then the reason when one fires, then the long/short P and spread, muted.
7. Parity.
   - `export_a1.py` writes a 30-min bar tail covering 75 valid sessions and the last 8 population rows for WTICO/USD and EUR/USD into `test/fixtures/local-predict-a1-parity.json` (371 KB). Each row has x, z, p and the excursion so far.
   - The export also refits the full abs11 model (with stress) walk-forward, so the cost of dropping stress is on record.
   - P(profit) fixtures are four A4 parity exports, one per timeframe and both targets: WTICO/USD M5 H12 up, EUR/USD M5 H48 plan, WTICO/USD M15 H48 plan and WTICO/USD M1 H12 up. `data/research/localpred/trim_pp.mjs` (gitignored) compacts each to 42 rows and the bars they need (150 to 245 KB each). `data/research/localpred/pp-check.mjs` shows the trimmed windows are safe: identical results on the last 2400 bars (M5, M15) and 2000 bars (M1) as on the full export; drift starts only at 2200 M5 bars and 1800 M1 bars (latr warm-up). All four cells are shipped, so the test loads the artifacts from config.
8. Running-app check.
   - Setup: a copy of the live engine database, the worktree engine on port 8797, a read-only review proxy and `next dev` on port 3100.
   - Driven with Playwright WebKit at desktop 1440x1000 and mobile 390x844, dark theme.
   - The live engine and console were not touched.

## Findings

- **Parity holds.**
  - Big day: Node features match the Python export to max |dx| 2.2e-16 (WTI) and 1.3e-15 (EUR/USD). p matches to max |dp| 1.5e-16 over 16 rows.
  - P(profit), A4 cells: features match to max |dx| 1.8e-13 (WTI M5 H12 up), 1.5e-12 (EUR/USD M5 H48 plan), 7.6e-14 (WTI M15 H48 plan) and 1.6e-13 (WTI M1 H12 up, isotonic). P matches to 2.5e-15 over 168 rows (exactly on the isotonic rows).
  - The test tolerance is 1e-9.
- **P(profit) has no serving skew.** On the live OANDA bid/ask feed (the last 5000 bars, as production reads them), P at the fixture rows equaled the research P to below 5e-6 for the three A1 to A3 fixtures checked; the A4 cells use the same features. Research and production read the same bid/ask source. Script: `data/research/localpred/pp-skew.mjs` (gitignored).
- **No side clears costs in any cell, at either horizon or target.**
  - The best decile's expected R per shipped A4 cell is negative everywhere: from −0.048 R (WTI M15 H48 plan) and −0.052 R (EUR/USD M15 H12 up) down to −0.43 R (NATGAS M1 H12 up). M1 cells are the worst (−0.08 to −0.43 R).
  - No decile mean reaches +0.05 R, and no interval lies above 0. A test runs the strict rule over all 32 shipped cells, both sides and all deciles: every case reads "Neutral · no side clears costs". The shorter horizon and the price-better target do not change this.
  - The live check gave WTI M5 at 11:40 local: H12 up long 47% / short 48% (avg −0.13 R each), H48 plan long 17% (−0.17 R) / short 18% (−0.16 R). "Price better after 12 candles" sits near a coin flip minus costs; the trade plan rarely reaches its target.
- **P(profit) is close to a spread meter.** Walk-forward 2023+ AUC of the 18-feature model is close to that of a spread-only model in every shipped cell, e.g. WTI M5 H12 up 0.572 against 0.571 (long), EUR/USD M1 H12 plan 0.804 against 0.804, XAU M5 H48 plan 0.583 against 0.558. The high M1 AUCs (0.72 to 0.92 on plan cells) come from the spread: on M1 the spread is a large share of 1R. The card's "Mostly reflects spread and hour" is accurate.
- **Base rates by target.** The share of profitable entries in 2023+ is 38% to 48% for `up` cells on M5 and M15 and 20% to 41% on M1; `plan` cells reach 12% to 30% on M5 and M15 and 2% to 22% on M1.
- **Research cadence.** On M5, research scored only the bars that close on a quarter hour. The card scores every closed bar, so the two M5 bars in between are not covered by research rows. M15 research scored every bar. M1 research scored every 5th bar (the M5 close). The A4 cells keep these cadences.
- **M1 live check (copy setup, 10:5x local, A3 artifacts before A4).** Every M1 pair read Neutral. The spread reason fired on WTI (0.27), XAU (0.22), XAG (0.29), EUR/USD (0.61) and NATGAS (2.13). SPX500 read "no side clears costs". P(profit) on M1 ranged from 8% to 16% per side, with average R from −0.17 to −0.55 R.
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
  - Screenshots (fifth round, A4 cells):
    - `docs/spikes/local-prediction-provider/prediction-card-desktop.png` (sixth round: WTI M5, default cell "12 candles (1 h) · price better": Neutral · no side clears costs, Long 46% / avg −0.13 R, Short 45% / avg −0.16 R, then the muted line "Difference between sides not meaningful for this instrument.")
    - `docs/spikes/local-prediction-provider/prediction-card-mobile.png` (fifth round, the same card at 390 px before the side-difference line)
    - `docs/spikes/local-prediction-provider/prediction-card-details-desktop.png` and `prediction-card-details-mobile.png` ("48 candles (4 h) · trade plan" chosen: Long 17% / avg −0.17 R, Short 18% / avg −0.16 R; Details open with the plan note for 48 candles)
    - `docs/spikes/local-prediction-provider/prediction-card-no-artifact-desktop.png` (BCO/USD M5, no shipped cell: "Neutral · no calibrated estimate", no select, no bars)
    - `docs/spikes/local-prediction-provider/settings-prediction-desktop.png` (provider select, local default)
  - Screenshots (sixth round, chart tooltip, WTI; same review setup):
    - `docs/spikes/local-prediction-provider/tooltip-M1-desktop.png` and `tooltip-M1-mobile.png` (M1 14:08: "Prediction (12 candles · price better): Neutral · Long 43% · Short 44% · spread 0.26 of stop", then the side-difference line)
    - `docs/spikes/local-prediction-provider/tooltip-M5-desktop.png` and `tooltip-M5-mobile.png` (M5 11:00: Neutral · Long 46% · Short 47% · spread 0.12 of stop)
    - `docs/spikes/local-prediction-provider/tooltip-M15-in-sample-desktop.png` (M15 Oct 7 13:30, before the training cutoff: "Prediction (48 candles · trade plan): Neutral · Long 19% · Short 15% · spread 0.08 of stop (model trained on this period)"; WTI M15 ships only H48 plan, so the tooltip falls back to it)
  - The first series read on WTI M1 scored 500 candles in one request (the window was capped) and stored them; the next reads came from the cache.
  - In the compact layout the spread reason showed as a warning line, e.g. NATGAS M5 "Spread wide (1.15 of the stop distance, limit 0.2)". It now appears as the Neutral reason.
- **Shield states on the live window (WTI M5, H12 price better, the last 500 closed candles up to 14:35 local on 2026-10-08; per side, before the shared state).**
  - Long/short pairs: red/red 185, grey/grey 101, green/green 97, grey/green 83, green/grey 34. Orange did not occur. All 185 red candles came from a reason (spread or thin hour), none from decile 1.
  - In 117 of the 500 candles the two sides differed (grey/green or green/grey). For WTI that difference is not measurable (slope 0.04), so these were the misleading cases; the shared state removes them.
  - "Low-cost moment" is relative, not profitable: the top deciles of this cell still average −0.13 R (long) and −0.15 R (short). That is why the label no longer says "good", and the avg R stays on every line.
  - Deciles 9 and 10 are common on WTI M5 now (the live spread is low against the 2019 to 2022 research population), so green shows on about a third of the candles.
  - Screenshots (eighth round; same review setup):
    - `docs/spikes/local-prediction-provider/shared-card-wti-desktop.png` and `shared-card-wti-mobile.png` (WTI M5 15:00: one line "● Low-cost moment · top 20% of conditions for WTI M5 · avg −0.14 R", then "Applies to both sides; direction not measurable for this instrument.")
    - `docs/spikes/local-prediction-provider/shared-tooltip-wti-1225-desktop.png` and `shared-tooltip-wti-1225-mobile.png` (the operator's strong up bar at 12:25: "● Normal (avg −0.16 R) · applies to both sides; direction not measurable for this instrument", then Long 46% · Short 48% muted)
    - `docs/spikes/local-prediction-provider/per-side-card-eurusd-desktop.png` (EUR/USD M5 keeps per-side lines; here "Spread wide (0.25 of stop)" above Long and Short "Don't trade now")
    - `docs/spikes/local-prediction-provider/shield-card-details-desktop.png` and `shield-card-details-mobile.png` (seventh round, per-side WTI before the shared state; Details: "Trade: Neutral · no side clears costs", the greyed Lean line, the bars, the side-difference note)
    - `docs/spikes/local-prediction-provider/shield-tooltip-Donttradenow-Donttradenow-desktop.png` (seventh round, per-side WTI at 08:45, both red from "Spread wide (0.21 of stop)")
- **The lean and the state can point different ways.** At 14:40 the lean was LONG (P 47% vs 47%, greyed), while Short was the greener side (decile 9 against long decile 8), because each side has its own decile edges. The lean is always greyed or hidden on most cells: the A1 decisive hit rates are 50% to 53%.
- **Behavior change for existing users.** A settings file with `predictionEnabled: '1'` and no `predictionProvider` now runs local. Jev users must pick Jev again.
- **Verification.**
  - `node --test test/local-predict.test.mjs`: 25 tests pass. They cover:
    - the shared state: WTI with different side deciles gives one state from floor(mean decile) and the mean avg R; EUR/USD keeps per-side states; the rename to "Low-cost moment"
    - the lean: gap 0 hides, gaps below 3 pp (or the cell's higher threshold) grey, cells without a grey rule always grey, the label is the A1 one, and the run stores it
    - the shield rule table: decile boundaries 1 to 10, sides with different states, reason precedence on both sides, the no-artifact fallback, avg R n/a; the run stores both side states and deciles; the series route returns the stored state
    - the series: `localSeries` equals `localPredict` per candle; forming and unclosed candles excluded; cache hit without a bid/ask read; from/to window; in-sample flag; the route with a stored live run, computed and cached entries, 400 on bad input and 409 while predictions are off
    - big-day parity, and P(profit) parity for four A4 cells (M1, M5, M15; up and plan)
    - cell resolution: only shipped horizon x target cells, `ppAvailable` per pair
    - short window
    - reasons, news relevance and news input
    - the headline rule (Neutral below the bar, the interval required, reason precedence, the higher side wins)
    - the rule over all 32 shipped cells: every decile reads Neutral
    - isotonic calibration (interpolation and clipping), bisect-right deciles and empty deciles
    - P(profit) per cell with its own headline, the default cell, and news invariance
    - reached sessions
    - the no-artifact fallback
    - the bid/ask window cache
    - route provider selection with reuse and dedup
    - the engine-cycle hook and the table migration
  - `npm run verify`: 811 tests pass, plus the console typecheck.
  - `go test ./...` in `platform`: pass, including the allow-list test for `GET /predictions/series` (forwarded) and `POST /predictions/series` (refused).

## Recommendation

Graduate with a narrowed scope. Make the local provider the default as a description layer, not a predictor:

1. Keep the card as built:
   - the big-day chance (absolute %, side-free, marked as a research preview)
   - the shield state (red, orange, grey, green) with its reason and avg R, per side for EUR/USD and SPX500 and shared for every other instrument, per shipped horizon x target cell, with the "Over" select
   - in Details: the strict trade rule, P(profit) bars per side, and the side-difference line outside EUR/USD and SPX500
   - the same scores per closed candle in the chart tooltip, with the in-sample mark
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
- Should the strict rule also require a minimum P decile support, now that intervals exist?
- The 18-feature P(profit) model barely beats a spread-only model in any A4 cell. Should the Go port ship the full model, or a spread-and-hour lookup with the same calibration and decile table?
- "Low-cost moment" stays purely relative (top deciles) while its avg R is negative in every shipped cell. Should it be gated on avg R above 0? Should the decile bands be fixed per artifact (shipped with it) rather than in code?
- Should the side-difference list come from the artifact (a per-cell slope and interval) instead of a console constant? The A4 cells disagree with the M5 study in places (XAG M5 H12 up 0.89, SPX500 M1 0.33 to 0.49).
- Should the series cache move into the Go store, and should the chart get an out-of-sample-only mode? With a final fit on all data, every candle before 2026-10-07 18:30 UTC is in-sample.
- Which cell should be the default (stored action, `probabilities`, agent tool), and should the card hide cells for the pairs where the chosen one failed calibration instead of falling back to the first shipped cell?
- Should P(profit) on M5 be scored only at the research cadence (quarter-hour closes), or on every closed bar as now?
- Should the bid/ask window be persisted, so that a restart does not refetch 5000 bars per pair?
- Should the thin-hour lists and T1 move into the artifact format of https://github.com/mfittko/market-signals/issues/310, with a version and an evidence reference?
- Does a no-trade reason feed EntryGuard as a REJECTED reason code, or does it stay display-only until it is qualified?
- Should the card show the big-day chance only above its usual rate, or always?
- Should the news store tag relevance per instrument at ingest (replacing the fixed keyword lists), and should escalation get more than two levels?
