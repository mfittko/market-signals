"""Parse scheduled FOMC statement dates from saved Federal Reserve calendar pages (fed_raw/) into fomc_dates.json.
Statement date = last day of each scheduled meeting. Unscheduled meetings, conference calls and notation votes are excluded."""
import re, json, os, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "fed_raw")
M = {m: i for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split(), 1)}
mon = lambda s: M[s.strip().lower()[:3]]


def end_date(year, month_txt, days_txt):
    """'Apr/May' + '30-1' -> May 1; 'July 31-August 1' handled by taking the last month word and last day."""
    words = re.findall(r"[A-Za-z]+", month_txt + " " + days_txt)
    days = re.findall(r"\d+", days_txt)
    return dt.date(year, mon(words[-1]), int(days[-1]))


out = []
for y in range(2005, 2021):
    html = open(os.path.join(RAW, f"fomchistorical{y}.htm"), encoding="utf-8", errors="replace").read()
    for h in re.findall(r"<h5[^>]*>([^<]*Meeting[^<]*)</h5>", html):
        h = " ".join(h.split())
        if "unscheduled" in h.lower() or "cancel" in h.lower():
            continue
        m = re.match(r"([A-Za-z/]+) (.+?) Meeting - (\d{4})$", h)
        assert m, h
        out.append(end_date(int(m[3]), m[1], m[2]).isoformat())
cur = open(os.path.join(RAW, "fomccalendars.htm"), encoding="utf-8", errors="replace").read()
for blk in re.split(r"<h4><a id=\"\d+\">", cur)[1:]:
    y = int(re.match(r"(\d{4}) FOMC Meetings", blk)[1])
    for mo, d in re.findall(r"fomc-meeting__month[^>]*><strong>([^<]+)</strong>.*?fomc-meeting__date[^>]*>([^<]+)</div>", blk, re.S):
        if "notation" in d.lower() or "unscheduled" in d.lower():
            continue
        out.append(end_date(y, mo, d.replace("*", "")).isoformat())
out = sorted(d for d in set(out) if "2005" <= d[:4] <= "2026")
by = {}
for d in out:
    by[d[:4]] = by.get(d[:4], 0) + 1
print(len(out), by)
json.dump({"source": ["https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm (2021-2026)",
                      "https://www.federalreserve.gov/monetarypolicy/fomchistorical{YYYY}.htm (2005-2020)"],
           "fetched": "2026-10-09",
           "rule": "scheduled meetings only; statement date = last meeting day; unscheduled meetings, conference calls and notation votes excluded; raw HTML kept in fed_raw/",
           "dates": out}, open(os.path.join(HERE, "fomc_dates.json"), "w"), indent=1)
