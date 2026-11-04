"""Post-hoc amendment to limit13 (after run 1): the registered random-timing null drew bars anywhere in the signal's
clock hour, including bars BEFORE the signal, with the signal's side -> look-ahead (a long placed before an up-flip
captures the move that made the flip). Two lookahead-free nulls, same variants/sample/statistics (lim13.run reused,
registered lim13.py unchanged):
  after:    random TF bar in [signal bar, end of its UTC hour]
  otherday: the bar nearest the signal's clock time on a random other day, offset +-1..20 days, same side
  python nullfix13.py after|otherday   -> out_null_<mode>/results.json
"""
import os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lim13  # noqa: E402

MODE = sys.argv[1]


def after(B, i, rng):
    hk = B["t"] // 60
    hi = np.searchsorted(hk, hk[i], "right")
    r = i + np.floor(rng.random(len(i)) * (hi - i)).astype(np.int64)
    ok = np.isfinite(B["atr"][r]) & (B["atr"][r] > 0)
    return np.where(ok, r, i)


def otherday(B, i, rng):
    k = rng.integers(1, 21, len(i)) * rng.choice([-1, 1], len(i))
    r = np.clip(np.searchsorted(B["t"], B["t"][i] + k * 1440), 0, len(B["t"]) - 2)
    ok = np.isfinite(B["atr"][r]) & (B["atr"][r] > 0) & (np.abs(B["t"][r] - B["t"][i] - k * 1440) <= 60)
    return np.where(ok, r, i)


def _check():
    B = {"t": np.arange(0, 600, 5), "atr": np.ones(120)}
    rng = np.random.default_rng(0)
    i = np.array([3, 13, 30])
    for _ in range(50):
        r = after(B, i, rng)
        assert np.all(r >= i) and np.all(B["t"][r] // 60 == B["t"][i] // 60)
    print("nullfix self-check OK: 'after' bars stay at/after the signal in its hour")


if __name__ == "__main__":
    _check()
    lim13.random_bars = {"after": after, "otherday": otherday}[MODE]
    lim13.OUT = os.path.join(HERE, f"out_null_{MODE}")
    os.makedirs(lim13.OUT, exist_ok=True)
    _log = lim13.de.log_trial
    lim13.de.log_trial = lambda rec, path=None: _log({**rec, "exp": "limit13-nullfix", "null": MODE}, path)
    lim13.run()
