# Campaigns

This table lists all 49 research campaigns from the pre-audit ladder to trend49 (2026-10-07 to 2026-10-09). The GitHub result comment is the primary record. The registry folder holds the protocol, amendments and scripts. Grades follow [README.md](README.md#evidence-grades): B for a preregistered result, D for a post-hoc or unregistered one.

Key numbers are the headline figures of each result comment. "dev" is 2018-2022 (or the campaign's stated development years). "2023+" is the second development window.

| Campaign | Question | Verdict | Key number | Grade | Result | Registry |
|---|---|---|---|---|---|---|
| ladder | Do supertrend flips, a volatility gate, geometry filters, a confirmation follower (D) or an accept/skip model (E) give WTI/XAU M5 an edge? | A-C rejected; D inconclusive (WTI), rejected (XAU); E no entries | WTI flips -0.286 R [-0.320, -0.259], 7,441 trades | B | [A-C][ladderac], [D-E][ladder] | local only |
| v1 | Is the evaluator correct and sensitive? | Defects D1-D4 confirmed; accounting correct | 15/15 fixtures; E has almost no power near 0.05 R | B | [v1] | [v1](registry/campaigns/v1/) |
| v2 | Corrections D1-D4 and a registered E redesign | V4 selected; digest 1b66053d | false qualification 0/40, Wilson upper 0.088 | B | [v2] | [v2](registry/campaigns/v2/) |
| bench1 | Do richer representations (HGB, MiniRocket, TS2Vec) beat LR? | Negative | raw AUC 0.485-0.534 in every fold | B | [bench1] | [bench1](registry/campaigns/bench1/) |
| fm2 | Do zero-shot foundation models or retrieval predict T2? | Negative | FM AUC 0.58-0.67 vs time of day 0.743 (WTI dev) | B | [fm2] | [fm2](registry/campaigns/fm2/) |
| ablate4 | Is the population or the label the problem? | The label | T2 AUC 0.70-0.81; T1/T3 at chance | B | [ablate4] | [ablate4](registry/campaigns/ablate4/) |
| mw6 | Does a multi-week layer qualify on 6 instruments? | No qualifying policy | 3 of 96 Sharpe CIs above 0 | B | [mw6] | [mw6](registry/campaigns/mw6/) |
| alert7 | Does the T2 alert replicate on six instruments? | Replicates, but is a session clock | AUC 0.757-0.866; large-move recall 5-22% | B | [alert7] | [alert7](registry/campaigns/alert7/) |
| risk8 | Can T2 set stop width, size or gating? | Negative for product use | 1 of 24 cells passes | B | [risk8] | [risk8](registry/campaigns/risk8/) |
| xvol9 | Do cross-instrument M5 bursts give entries? | Negative | H1 72 bars -0.062 R [-0.165, +0.047] dev | B | [xvol9] | [xvol9](registry/campaigns/xvol9/) |
| xvol10 | Do M1 bursts give entries? | NO-GO | -0.140 R [-0.191, -0.088] at +5 min (dev) | B | [xvol10] | [xvol10](registry/campaigns/xvol10/) |
| abs11 | Does an absolute (% of price) big-day alert qualify? | Registered FAIL; day-level signal real | A1 AUC 0.78-0.90 | B | [abs11] | [abs11](registry/campaigns/abs11/) |
| notrade12 | Which "do not enter now" reasons help? | 2 of 6 pass (spread, thin hours) | spread rule +0.371 R [+0.351, +0.394] dev | B | [notrade12] | [notrade12](registry/campaigns/notrade12/) |
| limit13 | Do passive limit entries save the spread? | All 8 FAIL | -0.109 to -0.135 R per filled signal | B | [limit13] | [limit13](registry/campaigns/limit13/) |
| daytype14 | Does a day-type classifier with a policy switch pay? | All 8 REJECTED | trend-day AUC 0.80-0.87 at 4 h; policies -0.110 to -0.223 R | B | [daytype14] | [daytype14](registry/campaigns/daytype14/) |
| orb15 | Do opening-range breakouts, fades, open momentum or the EIA window pay? | None supported | ORB15 -0.017 R dev, -0.056 R 2023+ | B | [orb15] | [orb15](registry/campaigns/orb15/) |
| pairs16 | Do relative-value spreads mean-revert profitably? | None supported | M15 half-life 32-66 h vs 24 h hold | B | [pairs16] | [pairs16](registry/campaigns/pairs16/) |
| filter316 | Does the live LLM alert filter beat random thinning? | No | 59th percentile of random thinning | B | [filter316] | [filter316](registry/campaigns/filter316/) |
| season17 | Do hour or weekday drifts survive costs? | Nothing supported | 2 of 27 survive validation; random gives 2.01 | B | [season17] | [season17](registry/campaigns/season17/) |
| pprofit20 | Can P(profit) for a long or short be calibrated? | Partly; no positive expected R | no decile CI above 0 | B | [pprofit20] | [pprofit20](registry/campaigns/pprofit20/) |
| lean21 | Does a big-day alert plus a strong move continue? | Not supported | pooled H12 continuation 47% / 45% | B | [lean21] | [lean21](registry/campaigns/lean21/) |
| lean22 | What is the track record of the card's side lean? | Descriptive; no pass rule; no result comment posted | lean hit 48.7-52.1% on "up" cells in 2023+ (local report) | B | not posted | [lean22](registry/campaigns/lean22/) |
| wave23 | Does riding the wave on alert days pay? | Not supported | -0.07 to -0.26 R per armed day | B | [wave23] | [wave23](registry/campaigns/wave23/) |
| news24 | Do news-backed strong candles continue more than the same candles without news? | REJECT | WTI NEWS minus CONTROL +0.25 R [-0.03, +0.55] dev | B | [news24] | [news24](registry/campaigns/news24/) |
| sess25 | Do session-level breakouts with high tick volume continue? | FAIL | WTI M5 high-volume 6-bar CI spans 0 in both windows | B | [sess25] | [sess25](registry/campaigns/sess25/) |
| rescan26 | Do completed campaigns hold gross of the spread? | 0 rows after Holm (POST-HOC) | 3 of 418 rows raw | D | [rescan26] | [rescan26](registry/campaigns/rescan26/) |
| legs27 | Does chop mean no direction; do long legs reverse longer? | H1 FAIL, H2 FAIL | counter-leg impression only on flat-close days | B | [legs27] | [legs27](registry/campaigns/legs27/) |
| news28 | Can Jev labels clean the GDELT store? | Closed by operator decision; no rerun | Jev-relevant share 0.12-0.54 by instrument | D | not posted (queue row 28) | [news28](registry/campaigns/news28/) |
| flow29 | Does CL aggressor imbalance predict WTI direction? | PASS REVERSAL (one year) | k=3 -5.1 pp [-7.0, -3.3], Holm p 0.002 | B | [flow29] | [flow29](registry/campaigns/flow29/) |
| flipday30 | Can flips per day be predicted at 07:00 UTC? | FAIL | rho -0.06 to +0.21 | B | [flipday30] | [flipday30](registry/campaigns/flipday30/) |
| fade31 | Do fades of fast moves without news pay? | FAIL | WTI M5 gross -0.074 R [-0.098, -0.051] dev | B | [fade31] | [fade31](registry/campaigns/fade31/) |
| flipdens32 | Does recent flip density mark good flips? | FAIL | WTI M5 Holm p at least 0.64 | B | [flipdens32] | [flipdens32](registry/campaigns/flipdens32/) |
| vol33 | Is extreme tick volume a climax or absorption signal? | FAIL | WTI M5 H1 +0.027 R [-0.030, +0.084] dev | B | [vol33] | [vol33](registry/campaigns/vol33/) |
| imom34 | Does market intraday momentum hold on SPX500? | FAIL | -1.87 bps [-3.71, -0.05] dev | B | [imom34] | [imom34](registry/campaigns/imom34/) |
| lead35 | Does a lagging follower catch up after a sharp leader move? | FAIL | XAU to XAG -0.034 ATR [-0.147, +0.078] dev | B | [lead35] | [lead35](registry/campaigns/lead35/) |
| tsmom36 | Does slow time-series momentum on 33 markets pay? | FAIL | gross Sharpe +0.25 [-0.18, +0.69] dev; net -0.28 | B | [tsmom36] | [tsmom36](registry/campaigns/tsmom36/) |
| cal37 | Do turn-of-month, pre-FOMC or pre-holiday effects hold in index CFDs? | FAIL (all three) | pre-FOMC +24.8 bps dev, -14.9 bps 2023+ | B | [cal37] | [cal37](registry/campaigns/cal37/) |
| night38 | Do US index CFDs drift overnight? | FAIL | SPX night +4.01 bps [+0.23, +7.94] dev, 2023+ CI spans 0 | B | [night38] | [night38](registry/campaigns/night38/) |
| ext39 | Do extreme daily moves continue or reverse? | FAIL | pooled h3 +0.116 sigma [-0.022, +0.261] dev | B | [ext39] | [ext39](registry/campaigns/ext39/) |
| vm40 | Does volatility-managed index exposure beat buy-and-hold? | FAIL | Sharpe difference +0.05 dev, -0.51 2023+ | B | [vm40] | [vm40](registry/campaigns/vm40/) |
| cmd41 | Does the ext39 commodity continuation replicate on new commodities? | FAIL | h5 +0.154 sigma dev, -0.058 sigma 2023+ | B | [cmd41] | [cmd41](registry/campaigns/cmd41/) |
| flow42 | Does flow29 replicate on 2024-10 to 2025-10? | FAIL (both primaries) | -0.5 pp [-2.3, +1.7] | B | [flow42] | [flow42](registry/campaigns/flow42/) |
| swing43 | Does an RSI(2) pullback in an uptrend pay over days? | FAIL | indices +16.9 bps [-6.0, +36.4] dev | B | [swing43] | [swing43](registry/campaigns/swing43/) |
| swing44 | Does swing43 replicate on 6 new indices? | FAIL (positive, CI touches 0) | +17.9 bps [-1.7, +38.4] | B | [swing44] | [swing44](registry/campaigns/swing44/) |
| swing45 | Does the pullback rule work on intraday bars? | FAIL | M1 excess +0.07 to +0.17 bps, net -1.3 to -2.3 bps | B | [swing45] | [swing45](registry/campaigns/swing45/) |
| scan46 | Does any classic chart strategy survive a Deflated Sharpe hurdle? | FAIL; 0 finalists; holdout not opened | 0 of 3,030 class cells | B | [scan46] | [scan46](registry/campaigns/scan46/) |
| roll47 | Does a rolling 1-hour move threshold give a signal? | FAIL | WTI min Holm p 0.27 dev | B | [roll47] | [roll47](registry/campaigns/roll47/) |
| abs48 | Does the A1 big-day alert catch the move still ahead? | FAIL (dev recall 0.454 < 0.5) | pooled AUC 0.856 dev, 0.864 2023+ | B | [abs48] | [abs48](registry/campaigns/abs48/) |
| trend49 | What do fixed trend rules (TS12, TS6, SMA200) keep of the recent big rallies after CFD costs, and what does leverage do? | Descriptive (hindsight-selected episodes, not a test) | episodes: TS12 kept 2% of the NAS100 2023-26 rally net; full periods at 10x: 11 of 12 TS accounts below 0.5 in 2023+, all 12 at 0.06 or less in 2018-22 (descriptive) | D (episode capture); full-period leverage tables descriptive | [result][trend49], [leverage][trend49-lev] | [trend49](registry/campaigns/trend49/) |

The ladder campaign has no registry folder. Its frozen files and results are listed in the engine section of [registry/LOCAL-EVIDENCE.md](registry/LOCAL-EVIDENCE.md#engine-folder).

<!-- campaign link definitions -->
[ablate4]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6050530948
[abs11]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6053999202
[abs48]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6085151801
[alert7]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6051635292
[bench1]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6050315703
[cal37]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078391261
[cmd41]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078887870
[daytype14]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054636254
[ext39]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078559927
[fade31]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077727397
[filter316]: https://github.com/mfittko/market-signals/issues/316#issuecomment-6055138146
[flipday30]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077614604
[flipdens32]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077760304
[flow29]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6076402618
[flow42]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6079878152
[fm2]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6051264073
[imom34]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078006875
[ladder]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6046831326
[ladderac]: https://github.com/mfittko/market-signals/issues/309#issuecomment-6046593404
[lead35]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078095798
[lean21]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6059927619
[legs27]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6061919607
[limit13]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054340144
[mw6]: https://github.com/mfittko/market-signals/issues/314#issuecomment-6051504954
[news24]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6072144766
[night38]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078494080
[notrade12]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054177967
[orb15]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054798153
[pairs16]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6055023857
[pprofit20]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6055442748
[rescan26]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6061163925
[risk8]: https://github.com/mfittko/market-signals/issues/311#issuecomment-6051369045
[roll47]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084812980
[scan46]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084524130
[season17]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6055192654
[sess25]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6061199017
[swing43]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6082779550
[swing44]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6082874730
[swing45]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6084121700
[trend49-lev]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6087525298
[trend49]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6087457614
[tsmom36]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078272501
[v1]: https://github.com/mfittko/market-signals/issues/308#issuecomment-6048120221
[v2]: https://github.com/mfittko/market-signals/issues/308#issuecomment-6048905005
[vm40]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6078668435
[vol33]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6077914731
[wave23]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6060307764
[xvol10]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6053719226
[xvol9]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6053439954
