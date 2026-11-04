"""Derive the tightened relevance rule (relevance28.json) from the Jev-labelled sample.
Form (drop-list): a news24 row stays relevant to an instrument under news28 unless it matches one of the instrument's
'drop' conditions:
  th:X    GKG theme X is in the stored theme string (sorted, truncated to 400 chars by the news24 fetch)
  sole:X  X is the ONLY news24 rule theme of this instrument in the stored theme string
  url:w   w is one of the URL slug word tokens (jev.slug path words, lowercase letters only, length >= 3)
Fit on the even-k half of the sample, evaluated on the odd-k half (held-out). Greedy: drop the candidate (support >= sup
rows in the fit half) with the best junk-removed / (relevant-removed + 1) ratio while fit recall stays >= target; (target, sup)
chosen per instrument by inner 2-fold CV inside the fit half (cv). A first drop-list fit with fixed (0.95, 10) failed held-out
recall (out/relevance28_droplist_v1_rejected.json).
An earlier keep-list form (out/relevance28_keeplist_rejected.json) failed the held-out recall check and is not used.
Usage: python rule28.py fit | eval"""
import os, sys, re, json, sqlite3, collections, hashlib
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from jev import slug

DB = os.path.join(HERE, "labels.db")
OUT = os.path.join(HERE, "relevance28.json")
REL24 = os.path.join(HERE, "..", "news24", "relevance.json")
INSTS = ["WTICO_USD", "XAU_USD", "XAG_USD", "EUR_USD", "SPX500_USD", "NATGAS_USD"]
TARGET, MIN_SUP, MIN_JUNK = 0.95, 10, 5


def tokens(url):
    return set(w for w in slug(url)[1].split() if re.fullmatch(r"[a-z]{3,}", w))


def rule_themes():
    """news24 rule themes per instrument (groups expanded)."""
    c = json.load(open(REL24)); G = c["groups"]; out = {}
    for i, rules in c["instruments"].items():
        s = set()
        for r in rules:
            for rr in (G[r[1:]] if isinstance(r, str) else [r]):
                t = rr.get("themes_any", [])
                s |= set(G[t[1:]] if isinstance(t, str) else t)
        out[i] = s
    return out


RT = rule_themes()


def feats(inst, url, themes):
    th = set(t for t in themes.split(";") if t)
    f = {"th:" + t for t in th} | {"url:" + w for w in tokens(url)}
    hits = th & RT[inst]
    if len(hits) == 1:
        f.add("sole:" + next(iter(hits)))
    return f


def keep(drop, inst, url, themes):
    """True if the row stays relevant to inst under the drop-list."""
    th = set(themes.split(";")); hits = th & RT[inst]; u = tokens(url)
    for c in drop:
        k, v = c.split(":", 1)
        if (k == "th" and v in th) or (k == "url" and v in u) or (k == "sole" and hits == {v}):
            return False
    return True


def load(inst, half, mod=2):
    q = ("select s.url, s.themes, l.choice='relevant' from sample s join labels l on l.inst=s.inst and l.rid=s.rid and l.mode='single' "
         "where s.inst=? and s.k % ? = ?")
    return sqlite3.connect(DB).execute(q, (inst, mod, half)).fetchall()


def fit(inst, rows, target=None, sup=None):
    cand = collections.defaultdict(set)
    for n, (u, th, _) in enumerate(rows):
        for c in feats(inst, u, th):
            cand[c].add(n)
    cand = {c: s for c, s in cand.items() if len(s) >= (sup or MIN_SUP)}
    rel = {n for n, r in enumerate(rows) if r[2]}
    drop, gone = [], set()
    while True:
        best = None
        for c, s in cand.items():
            new = s - gone; jr, rr = len(new - rel), len(new & rel)
            if jr < MIN_JUNK or len(rel - gone - new) < (target or TARGET) * len(rel):
                continue
            sc = (jr / (rr + 1), jr)
            if best is None or sc > best[0]:
                best = (sc, c)
        if best is None:
            return drop
        drop.append(best[1]); gone |= cand[best[1]]


def score(drop, inst, rows):
    rel = sum(r[2] for r in rows)
    k = [keep(drop, inst, u, th) for u, th, _ in rows]
    kr = sum(1 for x, r in zip(k, rows) if x and r[2])
    return {"n": len(rows), "jev_rel": rel, "precision24": round(rel / len(rows), 3), "kept": sum(k),
            "recall28": round(kr / rel, 3), "precision28": round(kr / sum(k), 3),
            "junk_dropped": round(1 - (sum(k) - kr) / (len(rows) - rel), 3)}


GRID = [(t, s) for t in (0.95, 0.97, 0.98, 0.99) for s in (10, 20, 40)]
CV_RECALL = 0.93


def cv(inst):
    """Inner 2-fold CV on the fit half only (k % 4 == 0 vs k % 4 == 2): pick (target, support) with the largest mean junk
    drop whose mean inner recall >= CV_RECALL. None -> no drop conditions."""
    a, b = load(inst, 0, 4), load(inst, 2, 4)
    best, table = None, []
    for t, s in GRID:
        r = [score(fit(inst, x, t, s), inst, y) for x, y in ((a, b), (b, a))]
        rec, jd = sum(z["recall28"] for z in r) / 2, sum(z["junk_dropped"] for z in r) / 2
        table.append({"target": t, "support": s, "cv_recall": round(rec, 3), "cv_junk_dropped": round(jd, 3)})
        if rec >= CV_RECALL and (best is None or jd > best[0]):
            best = (jd, t, s)
    return best, table


if __name__ == "__main__":
    assert keep(["sole:ENV_OIL"], "WTICO_USD", "http://x/a", "ENV_OIL;CRIME") is False
    assert keep(["sole:ENV_OIL"], "WTICO_USD", "http://x/a", "ECON_OILPRICE;ENV_OIL") is True
    assert keep(["url:police"], "XAU_USD", "http://x/police-chief", "ARMEDCONFLICT") is False
    if sys.argv[1] == "fit":
        R = {"note": __doc__.split("Usage:")[0].strip(),
             "fit": {"min_junk_removed": MIN_JUNK, "labeller": "TypeSafe jev-1.13.0", "cv_recall": CV_RECALL,
                     "sample": "labels.db, 1000 rows per instrument, seed 28; fit = even k (inner CV k%4 0 vs 2), held-out = odd k"},
             "params": {}, "cv": {}, "drop": {}}
        for i in INSTS:
            best, table = cv(i)
            R["cv"][i] = table
            R["params"][i] = {"target": best[1], "support": best[2]} if best else None
            R["drop"][i] = fit(i, load(i, 0), best[1], best[2]) if best else []
        json.dump(R, open(OUT, "w"), indent=1)
    R = json.load(open(OUT))
    rep = {}
    for i in INSTS:
        rep[i] = {"fit": score(R["drop"][i], i, load(i, 0)), "heldout": score(R["drop"][i], i, load(i, 1)), "n_conditions": len(R["drop"][i])}
        print(i, json.dumps(rep[i]))
    rep["relevance28_sha256"] = hashlib.sha256(open(OUT, "rb").read()).hexdigest()
    json.dump(rep, open(os.path.join(HERE, "out", "rule28_eval.json"), "w"), indent=1)
