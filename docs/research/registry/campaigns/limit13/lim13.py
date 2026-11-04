"""limit13 (queue v2 item 13): passive limit-order entries on the live signal types vs market entry.

Evaluator v2 (labels_v2.simulate for the market baseline, fills.resolve, validate.day_boot) and nt12 helpers
(signals, frames, thin hours) are imported, never edited. `manage` is labels_v2.simulate with the entry bar, the
entry price and the first (partial) bar as parameters; `check` proves it reproduces simulate exactly on real data.

  python lim13.py check      synthetic self-checks + parity of manage() with labels_v2.simulate (no statistics)
  python lim13.py register   write prereg.json (refuses to overwrite)
  python lim13.py run        outcomes + statistics -> out/results.json
"""
import os, sys, json, time, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
NT = os.path.join(ENG, "audit", "notrade12")
sys.path.insert(0, ENG); sys.path.insert(0, NT); sys.path.insert(0, os.path.join(ENG, "audit", "xvol9"))
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import de_v2 as de  # noqa: E402
from labels_v2 import simulate, POLICY, FLIP, TIME  # noqa: E402
from fills import resolve, STOP, TARGET  # noqa: E402
from validate import day_of, day_boot  # noqa: E402
import nt12  # noqa: E402

EXP = "limit13"
OUT = os.path.join(HERE, "out")
INSTS, CUT, GMIN, DEV_END, SPR_R = nt12.INSTS, nt12.CUT, nt12.GMIN, nt12.DEV_END, nt12.SPR_R
TFS = ["M5", "M15"]
# fixed up front: (name, level, d in ATR of the signal timeframe, expiry in bars of the signal timeframe)
VARIANTS = [("J0_x3", "ref", 0.0, 3), ("J0_x12", "ref", 0.0, 12),
            ("D25_x3", "ref", 0.25, 3), ("D25_x12", "ref", 0.25, 12),
            ("D50_x3", "ref", 0.5, 3), ("D50_x12", "ref", 0.5, 12),
            ("ST_x12", "st", 0.0, 12), ("VWAP_x12", "vwap", 0.0, 12)]
NDRAW, NBOOT, NBOOT_FAM, NTHIN = 20, 1000, 500, 500
CENSOR_GUARD_MIN = 4 * 1440  # signals in the last 4 days before CUT are dropped (outcome window)
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"lim13.py": sha(os.path.join(HERE, "lim13.py")), "nt12.py": sha(os.path.join(NT, "nt12.py"))}


# ------------------------------------------------------------------ execution
def limit_price(B, k, s, level, d, vw):
    """Buy limit (s=+1) below the bid at the close of bar k; sell limit (s=-1) above the ask. A level on the
    marketable side is capped at the bid (buy) / ask (sell) = join the quote."""
    ref = np.where(s > 0, B["bid_c"][k], B["ask_c"][k])
    if level == "ref":
        return ref - s * d * B["atr"][k]
    lv = B["st"][k] if level == "st" else vw[k]
    return np.where(s > 0, np.fmin(lv, ref), np.fmax(lv, ref))


def scan_fill(m1, B, g, k, s, L, X, touch=False):
    """Resting order placed at the close of bar k, live for TF bars k+1..k+X, cancelled after the close of the first
    opposite flip bar of the same timeframe inside that window. Buy fills when the M1 ASK low trades through L
    (strictly below; touch: <=); sell when the M1 BID high trades through. Returns the M1 index of the fill or -1."""
    n = len(B["t"]); N = len(k)
    last = np.minimum(k + X, n - 1)
    done = np.zeros(N, bool)
    for j in range(1, X + 1):
        f = np.clip(k + j, 0, n - 1)
        hit = ~done & (k + j <= n - 1) & (B["flip"][f] == -s)
        last = np.where(hit, f, last); done |= hit
    e = np.clip(k + 1, 0, n - 1)
    t1 = m1["t"]
    a = np.searchsorted(t1, B["t"][e]); b = np.searchsorted(t1, B["t"][last] + GMIN[g])
    b = np.where(k + 1 <= n - 1, b, a)
    fill = np.full(N, -1, np.int64)
    for off in range(int((b - a).max()) if N else 0):
        ix = a + off; ok = (fill < 0) & (ix < b)
        if not ok.any():
            continue
        ixc = np.clip(ix, 0, len(t1) - 1)
        if touch:
            c = np.where(s > 0, m1["ask_l"][ixc] <= L, m1["bid_h"][ixc] >= L)
        else:
            c = np.where(s > 0, m1["ask_l"][ixc] < L, m1["bid_h"][ixc] > L)
        fill = np.where(ok & c, ix, fill)
    return fill


def first_bar(m1, B, g, f, s):
    """TF bar of the fill and the rest of it after the fill minute, as an exit-side bar in long semantics
    (long: bid; short: negated ask). Empty rest -> valid False. Also the fill minute's exit-side low."""
    t1 = m1["t"]
    bf = np.searchsorted(B["t"], t1[f], side="right") - 1
    endm = np.searchsorted(t1, B["t"][bf] + GMIN[g])
    lo = s > 0
    o = np.full(len(f), np.nan); h = np.full(len(f), -np.inf); l = np.full(len(f), np.inf); c = np.full(len(f), np.nan)
    for off in range(1, GMIN[g]):
        ix = f + off; ok = ix < endm; ixc = np.clip(ix, 0, len(t1) - 1)
        bh = np.where(lo, m1["bid_h"][ixc], -m1["ask_l"][ixc]); bl = np.where(lo, m1["bid_l"][ixc], -m1["ask_h"][ixc])
        bo = np.where(lo, m1["bid_o"][ixc], -m1["ask_o"][ixc]); bc = np.where(lo, m1["bid_c"][ixc], -m1["ask_c"][ixc])
        o = np.where(ok & (off == 1), bo, o)
        h = np.where(ok, np.maximum(h, bh), h); l = np.where(ok, np.minimum(l, bl), l); c = np.where(ok, bc, c)
    valid = f + 1 < endm
    flo = np.where(lo, m1["bid_l"][f], -m1["ask_h"][f])
    return bf, (np.where(valid, o, np.nan), np.where(valid, h, np.nan), np.where(valid, l, np.nan), np.where(valid, c, np.nan)), flo


def manage(B, b, side, entry, R, flip, first, fstop_low=None, P=POLICY, optimistic=False):
    """labels_v2.simulate with parameters: management bar 0 is `first` (exit-side o,h,l,c in long semantics, NaN =
    nothing happens in it) at TF bar index b; bars 1..H-1 are b+1..b+H-1; `entry` is the fill price in long semantics.
    fstop_low: exit-side low of the fill minute; pessimistic mode stops there when it reached stop0 (fill-minute
    ordering unknown). Everything else is copied line by line from simulate."""
    b = np.asarray(b, np.int64); s = np.asarray(side, np.int64); n = len(B["bid_o"]); N = len(b)
    lo = s > 0

    def bar(x):
        return (np.where(lo, B["bid_o"][x], -B["ask_o"][x]), np.where(lo, B["bid_h"][x], -B["ask_l"][x]),
                np.where(lo, B["bid_l"][x], -B["ask_h"][x]), np.where(lo, B["bid_c"][x], -B["ask_c"][x]))
    R = np.asarray(R, float)
    stop0, arm, tgt, be = entry - R, entry + P["m"] * R, entry + P["T"] * R, entry
    alive = (b < n) & np.isfinite(R) & (R > 0) & np.isfinite(entry)
    cens = ~alive.copy()
    armed = np.zeros(N, bool); amb = np.zeros(N, bool)
    reason = np.zeros(N, np.int8); xp = np.full(N, np.nan); xb = np.full(N, -1)

    def close(mask, price, why, j):
        xp[mask] = price[mask]; reason[mask] = why; xb[mask] = b[mask] + j; alive[mask] = False

    if fstop_low is not None and not optimistic:
        close(alive & (fstop_low <= stop0), stop0, STOP, 0)
    for j in range(P["H"]):
        x = b + j
        out = alive & (x >= n)
        cens |= out; alive &= ~out
        xc = np.clip(x, 0, n - 1)
        o, h, l, c = first if j == 0 else bar(xc)
        if j >= 1:
            close(alive & (flip[xc - 1] == -s), o, FLIP, j)
        a1 = alive & armed
        r, p, am = resolve(o, h, l, be, tgt)
        if optimistic:
            r = np.where(am, TARGET, r); p = np.where(am, tgt, p)
        amb |= a1 & am
        close(a1 & (r == STOP), p, STOP, j); close(a1 & (r == TARGET), p, TARGET, j)
        a0 = alive & ~armed
        r, p, am = resolve(o, h, l, stop0, arm)
        if optimistic:
            armed |= a0 & am
            r = np.where(am & (h >= tgt), TARGET, r)
        amb |= a0 & am
        close(a0 & (r == STOP), p, STOP, j)
        newly = a0 & (r == TARGET)
        armed |= newly
        gap = newly & (o >= arm)
        r2, p2, am2 = resolve(o, h, l, stop0, tgt)
        if optimistic:
            r2 = np.where(am2, TARGET, r2); p2 = np.where(am2, tgt, p2)
        amb |= gap & am2
        close(gap & (r2 == STOP), p2, STOP, j); close(gap & (r2 == TARGET), p2, TARGET, j)
        intra = newly & ~gap & alive & (h >= tgt)
        close(intra, tgt, TARGET, j)
        if j == P["H"] - 1:
            close(alive.copy(), c, TIME, j)
    net = (xp - entry) / R
    return dict(net_R=net, reason=reason, exit_bar=xb, censored=cens, ok=~cens & np.isfinite(net), amb=amb)


def limit_trade(m1, B, g, k, s, R, var, vw, touch=False, optimistic=False):
    """One limit variant for orders placed at the close of bars k. Returns (filled, net_R or NaN, censored, wait bars)."""
    _, level, d, X = var
    L = limit_price(B, k, s, level, d, vw)
    f = scan_fill(m1, B, g, k, s, L, X, touch)
    fl = f >= 0
    net = np.full(len(k), np.nan); cens = np.zeros(len(k), bool); wait = np.full(len(k), -1)
    if fl.any():
        ff, ss = f[fl], s[fl]
        bf, fb, flo = first_bar(m1, B, g, ff, ss)
        M = manage(B, bf, ss, ss * L[fl], R[fl], B["flip"], fb, flo, POLICY, optimistic)
        net[fl] = M["net_R"]; cens[fl] = ~M["ok"]; wait[fl] = bf - k[fl]
    return fl, net, cens, wait


# ------------------------------------------------------------------ data
def vwap_bars(m1, B, g):
    """Session VWAP (22:00 UTC trading day) of the M1 mid typical price x tick volume, at the close of each TF bar."""
    tp = ((m1["bid_h"] + m1["ask_h"]) + (m1["bid_l"] + m1["ask_l"]) + (m1["bid_c"] + m1["ask_c"])) / 6
    dd = day_of(m1["t"])
    pv = pd.Series(tp * m1["volume"]).groupby(dd).cumsum().to_numpy()
    vv = pd.Series(m1["volume"]).groupby(dd).cumsum().to_numpy()
    ix = np.searchsorted(m1["t"], B["t"] + GMIN[g]) - 1
    ok = (ix >= 0) & (dd[np.clip(ix, 0, None)] == day_of(B["t"] + GMIN[g] - 1))
    ixc = np.clip(ix, 0, None)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(ok & (vv[ixc] > 0), pv[ixc] / vv[ixc], np.nan)


def streams():
    for inst in INSTS:
        m1, src = nt12.load_m1c(inst)
        H1 = nt12.h1(inst, m1)
        B5 = nt12.frame(inst, m1, "M5", H1)
        thin, _ = nt12.thin_hours(B5)
        for g in TFS:
            B = B5 if g == "M5" else nt12.frame(inst, m1, g, H1)
            vw = vwap_bars(m1, B, g)
            for kind in ("flip", "impulse"):
                if kind == "flip":
                    i = np.where(B["flip"] != 0)[0]; s = B["flip"][i]
                else:
                    i, s = nt12.impulses(B)
                with np.errstate(invalid="ignore"):
                    good = (np.isfinite(B["atr"][i]) & (B["atr"][i] > 0) & (B["spr"][i] <= SPR_R)
                            & ~np.isin((B["c"][i] % 1440) // 60, thin) & (B["c"][i] < np.datetime64(CUT, "m").astype(np.int64) - CENSOR_GUARD_MIN))
                yield (inst, g, kind), m1, B, vw, i[good], s[good], dict(src=src, thin=thin, raw=int(len(i)), kept=int(good.sum()))


def random_bars(B, i, rng):
    """A random TF bar in the same UTC clock hour of the same day as each signal bar (any bar of that hour)."""
    hk = B["t"] // 60
    lo = np.searchsorted(hk, hk[i], "left"); hi = np.searchsorted(hk, hk[i], "right")
    r = lo + np.floor(rng.random(len(i)) * (hi - lo)).astype(np.int64)
    ok = np.isfinite(B["atr"][r]) & (B["atr"][r] > 0)
    return np.where(ok, r, i)


def stream_outcomes(key, m1, B, vw, i, s, rng):
    g = key[1]
    R = POLICY["k"] * B["atr"][i]
    mk = simulate(B, i, s, B["atr"][i], B["flip"], POLICY)
    mko = simulate(B, i, s, B["atr"][i], B["flip"], POLICY, optimistic=True)
    o = dict(mkt=mk["net_R"], mkt_opt=mko["net_R"], ok=mk["ok"] & mko["ok"], day=B["day"][i], t=B["t"][i],
             spr=B["spr"][i], var={})
    for var in VARIANTS:
        fl, net, cens, wait = limit_trade(m1, B, g, i, s, R, var, vw)
        flt, nett, censt, _ = limit_trade(m1, B, g, i, s, R, var, vw, touch=True, optimistic=True)
        nul = np.zeros(len(i)); nulf = np.zeros(len(i)); ncens = np.zeros(len(i), bool)
        for _ in range(NDRAW):
            r = random_bars(B, i, rng)
            f2, n2, c2, _ = limit_trade(m1, B, g, r, s, POLICY["k"] * B["atr"][r], var, vw)
            nul += np.where(f2, np.nan_to_num(n2), 0.0) / NDRAW; nulf += f2 / NDRAW; ncens |= c2
        o["ok"] &= ~cens & ~censt & ~ncens
        o["var"][var[0]] = dict(filled=fl, net=net, filled_t=flt, net_t=nett, wait=wait, null_ps=nul, null_fill=nulf)
    return o


# ------------------------------------------------------------------ statistics
def holm(p):
    return nt12.holm(p)


METRICS = ["fill", "ps", "pf", "mkt_all", "mkt_f", "mkt_u", "adv", "exec_f", "d_mkt", "d_thin", "d_null", "ps_tb", "pf_tb",
           "null_ps", "null_fill"]


def vstats(mkt, filled, net, null_ps, null_fill, filled_t, net_t):
    """Per-signal metrics for one variant. ps = net R per signal (unfilled 0), pf = per filled trade."""
    fr = filled.mean()
    ps = np.where(filled, net, 0.0).mean()
    pf = net[filled].mean() if filled.any() else np.nan
    ma = mkt.mean()
    mf = mkt[filled].mean() if filled.any() else np.nan
    mu = mkt[~filled].mean() if (~filled).any() else np.nan
    ps_t = np.where(filled_t, net_t, 0.0).mean()
    pf_t = net_t[filled_t].mean() if filled_t.any() else np.nan
    return np.array([fr, ps, pf, ma, mf, mu, mf - ma, pf - mf, ps - ma, ps - fr * ma, ps - null_ps.mean(), ps_t, pf_t,
                     null_ps.mean(), null_fill.mean()])


def table(D, ix_all, all_days, nboot, seed=7):
    """Bootstrap all variants at once over the rows ix_all. Returns {variant: {metric: [point, lo, hi]}, p values}."""
    names = [v[0] for v in VARIANTS]
    col = lambda nm, k: D["var"][nm][k][ix_all]
    mkt = D["mkt"][ix_all]; day = D["day"][ix_all]
    V = {nm: (col(nm, "filled"), np.nan_to_num(col(nm, "net")), col(nm, "null_ps"), col(nm, "null_fill"),
              col(nm, "filled_t"), np.nan_to_num(col(nm, "net_t"))) for nm in names}

    def stat(ix):
        return np.concatenate([vstats(mkt[ix], *(a[ix] for a in V[nm])) for nm in names])
    T = stat(np.arange(len(mkt)))
    bt = day_boot(day, all_days, stat, nboot, seed=seed)
    K = len(METRICS); out = {}
    for j, nm in enumerate(names):
        o = {}
        for q, m in enumerate(METRICS):
            c = bt[:, j * K + q]
            o[m] = [float(T[j * K + q]), float(np.nanpercentile(c, 2.5)), float(np.nanpercentile(c, 97.5))]
        for m in ("pf", "d_thin", "d_null", "d_mkt", "ps"):
            c = bt[:, j * K + METRICS.index(m)]
            o["p_" + m] = float((np.sum(c <= 0) + 1) / (np.isfinite(c).sum() + 1))
        o["n"] = int(len(mkt)); o["n_filled"] = int(V[nm][0].sum())
        o["se_pf"] = float(np.nanstd(bt[:, j * K + METRICS.index("pf")]))
        out[nm] = o
    return out


def thinning_null(mkt, filled, rng):
    """Random thinning at the fill rate: percentile of the filled subset's market mean among random subsets of the
    same size (500 draws)."""
    nf = int(filled.sum())
    if nf == 0 or nf == len(mkt):
        return None
    d = np.array([mkt[rng.choice(len(mkt), nf, replace=False)].mean() for _ in range(NTHIN)])
    return dict(filled_mkt_mean=float(mkt[filled].mean()), random_q025=float(np.quantile(d, 0.025)),
                random_q975=float(np.quantile(d, 0.975)), pct=float((d < mkt[filled].mean()).mean()))


def run():
    t0 = time.time()
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    assert reg["code_sha256"]["lim13.py"] == CODE["lim13.py"], "lim13.py changed after registration (amend first)"
    assert reg["evaluator"]["digest"] == de.CODE_SHA
    rng = np.random.default_rng(13)
    recs, meta = [], {}
    for key, m1, B, vw, i, s, mt in streams():
        o = stream_outcomes(key, m1, B, vw, i, s, rng)
        o["key"] = key
        recs.append(o); meta["/".join(key)] = dict(**mt, ok=int(o["ok"].sum()))
        print(key, mt, "ok", int(o["ok"].sum()), round(time.time() - t0), "s", flush=True)
    names = [v[0] for v in VARIANTS]
    cat = lambda f: np.concatenate([f(r)[r["ok"]] for r in recs])
    D = dict(mkt=cat(lambda r: r["mkt"]), mkt_opt=cat(lambda r: r["mkt_opt"]), day=cat(lambda r: r["day"]),
             t=cat(lambda r: r["t"]), spr=cat(lambda r: r["spr"]),
             tf=cat(lambda r: np.full(len(r["mkt"]), r["key"][1])), kind=cat(lambda r: np.full(len(r["mkt"]), r["key"][2])),
             stream=cat(lambda r: np.full(len(r["mkt"]), "/".join(r["key"]))),
             var={nm: {k: cat(lambda r, nm=nm, k=k: r["var"][nm][k]) for k in recs[0]["var"][nm]} for nm in names})
    devt = np.datetime64(DEV_END, "m").astype(np.int64)
    res = dict(created=time.strftime("%Y-%m-%dT%H:%M:%S%z"), evaluator=de.CODE_SHA, code=CODE, streams=meta,
               note="development evidence only; 2023+ is a development window, never a holdout; nothing qualified", windows={})
    for win, m in (("dev2018_22", D["t"] < devt), ("w2023", D["t"] >= devt)):
        ix = np.where(m)[0]
        all_days = np.arange(D["day"][ix].min(), D["day"][ix].max() + 1)
        W = dict(n=int(len(ix)), mkt_mean=float(D["mkt"][ix].mean()), mkt_opt_mean=float(D["mkt_opt"][ix].mean()),
                 spread_R_mean=float(D["spr"][ix].mean()), primary=table(D, ix, all_days, NBOOT))
        for t in ("p_pf", "p_d_thin", "p_d_null"):
            ps = holm([W["primary"][nm][t] for nm in names])
            for nm, p in zip(names, ps):
                W["primary"][nm][t + "_holm"] = float(p)
        W["thinning_null"] = {nm: thinning_null(D["mkt"][ix], D["var"][nm]["filled"][ix], rng) for nm in names}
        W["wait_bars_median"] = {nm: float(np.median(D["var"][nm]["wait"][ix][D["var"][nm]["filled"][ix]])) for nm in names}
        fams = {}
        for tf in TFS:
            for kind in ("flip", "impulse"):
                jx = ix[(D["tf"][ix] == tf) & (D["kind"][ix] == kind)]
                fams[f"{tf}/{kind}"] = table(D, jx, all_days, NBOOT_FAM)
        W["families"] = fams
        st = {}
        for sk in np.unique(D["stream"][ix]):
            jx = ix[D["stream"][ix] == sk]
            st[sk] = dict(n=int(len(jx)), mkt=float(D["mkt"][jx].mean()), **{
                nm: dict(fill=float(D["var"][nm]["filled"][jx].mean()),
                         pf=float(np.nanmean(D["var"][nm]["net"][jx][D["var"][nm]["filled"][jx]])) if D["var"][nm]["filled"][jx].any() else None,
                         mkt_f=float(D["mkt"][jx][D["var"][nm]["filled"][jx]].mean()) if D["var"][nm]["filled"][jx].any() else None)
                for nm in names})
        W["streams"] = st
        res["windows"][win] = W
        for nm in names:
            v = W["primary"][nm]
            de.log_trial({"exp": EXP, "mode": "dev" if win == "dev2018_22" else "devwindow2023", "variant": nm, "window": win,
                          "config": dict(zip(["name", "level", "d_atr", "expiry_bars"], next(x for x in VARIANTS if x[0] == nm))),
                          "fill": v["fill"][0], "pf": v["pf"][0], "ps": v["ps"][0], "d_thin": v["d_thin"][0], "d_null": v["d_null"][0],
                          "p_pf_holm": v["p_pf_holm"], "lim13_sha256": CODE["lim13.py"]})
        print(win, "done", round(time.time() - t0), "s", flush=True)
    res["verdicts"] = verdicts(res)
    res["secs"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    print(json.dumps(res["verdicts"], indent=1))


def verdicts(res):
    out = {}
    d, w = res["windows"]["dev2018_22"]["primary"], res["windows"]["w2023"]["primary"]
    for nm in d:
        a = d[nm]["p_pf_holm"] < 0.05
        b = d[nm]["p_d_thin_holm"] < 0.05 and d[nm]["d_null"][1] > 0
        c_edge = w[nm]["pf"][0] > 0
        c_imp = w[nm]["d_thin"][0] > 0 and w[nm]["d_null"][0] > 0
        out[nm] = dict(dev_edge=a, dev_beats_thinning_and_null=b, w2023_edge=c_edge, w2023_improves=c_imp,
                       verdict="CANDIDATE" if (a and b and c_edge and c_imp) else
                       "IMPROVES_EXECUTION_ONLY" if (b and c_imp) else "FAIL")
    return out


# ------------------------------------------------------------------ checks
def check():
    def mk(rows, spread=0.0, t0=0, step=1):
        a = np.array(rows, float)
        return {"t": t0 + step * np.arange(len(a)), "bid_o": a[:, 0], "bid_h": a[:, 1], "bid_l": a[:, 2], "bid_c": a[:, 3],
                "ask_o": a[:, 0] + spread, "ask_h": a[:, 1] + spread, "ask_l": a[:, 2] + spread, "ask_c": a[:, 3] + spread,
                "volume": np.ones(len(a))}
    # M1: 10 minutes = 2 M5 bars; spread 0.1 (ask = bid + 0.1)
    m1 = mk([[100, 100.2, 99.9, 100], [100, 100.1, 99.95, 100], [100, 100.1, 99.95, 100], [100, 100.1, 99.95, 100],
             [100, 100.1, 99.95, 100],
             [100, 100.1, 99.85, 99.9], [99.9, 100, 99.7, 99.8], [99.8, 99.9, 99.6, 99.7], [99.7, 99.8, 99.6, 99.7],
             [99.7, 99.8, 99.6, 99.7]], spread=0.1)
    from bars import resample
    B = resample(m1, "M5"); B["flip"] = np.zeros(2, int); B["atr"] = np.ones(2); B["st"] = np.full(2, 99.0)
    # signal at bar 0 close; join the bid: buy limit 100.0. ask lows: bar1 minute5 ask_l 99.95 < 100 -> fill at m1 idx 5
    s = np.array([1])
    f = scan_fill(m1, B, "M5", np.array([0]), s, np.array([100.0]), 1)
    assert list(f) == [5], f
    # trade-through vs touch: limit 99.95 is touched (ask_l == 99.95) only in bar 1 minute 5 -> ask_l 99.95 at minute 5
    assert list(scan_fill(m1, B, "M5", np.array([0]), s, m1["ask_l"][5:6], 1)) == [6]  # minute 6 ask_l 99.8 trades through
    assert list(scan_fill(m1, B, "M5", np.array([0]), s, m1["ask_l"][5:6], 1, touch=True)) == [5]
    # beyond reach: limit 99.0 never fills; expiry ends the window
    assert list(scan_fill(m1, B, "M5", np.array([0]), s, np.array([99.0]), 1)) == [-1]
    # opposite flip on the order's first bar: order still live during that bar, then cancelled (here same result)
    B2 = dict(B); B2["flip"] = np.array([0, -1])
    assert list(scan_fill(m1, B2, "M5", np.array([0]), s, np.array([100.0]), 1)) == [5]
    # sell limit at the ask 100.1 + nothing above -> never fills (bid_h max 100.1 in bar 1, needs > 100.1)
    assert list(scan_fill(m1, B, "M5", np.array([0]), np.array([-1]), np.array([100.1]), 1)) == [-1]
    # first bar after fill minute 5: minutes 6..9 of bar 1, bid side
    bf, (o, h, l, c), flo = first_bar(m1, B, "M5", np.array([5]), s)
    assert bf[0] == 1 and o[0] == 99.9 and h[0] == 100 and l[0] == 99.6 and c[0] == 99.7 and flo[0] == 99.85
    # fill in the last minute of a bar -> empty rest
    bf, fb, _ = first_bar(m1, B, "M5", np.array([9]), s)
    assert bf[0] == 1 and np.isnan(fb[0][0])
    # limit_price: ref/st/vwap capping
    assert limit_price(B, np.array([0]), s, "ref", 0.25, None)[0] == B["bid_c"][0] - 0.25
    assert limit_price(B, np.array([0]), s, "st", 0, None)[0] == 99.0
    assert limit_price(B, np.array([0]), np.array([-1]), "st", 0, None)[0] == B["ask_c"][0]  # st below the ask: capped
    assert limit_price(B, np.array([0]), s, "vwap", 0, np.array([np.nan, 0]))[0] == B["bid_c"][0]  # no vwap: join
    # manage: fill-minute stop (pessimistic) and the optimistic bound ignores it
    Bm = mk([[100] * 4] * 80); fl = np.zeros(80, int)
    one = lambda **kw: manage(Bm, np.array([1]), np.array([1]), np.array([100.0]), np.array([0.5]), fl,
                              tuple(np.array([x]) for x in (100, 100, 100, 100)), **kw)
    r = one(fstop_low=np.array([99.4])); assert r["net_R"][0] == -1 and r["reason"][0] == STOP
    r = one(fstop_low=np.array([99.4]), optimistic=True); assert r["reason"][0] == TIME and r["net_R"][0] == 0
    # parity: manage == labels_v2.simulate for market entries on a real stream (both bounds)
    inst = "WTICO/USD"
    m1r, _ = nt12.load_m1c(inst)
    H1 = nt12.h1(inst, m1r)
    for g in TFS:
        Br = nt12.frame(inst, m1r, g, H1)
        i = np.where(Br["flip"] != 0)[0]; i = i[np.isfinite(Br["atr"][i]) & (Br["atr"][i] > 0)]; sd = Br["flip"][i]
        for opt in (False, True):
            a = simulate(Br, i, sd, Br["atr"][i], Br["flip"], POLICY, optimistic=opt)
            e = np.clip(i + 1, 0, len(Br["t"]) - 1); lo = sd > 0
            first = (np.where(lo, Br["bid_o"][e], -Br["ask_o"][e]), np.where(lo, Br["bid_h"][e], -Br["ask_l"][e]),
                     np.where(lo, Br["bid_l"][e], -Br["ask_h"][e]), np.where(lo, Br["bid_c"][e], -Br["ask_c"][e]))
            b = manage(Br, i + 1, sd, np.where(lo, Br["ask_o"][e], -Br["bid_o"][e]), POLICY["k"] * Br["atr"][i], Br["flip"], first,
                       None, POLICY, opt)
            assert np.array_equal(a["ok"], b["ok"]) and np.allclose(a["net_R"][a["ok"]], b["net_R"][b["ok"]], atol=0, rtol=0)
            assert np.array_equal(a["reason"][a["ok"]], b["reason"][b["ok"]])
        print(f"parity {g}: manage == simulate on {len(i)} WTI flips (pessimistic and optimistic)")
    print("lim13 self-check OK: fill trade-through vs touch, expiry, cancel window, sell side, partial first bar, "
          "limit capping, fill-minute stop bound, parity with labels_v2.simulate")


def register():
    Pf = os.path.join(HERE, "prereg.json")
    assert not os.path.exists(Pf), "prereg.json exists"
    nt = json.load(open(os.path.join(NT, "out", "results.json")))
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="limit13: passive limit-order entries on the live signal types vs market entry (queue v2 item 13)",
        before_registration="No outcome of any limit variant was computed before this file. `check` ran synthetic fixtures and "
                            "a parity test of manage() vs labels_v2.simulate on WTI market entries (equality only, no "
                            "statistics). Known before: notrade12 results (spread-filtered sets average about -0.12 R).",
        evaluator=dict(version="v2", digest=de.CODE_SHA, note="labels_v2.simulate (market baseline), fills.resolve, "
                       "validate.day_boot unchanged; manage() = simulate with entry bar/price/first bar as parameters, "
                       "parity-checked"),
        data=f"engine/cache M1 bid/ask npz via nt12.load_m1c, cut {CUT} UTC; M5/M15/H1 by bars.resample; production supertrend",
        signals=dict(
            types="supertrend flips and volume impulses (nt12 definitions) on M5 and M15",
            instruments=INSTS,
            filters=f"passing no-trade filters of notrade12: spread (ask_c-bid_c)/(1.5 ATR) at the signal bar <= {SPR_R} AND "
                    "entry hour (signal close, UTC) not in the instrument's 4 thin hours (nt12.thin_hours, 2018-2022 spread only)",
            thin_hours={k: v["thin"] for k, v in nt["streams"].items() if "/M5/flip" in k},
            guard="signals in the last 4 days before the cut dropped; a signal is dropped from ALL arms when the market "
                  "or any limit/null outcome is censored (paired sample)"),
        baseline="market entry at the open of the next bar on ask (buy) / bid (sell), labels_v2.simulate POLICY (308 baseline: "
                 "k=1.5, stop -1R, breakeven after +1R with one-bar latency, 3R target, opposite flip exits, H=72 bars)",
        variants=[dict(name=v[0], level=v[1], d_atr=v[2], expiry_bars=v[3]) for v in VARIANTS],
        variant_rules=dict(
            placement="order placed at the signal bar close. ref: buy limit at bid_c - d*ATR_tf, sell limit at ask_c + d*ATR_tf "
                      "(d=0: join the bid/ask). st: the supertrend line at the signal bar. vwap: session VWAP (22:00 UTC day, "
                      "M1 mid typical price x tick volume) at the signal close. A level on the marketable side is capped at "
                      "the bid (buy) / ask (sell)",
            life="live for TF bars k+1..k+expiry; cancelled after the close of the first opposite same-timeframe flip in that window",
            fill="conservative: buy fills in the first M1 bar whose ASK low < limit (sell: BID high > limit), at the limit price "
                 "(no price improvement on gaps). optimistic bound: touch (<=, >=) + optimistic management",
            management="308 baseline in R of the original stop distance (R = 1.5 ATR at the signal bar), stop/arm/target from "
                       "the fill price; management bar 0 = the remaining M1 minutes of the fill bar after the fill minute; "
                       "H=72 TF bars counted from the fill bar; conservative: a fill-minute exit-side low at or through the "
                       "stop exits at the stop"),
        candidate_budget=len(VARIANTS),
        family="primary: M5 + M15, all 6 instruments, flips + impulses pooled, signal-weighted. Breakdowns by TF x kind "
               "(4 signal families) and by stream (24) are exploratory",
        objective="net R per signal (unfilled = 0) and per filled trade, vs (i) market entry on the same signals, (ii) random "
                  "thinning of market entries at the fill rate (fill_rate x market mean; and the filled subset's market mean "
                  "vs 500 random subsets of the same size), (iii) a random-timing limit null: same variant, side, distance rule "
                  "and expiry placed at a random TF bar in the same UTC clock hour of the same day (20 draws, mean)",
        adverse_selection="market-entry R of filled vs unfilled signals (mkt_f - mkt_all), and the execution difference on "
                          "filled signals (limit R - market R)",
        statistics=f"5-day moving-block day bootstrap (validate.day_boot, {NBOOT} reps primary, {NBOOT_FAM} per family); "
                   "one-sided bootstrap p; Holm across the 8 variants per test",
        decision_rule="CANDIDATE (for shadow registration consideration, never 'qualified') iff (a) dev 2018-2022 Holm p < 0.05 "
                      "for per-filled-trade mean net R > 0, (b) dev Holm p < 0.05 for d_thin = net R per signal - fill_rate x "
                      "market mean > 0 AND dev 95% CI of d_null (minus random-timing null) above 0, (c) 2023+ development "
                      "window: per-filled mean > 0, d_thin > 0 and d_null > 0. IMPROVES_EXECUTION_ONLY iff (b) and the 2023+ "
                      "part of (c) on d_thin/d_null hold but (a) fails. Else FAIL. Conservative fills and management decide; "
                      "touch/optimistic reported as an upper bound",
        windows=dict(dev2018_22="signal time < 2023-01-01", w2023="2023-01-01..cut: DEVELOPMENT window, never a holdout"),
        rules="no test_ledger; nothing marked qualified; development evidence only; trials logged with exp limit13",
        code_sha256=dict(evaluator=de.CODE_SHA, evaluator_files=de.CODE_FILES_SHA, **CODE))
    json.dump(reg, open(Pf, "w"), indent=1)
    print("registered", reg["created"])


def amend():
    Pf = os.path.join(HERE, "prereg.json")
    reg = json.load(open(Pf))
    reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=sys.argv[2],
                                                  old_sha=reg["code_sha256"]["lim13.py"], new_sha=CODE["lim13.py"]))
    reg["code_sha256"]["lim13.py"] = CODE["lim13.py"]
    json.dump(reg, open(Pf, "w"), indent=1)


if __name__ == "__main__":
    {"check": check, "register": register, "run": run, "amend": amend}[sys.argv[1]]()
