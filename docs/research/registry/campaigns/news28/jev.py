"""TypeSafe Jev relevance labeller: is one GDELT GKG row (URL slug + GKG themes) market-relevant for an instrument?
The key comes from the TYPESAFE_API_KEY environment variable only; it is never logged or stored.
Usage: python jev.py probe   (labels 5 hard-coded rows, prints the answers)"""
import os, sys, json, time, re, urllib.request, urllib.error

ENDPOINT = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"
NAMES = {"WTICO_USD": "WTI crude oil futures price", "XAU_USD": "gold price (XAU/USD)",
         "XAG_USD": "silver price (XAG/USD)", "EUR_USD": "euro / US dollar exchange rate (EUR/USD)",
         "SPX500_USD": "S&P 500 US stock index", "NATGAS_USD": "US natural gas futures price (Henry Hub)"}


def slug(url):
    """Readable words from the URL: host + path, separators to spaces, long hex/ids dropped."""
    u = re.sub(r"^https?://(www\.)?", "", url)
    host, _, path = u.partition("/")
    words = re.sub(r"[-_/.?=&+%]+", " ", path)
    words = " ".join(w for w in words.split() if not re.fullmatch(r"[0-9a-f]{6,}|\d+|html?|php|aspx?|amp|index", w))
    return host, words[:300]


def state(inst, url, themes):
    host, words = slug(url)
    th = [t for t in themes.split(";") if t and not t.startswith("TAX_")][:40]
    return {"target_market": NAMES[inst], "news_site": host, "url_words": words, "gdelt_themes": ", ".join(th)}


QUESTION = lambda inst: {"relevant": {
    "type": "choice",
    "instructions": (f"This is one news article, seen only through its web address words and its automatic GDELT topic tags. "
                     f"Would a trader of the {NAMES[inst]} care about this article as news that can move that market "
                     f"in the next hours (supply, demand, prices, central banks, macro data, geopolitics affecting it)? "
                     f"Topic tags are often wrong or incidental; judge mainly by what the article is about."),
    "criteria": {"relevant": f"The article is about something that can move the {NAMES[inst]}",
                 "not_relevant": "The article is about something else (crime, health, sports, local politics, company HR, lifestyle, ...) and only mentions the topic in passing"}}}


class RateLimited(Exception):
    pass


def ask(inst, url, themes, timeout=30):
    key = os.environ["TYPESAFE_API_KEY"].strip()
    body = json.dumps({"model": MODEL, "state": state(inst, url, themes), "questions": QUESTION(inst)}).encode()
    req = urllib.request.Request(ENDPOINT, body, {"authorization": f"Bearer {key}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            j = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code in (429, 529):
            raise RateLimited(e.code)
        raise (ValueError if 400 <= e.code < 500 else RuntimeError)(f"HTTP {e.code}: {e.read()[:200]!r}")
    a = j["answers"]["relevant"]
    assert a["type"] == "choice" and a["choice"] in ("relevant", "not_relevant"), a
    return a["choice"], float(a["probabilities"]["relevant"]), a.get("confidence"), j.get("model")


def post(payload, timeout=120):
    key = os.environ["TYPESAFE_API_KEY"].strip()
    req = urllib.request.Request(ENDPOINT, json.dumps(payload).encode(), {"authorization": f"Bearer {key}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r), {k: v for k, v in r.headers.items() if "auth" not in k.lower() and "cookie" not in k.lower()}
    except urllib.error.HTTPError as e:
        if e.code in (429, 529):
            raise RateLimited(e.code)
        raise (ValueError if 400 <= e.code < 500 else RuntimeError)(f"HTTP {e.code}: {e.read()[:300]!r}")


def ask_batch(inst, items, timeout=300):
    """items: list of (url, themes). One request, one choice question per article. -> list of (choice, p_relevant, confidence)."""
    q = QUESTION(inst)["relevant"]
    st = {"target_market": NAMES[inst], "how_to_read": "articles a0..aN, each seen only through its web address words and GDELT topic tags",
          "task": q["instructions"], "relevant_means": q["criteria"]["relevant"], "not_relevant_means": q["criteria"]["not_relevant"]}
    qs = {}
    for k, (u, th) in enumerate(items):
        s = state(inst, u, th); s.pop("target_market")
        st[f"a{k}"] = s
        qs[f"a{k}"] = {"type": "choice", "instructions": f"Article a{k}: relevant to the target market per the task?",
                       "criteria": {"relevant": "yes", "not_relevant": "no"}}
    j, _ = post({"model": MODEL, "state": st, "questions": qs}, timeout)
    out = []
    for k in range(len(items)):
        a = j["answers"][f"a{k}"]
        out.append((a["choice"], float(a["probabilities"]["relevant"]), a.get("confidence")))
    return out, {k: v for k, v in j.items() if k != "answers"}


if __name__ == "__main__" and sys.argv[1:] == ["raw"]:
    s = state("WTICO_USD", "https://www.cnbc.com/2020/04/20/oil-markets-us-crude-futures-go-negative.html", "ENV_OIL;ECON_OILPRICE")
    j, h = post({"model": MODEL, "state": s, "questions": QUESTION("WTICO_USD")})
    print(json.dumps(h, indent=1)); print(json.dumps(j, indent=1)[:3000])

if __name__ == "__main__" and sys.argv[1:] == ["probe"]:
    P = [("WTICO_USD", "https://www.reuters.com/business/energy/oil-prices-jump-after-opec-agrees-deeper-output-cuts-2023-04-03/", "ENV_OIL;ECON_OILPRICE;EPU_ECONOMY"),
         ("WTICO_USD", "https://www.wkyc.com/article/news/crime/alzheimers-drug-trial-fraud-charges-doctor/95-abc", "ENV_OIL;CRIME;FRAUD;GENERAL_HEALTH;MEDICAL"),
         ("WTICO_USD", "https://www.law360.com/articles/123456/payroll-company-settles-overtime-lawsuit", "ENV_OIL;LEGISLATION;ECON_UNIONS"),
         ("XAU_USD", "https://www.kitco.com/news/2022-03-08/gold-price-hits-2000-as-ukraine-war-escalates.html", "WB_2936_GOLD;ARMEDCONFLICT"),
         ("SPX500_USD", "https://www.espn.com/nfl/story/_/id/123/fed-up-fans-boo-team-after-loss", "EPU_POLICY_FEDERAL_RESERVE;SPORTS")]
    for inst, u, th in P:
        t0 = time.time()
        print(inst, u[:80], ask(inst, u, th), f"{time.time() - t0:.1f}s", flush=True)
