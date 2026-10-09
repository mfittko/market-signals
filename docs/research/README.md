# Research

This folder is the single home for the research evidence of market-signals. Raw market data and databases stay out of git. The [registry manifest](registry/README.md#reproduce) identifies them.

## What lives where

| Folder | Content |
|---|---|
| [registry/](registry/README.md) | One folder per campaign: protocol, amendments, posted texts, scripts and aggregate reports. Also the evaluator v2 code, the trial summary and the data manifests. |
| [audits/](audits/README.md) | The external auditor's reviews, verbatim, each with a follow-up section. |
| [surveys/](surveys/) | Desk research on open-source strategies and the literature. |
| [notes/](notes/) | Earlier design and lab notes. A dated "Superseded by" note at the top marks the parts that later campaigns contradict. |

## What we know (2026-10-09)

The campaigns are development evidence. 2023 onward was inspected before this series, so it is a second development window and never an untouched holdout.

1. No direction edge survives costs at any tested frequency, from M1 to D1, on the six CFD instruments (WTI, XAU, XAG, NATGAS, SPX500, EUR/USD). Direction models stay at chance, with richer representations as well ([bench1](registry/campaigns/bench1/), [ablate4](registry/campaigns/ablate4/)). No re-scored campaign holds even gross of costs after Holm ([rescan26](registry/campaigns/rescan26/)). A mass backtest of 303 classic rule sets finds no cell that clears the Deflated Sharpe hurdle ([scan46](registry/campaigns/scan46/)). Where a small M1 edge exists, the spread is 10 to 20 times larger ([swing45](registry/campaigns/swing45/)). Fades, lead-lag and rolling-move rules fail ([fade31](registry/campaigns/fade31/), [lead35](registry/campaigns/lead35/), [roll47](registry/campaigns/roll47/)).
2. Volatility and timing are learnable. A logistic regression on time of day and volatility predicts a big move relative to ATR with AUC 0.76 to 0.87 on six instruments ([alert7](registry/campaigns/alert7/), [fm2](registry/campaigns/fm2/)). This target acts mostly as a session clock.
3. The cost shield rules pass. Skipping entries with a spread above 0.2 R and entries in thin hours avoids losses ([notrade12](registry/campaigns/notrade12/)). The filtered trades still lose after costs.
4. The daily equity-index pullback rule is the only forward candidate. It is positive in two index sets, but its primary confidence interval includes 0 in at least one window ([swing43](registry/campaigns/swing43/), [swing44](registry/campaigns/swing44/)). A frozen version runs as a forward paper test: https://github.com/mfittko/market-signals/issues/323.
5. The absolute (% of price) big-day model ranks well, with AUC 0.78 to 0.90, but fails its registered recall bar ([abs11](registry/campaigns/abs11/), [abs48](registry/campaigns/abs48/)).

The [campaign index](registry/README.md#campaign-index) lists every verdict with its preregistration and result comments.

## Evidence rules

- Register the protocol in `prereg.json` before any outcome run. Record a timezone-explicit `created` timestamp, what ran before registration, the hypotheses, the pass rule and the sha256 of the code.
- Put every change after registration in an amendment that states whether it came before or after outcomes. A post-outcome change is POST-HOC and counts as development evidence only.
- Develop on 2018-2022 with purged walk-forward folds. Report 2023 onward as a separate development window. Only prospective data or data after 2026-10-07 can confirm a winner.
- Log every configuration, seed, threshold and secondary cell to `trials.jsonl` under the campaign tag. Keep negative, skipped and blocked results.
- Use bid/ask fills, block-bootstrap intervals and Holm across primaries, as the protocol states.

The [registry README](registry/README.md#evidence-rules) gives the full rules.

## Add a new campaign

1. Create `data/research/engine/audit/<id>/` with the campaign script. The id is a short name plus the queue number, for example `roll47`.
2. Write `prereg.json` and `prereg_comment.md` before any outcome run. Post the comment to the research issue.
3. Run the campaign. Write `result_comment.md` and post it. Add a row to `data/research/engine/QUEUE.md` with the verdict and both comment URLs.
4. Copy the record into `docs/research/registry/campaigns/<id>/`: `prereg.json`, amendments, both comments, scripts under 60 KB and `out/` reports under 200 KB. Leave databases, parquet, npz, csv trade lists and raw downloads out.
5. Add the campaign to the index in `registry/README.md` and its trial counts to `registry/trials-summary.csv`. Add a manifest row for any new database.
6. Search the new files for "key", "token", "Authorization" and "api_key" before the commit. Credentials come only from environment variables.

## Add a survey

Save the survey as `surveys/<YYYY-MM-DD>-<topic>.md`. Mark evidence (peer-reviewed and replicated, or audited records) apart from claims. Use full URLs for every source.
