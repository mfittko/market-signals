"""flow29 Databento fetch: CL front-month trades, GLBX.MDP3, monthly chunks, resume-safe.

Usage:
  fetch.py quote                 cost of CL.c.0 and CL.v.0 for the full window (no billing)
  fetch.py download <symbol>     download missing monthly chunks into raw/ (billed once per chunk)

The API key comes only from the DATABENTO_API_KEY environment variable. It is never printed.
"""
import json
import os
import sys
import time

import databento as db

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
LOG = os.path.join(HERE, "fetch_log.jsonl")
DATASET, SCHEMA, STYPE = "GLBX.MDP3", "trades", "continuous"
START, END = "2025-10-01", "2026-10-08T23:00"  # end exclusive; licence limit ends before 2026-10-08T23:21 UTC


def months():
    y, m = 2025, 10
    out = []
    while (y, m) < (2026, 11):
        ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
        s = f"{y:04d}-{m:02d}-01"
        e = min(f"{ny:04d}-{nm:02d}-01", END)
        out.append((s, e))
        y, m = ny, nm
    return out


def log(rec):
    with open(LOG, "a") as f:
        f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), **rec}) + "\n")


def main():
    client = db.Historical()  # reads DATABENTO_API_KEY
    mode = sys.argv[1]
    if mode == "quote":
        for sym in ("CL.c.0", "CL.v.0"):
            cost = client.metadata.get_cost(dataset=DATASET, schema=SCHEMA, symbols=[sym],
                                            stype_in=STYPE, start=START, end=END)
            size = client.metadata.get_billable_size(dataset=DATASET, schema=SCHEMA, symbols=[sym],
                                                     stype_in=STYPE, start=START, end=END)
            rec = {"mode": "quote", "symbol": sym, "start": START, "end": END, "cost_usd": cost, "bytes": size}
            log(rec)
            print(json.dumps(rec))
        return
    sym = sys.argv[2]
    os.makedirs(RAW, exist_ok=True)
    total = 0.0
    for s, e in months():
        path = os.path.join(RAW, f"{sym}_{s[:7]}.dbn.zst")
        if os.path.exists(path):  # finished chunks are never re-downloaded
            print("skip", path)
            continue
        cost = None
        for attempt in range(5):  # get_cost is free; retry gateway timeouts
            try:
                cost = client.metadata.get_cost(dataset=DATASET, schema=SCHEMA, symbols=[sym],
                                                stype_in=STYPE, start=s, end=e)
                break
            except db.BentoServerError:
                time.sleep(10 * (attempt + 1))
        tmp = path + ".part"
        client.timeseries.get_range(dataset=DATASET, schema=SCHEMA, symbols=[sym], stype_in=STYPE,
                                    start=s, end=e, path=tmp)
        os.replace(tmp, path)
        total += cost or 0.0
        rec = {"mode": "download", "symbol": sym, "start": s, "end": e, "cost_usd": cost,
               "bytes": os.path.getsize(path), "file": os.path.basename(path)}
        log(rec)
        print(json.dumps(rec))
    print(json.dumps({"session_cost_usd": total}))


if __name__ == "__main__":
    main()
