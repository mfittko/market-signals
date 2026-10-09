"""scan46: mass backtest of a fixed library of classic chart strategies with a trial-count correction
(Deflated Sharpe Ratio, Bailey and Lopez de Prado 2014) and a locked holdout touched once by frozen finalists.

Data (read-only): audit/tsmom36/daily.db (33 daily markets), data/research/history.db candles_ba M1 bid/ask
(H4 and H1 mid bars), audit/tsmom36/out/spreads.json. LOCKED: audit/swing44/daily.db is opened only by `locked`.

  python scan46.py check      fixtures: no lookahead for every parameter set, return accounting, DSR, weights
  python scan46.py describe   instruments, bar and day counts per timeframe and window (no returns)
  python scan46.py grid       print the exact strategy grid (for the prereg)
  python scan46.py register   write prereg.json (refuses to overwrite)
  python scan46.py run        scan: discovery + validation (+ daily 2023+ context) -> out/, finalists.json, trials rows
  python scan46.py locked URL locked test of the frozen finalists (needs the posted finalists comment URL)
"""
import os, sys, json, time, hashlib, sqlite3, math
import numpy as np
import pandas as pd
from numba import njit
from scipy.stats import norm, skew, kurtosis, spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out")
CACHE = os.path.join(OUT, "cache")
TRIALS = os.path.join(ENG, "trials.jsonl")
HIST = os.path.join(os.path.dirname(ENG), "history.db")
DDB = os.path.join(ENG, "audit", "tsmom36", "daily.db")
LOCKDB = os.path.join(ENG, "audit", "swing44", "daily.db")
SPREADS = os.path.join(ENG, "audit", "tsmom36", "out", "spreads.json")
EXP, SEED, NBOOT, BLOCK = "scan46", 46, 1000, 20
FLAT_SIDE_BPS = 2.0
FIN = 0.03 / 365            # 0.822 bps per held night, as a fraction of notional
NY = "America/New_York"
LAST = "2026-10-08"          # last complete trading date in both sources
WIN = {"D": {"disc": ("2005-01-01", "2018-12-31"), "val": ("2019-01-01", "2022-12-31"), "w2023": ("2023-01-01", LAST)},
       "H4": {"disc": ("2018-01-01", "2021-12-31"), "val": ("2022-01-01", "2023-12-31"), "locked": ("2024-01-01", LAST)},
       "H1": {"disc": ("2018-01-01", "2021-12-31"), "val": ("2022-01-01", "2023-12-31"), "locked": ("2024-01-01", LAST)}}
SCAN_END_INTRA = "2023-12-31"   # the scan never builds intraday bars after this trading date
LOCKED_INSTS = ("FR40_EUR", "EU50_EUR", "NL25_EUR", "CH20_CHF", "SG30_SGD", "US2000_USD")
INTRA = {"EUR/USD": "fx", "GBP/USD": "fx", "USD/JPY": "fx",
         "SPX500/USD": "index", "NAS100/USD": "index", "US30/USD": "index", "DE30/EUR": "index", "UK100/GBP": "index",
         "JP225/USD": "index", "AU200/AUD": "index", "EU50/EUR": "index",
         "WTICO/USD": "commodity", "BCO/USD": "commodity", "NATGAS/USD": "commodity", "XAU/USD": "commodity",
         "XAG/USD": "commodity", "XPT/USD": "commodity"}   # BTC/USD has M1 data but no asset class here: excluded
CLASSES = ("fx", "index", "commodity", "bond")
VOL_N, VOL_TGT = 60, 0.01
MAX_FINALISTS, DSR_MIN = 5, 0.95
EULER = 0.5772156649015329
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()


# ================================================================== indicators (causal: value at t uses bars <= t)
def S(x):
    return pd.Series(x)


def sma(x, n):
    return S(x).rolling(n, min_periods=n).mean().to_numpy(copy=True)


def ema(x, n):
    return S(x).ewm(span=n, adjust=False, min_periods=n).mean().to_numpy(copy=True)


def rma(x, n):
    return S(x).ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean().to_numpy(copy=True)


def hh(x, n):
    return S(x).rolling(n, min_periods=n).max().to_numpy(copy=True)


def ll(x, n):
    return S(x).rolling(n, min_periods=n).min().to_numpy(copy=True)


def shift(x, k=1):
    out = np.full(len(x), np.nan)
    if k < len(x):
        out[k:] = x[:len(x) - k]
    return out


def tr(h, l, c):
    pc = shift(c)
    return np.nanmax(np.vstack([h - l, np.abs(h - pc), np.abs(l - pc)]), axis=0)


def atr(h, l, c, n):
    return rma(tr(h, l, c), n)


def rsi(c, n):
    d = np.r_[np.nan, np.diff(c)]
    up, dn = rma(np.clip(np.nan_to_num(d), 0, None), n), rma(np.clip(-np.nan_to_num(d), 0, None), n)
    up[0] = dn[0] = np.nan
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.where(dn == 0, 100.0, 100 - 100 / (1 + up / dn))
    return np.where(np.isnan(up) | np.isnan(dn), np.nan, r)


@njit(cache=True)
def rolling_mad(x, n):
    out = np.full(len(x), np.nan)
    for t in range(n - 1, len(x)):
        m = 0.0
        for j in range(t - n + 1, t + 1):
            m += x[j]
        m /= n
        a = 0.0
        for j in range(t - n + 1, t + 1):
            a += abs(x[j] - m)
        out[t] = a / n
    return out


@njit(cache=True)
def aroon(h, l, n):
    up = np.full(len(h), np.nan)
    dn = np.full(len(h), np.nan)
    for t in range(n, len(h)):
        bi, bj = t - n, t - n
        for j in range(t - n, t + 1):
            if h[j] >= h[bi]:
                bi = j
            if l[j] <= l[bj]:
                bj = j
        up[t] = 100.0 * (n - (t - bi)) / n
        dn[t] = 100.0 * (n - (t - bj)) / n
    return up, dn


# ================================================================== position engines (numba)
@njit(cache=True)
def machine(le, lx, se, sx, max_hold):
    """Position decided at each bar close from entry/exit flags. Flat: long entry, else short entry.
    Long: short entry reverses, long exit flattens, max_hold bars flattens. Mirror for short. No entry on an exit bar."""
    n = len(le)
    pos = np.zeros(n)
    p, held = 0.0, 0
    for t in range(n):
        if p == 0.0:
            if le[t]:
                p, held = 1.0, 0
            elif se[t]:
                p, held = -1.0, 0
        else:
            held += 1
            if p == 1.0:
                if se[t]:
                    p, held = -1.0, 0
                elif lx[t] or (max_hold > 0 and held >= max_hold):
                    p = 0.0
            else:
                if le[t]:
                    p, held = 1.0, 0
                elif sx[t] or (max_hold > 0 and held >= max_hold):
                    p = 0.0
        pos[t] = p
    return pos


@njit(cache=True)
def supertrend(h, l, c, a, m):
    n = len(c)
    pos = np.zeros(n)
    fu, fl, d = np.nan, np.nan, 0.0
    for t in range(n):
        if np.isnan(a[t]):
            continue
        mid = (h[t] + l[t]) / 2
        bu, bl = mid + m * a[t], mid - m * a[t]
        if np.isnan(fu):
            fu, fl, d = bu, bl, 1.0 if c[t] > mid else -1.0
        else:
            nfu = bu if (bu < fu or c[t - 1] > fu) else fu
            nfl = bl if (bl > fl or c[t - 1] < fl) else fl
            if d == 1.0 and c[t] < nfl:
                d = -1.0
            elif d == -1.0 and c[t] > nfu:
                d = 1.0
            fu, fl = nfu, nfl
        pos[t] = d
    return pos


@njit(cache=True)
def psar(h, l, step, mx):
    n = len(h)
    pos = np.zeros(n)
    if n < 3:
        return pos
    d = 1.0 if h[1] + l[1] >= h[0] + l[0] else -1.0
    sar = l[0] if d == 1.0 else h[0]
    ep = h[1] if d == 1.0 else l[1]
    af = step
    pos[1] = d
    for t in range(2, n):
        sar = sar + af * (ep - sar)
        if d == 1.0:
            sar = min(sar, l[t - 1], l[t - 2])
            if l[t] < sar:
                d, sar, ep, af = -1.0, ep, l[t], step
            elif h[t] > ep:
                ep, af = h[t], min(af + step, mx)
        else:
            sar = max(sar, h[t - 1], h[t - 2])
            if h[t] > sar:
                d, sar, ep, af = 1.0, ep, h[t], step
            elif l[t] < ep:
                ep, af = l[t], min(af + step, mx)
        pos[t] = d
    return pos


@njit(cache=True)
def heikin(o, h, l, c, k):
    """Heikin-Ashi color; position switches after k consecutive candles of one color, else holds."""
    n = len(c)
    pos = np.zeros(n)
    hao, hac = np.nan, np.nan
    run, col, p = 0, 0.0, 0.0
    for t in range(n):
        if np.isnan(o[t]) or np.isnan(c[t]) or np.isnan(h[t]) or np.isnan(l[t]):
            pos[t] = p
            continue
        if np.isnan(hao):
            hao = (o[t] + c[t]) / 2
            hac = (o[t] + h[t] + l[t] + c[t]) / 4
        else:
            nhao = (hao + hac) / 2
            hac = (o[t] + h[t] + l[t] + c[t]) / 4
            hao = nhao
        cc = 1.0 if hac > hao else (-1.0 if hac < hao else 0.0)
        if cc != 0.0 and cc == col:
            run += 1
        else:
            run, col = (1 if cc != 0.0 else 0), cc
        if run >= k and col != 0.0:
            p = col
        pos[t] = p
    return pos


@njit(cache=True)
def turtle(h, l, c, n_in, n_out, a, stop_mult):
    """Close above the prior n_in-bar high: long; below the prior n_in-bar low: short. Long exits below the prior
    n_out-bar low or below entry close - stop_mult x ATR(20) at entry (stop_mult 0 = no stop). Mirror for short."""
    n = len(c)
    pos = np.zeros(n)
    p, stop = 0.0, 0.0
    for t in range(max(n_in, n_out), n):
        hi_in, lo_in, hi_out, lo_out = -1e300, 1e300, -1e300, 1e300
        for j in range(t - n_in, t):
            hi_in = max(hi_in, h[j]); lo_in = min(lo_in, l[j])
        for j in range(t - n_out, t):
            hi_out = max(hi_out, h[j]); lo_out = min(lo_out, l[j])
        if p == 1.0 and (c[t] < lo_out or (stop_mult > 0 and c[t] < stop)):
            p = 0.0
        elif p == -1.0 and (c[t] > hi_out or (stop_mult > 0 and c[t] > stop)):
            p = 0.0
        elif p <= 0.0 and c[t] > hi_in:
            p, stop = 1.0, c[t] - stop_mult * a[t]
        elif p >= 0.0 and c[t] < lo_in:
            p, stop = -1.0, c[t] + stop_mult * a[t]
        pos[t] = p
    return pos


@njit(cache=True)
def pattern(h, l, c, armed, window, hold, up_ok, dn_ok):
    """Breakout of a pattern bar's range (inside bar, NRk): after a pattern bar at t0, the first close within `window`
    bars above h[t0] goes long (below l[t0] short), held `hold` bars; an opposite breakout reverses."""
    n = len(c)
    pos = np.zeros(n)
    p, held, hi, lo, left = 0.0, 0, 0.0, 0.0, 0
    for t in range(n):
        if p != 0.0:
            held += 1
        if left > 0:
            if c[t] > hi and up_ok[t] and p != 1.0:
                p, held, left = 1.0, 0, 0
            elif c[t] < lo and dn_ok[t] and p != -1.0:
                p, held, left = -1.0, 0, 0
            else:
                left -= 1
        if p != 0.0 and held >= hold:
            p = 0.0
        if armed[t]:
            hi, lo, left = h[t], l[t], window
        pos[t] = p
    return pos


# ================================================================== strategy library
def grid():
    """Fixed library: list of (family, params). Lengths are in bars of the timeframe."""
    g = []
    add = lambda f, **p: g.append((f, p))
    for f in ("sma_cross", "ema_cross"):
        for a in (5, 10, 20, 50):
            for b in (30, 50, 100, 200):
                if a < b:
                    add(f, fast=a, slow=b)
    for n in (20, 50, 100, 150, 200, 250):
        add("price_sma", n=n)
    for n in (10, 20, 40, 55, 100):
        for fr in (0.25, 0.5, 1.0):
            add("donchian", n=n, exit_frac=fr)
    for a, b in ((20, 10), (55, 20)):
        for s in (0, 2):
            add("turtle", entry=a, exit=b, stop_atr=s)
    for n in (10, 20, 50):
        for k in (1.5, 2.0, 2.5):
            for ex in ("mid", "opposite"):
                add("bb_breakout", n=n, k=k, exit=ex)
    for n in (14, 20, 50):
        for k in (1.5, 2.0, 2.5, 3.0):
            add("bb_meanrev", n=n, k=k)
    for n in (10, 20, 50):
        for m in (1.0, 1.5, 2.0, 2.5):
            add("keltner_breakout", n=n, mult=m)
    for n, los in ((2, (5, 10, 20, 30)), (3, (5, 10, 20, 30)), (5, (10, 15, 20, 30)), (14, (20, 25, 30, 35))):
        for lo in los:
            add("rsi_meanrev", n=n, lo=lo)
    for tn in (100, 200):
        for thr in (5, 10, 15, 25):
            for ex in ("sma5", "rsi70"):
                add("rsi2_pullback", trend=tn, thr=thr, exit=ex)
    for a in (6, 8, 12):
        for b in (17, 26, 39):
            for s in (5, 9):
                add("macd_signal", fast=a, slow=b, signal=s)
    for a in (6, 8, 12):
        for b in (17, 26, 39):
            add("macd_zero", fast=a, slow=b)
    for n in (5, 14, 21):
        for lo in (10, 20, 30):
            add("stoch_meanrev", n=n, lo=lo)
    for n in (5, 14, 21):
        for s in (3, 5):
            add("stoch_cross", n=n, smooth=s)
    for n in (5, 10, 14, 20):
        for lo in (5, 10, 20):
            add("williams_r", n=n, lo=lo)
    for n in (14, 20, 40):
        for thr in (100, 150, 200):
            for mode in ("trend", "meanrev"):
                add("cci", n=n, thr=thr, mode=mode)
    for n in (7, 14, 28):
        for a in (0, 15, 20, 25, 30):
            add("adx_di", n=n, adx_min=a)
    for n in (7, 10, 14, 20):
        for m in (1.5, 2.0, 3.0, 4.0):
            add("supertrend", atr=n, mult=m)
    for s in (0.01, 0.02, 0.03):
        for m in (0.1, 0.2, 0.3):
            add("psar", step=s, max=m)
    for t, k, s in ((9, 26, 52), (7, 22, 44), (20, 60, 120), (5, 15, 30)):
        for cf in (1, 0):
            add("ichimoku", tenkan=t, kijun=k, senkou=s, cloud=cf)
    for k in (1, 2, 3):
        for sm in (0, 5, 10):
            add("heikin_ashi", confirm=k, smooth=sm)
    for n in (5, 10, 20, 40, 60, 120, 250):
        add("nbar_mom", n=n)
    for lb in (21, 63, 126, 252):
        for vn in (20, 60):
            add("tsmom_vol", lookback=lb, vol=vn)
    for n in (14, 25, 50, 100):
        for thr in (0, 40, 70):
            add("aroon", n=n, thr=thr)
    for hd in (1, 3, 5, 10):
        for flt in ("none", "sma200"):
            add("inside_bar", hold=hd, filter=flt)
    for k in (4, 7):
        for hd in (1, 3, 5, 10):
            add("nr_breakout", k=k, hold=hd)
    for k in (2, 3, 4, 5):
        add("consec_pullback", down=k)
    return g


def pkey(fam, p):
    return fam + "(" + ",".join(f"{k}={v}" for k, v in p.items()) + ")"


F = lambda x: np.nan_to_num(x, nan=0.0)
B = lambda x: np.asarray(x, bool)
NO = None


def positions(fam, p, o, h, l, c):
    """Position (+1/0/-1; tsmom_vol continuous in [-2, 2]) decided at the close of each bar from bars <= t."""
    n = len(c)
    z = np.zeros(n, bool)
    with np.errstate(invalid="ignore", divide="ignore"):
        if fam in ("sma_cross", "ema_cross"):
            f = sma if fam == "sma_cross" else ema
            return F(np.sign(f(c, p["fast"]) - f(c, p["slow"])))
        if fam == "price_sma":
            return F(np.sign(c - sma(c, p["n"])))
        if fam == "donchian":
            ne, nx = p["n"], max(2, int(round(p["n"] * p["exit_frac"])))
            hi, lo, hx, lx = shift(hh(h, ne)), shift(ll(l, ne)), shift(hh(h, nx)), shift(ll(l, nx))
            return machine(B(c > hi), B(c < lx), B(c < lo), B(c > hx), 0)
        if fam == "turtle":
            return turtle(h, l, c, p["entry"], p["exit"], F(atr(h, l, c, 20)), float(p["stop_atr"]))
        if fam in ("bb_breakout", "bb_meanrev"):
            m = sma(c, p["n"]); sd = S(c).rolling(p["n"], min_periods=p["n"]).std(ddof=0).to_numpy()
            up, dn = m + p["k"] * sd, m - p["k"] * sd
            if fam == "bb_meanrev":
                return machine(B(c < dn), B(c >= m), B(c > up), B(c <= m), 0)
            if p["exit"] == "mid":
                return machine(B(c > up), B(c < m), B(c < dn), B(c > m), 0)
            return machine(B(c > up), z, B(c < dn), z, 0)
        if fam == "keltner_breakout":
            m = ema(c, p["n"]); a = atr(h, l, c, p["n"])
            return machine(B(c > m + p["mult"] * a), B(c < m), B(c < m - p["mult"] * a), B(c > m), 0)
        if fam == "rsi_meanrev":
            r = rsi(c, p["n"]); lo = p["lo"]
            return machine(B(r < lo), B(r > 50), B(r > 100 - lo), B(r < 50), 0)
        if fam == "rsi2_pullback":
            r = rsi(c, 2); tr_ = c > sma(c, p["trend"])
            ex = (c > sma(c, 5)) if p["exit"] == "sma5" else (r > 70)
            return machine(B(tr_ & (r < p["thr"])), B(ex), z, z, 10)
        if fam in ("macd_signal", "macd_zero"):
            md = ema(c, p["fast"]) - ema(c, p["slow"])
            if fam == "macd_zero":
                return F(np.sign(md))
            sg = S(md).ewm(span=p["signal"], adjust=False, min_periods=p["signal"]).mean().to_numpy()
            return F(np.sign(md - sg))
        if fam in ("stoch_meanrev", "stoch_cross"):
            lo_, hi_ = ll(l, p["n"]), hh(h, p["n"])
            k = sma(100 * (c - lo_) / (hi_ - lo_), 3)
            if fam == "stoch_cross":
                return F(np.sign(k - sma(k, p["smooth"])))
            d = sma(k, 3); kp, dp = shift(k), shift(d); lo = p["lo"]
            le = (kp <= dp) & (k > d) & (k < lo)
            se = (kp >= dp) & (k < d) & (k > 100 - lo)
            return machine(B(le), B(k > 50), B(se), B(k < 50), 0)
        if fam == "williams_r":
            hi_, lo_ = hh(h, p["n"]), ll(l, p["n"])
            w = -100 * (hi_ - c) / (hi_ - lo_); lo = p["lo"]
            return machine(B(w < -100 + lo), B(w > -50), B(w > -lo), B(w < -50), 0)
        if fam == "cci":
            tp = (h + l + c) / 3
            cc = (tp - sma(tp, p["n"])) / (0.015 * rolling_mad(tp, p["n"]))
            t_ = p["thr"]
            if p["mode"] == "trend":
                return machine(B(cc > t_), B(cc < 0), B(cc < -t_), B(cc > 0), 0)
            return machine(B(cc < -t_), B(cc > 0), B(cc > t_), B(cc < 0), 0)
        if fam == "adx_di":
            nn = p["n"]
            um, dm = h - shift(h), shift(l) - l
            pdm = np.where((um > dm) & (um > 0), um, 0.0); mdm = np.where((dm > um) & (dm > 0), dm, 0.0)
            pdm[0] = mdm[0] = np.nan
            a = atr(h, l, c, nn)
            pdi, mdi = 100 * rma(F(pdm), nn) / a, 100 * rma(F(mdm), nn) / a
            dx = 100 * np.abs(pdi - mdi) / (pdi + mdi)
            adx = rma(F(dx), nn); adx[np.isnan(dx)] = np.nan
            s = F(np.sign(pdi - mdi))
            return np.where(F(adx) > p["adx_min"], s, 0.0) if p["adx_min"] > 0 else s
        if fam == "supertrend":
            return supertrend(h, l, c, atr(h, l, c, p["atr"]), float(p["mult"]))
        if fam == "psar":
            return psar(h, l, float(p["step"]), float(p["max"]))
        if fam == "ichimoku":
            t_, k_, s_ = p["tenkan"], p["kijun"], p["senkou"]
            ten, kij = (hh(h, t_) + ll(l, t_)) / 2, (hh(h, k_) + ll(l, k_)) / 2
            sa, sb = shift((ten + kij) / 2, k_), shift((hh(h, s_) + ll(l, s_)) / 2, k_)
            s = F(np.sign(ten - kij))
            if not p["cloud"]:
                return s
            top, bot = np.fmax(sa, sb), np.fmin(sa, sb)
            return np.where((s > 0) & (c > top), 1.0, np.where((s < 0) & (c < bot), -1.0, 0.0))
        if fam == "heikin_ashi":
            if p["smooth"]:
                o, h, l, c = (ema(x, p["smooth"]) for x in (o, h, l, c))
            return heikin(o, h, l, c, p["confirm"])
        if fam == "nbar_mom":
            return F(np.sign(c / shift(c, p["n"]) - 1))
        if fam == "tsmom_vol":
            r = np.r_[np.nan, np.diff(np.log(c))]
            sl = S(r).rolling(252, min_periods=126).std().to_numpy()
            ss = S(r).rolling(p["vol"], min_periods=p["vol"]).std().to_numpy()
            return F(np.sign(c / shift(c, p["lookback"]) - 1) * np.clip(sl / ss, 0, 2))
        if fam == "aroon":
            up, dn = aroon(h, l, p["n"]); osc = up - dn; t_ = p["thr"]
            return np.where(osc > t_, 1.0, np.where(osc < -t_, -1.0, 0.0)) if t_ else F(np.sign(osc))
        if fam == "inside_bar":
            arm = B(np.r_[False, (h[1:] < h[:-1]) & (l[1:] > l[:-1])])
            if p["filter"] == "sma200":
                m = sma(c, 200); u, d = B(c > m), B(c < m)
            else:
                u = d = np.ones(n, bool)
            return pattern(h, l, c, arm, 3, p["hold"], u, d)
        if fam == "nr_breakout":
            rg = h - l
            arm = B(rg <= ll(rg, p["k"]))
            one = np.ones(n, bool)
            return pattern(h, l, c, arm, 3, p["hold"], one, one)
        if fam == "consec_pullback":
            dn = np.r_[False, c[1:] < c[:-1]].astype(float)
            k = S(dn).rolling(p["down"], min_periods=p["down"]).sum().to_numpy() == p["down"]
            return machine(B(k & (c > sma(c, 200))), B(c > sma(c, 5)), z, z, 10)
    raise ValueError(fam)


# ================================================================== data
def daily_frames(db):
    """{inst: (cls, DataFrame o,h,l,c indexed by trading date)}; date = OANDA bar open (17:00 NY) + 1 day (ext39 rule)."""
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    d = pd.read_sql("SELECT instrument, cls, time, o, h, l, c FROM daily", con)
    con.close()
    d["date"] = (pd.to_datetime(d["time"].str[:19]) + pd.Timedelta(days=1)).dt.normalize()
    d = d[(d["date"].dt.dayofweek < 5) & (d[["o", "h", "l", "c"]] > 0).all(axis=1) & (d["date"] <= LAST)]
    out = {}
    for i, g in d.groupby("instrument"):
        g = g.drop_duplicates("date", keep="last").set_index("date").sort_index()
        out[i] = (g["cls"].iat[0], g[["o", "h", "l", "c"]].astype(float))
    return out


def tdate_from_utc(tmin):
    """Trading date of UTC epoch minutes: NY time + 7 h, Saturday/Sunday clamp to Friday (swing45 rule)."""
    idx = pd.DatetimeIndex(tmin.astype("datetime64[m]")).tz_localize("UTC").tz_convert(NY).tz_localize(None)
    d = (idx + pd.Timedelta(hours=7)).normalize()
    return d - pd.to_timedelta(np.clip(d.dayofweek - 4, 0, None), unit="D")


def load_m1(inst):
    f = os.path.join(CACHE, inst.replace("/", "_") + ".npz")
    if not os.path.exists(f):
        con = sqlite3.connect(f"file:{HIST}?mode=ro", uri=True)
        q = ("select time, bid_o, bid_h, bid_l, bid_c, ask_o, ask_h, ask_l, ask_c from candles_ba "
             "where instrument=? and granularity='M1' order by time")
        a = pd.read_sql(q, con, params=(inst,))
        con.close()
        t = a["time"].str[:16].to_numpy().astype("datetime64[m]").astype(np.int64)
        mid = {k: ((a["bid_" + k] + a["ask_" + k]) / 2).to_numpy(float) for k in "ohlc"}
        np.savez(f, t=t, **mid)
    z = np.load(f)
    return z["t"], z["o"], z["h"], z["l"], z["c"]


def intraday_frame(inst, res, end):
    """H1: UTC hour buckets. H4: buckets anchored at 17:00 New York (swing45). Mid OHLC from M1; bars only where M1
    exists; index = trading date of the bar's last M1. Bars with trading date > end are dropped."""
    t, o, h, l, c = load_m1(inst)
    ok = np.isfinite(o) & np.isfinite(h) & np.isfinite(l) & np.isfinite(c) & (l > 0)
    t, o, h, l, c = t[ok], o[ok], h[ok], l[ok], c[ok]
    if res == "H1":
        k = t // 60
    else:
        loc = pd.DatetimeIndex(t.astype("datetime64[m]")).tz_localize("UTC").tz_convert(NY).tz_localize(None)
        k = (loc.to_numpy().astype("datetime64[m]").astype(np.int64) - 17 * 60) // 240
    st = np.flatnonzero(np.r_[True, k[1:] != k[:-1]])
    en = np.r_[st[1:], len(k)] - 1
    df = pd.DataFrame({"o": o[st], "h": np.maximum.reduceat(h, st), "l": np.minimum.reduceat(l, st), "c": c[en]},
                      index=tdate_from_utc(t[en]))
    return df[df.index <= pd.Timestamp(end)]


def spread_side(name):
    sp = json.load(open(SPREADS))
    v = sp.get(name, {}).get("median_spread_bps")
    return (v / 2 if v is not None else FLAT_SIDE_BPS) / 1e4


def universe(tf, end=None, locked=False):
    """{inst: (cls, frame)} for a timeframe. Daily from daily.db (or the locked db), intraday from history.db M1."""
    if tf == "D":
        d = daily_frames(LOCKDB if locked else DDB)
        if locked:
            d = {i: v for i, v in d.items() if i in LOCKED_INSTS}
            d = {i: ("index", f) for i, (_, f) in d.items()}
        return d
    return {i: (cls, intraday_frame(i, tf, end)) for i, cls in INTRA.items()}


# ================================================================== returns, pooling, statistics
def prep(univ):
    """Per instrument arrays + a common day calendar. Per bar k: held = position decided at close k-1, return
    open k -> open k+1, nights = trading-date gap between bar k and bar k+1 (financing), day code of bar k."""
    days = pd.DatetimeIndex(sorted(set().union(*[f.index.unique() for _, f in univ.values()])))
    P = {}
    for i, (cls, f) in univ.items():
        o = f["o"].to_numpy(); idx = f.index
        r = np.r_[o[1:] / o[:-1] - 1, np.nan]
        nights = np.r_[(idx[1:] - idx[:-1]).days.to_numpy(), 0].astype(float)
        code = days.get_indexer(idx)
        u = np.bincount(code[:-1], weights=r[:-1], minlength=len(days))
        has = np.zeros(len(days), bool); has[code[:-1]] = True
        u = np.where(has, u, np.nan)
        sd = S(u).dropna().rolling(VOL_N, min_periods=VOL_N).std().shift(1)
        w = np.full(len(days), np.nan); w[sd.index] = VOL_TGT / sd.to_numpy()
        w[~np.isfinite(w)] = np.nan
        P[i] = {"cls": cls, "o": o, "h": f["h"].to_numpy(), "l": f["l"].to_numpy(), "c": f["c"].to_numpy(),
                "r": r, "nights": nights, "code": code, "has": has, "w": w, "hs": spread_side(i.replace("/", "_"))}
    return days, P


def bar_returns(pos, a):
    """Net and gross per-bar returns for decided positions pos (len n)."""
    held = np.r_[0.0, pos[:-1]]
    trade = np.abs(np.diff(np.r_[0.0, held]))
    gross = held * np.nan_to_num(a["r"])
    net = gross - trade * a["hs"] - np.abs(held) * FIN * a["nights"]
    net[-1] = gross[-1] = 0.0
    return net, gross, held


def day_series(x, a, ndays):
    s = np.bincount(a["code"], weights=x, minlength=ndays)
    return np.where(a["has"], s, np.nan)


def srstats(x):
    """Per-day Sharpe (non-annualized), skew, non-excess kurtosis, T on the finite values of x."""
    x = x[np.isfinite(x)]
    T = len(x)
    if T < 30 or x.std() == 0:
        return {"T": int(T), "sr": np.nan, "g3": np.nan, "g4": np.nan}
    return {"T": int(T), "sr": float(x.mean() / x.std(ddof=1)), "g3": float(skew(x)), "g4": float(kurtosis(x, fisher=False))}


def psr(sr, sr0, T, g3, g4):
    den = 1 - g3 * sr + (g4 - 1) / 4 * sr ** 2
    return float(norm.cdf((sr - sr0) * math.sqrt(T - 1) / math.sqrt(den))) if den > 0 and T > 1 else np.nan


def sr0_dsr(var_sr, N):
    """Expected maximum Sharpe of N independent zero-skill trials with cross-trial variance var_sr."""
    return math.sqrt(var_sr) * ((1 - EULER) * norm.ppf(1 - 1 / N) + EULER * norm.ppf(1 - 1 / (N * math.e)))


def ann(days_in_window):
    yrs = (days_in_window[-1] - days_in_window[0]).days / 365.25
    return math.sqrt(len(days_in_window) / yrs) if yrs > 0 else np.nan


def block_boot_sr(x, seed=SEED, nboot=NBOOT, block=BLOCK):
    """Moving-block bootstrap of the daily series, annualized Sharpe 95% CI (scale passed by the caller)."""
    x = x[np.isfinite(x)]
    n = len(x)
    if n < 2 * block:
        return [np.nan, np.nan]
    rng = np.random.default_rng(seed)
    nb = int(np.ceil(n / block))
    st = rng.integers(0, n - block + 1, size=(nboot, nb))
    ix = (st[:, :, None] + np.arange(block)[None, None, :]).reshape(nboot, -1)[:, :n]
    y = x[ix]
    s = y.mean(1) / y.std(1, ddof=1)
    return [float(np.percentile(s, 2.5)), float(np.percentile(s, 97.5))]


def maxdd(x, scale):
    """Max drawdown of the cumulative daily series rescaled to 10% annualized vol (additive, fraction of capital)."""
    x = x[np.isfinite(x)]
    if len(x) < 2 or x.std() == 0:
        return np.nan
    y = np.cumsum(x * (0.10 / (x.std(ddof=1) * scale)))
    return float((y - np.maximum.accumulate(np.r_[0.0, y])[1:]).min())


def evaluate(tf, fam, p, days, P, wins, keep_series=False):
    """One parameter set on one timeframe: per-instrument and per-class pooled stats for each window."""
    nd = len(days)
    inst_rows, cls_net = {}, {}
    W = {w: (days >= a) & (days <= b) for w, (a, b) in wins.items()}
    sums = {c: [np.zeros(nd), np.zeros(nd), np.zeros(nd)] for c in CLASSES}
    for i, a in P.items():
        pos = positions(fam, p, a["o"], a["h"], a["l"], a["c"])
        net, gross, held = bar_returns(pos, a)
        dn = day_series(net, a, nd)
        ent = np.r_[False, (pos[1:] != pos[:-1]) & (pos[1:] != 0)] if fam != "tsmom_vol" else \
            np.r_[False, np.sign(pos[1:]) != np.sign(pos[:-1])] & (pos != 0)
        de = np.bincount(a["code"], weights=ent.astype(float), minlength=nd)
        row = {}
        for w, m in W.items():
            mm = m & a["has"]
            if mm.sum() < 30:
                continue
            st = srstats(dn[mm]); dw = days[mm]
            yrs = max((dw[-1] - dw[0]).days / 365.25, 1e-9)
            row[w] = {"sr": st["sr"] * ann(dw) if np.isfinite(st["sr"]) else None, "T": st["T"],
                      "tpy": float(de[mm].sum() / yrs), "expo": float(np.abs(held).mean())}
        inst_rows[i] = row
        ok = a["has"] & np.isfinite(a["w"])
        s = sums[a["cls"]]
        s[0][ok] += (a["w"] * dn)[ok]; s[1][ok] += 1; s[2][ok] += de[ok]
    out = {}
    for cl, (sw, cnt, ent) in sums.items():
        if not cnt.any():
            continue
        x = np.where(cnt > 0, sw / np.maximum(cnt, 1), np.nan)
        res = {}
        for w, m in W.items():
            mm = m & (cnt > 0)
            if mm.sum() < 30:
                continue
            st = srstats(x[mm]); dw = days[mm]; sc = ann(dw)
            yrs = max((dw[-1] - dw[0]).days / 365.25, 1e-9)
            res[w] = {**st, "sr_ann": st["sr"] * sc if np.isfinite(st["sr"]) else np.nan, "scale": sc,
                      "tpy_per_inst": float(ent[mm].sum() / yrs / np.mean(cnt[mm])), "n_inst": float(np.mean(cnt[mm]))}
        out[cl] = res
        if keep_series:
            cls_net[cl] = x
    return inst_rows, out, cls_net


# ================================================================== fixtures
def synth(n, seed):
    rng = np.random.default_rng(seed)
    c = 100 * np.exp(np.cumsum(rng.normal(0.0002, 0.012, n)))
    o = np.r_[c[0], c[:-1]] * np.exp(rng.normal(0, 0.002, n))
    h = np.maximum(o, c) * np.exp(np.abs(rng.normal(0, 0.006, n)))
    l = np.minimum(o, c) * np.exp(-np.abs(rng.normal(0, 0.006, n)))
    return o, h, l, c


def check():
    # 1. no lookahead: for every parameter set, positions up to t are identical when bars after t are changed
    o, h, l, c = synth(900, 1)
    o2, h2, l2, c2 = synth(900, 2)
    G = grid()
    for fam, p in G:
        full = positions(fam, p, o, h, l, c)
        assert np.isfinite(full).all() and np.abs(full).max() <= 2, pkey(fam, p)
        for t in (300, 520, 777):
            alt = [np.r_[x[:t + 1], y[t + 1:] * x[t] / y[t]] for x, y in ((o, o2), (h, h2), (l, l2), (c, c2))]
            alt[1] = np.maximum.reduce([alt[0], alt[1], alt[3]]); alt[2] = np.minimum.reduce([alt[0], alt[2], alt[3]])
            alt[1][:t + 1], alt[2][:t + 1] = h[:t + 1], l[:t + 1]
            pa = positions(fam, p, *alt)
            assert np.array_equal(full[:t + 1], pa[:t + 1]), ("lookahead", pkey(fam, p), t)
        if not (full != 0).any():
            ol, hl, lL, cl = synth(6000, 3)
            assert (positions(fam, p, ol, hl, lL, cl) != 0).any(), ("never trades", pkey(fam, p))
    # 2. return accounting: held = position decided one bar earlier, open-to-open, costs on changes, financing per night
    a = {"r": np.array([0.01, -0.02, 0.03, 0.0, np.nan]), "hs": 1e-4, "nights": np.array([1, 3, 1, 1, 0.0])}
    net, gross, held = bar_returns(np.array([1.0, -1.0, 0.0, 0.0, 0.0]), a)
    assert np.allclose(held, [0, 1, -1, 0, 0]) and np.allclose(gross, [0, -0.02, -0.03, 0, 0])
    assert np.allclose(net, [0, -0.02 - 1e-4 - 3 * FIN, -0.03 - 2e-4 - FIN, -1e-4, 0])
    # 3. machine: reversal, exit, max hold, no entry on the exit bar
    T_, F_ = True, False
    le = np.array([T_, F_, F_, F_, T_, F_, F_]); se = np.array([F_, F_, T_, F_, F_, F_, F_])
    lx = np.array([F_] * 7); sx = np.array([F_, F_, F_, T_, F_, F_, F_])
    assert list(machine(le, lx, se, sx, 0)) == [1, 1, -1, 0, 1, 1, 1]
    assert list(machine(np.array([T_] * 5), np.array([F_] * 5), np.array([F_] * 5), np.array([F_] * 5), 2)) == [1, 1, 0, 1, 1]
    # 4. DSR: Bailey and Lopez de Prado (2014) numerical example: annual SR 2.5, 5 years daily (T 1250), N 100,
    #    annualized cross-trial variance 0.5, skew -3, kurtosis 10 -> DSR about 0.90
    q = 250
    s0 = sr0_dsr(0.5 / q, 100)
    d = psr(2.5 / math.sqrt(q), s0, 1250, -3, 10)
    assert abs(d - 0.90) < 0.01, d
    # 5. weights use only days before d: perturbing day d's return does not change w[d]
    idx = pd.bdate_range("2010-01-01", periods=200)
    f = pd.DataFrame({"o": c[:200], "h": h[:200], "l": l[:200], "c": c[:200]}, index=idx)
    _, P1 = prep({"x": ("index", f)})
    g = f.copy(); g.iloc[150:152, 0] *= 1.05
    _, P2 = prep({"x": ("index", g)})
    assert np.allclose(P1["x"]["w"][:150], P2["x"]["w"][:150], equal_nan=True)
    assert not np.allclose(P1["x"]["w"][150:154], P2["x"]["w"][150:154], equal_nan=True)
    # 6. block bootstrap CI covers a planted Sharpe
    rng = np.random.default_rng(0)
    x = rng.normal(0.001, 0.01, 2000)
    lo, hi = block_boot_sr(x)
    sr = x.mean() / x.std(ddof=1)
    assert lo < sr < hi
    print(f"scan46 check ok: {len(G)} parameter sets, no lookahead at 3 cut points each; DSR example {d:.4f}")


# ================================================================== describe / register
def describe():
    os.makedirs(CACHE, exist_ok=True)
    res = {}
    for tf in ("D", "H4", "H1"):
        U = universe(tf, SCAN_END_INTRA)
        days, P = prep(U)
        for i, a in P.items():
            row = {"cls": a["cls"], "bars": int(len(a["o"])), "half_spread_bps": a["hs"] * 1e4}
            for w, (s, e) in WIN[tf].items():
                if w == "locked":
                    continue
                m = (days >= s) & (days <= e) & a["has"]
                row[w + "_days"] = int(m.sum())
            res[f"{tf}:{i}"] = row
        print(tf, len(P), "instruments", len(days), "days", flush=True)
    json.dump(res, open(os.path.join(OUT, "describe.json"), "w"), indent=1)


def print_grid():
    G = grid()
    fams = {}
    for f, p in G:
        fams.setdefault(f, []).append(p)
    for f, ps in fams.items():
        keys = list(ps[0])
        vals = {k: sorted({str(p[k]) for p in ps}, key=lambda s: (len(s), s)) for k in keys}
        print(f"{f} ({len(ps)}): " + "; ".join(f"{k} in {{{', '.join(v)}}}" for k, v in vals.items()))
    print("total", len(G), "parameter sets per timeframe;", len(fams), "families")


def register():
    f = os.path.join(HERE, "prereg.json")
    if os.path.exists(f):
        sys.exit("prereg.json exists")
    body = json.load(open(os.path.join(HERE, "prereg_body.json")))
    body = {"created": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "code_sha256": sha(os.path.abspath(__file__)),
            "grid": [[fam, p] for fam, p in grid()], **body}
    json.dump(body, open(f, "w"), indent=1)
    print("registered", f, sha(f))


# ================================================================== scan
def jl(x):
    return None if x is None or (isinstance(x, float) and not np.isfinite(x)) else round(float(x), 4)


def run():
    if not os.path.exists(os.path.join(HERE, "prereg.json")):
        sys.exit("register first")
    pr = json.load(open(os.path.join(HERE, "prereg.json")))
    assert pr["code_sha256"] == sha(os.path.abspath(__file__)), "scan46.py changed after registration"
    G = grid()
    ts = time.strftime("%Y-%m-%dT%H:%M:%S")
    trials, cells = [], []
    for tf in ("D", "H4", "H1"):
        wins = {w: v for w, v in WIN[tf].items() if w != "locked"}
        days, P = prep(universe(tf, SCAN_END_INTRA))
        assert days.max() <= pd.Timestamp(SCAN_END_INTRA if tf != "D" else LAST)
        t0 = time.time()
        for j, (fam, p) in enumerate(G):
            ir, cr, _ = evaluate(tf, fam, p, days, P, wins)
            key = pkey(fam, p)
            for i, row in ir.items():
                trials.append({"ts": ts, "exp": EXP, "tf": tf, "family": fam, "params": p, "cell": key, "unit": i,
                               "role": "instrument", **{f"sr_{w}": jl(v["sr"]) for w, v in row.items()},
                               **{f"T_{w}": v["T"] for w, v in row.items()},
                               "tpy_disc": jl(row.get("disc", {}).get("tpy"))})
            for cl, res in cr.items():
                cells.append({"tf": tf, "family": fam, "params": json.dumps(p), "cell": key, "cls": cl,
                              **{f"{k}_{w}": v for w, r in res.items() for k, v in r.items()}})
            if j % 50 == 0:
                print(tf, j, len(G), f"{time.time() - t0:.0f}s", flush=True)
    C = pd.DataFrame(cells)
    C.to_parquet(os.path.join(OUT, "cells.parquet"))
    # selection
    sel = {}
    for tf in ("D", "H4", "H1"):
        m = C.tf == tf
        N = int(m.sum())
        srs = C.loc[m, "sr_disc"]
        V = float(np.nanvar(srs, ddof=1))
        s0 = sr0_dsr(V, N)
        sel[tf] = {"N": N, "var_sr_daily": V, "sr0_daily": s0, "sr0_ann": s0 * float(np.nanmedian(C.loc[m, "scale_disc"]))}
        for ix in C.index[m]:
            r = C.loc[ix]
            C.loc[ix, "dsr"] = psr(r.sr_disc, s0, r.T_disc, r.g3_disc, r.g4_disc) if np.isfinite(r.sr_disc) else np.nan
            C.loc[ix, "psr0"] = psr(r.sr_disc, 0.0, r.T_disc, r.g3_disc, r.g4_disc) if np.isfinite(r.sr_disc) else np.nan
    C["pass_dsr"] = C.dsr > DSR_MIN
    C["pass_val"] = C.pass_dsr & (C.sr_val > 0)
    C["rank_key"] = np.fmin(C.sr_ann_disc, C.sr_ann_val)
    fin = C[C.pass_val].sort_values("rank_key", ascending=False).head(MAX_FINALISTS)
    C.to_parquet(os.path.join(OUT, "cells.parquet"))
    for _, r in C.iterrows():
        trials.append({"ts": ts, "exp": EXP, "tf": r.tf, "family": r.family, "params": json.loads(r.params), "cell": r.cell,
                       "unit": r.cls, "role": "class_pooled", "sr_ann_disc": jl(r.sr_ann_disc), "sr_ann_val": jl(r.sr_ann_val),
                       "sr_ann_w2023": jl(r.get("sr_ann_w2023")), "T_disc": jl(r.T_disc), "dsr": jl(r.dsr), "psr0": jl(r.psr0),
                       "pass_dsr": bool(r.pass_dsr), "pass_val": bool(r.pass_val), "N_trials_tf": sel[r.tf]["N"],
                       "scan46_sha256": pr["code_sha256"]})
    with open(TRIALS, "a") as fh:
        for t in trials:
            fh.write(json.dumps(t, default=float) + "\n")
    frozen = {"frozen_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "selection": sel,
              "finalists": [{"tf": r.tf, "family": r.family, "params": json.loads(r.params), "cell": r.cell, "cls": r.cls,
                             "sr_ann_disc": r.sr_ann_disc, "sr_ann_val": r.sr_ann_val, "dsr": r.dsr} for _, r in fin.iterrows()]}
    json.dump(frozen, open(os.path.join(OUT, "finalists.json"), "w"), indent=1, default=float)
    print(json.dumps(frozen, indent=1, default=float))
    print(len(trials), "trial rows appended")


# ================================================================== finalist detail + locked test
def detail(tf, fam, p, cls, univ, wins):
    days, P = prep(univ)
    P = {i: a for i, a in P.items() if a["cls"] == cls}
    _, cr, series = evaluate(tf, fam, p, days, P, wins, keep_series=True)
    x = series[cls]
    out = {}
    for w, (a, b) in wins.items():
        m = (days >= a) & (days <= b) & np.isfinite(x)
        if m.sum() < 30 or w not in cr[cls]:
            continue
        r = cr[cls][w]; sc = r["scale"]
        ci = block_boot_sr(x[m])
        out[w] = {"sr_ann": r["sr_ann"], "ci95": [ci[0] * sc, ci[1] * sc], "T": r["T"], "tpy_per_inst": r["tpy_per_inst"],
                  "n_inst": r["n_inst"], "maxdd_at_10pct_vol": maxdd(x[m], sc), "from": str(days[m][0].date()),
                  "to": str(days[m][-1].date())}
    return out


def locked(url):
    fz = json.load(open(os.path.join(OUT, "finalists.json")))
    if os.path.exists(os.path.join(OUT, "locked.json")):
        sys.exit("locked test already run")
    fz["posted_url"] = url
    fz["finalists_sha256_before_locked"] = sha(os.path.join(OUT, "finalists.json"))
    ts = time.strftime("%Y-%m-%dT%H:%M:%S")
    rows = []
    for f in fz["finalists"]:
        tf, fam, p, cls = f["tf"], f["family"], f["params"], f["cls"]
        if tf == "D":
            f["scan_windows"] = detail(tf, fam, p, cls, universe("D"), WIN["D"])
            if cls == "index":
                U = universe("D", locked=True)
                assert set(U) == set(LOCKED_INSTS), sorted(U)
                f["locked"] = detail(tf, fam, p, cls, U, {"locked": ("1900-01-01", LAST)})["locked"]
            else:
                f["locked"] = None
                f["locked_note"] = "no locked data for this class; prospective paper tracking only"
        else:
            U = universe(tf, LAST)
            f["scan_windows"] = detail(tf, fam, p, cls, U, {w: v for w, v in WIN[tf].items() if w != "locked"})
            f["locked"] = detail(tf, fam, p, cls, U, {"locked": WIN[tf]["locked"]})["locked"]
        L = f["locked"]
        f["verdict"] = None if L is None else ("PASS" if L["sr_ann"] > 0 and L["ci95"][0] > 0 else "FAIL")
        rows.append({"ts": ts, "exp": EXP, "tf": tf, "family": fam, "params": p, "cell": f["cell"], "unit": cls,
                     "role": "locked_test", "locked": L, "verdict": f["verdict"]})
    json.dump(fz, open(os.path.join(OUT, "locked.json"), "w"), indent=1, default=float)
    with open(TRIALS, "a") as fh:
        for t in rows:
            fh.write(json.dumps(t, default=float) + "\n")
    print(json.dumps(fz, indent=1, default=float))


if __name__ == "__main__":
    os.makedirs(CACHE, exist_ok=True)
    cmd = sys.argv[1]
    if cmd == "locked":
        locked(sys.argv[2])
    else:
        {"check": check, "describe": describe, "grid": print_grid, "register": register, "run": run}[cmd]()
