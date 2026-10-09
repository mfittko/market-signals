"""Generate LOCAL-EVIDENCE.md: where every local research output lives and how it was made.

The registry in git holds protocols, comments and scripts. Run outputs, databases and raw
downloads stay on the operator machine under data/research/. This script lists them per
campaign (path, size, sha256, modification time, the documented command that writes the
file, the input databases the scripts read) and adds the database manifest.

It only reads. Run it from the repository root of a checkout that has data/research/:

    python3 -I docs/research/registry/tools/local_evidence.py
    python3 -I docs/research/registry/tools/local_evidence.py --data /path/to/data/research --no-db-stats
"""
import argparse, datetime, hashlib, os, re, sqlite3

TOOLS = os.path.dirname(os.path.abspath(__file__))
REGISTRY = os.path.dirname(TOOLS)
REPO = os.path.dirname(os.path.dirname(os.path.dirname(REGISTRY)))
SKIP_DIRS = {"__pycache__"}

# Input detection from script source: (pattern, label)
INPUTS = [
    (r"history\.db|import de_v2|from de_v2|import de\b|de\.prep|import bars|from bars|spike4", "data/research/history.db"),
    (r"tsmom36|ext39\.load|import ext39|from ext39", "data/research/engine/audit/tsmom36/daily.db"),
    (r"swing44[/\\'\"].*daily\.db|os\.path\.join\(HERE, ['\"]daily\.db", "the campaign's own daily.db"),
    (r"news24\.db|news24/", "data/research/engine/audit/news24/news24.db"),
    (r"labels\.db", "data/research/engine/audit/news28/labels.db"),
    (r"candles\.db", "data/candles.db (live engine, read-only)"),
    (r"\.dbn|databento", "Databento raw files in the campaign's raw/"),
    (r"gdeltproject|masterfilelist", "GDELT 2.0 GKG files (download)"),
    (r"fxempire", "OANDA candles through the FXEmpire proxy (download)"),
]

DATABASES = [
    ("history.db", "OANDA M1 bid/ask through the FXEmpire proxy; data/research/pipeline/history.py (daily top-up job)"),
    ("engine/audit/tsmom36/daily.db", "OANDA daily mid, 17:00 New York alignment; engine/audit/tsmom36/fetch.py"),
    ("engine/audit/swing44/daily.db", "OANDA daily mid; engine/audit/swing44/fetch.py"),
    ("engine/audit/news24/news24.db", "GDELT 2.0 GKG 15-minute files, filtered by relevance.json; engine/audit/news24/fetch.py"),
    ("engine/audit/news28/labels.db", "Seeded news24 sample labelled by the Jev model; engine/audit/news28/sample.py and label.py"),
]
TABLE_SOURCE = {
    ("history.db", "candles_dukascopy"): "Dukascopy EUR/USD M1 bid; moved once by data/research/pipeline/move_dukascopy.py",
    ("history.db", "candles_mid_legacy"): "OANDA M1 mid rows fetched before the switch to bid/ask; data/research/pipeline/schema_ba.py",
}


def sha256(path, cache={}):
    if path not in cache:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 22), b""):
                h.update(chunk)
        cache[path] = h.hexdigest()
    return cache[path]


def mtime(path):
    return datetime.datetime.fromtimestamp(os.path.getmtime(path)).astimezone().isoformat(timespec="seconds")


def usage_commands(script_dir, scripts):
    """Documented commands: (script, command text, regex of the files it writes)."""
    out = []
    for s in scripts:
        src = open(os.path.join(script_dir, s), errors="replace").read()
        for line in src.splitlines():
            m = re.search(r"python3?\s+(" + re.escape(s) + r"\s[^\n]*?)(?:\s{2,}|\s->|\s+writes\s|$)", line)
            if not m:
                continue
            cmd = "python " + m.group(1).strip().removesuffix('"""').strip()
            if cmd.count(")") > cmd.count("("):  # docstring closes a parenthesis after the command
                cmd = cmd.rstrip(".").rstrip(")")
            targets = re.findall(r"((?:out[\w-]*|cache)/[\w<>{}.,*/-]*|prereg\.json|finalists\.json)", line.split(m.group(1), 1)[1])
            pats = []
            for t in targets:
                t = t.rstrip(".,;)")
                rx = re.escape(t)
                rx = re.sub(r"\\<[^>]*\\>|<[^>]*>", r"[^/]+", rx)
                rx = re.sub(r"\\\{([^}]*)\\\}", lambda g: "(" + "|".join(g.group(1).split(",")) + ")", rx)
                rx = rx.replace(r"\*", ".*")
                if rx.endswith("/"):
                    rx += ".*"
                pats.append(re.compile("^" + rx + "$"))
            out.append((s, cmd, pats))
    return out


def modes(src):
    keys = re.findall(r"\{([^{}]*)\}\[sys\.argv\[1\]\]", src)
    return sorted({k for block in keys for k in re.findall(r"[\"'](\w+)[\"']\s*:", block)})


def campaign_section(data, cid, in_repo):
    d = os.path.join(data, "engine", "audit", cid)
    scripts = sorted(f for f in os.listdir(d) if f.endswith((".py", ".mjs")) and os.path.isfile(os.path.join(d, f)))
    srcs = {s: open(os.path.join(d, s), errors="replace").read() for s in scripts}
    allsrc = "\n".join(srcs.values())
    venvs = sorted(x for x in os.listdir(d) if x.startswith(".venv") and os.path.isdir(os.path.join(d, x)))
    py = ", ".join(f"`data/research/engine/audit/{cid}/{v}/bin/python`" for v in venvs) or "`data/research/engine/.venv/bin/python`"
    inputs = sorted({label for rx, label in INPUTS if re.search(rx, allsrc, re.I)})
    cmds = usage_commands(d, scripts)
    rows, times = [], []
    for root, dirs, files in os.walk(d):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS and not x.startswith("."))
        for f in sorted(files):
            p = os.path.join(root, f)
            rel = os.path.relpath(p, d)
            if rel in in_repo or f == ".DS_Store":
                continue
            made = [c for s, c, pats in cmds if any(rx.match(rel) for rx in pats)]
            if not made and rel.endswith((".log", ".out")):
                made = ["run log"]
            t = mtime(p)
            times.append(t)
            rows.append(f"| `{rel}` | {os.path.getsize(p):,} | `{sha256(p)}` | {t} | {'; '.join(f'`{c}`' for c in dict.fromkeys(made)) or 'not documented in the script usage'} |")
    lines = [f"## {cid}", "",
             f"- Local folder: `{d}/` (repository path `data/research/engine/audit/{cid}/`).",
             f"- Interpreter: {py}. Working directory: the local folder. The scripts resolve their paths from their own location.",
             f"- Inputs read by the scripts: {', '.join(inputs) if inputs else 'none detected in the script source'}.",
             f"- Ran: {min(times)} to {max(times)} (file modification times)." if times else "- Ran: no local output files.",
             f"- Scripts in the registry: {', '.join(f'`{s}`' for s in scripts) or 'none'}."]
    documented = list(dict.fromkeys(c for _, c, _ in cmds))
    if documented:
        lines.append("- Documented commands: " + "; ".join(f"`{c}`" for c in documented) + ".")
    m = sorted({k for s in srcs.values() for k in modes(s)})
    if m:
        lines.append("- Modes dispatched on the first argument: " + ", ".join(f"`{k}`" for k in m) + ".")
    lines += ["", "| File | Bytes | sha256 | Modified | Written by |", "|---|---|---|---|---|"] + rows + [""]
    return lines, len(rows)


def db_section(data, stats):
    lines = ["## Databases", "",
             "| Database | Bytes | sha256 | Table | Rows | Distinct instrument values | First | Last | Source and fetch |",
             "|---|---|---|---|---|---|---|---|---|"]
    for rel, source in DATABASES:
        p = os.path.join(data, rel)
        if not os.path.exists(p):
            lines.append(f"| `data/research/{rel}` | missing | | | | | | | {source} |")
            continue
        size = os.path.getsize(p)
        digest = f"`{sha256(p)}`" if size < 200_000_000 else "not computed (over 200 MB)"
        if not stats:
            lines.append(f"| `data/research/{rel}` | {size:,} | {digest} | | | | | | {source} |")
            continue
        con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
        for (t,) in con.execute("select name from sqlite_master where type='table' order by name"):
            cols = [r[1] for r in con.execute(f"pragma table_info('{t}')")]
            tc = next((c for c in ("time", "ts", "at") if c in cols), None)
            q = f"select count(*), {f'min({tc}), max({tc})' if tc else 'null, null'}"
            ic = next((c for c in ("instrument", "inst") if c in cols), None)
            q += f", count(distinct {ic})" if ic else ", null"
            n, lo, hi, ni = con.execute(q + f" from \"{t}\"").fetchone()
            src = TABLE_SOURCE.get((rel, t), source)
            lines.append(f"| `data/research/{rel}` | {size:,} | {digest} | `{t}` | {n:,} | {ni if ni is not None else ''} | {lo if lo is not None else ''} | {hi if hi is not None else ''} | {src} |")
    return lines + ["", "Times in `news24.db` and `labels.db` are minutes since 1970-01-01 UTC.", ""]


def engine_section(data, in_repo_engine):
    e = os.path.join(data, "engine")
    rows = []
    for root, dirs, files in os.walk(e):
        dirs[:] = sorted(x for x in dirs if root != e or x == "results")
        for f in sorted(files):
            p = os.path.join(root, f)
            rel = os.path.relpath(p, e)
            if rel not in in_repo_engine and f != ".DS_Store":
                rows.append(f"| `{rel}` | {os.path.getsize(p):,} | `{sha256(p)}` | {mtime(p)} |")
    return ["## Engine folder", "", f"Local folder: `{e}/` (repository path `data/research/engine/`).",
            "`trials.jsonl` is the full trial log. `QUEUE.md` is the campaign queue with every verdict. `results/` holds the outputs of the pre-audit ladder campaign.",
            "`cache/` (derived bar caches) and `.venv/` (the engine interpreter) are not listed.", "",
            "| File | Bytes | sha256 | Modified |", "|---|---|---|---|"] + rows + [""]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(REPO, "data", "research"))
    ap.add_argument("--out", default=os.path.join(REGISTRY, "LOCAL-EVIDENCE.md"))
    ap.add_argument("--no-db-stats", action="store_true", help="skip the row counts (history.db takes minutes)")
    a = ap.parse_args()
    data = os.path.abspath(a.data)
    camp_dir = os.path.join(REGISTRY, "campaigns")
    ids = sorted(os.listdir(os.path.join(data, "engine", "audit")))
    body, total = [], 0
    for cid in ids:
        repo_d = os.path.join(camp_dir, cid)
        in_repo = set()
        if os.path.isdir(repo_d):
            for root, _, files in os.walk(repo_d):
                in_repo |= {os.path.relpath(os.path.join(root, f), repo_d) for f in files}
        lines, n = campaign_section(data, cid, in_repo)
        body += lines; total += n
    ev = os.path.join(REGISTRY, "evaluator", "engine")
    in_repo_engine = set(os.listdir(ev)) if os.path.isdir(ev) else set()
    now = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    head = ["# Local evidence", "",
            "This file lists the research evidence that stays on the operator machine. Run outputs, databases and raw downloads are data, so git does not hold them.",
            f"It was generated on {now} by `docs/research/registry/tools/local_evidence.py`. Re-run that script after a new campaign.",
            f"It covers {len(ids)} campaign folders and {total:,} local files.", "",
            "Each campaign section gives the local folder, the interpreter, the inputs and the run window. Its table lists every local file that is not in the registry, with size, sha256 and modification time.",
            "The \"Written by\" column comes from the usage text in the campaign scripts. A file that no usage line names is marked \"not documented in the script usage\".", ""]
    text = "\n".join(head + db_section(data, not a.no_db_stats) + engine_section(data, in_repo_engine) + body)
    with open(a.out, "w") as fh:
        fh.write(text.rstrip() + "\n")
    print(f"{len(ids)} campaigns, {total} files -> {a.out}")


if __name__ == "__main__":
    main()
