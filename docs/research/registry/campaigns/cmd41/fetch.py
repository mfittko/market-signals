"""cmd41 Databento fetch: daily OHLCV (ohlcv-1d), GLBX.MDP3, volume-ranked front month, 10 commodities.

Usage:
  fetch.py quote      cost per symbol for the full window (free, no billing)
  fetch.py download   one billed request for all 10 symbols into raw/ (refuses if the file exists or cost > CAP)

The API key comes only from DATABENTO_API_KEY. It is never printed.
Bars carry instrument_id (the underlying contract), so rolls are known per bar; the
continuous -> contract mapping is kept from the DBN metadata in raw/symbology.json.
"""
import json, os, sys, time
import databento as db

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
LOG = os.path.join(HERE, "fetch_log.jsonl")
DATASET, SCHEMA, STYPE = "GLBX.MDP3", "ohlcv-1d", "continuous"
SYMS = ["HO.v.0", "RB.v.0", "PA.v.0", "LE.v.0", "HE.v.0", "ZL.v.0", "ZM.v.0", "KE.v.0", "ZO.v.0", "GF.v.0"]
START, END = "2010-06-06", os.environ.get("CMD41_END", "2026-10-09")  # end exclusive: last bar 2026-10-08
CAP = 2.0
FILE = os.path.join(RAW, "ohlcv1d_10.dbn.zst")


def log(rec):
    with open(LOG, "a") as f:
        f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), **rec}) + "\n")


def cost(client, syms):
    for attempt in range(6):  # get_cost is free; retry gateway timeouts
        try:
            return client.metadata.get_cost(dataset=DATASET, schema=SCHEMA, symbols=syms, stype_in=STYPE, start=START, end=END)
        except db.BentoServerError:
            time.sleep(10 * (attempt + 1))
    raise SystemExit("get_cost failed after retries")


def main():
    client = db.Historical()
    if sys.argv[1] == "quote":
        tot = 0.0
        for s in SYMS:
            c = cost(client, [s]); tot += c
            log({"mode": "quote", "symbol": s, "start": START, "end": END, "cost_usd": c}); print(s, round(c, 4))
        allc = cost(client, SYMS)
        log({"mode": "quote", "symbol": "ALL", "start": START, "end": END, "cost_usd": allc})
        print("sum", round(tot, 4), "one request", round(allc, 4))
        return
    if os.path.exists(FILE):
        sys.exit("already downloaded; never re-download")
    c = cost(client, SYMS)
    if c > CAP:
        sys.exit(f"cost {c} exceeds cap {CAP}")
    tmp = FILE + ".part"
    store = client.timeseries.get_range(dataset=DATASET, schema=SCHEMA, symbols=SYMS, stype_in=STYPE, start=START, end=END, path=tmp)
    os.replace(tmp, FILE)
    json.dump({"mappings": store.metadata.mappings, "symbols": SYMS, "start": START, "end": END},
              open(os.path.join(RAW, "symbology.json"), "w"), indent=1, default=str)
    log({"mode": "download", "symbols": SYMS, "start": START, "end": END, "cost_usd": c, "bytes": os.path.getsize(FILE)})
    print("downloaded", os.path.getsize(FILE), "bytes, cost", c)


if __name__ == "__main__":
    main()
