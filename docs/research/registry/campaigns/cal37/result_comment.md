## cal37 result: FAIL on all three calendar effects

Preregistration: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078373914. The code ran unchanged (cal37.py sha256 `8c678ec4...`). Data: `audit/tsmom36/daily.db` (read-only), daily mid bars closing 17:00 New York, 8 indices, through 2026-10-08. FOMC dates: 175 scheduled statement dates from the Federal Reserve calendars (https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm and fomchistorical2005-2020.htm), stored in `audit/cal37/fomc_dates.json`.

### Verdict
- H1 turn of the month: FAIL. No TOM premium in either window.
- H2 pre-FOMC: FAIL. Positive in dev (raw p 0.020, Holm p 0.060), negative point estimate in 2023+.
- H3 pre-holiday: FAIL. Positive point estimates in both windows, CIs span 0.

### Primary table (bps; difference = event-day mean minus other-day mean; 95% CIs, Holm-level CI in its own column)

| Hyp | Window | n events | Event-day mean [95% CI] | Difference [95% CI] | Holm-level CI | p / Holm p | Net bps per event | MDE80 |
|---|---|---|---|---|---|---|---|---|
| H1 pooled 8 | dev | 216 turns x 8 | +3.64 [-3.17, +9.92] | +0.88 [-7.09, +8.15] | 95.0%: [-7.09, +8.15] | 0.803 / 0.803 | +7.4 (4-day hold) | 10.6 |
| H2 SPX500 | dev | 143 | +27.28 [+5.95, +49.18] | +24.80 [+3.80, +46.73] | 98.3%: [+0.00, +51.52] | 0.020 / 0.060 | +25.5 | 31.0 |
| H3 SPX500 | dev | 161 | +13.08 [-1.27, +27.15] | +10.18 [-4.16, +24.34] | 97.5%: [-6.15, +26.55] | 0.156 / 0.312 | +11.2 | 20.2 |
| H1 pooled 8 | 2023+ | 47 turns x 8 | +7.26 [-4.38, +19.25] | +1.08 [-11.83, +14.23] | 95.0%: [-11.83, +14.23] | 0.821 / 1.000 | +19.9 (4-day hold) | 18.4 |
| H2 SPX500 | 2023+ | 30 | -6.76 [-48.15, +32.25] | -14.86 [-55.69, +25.08] | 98.3%: [-65.05, +32.12] | 0.480 / 1.000 | -8.5 | 57.8 |
| H3 SPX500 | 2023+ | 37 | +14.14 [-1.86, +30.72] | +6.75 [-10.44, +25.22] | 97.5%: [-12.86, +29.03] | 0.492 / 1.000 | +12.3 | 26.5 |

H2 dev: the 98.3% Holm-level CI lower bound is +0.003 bps while the Holm p is 0.060 (the p carries a +1 correction). The registered rule needs both, so dev does not pass. The 2023+ window fails clearly either way.

Net per event subtracts a round trip at the median spread (SPX500 0.47 bps per side) and 3%/yr financing per night. The positive net values are mostly ordinary index drift. For H1 the TOM days earn the same as other days.

### Secondary highlights (never decide the verdict)
- H1 by index: no index has a TOM difference CI above 0 in either window (16 cells). By day position (pooled, dev): day -1 -11.9 [-24.3, +1.7], day +1 +15.2 [-1.8, +32.4], days +2/+3 about 0. In 2023+ all four positions are about +3/-6 with wide CIs. Positive years: 10 of 18 dev, 2 of 4 in 2023+.
- H2 by index (dev): the difference CI is above 0 for SPX500, NAS100, DE30, UK100 and JP225 (+25 to +42 bps). In 2023+ no index has a CI above 0. SPX500, US30, UK100, DE30 and AU200 have negative point estimates. The dev effect comes from 2007-2012 (2008 +148, 2009 +111, 2012 +44 bps) and 2020/2022; 2013-2019 is near 0 or negative. This matches the reported fading of the pre-FOMC drift after 2015.
- H2 exact window (SPX500 M1, 14:00 ET previous day to 13:59 ET statement day): 2018-2022 +27.5 [+4.7, +53.4] vs other days (39 events); 2023+ +5.3 [-15.5, +27.1] (30 events). The 13:59-16:59 ET post window averages -14.7 (2018-22) and -23.0 bps (2023+). The 17:00 daily bar therefore dilutes the pre-announcement drift with a negative post-statement part.
- H3 by index: point estimates are positive in 16 of 16 cells. CIs above 0: HK33 dev (+26.9 [+6.2, +48.0]) and UK100 2023+ (+21.8 [+6.4, +40.6]). SPX500 positive years 12 of 18 and 3 of 4. MDE80 20-27 bps against an observed 7-10 bps: H3 is underpowered, not refuted.
- Annualized contribution if traded alone (SPX500, net): H2 +2.0%/yr dev, -0.7%/yr 2023+; H3 +1.0%/yr dev, +1.2%/yr 2023+. These are long-only index exposure on 8-10 days a year and include the market drift.
- Power: MDE80 is 10.6 bps (H1 dev, pooled), 31 (H2 dev), 20 (H3 dev); 2023+ is 18-58 bps. The 2023+ window cannot detect effects of the size the literature reports.

### Files
- `data/research/engine/audit/cal37/cal37.py`, `fomc_parse.py`, `fomc_dates.json`, `fed_raw/` (Federal Reserve HTML), `prereg_body.json`, `prereg.json`, `prereg_comment.md`, `summarize.py`, `result_comment.md`
- `data/research/engine/audit/cal37/out/describe.json`, `results.json`, `summary.txt`, `run.log`
- 56 rows in `data/research/engine/trials.jsonl` with exp `cal37` (6 primary, 48 per-index, 2 intraday)
