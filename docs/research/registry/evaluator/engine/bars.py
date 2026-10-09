"""M1 bid/ask loading (read-only) and resampling to M5/M15/H1 bid/ask bars.

Times are integer minutes since the Unix epoch (UTC). A bar's time is its start.
Run `python bars.py` for the self-check.
"""
import os, sqlite3
import numpy as np

DB = "file:/Users/mfittko/github/market-signals/data/research/history.db?mode=ro"
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
F = ["bid_o", "bid_h", "bid_l", "bid_c", "ask_o", "ask_h", "ask_l", "ask_c", "volume"]
MIN = {"M1": 1, "M5": 5, "M15": 15, "H1": 60}


def coverage(inst):
    con = sqlite3.connect(DB, uri=True)
    return con.execute("select count(*), min(time), max(time) from candles_ba where instrument=? and granularity='M1'",
                       (inst,)).fetchone()


def load_m1(inst, until=None):
    """All M1 rows (optionally time < until, ISO date) as a dict of arrays. Cached by row count and newest time."""
    os.makedirs(CACHE, exist_ok=True)
    n, _, tmax = coverage(inst)
    f = os.path.join(CACHE, f"{inst.replace('/', '_')}_{n}_{tmax[:16].replace(':', '')}.npz")
    if os.path.exists(f):
        z = np.load(f)
        d = {k: z[k] for k in z.files}
    else:
        con = sqlite3.connect(DB, uri=True)
        rows = con.execute("select cast(strftime('%s', substr(time,1,19)) as integer)/60, " + ", ".join(F) +
                           " from candles_ba where instrument=? and granularity='M1' order by time", (inst,)).fetchall()
        a = np.array(rows, dtype=np.float64)
        d = {"t": a[:, 0].astype(np.int64), **{k: a[:, i + 1] for i, k in enumerate(F)}}
        np.savez(f, **d)
    if until:
        m = d["t"] < np.datetime64(until, "m").astype(np.int64)
        d = {k: v[m] for k, v in d.items()}
    return d


def resample(m1, gran):
    """Aggregate sorted M1 bars into `gran` buckets aligned to the epoch (H1 on the hour)."""
    step = MIN[gran]
    b = m1["t"] // step
    _, first = np.unique(b, return_index=True)
    last = np.r_[first[1:], len(b)] - 1
    out = {"t": b[first] * step, "n": np.diff(np.r_[first, len(b)])}
    for s in ("bid", "ask"):
        out[s + "_o"] = m1[s + "_o"][first]
        out[s + "_h"] = np.maximum.reduceat(m1[s + "_h"], first)
        out[s + "_l"] = np.minimum.reduceat(m1[s + "_l"], first)
        out[s + "_c"] = m1[s + "_c"][last]
    out["volume"] = np.add.reduceat(m1["volume"], first)
    for k in ("o", "h", "l", "c"):  # mid, as (bid + ask) / 2 per field (same convention as the `candles` view)
        out["mid_" + k] = (out["bid_" + k] + out["ask_" + k]) / 2
    return out


def iso(tmin):
    return np.datetime_as_string(np.asarray(tmin, dtype="datetime64[m]"), unit="m")


def _selfcheck():
    # synthetic: 7 M1 bars, one missing minute, spanning two M5 buckets
    t = np.array([0, 1, 2, 4, 5, 6, 9]) + 5 * 1000
    bo = np.array([10, 11, 12, 13, 14, 15, 16.0])
    m1 = {"t": t, "bid_o": bo, "bid_h": bo + 1, "bid_l": bo - 1, "bid_c": bo + 0.5,
          "ask_o": bo + .1, "ask_h": bo + 1.1, "ask_l": bo - .9, "ask_c": bo + .6, "volume": np.ones(7)}
    r = resample(m1, "M5")
    assert list(r["t"]) == [5000, 5005] and list(r["n"]) == [4, 3]
    assert r["bid_o"][0] == 10 and r["bid_c"][0] == 13.5 and r["bid_h"][0] == 14 and r["bid_l"][0] == 9
    assert r["ask_o"][1] == 14.1 and r["ask_c"][1] == 16.6 and r["ask_l"][1] == 13.1 and r["volume"][1] == 3
    # real data: M5 built from M1 equals M15 built from M5-resampled parts (associativity), and H1 is hour-aligned
    m1 = load_m1("WTICO/USD")
    m1 = {k: v[:200000] for k, v in m1.items()}
    m5, m15, h1 = resample(m1, "M5"), resample(m1, "M15"), resample(m1, "H1")
    assert np.all(m5["bid_h"] >= m5["bid_l"]) and np.all(m5["ask_c"] >= m5["bid_c"] - 1e-9)
    assert np.all(h1["t"] % 60 == 0) and np.all(m15["t"] % 15 == 0)
    m5r = {"t": m5["t"], **{k: m5[k] for k in F}}  # resample the M5 bars again to M15
    m15b = resample(m5r, "M15")
    for k in ("t", "bid_o", "bid_h", "bid_l", "bid_c", "ask_h", "ask_l"):
        assert np.allclose(m15b[k], m15[k]), k
    assert m1["volume"].sum() == m5["volume"].sum() == h1["volume"].sum()
    print(f"bars self-check OK: synthetic 2 buckets; real {len(m1['t'])} M1 -> {len(m5['t'])} M5, {len(m15['t'])} M15, "
          f"{len(h1['t'])} H1; M5->M15 equals M1->M15")


if __name__ == "__main__":
    _selfcheck()
