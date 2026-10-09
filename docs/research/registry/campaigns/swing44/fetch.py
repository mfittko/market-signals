"""swing44 data: OANDA DAILY mid candles for equity indices that were not in swing43, through the same FXEmpire proxy,
URL, headers and >= 3 s throttle as audit/tsmom36/fetch.py (its get() is imported unchanged).
-> audit/swing44/daily.db (new file, same schema as tsmom36/daily.db).

usage: python fetch.py [INSTRUMENT ...]
"""
import os, sqlite3, sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "tsmom36"))
from fetch import get, COUNT  # noqa: E402  same URL, headers, PAUSE=3.0

DB = os.path.join(HERE, "daily.db")
CANDIDATES = ["FR40_EUR", "EU50_EUR", "NL25_EUR", "CH20_CHF", "ESPIX_EUR", "SG30_SGD", "CN50_USD", "IN50_USD",
              "TWIX_USD", "US2000_USD", "CHINAH_HKD", "JP225Y_JPY"]


def main():
    db = sqlite3.connect(DB)
    db.execute("CREATE TABLE IF NOT EXISTS daily (instrument TEXT, cls TEXT, time TEXT, o REAL, h REAL, l REAL, c REAL, "
               "volume REAL, PRIMARY KEY (instrument, time))")
    db.execute("CREATE TABLE IF NOT EXISTS fetch_log (instrument TEXT PRIMARY KEY, cls TEXT, status TEXT, rows INTEGER, "
               "first TEXT, last TEXT, fetched_at TEXT)")
    want = set(sys.argv[1:])
    for inst in CANDIDATES:
        if want and inst not in want:
            continue
        frm, n, status = datetime(2000, 1, 1, tzinfo=timezone.utc), 0, "ok"
        while True:
            rows = get(inst, frm)
            if rows is None:
                status = "not served"
                break
            done = [r for r in rows if r.get("complete")]
            db.executemany("INSERT OR REPLACE INTO daily VALUES (?,?,?,?,?,?,?,?)", [
                (inst, "index", r["time"][:19], *(float(r["mid"][k]) for k in "ohlc"), float(r.get("volume", 0)))
                for r in done])
            db.commit()
            n += len(done)
            if len(rows) < COUNT or not done:
                break
            frm = datetime.strptime(done[-1]["time"][:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc) + timedelta(hours=1)
        if n == 0 and status == "ok":
            status = "empty"
        first, last = db.execute("SELECT min(time), max(time) FROM daily WHERE instrument=?", (inst,)).fetchone()
        db.execute("INSERT OR REPLACE INTO fetch_log VALUES (?,?,?,?,?,?,?)",
                   (inst, "index", status, n, first, last, datetime.now(timezone.utc).isoformat(timespec="seconds")))
        db.commit()
        print(f"{inst} {status} rows={n} {first} .. {last}", flush=True)


if __name__ == "__main__":
    main()
