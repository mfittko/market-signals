"""flow42 Databento fetch: CL.v.0 trades, GLBX.MDP3, 2024-10-01 .. 2025-10-01 (end exclusive), monthly chunks.

Usage:
  fetch.py quote      full-window and per-month cost (free)
  fetch.py download   download missing monthly chunks into raw/; refuses existing files; stops if the total quote > CAP

Same dataset/schema/symbol/stype as flow29 (audit/flow29/fetch.py). The key comes only from DATABENTO_API_KEY.
"""
import json, os, sys, time
import databento as db

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
LOG = os.path.join(HERE, "fetch_log.jsonl")
DATASET, SCHEMA, STYPE, SYM = "GLBX.MDP3", "trades", "continuous", "CL.v.0"
START, END, CAP = "2024-10-01", "2025-10-01", 35.0
MONTHS = [f"{2024 + (9 + i) // 12:04d}-{(9 + i) % 12 + 1:02d}-01" for i in range(13)]  # 2024-10-01 .. 2025-10-01


def log(rec):
    with open(LOG, "a") as f:
        f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), **rec}) + "\n")


def cost(client, s, e):
    for attempt in range(6):  # get_cost is free; retry gateway timeouts (504)
        try:
            return client.metadata.get_cost(dataset=DATASET, schema=SCHEMA, symbols=[SYM], stype_in=STYPE, start=s, end=e)
        except db.BentoServerError:
            time.sleep(10 * (attempt + 1))
    raise SystemExit("get_cost failed after retries")


def main():
    client = db.Historical()
    total = cost(client, START, END)
    log({"mode": "quote", "symbol": SYM, "start": START, "end": END, "cost_usd": total})
    print("quote", round(total, 4))
    if total > CAP:
        sys.exit(f"quote {total} exceeds cap {CAP}; stop")
    if sys.argv[1] != "download":
        return
    os.makedirs(RAW, exist_ok=True)
    billed = 0.0
    for s, e in zip(MONTHS[:-1], MONTHS[1:]):
        path = os.path.join(RAW, f"{SYM}_{s[:7]}.dbn.zst")
        if os.path.exists(path):
            print("exists, never re-downloaded:", os.path.basename(path)); continue
        c = cost(client, s, e)
        tmp = path + ".part"
        client.timeseries.get_range(dataset=DATASET, schema=SCHEMA, symbols=[SYM], stype_in=STYPE, start=s, end=e, path=tmp)
        os.replace(tmp, path)
        billed += c
        log({"mode": "download", "symbol": SYM, "start": s, "end": e, "cost_usd": c, "bytes": os.path.getsize(path),
             "file": os.path.basename(path)})
        print(s, round(c, 4))
    print("session billed (sum of per-month quotes)", round(billed, 4))


if __name__ == "__main__":
    main()
