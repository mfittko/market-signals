# Research registry

This folder publishes the records of the research campaigns run on 2026-10-07 to 2026-10-09.
It holds the evaluator v2 code, the registered protocols and amendments, the posted preregistration and result texts, the analysis scripts, the aggregate reports, the evaluator control outputs and a per-campaign trial count.
It answers section 6 of the external audit: https://github.com/mfittko/market-signals/issues/307#issuecomment-6053046878.

The working copy lives in `data/research/engine/` on the operator machine. That directory is gitignored.
This folder is a snapshot of it, taken on 2026-10-09 after abs48.
Raw market data, databases and large outputs stay out of git. The manifests below identify them.

## Evidence rules

All campaigns in the index follow these rules.

- A campaign writes `prereg.json` before any outcome run. The file records a timezone-explicit `created` timestamp, what ran before registration (`before_registration`), the hypotheses, the pass rule and the sha256 of the code it runs. The hash field is `code_sha256`. cal37 names it `sha256`, and flow29 and flow42 name it `file_sha256`.
- A change after registration is an amendment file. An amendment states whether it came before or after outcomes. A post-outcome change is labelled POST-HOC and counts as development evidence only.
- 2018-01-01 to 2022-12-31 is the development window. Models use purged walk-forward folds inside it.
- 2023-01-01 to the run date is a second development window. It was inspected twice before this campaign series, so it is never an untouched holdout. Binding confirmation of any winner needs prospective data or data after 2026-10-07.
- Trial accounting is campaign-level. Every configuration, seed, lookback, threshold and secondary cell is one row in `trials.jsonl` with the campaign tag in `exp`. Negative, skipped and blocked results stay in the record.
- Fills use bid and ask prices. A spread wider than about 0.2 R blocks an entry where the protocol says so. Gross mid results are reported where the protocol names them as primary.
- Confidence intervals use day-block or week-block bootstrap, as each protocol states. Multiple primaries use Holm.

## Layout

| Path | Content |
|---|---|
| `campaigns/<id>/prereg.json` | Registered protocol. pprofit20 also has the registered `prereg_m1.json`, `prereg_m15.json`, `prereg_m1_iso.json` and `prereg_horizons.json`. |
| `campaigns/<id>/*amendment*.json` | Amendments (lean22, news24). vol33 keeps its amendments inside `prereg.json`. |
| `campaigns/<id>/prereg_comment.md`, `result_comment.md` | The texts posted to GitHub. news24 keeps its original names (`prereg_comment.md`, `prereg_comment_edited.md`, `amendment1_comment.md`, `results_comment.md`). rescan26 has one `comment.md`. |
| `campaigns/<id>/*.py`, `*.mjs` | Analysis, fetch and summary scripts, each under 60 KB. |
| `campaigns/<id>/out/` | Aggregate reports: text (`.md`, `.txt`) and JSON, each under 200 KB. |
| `campaigns/<id>/fetch_log.jsonl` | Databento quote and download log (flow29, flow42, cmd41). |
| `campaigns/v1/` | Evaluator audit v1: `REPORT.md`, control scripts, control and power outputs, fixtures, code hashes, library versions. |
| `campaigns/v2/` | Evaluator v2: `prereg.json`, `selected.json`, correction and control scripts, corrections, fixtures, power outputs on the positive controls, code hashes. |
| `evaluator/` | Evaluator v2 code, byte-identical to the frozen version. |
| `manifests/databento-raw.sha256` | sha256 of every Databento raw file used by flow29, flow42 and cmd41. |
| `trials-summary.csv` | Trial rows per campaign. |

Target definitions are part of each protocol. The ladder targets and the trade management are in `evaluator/engine/labels_v2.py` (`POLICY`, `simulate`). The T2 big-move target is defined in `campaigns/ablate4/prereg.json`. The A1 absolute target is defined in `campaigns/abs11/prereg.json`.

## Evaluator v2

Evaluator v2 is `de_v2.py` with the modules it imports. Variant V4 of the registered E redesign was selected on 2026-10-08T01:25:17+0200 (`campaigns/v2/selected.json`).
The digest is `1b66053da304e13ab2539fef82f3ce31f180d1a5478e991a34985f294b72c6bb`.
It is the sha256 of the JSON map `{file: sha256}` over the ten files in `evaluator/SHA256SUMS`, serialized with `json.dumps(files, sort_keys=True)`. `de_v2.code_sha256()` computes it.

`evaluator/` keeps the source layout (`engine/` and `modellab/spike4/`), so the relative path `../modellab/spike4/data.py` resolves.
Check the files from `evaluator/engine`:

```sh
cd docs/research/registry/evaluator/engine
shasum -a 256 -c ../SHA256SUMS
```

Campaigns bench1 to legs27 (except lean21, wave23 and news24) and abs48 log `evaluator: "v2"` and the digest in every trial row.
From news24 on, each campaign uses its own script with the shared `validate.py` (same hash as in v2). Its `prereg.json` records the script hashes.
The library versions of the audit run are in `campaigns/v1/versions.txt`.

## Reproduce

The campaign scripts are in `campaigns/<id>/`. The full outputs stay in `data/research/engine/audit/<id>/` on the operator machine.
A rerun needs the databases below. Each campaign script opens them read-only.
`history.db` is updated daily by the top-up job, so a rerun must cut the data at the campaign's run date. The protocols name the windows.

| Database | Tables | Instruments | Date range | Rows | sha256 | Source and fetch |
|---|---|---|---|---|---|---|
| `data/research/history.db` (9.9 GB) | `candles_ba` (M1 bid/ask), view `candles` (mid) | 18: AU200/AUD, BCO/USD, BTC/USD, DE30/EUR, EU50/EUR, EUR/USD, GBP/USD, JP225/USD, NAS100/USD, NATGAS/USD, SPX500/USD, UK100/GBP, US30/USD, USD/JPY, WTICO/USD, XAG/USD, XAU/USD, XPT/USD | 2018-01-01 to 2026-10-09 | 50,989,791 | not computed (live file, appended daily) | OANDA M1 candles with `price=BA` through the FXEmpire proxy. `data/research/pipeline/history.py`, `count=5000` pages, `INSERT OR IGNORE`. |
| same file | `candles_mid_legacy` | WTICO/USD M1 mid | 2018-01-01 to 2020-06-19 | 820,000 | as above | OANDA mid rows fetched before the switch to bid/ask. |
| same file | `candles_dukascopy` | EUR/USD M1 bid | 2018-01-01 to 2024-12-31 | 2,600,497 | as above | Dukascopy, moved by `pipeline/move_dukascopy.py`. |
| `engine/audit/tsmom36/daily.db` (25.9 MB) | `daily`, `fetch_log` | 33 OANDA markets: 10 FX, 8 indices, 11 commodities, 4 bonds | 2002-05-06 to 2026-10-07 | 209,421 | `58fa10f6200ad6a0bf95cb5b3c7433e2546e966c3031ce1066c7659f6220a6ee` | OANDA daily mid, 17:00 New York alignment, FXEmpire proxy. `audit/tsmom36/fetch.py`. Used by tsmom36, ext39, vm40, swing43, scan46. |
| `engine/audit/swing44/daily.db` (6.1 MB) | `daily`, `fetch_log` | 12 OANDA index candidates (6 kept by the swing44 rule) | 2003-02-02 to 2026-10-07 | 49,934 | `a9dd8347fc6e562cf48befd1b18e88891148bdac073d669492a1c8156d6320c5` | Same source and script pattern as tsmom36. `audit/swing44/fetch.py`. Locked holdout of scan46 (not opened). |
| `engine/audit/news24/news24.db` (6.7 GB) | `files`, `rows` | 6 instruments (WTI, XAU, XAG, EUR/USD, SPX500, NATGAS) | 2018-12-01 to 2026-10-08 | 39,682 files, 11,688,459 rows | not computed (6.7 GB) | GDELT 2.0 GKG 15-minute files, filtered by `audit/news24/relevance.json`. `audit/news24/fetch.py`. |
| `engine/audit/news28/labels.db` (4.6 MB) | `sample`, `labels` | same 6 | 2018-12 to 2026-10 | 6,000 sample rows, 8,751 labels | `2b4a4c8a8b071a974b00f917431daf88b1f6ed84a8e810131537511989727251` | Seeded sample of news24 rows, labelled by the Jev model. `audit/news28/label.py`. |
| `engine/audit/{flow29,flow42,cmd41}/raw/*.dbn.zst` | Databento DBN files | CL.v.0 trades (flow29: 2025-10-01 to 2026-10-08, flow42: 2024-10-01 to 2025-10-01); 10 CME front months ohlcv-1d (cmd41: 2010-06 to 2026-10-08) | see protocols | 26 files | `manifests/databento-raw.sha256` | Databento GLBX.MDP3 through each campaign's `fetch.py`. Cost and bytes per request in `fetch_log.jsonl`. |
| `data/candles.db` | `signals` | live engine signals | 2026-07-22 to 2026-10-08 | see `campaigns/filter316/prereg.json` | live file | The live engine database, read-only. Used by filter316 only. |

Steps for a rerun:

1. Restore the databases above, or rebuild them with the named fetch scripts and check the sha256 values where given.
2. Place `evaluator/engine/` and `evaluator/modellab/spike4/` as `data/research/engine/` and `data/research/modellab/spike4/`. Check `SHA256SUMS`.
3. Copy the campaign scripts from `campaigns/<id>/` to `data/research/engine/audit/<id>/` and compare its sha256 with the hash in `prereg.json`. Run it as `prereg.json` describes.
4. Compare the output with `out/` and `result_comment.md`.

## Trial accounting

`trials.jsonl` is 18.6 MB and stays local. `trials-summary.csv` gives per campaign the exp tags, the row count, the rows marked `role: primary`, the rows that carry `evaluator: "v2"`, the first and last timestamps and the decision.
The snapshot has 42,350 rows through abs48.
Only flow29, flow42, swing43, swing44, swing45 and roll47 mark primary rows. In the other campaigns the primary is named in `prereg.json`.
The `ladder (pre-audit)` rows come from the ladder campaign that the evaluator audit superseded. v1, v2 and lean22 wrote no trial rows.

## What is excluded

- Raw downloads, databases, parquet, npz, pkl and cache files. The manifests above identify them.
- Trade lists (csv), run logs and per-row outputs.
- Output files of 200 KB or more (55 files, mostly per-cell `results.json`). No campaign script reaches the 60 KB limit.
- The pre-audit ladder code in `data/research/engine/` (`de.py`, `labels.py`, `frozen*.json`). Evaluator v2 replaced it.
- pprofit20 per-cell JSON outputs (`artifact_*`, `parity_*`, `results_*`, `diag*`, `explore*`; about 265,000 lines). Its text reports (`out/report*.txt`, `out/card_rule.txt`) carry the aggregates.
- `bench1/ts2vec_src/`, a vendored copy of the upstream TS2Vec code, and the virtual environments of bench1 and fm2.
- `trials.jsonl` (18.6 MB). `trials-summary.csv` replaces it.
- `prereg_body.json`. It is the posted subset of `prereg.json` without `created` and the hashes, so it adds nothing.
- `pprofit20/prereg_draft*.json`. These are drafts replaced by the registered files before any outcome.

news28 has scripts and outputs but no protocol. The operator closed it without a rerun.

## Campaign index

Verdicts are the registered decisions. "prereg.json only" means the protocol was registered in the local file and no separate preregistration comment was posted.

| Campaign | Title | Verdict | Preregistration | Result | Folder |
|---|---|---|---|---|---|
| v1 | Evaluator audit v1: positive controls, trace, accounting, lineage | Defects D1-D4 found; development diagnostics only | none | [result](https://github.com/mfittko/market-signals/issues/308#issuecomment-6048120221) | [campaigns/v1](campaigns/v1/) |
| v2 | Evaluator v2: corrections D1-D4 and registered E redesign | V4 selected; evaluator v2 digest 1b66053d | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/308#issuecomment-6048905005) | [campaigns/v2](campaigns/v2/) |
| bench1 | Representation benchmark (LR, HistGBT, MiniRocket, TS2Vec) | Negative | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6050315703) | [campaigns/bench1](campaigns/bench1/) |
| fm2 | Zero-shot foundation models and embedding retrieval on T2 | Negative | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6051264073) | [campaigns/fm2](campaigns/fm2/) |
| ablate4 | Candidate population x target ablation | Label is the dead end; T2 ranks, direction at chance | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6050530948) | [campaigns/ablate4](campaigns/ablate4/) |
| mw6 | Multi-week layer, 8 policies on 6 instruments | No qualifying policy | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/314#issuecomment-6051504954) | [campaigns/mw6](campaigns/mw6/) |
| alert7 | Replication of the T2 big-move alert on six instruments | Replicates (AUC 0.76-0.87) but T2 is a session clock | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6051635292) | [campaigns/alert7](campaigns/alert7/) |
| risk8 | T2-conditioned stop width, sizing and refit | Negative for product use | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/311#issuecomment-6051369045) | [campaigns/risk8](campaigns/risk8/) |
| xvol9 | Cross-instrument activity bursts, M5 | Negative | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6053439954) | [campaigns/xvol9](campaigns/xvol9/) |
| xvol10 | Cross-instrument bursts, M1 event study | NO-GO | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6053719226) | [campaigns/xvol10](campaigns/xvol10/) |
| abs11 | Absolute (% of price) big-move attention alert | Registered FAIL; A1 day-level signal real | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6053999202) | [campaigns/abs11](campaigns/abs11/) |
| notrade12 | No-trade advisor reasons | 2 of 6 reasons PASS (spread > 0.2 R, thin hours) | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6054177967) | [campaigns/notrade12](campaigns/notrade12/) |
| limit13 | Passive limit-order entries | All 8 variants FAIL | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6054340144) | [campaigns/limit13](campaigns/limit13/) |
| daytype14 | Day-type classifier with regime-switching policy | All 8 variants REJECTED | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6054636254) | [campaigns/daytype14](campaigns/daytype14/) |
| orb15 | Opening-range breakouts and EIA Wednesday window | None supported | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6054798153) | [campaigns/orb15](campaigns/orb15/) |
| pairs16 | Relative-value spread mean reversion | None supported | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6055023857) | [campaigns/pairs16](campaigns/pairs16/) |
| filter316 | Live LLM alert filter scored against outcomes | No better than random thinning | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/316#issuecomment-6055138146) | [campaigns/filter316](campaigns/filter316/) |
| season17 | Intraday and weekday return seasonality | Nothing supported | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6055192654) | [campaigns/season17](campaigns/season17/) |
| pprofit20 | Calibrated P(profit) for a long or short entered now | Calibration passes on some pairs; no expected-R decile above 0 | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6055442748) | [campaigns/pprofit20](campaigns/pprofit20/) |
| lean21 | Big-day alert plus strong move so far, continuation | Not supported | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6059927619) | [campaigns/lean21](campaigns/lean21/) |
| lean22 | Track record of the card lean | Descriptive only; no pass rule | prereg.json only | not posted | [campaigns/lean22](campaigns/lean22/) |
| wave23 | Ride the wave on big-day alert days | Not supported | prereg.json only | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6060307764) | [campaigns/wave23](campaigns/wave23/) |
| news24 | News-backed strong candles vs the same candles without news | REJECT | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6060706463) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6072144766) | [campaigns/news24](campaigns/news24/) |
| sess25 | Session-level breakouts split by tick volume | FAIL | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6060988444) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6061199017) | [campaigns/sess25](campaigns/sess25/) |
| rescan26 | Gross re-scoring of completed campaigns (POST-HOC) | 0 rows hold gross after Holm | none | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6061163925) | [campaigns/rescan26](campaigns/rescan26/) |
| legs27 | Chop and counter-legs (two operator claims) | H1 FAIL, H2 FAIL | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6061778970) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6061919607) | [campaigns/legs27](campaigns/legs27/) |
| news28 | Clean the news24 GDELT store with Jev labels | Closed by operator decision; no rerun | none | not posted | [campaigns/news28](campaigns/news28/) |
| flow29 | Aggressor-side volume imbalance vs WTI direction | PASS REVERSAL (single year; did not replicate in flow42) | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6076320299) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6076402618) | [campaigns/flow29](campaigns/flow29/) |
| flipday30 | Predict flips per day at 07:00 UTC | FAIL | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6077588331) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6077614604) | [campaigns/flipday30](campaigns/flipday30/) |
| fade31 | Fade fast moves without a news burst | FAIL | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6077701852) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6077727397) | [campaigns/fade31](campaigns/fade31/) |
| flipdens32 | Rolling flip density before each supertrend flip | FAIL | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6077727960) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6077760304) | [campaigns/flipdens32](campaigns/flipdens32/) |
| vol33 | Extreme tick volume as climax or absorption | FAIL | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6077853501) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6077914731) | [campaigns/vol33](campaigns/vol33/) |
| imom34 | Market intraday momentum | FAIL | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6077992431) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6078006875) | [campaigns/imom34](campaigns/imom34/) |
| lead35 | Short-horizon lead-lag | FAIL | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6078068454) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6078095798) | [campaigns/lead35](campaigns/lead35/) |
| tsmom36 | Diversified slow time-series momentum, 33 daily markets | FAIL | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6078259026) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6078272501) | [campaigns/tsmom36](campaigns/tsmom36/) |
| cal37 | Calendar effects in 8 stock-index CFDs | FAIL (all three) | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6078373914) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6078391261) | [campaigns/cal37](campaigns/cal37/) |
| night38 | Overnight drift in US stock index CFDs | FAIL | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6078463376) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6078494080) | [campaigns/night38](campaigns/night38/) |
| ext39 | Continuation or reversal after an extreme daily move | FAIL | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6078544479) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6078559927) | [campaigns/ext39](campaigns/ext39/) |
| vm40 | Volatility-managed long-only index exposure | FAIL | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6078627422) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6078668435) | [campaigns/vm40](campaigns/vm40/) |
| cmd41 | Out-of-sample check of the ext39 commodity lead | FAIL | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6078874337) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6078887870) | [campaigns/cmd41](campaigns/cmd41/) |
| flow42 | Confirm flow29 on 2024-10..2025-10 | FAIL (both primaries) | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6079863088) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6079878152) | [campaigns/flow42](campaigns/flow42/) |
| swing43 | RSI(2) pullback in a long-term uptrend, held for days | FAIL | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6082764613) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6082779550) | [campaigns/swing43](campaigns/swing43/) |
| swing44 | Out-of-sample replication of swing43 on 6 indices | FAIL (positive, CI touches 0) | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6082862968) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6082874730) | [campaigns/swing44](campaigns/swing44/) |
| swing45 | swing43 rule on intraday bars (M1 to H4) | FAIL | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6084026498) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6084121700) | [campaigns/swing45](campaigns/swing45/) |
| scan46 | Mass backtest of classic chart strategies with Deflated Sharpe | FAIL; 0 finalists; locked holdout not opened | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6084497493) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6084524130) | [campaigns/scan46](campaigns/scan46/) |
| roll47 | Rolling 1-hour move checked every 15 minutes | FAIL | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6084779140) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6084812980) | [campaigns/roll47](campaigns/roll47/) |
| abs48 | abs11 A1 big-day model scored on the move left after the alert | FAIL (dev recall 0.454 < 0.5); AUC 0.86 both windows | [prereg](https://github.com/mfittko/market-signals/issues/310#issuecomment-6085081061) | [result](https://github.com/mfittko/market-signals/issues/310#issuecomment-6085151801) | [campaigns/abs48](campaigns/abs48/) |
