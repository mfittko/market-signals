"""GKG row relevance per instrument from relevance.json. Run `python relevance.py` for the self-check."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, "relevance.json")))
INSTS = list(CFG["instruments"])


def _expand(cfg):
    G = cfg["groups"]
    ref = lambda v: G[v[1:]] if isinstance(v, str) and v.startswith("@") else v
    out = {}
    for inst, rules in cfg["instruments"].items():
        rs = []
        for r in rules:
            rs += ref(r) if isinstance(r, str) else [{k: set(ref(v)) for k, v in r.items()}]
        out[inst] = [{k: set(v) for k, v in r.items()} for r in rs]
    return out


RULES = _expand(CFG)


def parse(line):
    """GKG 2.1 row -> (url, themes set, orgs list, persons list, countries set) or None."""
    f = line.split("\t")
    if len(f) < 15:
        return None
    th = set(x for x in f[7].split(";") if x)
    countries = set(loc.split("#")[2] for loc in f[9].split(";") if loc.count("#") >= 2)
    return f[4].lower(), th, [x for x in f[13].split(";") if x], [x for x in f[11].split(";") if x], countries


def match(row):
    """-> list of instruments the row is relevant to."""
    url, th, orgs, persons, cc = row
    hit = []
    for inst, rules in RULES.items():
        for r in rules:
            ok = False
            if "themes_any" in r and th & r["themes_any"]:
                ok = True
            if "orgs_any" in r and any(p in o for p in r["orgs_any"] for o in orgs):
                ok = True
            if "persons_any" in r and any(p in o for p in r["persons_any"] for o in persons):
                ok = True
            if "url_any" in r and any(p in url for p in r["url_any"]):
                ok = True
            if ok and "and_country_any" in r and not (cc & r["and_country_any"]):
                ok = False
            if ok:
                hit.append(inst)
                break
    return hit


def _selfcheck():
    def row(themes="", orgs="", persons="", locs="", url="http://x.com/a"):
        f = [""] * 27
        f[4], f[7], f[13], f[11], f[9] = url, themes, orgs, persons, locs
        return parse("\t".join(f))
    assert match(row(themes="ENV_OIL;")) == ["WTICO_USD"]
    assert match(row(themes="ARMEDCONFLICT;", locs="1#Iran#IR#IR#32#53#IR")) == ["WTICO_USD", "XAU_USD", "XAG_USD"]
    assert "WTICO_USD" not in match(row(themes="ARMEDCONFLICT;", locs="1#France#FR#FR#46#2#FR"))
    m = match(row(orgs="federal reserve bank;"))
    assert set(m) == {"XAU_USD", "XAG_USD", "EUR_USD", "SPX500_USD"}, m
    assert match(row(themes="ECON_INFLATION;", locs="1#Germany#GM#GM#51#9#GM")) == ["EUR_USD"]
    assert match(row(url="https://site.com/english-news")) == []
    assert match(row(url="https://site.com/us-lng-exports")) == ["NATGAS_USD"]
    print("relevance self-check OK", {k: len(v) for k, v in RULES.items()})


if __name__ == "__main__":
    _selfcheck()
