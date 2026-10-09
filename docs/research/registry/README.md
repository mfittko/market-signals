# Registry

This folder is the reproducibility layer of the research. It holds what a rerun needs from git: the registered protocols and amendments, the campaign scripts, the evaluator v2 code, the trial counts, the raw-data manifest and the list of local evidence. The interpretation lives one level up in [../README.md](../README.md). The result comments on GitHub are the primary record; [../campaigns.md](../campaigns.md) links them.

## Layout

| Path | Content |
|---|---|
| `campaigns/<id>/prereg.json` | Registered protocol. pprofit20 also has `prereg_m1.json`, `prereg_m15.json`, `prereg_m1_iso.json` and `prereg_horizons.json`. |
| `campaigns/<id>/*amendment*.json` | Amendments (lean22, news24). vol33 keeps its amendments inside `prereg.json`. |
| `campaigns/<id>/*.py`, `*.mjs` | Analysis, fetch and summary scripts, each under 60 KB. |
| `evaluator/` | Evaluator v2 code, byte-identical to the frozen version, with `SHA256SUMS`. |
| `trials-summary.csv` | Trial row counts per campaign (42,810 rows through trend49). |
| `manifests/databento-raw.sha256` | sha256 of the 26 Databento raw files of flow29, flow42 and cmd41. |
| `LOCAL-EVIDENCE.md` | Every local output file with path, size, sha256, modification time and the documented command that writes it, plus the database manifest. |
| `tools/local_evidence.py` | Regenerates `LOCAL-EVIDENCE.md`. It only reads. |

Every `prereg.json` records a timezone-explicit `created` timestamp and the sha256 of the code it runs (field `code_sha256`; cal37 uses `sha256`, flow29 and flow42 use `file_sha256`). Target definitions are part of each protocol. The ladder targets and trade management are in `evaluator/engine/labels_v2.py` (`POLICY`, `simulate`). T2 is defined in `campaigns/ablate4/prereg.json`, A1 in `campaigns/abs11/prereg.json`.

## Evaluator v2

Evaluator v2 is `de_v2.py` with the modules it imports. Variant V4 of the registered E redesign was selected on 2026-10-08T01:25:17+0200; the selection record is the local `selected.json` of v2 (see `LOCAL-EVIDENCE.md`).

The digest is `1b66053da304e13ab2539fef82f3ce31f180d1a5478e991a34985f294b72c6bb`: the sha256 of the JSON map `{file: sha256}` over the ten files in `evaluator/SHA256SUMS`, serialized with `json.dumps(files, sort_keys=True)`. `de_v2.code_sha256()` computes it. `evaluator/` keeps the source layout, so `../modellab/spike4/data.py` resolves.

```sh
cd docs/research/registry/evaluator/engine
shasum -a 256 -c ../SHA256SUMS
```

Campaigns bench1 to legs27 (except lean21, wave23 and news24) and abs48 log `evaluator: "v2"` and the digest in every trial row. From news24 on, campaigns use their own scripts with the shared `validate.py` (same hash as in v2).

## Rerun

1. Restore the databases listed in [../data.md](../data.md), or rebuild them with the named fetch scripts. Check the sha256 values in `LOCAL-EVIDENCE.md` where given. `history.db` grows daily, so cut it at the campaign's run date.
2. Place `evaluator/engine/` and `evaluator/modellab/spike4/` as `data/research/engine/` and `data/research/modellab/spike4/`. Check `SHA256SUMS`.
3. Copy the scripts from `campaigns/<id>/` to `data/research/engine/audit/<id>/`. Compare their sha256 with the hashes in `prereg.json`.
4. Run them with the interpreter and commands that `LOCAL-EVIDENCE.md` lists for the campaign.
5. Compare the outputs with the sha256 values in `LOCAL-EVIDENCE.md` and with the result comment.

Refresh `LOCAL-EVIDENCE.md` from the repository root of a checkout that has `data/research/`:

```sh
python3 -I docs/research/registry/tools/local_evidence.py
```

## What stays local

`LOCAL-EVIDENCE.md` lists each of these files with its sha256.

- Every file under an `out/` folder and every other run output: JSON, CSV, TXT, logs, parquet, npz, pkl and trade lists.
- The v1 and v2 control, fixture, power and correction outputs, and `v2/selected.json`.
- Generated or fitted inputs next to the scripts: `cal37/fomc_dates.json`, `news24/relevance.json`, `news28/relevance28.json`, `v1/controls_registry_*.json`, the bench1 environment freezes and the Databento `fetch_log.jsonl` files.
- The local copies of posted comments (`prereg_comment.md`, `result_comment.md`, `comment.md`, `v1/REPORT.md`). The GitHub comments are the record.
- Databases, raw downloads and caches.
- `trials.jsonl` and `QUEUE.md`.
- `bench1/ts2vec_src/` (vendored upstream TS2Vec code) and the virtual environments of bench1 and fm2.
- The pre-audit ladder code and outputs in `data/research/engine/` (`de.py`, `labels.py`, `frozen*.json`, `results/`).
- `prereg_body.json` (the posted subset of `prereg.json`) and `pprofit20/prereg_draft*.json` (drafts replaced before any outcome).
