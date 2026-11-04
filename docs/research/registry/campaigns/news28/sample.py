"""Seeded random sample of news24 store rows, 1,000 per instrument, read-only from news24.db, into labels.db (table sample).
A row tagged with several instruments can enter several instrument samples. Usage: python sample.py"""
import os, sqlite3
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "news24", "news24.db")
DB = os.path.join(HERE, "labels.db")
INSTS = ["WTICO_USD", "XAU_USD", "XAG_USD", "EUR_USD", "SPX500_USD", "NATGAS_USD"]
N, SEED = 1000, 28


def init(con):
    con.execute("create table if not exists sample(inst text, k integer, rid integer, ts integer, url text, themes text, tags text, "
                "primary key(inst, k))")
    con.execute("create table if not exists labels(inst text, rid integer, mode text, choice text, p_rel real, conf real, "
                "model text, at text, primary key(inst, rid, mode))")


if __name__ == "__main__":
    src = sqlite3.connect(f"file:{SRC}?mode=ro", uri=True)
    con = sqlite3.connect(DB); init(con)
    if con.execute("select count(*) from sample").fetchone()[0]:
        raise SystemExit("sample exists; not redrawn")
    hi = src.execute("select max(rowid) from rows").fetchone()[0]
    rng = np.random.default_rng(SEED)
    got = {i: [] for i in INSTS}; seen = {i: set() for i in INSTS}
    while min(len(v) for v in got.values()) < N:
        for rid in rng.integers(1, hi + 1, 20000).tolist():
            r = src.execute("select ts, inst, url, themes from rows where rowid=?", (rid,)).fetchone()
            if r is None:
                continue
            for i in r[1].split(","):
                if len(got[i]) < N and r[2] not in seen[i]:
                    seen[i].add(r[2]); got[i].append((rid, *r))
    for i in INSTS:
        con.executemany("insert into sample values(?,?,?,?,?,?,?)", [(i, k, rid, ts, u, th, tags) for k, (rid, ts, tags, u, th) in enumerate(got[i])])
    con.commit()
    print({i: len(v) for i, v in got.items()}, "max rowid", hi)
