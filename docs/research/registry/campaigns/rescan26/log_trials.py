"""Append one trials.jsonl record per rescan26 row and window (POST-HOC re-scoring)."""
import os, sys, json, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ENG)
import de_v2 as de  # noqa: E402

sha = {f: hashlib.sha256(open(os.path.join(HERE, f), "rb").read()).hexdigest() for f in ("stats.py", "x_stored.py", "x_recompute.py")}
R = json.load(open(os.path.join(HERE, "out", "results.json")))["rows"]
n = 0
for r in R:
    for w in ("dev", "w2023"):
        if not r[w]:
            continue
        de.log_trial({"exp": "rescan26", "posthoc": True, "campaign": r["camp"], "variant": r["variant"], "unit": r["inst"], "window": w,
                      "n": r[w]["n"], "gross": r[w]["gross"][0], "gross_ci": r[w]["gross"][1:], "net": r[w]["net"][0],
                      "holds_gross": r["HOLDS_GROSS"], "holds_gross_holm": r.get("HOLDS_GROSS_HOLM", False),
                      "mode": "dev" if w == "dev" else "devwindow2023", "rescan26_sha256": sha})
        n += 1
print("logged", n)
