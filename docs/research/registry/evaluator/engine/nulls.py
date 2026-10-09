"""Execution-matched null entries. Each null keeps the side and is scored with the same policy,
barriers, costs and bid/ask fills as the real trades (by index into a table of all bars).

same_tod: the bar at the same time of day on another trading day within +-`window` trading days
          (keeps session and the local volatility regime); donors can be restricted (e.g. armed days).
circular: shift every entry by one common random offset inside the window (keeps spacing and clustering).
subset:   a random subset of the reference trades of the same size (pure selection null for filters).
Run `python nulls.py` for the self-check.
"""
import numpy as np
from validate import day_of, tod_of


class BarIndex:
    def __init__(self, tmin):
        self.day = day_of(tmin); self.tod = tod_of(tmin)
        self.key = self.day * 1440 + self.tod  # sorted because tmin is sorted
        self.days = np.unique(self.day)

    def same_tod(self, i, rng, window=20, donor_days=None, tries=30):
        i = np.asarray(i)
        d, tod = self.day[i], self.tod[i]
        rank = np.searchsorted(self.days, d)
        allowed = np.ones(len(self.days), bool) if donor_days is None else np.isin(self.days, donor_days)
        out = np.full(len(i), -1)
        todo = np.ones(len(i), bool)
        for _ in range(tries):
            if not todo.any():
                break
            off = rng.integers(1, window + 1, todo.sum()) * rng.choice([-1, 1], todo.sum())
            r = np.clip(rank[todo] + off, 0, len(self.days) - 1)
            dd = self.days[r]
            k = dd * 1440 + tod[todo]
            p = np.clip(np.searchsorted(self.key, k), 0, len(self.key) - 1)
            hit = (self.key[p] == k) & allowed[r] & (dd != d[todo])
            idx = np.where(todo)[0]
            out[idx[hit]] = p[hit]
            todo[idx[hit]] = False
        return out  # -1 where no donor bar was found


def circular(i, lo, hi, rng, min_shift=288):
    span = hi - lo
    off = rng.integers(min_shift, span - min_shift)
    return lo + (np.asarray(i) - lo + off) % span


def subset(n, k, rng):
    return np.sort(rng.choice(n, k, replace=False))


def _selfcheck():
    rng = np.random.default_rng(1)
    t0 = np.datetime64("2019-01-07T00:00", "m").astype(np.int64)
    t = np.concatenate([t0 + 1440 * d + np.arange(0, 1440, 5) for d in range(60) if (d % 7) < 5])  # weekdays only
    t = np.sort(t)
    X = BarIndex(t)
    i = rng.choice(len(t), 500, replace=False)
    j = X.same_tod(i, rng)
    ok = j >= 0
    assert ok.mean() > 0.99
    assert np.all(X.tod[j[ok]] == X.tod[i[ok]]) and np.all(X.day[j[ok]] != X.day[i[ok]])
    rk = lambda a: np.searchsorted(X.days, X.day[a])
    assert np.all(np.abs(rk(j[ok]) - rk(i[ok])) <= 20)
    donors = X.days[::3]
    j2 = X.same_tod(i, rng, donor_days=donors)
    assert np.all(np.isin(X.day[j2[j2 >= 0]], donors))
    c = circular(np.sort(i), 0, len(t), rng)
    assert len(np.unique(c)) == len(i) and np.all((c >= 0) & (c < len(t)))
    s = subset(100, 30, rng); assert len(np.unique(s)) == 30
    print(f"nulls self-check OK: same-tod donors found {ok.mean():.3f}, same tod, other day, within 20 days, "
          f"donor restriction holds; circular shift is a bijection; subset")


if __name__ == "__main__":
    _selfcheck()
