"""Precision of the news24 rule per instrument on the Jev-labelled sample, and which themes / URL tokens carry the junk.
'sole' = rows whose only news24-rule theme hit for the instrument is that theme (rows matched by URL/org/person rules
cannot be split this way; the store keeps no orgs/persons). Writes out/junk.json."""
import os, sys, json, sqlite3, collections
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from rule28 import tokens, INSTS, DB
sys.path.insert(0, os.path.join(HERE, "..", "news24"))
import relevance as rel24

if __name__ == "__main__":
    con = sqlite3.connect(DB)
    out = {}
    for i in INSTS:
        rows = con.execute("select s.url, s.themes, l.choice='relevant', l.conf from sample s join labels l on l.inst=s.inst and "
                           "l.rid=s.rid and l.mode='single' where s.inst=?", (i,)).fetchall()
        rule_th = set().union(*[r.get("themes_any", set()) for r in rel24.RULES[i]])
        th, tok, sole = collections.Counter(), collections.Counter(), collections.Counter()
        thr, tokr, soler = collections.Counter(), collections.Counter(), collections.Counter()
        for u, t, r, _ in rows:
            ts = set(t.split(";"))
            hits = ts & rule_th
            for x in hits:
                th[x] += 1; thr[x] += r
            if len(hits) == 1:
                x = next(iter(hits)); sole[x] += 1; soler[x] += r
            if not hits:
                sole["(no rule theme: url/org/person/truncated)"] += 1; soler["(no rule theme: url/org/person/truncated)"] += r
            for w in tokens(u):
                tok[w] += 1; tokr[w] += r
        n, nr = len(rows), sum(r[2] for r in rows)
        out[i] = {"n": n, "jev_relevant": nr, "precision24": round(nr / n, 3),
                  "high_conf_junk": sum(1 for r in rows if not r[2] and (r[3] or 0) >= 0.9),
                  "rule_theme_hits": {x: [c, round(thr[x] / c, 2)] for x, c in th.most_common()},
                  "sole_theme": {x: [c, round(soler[x] / c, 2)] for x, c in sole.most_common()},
                  "junk_url_tokens": [(w, c, round(tokr[w] / c, 2)) for w, c in tok.most_common(400) if c >= 15 and tokr[w] / c < 0.1][:15],
                  "rel_url_tokens": [(w, c, round(tokr[w] / c, 2)) for w, c in tok.most_common(400) if c >= 10 and tokr[w] / c >= 0.6][:15]}
    json.dump(out, open(os.path.join(HERE, "out", "junk.json"), "w"), indent=1)
    for i, o in out.items():
        print(i, "n", o["n"], "jev rel", o["jev_relevant"], "precision24", o["precision24"])
        print("  sole theme [n, prec]:", dict(list(o["sole_theme"].items())[:8]))
        print("  junk url tokens:", o["junk_url_tokens"][:10])
        print("  rel url tokens:", o["rel_url_tokens"][:10])
