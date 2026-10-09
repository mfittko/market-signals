"""Read-only census of news24.db rows: rows and distinct URLs per instrument, and URLs without a readable slug
(fewer than 2 alphabetic words of length >= 3 in the path, e.g. biztoc.com/x/<hash>). Writes out/urlstats.json."""
import os, sys, json, sqlite3, re
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from jev import slug

SRC = os.path.join(HERE, "..", "news24", "news24.db")


def readable(url):
    return len([w for w in slug(url)[1].split() if re.fullmatch(r"[a-z]{3,}", w)]) >= 2


if __name__ == "__main__":
    assert readable("https://www.reuters.com/business/energy/oil-prices-jump") and not readable("https://biztoc.com/x/8f2a9c1d0e7b6a54")
    con = sqlite3.connect(f"file:{SRC}?mode=ro", uri=True)
    rows, urls, noslug_rows = {}, {}, {}
    allu, alln = set(), set()
    for tags, url in con.execute("select inst, url from rows"):
        r = readable(url)
        for i in tags.split(","):
            rows[i] = rows.get(i, 0) + 1
            urls.setdefault(i, set()).add(url)
            noslug_rows[i] = noslug_rows.get(i, 0) + (not r)
        allu.add(url)
        if not r:
            alln.add(url)
    out = {"rows": rows, "distinct_urls": {i: len(s) for i, s in urls.items()}, "noslug_rows": noslug_rows,
           "distinct_urls_all": len(allu), "distinct_noslug_all": len(alln),
           "url_inst_pairs": sum(len(s) for s in urls.values())}
    json.dump(out, open(os.path.join(HERE, "out", "urlstats.json"), "w"), indent=1)
    print(json.dumps(out, indent=1))
