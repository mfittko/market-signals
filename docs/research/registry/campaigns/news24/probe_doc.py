"""Probe the GDELT DOC 2.0 timeline API: coverage back to 2019 and time resolution per span."""
import sys, time, urllib.request, urllib.parse, json
def get(q, s, e, mode="timelinevolraw"):
    u = "https://api.gdeltproject.org/api/v2/doc/doc?" + urllib.parse.urlencode(
        dict(query=q, mode=mode, format="json", startdatetime=s, enddatetime=e))
    with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "market-signals-research"}), timeout=120) as r:
        return r.read().decode("utf-8", "replace")
q, s, e, wait = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
time.sleep(wait)
t0 = time.time()
try:
    t = get(q, s, e)
    d = json.loads(t)["timeline"][0]["data"]
    print(q, s, e, "points", len(d), d[:2], d[-1], f"{time.time()-t0:.1f}s")
except Exception as ex:
    print("ERR", ex)
