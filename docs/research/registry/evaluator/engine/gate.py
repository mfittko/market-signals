"""Variant B volatility gate: the spike 4 day layer (HAR realized volatility -> logistic regression ->
P(big day) at the 22:00 UTC open), armed when P's trailing rank over the prior 252 valid days >= q.

Reuses spike4/data.py (build_days, day_stats, thresholds, day_features) on mid M1 bars.
Run `python gate.py` for the self-check (no lookahead + model fit).
"""
import sys
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, "/Users/mfittko/github/market-signals/data/research/modellab/spike4")
from data import build_days, day_stats, thresholds, day_features  # noqa: E402

HAR = [0, 1, 2]  # rv1, rv5, rv22 relative to the trailing big-day threshold


def day_layer(m1):
    raw = {"t": m1["t"], **{k: (m1["bid_" + k] + m1["ask_" + k]) / 2 for k in "ohlc"}}
    D = build_days(raw)
    S = day_stats(D)
    thr = thresholds(S["exc"])
    F, _, _ = day_features(D, S, thr)
    valid = ~np.isnan(F[:, HAR]).any(1) & ~np.isnan(thr)
    big = (S["exc"] >= thr).astype(int)
    return dict(day=D["day"].astype(np.int64), X=F[:, HAR], y=big, valid=valid)


def fit(L, train):
    m = train & L["valid"]
    sc = StandardScaler().fit(L["X"][m])
    lr = LogisticRegression(C=1.0, max_iter=2000).fit(sc.transform(L["X"][m]), L["y"][m])
    return dict(mean=sc.mean_.tolist(), scale=sc.scale_.tolist(), coef=lr.coef_[0].tolist(), b=float(lr.intercept_[0]),
                n=int(m.sum()), pos=int(L["y"][m].sum()))


def score(L, M):
    z = (L["X"] - np.array(M["mean"])) / np.array(M["scale"])
    p = 1 / (1 + np.exp(-(z @ np.array(M["coef"]) + M["b"])))
    return np.where(L["valid"], p, np.nan)


def trailing_rank(p, n=252, minn=126):
    """Share of the prior n valid days with a lower P. NaN until minn prior valid days exist."""
    vi = np.where(np.isfinite(p))[0]
    out = np.full(len(p), np.nan)
    for j, d in enumerate(vi):
        if j >= minn:
            hist = np.sort(p[vi[max(0, j - n):j]])
            out[d] = np.searchsorted(hist, p[d], side="left") / len(hist)
    return out


def _selfcheck():
    from bars import load_m1
    m1 = load_m1("WTICO/USD", until="2023-01-01")
    L = day_layer(m1)
    assert L["valid"].sum() > 150, L["valid"].sum()
    # no lookahead: perturb every M1 bar from the start of a chosen day on; that day's features must not change
    vd = np.where(L["valid"])[0]
    d = L["day"][vd[len(vd) // 2]]
    cut = d * 1440 - 120  # 22:00 UTC rollover start of day d, in epoch minutes
    m2 = {k: v.copy() for k, v in m1.items()}
    late = m2["t"] >= cut
    noise = np.random.default_rng(0).normal(1, 0.03, late.sum())
    for k in ("bid_o", "bid_h", "bid_l", "bid_c", "ask_o", "ask_h", "ask_l", "ask_c"):
        m2[k][late] *= noise
    L2 = day_layer(m2)
    i1 = np.searchsorted(L["day"], d); i2 = np.searchsorted(L2["day"], d)
    assert np.allclose(L["X"][i1], L2["X"][i2]) and np.allclose(L["X"][:i1][L["valid"][:i1]], L2["X"][:i2][L2["valid"][:i2]])
    M = fit(L, L["day"] < d)
    p = score(L, M)
    rk = trailing_rank(p)
    assert np.nanmin(rk) >= 0 and np.nanmax(rk) <= 1
    print(f"gate self-check OK: {L['valid'].sum()} valid days to 2022, features of day {np.datetime64(int(d), 'D')} "
          f"unchanged when later bars are perturbed; LR fit on {M['n']} days ({M['pos']} big), coef {np.round(M['coef'], 2).tolist()}")


if __name__ == "__main__":
    _selfcheck()
