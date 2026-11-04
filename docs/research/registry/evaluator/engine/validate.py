"""Calendar walk-forward with purge and embargo, moving-block bootstrap by trading day, and the trial log.

Trading day: 22:00 UTC rollover (day key = (minute + 120) // 1440), as in spike 4.
Run `python validate.py` for the self-check.
"""
import json, os, time, hashlib
import numpy as np
from arch.bootstrap import MovingBlockBootstrap

HERE = os.path.dirname(os.path.abspath(__file__))
TRIALS = os.environ.get("ENGINE_TRIALS", os.path.join(HERE, "trials.jsonl"))


def day_of(tmin):
    return (np.asarray(tmin, np.int64) + 120) // 1440


def tod_of(tmin):
    return (np.asarray(tmin, np.int64) + 120) % 1440


def year_start_day(y):
    """Day key of the first trading day of calendar year y (the session that opens 22:00 UTC on Dec 31)."""
    return int(day_of(np.datetime64(f"{y}-01-01", "m").astype(np.int64)))


def wf_folds(start_day, end_day, years, embargo=5):
    """Expanding walk-forward by calendar year. For each test year Y: test = rows that START in Y;
    train = rows whose label/trade interval ENDS before the start of Y minus `embargo` days (purge + embargo)."""
    for y in years:
        a, b = year_start_day(y), year_start_day(y + 1)
        yield y, end_day < a - embargo, (start_day >= a) & (start_day < b)


def day_boot(day, all_days, stat, reps=2000, block=5, seed=7):
    """Moving-block bootstrap over consecutive trading days (`all_days`, including days without rows).
    `stat(idx)` receives row indices for one replicate (days repeated as drawn). Returns the replicate array."""
    day = np.asarray(day); all_days = np.unique(all_days)
    order = np.argsort(day, kind="stable")
    pos = np.searchsorted(all_days, day[order])
    cnt = np.bincount(pos, minlength=len(all_days))
    start = np.r_[0, np.cumsum(cnt)[:-1]]
    bs = MovingBlockBootstrap(block, np.arange(len(all_days)), seed=seed)
    out = []
    for (d,), _ in bs.bootstrap(reps):
        c = cnt[d]
        tot = c.sum()
        if tot == 0:
            continue
        off = np.repeat(start[d] - np.r_[0, np.cumsum(c)[:-1]], c)
        out.append(stat(order[off + np.arange(tot)]))
    return np.array(out, float)


def ci(x, q=(2.5, 97.5)):
    x = np.asarray(x, float); x = x[np.isfinite(x)]
    return [float(v) for v in np.percentile(x, q)] if len(x) else [np.nan, np.nan]


def log_trial(rec, path=None):
    path = path or TRIALS
    rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), **rec}
    with open(path, "a") as f:
        f.write(json.dumps(rec, default=float) + "\n")


def trial_count(path=None, **match):
    path = path or TRIALS
    if not os.path.exists(path):
        return 0
    n = 0
    with open(path) as f:
        for line in f:
            r = json.loads(line)
            n += all(r.get(k) == v for k, v in match.items())
    return n


def config_hash(cfg):
    return hashlib.sha256(json.dumps(cfg, sort_keys=True, default=float).encode()).hexdigest()[:12]


def _selfcheck():
    # folds: train ends (with embargo) before the test year starts, test rows start inside the year
    d0 = year_start_day(2019)
    start = np.arange(d0 - 400, d0 + 800); end = start + 2
    for y, tr, te in wf_folds(start, end, [2019, 2020]):
        a = year_start_day(y)
        assert end[tr].max() < a - 5 and start[te].min() >= a and start[te].max() < year_start_day(y + 1)
        assert not (tr & te).any()
    # bootstrap: iid normal rows, one per day -> CI of the mean close to the analytic one
    rng = np.random.default_rng(0)
    x = rng.normal(0.1, 1, 2000); day = np.arange(2000)
    reps = day_boot(day, day, lambda ix: x[ix].mean(), reps=1000, block=5)
    lo, hi = ci(reps)
    se = 1 / np.sqrt(2000)
    assert abs((hi - lo) / (2 * 1.96 * se) - 1) < 0.2, (lo, hi)
    # several rows per day and empty days: replicate sizes vary, and every index is valid
    day2 = np.sort(rng.integers(0, 300, 900)); y2 = rng.normal(size=900)
    sizes = day_boot(day2, np.arange(300), lambda ix: len(ix), reps=200)
    assert sizes.min() > 0 and abs(sizes.mean() / 900 - 1) < 0.1
    # trial log append + count
    p = os.path.join(HERE, "cache", "selfcheck-trials.jsonl")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if os.path.exists(p):
        os.remove(p)
    log_trial({"variant": "X", "k": 1}, p); log_trial({"variant": "Y"}, p)
    assert trial_count(p) == 2 and trial_count(p, variant="X") == 1
    os.remove(p)
    print(f"validate self-check OK: folds purge+embargo; iid CI width ratio {(hi - lo) / (2 * 1.96 * se):.2f}; "
          f"multi-row days mean replicate size {sizes.mean():.0f}/900; trial log")


if __name__ == "__main__":
    _selfcheck()
