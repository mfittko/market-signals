"""Price/volume event candidates (no outcomes). Times are epoch minutes, bar time = bar start, close = t + step."""
import os
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
K_BODY = 1.5      # |mid body| >= K_BODY x ATR14 of the previous bar
V_Z = 2.0         # log tick-volume z-score vs the same UTC slot over the prior 20 non-weekend days (>= 10 obs)
COOLDOWN = 60     # minutes between events of one instrument/TF
SPR_MAX = 0.2     # spread at the signal bar <= 0.2 R, R = 1.5 x ATR14 at the signal bar
START = np.datetime64("2019-01-01", "m").astype(np.int64)


def load(inst, tf):
    z = np.load(os.path.join(HERE, "cache", f"{inst.replace('/', '_')}_{tf}.npz"))
    return {k: z[k] for k in z.files}


def weekend(t):
    dt = pd.to_datetime(t, unit="m")
    wd, hm = dt.weekday.to_numpy(), (dt.hour * 60 + dt.minute).to_numpy()
    return (wd == 5) | ((wd == 4) & (hm >= 21 * 60)) | ((wd == 6) & (hm < 22 * 60))


def vol_z(B):
    t = B["t"]; ok = ~weekend(t)
    lv = pd.Series(np.log1p(B["volume"][ok]))
    slot = pd.Series(t[ok] % 1440)
    g = lv.groupby(slot)
    mu = g.transform(lambda s: s.shift(1).rolling(20, min_periods=10).mean())
    sd = g.transform(lambda s: s.shift(1).rolling(20, min_periods=10).std())
    z = np.full(len(t), np.nan)
    z[ok] = ((lv - mu) / sd).to_numpy()
    return z


def candidates(B):
    step = int(B["step"])
    n = len(B["t"])
    atr_prev = np.r_[np.nan, B["atr"][:-1]]
    body = B["mid_c"] - B["mid_o"]
    z = vol_z(B)
    spr = (B["ask_c"] - B["bid_c"]) / (1.5 * B["atr"])
    m = (np.abs(body) >= K_BODY * atr_prev) & (z >= V_Z) & (B["t"] >= START) & (np.arange(n) < n - 1)
    m &= np.isfinite(B["atr"]) & (B["atr"] > 0)
    idx, last = [], -10 ** 9
    for i in np.flatnonzero(m):  # cooldown counts every qualifying bar, before the spread filter
        if B["t"][i] - last >= COOLDOWN:
            idx.append(i); last = B["t"][i]
    idx = np.array(idx, np.int64)
    keep = spr[idx] <= SPR_MAX
    return dict(i=idx[keep], side=np.sign(body[idx[keep]]).astype(np.int64), close=B["t"][idx[keep]] + step,
                vz=z[idx[keep]], n_spread_drop=int((~keep).sum()))


def _selfcheck():
    # synthetic: flat bars with a volume spike and a big body at one bar -> exactly that bar is an event
    n = 1440 // 5 * 40
    t = np.arange(n) * 5 + START
    rng = np.random.default_rng(1)
    c = 100 + np.cumsum(rng.normal(0, 0.01, n))
    o = np.r_[c[0], c[:-1]]
    vol = rng.integers(90, 110, n).astype(float)
    k = n - 2000
    while weekend(t[k:k + 1])[0]:
        k += 1
    c[k] = o[k] + 1.0; vol[k] = 1000
    B = dict(step=5, t=t, volume=vol, atr=np.full(n, 0.05), mid_o=o, mid_c=c, ask_c=c + 0.001, bid_c=c - 0.001)
    E = candidates(B)
    assert k in E["i"] and E["side"][list(E["i"]).index(k)] == 1, E
    assert all(B["t"][i] + 5 == cl for i, cl in zip(E["i"], E["close"]))
    print("events self-check OK", len(E["i"]))


if __name__ == "__main__":
    _selfcheck()
