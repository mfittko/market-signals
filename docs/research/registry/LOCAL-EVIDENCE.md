# Local evidence

This file lists the research evidence that stays on the operator machine. Run outputs, databases and raw downloads are data, so git does not hold them.
It was generated on 2026-10-09T21:15:47+02:00 by `docs/research/registry/tools/local_evidence.py`. Re-run that script after a new campaign.
It covers 48 campaign folders and 1,029 local files.

Each campaign section gives the local folder, the interpreter, the inputs and the run window. Its table lists every local file that is not in the registry, with size, sha256 and modification time.
The "Written by" column comes from the usage text in the campaign scripts. A file that no usage line names is marked "not documented in the script usage".

## Databases

| Database | Bytes | sha256 | Table | Rows | Distinct instrument values | First | Last | Source and fetch |
|---|---|---|---|---|---|---|---|---|
| `data/research/history.db` | 9,910,407,168 | not computed (over 200 MB) | `candles_ba` | 50,989,791 | 18 | 2018-01-01T00:00:00.000000000Z | 2026-10-09T04:19:00.000000000Z | OANDA M1 bid/ask through the FXEmpire proxy; data/research/pipeline/history.py (daily top-up job) |
| `data/research/history.db` | 9,910,407,168 | not computed (over 200 MB) | `candles_dukascopy` | 2,600,497 | 1 | 2018-01-01T22:00:00.000000000Z | 2024-12-31T21:59:00.000000000Z | Dukascopy EUR/USD M1 bid; moved once by data/research/pipeline/move_dukascopy.py |
| `data/research/history.db` | 9,910,407,168 | not computed (over 200 MB) | `candles_mid_legacy` | 820,000 | 1 | 2018-01-01T23:00:00.000000000Z | 2020-06-19T09:29:00.000000000Z | OANDA M1 mid rows fetched before the switch to bid/ask; data/research/pipeline/schema_ba.py |
| `data/research/engine/audit/tsmom36/daily.db` | 25,911,296 | `58fa10f6200ad6a0bf95cb5b3c7433e2546e966c3031ce1066c7659f6220a6ee` | `daily` | 209,421 | 33 | 2002-05-06T21:00:00 | 2026-10-07T21:00:00 | OANDA daily mid, 17:00 New York alignment; engine/audit/tsmom36/fetch.py |
| `data/research/engine/audit/tsmom36/daily.db` | 25,911,296 | `58fa10f6200ad6a0bf95cb5b3c7433e2546e966c3031ce1066c7659f6220a6ee` | `fetch_log` | 33 | 33 |  |  | OANDA daily mid, 17:00 New York alignment; engine/audit/tsmom36/fetch.py |
| `data/research/engine/audit/swing44/daily.db` | 6,135,808 | `a9dd8347fc6e562cf48befd1b18e88891148bdac073d669492a1c8156d6320c5` | `daily` | 49,934 | 12 | 2003-02-02T22:00:00 | 2026-10-07T21:00:00 | OANDA daily mid; engine/audit/swing44/fetch.py |
| `data/research/engine/audit/swing44/daily.db` | 6,135,808 | `a9dd8347fc6e562cf48befd1b18e88891148bdac073d669492a1c8156d6320c5` | `fetch_log` | 12 | 12 |  |  | OANDA daily mid; engine/audit/swing44/fetch.py |
| `data/research/engine/audit/news24/news24.db` | 6,658,396,160 | not computed (over 200 MB) | `files` | 39,682 |  | 25727040 | 29857680 | GDELT 2.0 GKG 15-minute files, filtered by relevance.json; engine/audit/news24/fetch.py |
| `data/research/engine/audit/news24/news24.db` | 6,658,396,160 | not computed (over 200 MB) | `rows` | 11,688,459 | 47 | 25727040 | 29857680 | GDELT 2.0 GKG 15-minute files, filtered by relevance.json; engine/audit/news24/fetch.py |
| `data/research/engine/audit/news28/labels.db` | 4,612,096 | `2b4a4c8a8b071a974b00f917431daf88b1f6ed84a8e810131537511989727251` | `labels` | 8,751 | 6 | 2026-10-09T06:31:46 | 2026-10-09T07:45:09 | Seeded news24 sample labelled by the Jev model; engine/audit/news28/sample.py and label.py |
| `data/research/engine/audit/news28/labels.db` | 4,612,096 | `2b4a4c8a8b071a974b00f917431daf88b1f6ed84a8e810131537511989727251` | `sample` | 6,000 | 6 | 25734480 | 29856270 | Seeded news24 sample labelled by the Jev model; engine/audit/news28/sample.py and label.py |

Times in `news24.db` and `labels.db` are minutes since 1970-01-01 UTC.

## Engine folder

Local folder: `/Users/mfittko/github/market-signals/data/research/engine/` (repository path `data/research/engine/`).
`trials.jsonl` is the full trial log. `QUEUE.md` is the campaign queue with every verdict. `results/` holds the outputs of the pre-audit ladder campaign.
`cache/` (derived bar caches) and `.venv/` (the engine interpreter) are not listed.

| File | Bytes | sha256 | Modified |
|---|---|---|---|
| `QUEUE.md` | 41,451 | `03b16f496339ef7c36475ac52b0ad00b4ef747e08cca4b67aaf36235ebd567ab` | 2026-10-09T21:10:46+02:00 |
| `de.py` | 53,930 | `5e0acdd5c4623639afafd8de5fcb937ba6635d15a164551a2535c3c311a73d13` | 2026-10-07T23:03:14+02:00 |
| `diag.py` | 1,318 | `10c0047860c3f5cb6b411699425b7070ad1e4c9ef52fd76f06fd1b5caa0b958f` | 2026-10-07T19:25:26+02:00 |
| `frozen.json` | 818 | `607302e20f34b989374875384fcf8c98af3b6d212a9c408691a74ca554ef9911` | 2026-10-07T20:01:59+02:00 |
| `frozen_de.json` | 6,951 | `dcbef4237ad1b89ce0f9267af4a1069b646f9724cccc06960321fdafda28e4c7` | 2026-10-07T23:02:14+02:00 |
| `labels.py` | 7,412 | `3252f515847fa9accd5125e2ae7d30b82bb6ba41585196d61e7045156fc8d87e` | 2026-10-07T19:20:40+02:00 |
| `selfchecks.txt` | 905 | `61c2ab45f1579ec2848f506d7bfb59b822bb5cde5212de24088de7394dab631c` | 2026-10-07T19:26:16+02:00 |
| `selfchecks_de.txt` | 686 | `357fc4e104e07d36675fa86dc2c5fd3040d32384448b36a17c80264a76f957ef` | 2026-10-07T23:01:43+02:00 |
| `sens.py` | 1,091 | `a8746fa4de43d4811590368e49264e496407788bae661741421a156cc9058d1b` | 2026-10-07T19:26:05+02:00 |
| `test_ledger.jsonl` | 345 | `69e0daebd74276964575311dc2cf0ff0b5aa3f62fe16ebb88957a5646cf95454` | 2026-10-07T22:49:30+02:00 |
| `test_ledger_de.jsonl` | 1,384 | `7a149e2ffb87e97607a1b5b8b99208fdb02f81ce09a5f3a5cbcd1dae7c8700b5` | 2026-10-07T23:03:27+02:00 |
| `trials.jsonl` | 18,743,777 | `3d6f63185fb391fcf66b82c4c5385ffc975c164f109844c99720c0595687302f` | 2026-10-09T21:09:47+02:00 |
| `results/de_dev_WTICO_USD.json` | 15,619 | `310291bf7782e4d6490089af18f833dd652b4858549ebce5be62cbc57afa6335` | 2026-10-07T23:01:57+02:00 |
| `results/de_dev_WTICO_USD.md` | 5,978 | `b71d71849875c58ab70bc5cfdd5a9bce7567c96e2f1da779db97accb60f1ae43` | 2026-10-07T23:01:57+02:00 |
| `results/de_dev_XAU_USD.json` | 19,015 | `f6bb9b558316717ca60ada4b1c369c2104f103fbfc251159cba0985400f567c7` | 2026-10-07T23:02:14+02:00 |
| `results/de_dev_XAU_USD.md` | 7,437 | `a17c94dd2112c8f2377ad31c000ce7d825ac61023923e904f964eef50ea60da0` | 2026-10-07T23:02:14+02:00 |
| `results/de_test_WTICO_USD.json` | 8,502 | `f72757fe1fb32bbd6bd9a8ad46d33b1e1ed2d36a7eb7fc69657d12e6ed892317` | 2026-10-07T23:03:26+02:00 |
| `results/de_test_WTICO_USD.md` | 3,547 | `e2d0b93d060d9179a6c7ea38ff01b51af8522e5398db88026273f28db911625c` | 2026-10-07T23:03:26+02:00 |
| `results/de_test_XAU_USD.json` | 15,358 | `6c80b805166606d55cdf7b54333b07879b0b141eb987412cd63e64c96c78e2e9` | 2026-10-07T23:03:40+02:00 |
| `results/de_test_XAU_USD.md` | 5,456 | `5b8419e3ca2d1bbf88c529ca27d97a615011673ab8b2f3b8d5220d06fe0ba937` | 2026-10-07T23:03:40+02:00 |
| `results/dev.json` | 7,819 | `501db9e79542fc69fb7291e98b94b4f6b428e6ad1d5a77b1ffdcca2f6b88bd9d` | 2026-10-07T20:01:59+02:00 |
| `results/dev.md` | 1,162 | `b97f13c16b6521851378708608237d674992d29061796feb244604c4daad097b` | 2026-10-07T20:01:59+02:00 |
| `results/test.json` | 3,833 | `ff401e1ebc071ec72f88f727c894d25afde0f4dd816177dce01a8c81b615bccc` | 2026-10-07T22:49:44+02:00 |
| `results/test.md` | 1,115 | `cfb6e6043cc82451aadf1ce9c75f8b9c191128f014953397f1bd90200d199ca8` | 2026-10-07T22:49:44+02:00 |

## ablate4

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/ablate4/` (repository path `data/research/engine/audit/ablate4/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T03:40:49+02:00 to 2026-10-08T03:50:22+02:00 (file modification times).
- Scripts in the registry: `count.py`, `diag_t2.py`, `run.py`, `summarize.py`.
- Documented commands: `python diag_t2.py INST`; `python run.py register`; `python run.py amend "reason"`; `python run.py run INST`; `python summarize.py WTICO_USD`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `out/WTICO_USD.json` | 699,762 | `eab30275967f572fc0cbf5eabce5b7943ee96985adcb5b788f304ea314982b94` | 2026-10-08T03:47:35+02:00 | `python run.py run INST` |
| `out/WTICO_USD.md` | 37,069 | `12851c93b40895c767827b2dd8390321aff7ba99c2376987637d37b89d9b9df2` | 2026-10-08T03:47:54+02:00 | not documented in the script usage |
| `out/WTICO_USD.run1.json` | 656,693 | `dc61192f919b4f5710884d9c232c6a1ca57576db91b6fe72e80173727ab0c4f1` | 2026-10-08T03:40:49+02:00 | `python run.py run INST` |
| `out/WTICO_USD.run1.md` | 34,102 | `69832637f6607b8f6ba2ff24719da467120fb6619ebb0cce7c01581508adec53` | 2026-10-08T03:40:57+02:00 | not documented in the script usage |
| `out/XAU_USD.json` | 559,119 | `2b2d3799daa7ca18517c142ab13f578a7ffd7f62c2c1b6c3d4513945aa9228d8` | 2026-10-08T03:47:11+02:00 | `python run.py run INST` |
| `out/XAU_USD.md` | 26,857 | `6eeec99016b829d5734ad59cfe1d18d630d5adfa68fbc92e2ba17cac80dd48ea` | 2026-10-08T03:48:02+02:00 | not documented in the script usage |
| `out/diag_T1_WTICO_USD.json` | 660 | `68acaf947de985f2881c55a5f68e8e5466c17c094dd94dd9ef2a81da4210e074` | 2026-10-08T03:50:12+02:00 | `python run.py run INST` |
| `out/diag_T2_WTICO_USD.json` | 659 | `5644794dd6e499c6b073c7d5bdedf3ac523b06ad74b23b1fd721feffe13a4be8` | 2026-10-08T03:49:46+02:00 | `python run.py run INST` |
| `out/diag_T2_XAU_USD.json` | 655 | `45b188bd939e66aa584c38c26f360f3f2f04e6ce2273cbcad381a4cef25d134a` | 2026-10-08T03:50:22+02:00 | `python run.py run INST` |
| `out/diag_T4_WTICO_USD.json` | 657 | `a71e42a4bcc618aff4cc139c6536e1b3e7a311a30ca0fb1a2dd105da4039c4c6` | 2026-10-08T03:50:01+02:00 | `python run.py run INST` |
| `out/wti.log` | 22,229 | `3840abbf6c884e40c8adf3ac3690ce9a12a7d7399a8db1652071d2d8a4e96623` | 2026-10-08T03:47:35+02:00 | `run log` |
| `out/wti.run1.log` | 22,229 | `67ac15aadae65e46ca5b6d36abffa91da7314ff00c9998e59b02d4e1794195b5` | 2026-10-08T03:40:49+02:00 | `run log` |
| `out/xau.log` | 15,814 | `056c38ab755029d882004e9b0c8ab894c701b2dc341e333ce76361d6c52c9c1e` | 2026-10-08T03:47:11+02:00 | `run log` |

## abs11

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/abs11/` (repository path `data/research/engine/audit/abs11/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T08:29:54+02:00 to 2026-10-08T08:34:46+02:00 (file modification times).
- Scripts in the registry: `abs11.py`, `summarize.py`.
- Documented commands: `python abs11.py thresholds`; `python abs11.py register`; `python abs11.py amend "reason"`; `python abs11.py check`; `python abs11.py run INST`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `out/EUR_USD.json` | 73,095 | `7947fd3b768f4d9b478fda42fa8f8514145e1f4c6e5741f842e330ed720ae33b` | 2026-10-08T08:34:19+02:00 | `python abs11.py run INST` |
| `out/NATGAS_USD.json` | 73,163 | `4c107b1e416ab84f4e865113d1c62cc420a407f5b4af729525c6aa1ec91bcbac` | 2026-10-08T08:34:14+02:00 | `python abs11.py run INST` |
| `out/SPX500_USD.json` | 70,814 | `a538e0b74425c88eea645533a3ff7efe16afc3bf77021210dfa9ee14ddeef875` | 2026-10-08T08:34:16+02:00 | `python abs11.py run INST` |
| `out/WTICO_USD.json` | 73,228 | `2ba536c12d15013b31a2dd451bd9c9f380cf113acd640aeb8de7101195aa5216` | 2026-10-08T08:34:17+02:00 | `python abs11.py run INST` |
| `out/XAG_USD.json` | 73,582 | `1e730bd7cd15e2d8a26a304f1fe3006e9c89d6c9561485e061e8f41c7d98b8e9` | 2026-10-08T08:34:14+02:00 | `python abs11.py run INST` |
| `out/XAU_USD.json` | 73,201 | `33a5c3caacda24fc00d1ad761e67888a704557e3341cd57cc9cb21c782b5d9b5` | 2026-10-08T08:31:57+02:00 | `python abs11.py run INST` |
| `out/bars_EUR_USD.npz` | 5,240,914 | `9355498de207420c280920668d30a8098b27706edeb8aba815e60eb0e2c9afea` | 2026-10-08T08:29:59+02:00 | not documented in the script usage |
| `out/bars_NATGAS_USD.npz` | 4,936,018 | `595a72b67bc3f0fea7c8536e373933ea48d7b4ba34bf991cfbfd04e458f3c6ce` | 2026-10-08T08:29:58+02:00 | not documented in the script usage |
| `out/bars_SPX500_USD.npz` | 4,968,322 | `83c4f108b75b3e1fa9fa956d4a640cb2b04d74719b7413bb81965024d6dede65` | 2026-10-08T08:29:58+02:00 | not documented in the script usage |
| `out/bars_WTICO_USD.npz` | 4,975,810 | `ea0279e2eb775afc09542eb3a34efa06e71a897a260834db2aa3a05429230e07` | 2026-10-08T08:29:54+02:00 | not documented in the script usage |
| `out/bars_XAG_USD.npz` | 4,976,674 | `8756664cb3457fbcce50ec78f2b028ecc666520c57f79c2176c407822daed899` | 2026-10-08T08:29:58+02:00 | not documented in the script usage |
| `out/bars_XAU_USD.npz` | 4,977,682 | `fdb93f5fd29a7ca90db826ecad4745cc5680f20c540fce2086582b32176b253c` | 2026-10-08T08:29:57+02:00 | not documented in the script usage |
| `out/log_EUR_USD.txt` | 49 | `795461caddae06ae3836d7c9186e9446b36db7e8313d35f472d21052cac51539` | 2026-10-08T08:34:19+02:00 | not documented in the script usage |
| `out/log_NATGAS_USD.txt` | 52 | `a87de239504e08e8fa0d2ba6a9afb30bbd8da2f5c46794f069eadb40d58a4ba4` | 2026-10-08T08:34:14+02:00 | not documented in the script usage |
| `out/log_SPX500_USD.txt` | 52 | `69b7522937ea4beff57d46c3852018feb54edb370b3ffa9b2a16eb9d4a1fd194` | 2026-10-08T08:34:16+02:00 | not documented in the script usage |
| `out/log_WTICO_USD.txt` | 51 | `5b77896f16245e8d738ccd709acd0edb7410e8ed2cc859f5e76cf6edf67164a6` | 2026-10-08T08:34:17+02:00 | not documented in the script usage |
| `out/log_XAG_USD.txt` | 49 | `6eb77ba0a6410a8f3f18397ed0a32f779a8b2c6db3c619f3a740b25eda7c9dc2` | 2026-10-08T08:34:14+02:00 | not documented in the script usage |
| `out/stress.json` | 46,596 | `dae716e614302467b91efafb2ec465aeb5d9a440450e86120bcf0b3f41a97397` | 2026-10-08T08:30:08+02:00 | `python abs11.py run INST` |
| `out/summary.txt` | 38,439 | `d00043645dffb0d52ce420f8c6104735753d6cbc0db817861f5b158fba807f9c` | 2026-10-08T08:34:46+02:00 | not documented in the script usage |
| `out/thresholds.json` | 1,876 | `be5135eeeef0dad3df163ba1e764b68101682040632fbbf73c5c747ca40016ca` | 2026-10-08T08:29:59+02:00 | `python abs11.py thresholds`; `python abs11.py run INST` |

## abs48

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/abs48/` (repository path `data/research/engine/audit/abs48/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-09T18:35:22+02:00 to 2026-10-09T18:39:52+02:00 (file modification times).
- Scripts in the registry: `abs48.py`.
- Documented commands: `python abs48.py check`; `python abs48.py run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `prereg_comment.md` | 4,420 | `fba4b6fc845413385bdd7666c39b0c0b5e4d4ccfceb14cfdc7db0faa1fe45da4` | 2026-10-09T18:35:22+02:00 | not documented in the script usage |
| `result_comment.md` | 7,726 | `04294b57e2d6bb5df94da07d3fcb1b1bd7e8a1cf1265ee2f0d942bcf748a63a0` | 2026-10-09T18:39:52+02:00 | not documented in the script usage |
| `out/log.txt` | 415 | `9c4da21492894288d3724ef6c427b6d50f3eb3396fbce8d90796f1552f1279ce` | 2026-10-09T18:38:55+02:00 | not documented in the script usage |
| `out/result.json` | 74,008 | `7df608ba608ccccd3361bb28c2509b5241b723c422b88d281154fbb3e3ecc59c` | 2026-10-09T18:38:55+02:00 | `python abs48.py run` |

## alert7

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/alert7/` (repository path `data/research/engine/audit/alert7/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T05:28:21+02:00 to 2026-10-08T05:33:55+02:00 (file modification times).
- Scripts in the registry: `alert7.py`, `diag_hours.py`, `diag_rows.py`, `summarize.py`, `warm.py`.
- Documented commands: `python alert7.py register`; `python alert7.py amend "reason"`; `python alert7.py check`; `python alert7.py run INST`; `python diag_hours.py INST`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `out/EUR_USD.json` | 76,100 | `b2333904b0d766742cf5e4e381d720596803532429a3eb8d4a72ec369301914b` | 2026-10-08T05:29:44+02:00 | `python alert7.py run INST` |
| `out/EUR_USD_ns.json` | 76,977 | `dccce264a1c0ac87ab39c418066b70be3e13357f1a7c08bfcc2474762c834c36` | 2026-10-08T05:32:42+02:00 | `python alert7.py run INST` |
| `out/NATGAS_USD_ns.json` | 76,355 | `73f46eef21c5f062c3a99bf449d650ce24c46011f732115d7cd3f5bfcf158c55` | 2026-10-08T05:32:38+02:00 | `python alert7.py run INST` |
| `out/SPX500_USD.json` | 76,907 | `86a99bf9d1af415da8f72fdf3fa213ca000a2a612a5821be114123ac5f29d5e3` | 2026-10-08T05:30:09+02:00 | `python alert7.py run INST` |
| `out/SPX500_USD_ns.json` | 77,147 | `e442ce65f1dc371401fb53f24032f3d7890a9ba39b9850222c912c250402bad5` | 2026-10-08T05:32:40+02:00 | `python alert7.py run INST` |
| `out/WTICO_USD.json` | 77,218 | `5c92390e8c0b9b5652c72775d3df4fb458d4e2e545fb806721a67212023ecfc3` | 2026-10-08T05:28:55+02:00 | `python alert7.py run INST` |
| `out/WTICO_USD_ns.json` | 76,800 | `aac8591caa1065b798e23ea5e02fc653026b5bd4dffaecf139ba1bec1878c5c7` | 2026-10-08T05:32:42+02:00 | `python alert7.py run INST` |
| `out/XAG_USD_ns.json` | 76,863 | `7adefb4a1efc2a4fe2ca0861b3a5b6e860eeedb389737ee30990b06844143077` | 2026-10-08T05:32:40+02:00 | `python alert7.py run INST` |
| `out/XAU_USD.json` | 76,744 | `407af1009f9c9324aa38104a599a2c8da89c4fda0a2ac472f3d563c083acd6be` | 2026-10-08T05:30:01+02:00 | `python alert7.py run INST` |
| `out/XAU_USD_ns.json` | 76,848 | `8233386f48feb750574ae6cc81e43b79b7072f6d80f47928f05d1d15bb44e816` | 2026-10-08T05:32:41+02:00 | `python alert7.py run INST` |
| `out/artifact_EUR_USD.json` | 3,574 | `22120a522ccad2e156bfbe665d4ca808b0e213228ce7b223838cb608c926c004` | 2026-10-08T05:29:44+02:00 | `python alert7.py run INST` |
| `out/artifact_EUR_USD_ns.json` | 3,574 | `b997584406332b5023b9378fc112a97d3861faf234744ec8fab5230d94a7a0b2` | 2026-10-08T05:32:42+02:00 | `python alert7.py run INST` |
| `out/artifact_NATGAS_USD_ns.json` | 3,583 | `f45a63626f68375f81146be1297b8d6ca11079bd530fd5546ae0cd18fed1b40a` | 2026-10-08T05:32:38+02:00 | `python alert7.py run INST` |
| `out/artifact_SPX500_USD.json` | 3,580 | `1f4e8d70700ba7ff900cb765feaa2f37ef64800b2e3f421895b14594964144d1` | 2026-10-08T05:30:09+02:00 | `python alert7.py run INST` |
| `out/artifact_SPX500_USD_ns.json` | 3,588 | `8cef7bd5a0950976dc2f853a02ff6134e847a7aa858fe0c2f8f9ea367f4f8391` | 2026-10-08T05:32:40+02:00 | `python alert7.py run INST` |
| `out/artifact_WTICO_USD.json` | 3,590 | `90328b043c920b335f8cb54f5697efb588245f7c875557e7b88b379b8732df55` | 2026-10-08T05:28:55+02:00 | `python alert7.py run INST` |
| `out/artifact_WTICO_USD_ns.json` | 3,598 | `52c8b0036bfb2abda58faaa03091e2c66b599b8e2a2363735b473b12e26de235` | 2026-10-08T05:32:42+02:00 | `python alert7.py run INST` |
| `out/artifact_XAG_USD_ns.json` | 3,579 | `44dbd0d249e52fd029acb0fb9d1378e99e5d99f02fdc2fadb89fea76b592b587` | 2026-10-08T05:32:40+02:00 | `python alert7.py run INST` |
| `out/artifact_XAU_USD.json` | 3,578 | `19f9dc7545a3f48e2209de10a677d52bf7369a53d03afc753b9714016daf7ad6` | 2026-10-08T05:30:00+02:00 | `python alert7.py run INST` |
| `out/artifact_XAU_USD_ns.json` | 3,582 | `a76d37cbdeb134044745a639c48166e5600ff05f52f06c7512ccdfe2c50e48ba` | 2026-10-08T05:32:41+02:00 | `python alert7.py run INST` |
| `out/diag_EUR.log` | 1,503 | `b9c915dabb7e090633933dc25b5e9972d174033e396423542aab93b6f2716538` | 2026-10-08T05:33:22+02:00 | `run log` |
| `out/diag_NATGAS.log` | 1,478 | `deccf2ab9c36a64885fd0a2c1f88d6a179c1ac59a86ed448d509e219434911bd` | 2026-10-08T05:33:20+02:00 | `run log` |
| `out/diag_SPX500.log` | 1,501 | `612a209f0579466062497df3c77eabc512917071c86d245420806c3e358555bf` | 2026-10-08T05:33:22+02:00 | `run log` |
| `out/diag_WTICO.log` | 1,489 | `b7676cd5926103e672f1d4e9af3c5fbe2dcd1383ff6b082381e86387e1d42dbc` | 2026-10-08T05:33:21+02:00 | `run log` |
| `out/diag_XAG.log` | 1,495 | `cf008c55bbce735dfc265b0e20de7d4a6a9b9c1a935053fd210fea6d71c8b1a2` | 2026-10-08T05:33:22+02:00 | `run log` |
| `out/diag_XAU.log` | 1,502 | `738f14ff4e3a267ce3d73ce3d66e9499a7d53ae675108d4d514e9328b455b011` | 2026-10-08T05:33:23+02:00 | `run log` |
| `out/diag_hours_EUR_USD.json` | 1,788 | `4e0771d2312041877cde5fcc8a49f834f07efa300cf176a2cff40a33e02a565b` | 2026-10-08T05:33:22+02:00 | `python alert7.py run INST`; `python diag_hours.py INST` |
| `out/diag_hours_EUR_USD_frozen.json` | 1,787 | `d6c7049c35ca44989c2a402c67c6888cfc6b476f740e4091dbef6b057124f289` | 2026-10-08T05:33:55+02:00 | `python alert7.py run INST`; `python diag_hours.py INST` |
| `out/diag_hours_NATGAS_USD.json` | 1,763 | `6fec972db51cbcf5896d19b0832ae46f13be85b689a79667a1624483de87c5af` | 2026-10-08T05:33:20+02:00 | `python alert7.py run INST`; `python diag_hours.py INST` |
| `out/diag_hours_SPX500_USD.json` | 1,786 | `55966a95cbe50e20d1ba988dfe29601ad6af604eac940adbbe2f8ff3d022e061` | 2026-10-08T05:33:22+02:00 | `python alert7.py run INST`; `python diag_hours.py INST` |
| `out/diag_hours_SPX500_USD_frozen.json` | 1,780 | `f710e3a84eab8a233e4edcf8990e9204b890dd2d79e1cac288aaca76b5a06e39` | 2026-10-08T05:33:55+02:00 | `python alert7.py run INST`; `python diag_hours.py INST` |
| `out/diag_hours_WTICO_USD.json` | 1,774 | `df55b3068894d12a6a93e33f706299565a2d2c33f0872588707ffca8dbfa184d` | 2026-10-08T05:33:21+02:00 | `python alert7.py run INST`; `python diag_hours.py INST` |
| `out/diag_hours_WTICO_USD_frozen.json` | 1,762 | `cf108f6dc82b87b7583cb72b1dbb83ef0b178c02e5b4551aad7f9d55175628be` | 2026-10-08T05:33:54+02:00 | `python alert7.py run INST`; `python diag_hours.py INST` |
| `out/diag_hours_XAG_USD.json` | 1,780 | `7835143ce1c29d1d31d508edb95eb9094c7d39f669a79eee0d3dfcda01d2b35d` | 2026-10-08T05:33:22+02:00 | `python alert7.py run INST`; `python diag_hours.py INST` |
| `out/diag_hours_XAU_USD.json` | 1,787 | `d863673c1418a895c471e0ec38424a7fd07859d171c57fc6d7b86880cec1191d` | 2026-10-08T05:33:23+02:00 | `python alert7.py run INST`; `python diag_hours.py INST` |
| `out/diag_hours_XAU_USD_frozen.json` | 1,756 | `69470ac33d0ce6b7c606c51709a2143cb82b544ef9d2c841c4fd7644e6d6909c` | 2026-10-08T05:33:55+02:00 | `python alert7.py run INST`; `python diag_hours.py INST` |
| `out/diagf_EUR.log` | 1,502 | `e435fc8a7457ce3c2adf5aa7ceff18910cb1794d412301c5317fe40a856910b6` | 2026-10-08T05:33:55+02:00 | `run log` |
| `out/diagf_SPX500.log` | 1,495 | `f01ad3fac8cd64013a87c88f4b08e1dbbc6e3bbec2f5d9daced0a77bb7821e46` | 2026-10-08T05:33:55+02:00 | `run log` |
| `out/diagf_WTICO.log` | 1,477 | `800d0b68f6f1fc92a26381358a3f1f1ed86a9db4e937e5a9c14c9d7b8977d7f9` | 2026-10-08T05:33:54+02:00 | `run log` |
| `out/diagf_XAU.log` | 1,471 | `49a3594f4fdf62d724c46a0a867a913c9e7f126f9787c10257f6cc018f510ba1` | 2026-10-08T05:33:55+02:00 | `run log` |
| `out/parity_EUR_USD.json` | 16,685 | `74268d789077502af03d7424751c1100fdbfebc75da9962435e9c9f48fe79296` | 2026-10-08T05:29:44+02:00 | `python alert7.py run INST` |
| `out/parity_EUR_USD_ns.json` | 16,681 | `4c8ad5532d4eb87b31706a495a805f2c27f05d3da2ad71a2bd9f2ec862d3c6b2` | 2026-10-08T05:32:42+02:00 | `python alert7.py run INST` |
| `out/parity_NATGAS_USD_ns.json` | 16,617 | `839988b8b8182c0454a031d77b6b8871796821cff74c86de7ab9799dc0e0f0c3` | 2026-10-08T05:32:38+02:00 | `python alert7.py run INST` |
| `out/parity_SPX500_USD.json` | 16,703 | `e941c16581cf5ac6c3b463d28dd4351a94eda4c88c4849e860345947a798e648` | 2026-10-08T05:30:09+02:00 | `python alert7.py run INST` |
| `out/parity_SPX500_USD_ns.json` | 16,718 | `e73c23e140897d12329bb140daf1e9097a4f88b6a7f63977e72d4f811f775a95` | 2026-10-08T05:32:40+02:00 | `python alert7.py run INST` |
| `out/parity_WTICO_USD.json` | 16,694 | `f5999388a319f0e4caab487de7c98735ffcfbf16642fe629828b59caebe97b92` | 2026-10-08T05:28:55+02:00 | `python alert7.py run INST` |
| `out/parity_WTICO_USD_ns.json` | 16,688 | `663094317c9fabc62ed3beff608148b83126638ddb3943f2e0c6d3a2828c299e` | 2026-10-08T05:32:42+02:00 | `python alert7.py run INST` |
| `out/parity_XAG_USD_ns.json` | 16,719 | `6362f1ef95ca0ed2119430981956c2e3da2e02a3b2d67b638851804689ded663` | 2026-10-08T05:32:40+02:00 | `python alert7.py run INST` |
| `out/parity_XAU_USD.json` | 16,738 | `18da23b72b5ee131f0d9367dc2f3555aee458c944d152aa4938d276252feb1cb` | 2026-10-08T05:30:00+02:00 | `python alert7.py run INST` |
| `out/parity_XAU_USD_ns.json` | 16,732 | `071cc3f8ba33888e0dcb218c2e12884110f76d316ce3a2315fa205ce92591290` | 2026-10-08T05:32:41+02:00 | `python alert7.py run INST` |
| `out/run_EUR.log` | 39 | `ba655aabdf72ecde89656bd688d392255374dfc7374df9436428db53c47f1e97` | 2026-10-08T05:29:44+02:00 | `run log` |
| `out/run_NATGAS.log` | 2,085 | `cb76985da9cbaf56db2ee4c0b6e4b77542a2b3bdcf6bc418cb6ced1b81196af4` | 2026-10-08T05:29:15+02:00 | `run log` |
| `out/run_SPX500.log` | 42 | `ab29036143423526653e82134813694d9e4f039fd4e5086c76b13f16fcd49bb1` | 2026-10-08T05:30:09+02:00 | `run log` |
| `out/run_XAG.log` | 3,111 | `9ef4530e68d3e96e4f6be930fc1980c91228efdb237007772fc0556814c4cbe1` | 2026-10-08T05:29:16+02:00 | `run log` |
| `out/run_XAU.log` | 39 | `77452b0c4ac9878d44fc6eb33eb27c78f671546208b23a4f88258e6cb24c7ec6` | 2026-10-08T05:30:01+02:00 | `run log` |
| `out/run_ns_EUR.log` | 40 | `8a5de3b1d4bf561ddbc8760341aee3d53a1c0816c04b894d82373ff8f8bd2818` | 2026-10-08T05:32:42+02:00 | `run log` |
| `out/run_ns_NATGAS.log` | 42 | `6a3d3e9a8aba952eefa8292c0aa4c21cb8388d5a99a2bf8c9047d569695bad7d` | 2026-10-08T05:32:38+02:00 | `run log` |
| `out/run_ns_SPX500.log` | 43 | `b7bacb515a2aca177c356fc2f39c27da0890027ca407d70bfc86514b67dc3d22` | 2026-10-08T05:32:40+02:00 | `run log` |
| `out/run_ns_WTICO.log` | 42 | `aa6e632a1ad68f8ac432387c53de536f2a7f40c0371cf4940f1e99b86feb0a90` | 2026-10-08T05:32:42+02:00 | `run log` |
| `out/run_ns_XAG.log` | 40 | `20f06a4bcd22a225ce223d5643ef9f2970ab37b387cae4f3e29de14b82c3a2cd` | 2026-10-08T05:32:40+02:00 | `run log` |
| `out/run_ns_XAU.log` | 40 | `eaa86031b39fe677423b0dc9dc4e093eec9d6d2d48457978f6fbec67d4ecc481` | 2026-10-08T05:32:41+02:00 | `run log` |
| `out/summary.md` | 15,176 | `4325fbf151aa0e6c78cc670621eb584a50069f53f82704152f7079ded84c598c` | 2026-10-08T05:30:12+02:00 | not documented in the script usage |
| `out/summary_ns.md` | 22,082 | `8c8fa17b17c5afa968397ccbb6544ef3c5ee5af9637a859f8ac5764bb8032535` | 2026-10-08T05:32:45+02:00 | not documented in the script usage |
| `out/warm_EUR.log` | 20 | `4fa663b5870eccd9368759914d1986fc23e17626c2727c8de6d3977e38286393` | 2026-10-08T05:28:54+02:00 | `run log` |
| `out/warm_NATGAS.log` | 23 | `3cce614cee70a12cfdb9a91f0b19c6a05e869f1d76a53cd0c19faf663f1cb0b7` | 2026-10-08T05:28:21+02:00 | `run log` |
| `out/warm_SPX500.log` | 23 | `9af2e5361eacb3884fe0e5e3e2f61986f6a01dca8cddf544025e81cf3a425024` | 2026-10-08T05:28:53+02:00 | `run log` |
| `out/warm_XAG.log` | 20 | `e6044cacd56164fca90d925363dd79efbb4e2957d36f9dd76811c8b9c7b7b131` | 2026-10-08T05:28:22+02:00 | `run log` |
| `out/wti.log` | 41 | `46442d25c8f97389ef1cf1280146b853c4c76f8b6cdd699a1c7a685aac491deb` | 2026-10-08T05:28:55+02:00 | `run log` |

## bench1

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/bench1/` (repository path `data/research/engine/audit/bench1/`).
- Interpreter: `data/research/engine/audit/bench1/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T01:29:09+02:00 to 2026-10-08T03:29:51+02:00 (file modification times).
- Scripts in the registry: `bench.py`, `real.py`, `register.py`, `summarize.py`.
- Documented commands: `python bench.py check`; `python bench.py probe KIND MU SEED`; `python bench.py controls dev|final N`; `python bench.py real POP`; `python summarize.py controls dev|final`; `python summarize.py real`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `bench_venv_freeze.txt` | 514 | `987a7110b96ef9079d1e12825f3c424605c3de60d9ff9077d4c7c3dcb90d8f3b` | 2026-10-08T01:29:59+02:00 | not documented in the script usage |
| `engine_venv_freeze.txt` | 471 | `13b22856fe337c627664e3fae5e4a1525369632038512504b206217ca67a88d6` | 2026-10-08T01:29:09+02:00 | not documented in the script usage |
| `out/check.txt` | 328 | `84d5a05de18ecadd826ea2852ae80eb5153b63fc6b1da298447631badfa0f249` | 2026-10-08T01:41:13+02:00 | not documented in the script usage |
| `out/controls_dev.jsonl` | 819,519 | `5739a64b837a1bf25fede7af5701b043e7177ec06a60ab0d2cc959b9b02fe05e` | 2026-10-08T02:16:49+02:00 | not documented in the script usage |
| `out/controls_dev.log` | 16,605 | `11f3bf4df1e9467371f858afa0142dce70a5667e804324a62294760c15e01faa` | 2026-10-08T01:53:10+02:00 | `run log` |
| `out/controls_dev.md` | 6,201 | `eb99408833393a34fdfb05d29b3b39a6ecdcf58e73cd02145a70a365aadcb6fe` | 2026-10-08T02:16:52+02:00 | not documented in the script usage |
| `out/controls_dev2.log` | 272 | `a75533df2a12edc959759e008e244deb8468605a083937d52a998260f6e3a5f8` | 2026-10-08T02:16:49+02:00 | `run log` |
| `out/controls_dev_summary.json` | 7,667 | `307d508179cad2f674083f5acd9da2fba31467b41100d16d69ee34da70af3a7d` | 2026-10-08T02:16:52+02:00 | not documented in the script usage |
| `out/controls_final.jsonl` | 5,349,306 | `2ac19dec867ff4d46d665b80ff9ef09acf4a481e0ee882620e0f67f9efbce5b3` | 2026-10-08T03:29:39+02:00 | not documented in the script usage |
| `out/controls_final.log` | 109,416 | `aa4a10aa9ca89609f2b1df1d3050c2fc3370c9aa932ad7da979a9af778c85198` | 2026-10-08T03:29:39+02:00 | `run log` |
| `out/controls_final.md` | 6,865 | `22df56fb3d91a16bbd22c1cba355bc4b4c9ac77666ea568bf7d8d28b2d15b768` | 2026-10-08T03:29:51+02:00 | not documented in the script usage |
| `out/controls_final_summary.json` | 8,726 | `8fd7e0f91f75c65621553330320f3e42d54e785b2bc9f5f66407d3e5a8578250` | 2026-10-08T03:29:51+02:00 | not documented in the script usage |
| `out/probe.err` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | 2026-10-08T01:34:57+02:00 | not documented in the script usage |
| `out/probe2.err` | 493 | `6da9bb8a9f47ffd37ac9587723f209517f325f6492e8855a63cd0c7387943493` | 2026-10-08T01:38:04+02:00 | not documented in the script usage |
| `out/probe2.time` | 126 | `4a6fd9580dde36f59b6e38da95ffcf7f83c8a2c02e9f60a906c12bc27d36bd7a` | 2026-10-08T01:39:44+02:00 | not documented in the script usage |
| `out/probe_linear.json` | 19,421 | `01353ca7f2c61963f1a1b2cc7d60c405aab8d252807dfb745f0e128b93ce4a1b` | 2026-10-08T01:37:04+02:00 | not documented in the script usage |
| `out/probe_subset.json` | 18,369 | `f9da72ebd62e6dd204b72477576861c57c3b5d7b9f2e27fd755f695bf5feba2b` | 2026-10-08T01:39:44+02:00 | not documented in the script usage |
| `out/real.md` | 19,343 | `f3b99d4ac2dd198f96da9560f504ef51ca49b23cf0025154e9770451d81bbb3c` | 2026-10-08T03:29:51+02:00 | `python summarize.py real` |
| `out/real_cfgX.json` | 133,023 | `0f3f245fd13486a12b51ee875dc1e9b69f3470c8cd9698139ee3f7e37e59479c` | 2026-10-08T02:03:28+02:00 | `python summarize.py real` |
| `out/real_cfgX.log` | 2,763 | `3657f72827fce84740f5bdfc816615d3aeba2479b7e41b4e490f8b4750c5112f` | 2026-10-08T02:03:28+02:00 | `run log` |
| `out/real_frozenD.json` | 76,921 | `0e7839a4cc970629f5f6589a9962d9f73cb554a18c212c5e8cb764cd82825bf9` | 2026-10-08T01:46:39+02:00 | `python summarize.py real` |
| `out/real_frozenD.log` | 2,829 | `e270a7885529ea32d42ee431ddb01ed4f835af1adcf0da3ee5a1e06290a57cdb` | 2026-10-08T01:46:39+02:00 | `run log` |
| `ts2vec_src/.gitignore` | 89 | `ce5015a492d10e54437f902a5f1527c8840c73d122094ff7e843ffbec8a6d12f` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/LICENSE` | 1,067 | `a0cc2d47952871dab9279d53700c02afb7a5b947afb85487d992f3c609486171` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/README.md` | 3,995 | `78a3622bb5a088a84b241764a0d31e86f022dc6bbb30c411a2a73e89f483061b` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/datautils.py` | 6,909 | `9f97764246a15800b44be5c8ffc885c6794d1f2826b93419465024152d37246a` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/requirements.txt` | 113 | `04def1c9863f3d84c74284b4cbff485008bb4aba00a2bb2ec7d0378b71dbd529` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/train.py` | 7,094 | `ccebca01c8913669857f1051b02c852b2bd91c9e9cea5a0a7a0b8801f0693a00` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/ts2vec.py` | 14,350 | `2704502598dde115b55559bff8b56563a94eed5cdae4087ec8941a2a077f9972` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/utils.py` | 3,954 | `85ca67e8e84cad09933d2f3ba60de3bc18bafda78706bd5c4c4a509f577dea90` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/datasets/preprocess_electricity.py` | 677 | `a9b81b677031eaa63753653c75e2ce07304d9a1834460ede2cfc190a6ca21c82` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/datasets/preprocess_kpi.py` | 3,533 | `053f2acf5116f2308505fbc7563776ae4a764b6fd9db5ba546d6d5b6f37ae51d` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/datasets/preprocess_yahoo.py` | 3,378 | `75fac22715570c49aae19ac053ea31fcc0b5199a59efe33254049c2041a3c1bc` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/models/__init__.py` | 31 | `ea9eb54772c0e1bfbdfedf068b36079f44eed61ef09c68cab3b151682a88c2d9` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/models/dilated_conv.py` | 1,921 | `9c98e7313e78748670083c400a4ee4d1357a88f1a0457c7f44e780ac4165cdbb` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/models/encoder.py` | 2,479 | `41ceb3902466686dfb0aa119175761ebceb78dd882de7403b45890b965c2fe94` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/models/losses.py` | 1,874 | `c6f38f66a09b29689ab501062f2851bbd8139eb4bdb40dc73aa4bb0ce3bb2f8c` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/scripts/electricity.sh` | 266 | `7770b19f45b71dd536812eb4ce0b59368c514784fa55e082fcc5326c6e0cc276` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/scripts/ett.sh` | 720 | `3183306e3c44cf59fb3aae5e006ba1d8f565f0c1eae6a5ab9b0d742e2ec42712` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/scripts/kpi.sh` | 649 | `0d9ecfcef2946d073837b6f7bf3ee045a0e92a45f608c995d7865a01dd5fe8dd` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/scripts/ucr.sh` | 14,618 | `04cd62af6f24e40a4a852ea5a7d189d5d892bbbefe322eba1614158a27a6cf08` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/scripts/uea.sh` | 3,422 | `cc216f13ad79d31d5579a0366fdbb860c7f1b0ca839955299d1e523bbae70433` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/scripts/yahoo.sh` | 661 | `aff72f3aee25e0602a05b806453d9c914832897f42ac5e2169df4730dbbba950` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/tasks/__init__.py` | 178 | `a49d351fec308f98104dc2cf03d975e89b0f9f89a4b8c05100853d0fc6b50a62` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/tasks/_eval_protocols.py` | 3,661 | `27f9d4d6da5af2cff3bbe3cd3cdea9ee271ba195c856e874f8769b11005d6245` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/tasks/anomaly_detection.py` | 6,832 | `c171bc3b53465bc19d857e56a345f3fc7478d736a5a4db1d88e9e2d297bc4c1d` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/tasks/classification.py` | 1,606 | `2aaf74c348bf80a5b648712300a006fe388f1f96d09e0cff92ca455a6edc47d4` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |
| `ts2vec_src/tasks/forecasting.py` | 3,127 | `94b70bfd06c164221df8e45abe644a0609dba172d1bd58f0edcab50ae6891a97` | 2026-10-08T01:30:04+02:00 | not documented in the script usage |

## cal37

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/cal37/` (repository path `data/research/engine/audit/cal37/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/engine/audit/tsmom36/daily.db, data/research/history.db.
- Ran: 2026-10-09T11:34:17+02:00 to 2026-10-09T11:40:46+02:00 (file modification times).
- Scripts in the registry: `cal37.py`, `fomc_parse.py`, `summarize.py`.
- Documented commands: `python cal37.py check`; `python cal37.py describe`; `python cal37.py register`; `python cal37.py run`.
- Modes dispatched on the first argument: `check`, `describe`, `register`, `run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `fomc_dates.json` | 3,194 | `a103a1ec1bbf3dbd950ff7153c18e34d6a7150c187b6bb6619dc52532d3ce5bb` | 2026-10-09T11:35:17+02:00 | not documented in the script usage |
| `prereg_body.json` | 5,421 | `be53c86655f7e4aca5fed15b36d665ca46347bd89ac0005e8f098ea46631b2ca` | 2026-10-09T11:39:09+02:00 | not documented in the script usage |
| `prereg_comment.md` | 5,967 | `188353c18121bebc2056349055e2140a2160f7e9acb80b7e62b3a7000bd76d63` | 2026-10-09T11:39:33+02:00 | not documented in the script usage |
| `result_comment.md` | 4,530 | `8ac4a7818965b821fae008c3d836113a18c21d897b2f45369ea087392ae4b818` | 2026-10-09T11:40:46+02:00 | not documented in the script usage |
| `fed_raw/fomccalendars.htm` | 165,751 | `97c3b2343e71b50bb5455cea4470bb0796afdb46c1fb4c5fe9a407228a8251fa` | 2026-10-09T11:34:17+02:00 | not documented in the script usage |
| `fed_raw/fomchistorical2005.htm` | 92,303 | `16619ffa3bd498dba288c225f7e4e261c31a0b9799ed19e44e19e2bb72e1860d` | 2026-10-09T11:34:17+02:00 | not documented in the script usage |
| `fed_raw/fomchistorical2006.htm` | 91,981 | `403ba5122a65686e7a9ee53b3c42aefc4e8b9af25b81156e3203c70551dc2670` | 2026-10-09T11:34:17+02:00 | not documented in the script usage |
| `fed_raw/fomchistorical2007.htm` | 94,779 | `ad10960e7bbc32a65ec8dff8f737d0ae0bbf979cbd50abce769b3d56ef7a97bb` | 2026-10-09T11:34:18+02:00 | not documented in the script usage |
| `fed_raw/fomchistorical2008.htm` | 100,002 | `d57f6f9d85e4bcd1d3471f0cfd0e995cf65616f0af9caadb2cd68fc660b8a0f2` | 2026-10-09T11:34:18+02:00 | not documented in the script usage |
| `fed_raw/fomchistorical2009.htm` | 98,252 | `b2f370e27aae8934eef1cdba7a6fd0625c6b31a3b7cd58b2f772c4b34f7e463c` | 2026-10-09T11:34:18+02:00 | not documented in the script usage |
| `fed_raw/fomchistorical2010.htm` | 96,220 | `803714f35ef4cd28a8c43eb0f467679b17f9ba2388d2f8e73cc33287a1f4c552` | 2026-10-09T11:34:19+02:00 | not documented in the script usage |
| `fed_raw/fomchistorical2011.htm` | 98,227 | `c467772a2fad728bf8553cd0144597fa0afcb338315fa9b62d0a5b411d6daea2` | 2026-10-09T11:34:19+02:00 | not documented in the script usage |
| `fed_raw/fomchistorical2012.htm` | 98,148 | `fab567ce1a54a88f0c12b12b6d3a62adb9023b07e1a859718fba0b84ab4c1bb1` | 2026-10-09T11:34:19+02:00 | not documented in the script usage |
| `fed_raw/fomchistorical2013.htm` | 95,809 | `0b9746d39dba2b4cf76798e4b5850e5b67c484a5687e725aaae4d91988be03f2` | 2026-10-09T11:34:19+02:00 | not documented in the script usage |
| `fed_raw/fomchistorical2014.htm` | 96,089 | `199937106508f51a8563f119c429797520336600b04942dca34ca13754a4ba7a` | 2026-10-09T11:34:20+02:00 | not documented in the script usage |
| `fed_raw/fomchistorical2015.htm` | 95,241 | `fc46350f8b634b02691dd9d61f754df7dbadfca5d90d810d754b1209aa2ecbe8` | 2026-10-09T11:34:20+02:00 | not documented in the script usage |
| `fed_raw/fomchistorical2016.htm` | 95,829 | `a63ebfb119b364ad97edff8d292f08765735182a9aac222fff5d405702c670c5` | 2026-10-09T11:34:20+02:00 | not documented in the script usage |
| `fed_raw/fomchistorical2017.htm` | 95,200 | `472c67b86fb33ff88f539206c410311c56e82ea7637f9c1c2a217d1d94b0b65d` | 2026-10-09T11:34:21+02:00 | not documented in the script usage |
| `fed_raw/fomchistorical2018.htm` | 95,705 | `ba2ea2e050370aec6e92ad0a5ac8d35b9d75d4b7ddd6564af4af48ae9f23c8b4` | 2026-10-09T11:34:21+02:00 | not documented in the script usage |
| `fed_raw/fomchistorical2019.htm` | 97,344 | `8768e129482ff2a13bf453ebff71e3bc8e207b38c9f403da3ac4d76101fa45b7` | 2026-10-09T11:34:21+02:00 | not documented in the script usage |
| `fed_raw/fomchistorical2020.htm` | 98,555 | `db2b3f80be5d5a763bf875da36404d7d0ced1bc66bd0191bd553a4cc6bdaf9f7` | 2026-10-09T11:34:22+02:00 | not documented in the script usage |
| `out/describe.json` | 2,197 | `fe9b4c4fa4ad5d5421be7a902302159d6005356b3ac74aaae66c65a7cd30ca21` | 2026-10-09T11:38:44+02:00 | not documented in the script usage |
| `out/results.json` | 61,533 | `a9f5af7615160f5c95b47ef61308c841d0e3133e03d44e83d30dd56a7ce303ae` | 2026-10-09T11:39:43+02:00 | `python cal37.py run` |
| `out/run.log` | 51 | `72ae80510aecd6d9ce445cd31b56f911be93d632a306bf69eb783553d8f38289` | 2026-10-09T11:39:43+02:00 | `run log` |
| `out/summary.txt` | 9,606 | `b5ee41a3b0222be0f12df81a591027f8106587459982af26d0c8d7beafa7bdd3` | 2026-10-09T11:39:53+02:00 | not documented in the script usage |

## cmd41

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/cmd41/` (repository path `data/research/engine/audit/cmd41/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: Databento raw files in the campaign's raw/, data/research/engine/audit/tsmom36/daily.db.
- Ran: 2026-10-09T12:11:22+02:00 to 2026-10-09T12:14:57+02:00 (file modification times).
- Scripts in the registry: `cmd41.py`, `fetch.py`, `summarize.py`.
- Documented commands: `python cmd41.py check`; `python cmd41.py describe`; `python cmd41.py register`; `python cmd41.py run`.
- Modes dispatched on the first argument: `check`, `describe`, `register`, `run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `fetch_log.jsonl` | 1,774 | `25499e43fa72595b3cabdae1cd413ec230e96b4d560a74c2d2409da61a752226` | 2026-10-09T12:11:22+02:00 | not documented in the script usage |
| `prereg_body.json` | 6,114 | `3ee9d161af82c25d35ad164ead555d03bdb9cd43fe2f2156f8cba26d790e9194` | 2026-10-09T12:13:39+02:00 | not documented in the script usage |
| `prereg_comment.md` | 4,099 | `a64530be3aa3203a1ac7ca0e00e4ba74c65d14b6979c812674651cc2e465fff2` | 2026-10-09T12:13:57+02:00 | not documented in the script usage |
| `result_comment.md` | 3,781 | `d6e1a6351a42fa8fc34b985aa2de3fceb3aafd5303207e2c2e561d4e52e9445d` | 2026-10-09T12:14:57+02:00 | not documented in the script usage |
| `out/describe.json` | 6,194 | `a992aefcd572b4b40570e1275fe441d7f8e206390137d153965b88f823b91f3c` | 2026-10-09T12:13:07+02:00 | not documented in the script usage |
| `out/results.json` | 1,083,145 | `726641a21ced4cc37721720a452c9a0cce4624ba368fb19d659532013866bbdd` | 2026-10-09T12:14:09+02:00 | `python cmd41.py run` |
| `out/summary.txt` | 7,700 | `33d3d65057cad628ce7f556d5b5a321339db940e2633a978e933d133693b5ba3` | 2026-10-09T12:14:26+02:00 | not documented in the script usage |
| `raw/ohlcv1d_10.dbn.zst` | 1,287,144 | `f465d5cc2258c77ce171cb02e51578715edc578ab6be791fe6adc0e65da00d01` | 2026-10-09T12:11:22+02:00 | not documented in the script usage |
| `raw/symbology.json` | 174,417 | `49f2284d04f78ee3620c3a0a1346b61bda5c89f23ee4e7375ae6b46bd7221cbf` | 2026-10-09T12:11:22+02:00 | not documented in the script usage |

## daytype14

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/daytype14/` (repository path `data/research/engine/audit/daytype14/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T09:03:45+02:00 to 2026-10-08T09:11:40+02:00 (file modification times).
- Scripts in the registry: `dt14.py`, `inspect_build.py`, `posthoc_layers.py`, `summarize.py`.
- Documented commands: `python dt14.py check`; `python dt14.py thresholds`; `python dt14.py register`; `python dt14.py amend "why"`; `python dt14.py build INST`; `python dt14.py run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `out/day_EUR_USD.pkl` | 995,502 | `effa96633d14623216ab0067e1d3152f349ea1d76cac5d0243af36b5070ed3fc` | 2026-10-08T09:04:12+02:00 | `python dt14.py build INST` |
| `out/day_NATGAS_USD.pkl` | 990,706 | `befa534b5503ab5c51307d9951fdd8596a50ad4a832cc15ca778a85e87376ca2` | 2026-10-08T09:04:09+02:00 | `python dt14.py build INST` |
| `out/day_SPX500_USD.pkl` | 992,014 | `ba2a20520af9db4403661651de242ebf34436bd1ec4b07271f8b3ab00c9b9b59` | 2026-10-08T09:04:10+02:00 | `python dt14.py build INST` |
| `out/day_WTICO_USD.pkl` | 990,706 | `ba41db54139ae7073b734c49df107d7392e60b2a88cafbf50a4adb267ef9b943` | 2026-10-08T09:03:51+02:00 | `python dt14.py build INST` |
| `out/day_XAG_USD.pkl` | 991,142 | `2eef61510b14ef4c52478c23cd23ec5977fa9475daa26c2b69ea1cc5d23e8fa6` | 2026-10-08T09:04:07+02:00 | `python dt14.py build INST` |
| `out/day_XAU_USD.pkl` | 991,142 | `787dfbd3e5acce2f07529765536817243508002b16f1c2245261582873de4822` | 2026-10-08T09:04:06+02:00 | `python dt14.py build INST` |
| `out/pooled.pkl` | 2,776,730 | `e02d199507bac584dbaa29e2542bfd21679ae92f95c97045eb0518308340cfe8` | 2026-10-08T09:11:31+02:00 | not documented in the script usage |
| `out/results.json` | 217,916 | `9e09606c0931d7413b4083c1e888cc867f4287523ca0e6e23339f56b863a86a3` | 2026-10-08T09:11:36+02:00 | `python dt14.py run` |
| `out/run.log` | 11,691 | `25b94a475e56362f0d460455565847b69f61dd65f410bf5107596f6b90abbd1d` | 2026-10-08T09:11:36+02:00 | `run log` |
| `out/summary.txt` | 29,051 | `a38a895da4f83ad74ff0b6621b11c792dec907db0cd89fe971b189bac8abcb6e` | 2026-10-08T09:11:40+02:00 | not documented in the script usage |
| `out/thresholds.json` | 2,116 | `f936bf16b413912423ab2d89564fd5c9bd223c2694dcb51f2c4f69b98c27c405` | 2026-10-08T09:03:45+02:00 | `python dt14.py thresholds` |
| `out/trd_EUR_USD.pkl` | 814,406 | `d2560795737320b7848fe4c25d995933d8b31f01fb1c5ad6c1d694645c277b29` | 2026-10-08T09:04:12+02:00 | `python dt14.py build INST` |
| `out/trd_NATGAS_USD.pkl` | 215,140 | `2d944c6fe5c995ce31ee0b577b4f1660ae530d281721ccc64cc82372cd2f64ad` | 2026-10-08T09:04:09+02:00 | `python dt14.py build INST` |
| `out/trd_SPX500_USD.pkl` | 726,429 | `a40b22f300d460f2b883ee33478cfc96e288319493243d195d266caadc9ea6a1` | 2026-10-08T09:04:10+02:00 | `python dt14.py build INST` |
| `out/trd_WTICO_USD.pkl` | 668,077 | `a2f48b8314db7d6990f7a6dac7d8782d224f20ceb5e1cb9a6748089c4c1d70af` | 2026-10-08T09:03:51+02:00 | `python dt14.py build INST` |
| `out/trd_XAG_USD.pkl` | 334,544 | `1aa69b191e4778a4c5accd013b0c92d76fa996889085b22b51b801500072f9cf` | 2026-10-08T09:04:07+02:00 | `python dt14.py build INST` |
| `out/trd_XAU_USD.pkl` | 630,652 | `7a644356b39101e1fe01c339b50f68192faa973189501c271dd8bddca4f3c10c` | 2026-10-08T09:04:06+02:00 | `python dt14.py build INST` |

## ext39

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/ext39/` (repository path `data/research/engine/audit/ext39/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/engine/audit/tsmom36/daily.db, data/research/history.db.
- Ran: 2026-10-09T11:50:36+02:00 to 2026-10-09T11:52:12+02:00 (file modification times).
- Scripts in the registry: `ext39.py`, `posthoc.py`.
- Documented commands: `python ext39.py check`; `python ext39.py describe`; `python ext39.py register`; `python ext39.py run`.
- Modes dispatched on the first argument: `check`, `describe`, `register`, `run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `prereg_body.json` | 4,548 | `111e10ee6c4f7d250e9f731072e6ad3d71f4aa03f91fdee4f19da88945714867` | 2026-10-09T11:51:01+02:00 | not documented in the script usage |
| `prereg_comment.md` | 3,091 | `477915cd7fb3f9cfbdab394fe69ae352c64e96b7db582443851d82211e9e91e9` | 2026-10-09T11:51:16+02:00 | not documented in the script usage |
| `result_comment.md` | 4,008 | `e585bfa9f52912418296e4292ecd10b0f8256ff8c8d89029d3649dff21df74ab` | 2026-10-09T11:52:12+02:00 | not documented in the script usage |
| `out/describe.json` | 856 | `a591d924057d60c56aca334e3517037ce39f55841f6712e1a37958cb0433dde5` | 2026-10-09T11:50:36+02:00 | not documented in the script usage |
| `out/posthoc.json` | 3,078 | `e508fad2da0220392e944ac6b6cd50d11c7cdf614c5a2a218b7cca1fdfb62f9a` | 2026-10-09T11:51:42+02:00 | not documented in the script usage |
| `out/results.json` | 323,981 | `7d29e4bdf417e8536bb12a8007e160a9008d6714f1908e7234d11e3f087bd326` | 2026-10-09T11:51:23+02:00 | `python ext39.py run` |

## fade31

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/fade31/` (repository path `data/research/engine/audit/fade31/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/engine/audit/news24/news24.db, data/research/history.db.
- Ran: 2026-10-09T10:54:08+02:00 to 2026-10-09T10:56:10+02:00 (file modification times).
- Scripts in the registry: `fade31.py`, `summarize.py`.
- Documented commands: `python fade31.py check | register | amend "<reason>" | plumb | run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `prereg_comment.md` | 3,808 | `fc393c68930202cc8a738d89801d432a9f1797f3792a1f25e28c14abcc5acc44` | 2026-10-09T10:54:30+02:00 | not documented in the script usage |
| `result_comment.md` | 3,755 | `b26a2df89b9ff8a4c1c471d826aad5e6e178fb00114b960313174ac6c0e3be48` | 2026-10-09T10:56:10+02:00 | not documented in the script usage |
| `out/partial.json` | 228,502 | `e3fbc6915537199bb7daa57a9a39feb7f941830a1f95604099e1d2e16a0b3014` | 2026-10-09T10:55:37+02:00 | not documented in the script usage |
| `out/plumb.json` | 4,111 | `847b8a444c7462d63de611ef1439a111448edd3005c7380310719e9b7ca91b1d` | 2026-10-09T10:54:08+02:00 | not documented in the script usage |
| `out/report.txt` | 22,164 | `2d6795f6020342a050c18206749f7d5062edecb0944eed3bc866360824ec88cc` | 2026-10-09T10:55:43+02:00 | not documented in the script usage |
| `out/results.json` | 330,889 | `d7b8d9d220a20f8e6dc897dc320caf74f37e5bc1cd2f8f8db665bcc45776d69e` | 2026-10-09T10:55:37+02:00 | not documented in the script usage |
| `out/run.log` | 2,196 | `52e5ab0ce12d9a040d23557a1b18f64817cb13eb6aa855ebc1638a255e2aee5e` | 2026-10-09T10:55:37+02:00 | `run log` |

## filter316

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/filter316/` (repository path `data/research/engine/audit/filter316/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/candles.db (live engine, read-only), data/research/history.db.
- Ran: 2026-10-08T09:39:39+02:00 to 2026-10-08T09:40:09+02:00 (file modification times).
- Scripts in the registry: `f316.py`, `summarize.py`.
- Documented commands: `python f316.py check`; `python f316.py explore`; `python f316.py register`; `python f316.py run`.
- Modes dispatched on the first argument: `check`, `explore`, `register`, `run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `out/explore.json` | 6,431 | `ecff4482d803fe42002b7ab4cbf568a7b296e55c9694dfe3496aedd1590371ec` | 2026-10-08T09:39:39+02:00 | not documented in the script usage |
| `out/report.txt` | 7,101 | `8e59dee891f099a48dda4432512e36be091914a0a17c11de47554feae311b3c8` | 2026-10-08T09:40:09+02:00 | not documented in the script usage |
| `out/results.json` | 30,344 | `02f63992cb5f214fbb15031890271b3f45118f0be856fd9655294b30db1981a1` | 2026-10-08T09:39:54+02:00 | `python f316.py run` |
| `out/signals.csv` | 1,727,782 | `518d7abd9e5bcd510c34fe12312741369b99fd978c36aea8c8dc1f1a97b4fb93` | 2026-10-08T09:39:52+02:00 | `python f316.py run` |

## flipday30

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/flipday30/` (repository path `data/research/engine/audit/flipday30/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-09T10:46:45+02:00 to 2026-10-09T10:48:28+02:00 (file modification times).
- Scripts in the registry: `fd30.py`, `summarize.py`.
- Documented commands: `python fd30.py check`; `python fd30.py register`; `python fd30.py a1 INST`; `python fd30.py build INST TF`; `python fd30.py run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `prereg_comment.md` | 3,667 | `03f504ac15ab74b8d83f3c0099fac4cc36dfe6f7bcd984e2271b3227f29de836` | 2026-10-09T10:46:45+02:00 | not documented in the script usage |
| `result_comment.md` | 4,970 | `7973cdccc91176aaa8ed349da5c70f4be81d660d1392228d4c7b16674cecc333` | 2026-10-09T10:48:28+02:00 | not documented in the script usage |
| `out/a1_EUR_USD.pkl` | 48,994 | `b8ee0ea8fdc94507363a9e7b308d6b0c88a3379dd4048b5e96154657a106a6c6` | 2026-10-09T10:47:02+02:00 | `python fd30.py a1 INST` |
| `out/a1_NATGAS_USD.pkl` | 48,730 | `e54eca7465390110a5956ce038bc00335ee7c3eebb56acb2e8236c8e03119ffe` | 2026-10-09T10:46:59+02:00 | `python fd30.py a1 INST` |
| `out/a1_SPX500_USD.pkl` | 48,778 | `c6ff553d507a7b8ddca9dc06766e46f4bdd8c5ea48acc03fbeafdf491957e2ec` | 2026-10-09T10:47:00+02:00 | `python fd30.py a1 INST` |
| `out/a1_WTICO_USD.pkl` | 48,730 | `1cd0860215ba0ab73177dc0b1034926f11e2aaed77a65041b6c0de0736ce4d52` | 2026-10-09T10:46:51+02:00 | `python fd30.py a1 INST` |
| `out/a1_XAG_USD.pkl` | 48,730 | `97d37ff754670f167b0ca58efbc9dccd2f23ee668ce9746258d2d911e508b795` | 2026-10-09T10:46:57+02:00 | `python fd30.py a1 INST` |
| `out/a1_XAU_USD.pkl` | 48,730 | `4da43e725570790ebc119d09f1807bb61f22bb1df578d4b5cf41208250c1faf8` | 2026-10-09T10:46:56+02:00 | `python fd30.py a1 INST` |
| `out/b_EUR_USD_M15.pkl` | 387,985 | `057349a56cc47d795dcb8744d201c3b330ab15744470f0ff5e40fbe46949498a` | 2026-10-09T10:47:15+02:00 | `python fd30.py build INST TF` |
| `out/b_EUR_USD_M5.pkl` | 597,914 | `a65686893bf913d721e52043a5bc66236567743ccc4c2b47c63a2a595100fefb` | 2026-10-09T10:47:14+02:00 | `python fd30.py build INST TF` |
| `out/b_NATGAS_USD_M15.pkl` | 392,883 | `e7cceda63402c23d2c97c9d6f2b44c8011c06ec1feed759f6a0933725856e5cc` | 2026-10-09T10:47:10+02:00 | `python fd30.py build INST TF` |
| `out/b_NATGAS_USD_M5.pkl` | 653,404 | `7aa80a3db1f543002eb9d7077fe1bff5cca3fe89c4e8be3db629ec378ae6e298` | 2026-10-09T10:47:09+02:00 | `python fd30.py build INST TF` |
| `out/b_SPX500_USD_M15.pkl` | 382,958 | `873b93415e9c42ad0517742bcc6cedcf6ab5997bec258d029fc0937d81701a05` | 2026-10-09T10:47:12+02:00 | `python fd30.py build INST TF` |
| `out/b_SPX500_USD_M5.pkl` | 597,655 | `bbddd2d9b758a64eb1c0c605efffca2dc7236eb882f2546d80ef1297d91fccec` | 2026-10-09T10:47:11+02:00 | `python fd30.py build INST TF` |
| `out/b_WTICO_USD_M15.pkl` | 373,170 | `3989c5cc9c0239957ce0154bf1bbaacdd7a5d0adabaa83f326029dde50508bef` | 2026-10-09T10:47:04+02:00 | `python fd30.py build INST TF` |
| `out/b_WTICO_USD_M5.pkl` | 562,683 | `91bb1d9f32e1468c2ed266124f575a03c3aaf929abb8499b1ef23fab5e8b1aac` | 2026-10-09T10:47:03+02:00 | `python fd30.py build INST TF` |
| `out/b_XAG_USD_M15.pkl` | 351,257 | `bd361a302ecbe739b33880b96d38594ad0832a158f8271f308cee45bb874a458` | 2026-10-09T10:47:08+02:00 | `python fd30.py build INST TF` |
| `out/b_XAG_USD_M5.pkl` | 580,418 | `f9b6965d99c8e25c090565bc88a6337198bd35c1c912268ad34c68ac302ebc05` | 2026-10-09T10:47:07+02:00 | `python fd30.py build INST TF` |
| `out/b_XAU_USD_M15.pkl` | 345,561 | `e8e135fe12d54acacc7d63f094b90457dbb6cd72e50e7586d3aab0a522779124` | 2026-10-09T10:47:06+02:00 | `python fd30.py build INST TF` |
| `out/b_XAU_USD_M5.pkl` | 542,626 | `cd6799103ea95f1aa6fa747c68cbb4771947d9ec1461696d5b3f18b2c376c4c7` | 2026-10-09T10:47:05+02:00 | `python fd30.py build INST TF` |
| `out/build.log` | 410 | `58b846a757eb28e637c8988c81cbe186d27794f79365dc02e7a83b97eaa9fb4f` | 2026-10-09T10:47:15+02:00 | `run log` |
| `out/report.txt` | 28,360 | `608c4054442f36079c52fcc104b2ad8ad41048962aafe8cdb498439269d105a1` | 2026-10-09T10:47:46+02:00 | `python fd30.py run` |
| `out/results.json` | 100,445 | `3baaf1270cdf241468093d4b73795b3d507b4bec3683f12a6a524ff05e3d7e8d` | 2026-10-09T10:47:34+02:00 | `python fd30.py run` |
| `out/run.log` | 393 | `f2652f165bbb2fc77579c771a96a594614c66a91545ec10655456e790018014b` | 2026-10-09T10:47:34+02:00 | `run log` |

## flipdens32

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/flipdens32/` (repository path `data/research/engine/audit/flipdens32/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-09T10:56:15+02:00 to 2026-10-09T10:58:23+02:00 (file modification times).
- Scripts in the registry: `fd32.py`, `summarize.py`.
- Documented commands: `python fd32.py check`; `python fd32.py register`; `python fd32.py build INST TF`; `python fd32.py run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `prereg_comment.md` | 3,810 | `96ba35eef51004b1cdd6a70ef16721384969bfbc4e501a620861e8f6c43af0ec` | 2026-10-09T10:56:15+02:00 | not documented in the script usage |
| `result_comment.md` | 5,018 | `d55c1a286dcf8d8fdaec8b7e238283a6e8ceaa584a2e272a7cce6f4aab25609b` | 2026-10-09T10:58:23+02:00 | not documented in the script usage |
| `out/build_EUR_USD.log` | 74 | `6b0ec3833a531573dbce29c501d2d6c7171cedc387ed17fa5f06a1f11467b721` | 2026-10-09T10:56:26+02:00 | `run log` |
| `out/build_NATGAS_USD.log` | 80 | `f7d495824502c391723806e84af9a60f3dedfdcc318dadf5df2b02c073eb696e` | 2026-10-09T10:56:26+02:00 | `run log` |
| `out/build_SPX500_USD.log` | 80 | `04a8760cf9e72953dbc7cefa50433cc4ca54b06d0916908bebf2d7f38122aad7` | 2026-10-09T10:56:26+02:00 | `run log` |
| `out/build_WTICO_USD.log` | 78 | `085909fb466111f74d8457286c2c68b8f4c4159dbb7dbd33fff105dc6c9e4a3c` | 2026-10-09T10:56:26+02:00 | `run log` |
| `out/build_XAG_USD.log` | 74 | `b62c9a451a5ee43c3b7a5cf68709b6a2262e1e458147d770ae197e6f9104aa01` | 2026-10-09T10:56:26+02:00 | `run log` |
| `out/build_XAU_USD.log` | 74 | `79275b1954481e479a1ce01ddf6a2494548b4986da3683b79114271b866d3fcc` | 2026-10-09T10:56:26+02:00 | `run log` |
| `out/f_EUR_USD_M15.pkl` | 764,099 | `6b0598dfc0fe0170d463eb4cfaae89bf06c07323ad989c8b84c5d49855f4f41b` | 2026-10-09T10:56:26+02:00 | `python fd32.py build INST TF` |
| `out/f_EUR_USD_M5.pkl` | 1,911,614 | `17ed05c6193f7b98ff19b63f701dc023c234f877227304f658439be8fda9ccd3` | 2026-10-09T10:56:24+02:00 | `python fd32.py build INST TF` |
| `out/f_NATGAS_USD_M15.pkl` | 810,837 | `5e81fcb85024c97a313d27a4ed7dab37408d5a271caba03e9f5e06be6b35029f` | 2026-10-09T10:56:26+02:00 | `python fd32.py build INST TF` |
| `out/f_NATGAS_USD_M5.pkl` | 2,105,136 | `c0ca423e2b415cc843c885db4fb58fc4be22eda3824b68cd41b8606af3dd7df4` | 2026-10-09T10:56:24+02:00 | `python fd32.py build INST TF` |
| `out/f_SPX500_USD_M15.pkl` | 739,008 | `111c3f6478b9c7e4b3e38a05b218ce3f580b9a4ecd64c3445fb4bb930258dc46` | 2026-10-09T10:56:26+02:00 | `python fd32.py build INST TF` |
| `out/f_SPX500_USD_M5.pkl` | 1,825,755 | `6ac05cfec22e30df8870f46bacbfe17f2020ae00840b2a197664561fa60649ad` | 2026-10-09T10:56:24+02:00 | `python fd32.py build INST TF` |
| `out/f_WTICO_USD_M15.pkl` | 741,908 | `33f40672ef4072e54ef9a21bd15f1f230faef86638008f27649d37cc8cf8ab43` | 2026-10-09T10:56:26+02:00 | `python fd32.py build INST TF` |
| `out/f_WTICO_USD_M5.pkl` | 1,787,471 | `484e259c2dba1f06008913d4a9dbd30525de92883603511a57bfb4226e6a6d98` | 2026-10-09T10:56:24+02:00 | `python fd32.py build INST TF` |
| `out/f_XAG_USD_M15.pkl` | 747,275 | `8c7a8ba46355a30923a4dbc399eba772274aafb4f636ad51e1385f612f498574` | 2026-10-09T10:56:26+02:00 | `python fd32.py build INST TF` |
| `out/f_XAG_USD_M5.pkl` | 1,991,942 | `1a61998cb2e05126c954afb89a330c2ed8788a2ae9e5f5121c7916e73426016c` | 2026-10-09T10:56:24+02:00 | `python fd32.py build INST TF` |
| `out/f_XAU_USD_M15.pkl` | 703,883 | `bfac0d5596fc1aca1caae079f0d5cfbb95aa1635664e941457ea3c16cb92e443` | 2026-10-09T10:56:26+02:00 | `python fd32.py build INST TF` |
| `out/f_XAU_USD_M5.pkl` | 1,763,942 | `aec7c03ad27d2178995a344c7bea14c70a8909ba5f7c58fd197fe5e0a0a285fc` | 2026-10-09T10:56:24+02:00 | `python fd32.py build INST TF` |
| `out/report.txt` | 77,548 | `da417ceb9f8b53a1bc13db1937ddfef34585e9e6396f861d3a4e00fe86eaab59` | 2026-10-09T10:57:24+02:00 | not documented in the script usage |
| `out/results.json` | 254,204 | `67cc16607cfe0b9515a0348d412181cff0d7b21622aa3d31a7fde8c31f7bec49` | 2026-10-09T10:57:10+02:00 | `python fd32.py run` |
| `out/run.log` | 422 | `1a713abbc3a334145fc9bfebeb1aa788293b6a2140e8fb233afb52a4ca854832` | 2026-10-09T10:57:10+02:00 | `run log` |

## flow29

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/flow29/` (repository path `data/research/engine/audit/flow29/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: Databento raw files in the campaign's raw/, data/research/history.db.
- Ran: 2026-10-09T09:14:59+02:00 to 2026-10-09T09:23:01+02:00 (file modification times).
- Scripts in the registry: `fetch.py`, `flow29.py`.
- Modes dispatched on the first argument: `bars`, `run`, `selfcheck`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `download.out` | 7,371 | `caf23658bcd97ac84462200429e3e9f085292a2e6fe27d9f6edb6131c0de827a` | 2026-10-09T09:21:06+02:00 | `run log` |
| `fetch_log.jsonl` | 2,863 | `a12c9eee05bfb1d7dfc09c9ab675735e552d593f8ae67a3fd7ec8d0c8a57f7a9` | 2026-10-09T09:21:40+02:00 | not documented in the script usage |
| `prereg_comment.md` | 3,346 | `e29f4ea7fb486f66f7998a29467b1b35b4f4d774d5ca0c6a17837c4d767781f3` | 2026-10-09T09:17:21+02:00 | not documented in the script usage |
| `result_comment.md` | 3,427 | `b9be51b578712f463891fda76714041ad7fabed7622612478439ff395042d775` | 2026-10-09T09:23:01+02:00 | not documented in the script usage |
| `out/bars_m1.parquet` | 5,456,409 | `b8943487bafb1589e19928ec59d055e6b816e40499aa142c66db4d8b9a76545a` | 2026-10-09T09:21:51+02:00 | not documented in the script usage |
| `out/bars_summary.json` | 283 | `e4263c6076f1fa916b7cc959c3f3c2818938cf6b65e36134e54c47fc0f08e11b` | 2026-10-09T09:21:51+02:00 | not documented in the script usage |
| `out/results.json` | 6,199 | `3b1042f1ea657c6df7dfb4de7c2f6406eaf7aa3aed1b9660dcaf29139f5a4cd4` | 2026-10-09T09:22:33+02:00 | not documented in the script usage |
| `raw/CL.v.0_2025-10.dbn.zst` | 37,382,798 | `fc5849f0b5f3ba8dc9ad1f16ccb3db652692531784ed89250dfdeddbf0450839` | 2026-10-09T09:14:59+02:00 | not documented in the script usage |
| `raw/CL.v.0_2025-11.dbn.zst` | 26,308,655 | `5038eb88b660f19659d14f758f9f1d47de1a36ab602188ac0e5f77d0b576a71c` | 2026-10-09T09:15:12+02:00 | not documented in the script usage |
| `raw/CL.v.0_2025-12.dbn.zst` | 23,282,673 | `ae52fd35940d8fcf08e0a2f59f5a67e81cd8e7993ca92404260dfa0da75cf92b` | 2026-10-09T09:15:22+02:00 | not documented in the script usage |
| `raw/CL.v.0_2026-01.dbn.zst` | 36,246,071 | `5673e62baeb27528f6fe5175dcd170c33485eb672dbeecb97947324b0eb63204` | 2026-10-09T09:16:43+02:00 | not documented in the script usage |
| `raw/CL.v.0_2026-02.dbn.zst` | 36,397,405 | `f23d1eeaec68ce1e7b66a5cc606c7684ff4006d41efaa3c180931858959e8047` | 2026-10-09T09:16:56+02:00 | not documented in the script usage |
| `raw/CL.v.0_2026-03.dbn.zst` | 117,789,430 | `7252f93914f4c656da7d38997a66304bf51c5de4744eacb1f042e5a9c6909cef` | 2026-10-09T09:17:53+02:00 | not documented in the script usage |
| `raw/CL.v.0_2026-04.dbn.zst` | 63,862,399 | `29878e32f2c84541923f1d1dce54c544bfc12ee363b5796146b7403f8af7a483` | 2026-10-09T09:18:23+02:00 | not documented in the script usage |
| `raw/CL.v.0_2026-05.dbn.zst` | 48,079,188 | `69e5ae2745cef9d0192ffebc73aeda7a921208c18560a7ab8935b0d98c96133d` | 2026-10-09T09:19:38+02:00 | not documented in the script usage |
| `raw/CL.v.0_2026-06.dbn.zst` | 40,145,820 | `0662d0b2cd2ec66b176418bacabaa5a2d56c87328dfa98d48194d41866ed8d29` | 2026-10-09T09:20:00+02:00 | not documented in the script usage |
| `raw/CL.v.0_2026-07.dbn.zst` | 45,939,837 | `b71f8480684747d279cdffb1fe484e918aef616535d18a9b820bed0d3a3a67f3` | 2026-10-09T09:20:26+02:00 | not documented in the script usage |
| `raw/CL.v.0_2026-08.dbn.zst` | 35,973,859 | `cae53fba156965526f3fc67526e90982d0e9cf667435831c6ddd97f94c1a5bc8` | 2026-10-09T09:20:33+02:00 | not documented in the script usage |
| `raw/CL.v.0_2026-09.dbn.zst` | 55,034,471 | `03a93a57e29960ef12960bc2a2ce432f08fc3b0a215dc2228e90cef7d0031197` | 2026-10-09T09:21:05+02:00 | not documented in the script usage |
| `raw/CL.v.0_2026-10.dbn.zst` | 14,115,443 | `3d9ba7524608d45a2f77919cfb5dd31f554cbe48dca7efe80f2dab3e6b2dfdb4` | 2026-10-09T09:21:40+02:00 | not documented in the script usage |

## flow42

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/flow42/` (repository path `data/research/engine/audit/flow42/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: Databento raw files in the campaign's raw/.
- Ran: 2026-10-09T13:17:59+02:00 to 2026-10-09T13:22:47+02:00 (file modification times).
- Scripts in the registry: `fetch.py`, `flow42.py`.
- Modes dispatched on the first argument: `bars`, `run`, `selfcheck`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `download.out` | 715 | `609e3d86a4d3be44fd6364f52d6ca2e143045c67cf9a9743ef83908b8c821be7` | 2026-10-09T13:21:25+02:00 | `run log` |
| `fetch_log.jsonl` | 2,620 | `c613662272ab756505a64e22649cd27aefb25b94fd8503e9bf8256aa8b2d7d73` | 2026-10-09T13:21:25+02:00 | not documented in the script usage |
| `prereg_comment.md` | 4,422 | `a1e0c2fae1f05de2ff200f509d731666178fa55c0332c86f7814f12adde7ace6` | 2026-10-09T13:21:46+02:00 | not documented in the script usage |
| `result_comment.md` | 5,079 | `c4f0437005515f027464e1e0c9c9a608e4a00f46a6fcc3767aa716e41c51b043` | 2026-10-09T13:22:47+02:00 | not documented in the script usage |
| `run.out` | 2,516 | `4b385917bbe68776be60df78736bba996455f4fdbe02d3b42ccd98ebb82a2220` | 2026-10-09T13:22:08+02:00 | `run log` |
| `out/bars_m1.parquet` | 5,143,003 | `3031d15ea9a4d9d3ab446835936a7b98a5ef6c494753d510dfeb7cda8d3fd486` | 2026-10-09T13:21:38+02:00 | not documented in the script usage |
| `out/bars_summary.json` | 280 | `9975cab0911f8da13c5e36756c560c96ceccdd7b026586b996a1448ada7d45c7` | 2026-10-09T13:21:38+02:00 | not documented in the script usage |
| `out/f29_run_results.json` | 6,188 | `8c5a2a05fc993eb7fc7da7db16f3fc42ac4a10e5a724fb900d1b9a59b2f339da` | 2026-10-09T13:22:00+02:00 | not documented in the script usage |
| `out/results.json` | 11,792 | `1b72fb046c248f6cb25a3e9538642c81d234323429eee291e87be9065e1aba36` | 2026-10-09T13:22:08+02:00 | not documented in the script usage |
| `raw/CL.v.0_2024-10.dbn.zst` | 55,739,425 | `59a0057266487e46844609eea78624bea2268cd94b451b13a23eb39af372e292` | 2026-10-09T13:17:59+02:00 | not documented in the script usage |
| `raw/CL.v.0_2024-11.dbn.zst` | 34,664,585 | `ff7660afb7620466a783c95467f01cfc59858fcc6eeea2a3df99901691984699` | 2026-10-09T13:18:31+02:00 | not documented in the script usage |
| `raw/CL.v.0_2024-12.dbn.zst` | 28,472,675 | `df8fc2344a44df1fe1a7a728768ebde0ffa067b95e06a990ae76d1344aa705e7` | 2026-10-09T13:18:52+02:00 | not documented in the script usage |
| `raw/CL.v.0_2025-01.dbn.zst` | 42,254,242 | `ab56138e8582158f23a5f1238a03a2e96fe5b2c4e54d821d199578addad3ef8b` | 2026-10-09T13:19:06+02:00 | not documented in the script usage |
| `raw/CL.v.0_2025-02.dbn.zst` | 31,546,480 | `17921d658a5de656f2bf9b0195fe113a04cb2b472d900f5c910e4c18dad7e9fc` | 2026-10-09T13:19:20+02:00 | not documented in the script usage |
| `raw/CL.v.0_2025-03.dbn.zst` | 30,539,499 | `5167456d65f48673332a76a350aed35567c7dac0d59f5c759611f827563f8153` | 2026-10-09T13:19:29+02:00 | not documented in the script usage |
| `raw/CL.v.0_2025-04.dbn.zst` | 48,282,244 | `fc1914c0263bcab87af490399b49baf7fe8d9fc41f416e28edbbb8881cdc15ab` | 2026-10-09T13:19:45+02:00 | not documented in the script usage |
| `raw/CL.v.0_2025-05.dbn.zst` | 33,238,568 | `1adfb093bdb450a2859fa2e7215d6d9befb5603ff9d297cfb1a2ad461022a1d7` | 2026-10-09T13:19:54+02:00 | not documented in the script usage |
| `raw/CL.v.0_2025-06.dbn.zst` | 51,931,378 | `b41eeeeee11673ee2a572e8720aca819e5e12eaa94394c8e47eeb79b3b363c86` | 2026-10-09T13:20:07+02:00 | not documented in the script usage |
| `raw/CL.v.0_2025-07.dbn.zst` | 30,333,065 | `88e897de3e12a29fc185a866bfd7f23443aadcd88075b432b81145a22d7cbf15` | 2026-10-09T13:20:21+02:00 | not documented in the script usage |
| `raw/CL.v.0_2025-08.dbn.zst` | 28,067,970 | `66b667102783a84503e01134456a48348cb8367633f507d90007016f7d89bb0d` | 2026-10-09T13:20:31+02:00 | not documented in the script usage |
| `raw/CL.v.0_2025-09.dbn.zst` | 27,930,300 | `086a28cc9d3ecfb4fc63f66911741c60bfbab906251aedddacec0558d5edac17` | 2026-10-09T13:21:25+02:00 | not documented in the script usage |

## fm2

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/fm2/` (repository path `data/research/engine/audit/fm2/`).
- Interpreter: `data/research/engine/audit/fm2/.venv/bin/python`, `data/research/engine/audit/fm2/.venv_moirai/bin/python`, `data/research/engine/audit/fm2/.venv_timesfm/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T03:52:56+02:00 to 2026-10-08T04:58:25+02:00 (file modification times).
- Scripts in the registry: `embed.py`, `fm2.py`, `infer.py`, `knn_abst.py`, `register.py`, `summarize.py`.
- Documented commands: `python embed.py INST`; `python embed.py INST knn`; `python fm2.py export INST`; `python fm2.py eval INST`; `python infer.py MODEL INST [synthetic]`; `python knn_abst.py WTICO_USD`; `python register.py [amend "reason"]`; `python summarize.py WTICO_USD`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `out/emb_WTICO_USD_bolt_small.npz` | 38,198,949 | `556c832fbf2a4a4a1e3ab0e72a97a87cb6cfd847c119b31e6e3669dc5df91b58` | 2026-10-08T04:11:35+02:00 | `python embed.py INST` |
| `out/emb_XAU_USD_bolt_small.npz` | 37,828,558 | `577061deb1ef8ce9738b727c3dcc7e361649cb952db00f125aea337fb673ddb3` | 2026-10-08T04:16:27+02:00 | `python embed.py INST` |
| `out/embed_WTI.log` | 609 | `f1f075f105462ad4d7cb27c247d8ede00806ce51e856b8358e17b1e46570e760` | 2026-10-08T04:11:42+02:00 | `run log` |
| `out/embed_XAU.log` | 664 | `62242a820a63a6c5300d63b304621dcbf21a86348cf4a73825f0f2494c3ec51a` | 2026-10-08T04:16:28+02:00 | `run log` |
| `out/eval_WTI.log` | 3,054 | `2c011dc604a0095c10efb28125046577a449efacb0f627014c11582b1ca649df` | 2026-10-08T04:58:24+02:00 | `run log` |
| `out/eval_WTICO_USD.json` | 94,007 | `ff4827258ce8b3df0073a9e25ef215bd4da0d1f799cdc8da3f9696647c711165` | 2026-10-08T04:58:24+02:00 | `python fm2.py eval INST` |
| `out/eval_XAU.log` | 2,201 | `1e95a746c4a6c41e5e886fb5a7cbf0c64d18903ef2d1c32cf9f1d41ea2c38199` | 2026-10-08T04:36:58+02:00 | `run log` |
| `out/eval_XAU_USD.json` | 70,988 | `f5c6f758254d552721ee1473adc9598eccb0a25c23cfeafad5310261ce85207d` | 2026-10-08T04:36:58+02:00 | `python fm2.py eval INST` |
| `out/fm_WTICO_USD_bolt_base.npz` | 338,282 | `b05a9a4911da54ed73f55da3a1a416137c5f6a01cfc3734f4c4ba83a4a7e27fd` | 2026-10-08T04:17:21+02:00 | not documented in the script usage |
| `out/fm_WTICO_USD_bolt_small.npz` | 337,893 | `e9321fdce22986c658255a4db2b38913a996db76d3f17dc06b27d7c58860a3e6` | 2026-10-08T04:10:16+02:00 | not documented in the script usage |
| `out/fm_WTICO_USD_chronos2.npz` | 338,072 | `bc3ff7ba83978f7811714a9cdf35aaef51cb20dc085e031da84349217b586209` | 2026-10-08T04:10:47+02:00 | not documented in the script usage |
| `out/fm_WTICO_USD_chronos_t5_small.npz` | 359,402 | `74896682df0242c4e29250c4d8ac49af2483d15ccfab371f000f7fde8a0844a9` | 2026-10-08T04:55:40+02:00 | not documented in the script usage |
| `out/fm_WTICO_USD_knn_bolt.npz` | 124,083 | `b42aa12c75d188c68f8166b7de134f8d36af908c5be3a6e4f9885deab7dec622` | 2026-10-08T04:11:53+02:00 | `python embed.py INST knn` |
| `out/fm_WTICO_USD_moirai11_small.npz` | 348,790 | `e0baa210af693845a93e946464631ebaa6bc2f46d2ea29984e1369e843016ca1` | 2026-10-08T04:23:33+02:00 | not documented in the script usage |
| `out/fm_WTICO_USD_timesfm25.npz` | 338,245 | `7d6adf75f2a7bb5fa53e063c22de83ddc0484f5e9d2a90903246c01b2e3c8864` | 2026-10-08T04:13:33+02:00 | not documented in the script usage |
| `out/fm_XAU_USD_bolt_small.npz` | 334,255 | `8438b0876b327d1d593a69524ebb65a6f526bb62008099ffe16d645db7894ff6` | 2026-10-08T04:15:03+02:00 | not documented in the script usage |
| `out/fm_XAU_USD_chronos2.npz` | 334,231 | `7243211bbc1b791dd8d1922e247c1024fdb20ded723f35eb7fc7a62fbfac2061` | 2026-10-08T04:16:10+02:00 | not documented in the script usage |
| `out/fm_XAU_USD_knn_bolt.npz` | 129,155 | `fd47db8a9f47a18666c5fd9c9b46a2fde96a3897717709d21291eb641b469099` | 2026-10-08T04:16:34+02:00 | `python embed.py INST knn` |
| `out/fm_XAU_USD_moirai11_small.npz` | 343,215 | `8f3d0c7cd31ab6b7503780973a36142712ba9441ffbb32117027f10be70878e3` | 2026-10-08T04:34:48+02:00 | not documented in the script usage |
| `out/fm_XAU_USD_timesfm25.npz` | 334,489 | `2044a387cb07d48221a4869c8f6de1dfa2b9c83d9ea599a7e9b0fe0377408506` | 2026-10-08T04:24:00+02:00 | not documented in the script usage |
| `out/infer_WTI_bolt_base.log` | 826 | `0418bc0e96695b76abf014d6b031d4db76bf4dd6411103bbe49050a23b8f04b7` | 2026-10-08T04:17:21+02:00 | `run log` |
| `out/infer_WTI_bolt_small.log` | 825 | `51fb26f0fa597310f0b482839b1bdbbc92f9d32c83abba1269b26ade436b4867` | 2026-10-08T04:10:16+02:00 | `run log` |
| `out/infer_WTI_chronos2.log` | 505 | `0235583db263f0e4e6e06a6d617962646e2cd29e6cfae9b87008cf5220381d45` | 2026-10-08T04:10:47+02:00 | `run log` |
| `out/infer_WTI_chronos_t5_small.log` | 43,342 | `6727d24f3544512a65812e903ee88cee67b564042bd5b54f2bb6122a6605210a` | 2026-10-08T04:55:40+02:00 | `run log` |
| `out/infer_WTI_moirai11_small.log` | 589 | `ffae6f4c42c64c839cae5ff4ea65b62e866f23724ed880ee5727810e47ef2253` | 2026-10-08T04:23:33+02:00 | `run log` |
| `out/infer_WTI_timesfm25.log` | 514 | `02bd52643910588ea308bc4e819f0d18c406ca8298a263c1fe1b302aacc6c80f` | 2026-10-08T04:13:33+02:00 | `run log` |
| `out/infer_XAU_bolt_small.log` | 825 | `c790ed17a21ae567488371c07d0eb88d438aa1188db2a63e3d5c8676d8a133c2` | 2026-10-08T04:15:03+02:00 | `run log` |
| `out/infer_XAU_chronos2.log` | 506 | `26a13b558ee986b40de69d8db3d477eeab39a02d4e79353ee553ea5eaf884eb5` | 2026-10-08T04:16:10+02:00 | `run log` |
| `out/infer_XAU_moirai11_small.log` | 587 | `ee36eef624c4572a19945a7b991cc25d35b85a6b846c250cd717ef1b3a3c448c` | 2026-10-08T04:34:48+02:00 | `run log` |
| `out/infer_XAU_timesfm25.log` | 515 | `10b7da26b5775bfafddc3d69d57f34d491c80593fbdadca9991e5392d3ff27c9` | 2026-10-08T04:24:00+02:00 | `run log` |
| `out/install_moirai.log` | 25,636 | `3dbeb1c54723f535096951694eaca87395cd99ca1efc6fb53efee6959dea5aa2` | 2026-10-08T03:53:33+02:00 | `run log` |
| `out/install_timesfm.log` | 5,671 | `5b563ed822ed26ba8681cde61cd2fd11259dfbd156f13e273454417d30843d8c` | 2026-10-08T03:52:56+02:00 | `run log` |
| `out/knn_abst_WTICO_USD.json` | 397 | `1cb408c9a1aa541867936a656b14b73166eb860f35857e22599ec6c3bd9bcb31` | 2026-10-08T04:16:51+02:00 | not documented in the script usage |
| `out/knn_abst_XAU_USD.json` | 398 | `048565d88b89ec3e2c023751b37c41c20bfca971527fc5940c6df264a1c25307` | 2026-10-08T04:16:53+02:00 | not documented in the script usage |
| `out/moirai_syn.log` | 300 | `013e3097c168dd211a2410686ee7ab0c73e420597a4a9019c368495f7030836f` | 2026-10-08T04:08:09+02:00 | `run log` |
| `out/p3_WTICO_USD.npz` | 7,315,581 | `1142b3b5e57321c028117d6a69b8a643fb93198e69021519a44e886d3b61f8bb` | 2026-10-08T03:54:11+02:00 | `python fm2.py export INST` |
| `out/p3_XAU_USD.npz` | 7,612,609 | `049ccd97ea2c035822b3cdb53acb777e1e66027ac377e71aad2ded3487a6a4f4` | 2026-10-08T04:09:35+02:00 | `python fm2.py export INST` |
| `out/summary_WTICO_USD.md` | 14,111 | `daa7aa3d2c9829465668f8c7aff2a841429c16a2a42390ad2bcfe63c1c22dd9d` | 2026-10-08T04:58:25+02:00 | not documented in the script usage |
| `out/summary_XAU_USD.md` | 10,479 | `e99d36508cbdea76b3f53775f68ab72f049d6738ddae28ff4192baabe3ebc019` | 2026-10-08T04:37:02+02:00 | not documented in the script usage |
| `out/syn_bolt_base.npz` | 9,824 | `f0449d1ffa55bf9c303b5365db43ebe68254c7eaa8b1be0059bacceaf27c4f66` | 2026-10-08T03:56:35+02:00 | not documented in the script usage |
| `out/syn_bolt_small.npz` | 9,808 | `146f203586c7d1fdf124b1df5f7ccb3310810e8ffcf48d91d40d047befeac4ba` | 2026-10-08T03:55:46+02:00 | not documented in the script usage |
| `out/syn_chronos2.npz` | 9,709 | `a9d24171adad36d7c2f08c6392fc03e9398ade1ca295ca440da5eb4a6607f04c` | 2026-10-08T03:57:05+02:00 | not documented in the script usage |
| `out/syn_chronos_t5_small.npz` | 10,678 | `1f57658db4f304a383caaaa52bada2463e327929b1ee4dc8a4aeb136b1c95e6b` | 2026-10-08T04:06:08+02:00 | not documented in the script usage |
| `out/syn_moirai11_small.npz` | 10,106 | `4f81b09ab5fa580e13283182f7d499159b1da991bd93d585f1cee62000c15a07` | 2026-10-08T04:08:09+02:00 | not documented in the script usage |
| `out/syn_timesfm25.npz` | 9,722 | `82e537aca18398f6f9e65f38ffefe28e756acc36c8e706d9375e1c20aea3291f` | 2026-10-08T04:07:16+02:00 | not documented in the script usage |
| `out/t5_syn.log` | 1,381 | `37a19dc1686afe82fcf5cb27cc59729ad579b1b31a56537423ebaeb767b8ea09` | 2026-10-08T04:06:08+02:00 | `run log` |
| `out/tfm_syn.log` | 263 | `ecbe56042a096159056c71ece5030a15c8ffe3ab56d5b38aef2df4c69a4178de` | 2026-10-08T04:07:16+02:00 | `run log` |

## imom34

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/imom34/` (repository path `data/research/engine/audit/imom34/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: none detected in the script source.
- Ran: 2026-10-09T11:13:15+02:00 to 2026-10-09T11:14:45+02:00 (file modification times).
- Scripts in the registry: `imom34.py`, `summarize.py`.
- Documented commands: `python imom34.py check | counts | register | amend "<reason>" | run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `prereg_body.json` | 4,046 | `aba8f74d258407bc187ebc6932d3a7b2f1769708b87e18807907e7c350a319a2` | 2026-10-09T11:13:37+02:00 | not documented in the script usage |
| `prereg_comment.md` | 4,065 | `6ae93388a22433aa30c7fdc69bbf1b876e37be08cfc196b104372f5b7cde3e18` | 2026-10-09T11:13:54+02:00 | not documented in the script usage |
| `result_comment.md` | 3,249 | `3e241e05da8ed95cf08a9d5852cb070297f4b11d7ef2400d9a723976cc0a57e0` | 2026-10-09T11:14:45+02:00 | not documented in the script usage |
| `out/counts.json` | 1,232 | `a1924f755074ef7e40635bcb37ed522e4597bc44d66262abe1c8e465f161bb66` | 2026-10-09T11:13:15+02:00 | not documented in the script usage |
| `out/report.txt` | 16,264 | `4546666370e871b67b48441ba401de2a6bcf56c6e5b80c5338ab73ca2939830d` | 2026-10-09T11:14:16+02:00 | not documented in the script usage |
| `out/results.json` | 110,149 | `e7afb2b7e9f5dc4c5991b056ef84ee1c580deb483fdb206952119706933a0253` | 2026-10-09T11:14:06+02:00 | not documented in the script usage |
| `out/run.log` | 953 | `02b88be57977be0786c91ae3dfe43d20521f978cccfc03eb2515e47ce3798673` | 2026-10-09T11:14:06+02:00 | `run log` |

## lead35

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/lead35/` (repository path `data/research/engine/audit/lead35/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-09T11:18:13+02:00 to 2026-10-09T11:20:42+02:00 (file modification times).
- Scripts in the registry: `lead35.py`, `posthoc_tally.py`, `posthoc_xcorr_year.py`, `summarize.py`.
- Documented commands: `python lead35.py check | counts | register | amend "<reason>" | run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `prereg_body.json` | 2,779 | `2dade027db41b8016c4bbea132d4b87f644119e182f9c231e981f8a1a255a2c9` | 2026-10-09T11:18:28+02:00 | not documented in the script usage |
| `prereg_comment.md` | 3,750 | `486370cd1d208c168c383e1e7ddf6df36a5678417cc66b3053bd526b2209cdd8` | 2026-10-09T11:18:48+02:00 | not documented in the script usage |
| `result_comment.md` | 4,625 | `b26a01db016a0047527fbfc1baed03b8aa74be14b914811ee9b81e8c3b30219e` | 2026-10-09T11:20:42+02:00 | not documented in the script usage |
| `out/counts.json` | 2,736 | `e56c997eba2874b90407a734df13e97e4d50ff224fd444f68f198e81df5e3358` | 2026-10-09T11:18:13+02:00 | not documented in the script usage |
| `out/posthoc_xcorr_year.txt` | 414 | `b85e02bceeb0cdd357596b638396275a0296f2341099d4aafbe321d38ff4b813` | 2026-10-09T11:20:04+02:00 | not documented in the script usage |
| `out/report.txt` | 87,136 | `1d081df8c2d3497365a2983b3b9a4cc1a36e76885d355c85024f948735983000` | 2026-10-09T11:19:45+02:00 | not documented in the script usage |
| `out/results.json` | 558,177 | `4c81d43ca794adec5d042fd4d2bcde840c90fda31480c1f4aed8cc63700e976a` | 2026-10-09T11:19:42+02:00 | not documented in the script usage |
| `out/run.log` | 2,092 | `395ad0c4165f66f8267e6335f3a4c573ace0e3479aa9e03d1c9dd47e728456a0` | 2026-10-09T11:19:42+02:00 | `run log` |
| `out/tally.txt` | 217 | `2f7d57ec2973adc9f73e67d30e9f701f2f7f06f8b781fc217a7b762f7bf3ece6` | 2026-10-09T11:20:15+02:00 | not documented in the script usage |

## lean21

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/lean21/` (repository path `data/research/engine/audit/lean21/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/candles.db (live engine, read-only), data/research/history.db.
- Ran: 2026-10-08T14:31:00+02:00 to 2026-10-08T14:31:01+02:00 (file modification times).
- Scripts in the registry: `lean21.py`, `summarize.py`.
- Documented commands: `python lean21.py check`; `python lean21.py register`; `python lean21.py run`; `python lean21.py today`.
- Modes dispatched on the first argument: `check`, `register`, `run`, `today`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `out_run.log` | 2,680 | `9ad7ca9f921170a6f7fbc407ef5a5df1a7abfc532abf8e9d0b939f838531cf9e` | 2026-10-08T14:31:01+02:00 | `run log` |
| `out/results.json` | 125,071 | `0bf74312062974c020a150f557dd19c053bd9bad8ce07d8784543c1b57ba57d7` | 2026-10-08T14:31:01+02:00 | `python lean21.py run` |
| `out/today_WTI.json` | 13,062 | `ced7920419faf69084eb5515dcaa451b37ec164fefcfc5db951a5e83b2ce8b60` | 2026-10-08T14:31:00+02:00 | `python lean21.py today` |

## lean22

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/lean22/` (repository path `data/research/engine/audit/lean22/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T14:40:19+02:00 to 2026-10-08T14:44:33+02:00 (file modification times).
- Scripts in the registry: `lean22.py`.
- Documented commands: `python lean22.py check`; `python lean22.py register`; `python lean22.py cell INST TF H TGT`; `python lean22.py report`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `out/cells.txt` | 619 | `6887b355d99cd38925b61bcc6ed02321a3a020c14e92b598f4702b962649e183` | 2026-10-08T14:40:19+02:00 | not documented in the script usage |
| `out/lean_track_record.json` | 231,376 | `f6fa07166ebc88cbffc8e74bdab40ff33b79899c21dc2b00692483dd805387b4` | 2026-10-08T14:44:33+02:00 | `python lean22.py report` |
| `out/report.txt` | 29,582 | `893175a43b18b3355bab7313b0b557e0fc70b5cb814082f06c423d4bcce6fed1` | 2026-10-08T14:44:33+02:00 | `python lean22.py report` |
| `out/report_run1_registered.txt` | 14,285 | `5f0517e726f0f78c2837f03c898afc41255b6c682ae4ecb8cec89514a99a37c5` | 2026-10-08T14:43:08+02:00 | not documented in the script usage |
| `out/results_full.json` | 1,042,370 | `d7cb93732422808f6d260431ef14bef120fdedf1b0a3e850d4532ba438d79922` | 2026-10-08T14:44:33+02:00 | not documented in the script usage |
| `out/run.log` | 2,441 | `c12c0b92bb31e6d85c80055f1c07bc5915443a4b35ff458ab598f964bfdfdb08` | 2026-10-08T14:41:42+02:00 | `run log` |
| `out/run_A1.log` | 2,441 | `88b415e8e6c5a789093e73bb2d7693d3f2a38e69f5f73dc4f52d0d30698806e9` | 2026-10-08T14:44:26+02:00 | `run log` |
| `out/cells/EUR_USD_M15_H12_up.json` | 449 | `3b71c121216f3039fd14697688a25262eff97e0754dc656d66c5efc3a78595b7` | 2026-10-08T14:43:15+02:00 | not documented in the script usage |
| `out/cells/EUR_USD_M15_H12_up.npz` | 250,499 | `1905b66ae57e9af40ab06e0920a09b1f813452d328901d82ec4239f104806fbf` | 2026-10-08T14:43:15+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/EUR_USD_M15_H48_plan.json` | 452 | `4c80f94d4cc7525ef84fa54376861f5aed87cae96d93d5ebcd31ba6e1465db29` | 2026-10-08T14:43:16+02:00 | not documented in the script usage |
| `out/cells/EUR_USD_M15_H48_plan.npz` | 243,905 | `76224e3b828e14f0fe9428523bd146bd5215b2af3e56beec7dd5fb864e995c9d` | 2026-10-08T14:43:16+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/EUR_USD_M1_H12_plan.json` | 395 | `28f79f2571c0dd7b2e9f906a8e15e05645d2a68db0e8112614cc2cbe03489630` | 2026-10-08T14:43:31+02:00 | not documented in the script usage |
| `out/cells/EUR_USD_M1_H12_plan.npz` | 278,294 | `87d5b4fb05fb9b6a05d2a348fda2d67de137393a456663eff803b537c9b111ea` | 2026-10-08T14:43:31+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/EUR_USD_M1_H12_up.json` | 421 | `14935588a3cf11ec24a193c22be8f03e2acda4304572980d823e5f199c7829e8` | 2026-10-08T14:43:28+02:00 | not documented in the script usage |
| `out/cells/EUR_USD_M1_H12_up.npz` | 278,997 | `e0b711d1b244156064ba940f55d48fdd5e9769cb0d68c132842a156c2ca74adc` | 2026-10-08T14:43:28+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/EUR_USD_M1_H48_plan.json` | 397 | `5d8f13aa6647b9c764be2bc105d4ecc851b45c99794d38bc1000aa8120a79095` | 2026-10-08T14:43:31+02:00 | not documented in the script usage |
| `out/cells/EUR_USD_M1_H48_plan.npz` | 243,184 | `c10b25f86e9295045eb69df634c29ebc886e5eb21c9a71bd1ee86ede727caa11` | 2026-10-08T14:43:31+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/EUR_USD_M5_H12_up.json` | 449 | `8e7cc8704db078d85321f9a4d3c1050a5def80eea27a875cac5b233518967236` | 2026-10-08T14:43:16+02:00 | not documented in the script usage |
| `out/cells/EUR_USD_M5_H12_up.npz` | 242,823 | `6677e5a2c17d84d2a80f989c1f1be20e51969faef1406666903d4b2ac92a9161` | 2026-10-08T14:43:16+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/EUR_USD_M5_H48_plan.json` | 454 | `ca19ad337532c3479d5ac68483d5302f8810a9bf36f02bd760eeba64616a41a5` | 2026-10-08T14:43:25+02:00 | not documented in the script usage |
| `out/cells/EUR_USD_M5_H48_plan.npz` | 233,023 | `597f8fecb14908c06348a1a9c1dc6c5ce033b020fbd6eb1636f3035fa9821b95` | 2026-10-08T14:43:25+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/EUR_USD_M5_H48_up.json` | 448 | `0b76abbb233c943bae9132a802d3c1cedfc25ee03e18155a6ffd784aef02ead9` | 2026-10-08T14:43:24+02:00 | not documented in the script usage |
| `out/cells/EUR_USD_M5_H48_up.npz` | 249,639 | `5488777ec610035709dc6f9a576e69ef07cd988cfd1c6bae8cf52b9a96d84c14` | 2026-10-08T14:43:24+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/NATGAS_USD_M1_H12_up.json` | 400 | `5348bde47474768e290a097326ddf2dc551bd5c082fbd7244732a77eb9c919bc` | 2026-10-08T14:43:31+02:00 | not documented in the script usage |
| `out/cells/NATGAS_USD_M1_H12_up.npz` | 246,571 | `ec61fe48045739105c441da9163dda208ceba4c4dc44d9d7674a03ff8b87b705` | 2026-10-08T14:43:31+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/NATGAS_USD_M5_H12_up.json` | 456 | `835450d20f03d0831558e37fa85578387feea0c0cb442e9729eadf4ffaafd2fd` | 2026-10-08T14:43:32+02:00 | not documented in the script usage |
| `out/cells/NATGAS_USD_M5_H12_up.npz` | 223,406 | `931e64ae08ab1d51662a0a03ca0d71bea67acd3d799795c271d8a5498052dc9e` | 2026-10-08T14:43:32+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/SPX500_USD_M1_H12_plan.json` | 397 | `772d702dc36be34c222083b2cdfa7f998bc35ae9510b881bdcf5485701e1cf1e` | 2026-10-08T14:43:44+02:00 | not documented in the script usage |
| `out/cells/SPX500_USD_M1_H12_plan.npz` | 283,192 | `f5247d68684976c7be63fa846fe5412857d5251cebbc21c2af327c7c66a404db` | 2026-10-08T14:43:44+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/SPX500_USD_M1_H12_up.json` | 428 | `f4e375c2858381cc52653f1bdea5d2c6a5534fede081f25cacae5606b939bc8a` | 2026-10-08T14:43:46+02:00 | not documented in the script usage |
| `out/cells/SPX500_USD_M1_H12_up.npz` | 282,289 | `c0b005709bbe52f0383a764c33fcbac82b9188928a8dbc07e172d5a2f1470310` | 2026-10-08T14:43:46+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/SPX500_USD_M1_H48_plan.json` | 399 | `3ba0813f9962795d50479f36b259b593399744d2ed7e6fdd2994c0e4c740e3e1` | 2026-10-08T14:43:52+02:00 | not documented in the script usage |
| `out/cells/SPX500_USD_M1_H48_plan.npz` | 258,814 | `14a11254cb5d171138cd5d979a860cc2eb705e578174916de05ab8f87a652d4d` | 2026-10-08T14:43:52+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/SPX500_USD_M5_H12_up.json` | 452 | `42a2fdfc8476905bb42290f0929457b95ceca6a0bc32b395d6d184cc18c13ce0` | 2026-10-08T14:43:38+02:00 | not documented in the script usage |
| `out/cells/SPX500_USD_M5_H12_up.npz` | 239,210 | `012a112afb2bf8161bd55109825d7253859ff00f864c665b9893bdcc1c3453fc` | 2026-10-08T14:43:38+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/SPX500_USD_M5_H48_plan.json` | 456 | `8ebe4aef67a99904e2da984600cb85a1f0d70fd8c810608e30ef9e01a47ea4ae` | 2026-10-08T14:43:40+02:00 | not documented in the script usage |
| `out/cells/SPX500_USD_M5_H48_plan.npz` | 233,810 | `0ed5a0f9470f7ca03f8e786602fa781ba5691ce880dcc3e48d97abc7740bbc64` | 2026-10-08T14:43:40+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/WTICO_USD_M15_H48_plan.json` | 457 | `37566ea06b1f07d328b6ef0595ac44301d5778652e3038d357815a88be2609ef` | 2026-10-08T14:43:40+02:00 | not documented in the script usage |
| `out/cells/WTICO_USD_M15_H48_plan.npz` | 228,315 | `91c8f2da61667b22c285b6a381cec04edab4237d1ff750de7adc692670e418b7` | 2026-10-08T14:43:40+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/WTICO_USD_M1_H12_up.json` | 427 | `cb5a12983a0449c6c3030049bb927042b24dfddf61fef12ad548ab788bcb89c3` | 2026-10-08T14:43:59+02:00 | not documented in the script usage |
| `out/cells/WTICO_USD_M1_H12_up.npz` | 269,383 | `77d827fa053c6d22afeaad598e723cc2e972ae65f8d1d37df763b3dfade4a6a7` | 2026-10-08T14:43:59+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/WTICO_USD_M1_H48_plan.json` | 400 | `b112997cab91234c7d5e0c89340da45ed5dd4ede730d402fc0c03c7554f93677` | 2026-10-08T14:44:01+02:00 | not documented in the script usage |
| `out/cells/WTICO_USD_M1_H48_plan.npz` | 225,236 | `c334700d73a92a0f3ce901a76cd90c9af9ca09ae7d84c1821e92c5ba3ae50900` | 2026-10-08T14:44:01+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/WTICO_USD_M1_H48_up.json` | 427 | `2031b8a2ed922af0ed1a2b398ff27b8c9b312dee345ce2ec9146963593176fc5` | 2026-10-08T14:44:00+02:00 | not documented in the script usage |
| `out/cells/WTICO_USD_M1_H48_up.npz` | 276,557 | `d7aae21d77be0407bdaa1726c265b24576112377ed304f10adf52439374f263a` | 2026-10-08T14:44:00+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/WTICO_USD_M5_H12_plan.json` | 455 | `647ce9909484ca3d08c9f1c7b495c6390c448ed4d2e798da29afdea4c2c4435a` | 2026-10-08T14:43:53+02:00 | not documented in the script usage |
| `out/cells/WTICO_USD_M5_H12_plan.npz` | 243,235 | `fc0d5d69dec7fc33a19311ac3464d32be2f007651081c288c41dd52441cb6dca` | 2026-10-08T14:43:53+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/WTICO_USD_M5_H12_up.json` | 455 | `8dc928a5cdda3fd2bdeefcd09a765c5834897891584ae072ee7ff33a3f8d390d` | 2026-10-08T14:43:53+02:00 | not documented in the script usage |
| `out/cells/WTICO_USD_M5_H12_up.npz` | 230,921 | `f9796e4c194bbad7a2c664a708bea2336d4df03e04ced2e9a8c1de5b2786ea81` | 2026-10-08T14:43:53+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/WTICO_USD_M5_H48_plan.json` | 456 | `0745316797492438b84ace31c71fed3451b75f9c2084a0bc605158a9a76540f9` | 2026-10-08T14:44:00+02:00 | not documented in the script usage |
| `out/cells/WTICO_USD_M5_H48_plan.npz` | 224,337 | `51d4de349b7b6e8bc6064d99dfe2eeea2cd783424e64ddc0131acc444ba30855` | 2026-10-08T14:44:00+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/XAG_USD_M15_H48_plan.json` | 453 | `1a8c3cf4d7cd75ee0686dbf6c8d9d63fe4e5d530cea3da8e9d9c05a277a8aa9d` | 2026-10-08T14:44:01+02:00 | not documented in the script usage |
| `out/cells/XAG_USD_M15_H48_plan.npz` | 223,222 | `9ab6492b5325e0689d388873429f614b245e084106d74c6d4e95e1d8912f2462` | 2026-10-08T14:44:01+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/XAG_USD_M1_H12_plan.json` | 382 | `ffaf75ff3f49b6bedbf98e16fea79148eafec32918b3054498a89543e23fd0af` | 2026-10-08T14:44:12+02:00 | not documented in the script usage |
| `out/cells/XAG_USD_M1_H12_plan.npz` | 251,201 | `75744756ce5149807720427ca885dddfc2a264c5b82f21328913aa972af58552` | 2026-10-08T14:44:12+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/XAG_USD_M1_H48_plan.json` | 380 | `e5998561d8aeadd6ecd17513afd286eae86861a9155e0f251abee5dc2dfea8a6` | 2026-10-08T14:44:18+02:00 | not documented in the script usage |
| `out/cells/XAG_USD_M1_H48_plan.npz` | 220,345 | `3bf533ffc459b89bbf32a171d9405a026c728a07828320e88a14327e106584e9` | 2026-10-08T14:44:18+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/XAG_USD_M5_H12_up.json` | 448 | `00605a387923b94ae05dda578174d95c9065b8b05a5611c2634e0ff28bb7a13e` | 2026-10-08T14:44:07+02:00 | not documented in the script usage |
| `out/cells/XAG_USD_M5_H12_up.npz` | 226,122 | `4ee17fb14cd41700830c9635e75b16d0c0aebc18f3712cf43a6f9b61a04c9438` | 2026-10-08T14:44:07+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/XAU_USD_M1_H12_plan.json` | 427 | `a668a4239900d26505bca8950a1092adc4d14a8ca28ad05cc117045520b046b3` | 2026-10-08T14:44:22+02:00 | not documented in the script usage |
| `out/cells/XAU_USD_M1_H12_plan.npz` | 275,283 | `cb344433227dde54da5be09f63a36a25d1e838b7ca04614c4a4a949813da833d` | 2026-10-08T14:44:22+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/XAU_USD_M1_H12_up.json` | 419 | `f73de67af2664abb969cd50d1bbb63e8d57f2ea64b51d4a0204897b634673314` | 2026-10-08T14:44:21+02:00 | not documented in the script usage |
| `out/cells/XAU_USD_M1_H12_up.npz` | 254,522 | `01230e9ed251264534b2feb129c2126f9cf9e62bac98fc8157838901d0567a96` | 2026-10-08T14:44:21+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/XAU_USD_M1_H48_plan.json` | 395 | `b5eb1e4e9f4f3dd6fe9585b457c179d45404e9af922d6a9e0a7d1633fed3ca0b` | 2026-10-08T14:44:25+02:00 | not documented in the script usage |
| `out/cells/XAU_USD_M1_H48_plan.npz` | 243,849 | `2681115303e9dc5f1b7b1b43a927782be6e3c219b3c6b2c513c66b392b4fe6b5` | 2026-10-08T14:44:25+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/XAU_USD_M1_H48_up.json` | 439 | `d88c8b3cba2c8736c375aa0f56b5df62ac7ff2e4d74d52d98de099bc8454da23` | 2026-10-08T14:44:26+02:00 | not documented in the script usage |
| `out/cells/XAU_USD_M1_H48_up.npz` | 267,368 | `6db17236531400d3e2e273693be7bf77d08f5fb2f7d52217aca51eff334da238` | 2026-10-08T14:44:26+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/XAU_USD_M5_H12_plan.json` | 453 | `2e16c0c1a0dcf2a530d73085fb29e1553fa605befbb6046749540517b3cb0cda` | 2026-10-08T14:44:21+02:00 | not documented in the script usage |
| `out/cells/XAU_USD_M5_H12_plan.npz` | 244,299 | `50d7c135e8847ae0605369203823ff8b0be93c9368db90b330f991006bcfc31d` | 2026-10-08T14:44:21+02:00 | `python lean22.py cell INST TF H TGT` |
| `out/cells/XAU_USD_M5_H48_plan.json` | 453 | `addbbfa0df5d25d8559b9663ebc510e9220e48f378acd03e277255e40c155a65` | 2026-10-08T14:44:26+02:00 | not documented in the script usage |
| `out/cells/XAU_USD_M5_H48_plan.npz` | 232,090 | `0756c5ceb27519c5a991ad3fcfc234c1cff5beb76d4e44d7f45b63ed05f39156` | 2026-10-08T14:44:26+02:00 | `python lean22.py cell INST TF H TGT` |

## legs27

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/legs27/` (repository path `data/research/engine/audit/legs27/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T16:13:02+02:00 to 2026-10-08T16:20:09+02:00 (file modification times).
- Scripts in the registry: `legs27.py`, `summarize.py`.
- Documented commands: `python legs27.py check`; `python legs27.py register`; `python legs27.py build INST TF`; `python legs27.py run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `prereg_comment.md` | 4,837 | `8050a15af28aa172ac406dfcfcdabfb4fac193ff32d8c82c15920f47d8d7c125` | 2026-10-08T16:13:02+02:00 | not documented in the script usage |
| `result_comment.md` | 6,636 | `44fd9fc6f1e462e97218b22331dc431de56e4d6ddf4ff66505bab80cd338e76b` | 2026-10-08T16:20:09+02:00 | not documented in the script usage |
| `out/b_EUR_USD_M1.pkl` | 7,118,271 | `8aa8be0730bcb9b83767549dd053bedb298d6fb7954979288da96cc3768a1c95` | 2026-10-08T16:13:53+02:00 | `python legs27.py build INST TF` |
| `out/b_EUR_USD_M15.pkl` | 6,713,847 | `23b28252db1858da61d72022e38546dff4d1372ef032a748c8d5f7c4b09050ca` | 2026-10-08T16:13:50+02:00 | `python legs27.py build INST TF` |
| `out/b_EUR_USD_M5.pkl` | 7,682,172 | `e5d7fb293bb70a6cedd9e4a8e6e159bd41e9d0032288718abd606eb03b58dee7` | 2026-10-08T16:13:49+02:00 | `python legs27.py build INST TF` |
| `out/b_NATGAS_USD_M1.pkl` | 6,490,482 | `753be561b2e4b91234294f2738c69e20d12ce0c8304ce0c4fa3f865917f430d7` | 2026-10-08T16:14:06+02:00 | `python legs27.py build INST TF` |
| `out/b_NATGAS_USD_M15.pkl` | 6,681,378 | `d245e045fe90c676942572070c79553bc01b0eff7417ed7f267851cd8a6bac4a` | 2026-10-08T16:14:04+02:00 | `python legs27.py build INST TF` |
| `out/b_NATGAS_USD_M5.pkl` | 7,672,820 | `de0b1a79e6bc2369d1536f0e0ca319d12e28bd5ed4ec0da3de1c5b243ece8914` | 2026-10-08T16:14:03+02:00 | `python legs27.py build INST TF` |
| `out/b_SPX500_USD_M1.pkl` | 6,689,250 | `adca25508e992c4bae05446102f2b981fcdd1c3c518a11fa902088b196e4a9af` | 2026-10-08T16:14:00+02:00 | `python legs27.py build INST TF` |
| `out/b_SPX500_USD_M15.pkl` | 6,690,234 | `a07deb5316685ac3b6519bb3a9d5ef2e21900f0c04e31dbdb8fd082e813edd80` | 2026-10-08T16:13:57+02:00 | `python legs27.py build INST TF` |
| `out/b_SPX500_USD_M5.pkl` | 7,635,649 | `a00b2f57c6ba07283e1913b5cb9193075bd443317694cb541a98132fe1592ec6` | 2026-10-08T16:13:56+02:00 | `python legs27.py build INST TF` |
| `out/b_WTICO_USD_M1.pkl` | 6,681,377 | `967d1c92d68dd545b3f9592866690b791cb29b27d8ce66f0b6b12c1e8177826c` | 2026-10-08T16:13:30+02:00 | `python legs27.py build INST TF` |
| `out/b_WTICO_USD_M15.pkl` | 6,681,377 | `ec19ecc92f07747c8ffc1c77267719f19c0d79497db364a0ef6a72da9804dbfe` | 2026-10-08T16:13:27+02:00 | `python legs27.py build INST TF` |
| `out/b_WTICO_USD_M5.pkl` | 7,656,082 | `6c368296ca91352848376e5572f3bff8e336bf82494095b0470fca496acaa624` | 2026-10-08T16:13:10+02:00 | `python legs27.py build INST TF` |
| `out/b_XAG_USD_M1.pkl` | 6,670,551 | `181a0f7aab47e31a2218399efa30c2d73de510adce595a18105cc850ac3dfa16` | 2026-10-08T16:13:45+02:00 | `python legs27.py build INST TF` |
| `out/b_XAG_USD_M15.pkl` | 6,681,375 | `6f66075479c7e5e144fc6362cccc81e6c704c0eefa51177a1ec78128939ac0ee` | 2026-10-08T16:13:42+02:00 | `python legs27.py build INST TF` |
| `out/b_XAG_USD_M5.pkl` | 7,637,116 | `03d8109fb39a813894e68d1c1948eb8fdca40dd16a5cf25a0c49c628c65d615f` | 2026-10-08T16:13:41+02:00 | `python legs27.py build INST TF` |
| `out/b_XAU_USD_M1.pkl` | 6,681,375 | `bf119b2c7f301e39fbf3343e296c8c466565462932368806dc8ffb14a4684ebe` | 2026-10-08T16:13:38+02:00 | `python legs27.py build INST TF` |
| `out/b_XAU_USD_M15.pkl` | 6,681,375 | `4c15bbd6c75bb1e17072228e442d08375af76897dae97e7b086aebff5f2f4185` | 2026-10-08T16:13:35+02:00 | `python legs27.py build INST TF` |
| `out/b_XAU_USD_M5.pkl` | 7,611,710 | `b5e0caebdd06ba870fc6ce0bc7f6eb9adaad34e43478825b5cc2ffa5e93604df` | 2026-10-08T16:13:34+02:00 | `python legs27.py build INST TF` |
| `out/build.log` | 1,714 | `f92c453a4562523e79941743aef1d435e42ce0246e9ff906a7fb6e485e3a90e5` | 2026-10-08T16:14:06+02:00 | `run log` |
| `out/report.txt` | 32,530 | `513aecb5ea51a321a5cab080fd8d8a7a65481b97aa6d989f76de05d824387929` | 2026-10-08T16:14:43+02:00 | not documented in the script usage |
| `out/results.json` | 1,054,404 | `353a052dccb85909eac9c4a2bc13b071f4bb92e9d2a1d681d73ab7222f42dcde` | 2026-10-08T16:14:35+02:00 | `python legs27.py run` |
| `out/run.log` | 350 | `69a8e7cb170fd2aba0b270cd367611cb6a4b7aaaa66732fd71998fb1ea49cc75` | 2026-10-08T16:14:35+02:00 | `run log` |

## limit13

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/limit13/` (repository path `data/research/engine/audit/limit13/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T08:53:56+02:00 to 2026-10-08T08:56:01+02:00 (file modification times).
- Scripts in the registry: `lim13.py`, `nullfix13.py`, `summarize.py`.
- Documented commands: `python lim13.py check`; `python lim13.py register`; `python lim13.py run`; `python nullfix13.py after|otherday`.
- Modes dispatched on the first argument: `amend`, `check`, `register`, `run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `out/nullfix_after.log` | 4,700 | `c888cfe32a62b6d1fcfc8a9d0cd3eb0961bdfd390fe95b28338ff15025524942` | 2026-10-08T08:56:01+02:00 | `run log` |
| `out/nullfix_otherday.log` | 4,698 | `fbfc6a01d79fee948103000cb5fb7c94c6dac7758cd6a815ae156decdad1c401` | 2026-10-08T08:56:01+02:00 | `run log` |
| `out/report.txt` | 21,355 | `0acc022027abde0796e65a45206c634157a2067d080b796562c56abc4572e3fe` | 2026-10-08T08:53:59+02:00 | not documented in the script usage |
| `out/results.json` | 213,969 | `b527bd9f104b5bfe6608160b4b5302db15b6022b24a3c75f57daf0632f87a366` | 2026-10-08T08:53:56+02:00 | `python lim13.py run` |
| `out/run.log` | 4,627 | `52c289e7a3b12a56589f7ac4876141c9f617ca479011cc0c84728b25c40e1c5b` | 2026-10-08T08:53:56+02:00 | `run log` |
| `out_null_after/results.json` | 215,681 | `8f4bf047f3bc4f7e730bef9b7959633986b9596ce5ab6706c81a78f392b2d33e` | 2026-10-08T08:56:01+02:00 | not documented in the script usage |
| `out_null_otherday/results.json` | 215,769 | `9a2d4dff0ed7af49571eb34ebbcfa61351b1d29fa21197ce532ad18dc5858aac` | 2026-10-08T08:56:01+02:00 | not documented in the script usage |

## mw6

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/mw6/` (repository path `data/research/engine/audit/mw6/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T05:10:59+02:00 to 2026-10-08T05:20:29+02:00 (file modification times).
- Scripts in the registry: `coverage.py`, `mw6.py`, `summarize.py`.
- Documented commands: `python mw6.py check`; `python mw6.py register`; `python mw6.py amend "reason"`; `python mw6.py run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `out/coverage.json` | 11,164 | `ffd2361ad03a03d743514b7773c2e6238d527d992fd3e974308c591312fb854e` | 2026-10-08T05:10:59+02:00 | not documented in the script usage |
| `out/results.json` | 1,001,605 | `0104cf98ae09b378437d2f19c6774151f21e7dcdb2330be7a22f020789a01a7d` | 2026-10-08T05:20:05+02:00 | `python mw6.py run` |
| `out/run.log` | 14,074 | `fcb6ddb636fbdd4a11e6cfb367eb91c2ecec01e096c0ed1412cf04dc60e842ff` | 2026-10-08T05:20:05+02:00 | `run log` |
| `out/summary.txt` | 74,636 | `226683606542134ecd36c0feb032cde61dc51936a681c54f8be4c69336c12a34` | 2026-10-08T05:20:29+02:00 | not documented in the script usage |

## news24

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/news24/` (repository path `data/research/engine/audit/news24/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: GDELT 2.0 GKG files (download), data/research/engine/audit/news24/news24.db, data/research/history.db.
- Ran: 2026-10-08T15:04:53+02:00 to 2026-10-09T03:05:19+02:00 (file modification times).
- Scripts in the registry: `count.py`, `events.py`, `feas.py`, `fetch.py`, `news24.py`, `prep.py`, `probe_doc.py`, `relevance.py`, `summarize.py`, `themes_probe.py`.
- Documented commands: `python fetch.py [--max N]`; `python news24.py selfcheck | plumb | run`; `python prep.py INST [INST ...]`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `.fetch.lock` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | 2026-10-08T15:14:08+02:00 | not documented in the script usage |
| `fetch.log` | 10,656 | `cd17bfcf55fa01486a7c6939a4efd775cd02388088850e79cc7451227ed7ece4` | 2026-10-09T03:04:05+02:00 | `run log` |
| `news24.db` | 6,658,396,160 | `246ad5ef5816b6ab57d0999117400fdbd00dfab6a421cc4ddf8286d692445f0e` | 2026-10-09T03:04:04+02:00 | not documented in the script usage |
| `prep.log` | 298 | `3bdae0f61259240cc99c15228bc61b03620406ad1f43069f46d8602c89304d2a` | 2026-10-08T15:10:58+02:00 | `run log` |
| `relevance.json` | 2,666 | `09dab78662dc71d4932979f899fa43374d8819fd5f83f58aa792ae2e12db63f8` | 2026-10-08T15:12:38+02:00 | not documented in the script usage |
| `cache/EUR_USD_M1.npz` | 388,821,900 | `5d8c289150508622d65a8926068a8de5d3f48db7340f9732b93edcc8462b41aa` | 2026-10-08T15:10:46+02:00 | not documented in the script usage |
| `cache/EUR_USD_M15.npz` | 26,417,946 | `e144b3c1895f80839481908bb3ea220ce0a33d5c627c7a139efeeeed320b9c09` | 2026-10-08T15:10:46+02:00 | not documented in the script usage |
| `cache/EUR_USD_M5.npz` | 79,130,386 | `53922ae6be9bba7a46046a61a58f9f917e369799757720a6c4509ff22e272ffb` | 2026-10-08T15:10:46+02:00 | not documented in the script usage |
| `cache/NATGAS_USD_M1.npz` | 249,695,253 | `ebc7e3a1091cf5194751545cdecc73843408dfd7061544621f6513e8043a8ad4` | 2026-10-08T15:10:58+02:00 | not documented in the script usage |
| `cache/NATGAS_USD_M15.npz` | 24,403,659 | `ba3602895a0c0085b2ac160d7f76b9cc8ca392ea68b7b9becc2a4bf24c898a4f` | 2026-10-08T15:10:58+02:00 | not documented in the script usage |
| `cache/NATGAS_USD_M5.npz` | 67,688,263 | `30ff8764c55d48975ea193432bb72c6900100a95ac777725664caee04a9167fe` | 2026-10-08T15:10:58+02:00 | not documented in the script usage |
| `cache/SPX500_USD_M1.npz` | 355,605,222 | `c13ddaa07962fa96c6ff621526a6bcde5477531706cfbbb57170106f45106232` | 2026-10-08T15:10:53+02:00 | not documented in the script usage |
| `cache/SPX500_USD_M15.npz` | 24,929,646 | `002f80e11105e1bcd35263bb8727dde125b22da4637da5937ec5d699ca16866c` | 2026-10-08T15:10:53+02:00 | not documented in the script usage |
| `cache/SPX500_USD_M5.npz` | 74,553,803 | `f09fb8976cc9d25fdeaf49e35ed6ad7603d502bf4856be2a2d2d4e3eb40f73b3` | 2026-10-08T15:10:53+02:00 | not documented in the script usage |
| `cache/WTICO_USD_M1.npz` | 363,284,608 | `1046d6bc66a73b65c015056f84a4fb907a35a02e81b5df7de8b003a38463be68` | 2026-10-08T15:10:19+02:00 | not documented in the script usage |
| `cache/WTICO_USD_M15.npz` | 25,078,113 | `d08bab885db26631445dd2e1f577afc30a1e9322dc83dd337a482a39a8f6df16` | 2026-10-08T15:10:19+02:00 | not documented in the script usage |
| `cache/WTICO_USD_M5.npz` | 75,124,681 | `41f0c47806dff23ad59b79d8dc27cabd966ee840ba5008b8c555ae08a78a3e47` | 2026-10-08T15:10:19+02:00 | not documented in the script usage |
| `cache/XAG_USD_M1.npz` | 341,703,169 | `608830602e7d030a24332de42f39c78bd97a14ed0790974c0da28cb7007427e9` | 2026-10-08T15:10:38+02:00 | not documented in the script usage |
| `cache/XAG_USD_M15.npz` | 25,053,913 | `9866b11329250d16d2591bbc0510390a5d4924808b14741fe76109c5a2b0f0ef` | 2026-10-08T15:10:38+02:00 | not documented in the script usage |
| `cache/XAG_USD_M5.npz` | 74,323,177 | `0115cd23df3208a9caaf3aac557b7833743e255f4420e00d0930419fdf0625da` | 2026-10-08T15:10:38+02:00 | not documented in the script usage |
| `cache/XAU_USD_M1.npz` | 370,380,169 | `bfb9823dc4531ea88660bd7b9e986cdec31d6e01f8e1a8c6dd2cc08558740d56` | 2026-10-08T15:10:31+02:00 | not documented in the script usage |
| `cache/XAU_USD_M15.npz` | 25,088,761 | `cd64038d4982f6458e60d8207d8762e2c74c1cca587a93cf605816ef28341d5a` | 2026-10-08T15:10:31+02:00 | not documented in the script usage |
| `cache/XAU_USD_M5.npz` | 75,226,926 | `b459545422d03bbf78beab771284db74cb0d24b465f36e5148acec70a300fcb6` | 2026-10-08T15:10:31+02:00 | not documented in the script usage |
| `cache/needed_M1.npy` | 93,320 | `a25aa2998406a36f06879e7ba39f91cbc8ed371795f1b2b6cc2904a941545b39` | 2026-10-08T15:13:12+02:00 | not documented in the script usage |
| `cache/needed_M15.npy` | 65,736 | `488de94f7cf08d4d10d8cb6d04638f4c09f664158f8d1215875c641c4a1f4a16` | 2026-10-08T15:13:12+02:00 | not documented in the script usage |
| `cache/needed_M5.npy` | 98,112 | `ba9e138fb924a36538fe7d89334ff40f38a2d04208e2fbef932b4049b06b722f` | 2026-10-08T15:13:12+02:00 | not documented in the script usage |
| `cache/needed_windows.npy` | 192,280 | `523af01c1351e60c3c2dc157a2a152e6dd07a122cbd0770325129760a1924ee3` | 2026-10-08T15:11:11+02:00 | not documented in the script usage |
| `out/amendment1_comment.md` | 1,117 | `493b6eb9140eebb2ad927d301969fc032a3f26c961d04f3c9f36f09b8fce2e9e` | 2026-10-08T15:26:19+02:00 | not documented in the script usage |
| `out/plumb.log` | 2,901 | `7e337e5def5c41599b151a7ff7e895d843f23cce9ef3288643c944fb58c1af88` | 2026-10-09T03:04:21+02:00 | `run log` |
| `out/prereg_comment.md` | 2,818 | `860d06e1971484a7ea8d5025ac5d62048562c71668c8c4e5a5cbd5ba158f012a` | 2026-10-08T15:15:55+02:00 | not documented in the script usage |
| `out/prereg_comment_edited.md` | 3,078 | `ad7be9a0900f6d2aab632efd666be0ee7415a9bab83069ffb60121bed20961ee` | 2026-10-08T15:26:25+02:00 | not documented in the script usage |
| `out/report.txt` | 26,908 | `f6ed4127942020e1815f46c5b875d0a26ac95d2da2c6f402a9939730591955db` | 2026-10-09T03:04:42+02:00 | not documented in the script usage |
| `out/results.json` | 114,859 | `10ee1d6fd9614bfae0a8e7ca1c5b9c7c40ad58d2bd377b07d26e0ef2bc843f89` | 2026-10-09T03:04:35+02:00 | not documented in the script usage |
| `out/results_comment.md` | 3,355 | `6f1456afd86d9f8a0aa5023153b70f7d5cad72cea77ee68d065ca55f0be12657` | 2026-10-09T03:05:19+02:00 | not documented in the script usage |
| `out/run.log` | 2,973 | `46c1f3de8cdebca8cd9e3089d56b08add2b9fb6cb304013b56b9691db583327a` | 2026-10-09T03:04:35+02:00 | `run log` |
| `raw/doc_probe.json` | 444 | `44c03f8dd984184218c90dc7e64aed9e6e2d8b17426feb5aa7933b3c44df64c6` | 2026-10-08T15:05:25+02:00 | not documented in the script usage |
| `raw/g.zip` | 4,590,899 | `77cfa1968c31d86e6ef52885e1a565e7f3677c15dfe6322c5b7411f1cfcabea9` | 2026-10-08T15:09:28+02:00 | not documented in the script usage |
| `raw/masterfilelist.txt` | 128,354,033 | `1f56a572d1a98f1939b0f95adf834bf78c9c0f54e51e08a99c68ee0f68b73a9f` | 2026-10-08T15:04:53+02:00 | not documented in the script usage |
| `raw/t.zip` | 73,737 | `b3f7a900ca2f77b95e16db93538ec7a58218b3ab8eea4e905d936e648911812e` | 2026-10-08T15:07:15+02:00 | not documented in the script usage |

## news28

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/news28/` (repository path `data/research/engine/audit/news28/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/engine/audit/news24/news24.db, data/research/engine/audit/news28/labels.db.
- Ran: 2026-10-09T08:33:07+02:00 to 2026-10-09T09:45:11+02:00 (file modification times).
- Scripts in the registry: `calib.py`, `jev.py`, `junk.py`, `label.py`, `rule28.py`, `sample.py`, `urlstats.py`.
- Documented commands: `python jev.py probe`; `python label.py single`; `python label.py batch N [N ...]`; `python label.py reask`; `python rule28.py fit | eval`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `labels.db` | 4,612,096 | `2b4a4c8a8b071a974b00f917431daf88b1f6ed84a8e810131537511989727251` | 2026-10-09T09:45:09+02:00 | not documented in the script usage |
| `relevance28.json` | 10,268 | `70e61b2fce0444c20c2c065adf1c95689986c23420edfcd0a62be24f35cf4bbb` | 2026-10-09T09:25:05+02:00 | not documented in the script usage |
| `out/calib.json` | 1,553 | `5fc08673eeb59fc1331d6b3befe4c6fce126f890982c86f29b7fc8a8922043ab` | 2026-10-09T09:45:11+02:00 | not documented in the script usage |
| `out/jev_calls.jsonl` | 571,771 | `38fc3fb98c3d79a4215726275e603fa2c930cd3f49f505b9882a5bd7039b9001` | 2026-10-09T09:45:09+02:00 | not documented in the script usage |
| `out/junk.json` | 8,741 | `8405da74a30fb821848cb361798e0e72da0b7aa665a561a031892f067dd361e5` | 2026-10-09T09:23:29+02:00 | not documented in the script usage |
| `out/label_reask.log` | 68 | `e4e69df23c4cde368666db6b649868369105159b59f0b2bef6ae6a401076d063` | 2026-10-09T09:43:44+02:00 | `run log` |
| `out/label_single.log` | 276 | `922aa0ce7984b0854f07b0c22aed6c97e107a00065a80056a8f0df67e2e9f31b` | 2026-10-09T09:21:17+02:00 | `run log` |
| `out/relevance28_droplist_v1_rejected.json` | 3,276 | `a736ca86d508b642d3cc1a24327682d1dd4ea2d0621da8844e34ff64a5cbc04c` | 2026-10-09T09:24:24+02:00 | not documented in the script usage |
| `out/relevance28_keeplist_rejected.json` | 3,566 | `6d64fdbe83c28837717638423552814f66cf2d724947012532fdeba3ccfb029c` | 2026-10-09T09:23:52+02:00 | not documented in the script usage |
| `out/review100.txt` | 13,658 | `e3b97bcf1785dc0e7a170f8e36b6f83009eb8339584dc3c23bddf19eddd869bf` | 2026-10-09T09:25:19+02:00 | not documented in the script usage |
| `out/rule28_droplist_v1_rejected_eval.json` | 2,281 | `9dd2b6d01d942f80eb96ce0b48a8525947ffb67dc9298561002fb33f47745cc7` | 2026-10-09T09:24:24+02:00 | not documented in the script usage |
| `out/rule28_eval.json` | 2,277 | `7d28c47ef2360d3f63c0f3b22ebbaa2219f220318ec3c144da258fbe17cc9916` | 2026-10-09T09:25:05+02:00 | not documented in the script usage |
| `out/rule28_keeplist_rejected_eval.json` | 2,705 | `2dc3d4a559462a869efb24781ad94dece385aecacbbece24e7e13601a4861ffb` | 2026-10-09T09:23:52+02:00 | not documented in the script usage |
| `out/urlstats.json` | 562 | `8a479bd3977b59c6a65779cccedb45092d05e6c1c8575500eb4ade9d92f9cbd7` | 2026-10-09T08:33:07+02:00 | not documented in the script usage |
| `out/urlstats.log` | 563 | `2c4d5a60ea45a360211d48ee88174c660ad09c0e309559ef9e3e69507a39e884` | 2026-10-09T08:33:07+02:00 | `run log` |

## night38

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/night38/` (repository path `data/research/engine/audit/night38/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-09T11:45:09+02:00 to 2026-10-09T11:47:41+02:00 (file modification times).
- Scripts in the registry: `diag.py`, `night38.py`, `posthoc.py`.
- Documented commands: `python night38.py check | counts | register | amend "<reason>" | run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `prereg_body.json` | 3,899 | `71fc2217ffc3d8cc7205aee2d15952387bfef255bd1a67faa48dd9fc7c1a392c` | 2026-10-09T11:45:27+02:00 | not documented in the script usage |
| `prereg_comment.md` | 3,306 | `87488a4c1afbd75d4fa8416f699749dce6ec1eaf6445b570c7f1294d27ff9f76` | 2026-10-09T11:45:41+02:00 | not documented in the script usage |
| `result_comment.md` | 4,539 | `8c5aa45c87b36b57f652523dfe44bda7779dde2dd328566413cd03b7f5d6a933` | 2026-10-09T11:47:41+02:00 | not documented in the script usage |
| `out/counts.json` | 963 | `a395fec987830a33a1d4ad7dd0489229bcecfded2209ee3b359bdb7a5c484f71` | 2026-10-09T11:45:09+02:00 | not documented in the script usage |
| `out/diag_spx.txt` | 1,024 | `1a1158a8415d4fe4d8a7566e04908bbbc80c926c42d01f31cd3f79ab640c9c94` | 2026-10-09T11:46:20+02:00 | not documented in the script usage |
| `out/report.txt` | 7,830 | `2ad073a31f1cbd4179db680ca4b7c0b631a2d436687d7cea3ffd6048232f50d0` | 2026-10-09T11:45:55+02:00 | not documented in the script usage |
| `out/results.json` | 39,594 | `940ee50658fa536103df5c5c7e822016ed9c97bf98d474c0d3b6c3602095c56b` | 2026-10-09T11:45:55+02:00 | not documented in the script usage |
| `out/posthoc/report.txt` | 7,827 | `157fccb7c614e5fbc988cb6298a8c200cd516ea51c3b743156f58ea48501b80a` | 2026-10-09T11:47:20+02:00 | not documented in the script usage |
| `out/posthoc/report_stdout.txt` | 7,827 | `157fccb7c614e5fbc988cb6298a8c200cd516ea51c3b743156f58ea48501b80a` | 2026-10-09T11:47:20+02:00 | not documented in the script usage |
| `out/posthoc/results.json` | 39,667 | `5aa5ece93325cda1a9b6a1fbcf1f5f57f7967ed717ce7afd8ede11934179bbff` | 2026-10-09T11:47:20+02:00 | not documented in the script usage |

## notrade12

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/notrade12/` (repository path `data/research/engine/audit/notrade12/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T08:43:58+02:00 to 2026-10-08T08:46:29+02:00 (file modification times).
- Scripts in the registry: `nt12.py`, `summarize.py`.
- Documented commands: `python nt12.py check`; `python nt12.py explore`; `python nt12.py register`; `python nt12.py run`.
- Modes dispatched on the first argument: `amend`, `check`, `explore`, `register`, `run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `out/explore.json` | 11,013 | `c1f29179b98439c8e9422328d35873714dfa17e8969fbe80636a7f32097ebae7` | 2026-10-08T08:43:58+02:00 | not documented in the script usage |
| `out/explore.log` | 8,631 | `5b14816557080ee5722ab9434a48af9a590f2dcbccc56ca3290c6517d1369a5a` | 2026-10-08T08:43:58+02:00 | `run log` |
| `out/report.txt` | 15,748 | `a99a2a4ee53b5210c61e16e9db88d88390e1278ccfef0b01f2d81aacb4b7b8da` | 2026-10-08T08:46:29+02:00 | `python nt12.py run` |
| `out/report_run1.txt` | 15,759 | `5075c1e1e9efe70d7b982bf9a7825e8b46702f96815fd528ea088932b7461485` | 2026-10-08T08:45:47+02:00 | not documented in the script usage |
| `out/results.json` | 129,436 | `c80a015fd61d6f421310f1ae145d5603e3425ec45a238729c087b21a1d9e8f54` | 2026-10-08T08:46:29+02:00 | `python nt12.py run` |
| `out/results_run1.json` | 120,477 | `6dc221edd7df2cb57ff12c13768d9fb7e16e9182c708cbde0148ddd16cde9be8` | 2026-10-08T08:45:47+02:00 | not documented in the script usage |
| `out/run.log` | 1,434 | `1c2daa2e18c77703b4d19e9e21cc44416b6d42fb7acc325a9c57f1857ee2e340` | 2026-10-08T08:46:29+02:00 | `run log` |

## orb15

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/orb15/` (repository path `data/research/engine/audit/orb15/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T09:18:21+02:00 to 2026-10-08T09:20:21+02:00 (file modification times).
- Scripts in the registry: `orb15.py`, `summarize.py`, `verify.py`.
- Documented commands: `python orb15.py check`; `python orb15.py register`; `python orb15.py amend "why" append an amendment with new code hashes`; `python orb15.py build INST`; `python orb15.py run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `out/build_NATGAS_USD.log` | 229 | `95c0506e584f4abaca461e7afa9430e6d9d434a1a3a9d3cf401adb98a59c117b` | 2026-10-08T09:19:46+02:00 | `run log` |
| `out/build_SPX500_USD.log` | 227 | `da3d8e1e67049a2f1c92744264ca0f337d00f7db9674c8519056b0f9fa25fe08` | 2026-10-08T09:19:51+02:00 | `run log` |
| `out/build_WTICO_USD.log` | 239 | `ebeb3986c8940d66d70ada2dbf858995185388b1e2df7a773c4db912e7396802` | 2026-10-08T09:19:48+02:00 | `run log` |
| `out/build_XAG_USD.log` | 224 | `45511573cab81cb0b2abb8112414b6b84bea6f5f016d298a7fe1ae8c98903c3d` | 2026-10-08T09:19:49+02:00 | `run log` |
| `out/build_XAU_USD.log` | 224 | `e13ba759ed41abaaf97823307cc31147e3e33a0241df1da048217d2cf1be11e6` | 2026-10-08T09:19:48+02:00 | `run log` |
| `out/ev_EUR_USD.pkl` | 272,864,533 | `a8e199fd17684eb505c74b1b58462df13b148c5d1008b8b03b54dc351793a012` | 2026-10-08T09:18:21+02:00 | `python orb15.py build INST` |
| `out/ev_NATGAS_USD.pkl` | 241,804,308 | `2f133d51730a5d770475bb908730a713c396013ac0d239ac05a6d07685df43ea` | 2026-10-08T09:19:46+02:00 | `python orb15.py build INST` |
| `out/ev_SPX500_USD.pkl` | 253,652,784 | `a717045f09f36a3e2dc995dd5c6eb1033263cf8d07ef142c202b94af1daa9dc7` | 2026-10-08T09:19:51+02:00 | `python orb15.py build INST` |
| `out/ev_WTICO_USD.pkl` | 247,221,096 | `4dca3aa2f729ec749bc2509fa3609b554e91c0df2659b732370e936dac18feda` | 2026-10-08T09:19:48+02:00 | `python orb15.py build INST` |
| `out/ev_XAG_USD.pkl` | 245,977,674 | `575b66826eaa888b258d1bfde8abca7989e72508bdb9c99c98c1ab386d8f64af` | 2026-10-08T09:19:49+02:00 | `python orb15.py build INST` |
| `out/ev_XAU_USD.pkl` | 247,126,592 | `8c4cb7ebb1d63e9280f067281c4f608e8ecbade85446848a021387b8aefde9be` | 2026-10-08T09:19:48+02:00 | `python orb15.py build INST` |
| `out/results.json` | 95,247 | `d2ef844bfe63bfe6cd10f4d9899ddc56291fc169a793e8e72b220ed847621cd9` | 2026-10-08T09:20:07+02:00 | `python orb15.py run` |
| `out/run.log` | 2,489 | `b2da9f8f9dedd0bfa65ac1d261b2a1d80b9ebcfd4f4150abafe216e0f0191a34` | 2026-10-08T09:20:07+02:00 | `run log` |
| `out/summary.txt` | 16,950 | `7e9cae171f659bd070d6884709488fc52aa58336826267b0dd385227287465bf` | 2026-10-08T09:20:21+02:00 | not documented in the script usage |

## pairs16

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/pairs16/` (repository path `data/research/engine/audit/pairs16/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T09:28:38+02:00 to 2026-10-08T09:30:35+02:00 (file modification times).
- Scripts in the registry: `cache_nas.py`, `explore_ratio.py`, `pairs16.py`, `summarize.py`.
- Documented commands: `python pairs16.py check`; `python pairs16.py register`; `python pairs16.py amend why`; `python pairs16.py run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `out/explore_ratio.json` | 3,883 | `37d80694197909eb5ec8670c8ade52f3da08d1279c68d7cc6eab365b06844b48` | 2026-10-08T09:30:35+02:00 | not documented in the script usage |
| `out/results.json` | 35,960 | `194e05aafba5d4dc94ffb307aaa935a8418900e184d24197f21405b2ce68c5b5` | 2026-10-08T09:28:38+02:00 | `python pairs16.py run` |

## pprofit20

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/pprofit20/` (repository path `data/research/engine/audit/pprofit20/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T09:47:50+02:00 to 2026-10-08T11:41:07+02:00 (file modification times).
- Scripts in the registry: `backfill_ci.py`, `card_rule.py`, `diag.py`, `grid_a4.py`, `pp20.py`, `summarize.py`, `verify_a4.py`, `verify_iso.py`.
- Documented commands: `python pp20.py check`; `python pp20.py register`; `python pp20.py run [INST]`; `python verify_iso.py self`; `python verify_iso.py parity [GLOB]`.
- Modes dispatched on the first argument: `parity`, `self`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `prereg_draft.json` | 5,176 | `27c8a52eff27e0e8c15f50e91c6dda23cd7a2d269aa3f5fbbc008dcdf9133e51` | 2026-10-08T09:48:19+02:00 | not documented in the script usage |
| `prereg_draft_horizons.json` | 2,997 | `98cdf0f6ff65c71aa2af679d22441c1d1fd979ea2478c4376eb7d57a2ca6f729` | 2026-10-08T11:27:43+02:00 | not documented in the script usage |
| `prereg_draft_m1.json` | 3,949 | `b26c95af4805ab4a59e1251ed8b5d89501d1584740f3c3b030ace696099f7231` | 2026-10-08T10:40:02+02:00 | not documented in the script usage |
| `prereg_draft_m15.json` | 1,443 | `05770ccd23f25944393d06e53b42b67be0fab954a05c649c1f7f72ccc3579de4` | 2026-10-08T09:54:11+02:00 | not documented in the script usage |
| `prereg_draft_m1_iso.json` | 2,936 | `e66351223120bbf79258a834c6486467ca46c1f5e80f075d795379d82d1f339b` | 2026-10-08T11:04:28+02:00 | not documented in the script usage |
| `out/artifact_EUR_USD_M15_H12_plan_pprofit20.json` | 15,487 | `4b7cac96ea93516ff413acda1022762472ec6c5845740cb3724781188711e59e` | 2026-10-08T11:36:09+02:00 | `python pp20.py run [INST]` |
| `out/artifact_EUR_USD_M15_H12_up_pprofit20.json` | 15,650 | `34d2e5852b993a7851ecabb2cad1ee4b4bf23497eeeefcb4c34066a769a1260d` | 2026-10-08T11:36:03+02:00 | `python pp20.py run [INST]` |
| `out/artifact_EUR_USD_M15_H48_plan_pprofit20.json` | 15,580 | `5e099797654f51e192f8fef35a080fa133b350a167978b7ee17731c17353b5f0` | 2026-10-08T11:39:38+02:00 | `python pp20.py run [INST]` |
| `out/artifact_EUR_USD_M15_H48_up_pprofit20.json` | 15,574 | `49aebae130d3345f717cbee167a839f0bd3d7570c70edd1a7b0ce9798673a1ac` | 2026-10-08T11:39:33+02:00 | `python pp20.py run [INST]` |
| `out/artifact_EUR_USD_M15_pprofit20.json` | 15,721 | `6d015684824cd68c0cab2290e5c962e024653926dc25c1c4e43d7fe5c5e7c535` | 2026-10-08T10:39:31+02:00 | `python pp20.py run [INST]` |
| `out/artifact_EUR_USD_M1_H12_plan_pprofit20.json` | 44,496 | `4b53cbaa040504a89724190836250b48e53dac5f1cbdd9d623b0d911addb40c4` | 2026-10-08T11:37:39+02:00 | `python pp20.py run [INST]` |
| `out/artifact_EUR_USD_M1_H12_up_pprofit20.json` | 45,576 | `f510268b50bb4acd9eedcdedddebfb58081bc7c83174b024640a04a2e083d8c3` | 2026-10-08T11:38:00+02:00 | `python pp20.py run [INST]` |
| `out/artifact_EUR_USD_M1_H48_plan_pprofit20.json` | 43,718 | `58393f492bf67cf85f379c5a15f141bb60610d8f256a2b04f6b83a45e7247451` | 2026-10-08T11:40:50+02:00 | `python pp20.py run [INST]` |
| `out/artifact_EUR_USD_M1_H48_up_pprofit20.json` | 44,809 | `bb4bb394812d70e65294091f1358a4fcea68f8405dada666632910990a983f56` | 2026-10-08T11:40:43+02:00 | `python pp20.py run [INST]` |
| `out/artifact_EUR_USD_M1_iso_pprofit20.json` | 43,332 | `3743f9e3b8bf410e82299687bafa9a100116e652b02592c26d2c96ce60d8fc12` | 2026-10-08T11:06:13+02:00 | `python pp20.py run [INST]` |
| `out/artifact_EUR_USD_M1_pprofit20.json` | 40,082 | `9cf5c2bc3904e39a2aba1ca541a41a58fccffafb794d85e5239b50e28992ec8a` | 2026-10-08T10:41:49+02:00 | `python pp20.py run [INST]` |
| `out/artifact_EUR_USD_M5_H12_plan_pprofit20.json` | 15,458 | `60aef334e7766fba449802e98eb8b92c89452da1c697adf0d0118a6295415284` | 2026-10-08T11:31:55+02:00 | `python pp20.py run [INST]` |
| `out/artifact_EUR_USD_M5_H12_up_pprofit20.json` | 15,399 | `c47a64f47367496f97299e69334da966988d96f901443c1dac38993bb241a830` | 2026-10-08T11:31:59+02:00 | `python pp20.py run [INST]` |
| `out/artifact_EUR_USD_M5_H48_plan_pprofit20.json` | 15,329 | `c6ae0c0b998460e3fd33872d9936e6af5528bacfe5793b20c1bc51e61aaa425b` | 2026-10-08T11:32:03+02:00 | `python pp20.py run [INST]` |
| `out/artifact_EUR_USD_M5_H48_up_pprofit20.json` | 15,414 | `5d3e12930259967944a74107e568a057b1d1ff5d1d9dc021d69bfbe9bd0dfd12` | 2026-10-08T11:31:46+02:00 | `python pp20.py run [INST]` |
| `out/artifact_EUR_USD_pprofit20.json` | 15,461 | `03a4f7ab65a1334098778b0ca04129addfe6aa0eaffa82fd25bf99a728c9ee4e` | 2026-10-08T10:39:31+02:00 | `python pp20.py run [INST]` |
| `out/artifact_NATGAS_USD_M1_H12_plan_pprofit20.json` | 41,608 | `162d44e999077a2cb844b1ab66db606d7d94162dc7551856f8a55a1dd879c358` | 2026-10-08T11:34:00+02:00 | `python pp20.py run [INST]` |
| `out/artifact_NATGAS_USD_M1_H12_up_pprofit20.json` | 44,388 | `78796239daf45f44aa8121a002e042cb18b88bd87c47b632bf6ec4d477abbe1d` | 2026-10-08T11:34:25+02:00 | `python pp20.py run [INST]` |
| `out/artifact_NATGAS_USD_M1_H48_plan_pprofit20.json` | 41,347 | `387f857ccb58c4ce237a00968c0b581c7e75b7b51a98b55e2a563d19f9acc0c6` | 2026-10-08T11:38:03+02:00 | `python pp20.py run [INST]` |
| `out/artifact_NATGAS_USD_M1_iso_pprofit20.json` | 40,951 | `36bf5ac7544e95c198686b36ddfdd93f731103720edc7ffd67b9b127d99ca08f` | 2026-10-08T11:07:15+02:00 | `python pp20.py run [INST]` |
| `out/artifact_NATGAS_USD_M1_pprofit20.json` | 40,205 | `777ca28a8f362fe2f2e7faae1b0eb173ed49ab0803a602d2b364fb7938e97d4a` | 2026-10-08T10:42:49+02:00 | `python pp20.py run [INST]` |
| `out/artifact_NATGAS_USD_M5_H12_up_pprofit20.json` | 15,360 | `c2badd8e459f2553b6a9f79439ac4e7f6ba1404dc2723ae62e6065ad5868ecad` | 2026-10-08T11:30:33+02:00 | `python pp20.py run [INST]` |
| `out/artifact_SPX500_USD_M15_pprofit20.json` | 15,518 | `b2bfca1dfdeb309c21a3eb5a38067381d2e8fca263aff0aed0f0287beaa19cbb` | 2026-10-08T10:39:39+02:00 | `python pp20.py run [INST]` |
| `out/artifact_SPX500_USD_M1_H12_plan_pprofit20.json` | 44,365 | `0c3852de255d4280660673093478011c6b02dfcc8faf6a2e50a83eb41a250bd2` | 2026-10-08T11:35:46+02:00 | `python pp20.py run [INST]` |
| `out/artifact_SPX500_USD_M1_H12_up_pprofit20.json` | 43,280 | `d27ef799ea4ba4a62d95cd831f6310cb815b46e26a3d2bae51e0cfd34bc5a5a7` | 2026-10-08T11:36:10+02:00 | `python pp20.py run [INST]` |
| `out/artifact_SPX500_USD_M1_H48_plan_pprofit20.json` | 44,425 | `dab2c235b2c69ac9c755ade0a5ca2c475f4a69e4554ae640181ad03c918c7604` | 2026-10-08T11:39:31+02:00 | `python pp20.py run [INST]` |
| `out/artifact_SPX500_USD_M1_iso_pprofit20.json` | 44,307 | `dba7b9ca5e1c8f081289f7d1accc89e36cb8ce0dc0e01b0f321eac90b26ef3f3` | 2026-10-08T11:07:39+02:00 | `python pp20.py run [INST]` |
| `out/artifact_SPX500_USD_M5_H12_up_pprofit20.json` | 15,441 | `e20744901cace1248fdb70a1d815a18490a218e4775bf43a9f85440c0797f4e3` | 2026-10-08T11:31:16+02:00 | `python pp20.py run [INST]` |
| `out/artifact_SPX500_USD_M5_H48_plan_pprofit20.json` | 15,551 | `ef26be4bcbfb833d97e678f8c08e7d0427bc72a1127f6444134bfaf139660e6e` | 2026-10-08T11:31:17+02:00 | `python pp20.py run [INST]` |
| `out/artifact_SPX500_USD_pprofit20.json` | 15,679 | `5d88a658ff2bcc7e0882f2cc6ca1ecabb5d08673d651a0aea864a3db5475309d` | 2026-10-08T10:39:39+02:00 | `python pp20.py run [INST]` |
| `out/artifact_WTICO_USD_M15_H12_plan_pprofit20.json` | 15,536 | `202dcbf5197588fe48b9ea9b31ed60d192bff0e278b844466fc0149118806ac8` | 2026-10-08T11:32:49+02:00 | `python pp20.py run [INST]` |
| `out/artifact_WTICO_USD_M15_H12_up_pprofit20.json` | 15,600 | `17b72ce2f1b859efb6f610c79a804baf95b74226f40dedf946e77defc3a8ab59` | 2026-10-08T11:32:52+02:00 | `python pp20.py run [INST]` |
| `out/artifact_WTICO_USD_M15_H48_plan_pprofit20.json` | 15,584 | `7c06f39df4d76ec9c62b831eaf7d58eac8c482db0402978b5aef32158f59ef48` | 2026-10-08T11:36:50+02:00 | `python pp20.py run [INST]` |
| `out/artifact_WTICO_USD_M15_H48_up_pprofit20.json` | 15,581 | `ab0d99c836e0f80056bb9fb044e4803ec6f31bb965dfa5e8cf9d2392acdd9edb` | 2026-10-08T11:36:55+02:00 | `python pp20.py run [INST]` |
| `out/artifact_WTICO_USD_M15_pprofit20.json` | 15,716 | `e9b3dd19be025e5a5a7e856b252baf649a1ef1feb2ce04c457941e7451bee5ea` | 2026-10-08T10:39:48+02:00 | `python pp20.py run [INST]` |
| `out/artifact_WTICO_USD_M1_H12_plan_pprofit20.json` | 44,330 | `e49ca8ecb6a634b69c52eb36476665adf7ab9348423d35f9c42ced3cf21d2938` | 2026-10-08T11:29:40+02:00 | `python pp20.py run [INST]` |
| `out/artifact_WTICO_USD_M1_H12_up_pprofit20.json` | 44,162 | `a29ff4a23382632670e49d770d1a40e599cd8a51193ef87a1bb692e81d744445` | 2026-10-08T11:29:42+02:00 | `python pp20.py run [INST]` |
| `out/artifact_WTICO_USD_M1_H48_plan_pprofit20.json` | 44,368 | `74478b10fd6a560dacfd4cf5bf00bdf62e2a60689e16fd9f95871cdfc8e5cc28` | 2026-10-08T11:33:42+02:00 | `python pp20.py run [INST]` |
| `out/artifact_WTICO_USD_M1_H48_up_pprofit20.json` | 43,039 | `e1d450dd89dda53f419c89da7d4085276fa1b104e36304a6cbc17138561afa55` | 2026-10-08T11:33:48+02:00 | `python pp20.py run [INST]` |
| `out/artifact_WTICO_USD_M1_iso_pprofit20.json` | 44,198 | `4bb88e8b6c4d17b92a02104729e9f29d677612b9586c8f0f62d67c8ed9d6fd3d` | 2026-10-08T11:06:09+02:00 | `python pp20.py run [INST]` |
| `out/artifact_WTICO_USD_M1_pprofit20.json` | 40,180 | `80e25729e138ea41fbe2ae742895e9cce7c66e87a3f103580198226bdad53d81` | 2026-10-08T10:41:46+02:00 | `python pp20.py run [INST]` |
| `out/artifact_WTICO_USD_M5_H12_plan_pprofit20.json` | 15,532 | `db832589adff118274578b58c3937a591397a6d6bc647f9505c9669229441cb5` | 2026-10-08T11:28:37+02:00 | `python pp20.py run [INST]` |
| `out/artifact_WTICO_USD_M5_H12_up_pprofit20.json` | 15,411 | `2c57b088cc0f7a9e04b161959cf0948831b4f1e3a7e46e02554ba1d1807fd919` | 2026-10-08T11:28:36+02:00 | `python pp20.py run [INST]` |
| `out/artifact_WTICO_USD_M5_H48_plan_pprofit20.json` | 15,377 | `cea9cd3dc7f3dd7f68acf35c41ed1cd5ef9a1e65ab364ebe7f7cf5db44f6fabd` | 2026-10-08T11:28:38+02:00 | `python pp20.py run [INST]` |
| `out/artifact_WTICO_USD_M5_H48_up_pprofit20.json` | 15,562 | `869cc5a00406f5006b52e02409ac041056f64d3d3a9f6794072441ed559950f8` | 2026-10-08T11:28:38+02:00 | `python pp20.py run [INST]` |
| `out/artifact_WTICO_USD_pprofit20.json` | 15,512 | `c8b5d6f731174f071a1cbee3c6987969b622a6f15322e9d7017eced1f0831d85` | 2026-10-08T10:39:47+02:00 | `python pp20.py run [INST]` |
| `out/artifact_XAG_USD_M15_H48_plan_pprofit20.json` | 15,552 | `d8db553330312d9c6ef0740b84cb842938a564d5264a9febe3dcb7fe91b02a06` | 2026-10-08T11:38:04+02:00 | `python pp20.py run [INST]` |
| `out/artifact_XAG_USD_M15_pprofit20.json` | 15,677 | `f84583a51d1bb055ee77515585ebe52889fd7b4937b9f54aca98617cc73761f7` | 2026-10-08T10:39:55+02:00 | `python pp20.py run [INST]` |
| `out/artifact_XAG_USD_M1_H12_plan_pprofit20.json` | 45,046 | `e1c6cf509bd1f37abee528e5b527ac43390e815297c75ac0bfb5beb6a1a5a217` | 2026-10-08T11:32:53+02:00 | `python pp20.py run [INST]` |
| `out/artifact_XAG_USD_M1_H48_plan_pprofit20.json` | 43,357 | `7661242bfde92f48f723050ef1fd20bc71f6e65f5631f0763bef1a1bc228ad33` | 2026-10-08T11:36:58+02:00 | `python pp20.py run [INST]` |
| `out/artifact_XAG_USD_M1_iso_pprofit20.json` | 43,682 | `a274958675670e2cb48cf3b6e39abc00805a208f9fa4432ed34db43248cb3170` | 2026-10-08T11:07:30+02:00 | `python pp20.py run [INST]` |
| `out/artifact_XAG_USD_M5_H12_up_pprofit20.json` | 15,569 | `953941979584c06be9581fe481f134a4f691dcfc56939d33b9966412ea03c468` | 2026-10-08T11:29:50+02:00 | `python pp20.py run [INST]` |
| `out/artifact_XAU_USD_M1_H12_plan_pprofit20.json` | 44,326 | `bfc7d60039e9bc7620ba541c0bc7138c0dae6782927d2e4628188a4cfd2d7b16` | 2026-10-08T11:31:23+02:00 | `python pp20.py run [INST]` |
| `out/artifact_XAU_USD_M1_H12_up_pprofit20.json` | 43,200 | `b39c3f82eeac820723b3d55363cc45257721c5d67df511ba2d6ce082651886ba` | 2026-10-08T11:31:35+02:00 | `python pp20.py run [INST]` |
| `out/artifact_XAU_USD_M1_H48_plan_pprofit20.json` | 43,460 | `c5c4942ed27ebeeca2e574259c9d6a17f5fa1297ee9139aeaa4564d7f080d6ce` | 2026-10-08T11:35:27+02:00 | `python pp20.py run [INST]` |
| `out/artifact_XAU_USD_M1_H48_up_pprofit20.json` | 42,257 | `6512a92a15a37a66e667f1d77d0e5296e2c5473c71fcd093a559934486f765fb` | 2026-10-08T11:35:35+02:00 | `python pp20.py run [INST]` |
| `out/artifact_XAU_USD_M1_iso_pprofit20.json` | 42,836 | `901711dce9c042017f52c54c44c7a0f86bc5d58b1fe000b497bd8d95a75d8c8b` | 2026-10-08T11:06:08+02:00 | `python pp20.py run [INST]` |
| `out/artifact_XAU_USD_M1_pprofit20.json` | 40,142 | `c8b6687b7cfa34163f74763d6d920cf0e5e3ed3dba417c2e26ab95f7928accfd` | 2026-10-08T10:41:44+02:00 | `python pp20.py run [INST]` |
| `out/artifact_XAU_USD_M5_H12_plan_pprofit20.json` | 15,338 | `2157c82d9352184792ad0180dd5a9b4c659deb717c34b06f548ec80e8c204063` | 2026-10-08T11:29:20+02:00 | `python pp20.py run [INST]` |
| `out/artifact_XAU_USD_M5_H48_plan_pprofit20.json` | 15,521 | `087864a4db834cd5d25c263663dc19d700a0323bc1612475f0962b2c350f7fee` | 2026-10-08T11:29:21+02:00 | `python pp20.py run [INST]` |
| `out/artifact_XAU_USD_pprofit20.json` | 15,642 | `c122805579ed6daf502e18ee7f22b46dd263b6549e87541decfcb18df6779470` | 2026-10-08T10:39:55+02:00 | `python pp20.py run [INST]` |
| `out/card_rule.txt` | 17,633 | `18adf980af295c59db39bdf8e4b7484122777f0a9c5d17f0410f91509942c13b` | 2026-10-08T11:07:55+02:00 | `python pp20.py run [INST]` |
| `out/diag.json` | 2,351 | `06182cb4d3000e64bf5eca33a489dd6b13816ee48d1ec9eff21927553a7e5aa4` | 2026-10-08T09:52:04+02:00 | `python pp20.py run [INST]` |
| `out/diag_M1.json` | 2,757 | `f35fc235ad91f47917f6a2eca3edbf7b22d43c3ca28feaf16198a0ed20803fdd` | 2026-10-08T10:45:17+02:00 | `python pp20.py run [INST]` |
| `out/diag_M15.json` | 2,360 | `5c953ecf24fa718ee18d50acc62400edc30e22cf94c253e5ecc00ad98e92b2be` | 2026-10-08T09:57:14+02:00 | `python pp20.py run [INST]` |
| `out/explore.json` | 8,822 | `b7d6460ba585a2ae436224a855c44812b8d1120ba71fa09467e625389a0ea500` | 2026-10-08T09:47:50+02:00 | `python pp20.py run [INST]` |
| `out/explore_M1.json` | 9,339 | `0741dd70594f3b255cdb9c252d7270d56716ba58bd506278e1a731712cddad05` | 2026-10-08T10:39:36+02:00 | `python pp20.py run [INST]` |
| `out/parity_EUR_USD_M15_H12_plan_pprofit20.json` | 1,257,437 | `e8f9db69c7b1980de6cd7601ef123213e4b721eace402ea3b7fc0d02fc64db29` | 2026-10-08T11:36:04+02:00 | `python pp20.py run [INST]` |
| `out/parity_EUR_USD_M15_H12_up_pprofit20.json` | 1,257,621 | `87f77f91a99bf7277ebd1f8758fec2cfab244c0915e678959271e0d84443a8c1` | 2026-10-08T11:36:04+02:00 | `python pp20.py run [INST]` |
| `out/parity_EUR_USD_M15_H48_plan_pprofit20.json` | 1,257,425 | `3349eb305605157abc4986febb1d49d5e8bfeea5c29cd7ef2aedec535b2a2f74` | 2026-10-08T11:39:38+02:00 | `python pp20.py run [INST]` |
| `out/parity_EUR_USD_M15_H48_up_pprofit20.json` | 1,257,729 | `4ceb538f9c7ff838f6519fc8b62dcf04d28b3cbd463ffdd113161c8bdcae7b9b` | 2026-10-08T11:39:30+02:00 | `python pp20.py run [INST]` |
| `out/parity_EUR_USD_M15_pprofit20.json` | 1,257,448 | `f028ab2a82da69ed99b6faea57710c70ecbae56cfff2aecae30a57d11f2f370e` | 2026-10-08T09:56:46+02:00 | `python pp20.py run [INST]` |
| `out/parity_EUR_USD_M1_H12_plan_pprofit20.json` | 386,877 | `8945ea9af537c872a0d28ce8b19c9233542b770e9b4631d8e506915c60ebd2e3` | 2026-10-08T11:37:39+02:00 | `python pp20.py run [INST]` |
| `out/parity_EUR_USD_M1_H12_up_pprofit20.json` | 386,899 | `f5bfb0b4eb5177945ad80513648984b672157deb104a0660c2f4014365888994` | 2026-10-08T11:38:01+02:00 | `python pp20.py run [INST]` |
| `out/parity_EUR_USD_M1_H48_plan_pprofit20.json` | 386,902 | `4ee73e7678f8b0c775a14e32b59e21ced9fbb03192c70664ad310b2ad26f7fac` | 2026-10-08T11:40:50+02:00 | `python pp20.py run [INST]` |
| `out/parity_EUR_USD_M1_H48_up_pprofit20.json` | 386,891 | `c113085fc9dc2488a127422b576222a2abb3a6d99ad182ff83d2a5347fa590ad` | 2026-10-08T11:40:34+02:00 | `python pp20.py run [INST]` |
| `out/parity_EUR_USD_M1_iso_pprofit20.json` | 386,883 | `b0893179231a09ba70dfeb75ad5d6cf1c2169c6cda74ff98ec510346b745386a` | 2026-10-08T11:06:13+02:00 | `python pp20.py run [INST]` |
| `out/parity_EUR_USD_M1_pprofit20.json` | 386,903 | `de4a0a273218183eb6d98a0c2461aebb67fd80666bec73cab69751da4a267eed` | 2026-10-08T10:41:39+02:00 | `python pp20.py run [INST]` |
| `out/parity_EUR_USD_M5_H12_plan_pprofit20.json` | 1,257,047 | `05acd999ca6136ac5783d9fdaee0ca5989c2d56a62bde9f245cbb2ec015fc385` | 2026-10-08T11:31:51+02:00 | `python pp20.py run [INST]` |
| `out/parity_EUR_USD_M5_H12_up_pprofit20.json` | 1,257,128 | `3fff1f404b8cd39e3b5d9c46273c2755b543c86b2d85ed3aa0ba217ceae3355b` | 2026-10-08T11:31:59+02:00 | `python pp20.py run [INST]` |
| `out/parity_EUR_USD_M5_H48_plan_pprofit20.json` | 1,257,128 | `c3b9e972478c7b5f2afdab545bccfe90dfce89b62ef0c514660504bc7b17ff66` | 2026-10-08T11:32:03+02:00 | `python pp20.py run [INST]` |
| `out/parity_EUR_USD_M5_H48_up_pprofit20.json` | 1,257,249 | `516b9feae10bac84085c794b2f84dec2fb5c3df08448b830442126e37de8bdb7` | 2026-10-08T11:31:47+02:00 | `python pp20.py run [INST]` |
| `out/parity_EUR_USD_pprofit20.json` | 1,257,100 | `7deea2674ec6c11f24c8a35762df3a0800185cac3b30fbd53f3c46c67f73d440` | 2026-10-08T09:51:20+02:00 | `python pp20.py run [INST]` |
| `out/parity_WTICO_USD_M15_H12_plan_pprofit20.json` | 1,214,535 | `11fc4116a4129e0c44ad8091bd54dc15f32a8e2f5ba5e5f890b84a5877f081d2` | 2026-10-08T11:32:44+02:00 | `python pp20.py run [INST]` |
| `out/parity_WTICO_USD_M15_H12_up_pprofit20.json` | 1,214,782 | `1ca0efff0b9de6bd597d97431e857ad10906e8b79f546464ff50eb3a24f6c6c5` | 2026-10-08T11:32:48+02:00 | `python pp20.py run [INST]` |
| `out/parity_WTICO_USD_M15_H48_plan_pprofit20.json` | 1,214,544 | `5f790d67172f4ff472e38cd2f1a1a12c7fbd160e06d5ab91167a8328e3e96114` | 2026-10-08T11:36:51+02:00 | `python pp20.py run [INST]` |
| `out/parity_WTICO_USD_M15_H48_up_pprofit20.json` | 1,214,697 | `f222644f8df18a1de48fe89aa1724e2925d268c43077211706a1dc13b8568f60` | 2026-10-08T11:36:50+02:00 | `python pp20.py run [INST]` |
| `out/parity_WTICO_USD_M15_pprofit20.json` | 1,214,557 | `f18028e17374cd67126fd98f5a001a58f637266f9be6981d3482be0932ad8bd4` | 2026-10-08T09:54:42+02:00 | `python pp20.py run [INST]` |
| `out/parity_WTICO_USD_M1_H12_plan_pprofit20.json` | 372,043 | `3750b2cdc991f4c7e09a2027bb93978724dc40bba855fce148855b7fab760765` | 2026-10-08T11:29:28+02:00 | `python pp20.py run [INST]` |
| `out/parity_WTICO_USD_M1_H12_up_pprofit20.json` | 372,103 | `36ede3c50ebf175422bb3dfef28e9054b6c9c6966f547630e31a16dce60dd610` | 2026-10-08T11:29:42+02:00 | `python pp20.py run [INST]` |
| `out/parity_WTICO_USD_M1_H48_plan_pprofit20.json` | 372,035 | `07b4e9d960fbfaf45123d953a008c6e46ca9f7f67d60b73bfaad16d587db7f0e` | 2026-10-08T11:33:42+02:00 | `python pp20.py run [INST]` |
| `out/parity_WTICO_USD_M1_H48_up_pprofit20.json` | 372,119 | `48fc4a81047e3f4a6e90e9b15dbe4048476895abad6644c1dacdbb515a23ceaf` | 2026-10-08T11:33:48+02:00 | `python pp20.py run [INST]` |
| `out/parity_WTICO_USD_M1_iso_pprofit20.json` | 372,044 | `cdebc9563c5805aaaff72724752630a9560fe14ba2e5c66780313d6b2e7e3388` | 2026-10-08T11:06:09+02:00 | `python pp20.py run [INST]` |
| `out/parity_WTICO_USD_M1_pprofit20.json` | 372,047 | `eb22e1941f85cacc0bc9fbd9acea9e1fae7bf9a28f199c8055af6ddc3a15e53a` | 2026-10-08T10:41:36+02:00 | `python pp20.py run [INST]` |
| `out/parity_WTICO_USD_M5_H12_plan_pprofit20.json` | 1,222,977 | `8dc6c6eb9bfdf4ea764bf108adec6f47eb2540792e6353c861e34573a87877ca` | 2026-10-08T11:28:37+02:00 | `python pp20.py run [INST]` |
| `out/parity_WTICO_USD_M5_H12_up_pprofit20.json` | 1,223,233 | `e4dacb83938a923c5d816805960f1b78376add7919ba7a8cd99739487601876b` | 2026-10-08T11:28:36+02:00 | `python pp20.py run [INST]` |
| `out/parity_WTICO_USD_M5_H48_plan_pprofit20.json` | 1,223,040 | `5f408aeffd0f8ad1be8aabb04cf18a15b809d248af355fb27ea36834b88a1ed3` | 2026-10-08T11:28:38+02:00 | `python pp20.py run [INST]` |
| `out/parity_WTICO_USD_M5_H48_up_pprofit20.json` | 1,223,222 | `cc59ae71440aad4cf63ddedc178c85d470b4a27fd3592dc690c9c4ce006dec98` | 2026-10-08T11:28:34+02:00 | `python pp20.py run [INST]` |
| `out/parity_WTICO_USD_pprofit20.json` | 1,222,975 | `fee48e5a5f8d2d0276a25fe0bd39b83d009728672a690364ea29a56f0bc21ae0` | 2026-10-08T09:54:00+02:00 | `python pp20.py run [INST]` |
| `out/report.txt` | 61,502 | `e0a0f45f89c61e8bc456855869b5c77d4ed595371b220b69e483afc36c6aee8e` | 2026-10-08T09:57:14+02:00 | `python pp20.py run [INST]` |
| `out/report_M1.txt` | 60,691 | `568efd1936d3ad59c07b59b78a601c61d75d82924d9ae04525d3a9d3582e472e` | 2026-10-08T10:45:17+02:00 | `python pp20.py run [INST]` |
| `out/report_M15.txt` | 62,326 | `087d5a6b14e846cedb5bd3340f880d89670294f59e17330e30f9f428a8a3a365` | 2026-10-08T09:57:14+02:00 | `python pp20.py run [INST]` |
| `out/report_horizons.txt` | 40,837 | `03cfc4d9a4094390b889da0e4fecc1992b2172d324e86e03128abad1932665b1` | 2026-10-08T11:41:07+02:00 | `python pp20.py run [INST]` |
| `out/results_EUR_USD.json` | 44,367 | `364b6af0527c276dd9d623295490a0d48860b04765a05d94d77f5e6aed4f2fac` | 2026-10-08T09:51:20+02:00 | `python pp20.py run [INST]` |
| `out/results_EUR_USD_M1.json` | 43,734 | `a8287c1768fd331e2f1bbe1aa709710f5fe1c95b8609db1b15c7524889b7797d` | 2026-10-08T10:41:49+02:00 | `python pp20.py run [INST]` |
| `out/results_EUR_USD_M15.json` | 45,288 | `fb688fdef166651eeac02ce30427e60597847f53896a2b4e17b6d39f35ed260b` | 2026-10-08T09:56:46+02:00 | `python pp20.py run [INST]` |
| `out/results_EUR_USD_M15_H12_plan.json` | 45,488 | `3dca54f5aadd54101055e7fa48e55331f60855179e8304dcea8e66b3aff21993` | 2026-10-08T11:36:09+02:00 | `python pp20.py run [INST]` |
| `out/results_EUR_USD_M15_H12_up.json` | 45,415 | `037c95677ad24903dba21c2c43c568b9cd82a8579d7f6fd91708e700f25cb4d0` | 2026-10-08T11:36:04+02:00 | `python pp20.py run [INST]` |
| `out/results_EUR_USD_M15_H48_plan.json` | 45,496 | `f7e86c807eb563d13c20cdf943a63567db3930501919fab3725cbe5e7e712b6a` | 2026-10-08T11:39:38+02:00 | `python pp20.py run [INST]` |
| `out/results_EUR_USD_M15_H48_up.json` | 45,345 | `5d0b272215e803966a8de5d36eb718aad2adceb920416b086399d00931ab7781` | 2026-10-08T11:39:33+02:00 | `python pp20.py run [INST]` |
| `out/results_EUR_USD_M1_H12_plan.json` | 40,273 | `5082fa24b39a365d1c501fa6e8a56d9d8c5d8e491e2146dc48c3b37f9fc8a042` | 2026-10-08T11:37:39+02:00 | `python pp20.py run [INST]` |
| `out/results_EUR_USD_M1_H12_up.json` | 42,180 | `7c1129e615dae43357e39c9a8e1e237dc96600547f9bdbe7fd83d81969b9eb06` | 2026-10-08T11:38:01+02:00 | `python pp20.py run [INST]` |
| `out/results_EUR_USD_M1_H48_plan.json` | 40,306 | `8698e4560f36208340ea1597ff0989383849885e0fefbca298015d30498c60db` | 2026-10-08T11:40:50+02:00 | `python pp20.py run [INST]` |
| `out/results_EUR_USD_M1_H48_up.json` | 42,074 | `2880f54c6b7677d317ae802550cc276ebffde4afc4e13f9b71d72472998ec922` | 2026-10-08T11:40:43+02:00 | `python pp20.py run [INST]` |
| `out/results_EUR_USD_M1_iso.json` | 40,147 | `7e9b4e1b7925a3bd6bfa2918ac2e099ccef67b2e4d2bf15d7f7dbdb95d50aebb` | 2026-10-08T11:06:13+02:00 | `python pp20.py run [INST]` |
| `out/results_EUR_USD_M5_H12_plan.json` | 44,446 | `dfd24d15628e760d33d0c64b04107e9b26384b0cae310860f68f857683fcd148` | 2026-10-08T11:31:55+02:00 | `python pp20.py run [INST]` |
| `out/results_EUR_USD_M5_H12_up.json` | 44,317 | `adb6c0c8e22c3b5d24c03627cc29655245469c3d9859d8f8646af12e370f74d6` | 2026-10-08T11:31:59+02:00 | `python pp20.py run [INST]` |
| `out/results_EUR_USD_M5_H48_plan.json` | 44,529 | `79a7aaa12699060c3c2a2532d4b1315b4002a15281c9aa4116dea5766ce78b27` | 2026-10-08T11:32:03+02:00 | `python pp20.py run [INST]` |
| `out/results_EUR_USD_M5_H48_up.json` | 44,325 | `4947b192e0aedb42a29d759f6000445508f83bcf988962c29e7dc2612174d505` | 2026-10-08T11:31:47+02:00 | `python pp20.py run [INST]` |
| `out/results_NATGAS_USD.json` | 43,969 | `ff67ae04086d4efe7075786996204b5f6e00eb874d702e86bd41db8ceaf7d236` | 2026-10-08T09:50:20+02:00 | `python pp20.py run [INST]` |
| `out/results_NATGAS_USD_M1.json` | 42,499 | `45d0b522ca9ffae8bea4d1ebfd68c3fe7cfddf46988ce202506bee769ea4d47a` | 2026-10-08T10:42:49+02:00 | `python pp20.py run [INST]` |
| `out/results_NATGAS_USD_M15.json` | 45,221 | `4b946b62b2033847efbf676850a0a3cff8eb8b1b69851cc5661731716a08638f` | 2026-10-08T09:55:56+02:00 | `python pp20.py run [INST]` |
| `out/results_NATGAS_USD_M15_H12_plan.json` | 45,409 | `7fd5e76614a581249b1c24294bf6d369dfa27af0cfaa04c06fc9c2238b7bde8f` | 2026-10-08T11:34:45+02:00 | `python pp20.py run [INST]` |
| `out/results_NATGAS_USD_M15_H12_up.json` | 45,182 | `e0cca58516f4d0d861f90bb667af836066a03b5d87ae2651fa007255ab342831` | 2026-10-08T11:34:45+02:00 | `python pp20.py run [INST]` |
| `out/results_NATGAS_USD_M15_H48_plan.json` | 45,420 | `1adcaa39c831df811c49615906178dd670fd3cdae94aa783c6d12aca1e6963b6` | 2026-10-08T11:38:34+02:00 | `python pp20.py run [INST]` |
| `out/results_NATGAS_USD_M15_H48_up.json` | 45,106 | `0d20eb6a88d912e4ce738e6dd31e4e3454f74d78c333b153335662b69b60b36a` | 2026-10-08T11:38:30+02:00 | `python pp20.py run [INST]` |
| `out/results_NATGAS_USD_M1_H12_plan.json` | 36,221 | `f08ea0c9938a3d16cdf13fbec89c3ad69f44a77bcaf2c5f4745f24fabaf13bb3` | 2026-10-08T11:34:00+02:00 | `python pp20.py run [INST]` |
| `out/results_NATGAS_USD_M1_H12_up.json` | 41,397 | `4f085f6dc67095985f497dedd2673ad2769624c61b147b095b6d2c32bdac57d4` | 2026-10-08T11:34:25+02:00 | `python pp20.py run [INST]` |
| `out/results_NATGAS_USD_M1_H48_plan.json` | 35,953 | `df4f9e83a1c0772b8445638d4eb350632e784677486bc7a79e0932b8722f224d` | 2026-10-08T11:38:03+02:00 | `python pp20.py run [INST]` |
| `out/results_NATGAS_USD_M1_H48_up.json` | 41,329 | `e5c5fe5fc54f8fa2a8381d2b18b71f8c3608caf75bad33e3493c58b107c33737` | 2026-10-08T11:38:09+02:00 | `python pp20.py run [INST]` |
| `out/results_NATGAS_USD_M1_iso.json` | 35,784 | `fb3d1573cf2a3898feae15023250a0a54900ddbb2c9d330a2a3e2dd9146d2107` | 2026-10-08T11:07:15+02:00 | `python pp20.py run [INST]` |
| `out/results_NATGAS_USD_M5_H12_plan.json` | 43,988 | `69791668ea589b6ea48802277225c87e5d9048e881498b4da88c3c8fdee35ad8` | 2026-10-08T11:30:31+02:00 | `python pp20.py run [INST]` |
| `out/results_NATGAS_USD_M5_H12_up.json` | 44,192 | `f7a466810cd6349e6f08cf0bd91ccac77bab29e668f210d970a6947e4d3b7f3a` | 2026-10-08T11:30:33+02:00 | `python pp20.py run [INST]` |
| `out/results_NATGAS_USD_M5_H48_plan.json` | 44,133 | `1d0558d23c8965b2b88f326f08b6ae75b09fc2f2b4a9fbbad70fcc16535cd5b6` | 2026-10-08T11:30:32+02:00 | `python pp20.py run [INST]` |
| `out/results_NATGAS_USD_M5_H48_up.json` | 44,086 | `6387e97512e1e8808939263378e88ee7acf880739a0ba8433dd494fdffb08582` | 2026-10-08T11:30:26+02:00 | `python pp20.py run [INST]` |
| `out/results_SPX500_USD.json` | 45,408 | `bcd8ab2922c15bd61f1085e60e2d20cee5e93d126d4ea51c13fdd4d06c485176` | 2026-10-08T09:50:49+02:00 | `python pp20.py run [INST]` |
| `out/results_SPX500_USD_M1.json` | 45,492 | `6787b86978d4517eafa33960de8770f2c60f4d41f826b3c99a6775e8b45bcb7a` | 2026-10-08T10:43:06+02:00 | `python pp20.py run [INST]` |
| `out/results_SPX500_USD_M15.json` | 44,840 | `61bfedde0956261a3319c5cf22831e722b6e0d0795993c0c18e30c20bf2388fb` | 2026-10-08T09:56:20+02:00 | `python pp20.py run [INST]` |
| `out/results_SPX500_USD_M15_H12_plan.json` | 44,969 | `b13b058ffbf939cac9e61ec236675f163c2ee834b7f0da4cc2e4f809431ff8ba` | 2026-10-08T11:35:25+02:00 | `python pp20.py run [INST]` |
| `out/results_SPX500_USD_M15_H12_up.json` | 44,839 | `b90c837003826721cb4399493334bb8c02490be8742906283cf7096bd4b4f96d` | 2026-10-08T11:35:24+02:00 | `python pp20.py run [INST]` |
| `out/results_SPX500_USD_M15_H48_plan.json` | 45,072 | `689218ba55dd018682b91ca5ea9bc0d853a8a7953bc940c53c96eea05c03927a` | 2026-10-08T11:39:07+02:00 | `python pp20.py run [INST]` |
| `out/results_SPX500_USD_M15_H48_up.json` | 44,681 | `03c06c6e5dd2390766d03aec5d5442f2fa87bfd8bdb47309341c0f8bb93a3863` | 2026-10-08T11:39:03+02:00 | `python pp20.py run [INST]` |
| `out/results_SPX500_USD_M1_H12_plan.json` | 43,688 | `b2face4694dcc0afd12833693ed5661e636176c83da71f8b66d3255cdc38adb6` | 2026-10-08T11:35:46+02:00 | `python pp20.py run [INST]` |
| `out/results_SPX500_USD_M1_H12_up.json` | 43,670 | `aa0fa4900f1e64776e901a2ac2380728c6771f6d28591e78e107b68e4ae7c2ea` | 2026-10-08T11:36:10+02:00 | `python pp20.py run [INST]` |
| `out/results_SPX500_USD_M1_H48_plan.json` | 43,787 | `190791e4b1011a0889854cfedcd167fdf0f45fe25c3d1d1b134d2cbd5e449260` | 2026-10-08T11:39:31+02:00 | `python pp20.py run [INST]` |
| `out/results_SPX500_USD_M1_H48_up.json` | 43,679 | `d0cd68c97cb96dbd8761fc61e7de1c70533694baf245f208cf08c2e4f8af1150` | 2026-10-08T11:39:24+02:00 | `python pp20.py run [INST]` |
| `out/results_SPX500_USD_M1_iso.json` | 43,640 | `23188a36d7cc1f857b2f8906312670d90ef26ec571824363a54610081df0ece5` | 2026-10-08T11:07:39+02:00 | `python pp20.py run [INST]` |
| `out/results_SPX500_USD_M5_H12_plan.json` | 45,503 | `040491ca27bca77c3ca46334306013e3d3f05cd1cda7d269e98ec50e6b09663a` | 2026-10-08T11:31:12+02:00 | `python pp20.py run [INST]` |
| `out/results_SPX500_USD_M5_H12_up.json` | 45,412 | `88112e95b075fe4bf61e29aa8cfa9b19d064e39cdcb710d0be55727aad654665` | 2026-10-08T11:31:16+02:00 | `python pp20.py run [INST]` |
| `out/results_SPX500_USD_M5_H48_plan.json` | 45,586 | `6247f3ecbfc0a7f1a92d726888947376b0e1c63e2370147e5ed9d74dd1bc233e` | 2026-10-08T11:31:17+02:00 | `python pp20.py run [INST]` |
| `out/results_SPX500_USD_M5_H48_up.json` | 45,249 | `0123a45989e99f297e20e3faca635395e63791e400a3ccc66149886f389757be` | 2026-10-08T11:31:05+02:00 | `python pp20.py run [INST]` |
| `out/results_WTICO_USD.json` | 45,441 | `7349e58db7b6173159e4f294582901039a529909715d1cf3843b804a4e94c5d6` | 2026-10-08T09:54:00+02:00 | `python pp20.py run [INST]` |
| `out/results_WTICO_USD.registered_run.json` | 45,441 | `7349e58db7b6173159e4f294582901039a529909715d1cf3843b804a4e94c5d6` | 2026-10-08T09:53:03+02:00 | `python pp20.py run [INST]` |
| `out/results_WTICO_USD_M1.json` | 45,538 | `d5805f961ee56f970163d297561d97fd2e0b9391b0b5010deda362757e165ca1` | 2026-10-08T10:41:46+02:00 | `python pp20.py run [INST]` |
| `out/results_WTICO_USD_M15.json` | 45,427 | `d075a111bf3e11550a1bf506c4afcc0dbd3fa3bb590344d9eb20d2a3cbc54c01` | 2026-10-08T09:54:42+02:00 | `python pp20.py run [INST]` |
| `out/results_WTICO_USD_M15_H12_plan.json` | 45,511 | `2c4cd1714ae7a0fb5ded3ff849ba2815472c15e856690f45598abf521d078ce4` | 2026-10-08T11:32:49+02:00 | `python pp20.py run [INST]` |
| `out/results_WTICO_USD_M15_H12_up.json` | 45,450 | `ae78d4bcc9abc1a47bdb4a03683f8a79f2a2f5c0f34d2d0714e1a9717c7a7fa8` | 2026-10-08T11:32:52+02:00 | `python pp20.py run [INST]` |
| `out/results_WTICO_USD_M15_H48_plan.json` | 45,556 | `974f03172a68084b59d484934700957d985a52e62e29f09ba13f8094f01756fe` | 2026-10-08T11:36:51+02:00 | `python pp20.py run [INST]` |
| `out/results_WTICO_USD_M15_H48_up.json` | 45,285 | `e4ad073e08c57da19d05a9c4645c4b88915439adbfcad2a0a5d180cd1d17cc65` | 2026-10-08T11:36:55+02:00 | `python pp20.py run [INST]` |
| `out/results_WTICO_USD_M1_H12_plan.json` | 43,180 | `a4af042c63ba89a9f67def2e3a0a897837ec10da616e9d201be153b871c09e82` | 2026-10-08T11:29:40+02:00 | `python pp20.py run [INST]` |
| `out/results_WTICO_USD_M1_H12_up.json` | 43,660 | `3fe415638adbec7ac1949564e3efd1bb9e99e9c454020629b45a68f431adea2d` | 2026-10-08T11:29:42+02:00 | `python pp20.py run [INST]` |
| `out/results_WTICO_USD_M1_H48_plan.json` | 42,926 | `12b49e098c20642534cc39b558f0700e150559e2bf1b87be7af0316af4054028` | 2026-10-08T11:33:42+02:00 | `python pp20.py run [INST]` |
| `out/results_WTICO_USD_M1_H48_up.json` | 43,583 | `fa888309aea4b008cf6c6e9626db303669b9129fc78916b5239692c663dc20de` | 2026-10-08T11:33:48+02:00 | `python pp20.py run [INST]` |
| `out/results_WTICO_USD_M1_iso.json` | 42,763 | `c1fda1f9e1e4d7ab1f108144bee4f10164d5fe14987305e56923bab04e6663c8` | 2026-10-08T11:06:09+02:00 | `python pp20.py run [INST]` |
| `out/results_WTICO_USD_M5_H12_plan.json` | 45,532 | `d1c4f21f8fe98080ba7140a2c2e3d876feda617afea902fe68fbb58c76040176` | 2026-10-08T11:28:37+02:00 | `python pp20.py run [INST]` |
| `out/results_WTICO_USD_M5_H12_up.json` | 45,462 | `9660fefba42ccd238f223b67ea8d933c8a2423ea774c4ef7176995dac8d88be0` | 2026-10-08T11:28:37+02:00 | `python pp20.py run [INST]` |
| `out/results_WTICO_USD_M5_H48_plan.json` | 45,602 | `624d33d65dccd3bae866c4e94ab066299a87504816f0d27831c16f7a3f9620f5` | 2026-10-08T11:28:38+02:00 | `python pp20.py run [INST]` |
| `out/results_WTICO_USD_M5_H48_up.json` | 45,369 | `933c0ecd61aa8d55d7c101bafd15366de24a59e993148ddc4fa1a37e5b64b5ed` | 2026-10-08T11:28:38+02:00 | `python pp20.py run [INST]` |
| `out/results_XAG_USD.json` | 44,897 | `2a0344477eebc5f2ab60cc8e28400faa751d31c2cbac0a3dc295a0eab6e90e58` | 2026-10-08T09:49:53+02:00 | `python pp20.py run [INST]` |
| `out/results_XAG_USD_M1.json` | 43,569 | `9c61747b77bc91d0434413f4b96e8147911b6ca3e36ba990c81d254aa5713ab0` | 2026-10-08T10:42:57+02:00 | `python pp20.py run [INST]` |
| `out/results_XAG_USD_M15.json` | 44,874 | `1612c63cfde2404ec34b750cba14d65dd9f0eb0da6643eefac214cd004b53093` | 2026-10-08T09:55:32+02:00 | `python pp20.py run [INST]` |
| `out/results_XAG_USD_M15_H12_plan.json` | 44,989 | `d3d9af15239556e9180074ee8b5e247cb75f1395c164c0ffa0c3348e8187fd20` | 2026-10-08T11:34:04+02:00 | `python pp20.py run [INST]` |
| `out/results_XAG_USD_M15_H12_up.json` | 44,872 | `80b605ff05dd37e22784aeb89502e9e406d3ff2db7b1cb813162f9a38ae38a2d` | 2026-10-08T11:34:05+02:00 | `python pp20.py run [INST]` |
| `out/results_XAG_USD_M15_H48_plan.json` | 45,063 | `88e3dd7751c74a4dbe7cbbc95a2a19d05aeb278a36463aa6764640e2109abf96` | 2026-10-08T11:38:04+02:00 | `python pp20.py run [INST]` |
| `out/results_XAG_USD_M15_H48_up.json` | 44,797 | `8d10dcc681ac64d88d8725de6fb9f92e3cf733d27af534dbba3e0ec5cd427895` | 2026-10-08T11:38:03+02:00 | `python pp20.py run [INST]` |
| `out/results_XAG_USD_M1_H12_plan.json` | 39,330 | `e5cf69d0ad0f0ffa05a5ee6eae53bbee20e8cedfc990acd3db1d1cf523d3a881` | 2026-10-08T11:32:53+02:00 | `python pp20.py run [INST]` |
| `out/results_XAG_USD_M1_H12_up.json` | 42,052 | `e08afd2c7db9064e461ba6c0778b82706a250cde463cae8c0175593202c2c1d6` | 2026-10-08T11:33:07+02:00 | `python pp20.py run [INST]` |
| `out/results_XAG_USD_M1_H48_plan.json` | 39,159 | `226aea339cdea2e256734d028e00f9d27121f2587714986d7d772619e268acc8` | 2026-10-08T11:36:58+02:00 | `python pp20.py run [INST]` |
| `out/results_XAG_USD_M1_H48_up.json` | 42,100 | `dc40355d50f684a98695a04bfe9d9e082f18529b32f6d156d58d03a988db4f8a` | 2026-10-08T11:37:06+02:00 | `python pp20.py run [INST]` |
| `out/results_XAG_USD_M1_iso.json` | 39,080 | `ebf29e69fbd45254e47230ab88a8876e706a7f8237f2287edf9ed6efdbb47132` | 2026-10-08T11:07:30+02:00 | `python pp20.py run [INST]` |
| `out/results_XAG_USD_M5_H12_plan.json` | 45,005 | `f111bea1e311c988221072193e62117351888d6b78918c6c12c6a335917a6f82` | 2026-10-08T11:29:53+02:00 | `python pp20.py run [INST]` |
| `out/results_XAG_USD_M5_H12_up.json` | 44,865 | `715a3315be8e10189393aab096d150785513d75b70d91141e687747e665fca9c` | 2026-10-08T11:29:50+02:00 | `python pp20.py run [INST]` |
| `out/results_XAG_USD_M5_H48_plan.json` | 45,015 | `fda127bd13466d2dbd02f5da5934fa51d0884d3c65d611feb26c6dbd99c3d318` | 2026-10-08T11:29:55+02:00 | `python pp20.py run [INST]` |
| `out/results_XAG_USD_M5_H48_up.json` | 44,793 | `45f4d042336f1611b6e23aa0239a264f5a9a4fc04f983988ca5b384bbe91aa03` | 2026-10-08T11:29:48+02:00 | `python pp20.py run [INST]` |
| `out/results_XAU_USD.json` | 45,395 | `938be82ee7e944300817aa2913562913599a5d0f9e5601d44672d24b83de5507` | 2026-10-08T09:49:26+02:00 | `python pp20.py run [INST]` |
| `out/results_XAU_USD_M1.json` | 45,034 | `7deca12ff46fb5b7a558d867fb13a165b178eef63603fb8f18fe858699676c62` | 2026-10-08T10:41:44+02:00 | `python pp20.py run [INST]` |
| `out/results_XAU_USD_M15.json` | 45,368 | `c4ed3fcf8775ff15c1705692f3060faaac727fdefe32c75c20f45c960ff7d3f9` | 2026-10-08T09:55:08+02:00 | `python pp20.py run [INST]` |
| `out/results_XAU_USD_M15_H12_plan.json` | 45,458 | `e008de9e608003b1295a51bafc365ca4076b0b2aa09688dd2468a526dde5fdfe` | 2026-10-08T11:33:27+02:00 | `python pp20.py run [INST]` |
| `out/results_XAU_USD_M15_H12_up.json` | 45,437 | `74a9ca81daf54cd55a095119bcfdc0f5d24a13672b79f2f129c20c68ad782cf1` | 2026-10-08T11:33:29+02:00 | `python pp20.py run [INST]` |
| `out/results_XAU_USD_M15_H48_plan.json` | 45,562 | `101a5e513134167a162ac496dd63e9e0fb6b785f32955f826c0f21fdd9cc7a06` | 2026-10-08T11:37:27+02:00 | `python pp20.py run [INST]` |
| `out/results_XAU_USD_M15_H48_up.json` | 45,268 | `ebd20a47f487297b365a1209d390066c77cc11c41a9e82faf39a3521d1d33310` | 2026-10-08T11:37:31+02:00 | `python pp20.py run [INST]` |
| `out/results_XAU_USD_M1_H12_plan.json` | 43,211 | `3636c8baa300ca06061247c5c85587b1dc5bddf0d7ff14fdb1928cfce83341c5` | 2026-10-08T11:31:23+02:00 | `python pp20.py run [INST]` |
| `out/results_XAU_USD_M1_H12_up.json` | 43,241 | `fc61c82ff5d13645e18cea60b4f21cb7a7bd9a10ffff9579c33cd2fb3cef2bb9` | 2026-10-08T11:31:35+02:00 | `python pp20.py run [INST]` |
| `out/results_XAU_USD_M1_H48_plan.json` | 43,203 | `635b23f6b1843ead2cafbcd1aa822403ec48d7d15535dfc23aef33f487eca644` | 2026-10-08T11:35:27+02:00 | `python pp20.py run [INST]` |
| `out/results_XAU_USD_M1_H48_up.json` | 43,120 | `63195788e187032ec2ef22d883a75bbf7c85431e9405df6101f7b0bfe2adc4b2` | 2026-10-08T11:35:35+02:00 | `python pp20.py run [INST]` |
| `out/results_XAU_USD_M1_iso.json` | 43,033 | `38cbdd1fd32e4ccbe4c48b2624e9aab9549e40dae3fed97fd6c83497bcd84d59` | 2026-10-08T11:06:08+02:00 | `python pp20.py run [INST]` |
| `out/results_XAU_USD_M5_H12_plan.json` | 45,501 | `009237c1175ffee87ede1b73a7985536aab0600aa83e7d212ccb284c63628658` | 2026-10-08T11:29:20+02:00 | `python pp20.py run [INST]` |
| `out/results_XAU_USD_M5_H12_up.json` | 45,466 | `a08377bd6b1114840702afa6d4524830accefa2d7329dbeff7992152f8286695` | 2026-10-08T11:29:15+02:00 | `python pp20.py run [INST]` |
| `out/results_XAU_USD_M5_H48_plan.json` | 45,552 | `bbd68a47d4dd1a9b8354ae5f1fcc3de97dbd893b682269825aa1a10e67a5e113` | 2026-10-08T11:29:21+02:00 | `python pp20.py run [INST]` |
| `out/results_XAU_USD_M5_H48_up.json` | 45,349 | `c8e1f4024740c68f3b589aafc49b8214222a08e5c436e09afe1823ad051bfde7` | 2026-10-08T11:29:16+02:00 | `python pp20.py run [INST]` |

## rescan26

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/rescan26/` (repository path `data/research/engine/audit/rescan26/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T15:32:25+02:00 to 2026-10-08T15:40:34+02:00 (file modification times).
- Scripts in the registry: `log_trials.py`, `probe.py`, `stats.py`, `x_recompute.py`, `x_stored.py`.
- Documented commands: `python x_recompute.py pairs16 | mw6 | xvol9 | xvol10 | lean21 | wave23 | nt12 | dev2`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `comment.md` | 4,149 | `00c1839d70b4025a08c9c9454c6480b2861a45b592f451a4a751ee858f6158e6` | 2026-10-08T15:40:34+02:00 | not documented in the script usage |
| `out/report.txt` | 71,966 | `8085f8f0edd267873b288ce55259bf3be04d012a116ab20fd3ca1009289f9342` | 2026-10-08T15:40:00+02:00 | not documented in the script usage |
| `out/report_mw6_b20.txt` | 9,397 | `ddabfd8efe86d6f31c0820b5980097e138b94ed49f4733e03ece0ce712691ff6` | 2026-10-08T15:38:14+02:00 | not documented in the script usage |
| `out/report_orb15.txt` | 7,419 | `60402dfdc4e0afe7c1d00d1bd0f884294528b8d1a4b007bca3af3aca7f0eadba` | 2026-10-08T15:32:56+02:00 | not documented in the script usage |
| `out/results.json` | 488,401 | `616a6731137d5883cbb351cfe4a8cfb5e5e7f50a0fe31eea124b66c694cc80c7` | 2026-10-08T15:39:49+02:00 | not documented in the script usage |
| `out/results_mw6_b20.json` | 50,853 | `f0384300d464e8e6689b8e3763fd3dacb92b3795a129e71644bc2d110c044c70` | 2026-10-08T15:38:14+02:00 | not documented in the script usage |
| `out/results_orb15.json` | 40,816 | `2b99401fbcfafd75e1286cb4ca4de18523e9f7afcbf584aef90d67f5fe550349` | 2026-10-08T15:32:56+02:00 | not documented in the script usage |
| `out/tr_daytype14.pkl` | 562,321 | `a42d54f6088ae5babcb1d354ee4bac2321b42f5eef3b1fe829addba0bdaec334` | 2026-10-08T15:32:25+02:00 | not documented in the script usage |
| `out/tr_dev2.pkl` | 1,037,072 | `3b497b99dff6c57c153ae63ec9ac0610c3120dd6c6a4a51b1b562dc41136118a` | 2026-10-08T15:36:38+02:00 | not documented in the script usage |
| `out/tr_lean21.pkl` | 28,725,980 | `61921f308b2ea3e48b5a2449d004b009cc35673b7f79dec04b3acee8db2c2aea` | 2026-10-08T15:35:35+02:00 | not documented in the script usage |
| `out/tr_mw6.pkl` | 1,540,391 | `ad289a1105f15c93a186d1316bdab7f935b81cf72cbb8a64dfb9acf8646a3ba1` | 2026-10-08T15:35:23+02:00 | not documented in the script usage |
| `out/tr_nt12.pkl` | 9,273,368 | `3ec38f3a499c6ebfc96088550035ccef27bc82248812364730bedc914f940ab4` | 2026-10-08T15:36:06+02:00 | not documented in the script usage |
| `out/tr_orb15.pkl` | 1,696,609 | `bfb9bd7e0775ab59fd1570523795deccbcf72a16be7fee47def0a056555a65e4` | 2026-10-08T15:32:25+02:00 | not documented in the script usage |
| `out/tr_pairs16.pkl` | 191,326 | `734ba53baff9a58c82999e8314603c84dd8efbaa594a4118dff2723e8381b9de` | 2026-10-08T15:35:07+02:00 | not documented in the script usage |
| `out/tr_season17.pkl` | 2,122,690 | `9ee414e64c2c205994913975b9a59dc909b695fd0fa9f09c0719c63578feebe4` | 2026-10-08T15:32:26+02:00 | not documented in the script usage |
| `out/tr_wave23.pkl` | 529,128 | `33011aab7dcccf70c3f5342567084d17cb028c19b086f5a201c5385cd6157a84` | 2026-10-08T15:36:02+02:00 | not documented in the script usage |
| `out/tr_xvol10.pkl` | 200,829 | `915ba8f421fe0c86961d9c1637c0c1e1b2e22dd294426d41ecc9843e3a50096d` | 2026-10-08T15:35:49+02:00 | not documented in the script usage |
| `out/tr_xvol9.pkl` | 153,804 | `e7d6d6785e6c9313dacbfbb47ab6f32b1338fb907cad0b6b3c6f88eb1c558c3d` | 2026-10-08T15:35:26+02:00 | not documented in the script usage |

## risk8

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/risk8/` (repository path `data/research/engine/audit/risk8/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T05:05:17+02:00 to 2026-10-08T05:07:27+02:00 (file modification times).
- Scripts in the registry: `diag_hours.py`, `explore.py`, `risk8.py`, `summarize.py`.
- Documented commands: `python diag_hours.py INST`; `python explore.py INST`; `python risk8.py register`; `python risk8.py amend "reason"`; `python risk8.py check`; `python risk8.py run INST`; `python risk8.py refit INST`; `python summarize.py INST`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `out/WTICO_USD.md` | 14,006 | `71767ea1c172061cd5bc184e9fd75496da1b9234bd9b170ce35c4435269b0743` | 2026-10-08T05:06:01+02:00 | not documented in the script usage |
| `out/XAU_USD.md` | 14,054 | `583665081a908b8a08b2d8734a7c9bf2b4e1b270def3a57712d1b2b2dd702944` | 2026-10-08T05:07:27+02:00 | not documented in the script usage |
| `out/overlay_WTICO_USD.json` | 78,689 | `28822b91e146bcd8fa96ea1e7178c05b867564cbe430bfe055c2295772249440` | 2026-10-08T05:05:17+02:00 | `python risk8.py run INST` |
| `out/overlay_XAU_USD.json` | 78,652 | `824cd2f7bca6109c20ecaba908e37f66b0ab0d9c3d409385ab1d2b3205367600` | 2026-10-08T05:06:55+02:00 | `python risk8.py run INST` |
| `out/refit_WTICO_USD.json` | 30,053 | `08c6c64b4acaede6e3f22fbc13d060aecc06ff64e5eacbeb94cf8d777a0b34e4` | 2026-10-08T05:05:45+02:00 | `python risk8.py refit INST` |
| `out/refit_XAU_USD.json` | 29,862 | `09c378575bc778196360dca055ce2f117c1287587d4cdc3d39a4d020e7bbe8d8` | 2026-10-08T05:07:27+02:00 | `python risk8.py refit INST` |
| `out/refit_wti.log` | 1,352 | `8858b95caa0ef2160c4e165b72d1826ac62a464d29bbb2e99cd10cb0148c31c4` | 2026-10-08T05:05:45+02:00 | `run log` |
| `out/refit_xau.log` | 1,342 | `797ef16da55cd454a2dbd6d27fe541726b7c861ceb24c94c284fb73f13dfba96` | 2026-10-08T05:07:27+02:00 | `run log` |
| `out/run_wti.log` | 138 | `c2c8a25bd376c08a12cf6b258aae4e94e5317230b8b16ed5bb889e02308722b5` | 2026-10-08T05:05:17+02:00 | `run log` |
| `out/run_xau.log` | 130 | `8b1cce53cebcd81055ab52a02c27fb59be3344a73b142fe0ada46204c1a5eb27` | 2026-10-08T05:06:55+02:00 | `run log` |

## roll47

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/roll47/` (repository path `data/research/engine/audit/roll47/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-09T18:15:35+02:00 to 2026-10-09T18:18:40+02:00 (file modification times).
- Scripts in the registry: `posthoc.py`, `roll47.py`, `summarize.py`.
- Documented commands: `python roll47.py check | counts | run`.
- Modes dispatched on the first argument: `check`, `counts`, `run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `prereg_comment.md` | 4,868 | `3f3b0b461182e27805b969d5f0ee87a64cde023c96e135765670d3fa5bbbb35a` | 2026-10-09T18:16:32+02:00 | not documented in the script usage |
| `result_comment.md` | 6,617 | `89a737132f3ed61773fd85fe7b78c22183555cc8913501dda50354a60aa5e733` | 2026-10-09T18:18:40+02:00 | not documented in the script usage |
| `out/cells.json` | 810,808 | `5c1733b871d91558a8a9b658ea4998289aa13f4e20588b19bdfdd906f7317e7c` | 2026-10-09T18:17:00+02:00 | not documented in the script usage |
| `out/counts.json` | 3,531 | `01c3c6e72f0b48a8aa9798aaa78b5cc688668b202e8bade1b1c2168012392b4c` | 2026-10-09T18:15:54+02:00 | not documented in the script usage |
| `out/posthoc.txt` | 845 | `882ff3276ab8e1c396e6f50225a6c87c6a6e696148841b9625f0bb8c07ce1969` | 2026-10-09T18:17:40+02:00 | not documented in the script usage |
| `out/run.log` | 4,538 | `7e9bc7cd2cfb3d9a5abd06a11ba5bd3b932e42a859203673e5c768c9e8581275` | 2026-10-09T18:17:00+02:00 | `run log` |
| `out/verdict.json` | 249 | `2ff1a08a2b4c23daeff12b17007d023216ec97cb69205feb33c04f63784ca968` | 2026-10-09T18:17:00+02:00 | not documented in the script usage |
| `out/cache/DE30_EUR.npz` | 102,687,960 | `bc6bca6458f151eeeaacb8339c585550afd7e724f00cca9b8b63147f51e8c85f` | 2026-10-09T18:15:51+02:00 | not documented in the script usage |
| `out/cache/EUR_USD.npz` | 128,587,920 | `426bf782bc153acb80e60d5f32d7dc9b658ec1970439505b05881257c9413821` | 2026-10-09T18:15:54+02:00 | not documented in the script usage |
| `out/cache/NAS100_USD.npz` | 122,913,960 | `fd203c1205a55bab8b64bc30ffcdf544733b13c9d7bfa97c5cfb5485fd322719` | 2026-10-09T18:15:46+02:00 | not documented in the script usage |
| `out/cache/NATGAS_USD.npz` | 82,581,360 | `f7aa1f470c3ab36677bd49c82119a01c3e56eae18b7077058c32f34b0b35da34` | 2026-10-09T18:15:41+02:00 | not documented in the script usage |
| `out/cache/SPX500_USD.npz` | 117,609,040 | `0dff31af17e5aeeca9a65af3a06fc6b1842b628a6942fa85a7b5b37d5221521f` | 2026-10-09T18:15:44+02:00 | not documented in the script usage |
| `out/cache/US30_USD.npz` | 122,326,400 | `f70d84d01cbb350c17dff0df0214844f8e47b01afe03bf76a3e27b6fa01af03f` | 2026-10-09T18:15:49+02:00 | not documented in the script usage |
| `out/cache/WTICO_USD.npz` | 120,159,240 | `d6aba80c4e8066ffea1f8b33ebeb9732fe3b96517f57e526e3f0548f50e80d17` | 2026-10-09T18:15:35+02:00 | not documented in the script usage |
| `out/cache/XAG_USD.npz` | 113,019,240 | `457010a668f7cd050ef25e601852c6b733809df3fd49f3567cbb995b7cb9e9ab` | 2026-10-09T18:15:40+02:00 | not documented in the script usage |
| `out/cache/XAU_USD.npz` | 122,500,520 | `79e278b8ccfa43a605b19ff631f1adab7eb538af55d1ba5a3c90c0d02d9c75f7` | 2026-10-09T18:15:37+02:00 | not documented in the script usage |

## scan46

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/scan46/` (repository path `data/research/engine/audit/scan46/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/engine/audit/tsmom36/daily.db, data/research/history.db, the campaign's own daily.db.
- Ran: 2026-10-09T17:58:13+02:00 to 2026-10-09T18:01:17+02:00 (file modification times).
- Scripts in the registry: `_nbtest.py`, `posthoc.py`, `report.py`, `scan46.py`.
- Documented commands: `python scan46.py check`; `python scan46.py describe`; `python scan46.py grid`; `python scan46.py register`; `python scan46.py run`; `python scan46.py locked URL locked test of the frozen finalists (needs the posted finalists comment URL)`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `prereg_body.json` | 5,159 | `becb4770b17eae4e3b84ae0b5470f415e6408fd9e923e36190725cdb8fc72433` | 2026-10-09T17:58:43+02:00 | not documented in the script usage |
| `prereg_comment.md` | 9,458 | `a5fd45eb406526fcf0e145ccce2c18075eb8138b01b3de72d6bc4001588d0919` | 2026-10-09T17:59:43+02:00 | not documented in the script usage |
| `result_comment.md` | 4,445 | `3734bcf443c0a0de28cb838010bd14f20974f0d95266211d03133567245e2dbb` | 2026-10-09T18:01:17+02:00 | not documented in the script usage |
| `out/cells.parquet` | 454,410 | `9768a5b7be80bcc1a6e60dc2ab63e89498f9487f00d151af85df865c6a049ce7` | 2026-10-09T18:00:29+02:00 | `python scan46.py run` |
| `out/describe.json` | 9,615 | `d5f4fcde315302adf8cedc446e4a2c603d14b3ec7bab54836c31abd1770354ad` | 2026-10-09T17:59:06+02:00 | `python scan46.py run` |
| `out/describe.log` | 83 | `81f6ba9fa7edde0469a425ff77a230b41530f7cc684116a11a8c9d69036858c1` | 2026-10-09T17:59:06+02:00 | `python scan46.py run` |
| `out/finalists.json` | 497 | `f74583e49b7f9c73f412aae5c5abf1edc0a50460ba10e1de14ea57483e26535e` | 2026-10-09T18:00:29+02:00 | `python scan46.py run` |
| `out/grid.txt` | 1,818 | `713338a4dfe20ce94225082052f806f3a9194f636719d69022e29edf419de812` | 2026-10-09T17:58:54+02:00 | `python scan46.py run` |
| `out/posthoc.json` | 5,271 | `1732b21cf0490201d370c79ada66a57cced84cc7bf7acc9c6aee390f2737f163` | 2026-10-09T18:00:51+02:00 | `python scan46.py run` |
| `out/report.json` | 18,838 | `f0a755d9c562b5d97bc3e4f2e5cdda6d142a6e2e6ed0bd1a14a85334b619e6a6` | 2026-10-09T18:00:35+02:00 | `python scan46.py run` |
| `out/run.log` | 806 | `bcf90d739bcf07c96e1e8c96e9b809494c19c68afa199b65d1c1f2fc1b394fd3` | 2026-10-09T18:00:29+02:00 | `python scan46.py run` |
| `out/cache/AU200_AUD.npz` | 101,382,232 | `40f850672bdc4c4748c23c97271d8ba868c034e15ecf3f3d01a6e10ac2478846` | 2026-10-09T17:58:42+02:00 | `python scan46.py run` |
| `out/cache/BCO_USD.npz` | 114,208,512 | `9ab3de5f0fe55a3cdf3a30362b31d3c290ac7458449abbaf34c950ea62a992c8` | 2026-10-09T17:58:53+02:00 | `python scan46.py run` |
| `out/cache/DE30_EUR.npz` | 102,697,712 | `c61204cbc1946f228cdd6f68631d9beb8ee09cb76f556d89f5801ce0271d0641` | 2026-10-09T17:58:34+02:00 | `python scan46.py run` |
| `out/cache/EU50_EUR.npz` | 72,834,192 | `bed8261740f5f75615629a351b426d8f4db124f1cbe88e17dabe0c5938217883` | 2026-10-09T17:58:45+02:00 | `python scan46.py run` |
| `out/cache/EUR_USD.npz` | 128,598,232 | `8c09a187569cc75decd4fb67ca43c5aca4b136c5e0937e172afc67922a93c479` | 2026-10-09T17:58:13+02:00 | `python scan46.py run` |
| `out/cache/GBP_USD.npz` | 127,408,432 | `91f30a930d5800a72dd76e07dba707c83e7607d92f0914d9fb090ca97fd12313` | 2026-10-09T17:58:17+02:00 | `python scan46.py run` |
| `out/cache/JP225_USD.npz` | 115,320,872 | `f5d722e214408c335d1d95144b2b40c1be328ba12e9640933a0539a96f1ae85c` | 2026-10-09T17:58:40+02:00 | `python scan46.py run` |
| `out/cache/NAS100_USD.npz` | 122,924,312 | `8e7a0bfcea502e35a4bfb59236db8d13f2333001cf61c575bcb68b5fa66c753b` | 2026-10-09T17:58:27+02:00 | `python scan46.py run` |
| `out/cache/NATGAS_USD.npz` | 82,585,432 | `53bf5b048b437248a00e2675d5bc64fe7a879ae802f0a78036d0cb91fe8bf5f9` | 2026-10-09T17:58:55+02:00 | `python scan46.py run` |
| `out/cache/SPX500_USD.npz` | 117,619,272 | `68f1bb22ac5eaa1eefc5ca968ecd62a61d7d43ff601b1adf41edc4ebad7bd0e1` | 2026-10-09T17:58:24+02:00 | `python scan46.py run` |
| `out/cache/UK100_GBP.npz` | 100,652,432 | `7031de234122026539225494573e9d4ba09112ed86cb7d90dad90e14b04cf73b` | 2026-10-09T17:58:36+02:00 | `python scan46.py run` |
| `out/cache/US30_USD.npz` | 122,336,752 | `9303aaeeaa9a4c8c00503e1d651ca5bdd12d139d7a4e61999056014326919474` | 2026-10-09T17:58:31+02:00 | `python scan46.py run` |
| `out/cache/USD_JPY.npz` | 128,926,432 | `5c6d6a39c652c986bca0555c588fe802208aa1f59709e32c07ffc3934eaddab6` | 2026-10-09T17:58:20+02:00 | `python scan46.py run` |
| `out/cache/WTICO_USD.npz` | 120,169,512 | `c1f4aa3fa6773fcc13736304296d87efa0992fcfbc2f4f94e6d5ccd21a675e1d` | 2026-10-09T17:58:50+02:00 | `python scan46.py run` |
| `out/cache/XAG_USD.npz` | 113,029,512 | `9ac257aa6d785245abbe84e0e45be0e027bc647903e5483ed5b8b697c885e487` | 2026-10-09T17:59:02+02:00 | `python scan46.py run` |
| `out/cache/XAU_USD.npz` | 122,510,792 | `6d5b7e3581a38ecaab0408b9f48f7ee909b51e171a8b4d2243b083fbe4beef25` | 2026-10-09T17:58:59+02:00 | `python scan46.py run` |
| `out/cache/XPT_USD.npz` | 114,793,792 | `72685c8890bb0d8bf4e646d67027613327afd7b054c43bd802af34602839a5cd` | 2026-10-09T17:59:05+02:00 | `python scan46.py run` |

## season17

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/season17/` (repository path `data/research/engine/audit/season17/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T09:36:41+02:00 to 2026-10-08T09:42:46+02:00 (file modification times).
- Scripts in the registry: `coverage.py`, `inspect_counts.py`, `season17.py`, `summarize.py`, `verify.py`.
- Documented commands: `python season17.py check`; `python season17.py register`; `python season17.py amend "why" append an amendment with new code hashes`; `python season17.py build INST`; `python season17.py run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `out/coverage.json` | 3,244 | `cb4a371dd5421ac9eb8de6b85a19a3712b4ee2abd7a67ee09568c503ed4fc70a` | 2026-10-08T09:36:41+02:00 | not documented in the script usage |
| `out/results.json` | 237,811 | `019b0759b447165b736343b43425aba3caa644d6491a6fc8345d234f63a7d98c` | 2026-10-08T09:42:46+02:00 | `python season17.py run` |
| `out/scan.csv` | 89,064 | `8eb2d3c49fe48eeb601bf46c93d17ff93204e96f7212d76fcadbbabf045a53cd` | 2026-10-08T09:42:36+02:00 | not documented in the script usage |
| `out/tr_BTC_USD.pkl` | 8,110,482 | `6b29ac40ac5d4690cee734c3c98c20d3063a556f46e7fd782ffb3999851d7ac5` | 2026-10-08T09:42:27+02:00 | `python season17.py build INST` |
| `out/tr_EUR_USD.pkl` | 8,302,926 | `135966029f8192f1fdc5f7915f9ada4111804df6d1d33f49042c8c7015c79beb` | 2026-10-08T09:42:24+02:00 | `python season17.py build INST` |
| `out/tr_NAS100_USD.pkl` | 8,160,672 | `366b7a7276b10ec214575284922d4baad85ca9ae041ec62aad0e00dc8d3946d6` | 2026-10-08T09:42:25+02:00 | `python season17.py build INST` |
| `out/tr_NATGAS_USD.pkl` | 7,364,939 | `a32a85716bc503a43ffc4bc13d438b89dd1bd17274c120577045ed1f831fd7bd` | 2026-10-08T09:42:22+02:00 | `python season17.py build INST` |
| `out/tr_SPX500_USD.pkl` | 8,159,000 | `eb2bf3abf83f0b5c3d5fd621a749c48eaa834b3f530a1d6e1ebc0b29edd77168` | 2026-10-08T09:42:23+02:00 | `python season17.py build INST` |
| `out/tr_USD_JPY.pkl` | 8,305,244 | `e647f712fe950b93dee3b8c4031fc8ca56f4cded0224c6111f91d70d5e2fdf6f` | 2026-10-08T09:42:17+02:00 | `python season17.py build INST` |
| `out/tr_WTICO_USD.pkl` | 7,770,440 | `08678e896aa7b49cbbe630db73ae0680fa3b3211bb238587ae486ed3bc6305c6` | 2026-10-08T09:42:18+02:00 | `python season17.py build INST` |
| `out/tr_XAG_USD.pkl` | 7,752,498 | `2e157635916121a0b8fd6687454c5769b741f717ee0514de921c6905bffe1d4c` | 2026-10-08T09:42:21+02:00 | `python season17.py build INST` |
| `out/tr_XAU_USD.pkl` | 8,116,213 | `da545979d7636140ee33784891d8217b26682cfe156baf5b04225308c787ae3c` | 2026-10-08T09:42:20+02:00 | `python season17.py build INST` |

## sess25

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/sess25/` (repository path `data/research/engine/audit/sess25/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T15:31:20+02:00 to 2026-10-08T15:42:25+02:00 (file modification times).
- Scripts in the registry: `sess25.py`, `summarize.py`.
- Documented commands: `python sess25.py check`; `python sess25.py register`; `python sess25.py build INST TF`; `python sess25.py run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `prereg_comment.md` | 3,980 | `7930ffc286496405b574d42082847e677d6bdf559fda30244d219fca16aa19ab` | 2026-10-08T15:31:20+02:00 | not documented in the script usage |
| `result_comment.md` | 3,807 | `e628ba87ef2ac3cfee1e8858f623c8d15df2079c29cb64695fd1349948ea013b` | 2026-10-08T15:42:25+02:00 | not documented in the script usage |
| `out/base_rates.json` | 10,411 | `5bcddc102fcc97aed462d3023c010a3f736c0244eb8792e209639d5bb7d2a710` | 2026-10-08T15:41:20+02:00 | `python sess25.py run` |
| `out/build_M1.log` | 1,489 | `727e5c43563f3c3e00d17985c598d071d36d275100b47d1054a7d6e5e453d187` | 2026-10-08T15:41:05+02:00 | `run log` |
| `out/build_M5.log` | 1,515 | `f0fdfecf2da90d0acbd822559c2285b0c40f943a89c1870230a1687434559918` | 2026-10-08T15:40:47+02:00 | `run log` |
| `out/ev_EUR_USD_M1.pkl` | 792,431 | `4538f9ff3c6fd0d16e17aa25ae4f7a2f439d53edb8a10d6ae5afa4addeff3bab` | 2026-10-08T15:41:01+02:00 | `python sess25.py build INST TF` |
| `out/ev_EUR_USD_M5.pkl` | 761,870 | `34e9116960adbdff07f459fdb992025033e20d19ffe7df62405517723c1b3df2` | 2026-10-08T15:40:45+02:00 | `python sess25.py build INST TF` |
| `out/ev_NATGAS_USD_M1.pkl` | 201,128 | `6c7a8e1e403030f5e8f2c7f259b429f273bad65fbe85c903361e3fdd94b5b498` | 2026-10-08T15:41:05+02:00 | `python sess25.py build INST TF` |
| `out/ev_NATGAS_USD_M5.pkl` | 574,264 | `d83f10847c7ca7325f91e198264b3313704d2593082c5f14354a187bf3ed45a7` | 2026-10-08T15:40:47+02:00 | `python sess25.py build INST TF` |
| `out/ev_SPX500_USD_M1.pkl` | 755,835 | `c1b0647edb620914ecf233e0d73bcce5f3ce70a7f31bed4a5c76242d8805bad4` | 2026-10-08T15:41:03+02:00 | `python sess25.py build INST TF` |
| `out/ev_SPX500_USD_M5.pkl` | 803,647 | `5d0d543068cb2fffdbd23588e6fd7f71f43aacbd9da17202ad0bc8f81be7bef8` | 2026-10-08T15:40:46+02:00 | `python sess25.py build INST TF` |
| `out/ev_WTICO_USD_M1.pkl` | 786,716 | `79e0f758266ceb3ea35c6b203ac95578c453dae578257cd9dab27550c77b108c` | 2026-10-08T15:40:54+02:00 | `python sess25.py build INST TF` |
| `out/ev_WTICO_USD_M5.pkl` | 802,976 | `da958e7331bd49bbdee39a39438dcc72103eb176baf3ecd67d82f216a6103ef9` | 2026-10-08T15:40:40+02:00 | `python sess25.py build INST TF` |
| `out/ev_XAG_USD_M1.pkl` | 575,382 | `f02124dadcd04b1b11d040122e9e0068b4265cd356b6b7a35c225435ca1824a3` | 2026-10-08T15:40:59+02:00 | `python sess25.py build INST TF` |
| `out/ev_XAG_USD_M5.pkl` | 680,586 | `0b7a75c96ffe51a24b6022d83576a9cc59303c7bd8871fb31fc14ca9f9ea7e78` | 2026-10-08T15:40:43+02:00 | `python sess25.py build INST TF` |
| `out/ev_XAU_USD_M1.pkl` | 718,635 | `d8d0586875628db268c79a6b7886f644caa1d8f1f838b75323055d7de463c7d6` | 2026-10-08T15:40:56+02:00 | `python sess25.py build INST TF` |
| `out/ev_XAU_USD_M5.pkl` | 690,555 | `0b406c8ad3c01f0535ac816a4232e282a9f441caab20d1b32ceb14bf2c1f94f0` | 2026-10-08T15:40:42+02:00 | `python sess25.py build INST TF` |
| `out/report.txt` | 20,340 | `fd393d30d580b7fb709bb6070903e25ffc5133fe649c100c5876acb2642ae4e4` | 2026-10-08T15:41:30+02:00 | `python sess25.py run` |
| `out/results.json` | 146,220 | `db8265f1d2be4e1a3a0cdb828def835ce8e7b747b4b312169a25a0a7c66d024b` | 2026-10-08T15:41:20+02:00 | `python sess25.py run` |
| `out/run.log` | 510 | `cdfbe102f2f2c0489fdf5eb52503c70ed30ef212b9e73ace4dc94555f6b846b8` | 2026-10-08T15:41:21+02:00 | `run log` |

## swing43

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/swing43/` (repository path `data/research/engine/audit/swing43/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/engine/audit/tsmom36/daily.db.
- Ran: 2026-10-09T16:18:11+02:00 to 2026-10-09T16:19:41+02:00 (file modification times).
- Scripts in the registry: `swing43.py`.
- Documented commands: `python swing43.py check`; `python swing43.py describe`; `python swing43.py register`; `python swing43.py run`.
- Modes dispatched on the first argument: `check`, `describe`, `register`, `run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `prereg_body.json` | 4,089 | `2020e9680bdcf0fc9e604f3aebd9e95d7c5b1e222ec84a882668ddf51ecb6f51` | 2026-10-09T16:18:33+02:00 | not documented in the script usage |
| `prereg_comment.md` | 3,413 | `82f1365dd80fbb0bf3ac8cac7cb25a485da1632359a2da3b722ba9e3b6d1a47f` | 2026-10-09T16:18:48+02:00 | not documented in the script usage |
| `result_comment.md` | 5,093 | `0c78e8a1e8bd9c1c99564d872f6d0a35b38146dcae3b7253960dd93d41bbf250` | 2026-10-09T16:19:41+02:00 | not documented in the script usage |
| `out/describe.json` | 2,075 | `b1eb6eae4059e6722b3ace9c7c1fd98a57c5e18d673f7a82dbf325a3d4b40486` | 2026-10-09T16:18:11+02:00 | not documented in the script usage |
| `out/results.json` | 456,746 | `e5fc8185e5a81b0dd60439cb27224a6f4a1c68ec5ebc571b20dce2d79a649034` | 2026-10-09T16:18:55+02:00 | `python swing43.py run` |
| `out/run.log` | 1,390 | `61264c6ae3504b231f50dd2fdf340158a6ffd8abd8ea32b64e19b61dcaef253d` | 2026-10-09T16:18:55+02:00 | `run log` |
| `out/trades_down2.csv` | 1,453,174 | `c2639389d54cd4bfaa23ada4708a56ada6aea6cf8fcdd35be41f9018deb55834` | 2026-10-09T16:18:54+02:00 | not documented in the script usage |
| `out/trades_down3.csv` | 667,347 | `1a754809e3b5e1420e2df29b581e88b3a635a4dd655e8fdd2d012afdd67ea7ad` | 2026-10-09T16:18:55+02:00 | not documented in the script usage |
| `out/trades_fixed5.csv` | 642,228 | `d54d3e5dd5cf8836ffbf25f955d8b9b55b838817cdce99eb1f4c21d80c9eb1d9` | 2026-10-09T16:18:55+02:00 | not documented in the script usage |
| `out/trades_primary.csv` | 621,813 | `45860af77ffeba995d62e90ed9a2b0e27b872151e962f700758618f116493765` | 2026-10-09T16:18:53+02:00 | not documented in the script usage |
| `out/trades_rsi25.csv` | 1,308,656 | `9de216d04ee2cff1cbcf9eb4f253413497734102af65162682531bdd43a31d64` | 2026-10-09T16:18:54+02:00 | not documented in the script usage |
| `out/trades_rsi5.csv` | 311,892 | `e3de935ef7acb59a2be50e265059f94db2c68f28b991a0a3fe7bad8b4c45a36d` | 2026-10-09T16:18:54+02:00 | not documented in the script usage |
| `out/trades_short.csv` | 483,559 | `d579e872518980a72f81331d9bd9b6b08de6d2b42c24bf7d5365458ed00efb83` | 2026-10-09T16:18:55+02:00 | not documented in the script usage |

## swing44

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/swing44/` (repository path `data/research/engine/audit/swing44/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: OANDA candles through the FXEmpire proxy (download), data/research/engine/audit/tsmom36/daily.db, the campaign's own daily.db.
- Ran: 2026-10-09T16:22:40+02:00 to 2026-10-09T16:25:10+02:00 (file modification times).
- Scripts in the registry: `fetch.py`, `swing44.py`.
- Documented commands: `python fetch.py [INSTRUMENT ...]`; `python swing44.py check`; `python swing44.py describe`; `python swing44.py register`; `python swing44.py run`.
- Modes dispatched on the first argument: `check`, `describe`, `register`, `run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `daily.db` | 6,135,808 | `a9dd8347fc6e562cf48befd1b18e88891148bdac073d669492a1c8156d6320c5` | 2026-10-09T16:22:40+02:00 | not documented in the script usage |
| `fetch.log` | 787 | `b9c00dbae9171142634ef3e2659a34143ef71b33d8a485ca5f2d0345a0a6baf5` | 2026-10-09T16:22:40+02:00 | `run log` |
| `prereg_body.json` | 4,407 | `76865735bccc277e6296ea35b51c86c0aeeca0aae6e8e87103ad4261687737f8` | 2026-10-09T16:24:13+02:00 | not documented in the script usage |
| `prereg_comment.md` | 3,753 | `3cc1a963d6aaab975835afb3971b4f7f710864605b0c0da2d9904c1e8b9b6cd5` | 2026-10-09T16:24:31+02:00 | not documented in the script usage |
| `result_comment.md` | 4,158 | `b3c6e4e8a8d271d3fcbcf7b8a5ce1ff239e0550b14646055ba76f99d21259f6a` | 2026-10-09T16:25:10+02:00 | not documented in the script usage |
| `out/describe.json` | 3,877 | `3d0be4cf3e0f88d33cc62529e4da2f9663be1114e94eaa13853703000a5d55c8` | 2026-10-09T16:23:45+02:00 | not documented in the script usage |
| `out/results.json` | 73,993 | `9291a7078a683d45efb711b7e21e8aca89faa8380f5ce25c01f62fec94423e72` | 2026-10-09T16:24:35+02:00 | `python swing44.py run` |
| `out/run.log` | 2,104 | `2ab5c3e182638f82814b9735454bea0d6647592f8370579540eb6bb7ee219029` | 2026-10-09T16:24:35+02:00 | `run log` |
| `out/trades_down3.csv` | 131,456 | `ddefe63ba39478093d22c7f6047b43e5f06c0d74cc31eccfd7304a18c57bda2c` | 2026-10-09T16:24:35+02:00 | not documented in the script usage |
| `out/trades_primary.csv` | 125,244 | `22300dc2561e3b7693cbf860377a5bc78a094c7cd312c46bd51b45c5542ce2f7` | 2026-10-09T16:24:35+02:00 | not documented in the script usage |
| `out/trades_rsi5.csv` | 63,273 | `89407e4b664fb7e62569be098894d22384183a94744bdbcab1680f457c91b8d3` | 2026-10-09T16:24:35+02:00 | not documented in the script usage |

## swing45

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/swing45/` (repository path `data/research/engine/audit/swing45/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/engine/audit/tsmom36/daily.db, data/research/history.db, the campaign's own daily.db.
- Ran: 2026-10-09T17:28:18+02:00 to 2026-10-09T17:37:17+02:00 (file modification times).
- Scripts in the registry: `report.py`, `swing45.py`.
- Documented commands: `python swing45.py check`; `python swing45.py describe`; `python swing45.py register`; `python swing45.py run`.
- Modes dispatched on the first argument: `check`, `counts`, `describe`, `register`, `run`, `short`, `summary`, `t6`, `table`, `units`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `prereg_body.json` | 4,939 | `438e2357da6cb28692df9fd0d8c0abbe0a2ba11d5dbecf7755bc7765dd8a3c00` | 2026-10-09T17:31:13+02:00 | not documented in the script usage |
| `prereg_comment.md` | 3,865 | `6618b5e73a74fac47440dabcf2a66468af1e889b5850a838254b364c1165c981` | 2026-10-09T17:31:32+02:00 | not documented in the script usage |
| `result_comment.md` | 8,575 | `7474d3a79230b19f8f22389ad972372a3d43f9a12af5382076ff3affee316c96` | 2026-10-09T17:37:17+02:00 | not documented in the script usage |
| `out/describe.json` | 10,270 | `ae24fd253b87dc6f86fef1261acd0ad526a64c116b5470becbd877b6f7e18032` | 2026-10-09T17:30:46+02:00 | not documented in the script usage |
| `out/results.json` | 2,878,079 | `6a217216ef76408d16b40a9ef86e30138342842cb8f0bcdb6ed3f40bf8f0d544` | 2026-10-09T17:35:56+02:00 | `python swing45.py run` |
| `out/run.log` | 299 | `28bbb95a73672c1e79b81111c5b6f0f02699a014769300b06e168774705910b8` | 2026-10-09T17:35:57+02:00 | `run log` |
| `out/trades.parquet` | 1,394,161,655 | `99c48c35772d18eb09793247010b32f8f1197cd24cb20cbc5b8ae3874086d561` | 2026-10-09T17:35:34+02:00 | not documented in the script usage |
| `out/cache/AU200_AUD.npz` | 60,829,356 | `e192fecfc5f6ba8aed5390f4e782dea8a11d34eefcd73a48cf661092f01f003e` | 2026-10-09T17:29:06+02:00 | not documented in the script usage |
| `out/cache/DE30_EUR.npz` | 61,618,644 | `c564af38453dd64ed2b7bfebd14c2bcc59cb7abd75f587d4d6cf40d3c0db627e` | 2026-10-09T17:28:43+02:00 | not documented in the script usage |
| `out/cache/EU50_EUR.npz` | 43,700,532 | `4d28fb701df6a039425d7744079d0bcc5bedcfad0a81bd813216fd788cdd949b` | 2026-10-09T17:29:12+02:00 | not documented in the script usage |
| `out/cache/EUR_USD.npz` | 77,158,956 | `01037618e89d39ee8940c24397cae7f110f8b08610935dd3ccb50c46343fffe7` | 2026-10-09T17:35:17+02:00 | not documented in the script usage |
| `out/cache/JP225_USD.npz` | 69,192,540 | `cf43a7e8172a0dc13f509c70853f694ce07c864709f3b65d26454066317e264f` | 2026-10-09T17:28:58+02:00 | not documented in the script usage |
| `out/cache/NAS100_USD.npz` | 73,754,604 | `817b3636eb2d39f5d9012ec7080c856690229a45a2389c32f789a9ef1b09a18a` | 2026-10-09T17:28:26+02:00 | not documented in the script usage |
| `out/cache/NATGAS_USD.npz` | 49,551,276 | `f5e1a91d4291952debb345c4c8d30e82f72d479d0e06cfff2387168991e9ec82` | 2026-10-09T17:35:07+02:00 | not documented in the script usage |
| `out/cache/SPX500_USD.npz` | 70,571,580 | `34e9fd5221f65b64b4402ee2d50ec4614312ef2930a846c7a319a8d11aa12a52` | 2026-10-09T17:28:18+02:00 | not documented in the script usage |
| `out/cache/UK100_GBP.npz` | 60,391,476 | `94c5e5dc527b69a56cdf84e50e1c64aa5618b99c5ae8e0d8b2f338503a80f1ba` | 2026-10-09T17:28:51+02:00 | not documented in the script usage |
| `out/cache/US30_USD.npz` | 73,402,068 | `5cb99157c24105de877f364b7f218c40ba9ad02327b6a00701d09178cc8d235c` | 2026-10-09T17:28:35+02:00 | not documented in the script usage |
| `out/cache/WTICO_USD.npz` | 72,101,724 | `e0996b24b84f4f86bf12a3c772b1adf23815bd23227e7d7ae3b3a6a29453a6ae` | 2026-10-09T17:34:29+02:00 | not documented in the script usage |
| `out/cache/XAG_USD.npz` | 67,817,724 | `2d33edd4d7dd0a15760d1059b6ab79bd5d7e8b83ae5826c638b3be2f2d4a4dcd` | 2026-10-09T17:34:55+02:00 | not documented in the script usage |
| `out/cache/XAU_USD.npz` | 73,506,492 | `d964acdeb39fa8ee93e52d1fb44a2b265669258d9b08853bd3a828b7bcfc8ca4` | 2026-10-09T17:34:42+02:00 | not documented in the script usage |

## trend49

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/trend49/` (repository path `data/research/engine/audit/trend49/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/engine/audit/tsmom36/daily.db, data/research/history.db.
- Ran: 2026-10-09T21:04:03+02:00 to 2026-10-09T21:10:36+02:00 (file modification times).
- Scripts in the registry: `trend49.py`, `trend49_amend.py`, `trend49_lev.py`.
- Documented commands: `python trend49.py check`; `python trend49.py register`; `python trend49.py run`; `python trend49_amend.py`; `python trend49_lev.py check`; `python trend49_lev.py register`; `python trend49_lev.py run`.
- Modes dispatched on the first argument: `check`, `register`, `run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `result_comment.md` | 10,810 | `87a9a134137ce7f401c399f3c4c36962ba00e83415888112360f151b298b3dd2` | 2026-10-09T21:06:15+02:00 | not documented in the script usage |
| `result_comment_lev.md` | 16,274 | `625e52b6dd6b17694710429f288f5dd1088a1456dfc7794d3741a5492e27d6f6` | 2026-10-09T21:10:36+02:00 | not documented in the script usage |
| `out/DTB3.csv` | 40,356 | `12fdb695fa7ad88e98c3ec82063d6743409ef15adb9f575c3a208c51dce7cb85` | 2026-10-09T21:08:47+02:00 | not documented in the script usage |
| `out/episodes_amended.json` | 20,090 | `92a7c6e850be1f586f8cf4bac714f6ff0b603a7b727144dd416c9fdbb9d02978` | 2026-10-09T21:04:47+02:00 | `python trend49_amend.py` |
| `out/episodes_amended.md` | 3,782 | `7977b1337f492b28d71906fbe906ae848a0afad1b92f5484a9457b2b26e096ed` | 2026-10-09T21:04:47+02:00 | `python trend49_amend.py` |
| `out/lev.json` | 127,722 | `c6179242a556af3620902410cd69d945c9410545923dcb0edf12368484654524` | 2026-10-09T21:09:23+02:00 | `python trend49_lev.py run` |
| `out/lev_tables.md` | 11,153 | `c4ca54863c7531c1f369ffa3894cfb50a35b9b90559f07e1f4e5f335acf1a496` | 2026-10-09T21:09:23+02:00 | `python trend49_lev.py run` |
| `out/results.json` | 50,389 | `8990f0cfb79e7bd887ebfe20c57232c65077abaa0d9ded61a625c34712450507` | 2026-10-09T21:04:03+02:00 | `python trend49.py run` |
| `out/tables.md` | 9,610 | `34d9c3842022cc1463d86eef813350cb37bee094515246bf50ff03fc324b9074` | 2026-10-09T21:04:03+02:00 | `python trend49.py run` |

## tsmom36

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/tsmom36/` (repository path `data/research/engine/audit/tsmom36/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: OANDA candles through the FXEmpire proxy (download), data/candles.db (live engine, read-only), data/research/engine/audit/tsmom36/daily.db, data/research/history.db, the campaign's own daily.db.
- Ran: 2026-10-09T11:27:54+02:00 to 2026-10-09T11:32:45+02:00 (file modification times).
- Scripts in the registry: `fetch.py`, `tsmom36.py`.
- Documented commands: `python fetch.py [INSTRUMENT ...]`; `python tsmom36.py check`; `python tsmom36.py describe`; `python tsmom36.py register`; `python tsmom36.py run`.
- Modes dispatched on the first argument: `check`, `describe`, `register`, `run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `daily.db` | 25,911,296 | `58fa10f6200ad6a0bf95cb5b3c7433e2546e966c3031ce1066c7659f6220a6ee` | 2026-10-09T11:27:54+02:00 | not documented in the script usage |
| `fetch.log` | 2,151 | `f367117da6405c1982964b72b17d4f717c2a9b9c52b1419a4865f85948b2ecd5` | 2026-10-09T11:27:54+02:00 | `run log` |
| `prereg_body.json` | 4,239 | `17fff09cd6f06609b9c35dca324484b3917f472076e890f3b766ff19f8b97ca3` | 2026-10-09T11:31:20+02:00 | not documented in the script usage |
| `prereg_comment.md` | 4,390 | `4e35dcfd89b6c9c65f83ffba2f4697bd4b8066d35dbaa42f7e340f96a302b475` | 2026-10-09T11:31:40+02:00 | not documented in the script usage |
| `result_comment.md` | 3,934 | `266c041e037b5526602f19356038fa0b2ba8ae28701dc7cd33f98d84a8a980db` | 2026-10-09T11:32:45+02:00 | not documented in the script usage |
| `out/describe.json` | 6,958 | `1db898e3a740164875af1844a75721ad419de8f9a6b4a0bc8689f4b9ff8f251a` | 2026-10-09T11:30:57+02:00 | not documented in the script usage |
| `out/primary_daily.csv` | 532,155 | `7f65074af88930e9e9978954bba209916260fefd3dbb71bb459921d92cc25951` | 2026-10-09T11:31:46+02:00 | not documented in the script usage |
| `out/results.json` | 52,656 | `cab011f11770ea953d05e5610fe1f43ac08e365a9e4c35fa7801c9dde1b287ec` | 2026-10-09T11:31:47+02:00 | `python tsmom36.py run` |
| `out/run.log` | 2,197 | `4d599f78f37b9047a306d17ef6445b9ff60c3732a92db5041096029f4338def3` | 2026-10-09T11:31:47+02:00 | `run log` |
| `out/spreads.json` | 1,379 | `5b238d44756bf23b3cbddd5f71345b59c4f07bf7238286e27aa53d64476761aa` | 2026-10-09T11:30:36+02:00 | not documented in the script usage |

## v1

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/v1/` (repository path `data/research/engine/audit/v1/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-07T23:56:30+02:00 to 2026-10-08T00:26:04+02:00 (file modification times).
- Scripts in the registry: `ambiguity.py`, `calib_trace.py`, `controls.py`, `fixtures.py`, `layers.py`, `lineage.py`, `power.py`.
- Documented commands: `python ambiguity.py`; `python calib_trace.py`; `python controls.py probe`; `python controls.py run dev|final N`; `python fixtures.py`; `python layers.py`; `python lineage.py`; `python power.py [final|dev]`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `REPORT.md` | 3,928 | `031b6041d11983a1a9a54427e75d8b38fe9b251a4daa41dbe72259debc5cd22f` | 2026-10-08T00:26:04+02:00 | not documented in the script usage |
| `controls_registry_dev.json` | 3,099 | `c291cff59198edce7adafded80c45f2e87a8f6cddca47bb084b10cde457b0577` | 2026-10-07T23:56:30+02:00 | not documented in the script usage |
| `controls_registry_final.json` | 3,099 | `78b262ae52bfae018d4d6aa2670ba872e27277e248fcfe6241a5484ec79b6837` | 2026-10-08T00:00:22+02:00 | not documented in the script usage |
| `out/ambiguity.json` | 9,894 | `ff1b270bdabfb795a501c7203254fc68d5bf9ef3a05b79d6747cfc14a21236b3` | 2026-10-08T00:04:03+02:00 | `python ambiguity.py` |
| `out/ambiguity.md` | 2,414 | `08c84a021819768bb325d9aa032c086782fff306296a66d2a915dba7eda4b54b` | 2026-10-08T00:04:03+02:00 | `python ambiguity.py` |
| `out/calibration.json` | 9,183 | `5d8e118bed687fa2e89fc298af6376ae422b0997c3da904f6e5190fe72e56ee7` | 2026-10-08T00:06:29+02:00 | `python calib_trace.py` |
| `out/code_hashes.txt` | 1,633 | `eecd343b629733e51c7b27655eac501ea05ae804f2d3b7f91c7c31cec4a2a877` | 2026-10-08T00:12:38+02:00 | not documented in the script usage |
| `out/controls_dev.jsonl` | 117,868 | `21eb605f556c1c3e3a1e0c62cef8de4c8a801771a72e33856e447057cbec162c` | 2026-10-08T00:00:10+02:00 | `python power.py [final|dev]` |
| `out/controls_final.jsonl` | 1,528,394 | `d9f9cdfafa594520f6a5f64d595ff2473edc6f062bfedca1f86a412afc6a0bce` | 2026-10-08T00:16:41+02:00 | `python power.py [final|dev]` |
| `out/controls_final.log` | 104,660 | `bd6fc3b8df5afc4d91e1ea178d86b019a93fe38c72eff0ad3a2d49e1f30554f3` | 2026-10-08T00:16:41+02:00 | `run log` |
| `out/controls_trials.jsonl` | 3,538,985 | `e310fdbedac47c2e6047fc5702f855f83a31dc222a5d98f2f9c7c436bf8cd3e7` | 2026-10-08T00:16:40+02:00 | `python power.py [final|dev]` |
| `out/fixtures.txt` | 1,693 | `87b62d9b6100a450418e11092215f55a8f3994bbc830c9eacd6b2302aeff42e9` | 2026-10-08T00:12:38+02:00 | not documented in the script usage |
| `out/layers.json` | 15,507 | `d70df3e20cc7a06fbda9e4119d3c11c6a54e64d52ce4fddc96f3cb5d837684f4` | 2026-10-08T00:10:59+02:00 | `python layers.py` |
| `out/layers.md` | 2,768 | `20e2888bd8d240460619e7d2f46f8c000f8715a8d101e1291a8cf86aa05f8908` | 2026-10-08T00:10:59+02:00 | `python layers.py` |
| `out/lineage.json` | 12,130 | `6d6b680d6a614eef531793863747e806d73fffcf31d2657de6ad62320d75a570` | 2026-10-08T00:11:42+02:00 | `python lineage.py` |
| `out/power_dev.json` | 61,077 | `2b0e4f1bfe237d8495de6a5d8f801e6b130713f61c6100195678fe068d5175a6` | 2026-10-08T00:12:15+02:00 | `python power.py [final|dev]` |
| `out/power_dev.md` | 11,802 | `b432f6ef146f700850a7a11bdd50acdae299531dc70b80fc8a7503a6197967ba` | 2026-10-08T00:12:15+02:00 | `python power.py [final|dev]` |
| `out/power_final.json` | 71,254 | `325a4ead428e2b173de3c925757a6d61662c264734c7ff154b7e3a3d7810d905` | 2026-10-08T00:22:50+02:00 | `python power.py [final|dev]` |
| `out/power_final.md` | 18,793 | `90f05e63b30961b87dd09eeb531852e63400e6d7b3021c3a93552336012e97ed` | 2026-10-08T00:22:50+02:00 | `python power.py [final|dev]` |
| `out/trace.jsonl` | 69,608 | `b46fea02be8df42a24b5d58f3d6541386f9f145620fdc5d073042763547c60c4` | 2026-10-08T00:06:29+02:00 | `python calib_trace.py` |
| `out/trace.md` | 4,479 | `781a914193d642aaaaaef7b5d352cb48644a9bd2d01d72ca4beb3005e0201be8` | 2026-10-08T00:06:29+02:00 | `python calib_trace.py` |
| `out/versions.txt` | 144 | `c94ea3794834347a747e06c6dc08b0e472d85ef770834da1b11e7535741f843f` | 2026-10-08T00:12:38+02:00 | not documented in the script usage |

## v2

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/v2/` (repository path `data/research/engine/audit/v2/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T00:31:19+02:00 to 2026-10-08T01:25:38+02:00 (file modification times).
- Scripts in the registry: `controls_v2.py`, `correct_v2.py`, `fixtures_v2.py`, `power_v2.py`, `register_v2.py`.
- Documented commands: `python controls_v2.py run dev|final N`; `python correct_v2.py`; `python fixtures_v2.py`; `python power_v2.py dev|final`; `python register_v2.py amend "reason"`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `selected.json` | 2,537 | `3882d9343779af5512d4425c9d7b4885082711682e80dc73293904061c18074b` | 2026-10-08T01:25:17+02:00 | not documented in the script usage |
| `out/code_hashes.txt` | 1,655 | `295cb8def46e47827784b76dad113b6afdde6188ec586da541ac34b10b938e49` | 2026-10-08T01:25:38+02:00 | not documented in the script usage |
| `out/controls_v2_dev.jsonl` | 525,621 | `ade0ecf31abc5570779b941bb85bfd740b57f69bb65b5ab5c123e89645e9142d` | 2026-10-08T01:06:45+02:00 | `python power_v2.py dev|final` |
| `out/controls_v2_dev.log` | 20,461 | `017fc8e60d4731a725a6461a6486fd26907dac7c450ad21c0cd1a26c868e443c` | 2026-10-08T01:06:45+02:00 | `run log` |
| `out/controls_v2_dev_a0.jsonl` | 521,377 | `0b1b0852e72489abb82c1f3a7c989582531ee0c1c9c537ce5d8a548379e18866` | 2026-10-08T00:54:20+02:00 | `python power_v2.py dev|final` |
| `out/controls_v2_final.jsonl` | 6,908,938 | `20e740647693ae3bf7ae6869dc0bf96426f3d4aadc41389afb150bb59b6bb427` | 2026-10-08T01:19:45+02:00 | `python power_v2.py dev|final` |
| `out/controls_v2_final.log` | 275,820 | `3d76b61908444d63522343d2330eb92d713e593bf86203958c5ba0df04496ab0` | 2026-10-08T01:19:45+02:00 | `run log` |
| `out/corrections_v2.json` | 7,081 | `ece23b4f4318eab7a6a7ca971d39a68af608ccac6f7f412251c9ca6ce77a6276` | 2026-10-08T00:40:36+02:00 | `python correct_v2.py` |
| `out/corrections_v2.log` | 2,193 | `f079c6d5a01c15f066e9b97748964003a8a98d89f269faa271dd15f0af7043fd` | 2026-10-08T00:40:36+02:00 | `run log` |
| `out/corrections_v2.md` | 2,193 | `f079c6d5a01c15f066e9b97748964003a8a98d89f269faa271dd15f0af7043fd` | 2026-10-08T00:40:36+02:00 | `python correct_v2.py` |
| `out/fixtures_v2.txt` | 1,588 | `2c48cdd46d7012b0ab773155d4c212a67eb0742749f2fdf0321f94f0de1016fc` | 2026-10-08T00:31:19+02:00 | not documented in the script usage |
| `out/power_v2_dev.json` | 47,637 | `562aab699e86a201182f96a22f5146bc21d23f952ae6a15e9dff9de540fb1c22` | 2026-10-08T01:06:46+02:00 | `python power_v2.py dev|final` |
| `out/power_v2_dev.md` | 12,829 | `59f5f0c7d4a605ad05a7a70077e522e24453c99d32b5a02bdd7c7ac4c303b1ed` | 2026-10-08T01:06:46+02:00 | `python power_v2.py dev|final` |
| `out/power_v2_dev_a0.json` | 48,157 | `46a939b66905227fc753a20b51905613f971fe0d49e041ce21603e985972d403` | 2026-10-08T01:03:52+02:00 | `python power_v2.py dev|final` |
| `out/power_v2_dev_a0.md` | 13,352 | `dde560d90694ac66afd23c87c06a5f881aba18334e08cee181b8c439616930da` | 2026-10-08T01:03:52+02:00 | `python power_v2.py dev|final` |
| `out/power_v2_final.json` | 52,642 | `29e83b88b6258f13a7ccc529d0b1ca5f018c23209abff693a6255cc744cbe763` | 2026-10-08T01:25:17+02:00 | `python power_v2.py dev|final` |
| `out/power_v2_final.md` | 15,237 | `e69281da3e4fb88ae1f0591202bc3ee66e957e7e69c9667d490ac0d03b337588` | 2026-10-08T01:25:17+02:00 | `python power_v2.py dev|final` |

## vm40

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/vm40/` (repository path `data/research/engine/audit/vm40/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/engine/audit/tsmom36/daily.db.
- Ran: 2026-10-09T11:56:38+02:00 to 2026-10-09T11:59:51+02:00 (file modification times).
- Scripts in the registry: `posthoc.py`, `summarize.py`, `vm40.py`.
- Documented commands: `python vm40.py check`; `python vm40.py describe`; `python vm40.py register`; `python vm40.py run`.
- Modes dispatched on the first argument: `check`, `describe`, `register`, `run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `prereg_body.json` | 4,996 | `55d86e29ffeb34e66b203d76725cfa6cb385589bdfa89dc6c7d4fed4f598a644` | 2026-10-09T11:56:38+02:00 | not documented in the script usage |
| `prereg_comment.md` | 3,365 | `b0841931720194fb0861f7fc32647ffb08bb215f1719ede9955e9d34e799edf2` | 2026-10-09T11:56:54+02:00 | not documented in the script usage |
| `result_comment.md` | 4,614 | `da3d3ef89589f56d554202d9444a4a664afe94424f9d200a472e7fe16e8dcdaf` | 2026-10-09T11:59:51+02:00 | not documented in the script usage |
| `out/posthoc.json` | 8,249 | `41b27a422fea4a3dbdeea640e013e284d6a4077df472489843b5cfaead60d1da` | 2026-10-09T11:59:02+02:00 | not documented in the script usage |
| `out/results.json` | 316,043 | `06336abfc408f79468ae43bd096056eae5e1983fb6edd2c33f927cf5822f81c6` | 2026-10-09T11:58:10+02:00 | `python vm40.py run` |

## vol33

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/vol33/` (repository path `data/research/engine/audit/vol33/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: none detected in the script source.
- Ran: 2026-10-09T11:03:10+02:00 to 2026-10-09T11:08:45+02:00 (file modification times).
- Scripts in the registry: `posthoc_h3.py`, `summarize.py`, `vol33.py`.
- Documented commands: `python vol33.py check | plumb | register | amend "<reason>" | run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `prereg_body.json` | 4,345 | `f691cb5df68d09c9ce99f443237da2b94e1b700e144eed38dc91c234fd5bf15e` | 2026-10-09T11:04:30+02:00 | not documented in the script usage |
| `prereg_comment.md` | 4,486 | `f4670e2ff9cf3b54ade5fc24bc4c2c8cc9b584409b2c907b96264d2a38d73eaa` | 2026-10-09T11:04:48+02:00 | not documented in the script usage |
| `result_comment.md` | 6,124 | `1acc8c24aefb877d14ead64423186a29cad66c918394061d4c9bdeb066ef53bf` | 2026-10-09T11:08:45+02:00 | not documented in the script usage |
| `out/feat_EUR_USD_M1.npz` | 208,870,022 | `4874fb917952ff31ffc9dfbd683067e1abad10add01e2e2c935b068974209c11` | 2026-10-09T11:04:12+02:00 | not documented in the script usage |
| `out/feat_EUR_USD_M15.npz` | 14,190,212 | `e3ab240999db36706329a162b452c185097ecc24d4122b112c1f79375648d28d` | 2026-10-09T11:04:16+02:00 | not documented in the script usage |
| `out/feat_EUR_USD_M5.npz` | 42,506,812 | `dfa697ff440368f5c6560a07220f8619dd0c1bef29cc4f911c848a37d584f9df` | 2026-10-09T11:03:19+02:00 | not documented in the script usage |
| `out/feat_NATGAS_USD_M1.npz` | 134,132,567 | `4fea0dcefa25390203e6499feecc53e9e666c01b1e8b3d078355b3c39e890103` | 2026-10-09T11:03:53+02:00 | not documented in the script usage |
| `out/feat_NATGAS_USD_M15.npz` | 13,108,157 | `1e2200749d973f2f4c16a9149f6394af0e84fca046cacd02f64237bd5df63ef1` | 2026-10-09T11:04:15+02:00 | not documented in the script usage |
| `out/feat_NATGAS_USD_M5.npz` | 36,360,217 | `bb9b04baf962bb02609e94126e6e2495a201a129b57b68609113f201ea092629` | 2026-10-09T11:03:15+02:00 | not documented in the script usage |
| `out/feat_SPX500_USD_M1.npz` | 191,026,352 | `b94c1b2257e320be13c92ebb3ab5bcec0731e3b67a6261748498a0a059a9676d` | 2026-10-09T11:04:02+02:00 | not documented in the script usage |
| `out/feat_SPX500_USD_M15.npz` | 13,390,712 | `a1075e10406e3dba07d0b324eb3a76902ea6484086341ad9ee236a478ff7aff9` | 2026-10-09T11:04:16+02:00 | not documented in the script usage |
| `out/feat_SPX500_USD_M5.npz` | 40,048,317 | `e8efab352de827821c9b13e815c04f4785e786f29b8c7ab3999ad4d9b39d298e` | 2026-10-09T11:03:17+02:00 | not documented in the script usage |
| `out/feat_WTICO_USD_M1.npz` | 195,151,642 | `9431f7e7968c04cd8bc0a177f3104f0e9dd5f02e27ef0f692710e919f30354f2` | 2026-10-09T11:03:29+02:00 | not documented in the script usage |
| `out/feat_WTICO_USD_M15.npz` | 13,470,467 | `950013872300221a1b6805720cb4d12ee3f30aa0a5f7971fd5ca55d6b3166e25` | 2026-10-09T11:04:13+02:00 | not documented in the script usage |
| `out/feat_WTICO_USD_M5.npz` | 40,354,987 | `3cf4f600e6cdd17640ea39fa8bfa825a77b4ead49d8d252e3c271cdeee06f757` | 2026-10-09T11:03:10+02:00 | not documented in the script usage |
| `out/feat_XAG_USD_M1.npz` | 183,558,307 | `08912a414a88859d5d229163f40e26eba7d27c4602055871307ae4ae7baf7527` | 2026-10-09T11:03:47+02:00 | not documented in the script usage |
| `out/feat_XAG_USD_M15.npz` | 13,457,467 | `b28d7c616a9f7e38e651a27985c04edc343491952073625e3a463d30e6c1954c` | 2026-10-09T11:04:14+02:00 | not documented in the script usage |
| `out/feat_XAG_USD_M5.npz` | 39,924,427 | `3a81d31a87faca182302ef07839138f52ab3c2b2fbd7993fe4822fcce37cab98` | 2026-10-09T11:03:14+02:00 | not documented in the script usage |
| `out/feat_XAU_USD_M1.npz` | 198,963,307 | `ec01a548234591f64b7b19e9a27695f9b69b080c66db112c0a9044266a244721` | 2026-10-09T11:03:38+02:00 | not documented in the script usage |
| `out/feat_XAU_USD_M15.npz` | 13,476,187 | `5a35bd1ec6a431ff39e224f8e6321fb19b3a7f661fb89fcb8cb59ca579cbc425` | 2026-10-09T11:04:13+02:00 | not documented in the script usage |
| `out/feat_XAU_USD_M5.npz` | 40,409,912 | `227da086fa86f57a37082f2ed2c29b606cfd53474225b5e8660294b1083252b9` | 2026-10-09T11:03:12+02:00 | not documented in the script usage |
| `out/plumb.json` | 8,279 | `d17e3e2698102b2b848dc07743181ca8b2e4fb36f00c1b8480cd63054652be0b` | 2026-10-09T11:04:16+02:00 | not documented in the script usage |
| `out/posthoc_h3.json` | 28,430 | `f8c7b872122cc906268df77d4c116e872a895f5eec172be1933df72a87b6ffda` | 2026-10-09T11:07:43+02:00 | not documented in the script usage |
| `out/posthoc_h3.txt` | 1,308 | `f1f0897bb859ee1a1d1c191939e74f007f22a8dc03ad17cb94d80fff0b662360` | 2026-10-09T11:07:43+02:00 | not documented in the script usage |
| `out/report.txt` | 40,587 | `b52319574275619075cbf3c004529ae29e77145dc04020fe70f32bca535efe60` | 2026-10-09T11:07:02+02:00 | not documented in the script usage |
| `out/results.json` | 223,810 | `c3f2269d6a572191b07405fd0ecae3a02d4f442c6893c3eb50496a9cf29dfa41` | 2026-10-09T11:07:01+02:00 | not documented in the script usage |
| `out/run.log` | 7,846 | `34dfee828d84311d96e737b9c8cfc9bd5651b9f651e38b2dd99459f923e43a61` | 2026-10-09T11:05:46+02:00 | `run log` |
| `out/run2.log` | 5,826 | `e0260f8f7a8b8d5f65b0b6787c3365d88c3a0e668d4564b5048fa67537b71f66` | 2026-10-09T11:07:01+02:00 | `run log` |

## wave23

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/wave23/` (repository path `data/research/engine/audit/wave23/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T14:52:21+02:00 to 2026-10-08T14:52:51+02:00 (file modification times).
- Scripts in the registry: `summarize.py`, `wave23.py`.
- Documented commands: `python wave23.py check`; `python wave23.py register`; `python wave23.py run`; `python wave23.py today`.
- Modes dispatched on the first argument: `check`, `plumb`, `register`, `run`, `today`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `out_run.log` | 1,631 | `b8f4940c3b8dbd4afda0118eff80809d78564a875c3c46294487497acdda1626` | 2026-10-08T14:52:21+02:00 | `run log` |
| `out/results.json` | 4,216,089 | `b1fc21a88a7a3f5e752cb254399f15e6c4aabe3a8e99afe08a5bbe3afa0112d3` | 2026-10-08T14:52:21+02:00 | `python wave23.py run` |
| `out/today_WTI.json` | 967 | `d6b2291833d7d1e90fda193dcf26a5a04cad463e5e5ce37f2825508487d30d0f` | 2026-10-08T14:52:51+02:00 | `python wave23.py today` |

## xvol10

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/xvol10/` (repository path `data/research/engine/audit/xvol10/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T08:19:05+02:00 to 2026-10-08T08:19:08+02:00 (file modification times).
- Scripts in the registry: `summarize.py`, `xvol10.py`.
- Documented commands: `python xvol10.py check`; `python xvol10.py register`; `python xvol10.py run`.
- Modes dispatched on the first argument: `check`, `register`, `run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `out/report.txt` | 20,561 | `1f2345ce3152da8b47acf9ab8de6298d903c25deb27d181a672099306054d766` | 2026-10-08T08:19:08+02:00 | `python xvol10.py run` |
| `out/results.json` | 34,722 | `99173252409b4f63f65c076df3fd0220737a826470b019e62953f91e9fb660ff` | 2026-10-08T08:19:05+02:00 | `python xvol10.py run` |
| `out/run.log` | 711 | `d9c38b94d82520ade98e1bf22088c8b78e2902f4bc8d04e6b6b9dedb2e0396a4` | 2026-10-08T08:19:05+02:00 | `run log` |

## xvol9

- Local folder: `/Users/mfittko/github/market-signals/data/research/engine/audit/xvol9/` (repository path `data/research/engine/audit/xvol9/`).
- Interpreter: `data/research/engine/.venv/bin/python`. Working directory: the local folder. The scripts resolve their paths from their own location.
- Inputs read by the scripts: data/research/history.db.
- Ran: 2026-10-08T07:54:32+02:00 to 2026-10-08T07:57:12+02:00 (file modification times).
- Scripts in the registry: `cov.py`, `diag_cost.py`, `prep.py`, `summarize.py`, `xvol9.py`.
- Documented commands: `python prep.py INST [INST ...]`; `python xvol9.py check`; `python xvol9.py register`; `python xvol9.py run`.
- Modes dispatched on the first argument: `check`, `register`, `run`.

| File | Bytes | sha256 | Modified | Written by |
|---|---|---|---|---|
| `cache/BTC_USD.npz` | 148,345,890 | `4c964f5cb27f28caf0c02fcb7b31bd71fd547aecf901a3fb623d65f596e6d0cf` | 2026-10-08T07:54:53+02:00 | not documented in the script usage |
| `cache/EUR_USD.npz` | 145,586,530 | `e8fab89b2030936dbf16cb9a2fd2b26212c19dcbd729aed9b54ae37eb419ebdd` | 2026-10-08T07:54:37+02:00 | not documented in the script usage |
| `cache/NATGAS_USD.npz` | 113,572,546 | `72d6ae65323b7beb91580e5c77ba07cb5d656b0b91bcfe727ac65010b260f8a0` | 2026-10-08T07:54:35+02:00 | not documented in the script usage |
| `cache/SPX500_USD.npz` | 135,747,730 | `8ebb1b7c74ba8a698ebf2fd942fd6348193f745968b8a7e9cda5a0ec7b026c23` | 2026-10-08T07:54:36+02:00 | not documented in the script usage |
| `cache/USD_JPY.npz` | 145,724,978 | `c6c49875031b1ec01b22211fb84aa44f17e1a9eb014654e3108e0de6a691f56c` | 2026-10-08T07:54:45+02:00 | not documented in the script usage |
| `cache/WTICO_USD.npz` | 137,442,578 | `ab2a9352399e5efb8a612bce896f5598bc66895205d6412cb376740f849f47d1` | 2026-10-08T07:54:32+02:00 | not documented in the script usage |
| `cache/XAG_USD.npz` | 133,634,978 | `3e7958ec223067f799db0ecf7e5fba28826887f6e36ebe0258700831fc44c5be` | 2026-10-08T07:54:34+02:00 | not documented in the script usage |
| `cache/XAU_USD.npz` | 138,502,514 | `5b30d81c6315f9e14e2415c5e6322538d7741d6e0de04cdfaa98192656956acc` | 2026-10-08T07:54:33+02:00 | not documented in the script usage |
| `out/prep.log` | 752 | `0ec5ab3c9ad66ef95515f6513df6ebf41fe2896c9e43c3ad726db0c380758d15` | 2026-10-08T07:54:53+02:00 | `run log` |
| `out/results.json` | 70,828 | `d01a7d138198abacc085443df01f132adfb258ba16dab90315fb3aa93f02950e` | 2026-10-08T07:57:12+02:00 | `python xvol9.py run` |
| `out/run.log` | 5,349 | `f40489d60b356d518e468d511475eef0c54c0243be8d7889512d2c62e9a4ecb5` | 2026-10-08T07:57:12+02:00 | `run log` |
