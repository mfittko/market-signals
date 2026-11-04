"""Stream GDELT 2.0 GKG 15-min files (serial, polite delay, resume-safe), keep only the rows relevant to the
instruments in relevance.json, plus the per-file total row count. Store: news24.db (this directory).
File list: a 4-hourly baseline grid (00,04,..,20 UTC file timestamps) from 2018-12-01, then the files needed by
the event candidates (cache/needed_<TF>.npy, M5 and M15 first, then M1). Usage: python fetch.py [--max N]"""
import os, sys, time, sqlite3, zipfile, io, hashlib, fcntl, http.client, datetime as dt
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
import relevance as rel

DB = os.path.join(HERE, "news24.db")
MASTER = os.path.join(HERE, "raw", "masterfilelist.txt")
DELAY = 0.5
GRID_START = np.datetime64("2018-12-01", "m").astype(np.int64)


def ts_of(name):  # '20230315120000' -> epoch minutes
    return int(np.datetime64(dt.datetime.strptime(name[:14], "%Y%m%d%H%M%S"), "m").astype(np.int64))


def master():
    M = {}
    for line in open(MASTER, errors="replace"):
        p = line.split()
        if len(p) == 3 and p[2].endswith(".gkg.csv.zip"):
            M[ts_of(p[2].rsplit("/", 1)[-1])] = (int(p[0]), p[1], p[2].replace("http://", "https://"))
    return M


def plan():
    now = int(np.datetime64("now", "m").astype(np.int64)) // 15 * 15
    grid = list(range(GRID_START, now, 240))
    order = []
    for part in (grid, np.load(os.path.join(HERE, "cache", "needed_M5.npy")).tolist(),
                 np.load(os.path.join(HERE, "cache", "needed_M15.npy")).tolist(),
                 np.load(os.path.join(HERE, "cache", "needed_M1.npy")).tolist()):
        order += sorted(part)
    seen, out = set(), []
    for t in order:
        if t not in seen:
            seen.add(t); out.append(t)
    return out


def init(con):
    con.execute("create table if not exists files(ts integer primary key, status text, total integer, "
                + ", ".join(f"{i} integer" for i in rel.INSTS) + ", bytes integer, fetched text)")
    con.execute("create table if not exists rows(ts integer, inst text, url text, themes text)")
    con.execute("create index if not exists rows_ts on rows(ts)")


class Getter:
    def __init__(self):
        self.c = None

    def get(self, url):
        host, path = url.split("/", 3)[2], "/" + url.split("/", 3)[3]
        for attempt in range(2):
            try:
                if self.c is None:
                    self.c = http.client.HTTPSConnection(host, timeout=120)
                self.c.request("GET", path, headers={"User-Agent": "market-signals-research (serial, polite)"})
                r = self.c.getresponse()
                body = r.read()
                return r.status, body
            except (http.client.HTTPException, OSError):
                self.c = None
                if attempt:
                    raise


def process(body):
    z = zipfile.ZipFile(io.BytesIO(body))
    raw = z.read(z.namelist()[0]).decode("utf-8", "replace")
    total, cnt, keep = 0, {i: 0 for i in rel.INSTS}, []
    for line in raw.split("\n"):
        row = rel.parse(line)
        if row is None:
            continue
        total += 1
        hit = rel.match(row)
        for inst in hit:
            cnt[inst] += 1
        if hit:
            keep.append((",".join(hit), row[0][:300], ";".join(sorted(row[1]))[:400]))
    return total, cnt, keep


def main():
    lock = open(os.path.join(HERE, ".fetch.lock"), "w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    mx = int(sys.argv[sys.argv.index("--max") + 1]) if "--max" in sys.argv else 10 ** 9
    M = master()
    con = sqlite3.connect(DB); init(con)
    done = set(r[0] for r in con.execute("select ts from files"))
    todo = [t for t in plan() if t not in done]
    print("todo", len(todo), "done", len(done), flush=True)
    G = Getter(); back = 15; n = 0; t0 = time.time()
    for t in todo[:mx]:
        now = dt.datetime.now(dt.UTC).isoformat()[:19]
        if t not in M:
            con.execute("insert into files(ts, status, fetched) values(?, 'missing', ?)", (t, now)); con.commit()
            continue
        size, md5, url = M[t]
        while True:
            try:
                st, body = G.get(url)
            except Exception as ex:
                st, body = -1, str(ex).encode()
            if st == 200 and hashlib.md5(body).hexdigest() == md5:
                back = 15
                break
            if st == 404:
                break
            print("retry", t, st, body[:120], "sleep", back, flush=True)
            time.sleep(back); back = min(back * 2, 1800)
        if st == 404:
            con.execute("insert into files(ts, status, fetched) values(?, 'http404', ?)", (t, now)); con.commit()
            continue
        try:
            total, cnt, keep = process(body)
            status = "ok"
        except Exception as ex:
            total, cnt, keep, status = 0, {i: None for i in rel.INSTS}, [], "bad:" + str(ex)[:80]
        con.execute(f"insert into files values(?, ?, ?, {','.join('?' * len(rel.INSTS))}, ?, ?)",
                    (t, status, total, *[cnt[i] for i in rel.INSTS], len(body), now))
        con.executemany("insert into rows values(?, ?, ?, ?)", [(t, *k) for k in keep])
        con.commit()
        n += 1
        if n % 200 == 0:
            print(f"{n} files, {time.time() - t0:.0f}s, last {np.datetime64(t, 'm')}, db {os.path.getsize(DB) / 1e6:.0f} MB", flush=True)
        time.sleep(DELAY)
    print("finished", n, flush=True)


if __name__ == "__main__":
    main()
