"""Label the sample with Jev. Throttled (<= 2 requests/s), backoff on 429/529, resume-safe (skips labelled rows).
Usage: python label.py single           one request per sample row (mode 'single')
       python label.py batch N [N ...]  batch-size probe on WTI rows 0..N-1 (mode 'batchN'), compared with 'single'
       python label.py reask            second look: rows whose single label is not_relevant with confidence >= 0.9,
                                         re-asked with an independent wording (mode 'reask')"""
import os, sys, time, sqlite3, datetime as dt, json
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import jev

DB = os.path.join(HERE, "labels.db")
GAP = 0.5  # seconds between request starts
LOG = os.path.join(HERE, "out", "jev_calls.jsonl")
_last = [0.0]


def call(fn, *a):
    """Throttle + retry on rate limit. Logs each call (no key, no payload)."""
    back = 2
    while True:
        w = _last[0] + GAP - time.time()
        if w > 0:
            time.sleep(w)
        _last[0] = time.time()
        t0 = time.time()
        try:
            r = fn(*a)
            ev = {"ok": True}
        except jev.RateLimited as e:
            ev = {"ok": False, "rate_limited": str(e)}
        except ValueError:  # HTTP 4xx other than 429: a bad request, never retried
            open(LOG, "a").write(json.dumps({"ok": False, "fatal": True, "at": dt.datetime.now(dt.UTC).isoformat()[:19], "fn": fn.__name__}) + "\n")
            raise
        except Exception as e:  # network or answer-shape error
            ev = {"ok": False, "error": str(e)[:200]}
        ev.update(at=dt.datetime.now(dt.UTC).isoformat()[:19], fn=fn.__name__, s=round(time.time() - t0, 2))
        open(LOG, "a").write(json.dumps(ev) + "\n")
        if ev["ok"]:
            return r
        print("retry", ev, "sleep", back, flush=True)
        time.sleep(back); back = min(back * 2, 300)


REASK = {"relevant": {
    "type": "choice",
    "instructions": "You see a news article only as its URL words and machine topic tags. Decide what the article is mainly about, then "
                    "decide if a professional trader of the target market would read it for trading.",
    "criteria": {"relevant": "Yes: its main subject bears on the target market's price",
                 "not_relevant": "No: its main subject is unrelated to the target market's price"}}}


def reask(inst, url, themes):
    j, _ = jev.post({"model": jev.MODEL, "state": jev.state(inst, url, themes), "questions": REASK})
    a = j["answers"]["relevant"]
    return a["choice"], float(a["probabilities"]["relevant"]), a.get("confidence"), j.get("model")


def put(con, inst, rid, mode, r):
    con.execute("insert or replace into labels values(?,?,?,?,?,?,?,?)", (inst, rid, mode, *r[:3], r[3] if len(r) > 3 else None,
                                                                         dt.datetime.now(dt.UTC).isoformat()[:19]))
    con.commit()


if __name__ == "__main__":
    con = sqlite3.connect(DB)
    mode = sys.argv[1]
    if mode in ("single", "reask"):
        if mode == "single":
            todo = con.execute("select s.inst, s.rid, s.url, s.themes from sample s left join labels l on l.inst=s.inst and l.rid=s.rid "
                               "and l.mode='single' where l.rid is null order by s.k, s.inst").fetchall()
        else:
            todo = con.execute("select s.inst, s.rid, s.url, s.themes from sample s join labels l on l.inst=s.inst and l.rid=s.rid "
                               "and l.mode='single' left join labels r on r.inst=s.inst and r.rid=s.rid and r.mode='reask' "
                               "where l.choice='not_relevant' and l.conf >= 0.9 and r.rid is null order by s.k, s.inst").fetchall()
        fn = jev.ask if mode == "single" else reask
        print("todo", len(todo), flush=True)
        for n, (inst, rid, u, th) in enumerate(todo):
            put(con, inst, rid, mode, call(fn, inst, u, th))
            if n % 200 == 0:
                print(n, flush=True)
    elif mode == "batch":
        rows = con.execute("select rid, url, themes from sample where inst='WTICO_USD' order by k").fetchall()
        for size in map(int, sys.argv[2:]):
            t0 = time.time()
            res, meta = call(jev.ask_batch, "WTICO_USD", [(u, th) for _, u, th in rows[:size]])
            print("batch", size, f"{time.time() - t0:.1f}s", meta, flush=True)
            for (rid, _, _), r in zip(rows, res):
                put(con, "WTICO_USD", rid, f"batch{size}", (*r, meta.get("model")))
