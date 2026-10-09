"""pairs16 (queue v2 item 16, issue 310): mean reversion of relative-value log-price spreads.
Pairs XAU/XAG, SPX500/NAS100, EUR/USD vs XAU. Hedge ratio = rolling 60-day OLS on H1 log mid closes, as-of only.
z-score of the spread vs its trailing mean/sd at two horizons (M15 / 460 bars / hold <= 24 h; D1 / 60 bars / hold <= 20 bars).
Both legs filled bid/ask, equal cash risk (1R = 2 sd of the spread at the signal bar), financing per night held.
Evaluator v2 helpers (bars, validate.day_boot, mw6.d1_bars, nt12.load_m1c / holm) are imported, never edited.
Development evidence only; nothing is qualified; no test ledger.

  python pairs16.py check      synthetic self-checks
  python pairs16.py register   prereg.json (refuses to overwrite)
  python pairs16.py amend why  append an amendment with new code hashes
  python pairs16.py run        everything -> out/results.json
"""
import os, sys, json, time, hashlib, itertools
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
for p in (ENG, os.path.join(ENG, "audit", "notrade12"), os.path.join(ENG, "audit", "mw6")):
    sys.path.insert(0, p)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import bars  # noqa: E402
import de_v2 as de  # noqa: E402
from validate import day_boot, log_trial  # noqa: E402
import nt12  # noqa: E402
import mw6  # noqa: E402

EXP = "pairs16"
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"pairs16.py": sha(os.path.join(HERE, "pairs16.py")), "mw6.py": mw6.CODE["mw6.py"], "nt12.py": nt12.CODE["nt12.py"],
        "bars.py": sha(os.path.join(ENG, "bars.py")), "validate.py": sha(os.path.join(ENG, "validate.py")), "evaluator": de.CODE_SHA}
CUT = nt12.CUT
POOL = ["WTICO/USD", "XAU/USD", "XAG/USD", "NATGAS/USD", "SPX500/USD", "NAS100/USD", "EUR/USD", "USD/JPY"]
PAIRS = {"XAUXAG": ("XAU/USD", "XAG/USD"), "SPXNAS": ("SPX500/USD", "NAS100/USD"), "EURXAU": ("EUR/USD", "XAU/USD")}
CONTROLS = {f"{a}~{b}": (a, b) for a, b in itertools.combinations(POOL, 2)
            if (a, b) not in PAIRS.values() and (b, a) not in PAIRS.values()}
HZ = {"M15": dict(gran="M15", L=460, minp=400, hold_min=1440, hold_bars=None, block=5),
      "D1": dict(gran="D1", L=60, minp=60, hold_min=None, hold_bars=20, block=20)}
BETA_WIN, BETA_MINP = "60D", 700          # H1 bars; ~30 trading days minimum
Z_IN, Z_OUT, Z_STOP = 2.0, 0.5, 4.0
R_SD = 2.0                                  # 1R = (Z_STOP - Z_IN) sd = 2 sd of the spread at the signal bar
SPR_R = 0.2                                 # round-trip quoted cost of both legs at the signal bar <= 0.2 R
FIN = (0.0, 0.03)
FIN_BASE = 0.03
NBOOT, NSIDE, NRT, NCTRL = 1000, 1000, 200, 1000
WINDOWS = {"dev": ("2018-01-01", "2023-01-01"), "w2023": ("2023-01-01", "2026-10-08")}
CRISES = {"2020H1": ("2020-01-01", "2020-07-01"), "2022H1": ("2022-01-01", "2022-07-01"), "2025Q4_26Q1": ("2025-10-01", "2026-04-01")}
VARIANTS = [f"{p}_{h}" for h in HZ for p in PAIRS] + [f"pooled_{h}" for h in HZ]
mn = lambda s: np.datetime64(s, "m").astype(np.int64)
bars.MIN.update(H4=240, D1=1440)


# ------------------------------------------------------------------ data
_B = {}


def inst_bars(inst):
    if inst not in _B:
        m1, f = nt12.load_m1c(inst)
        _B[inst] = {"M15": bars.resample(m1, "M15"), "H1": bars.resample(m1, "H1"), "D1": mw6.d1_bars(m1), "src": f}
    return _B[inst]


def beta_asof(a, b, t):
    """OLS slope of log A on log B over the trailing 60 calendar days of H1 mid closes, taken from the last H1 bar that
    CLOSED at or before each time in t (bar start). NaN when fewer than BETA_MINP H1 bars are in the window."""
    A, B = inst_bars(a)["H1"], inst_bars(b)["H1"]
    th, ia, ib = np.intersect1d(A["t"], B["t"], return_indices=True)
    tc = th + 60
    idx = pd.to_datetime(tc * 60, unit="s")
    la = pd.Series(np.log(A["mid_c"][ia]), idx); lb = pd.Series(np.log(B["mid_c"][ib]), idx)
    cov = la.rolling(BETA_WIN, min_periods=BETA_MINP).cov(lb).to_numpy()
    var = lb.rolling(BETA_WIN, min_periods=BETA_MINP).var().to_numpy()
    bh = cov / var
    j = np.searchsorted(tc, t, side="right") - 1
    return np.where(j >= 0, bh[np.clip(j, 0, None)], np.nan)


def zscore(la, lb, beta, L, minp):
    """As-of z of s = la - beta*lb over the trailing L bars (current bar included), with the CURRENT beta applied to the
    whole window: mean_s = mA - b mB, var_s = vA + b^2 vB - 2 b cAB."""
    A, B = pd.Series(la), pd.Series(lb)
    rA, rB = A.rolling(L, min_periods=minp), B.rolling(L, min_periods=minp)
    mA, mB, vA, vB = rA.mean().to_numpy(), rB.mean().to_numpy(), rA.var().to_numpy(), rB.var().to_numpy()
    cAB = A.rolling(L, min_periods=minp).cov(B).to_numpy()
    var = vA + beta ** 2 * vB - 2 * beta * cAB
    sd = np.sqrt(np.where(var > 0, var, np.nan))
    return (la - beta * lb - (mA - beta * mB)) / sd, sd


def pair_frame(a, b, h):
    g = HZ[h]["gran"]
    A, B = inst_bars(a)[g], inst_bars(b)[g]
    t, ia, ib = np.intersect1d(A["t"], B["t"], return_indices=True)
    P = {"t": t, "n": len(t)}
    for k, X, ix in (("a", A, ia), ("b", B, ib)):
        for f in ("bid_o", "ask_o", "bid_c", "ask_c", "mid_o", "mid_c"):
            P[f"{k}_{f}"] = X[f][ix]
    la, lb = np.log(P["a_mid_c"]), np.log(P["b_mid_c"])
    P["la"], P["lb"] = la, lb
    P["beta"] = beta_asof(a, b, t)
    P["z"], P["sd"] = zscore(la, lb, P["beta"], HZ[h]["L"], HZ[h]["minp"])
    qa = (P["a_ask_c"] - P["a_bid_c"]) / P["a_mid_c"]; qb = (P["b_ask_c"] - P["b_bid_c"]) / P["b_mid_c"]
    P["costR"] = (qa + np.abs(P["beta"]) * qb) / (R_SD * P["sd"])
    # nights: calendar-day count at the 22:00 UTC roll (M15); calendar days between D1 bars (Fri -> Mon = 3)
    P["nkey"] = (t + 120) // 1440 if g == "M15" else t // 1440
    P["day"] = (t + 120) // 1440
    P["year"] = (t // 1440).astype("datetime64[D]").astype("datetime64[Y]").astype(int) + 1970
    return P


# ------------------------------------------------------------------ rules
def entry_ok(P, i):
    z, zp = P["z"][i], P["z"][i - 1]
    return (np.isfinite(z) and np.isfinite(zp) and Z_IN <= abs(z) < Z_STOP and abs(zp) < Z_IN
            and np.isfinite(P["beta"][i]) and P["costR"][i] <= SPR_R)


def find_trades(P, h):
    """Signal at the close of bar i (|z| crosses 2 from below, |z| < 4, cost rule). side = -sign(z) (+1 = long spread:
    long A, short beta B). Enter at the open of i+1. At each later close j: exit when z crosses back through the 0.5 band
    (long: z >= -0.5; short: z <= 0.5), stop when z reaches the adverse 4 (long: z <= -4; short: z >= 4), time-out when the
    next bar starts >= 24 h after entry (M15) or j+1-e >= 20 bars (D1); all exits at the open of j+1. One position at a time.
    Returns int arrays (i, e, x, side, reason 0 target / 1 stop / 2 time); trades without an exit bar are dropped."""
    z, t, n = P["z"], P["t"], P["n"]
    hm, hb = HZ[h]["hold_min"], HZ[h]["hold_bars"]
    out = []
    i = 1
    while i < n - 1:
        if not entry_ok(P, i):
            i += 1
            continue
        s = -1 if z[i] > 0 else 1
        e = i + 1
        x = None
        for j in range(e, n - 1):
            zj = z[j]
            if np.isfinite(zj) and s * zj >= -Z_OUT:
                x, r = j + 1, 0
            elif np.isfinite(zj) and s * zj <= -Z_STOP:
                x, r = j + 1, 1
            elif (hm is not None and t[j + 1] - t[e] >= hm) or (hb is not None and j + 1 - e >= hb):
                x, r = j + 1, 2
            if x is not None:
                break
        if x is None:
            break
        out.append((i, e, x, s, r))
        i = x
    a = np.array(out, int).reshape(-1, 5)
    return {k: a[:, c] for c, k in enumerate(("i", "e", "x", "side", "reason"))}


def outcome(P, i, e, x, s, fin=FIN_BASE):
    """Vectorized. Leg notionals: A = s, B = -s*beta_i (log-return units per unit of A notional). Bid/ask fills on both legs
    at the opens of e and x; mid for gross. R = 2 sd_i. Financing fin/365 * (|nA| + |nB|) per night. Returns (net R, gross R)."""
    b = P["beta"][i]; R = R_SD * P["sd"][i]
    nA, nB = s.astype(float), -s * b

    def leg(k, nn):
        buy = nn > 0
        pin = np.where(buy, P[f"{k}_ask_o"][e], P[f"{k}_bid_o"][e])
        pout = np.where(buy, P[f"{k}_bid_o"][x], P[f"{k}_ask_o"][x])
        return nn * np.log(pout / pin), nn * np.log(P[f"{k}_mid_o"][x] / P[f"{k}_mid_o"][e])

    na, ga = leg("a", nA); nb, gb = leg("b", nB)
    nights = P["nkey"][x] - P["nkey"][e]
    finc = fin / 365.0 * (np.abs(nA) + np.abs(nB)) * nights
    return (na + nb - finc) / R, (ga + gb) / R


# ------------------------------------------------------------------ nulls
def rand_time(P, T, rng, fin=FIN_BASE, nd=NRT):
    """Per trade: nd random entry bars in the same calendar year with the same side and the same holding length in bars,
    signal bar = e'-1 must have finite beta/sd and pass the cost rule. Returns (ntrades, nd) net R."""
    n = P["n"]
    ok = np.isfinite(P["beta"]) & np.isfinite(P["sd"]) & (P["costR"] <= SPR_R)
    res = np.full((len(T["i"]), nd), np.nan)
    for k in range(len(T["i"])):
        hl = T["x"][k] - T["e"][k]
        y = P["year"][T["e"][k]]
        cand = np.flatnonzero(ok[:-hl - 1] & (P["year"][:-hl - 1] == y)) + 1   # e' = i' + 1
        cand = cand[cand + hl < n]
        if not len(cand):
            continue
        ep = rng.choice(cand, nd)
        res[k] = outcome(P, ep - 1, ep, ep + hl, np.full(nd, T["side"][k]), fin)[0]
    return res


# ------------------------------------------------------------------ stats
def mdd(r):
    c = np.cumsum(r)
    return float(np.max(np.maximum.accumulate(np.r_[0, c])[1:] - c)) if len(r) else 0.0


def all_days(lo, hi):
    d = np.arange(lo // 1440, hi // 1440)
    return d[((d + 3) % 7) < 5]


def wstats(rows, lo, hi, block, rng, ctrl=None):
    """rows: dict of per-trade arrays (net, gross, net0, mirror, rt (n, NRT), day, xt). ctrl: list of control net arrays
    already restricted to the window (one per control pair)."""
    n = len(rows["net"])
    yrs = (hi - lo) / (1440 * 365.25)
    if n == 0:
        return {"trades": 0}
    net = rows["net"]
    bs = day_boot(rows["day"], all_days(lo, hi), lambda ix: net[ix].mean(), reps=NBOOT, block=block)
    se = float(np.std(bs))
    o = np.argsort(rows["xt"])
    side = np.where(rng.random((NSIDE, n)) < 0.5, net, rows["mirror"]).mean(1)
    rt = np.nanmean(rows["rt"], 1)
    r = {"trades": n, "trades_per_year": n / yrs, "net_per_trade": float(net.mean()),
         "ci": [float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))],
         "p_le0": float((1 + (bs <= 0).sum()) / (1 + len(bs))), "se": se, "mde": 2.8 * se,
         "net_per_year": float(net.sum() / yrs), "hit": float((net > 0).mean()), "maxdd": mdd(net[o]),
         "gross_per_trade": float(rows["gross"].mean()), "cost_per_trade": float((rows["gross"] - net).mean()),
         "net_per_trade_fin0": float(rows["net0"].mean()),
         "p_side": float((1 + (side >= net.mean()).sum()) / (1 + NSIDE)),
         "rt_mean": float(rt.mean()), "delta_rt": float(net.mean() - rt.mean()),
         "p_rt": float((1 + (rt >= net.mean()).sum()) / (1 + len(rt))),
         "exit_mix": [float((rows["reason"] == k).mean()) for k in (0, 1, 2)],
         "hold_bars_median": float(np.median(rows["hold"]))}
    if ctrl is not None:
        cm = np.array([c.mean() for c in ctrl if len(c)])
        r["ctrl_mean"] = float(cm.mean()) if len(cm) else None
        r["p_ctrl"] = float((1 + (cm >= net.mean()).sum()) / (1 + len(cm)))
        r["n_ctrl"] = int(len(cm))
    return r


def rows_for(P, T, rng):
    net, gross = outcome(P, T["i"], T["e"], T["x"], T["side"])
    net0 = outcome(P, T["i"], T["e"], T["x"], T["side"], fin=0.0)[0]
    cost = gross - net
    return {"net": net, "gross": gross, "net0": net0, "mirror": -gross - cost, "rt": rand_time(P, T, rng).T,
            "day": P["day"][T["e"]], "et": P["t"][T["e"]], "xt": P["t"][T["x"]], "reason": T["reason"],
            "hold": T["x"] - T["e"], "side": T["side"]}


def sub(rows, lo, hi):
    m = (rows["et"] >= lo) & (rows["et"] < hi)
    return {k: (v[:, m] if k == "rt" else v[m]) for k, v in rows.items()}


def cat(rs):
    return {k: (np.concatenate([r[k] for r in rs], 1) if k == "rt" else np.concatenate([r[k] for r in rs])) for k in rs[0]}


def half_lives(P, h):
    """Per calendar year. D1: classic AR(1) on the D1 spread with beta frozen at the year's first bar (as-of), days.
    M15: AR(1) of the deviation x = z*sd (trailing 5-day mean, current beta) on consecutive 15-min bars, hours."""
    out = {}
    for y in range(2018, 2027):
        m = P["year"] == y
        if m.sum() < 30:
            continue
        if h == "D1":
            ix = np.flatnonzero(m & np.isfinite(P["beta"]))
            if len(ix) < 30:
                continue
            s = P["la"][ix] - P["beta"][ix[0]] * P["lb"][ix]
            ds, s0 = np.diff(s), s[:-1]
            phi = np.polyfit(s0, ds, 1)[0]
            out[y] = float(-np.log(2) / np.log1p(phi)) if -1 < phi < 0 else None
        else:
            xd = P["z"] * P["sd"]
            ix = np.flatnonzero(m[1:] & m[:-1] & (np.diff(P["t"]) == 15) & np.isfinite(xd[1:]) & np.isfinite(xd[:-1])) + 1
            rho = np.polyfit(xd[ix - 1], xd[ix], 1)[0]
            out[y] = float(-np.log(2) / np.log(rho) * 0.25) if 0 < rho < 1 else None
    return out


# ------------------------------------------------------------------ run
def run():
    t0 = time.time()
    rng = np.random.default_rng(16)
    res = {"code": CODE, "variants": {}, "half_life": {}, "controls": {}, "sources": {}}
    W = {w: (mn(a), min(mn(b), mn(CUT))) for w, (a, b) in WINDOWS.items()}
    C = {w: (mn(a), mn(b)) for w, (a, b) in CRISES.items()}
    ROWS, CROWS = {}, {}
    for h in HZ:
        for name, (a, b) in {**PAIRS, **CONTROLS}.items():
            P = pair_frame(a, b, h)
            T = find_trades(P, h)
            if name in PAIRS:
                ROWS[(name, h)] = rows_for(P, T, rng)
                res["half_life"][f"{name}_{h}"] = half_lives(P, h)
                res["half_life"][f"{name}_{h}_beta_median_by_year"] = {
                    int(y): float(np.nanmedian(P["beta"][P["year"] == y])) for y in range(2018, 2027)
                    if np.isfinite(P["beta"][P["year"] == y]).any()}
            else:
                net = outcome(P, T["i"], T["e"], T["x"], T["side"])[0]
                CROWS[(name, h)] = {"net": net, "et": P["t"][T["e"]]}
            print(h, name, len(T["i"]), round(time.time() - t0), "s", flush=True)
    for a in POOL:
        res["sources"][a] = inst_bars(a)["src"]

    def ctrl_in(h, lo, hi):
        return [c["net"][(c["et"] >= lo) & (c["et"] < hi)] for (nm, hh), c in CROWS.items() if hh == h]

    for h in HZ:
        blk = HZ[h]["block"]
        for w, (lo, hi) in W.items():
            cl = ctrl_in(h, lo, hi)
            res["controls"][f"{h}_{w}"] = {nm: {"trades": int(len(c)), "net_per_trade": float(c.mean()) if len(c) else None}
                                           for nm, c in zip([k[0] for k in CROWS if k[1] == h], cl)}
            subs = []
            for name in PAIRS:
                r = sub(ROWS[(name, h)], lo, hi); subs.append(r)
                res["variants"].setdefault(f"{name}_{h}", {})[w] = wstats(r, lo, hi, blk, rng, cl)
            pr = cat(subs)
            st = wstats(pr, lo, hi, blk, rng)
            # pooled control null: pool the trades of 3 distinct random control pairs
            nonempty = [c for c in cl if len(c)]
            draws = [np.concatenate([nonempty[k] for k in rng.choice(len(nonempty), 3, replace=False)]).mean()
                     for _ in range(NCTRL)]
            st["ctrl_mean"] = float(np.mean(draws))
            st["p_ctrl"] = float((1 + (np.array(draws) >= st["net_per_trade"]).sum()) / (1 + NCTRL))
            res["variants"].setdefault(f"pooled_{h}", {})[w] = st
        for c, (lo, hi) in C.items():
            subs = []
            for name in PAIRS:
                r = sub(ROWS[(name, h)], lo, hi); subs.append(r)
                res["variants"][f"{name}_{h}"][c] = {"trades": int(len(r["net"])),
                                                     "net_per_trade": float(r["net"].mean()) if len(r["net"]) else None,
                                                     "net_sum": float(r["net"].sum()), "maxdd": mdd(r["net"][np.argsort(r["xt"])])}
            pr = cat(subs)
            res["variants"][f"pooled_{h}"][c] = {"trades": int(len(pr["net"])),
                                                 "net_per_trade": float(pr["net"].mean()) if len(pr["net"]) else None,
                                                 "net_sum": float(pr["net"].sum())}
    # yearly net by pair (descriptive)
    res["yearly"] = {}
    for (n, h), r in ROWS.items():
        yy = (r["et"] // 1440).astype("datetime64[D]").astype("datetime64[Y]").astype(int) + 1970
        res["yearly"][f"{n}_{h}"] = {int(y): [int((yy == y).sum()), float(r["net"][yy == y].mean())] for y in np.unique(yy)}
    # Holm across the 8 candidates, per window and test; decision rule
    for w in W:
        for key in ("p_le0", "p_side", "p_rt"):
            ps = np.array([res["variants"][v][w].get(key, 1.0) if res["variants"][v][w]["trades"] else 1.0 for v in VARIANTS])
            adj = nt12.holm(ps)
            for v, q in zip(VARIANTS, adj):
                res["variants"][v][w][key + "_holm"] = float(q)
    for v in VARIANTS:
        R = res["variants"][v]
        def ok(w):
            s = R[w]
            return (s["trades"] > 0 and s["ci"][0] > 0 and s["p_le0_holm"] < 0.05 and s["p_side_holm"] < 0.05
                    and s["p_rt_holm"] < 0.05 and s.get("p_ctrl", 1) < 0.05)
        if all(ok(w) for w in W):
            R["verdict"] = "SUPPORTED"
        elif all(R[w]["trades"] and R[w]["ci"][1] < 0 for w in W):
            R["verdict"] = "REJECTED"
        else:
            R["verdict"] = "INCONCLUSIVE"
        for w in list(W) + list(C):
            s = R[w]
            log_trial({"exp": EXP, "variant": v, "window": w, "net_per_trade": s.get("net_per_trade"), "trades": s["trades"],
                       "mode": "devwindow", "pairs16_sha256": CODE["pairs16.py"], "evaluator": "v2", "code_sha256": de.CODE_SHA})
    log_trial({"exp": EXP, "variant": "controls", "n_control_pairs": len(CONTROLS), "horizons": list(HZ), "mode": "null",
               "pairs16_sha256": CODE["pairs16.py"], "evaluator": "v2", "code_sha256": de.CODE_SHA})
    res["secs"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    print("done", res["secs"], "s")


# ------------------------------------------------------------------ checks
def check():
    rng = np.random.default_rng(0)
    n = 600
    lb = np.cumsum(rng.normal(0, 0.01, n)) + 3
    beta = np.full(n, 1.3); beta[300:] = 0.8
    la = beta * lb + 0.002 * rng.normal(size=n)
    z, sd = zscore(la, lb, beta, 50, 50)
    k = 400
    s = la[k - 49:k + 1] - beta[k] * lb[k - 49:k + 1]
    assert abs(z[k] - (s[-1] - s.mean()) / s.std(ddof=1)) < 1e-6, "moment z"
    # synthetic frame: A mean-reverts around B; constant spreads; P&L telescoping and mirror identity
    t = np.arange(n) * 15
    P = {"t": t, "n": n, "z": z, "sd": sd, "beta": beta, "costR": np.zeros(n), "nkey": (t + 120) // 1440,
         "day": (t + 120) // 1440, "year": np.full(n, 2020)}
    for kk, l in (("a", la), ("b", lb)):
        m = np.exp(l)
        P.update({f"{kk}_mid_o": m, f"{kk}_mid_c": m, f"{kk}_bid_o": m * 0.9999, f"{kk}_ask_o": m * 1.0001})
    T = find_trades(P, "M15")
    assert len(T["i"]) > 0 and np.all(T["e"] == T["i"] + 1) and np.all(T["x"] > T["e"])
    assert np.all(np.diff(T["i"]) > 0) and np.all(T["i"][1:] >= T["x"][:-1]), "one position at a time"
    net, gross = outcome(P, T["i"], T["e"], T["x"], T["side"], fin=0.0)
    cost = (2e-4 * (1 + np.abs(P["beta"][T["i"]]))) / (2 * P["sd"][T["i"]])   # ~ one full spread per leg
    assert np.allclose(gross - net, cost, rtol=1e-3), "two spreads per round trip"
    for kk in range(len(T["i"])):
        zi, s = z[T["i"][kk]], T["side"][kk]
        assert s == (-1 if zi > 0 else 1) and Z_IN <= abs(zi) < Z_STOP
    # financing: one night per 1440 min
    netf = outcome(P, T["i"], T["e"], T["x"], T["side"], fin=0.0365)[0]
    nights = P["nkey"][T["x"]] - P["nkey"][T["e"]]
    assert np.allclose(net - netf, 1e-4 * (1 + np.abs(P["beta"][T["i"]])) * nights / (2 * P["sd"][T["i"]]))
    print("check ok", len(T["i"]), "synthetic trades")


def coverage():
    cov = {}
    for a in POOL:
        B = inst_bars(a)
        cov[a] = {"src": B["src"], "first": str(bars.iso(B["M15"]["t"][0])), "last": str(bars.iso(B["M15"]["t"][-1]))}
    cov["pairs_common_bars_by_year"] = {}
    for name, (a, b) in PAIRS.items():
        for h in HZ:
            g = HZ[h]["gran"]
            t = np.intersect1d(inst_bars(a)[g]["t"], inst_bars(b)[g]["t"])
            y = (t // 1440).astype("datetime64[D]").astype("datetime64[Y]").astype(int) + 1970
            cov["pairs_common_bars_by_year"][f"{name}_{h}"] = {int(k): int(v) for k, v in zip(*np.unique(y, return_counts=True))}
    return cov


def register():
    f = os.path.join(HERE, "prereg.json")
    if os.path.exists(f):
        sys.exit("prereg.json exists; use amend")
    reg = {
        "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "title": "pairs16: mean reversion of relative-value log-price spreads (queue v2 item 16, issue 310)",
        "before_registration": "Nothing computed on outcomes before this file (synthetic self-checks and bar coverage only). "
                               "Prior knowledge: notrade12 (spread/thin hours), limit13 (passive fills suffer adverse selection, so "
                               "market bid/ask entries only), orb15, mw6 (financing dominant on multi-day holds).",
        "declared": "Development evidence only. No test ledger, nothing qualified. 2023+ is a development window, not a holdout. "
                    "Binding confirmation for any survivor is prospective (issue 313) or post-2026-10-07 data.",
        "evaluator": {"version": "v2", "digest": de.CODE_SHA,
                      "note": "bars.resample, validate.day_boot/log_trial, mw6.d1_bars, nt12.load_m1c/holm imported unchanged"},
        "data": f"engine/cache M1 bid/ask npz via nt12.load_m1c (cut {CUT} UTC); NAS100 cache built read-only from history.db",
        "pairs": {"XAUXAG": "XAU/USD vs XAG/USD (gold-silver ratio; common precious-metals factor)",
                  "SPXNAS": "SPX500/USD vs NAS100/USD (NAS100 backfill complete 2018-01-01..2026-10-08, ~345-355k M1 rows/year)",
                  "EURXAU": "EUR/USD vs XAU/USD (declared rationale: both are priced against USD and load on the broad USD factor; "
                            "the residual is EUR-specific vs gold-specific risk; weakest prior of the three)"},
        "skipped": {"WTI vs BCO": "BCO/USD not in history.db (no rows in candles_ba)"},
        "hedge_ratio": "beta = OLS slope (with intercept) of log A on log B over the trailing 60 calendar days of H1 mid closes "
                       "(min 700 H1 bars), taken from the last H1 bar closed at or before the bar start. Never full-sample. "
                       "Beta updates hourly; the z-score applies the current beta to the whole lookback window.",
        "spread": "s = ln(mid_c A) - beta * ln(mid_c B) on the common bar grid (inner join of bar start times)",
        "horizons": {"M15": "M15 bars, lookback 460 bars (~5 trading days, min 400), hold <= 24 h clock time (exit at the first "
                            "bar open >= entry + 24 h), bootstrap block 5 trading days",
                     "D1": "D1 bars (mw6.d1_bars: UTC-midnight, weekend stub joined to Monday), lookback 60 bars, hold <= 20 bars, "
                           "bootstrap block 20 trading days"},
        "rules": {"signal": "z at the close of bar i; entry iff |z_i| crosses 2 from below (|z_{i-1}| < 2 <= |z_i| < 4), beta "
                            "finite, cost rule; side = -sign(z) (+1 = long A, short beta B)",
                  "entry": "open of bar i+1, both legs bid/ask (buy at ask, sell at bid)",
                  "exit": "at the close of each later bar j: target when z crosses back through the 0.5 band (long: z >= -0.5, "
                          "short: z <= 0.5); stop when z reaches the adverse 4 (long: z <= -4; short: z >= 4); time-out; all "
                          "exits at the open of bar j+1 with bid/ask (two spreads per round trip). Close-based stop: gaps can "
                          "lose more than 1R. One position per pair and horizon; a new entry needs a fresh crossing after the exit.",
                  "sizing": "equal cash risk: leg notionals A = side, B = -side*beta per unit; 1R = 2 sd of the spread at the "
                            "signal bar (the distance from z = 2 to z = 4); results in R",
                  "cost_rule": "round-trip quoted cost of both legs at the signal bar ((ask-bid)/mid of A + |beta| (ask-bid)/mid "
                               "of B) <= 0.2 R; no thin-hour filter",
                  "financing": "fin/365 * (|nA| + |nB|) per calendar night held (22:00 UTC roll for M15; calendar days between "
                               "D1 bars), primary 3%/yr, sensitivity 0%"},
        "nulls": {"random_time": "per trade, 200 random entry bars in the same calendar year with the same side and the same "
                                 "holding length in bars (signal bar must have finite beta/sd and pass the cost rule); p = share "
                                 "of draws with mean R/trade >= actual",
                  "random_side": "per trade, actual or mirror outcome (same bars, opposite legs: -gross - cost) by a fair coin, "
                                 "1000 draws",
                  "cointegration_free": f"the same rules on all {len(CONTROLS)} other pairs of the 8-instrument pool {POOL} "
                                        "(randomly paired instruments); per pair p = (1 + #controls with R/trade >= actual) / "
                                        "(1 + #controls); pooled: 1000 draws of 3 distinct control pairs pooled"},
        "windows": {"dev": "trades entered 2018-01-01..2022-12-31 (effective after ~60-day beta/z warm-up)",
                    "w2023": "2023-01-01..cut (development window)",
                    "crisis": "2020H1, 2022H1, 2025Q4-26Q1 (stress; the metals period matters for XAU/XAG), reported only"},
        "metrics": "per pair and pooled per horizon: trades, trades/year, net R/trade [day-block bootstrap 95% CI, 1000 reps], "
                   "net R/year, hit rate, max drawdown (R, by exit time), gross (mid) R, cost, net at 0% financing, random-time / "
                   "random-side / control p and deltas, MDE = 2.8 x bootstrap SE, exit mix; spread half-life per year (D1: AR(1) "
                   "with the year-start as-of beta, days; M15: AR(1) of the deviation from the 5-day mean, hours); yearly net R",
        "objective": "net R per trade at 3% financing",
        "decision_rule": "A variant is SUPPORTED (development evidence only; eligible to propose a shadow registration under "
                         "issue 313) iff in BOTH dev and 2023+: net R/trade 95% CI lower bound > 0; Holm-adjusted (8 candidates) "
                         "one-sided p (R/trade <= 0) < 0.05; Holm-adjusted p vs random side < 0.05; Holm-adjusted p vs random "
                         "time < 0.05; control p < 0.05 (unadjusted; minimum attainable 1/26 per pair). REJECTED iff the net "
                         "R/trade CI upper bound < 0 in both windows. Otherwise INCONCLUSIVE (with MDE). Crisis windows and "
                         "per-year results are descriptive only.",
        "budget": {"policy_candidates": 8, "variants": VARIANTS, "tuned_hyperparameters": 0,
                   "fixed_constants": {"Z_IN": Z_IN, "Z_OUT": Z_OUT, "Z_STOP": Z_STOP, "R_SD": R_SD, "SPR_R": SPR_R,
                                       "BETA_WIN": BETA_WIN, "BETA_MINP": BETA_MINP, "HZ": HZ, "FIN": FIN}},
        "coverage": coverage(),
        "code_sha256": CODE,
        "amendments": [],
    }
    json.dump(reg, open(f, "w"), indent=1, default=str)
    print("registered", f)


def amend(why):
    f = os.path.join(HERE, "prereg.json")
    reg = json.load(open(f))
    reg["amendments"].append({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "reason": why, "code_sha256": CODE})
    json.dump(reg, open(f, "w"), indent=1, default=str)
    print("amended")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    {"check": check, "register": register, "run": run}.get(mode, lambda: None)() if mode != "amend" else amend(sys.argv[2])
