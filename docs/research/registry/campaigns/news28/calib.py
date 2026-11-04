"""Calibration of Jev junk labels and bulk-pass projection. Reads labels.db, out/jev_calls.jsonl, out/urlstats.json.
Writes out/calib.json."""
import os, json, sqlite3
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))

if __name__ == "__main__":
    con = sqlite3.connect(os.path.join(HERE, "labels.db"))
    out = {"reask": {}, "batch_vs_single": {}}
    q = ("select s.inst, s.conf, r.choice from labels s join labels r on r.inst=s.inst and r.rid=s.rid and r.mode='reask' "
         "where s.mode='single' and s.choice='not_relevant' and s.conf >= 0.9")
    rows = con.execute(q).fetchall()
    for name, f in (("all", lambda r: True), ("conf>=0.99", lambda r: r[1] >= 0.99), ("0.9<=conf<0.99", lambda r: r[1] < 0.99)):
        x = [r for r in rows if f(r)]
        out["reask"][name] = {"n": len(x), "reask_junk_too": round(sum(r[2] == "not_relevant" for r in x) / len(x), 3) if x else None}
    for i in sorted({r[0] for r in rows}):
        x = [r for r in rows if r[0] == i]
        out["reask"][i] = {"n": len(x), "reask_junk_too": round(sum(r[2] == "not_relevant" for r in x) / len(x), 3)}
    for m, n, a, hb in con.execute("select b.mode, count(*), sum(b.choice=s.choice), sum(b.conf>=0.9 and s.conf>=0.9 and b.choice=s.choice) * 1.0 / "
                                   "max(1, sum(b.conf>=0.9 and s.conf>=0.9)) from labels b join labels s on s.inst=b.inst and s.rid=b.rid "
                                   "and s.mode='single' where b.mode like 'batch%' group by 1"):
        out["batch_vs_single"][m] = {"n": n, "agree": round(a / n, 3), "agree_both_conf>=0.9": round(hb, 3)}
    conf = np.array([r[0] for r in con.execute("select conf from labels where mode='single' and choice='not_relevant'")])
    out["single_junk_conf_share"] = {"n": len(conf), ">=0.9": round(float((conf >= 0.9).mean()), 3), ">=0.99": round(float((conf >= 0.99).mean()), 3)}
    calls = [json.loads(l) for l in open(os.path.join(HERE, "out", "jev_calls.jsonl"))]
    ok = [c for c in calls if c.get("ok")]
    s = np.array([c["s"] for c in ok if c["fn"] in ("ask", "reask")])
    out["calls"] = {"total": len(calls), "ok": len(ok), "rate_limited": sum("rate_limited" in c for c in calls),
                    "errors": sum(("error" in c) or c.get("fatal", False) for c in calls),
                    "single_latency_s_p50_p95": [round(float(np.median(s)), 2), round(float(np.percentile(s, 95)), 2)]}
    U = json.load(open(os.path.join(HERE, "out", "urlstats.json")))
    pairs = U["url_inst_pairs"] - sum(U["noslug_rows"].values())  # readable (url, instrument) pairs, approx (rows ~ distinct urls)
    tok_single, tok_b100 = (491, 40), (24083 / 100, 3760 / 100)
    out["projection"] = {"readable_pairs": pairs, "distinct_urls": U["distinct_urls_all"], "noslug_urls": U["distinct_noslug_all"],
                         "single": {"requests": pairs, "hours_at_2rps": round(pairs / 2 / 3600, 1),
                                    "tokens_in_B": round(pairs * tok_single[0] / 1e9, 2), "tokens_out_B": round(pairs * tok_single[1] / 1e9, 2)},
                         "batch100": {"requests": -(-pairs // 100), "hours_at_2rps": round(pairs / 100 / 2 / 3600, 1),
                                      "tokens_in_B": round(pairs * tok_b100[0] / 1e9, 2), "tokens_out_B": round(pairs * tok_b100[1] / 1e9, 2)}}
    json.dump(out, open(os.path.join(HERE, "out", "calib.json"), "w"), indent=1)
    print(json.dumps(out, indent=1))
