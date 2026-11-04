"""daytype14 (queue v2 item 14): day-type classifier (trend / range / mixed, side-free) with a regime-conditional policy.

Evaluator v2 (labels_v2.simulate, fills.resolve, validate.day_boot) and the nt12 / abs11 / lim13 helpers are imported,
never edited. Development evidence only; nothing is qualified; no test ledger.

  python dt14.py check        synthetic self-checks (labels, range-fade simulator, random assignment)
  python dt14.py thresholds   2018-2022 main-window range quantiles (q60) and label base rates -> out/thresholds.json
  python dt14.py register     prereg.json (refuses to overwrite)
  python dt14.py amend "why"  append an amendment with new code hashes
  python dt14.py build INST   features, labels, per-day trade outcomes -> out/day_<TAG>.pkl, out/trd_<TAG>.pkl
  python dt14.py run          classifier walk-forward + policies + statistics -> out/results.json
"""
import os, sys, json, time, hashlib
from datetime import datetime
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
for p in (ENG, os.path.join(ENG, "audit", "notrade12"), os.path.join(ENG, "audit", "abs11"), os.path.join(ENG, "audit", "limit13"),
          os.path.join(ENG, "audit", "xvol9")):
    sys.path.insert(0, p)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.ensemble import HistGradientBoostingClassifier  # noqa: E402
import de_v2 as de  # noqa: E402
from labels_v2 import simulate, POLICY  # noqa: E402
from fills import resolve, STOP, TARGET  # noqa: E402
from validate import day_boot, year_start_day  # noqa: E402
import nt12  # noqa: E402
import abs11  # noqa: E402
import lim13  # noqa: E402

EXP = "daytype14"
INSTS = nt12.INSTS
TAG = lambda inst: inst.replace("/", "_")
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"dt14.py": sha(os.path.join(HERE, "dt14.py")), "nt12.py": nt12.CODE["nt12.py"], "abs11.py": abs11.CODE["abs11.py"],
        "lim13.py": lim13.CODE["lim13.py"], "evaluator": de.CODE_SHA}

# main session open per instrument (local exchange clock, DST-aware); the window ends at 21:00 UTC for all
MAIN_OPEN = {"WTICO/USD": ("America/New_York", 9, 0), "NATGAS/USD": ("America/New_York", 9, 0),
             "SPX500/USD": ("America/New_York", 9, 30), "XAU/USD": ("America/New_York", 8, 20),
             "XAG/USD": ("America/New_York", 8, 20), "EUR/USD": ("Europe/London", 8, 0)}
END_UTC = 21 * 60
MIN_COVER = 0.8                 # a window / checkpoint slice needs >= 80% of its expected M5 bars
EFF_TREND, EFF_RANGE, RNG_Q = 0.6, 0.3, 0.60
CHECKPOINTS = (60, 120, 240)    # minutes after the main open (classifier); policies use 120 and 240
POL_CPS = (120, 240)
DEADLINE = 60                   # signal bar must close >= 60 min before the window end
FADE_ZONE, STOP_BUF = 0.10, 0.25
NORM_N, NORM_MIN = 60, 20
EMB, Q_FIRST, TRAIL = 5, 2019, 365
NBOOT, NRAND = 1000, 1000
SPR_R = nt12.SPR_R
CRISES = abs11.CRISES
FEATS = ["rv1", "rv5", "rv22", "gap", "stress", "dow_s", "dow_c", "pre_rng_norm", "pre_eff",
         "so_rng_norm", "so_rv_norm", "so_eff", "so_peff", "so_disp", "so_loc"]
BASE = {"rv": ["rv1", "rv5", "rv22", "so_rv_norm"]}
VARIANTS = ["trend_120", "trend_240", "rmid_120", "rmid_240", "rvwap_120", "rvwap_240", "switch_120", "switch_240"]
dstr = lambda d: str(np.datetime64(int(d), "D"))
dnum = abs11.dnum


# ------------------------------------------------------------------ pure helpers
def day_label(O, H, L, C, rng_q):
    """1 = trend, -1 = range, 0 = mixed. eff = |C-O|/(H-L); range % = 100 (H-L)/O."""
    rng = H - L
    eff = np.where(rng > 0, np.abs(C - O) / np.where(rng > 0, rng, 1), 0.0)
    rp = 100 * rng / O
    return np.where((eff >= EFF_TREND) & (rp >= rng_q), 1, np.where(eff <= EFF_RANGE, -1, 0)), eff, rp


def range_sim(B, e, s, stop, tgt, e_end, optimistic=False, mid=False):
    """Fixed stop / fixed target / exit at the open of bar e_end. Entry at the open of bar e (long ask, short bid;
    mid=True: mid fills, no spread). Exit side in long semantics as labels_v2 (fills.resolve; stop first when both
    touch, optimistic: target). Returns net R (R = entry - stop in long semantics) and ok."""
    e = np.asarray(e, np.int64); s = np.asarray(s, np.int64); lo = s > 0
    pre = ("mid_", "mid_") if mid else ("bid_", "ask_")

    def bar(x):
        return (np.where(lo, B[pre[0] + "o"][x], -B[pre[1] + "o"][x]), np.where(lo, B[pre[0] + "h"][x], -B[pre[1] + "l"][x]),
                np.where(lo, B[pre[0] + "l"][x], -B[pre[1] + "h"][x]), np.where(lo, B[pre[0] + "c"][x], -B[pre[1] + "c"][x]))
    entry = np.where(lo, B[pre[1] + "o"][e], -B[pre[0] + "o"][e])
    st, tg = s * stop, s * tgt
    R = entry - st
    alive = (R > 0) & (tg > entry)
    ok = alive.copy()
    xp = np.full(len(e), np.nan)
    for j in range(int((e_end - e).max()) + 1 if len(e) else 0):
        x = np.minimum(e + j, len(B["t"]) - 1)
        o, h, l, c = bar(x)
        end = alive & (e + j >= e_end)
        xp[end] = o[end]; alive &= ~end
        r, p, am = resolve(o, h, l, st, tg)
        if optimistic:
            r = np.where(am, TARGET, r); p = np.where(am, tg, p)
        hit = alive & (r != 0)
        xp[hit] = p[hit]; alive &= ~hit
    net = np.where(ok, (xp - entry) / np.where(R > 0, R, 1), np.nan)
    return net, ok & np.isfinite(net)


def permute_within(groups, pred, rng):
    """Random day assignment at the same rates: permute `pred` within each group (instrument x quarter)."""
    key = groups * 4.0 + rng.random(len(groups))  # groups are integer ids, random in [0,1) breaks ties inside a group
    o_rand = np.lexsort((key,))
    o_orig = np.lexsort((np.arange(len(groups)), groups))
    out = np.empty_like(pred)
    out[o_rand] = pred[o_orig]
    return out


def check():
    O, H, L, C = np.array([100., 100, 100, 100]), np.array([103., 103, 101, 102]), np.array([100., 99, 99, 99.5]), np.array([102.5, 101.0, 100, 101])
    lab, eff, rp = day_label(O, H, L, C, 2.0)
    assert list(lab) == [1, -1, -1, 0], lab
    lab2, _, _ = day_label(O, H, L, C, 3.5)
    assert lab2[0] == 0
    # range-fade simulator on synthetic bars: short from 10.0 bid, stop 10.5, target 9.0
    n = 8
    B = {k: np.full(n, 10.0) for k in ("bid_o", "bid_h", "bid_l", "bid_c", "ask_o", "ask_h", "ask_l", "ask_c", "mid_o", "mid_h", "mid_l", "mid_c")}
    B["t"] = np.arange(n) * 5
    for k in ("ask_o", "ask_h", "ask_l", "ask_c"):
        B[k] = B[k] + 0.1
    B["bid_l"][3] = 8.8; B["ask_l"][3] = 8.9  # bar 3: ask low 8.9 <= 9.0 -> short target
    net, ok = range_sim(B, np.array([1]), np.array([-1]), np.array([10.5]), np.array([9.0]), np.array([6]))
    assert ok[0] and abs(net[0] - (10.0 - 9.0) / 0.5) < 1e-12, net
    B["ask_h"][2] = 10.6  # stop touched first at bar 2
    net, ok = range_sim(B, np.array([1]), np.array([-1]), np.array([10.5]), np.array([9.0]), np.array([6]))
    assert abs(net[0] + 1.0) < 1e-12
    net, ok = range_sim(B, np.array([1]), np.array([-1]), np.array([10.5]), np.array([9.0]), np.array([2]))  # session end at bar 2 open
    assert abs(net[0] - (10.0 - 10.1) / 0.5) < 1e-12
    net, ok = range_sim(B, np.array([1]), np.array([-1]), np.array([10.5]), np.array([10.2]), np.array([6]))  # target on the wrong side
    assert not ok[0]
    rng = np.random.default_rng(0); g = np.repeat(np.arange(5), 40); pr = rng.integers(-1, 2, 200)
    pp = permute_within(g, pr, rng)
    assert all(np.array_equal(np.sort(pr[g == k]), np.sort(pp[g == k])) for k in range(5)) and not np.array_equal(pr, pp)
    print("dt14 self-check OK: labels, range-fade simulator (target/stop/session end/invalid), within-group permutation")


# ------------------------------------------------------------------ data
def opens_utc(inst, days):
    tz, hh, mm = MAIN_OPEN[inst]
    out = []
    for d in days:
        dt = np.datetime64(int(d), "D").astype(datetime)
        loc = datetime(dt.year, dt.month, dt.day, hh, mm, tzinfo=ZoneInfo(tz))
        out.append(int(loc.timestamp() // 60))
    return np.array(out, np.int64)


def load(inst):
    m1, src = nt12.load_m1c(inst)
    H1 = nt12.h1(inst, m1)
    B = nt12.frame(inst, m1, "M5", H1)
    thin, _ = nt12.thin_hours(B)
    vw = lim13.vwap_bars(m1, B, "M5")
    return B, thin, vw, src


def windows_table(inst, B):
    """One row per weekday session: main-window index bounds and O/H/L/C, and checkpoint slices."""
    t = B["t"]
    days = np.unique(B["day"])
    days = days[((days + 3) % 7) < 5]  # Mon..Fri calendar dates (epoch day 0 = Thursday)
    op = opens_utc(inst, days)
    end = days * 1440 + END_UTC
    a = np.searchsorted(t, op); b = np.searchsorted(t, end)
    W = pd.DataFrame({"day": days, "open": op, "end": end, "a": a, "b": b, "nb": b - a})
    W["valid"] = (W.nb >= MIN_COVER * (W.end - W.open) / 5) & (W.end > W.open)
    mo, mh, ml, mc = B["mid_o"], B["mid_h"], B["mid_l"], B["mid_c"]
    O = np.where(W.valid, mo[np.clip(a, 0, len(t) - 1)], np.nan)
    H = np.array([mh[x:y].max() if v else np.nan for x, y, v in zip(a, b, W.valid)])
    L = np.array([ml[x:y].min() if v else np.nan for x, y, v in zip(a, b, W.valid)])
    C = np.where(W.valid, mc[np.clip(b - 1, 0, len(t) - 1)], np.nan)
    W["O"], W["H"], W["L"], W["C"] = O, H, L, C
    return W.set_index("day")


def thresholds():
    res = {}
    for inst in INSTS:
        B, thin, _, src = load(inst)
        W = windows_table(inst, B)
        lo, hi = year_start_day(2018), year_start_day(2023)
        V = W[W.valid & (W.index >= lo) & (W.index < hi)]
        rp = 100 * (V.H - V.L) / V.O
        q = float(np.quantile(rp, RNG_Q))
        lab, eff, _ = day_label(V.O.to_numpy(), V.H.to_numpy(), V.L.to_numpy(), V.C.to_numpy(), q)
        res[inst] = dict(range_q60_pct=q, n_windows_2018_22=int(len(V)), trend_rate_2018_22=float((lab == 1).mean()),
                         range_rate_2018_22=float((lab == -1).mean()), mixed_rate_2018_22=float((lab == 0).mean()),
                         median_window_bars=float(V.nb.median()), thin_hours=thin, m1_cache=src)
        print(inst, res[inst], flush=True)
    json.dump(res, open(os.path.join(OUT, "thresholds.json"), "w"), indent=1)


def build(inst):
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    cur = reg["amendments"][-1]["code_sha256"] if reg.get("amendments") else reg["code_sha256"]
    assert cur["dt14.py"] == CODE["dt14.py"], "dt14.py changed after registration (amend first)"
    q = reg["labels"]["range_q60_pct"][inst]
    t0 = time.time()
    B, thin, vw, src = load(inst)
    W = windows_table(inst, B)
    t = B["t"]; n = len(t)
    lab, eff, rp = day_label(W.O.to_numpy(), W.H.to_numpy(), W.L.to_numpy(), W.C.to_numpy(), q)
    W["label"] = np.where(W.valid, lab, -9); W["eff"] = eff; W["rng_pct"] = rp
    # session-level (abs11): HAR realized vol, gap, stress as of the 22:00 UTC session open
    _, D30 = abs11.session(abs11.bars30(inst))
    V = abs11.har(D30); st = abs11.stress_table()
    eps = 1e-4
    for k in ("rv1", "rv5", "rv22"):
        W[k] = np.log(V[k].reindex(W.index).to_numpy() + eps)
    W["gap"] = V["gap"].reindex(W.index).to_numpy()
    W["stress"] = st.reindex(W.index).to_numpy()
    dw = ((W.index.to_numpy() + 3) % 7) / 7
    W["dow_s"], W["dow_c"] = np.sin(2 * np.pi * dw), np.cos(2 * np.pi * dw)
    mo, mh, ml, mc = B["mid_o"], B["mid_h"], B["mid_l"], B["mid_c"]
    lr = np.log(mc / np.r_[np.nan, mc[:-1]])
    # pre-open segment: 22:00 UTC session start .. main open
    ps = np.searchsorted(t, W.index.to_numpy() * 1440 - 120); pe = W.a.to_numpy()
    pre_r, pre_e = [], []
    for x, y in zip(ps, pe):
        if y - x >= 6:
            hh, ll = mh[x:y].max(), ml[x:y].min()
            pre_r.append(100 * (hh - ll) / mo[x]); pre_e.append(abs(mc[y - 1] - mo[x]) / (hh - ll) if hh > ll else 0.0)
        else:
            pre_r.append(np.nan); pre_e.append(np.nan)
    W["pre_rng"] = pre_r; W["pre_eff"] = pre_e
    prior = lambda s: s.where(W.valid).rolling(NORM_N, min_periods=NORM_MIN).median().shift(1)
    W["pre_rng_norm"] = np.log((W.pre_rng + eps) / (prior(W.pre_rng) + eps))
    W["full_rng_med"] = prior(W.rng_pct)
    # checkpoint features
    for cp in CHECKPOINTS:
        a = W.a.to_numpy(); c = np.searchsorted(t, W.open.to_numpy() + cp)
        okc = W.valid.to_numpy() & (c - a >= MIN_COVER * cp / 5)
        f = {k: np.full(len(W), np.nan) for k in ("rng", "rv", "eff", "peff", "disp", "loc", "dir", "hi", "lo", "ci")}
        for r, (x, y) in enumerate(zip(a, c)):
            if not okc[r]:
                continue
            hh, ll, o0, cc = mh[x:y].max(), ml[x:y].min(), mo[x], mc[y - 1]
            rr = lr[x + 1:y]; rr = rr[np.isfinite(rr)]
            pth = np.abs(np.diff(np.r_[o0, mc[x:y]])).sum()
            f["rng"][r] = 100 * (hh - ll) / o0
            f["rv"][r] = 100 * np.sqrt((rr * rr).sum() + np.log(mc[x] / o0) ** 2)
            f["eff"][r] = abs(cc - o0) / (hh - ll) if hh > ll else 0.0
            f["peff"][r] = abs(cc - o0) / pth if pth > 0 else 0.0
            f["disp"][r] = 100 * abs(cc - o0) / o0
            f["loc"][r] = abs(2 * (cc - ll) / (hh - ll) - 1) if hh > ll else 0.0
            f["dir"][r] = np.sign(cc - o0); f["hi"][r] = hh; f["lo"][r] = ll; f["ci"][r] = y
        S = pd.DataFrame(f, index=W.index)
        W[f"ok_{cp}"] = okc
        W[f"so_rng_norm_{cp}"] = np.log((S["rng"] + eps) / (prior(S["rng"]) + eps))
        W[f"so_rv_norm_{cp}"] = np.log((S["rv"] + eps) / (prior(S["rv"]) + eps))
        W[f"so_eff_{cp}"] = S["eff"]; W[f"so_peff_{cp}"] = S["peff"]; W[f"so_loc_{cp}"] = S["loc"]
        W[f"so_disp_{cp}"] = np.log((S["disp"] + eps) / (W.full_rng_med + eps))
        for k in ("dir", "hi", "lo", "ci"):
            W[f"{k}_{cp}"] = S[k]
    # ---------------- trade outcomes on ALL valid days (policies select subsets later)
    hr = ((t + 5) % 1440) // 60
    with np.errstate(invalid="ignore", divide="ignore"):
        Rtr = POLICY["k"] * B["atr"]
        spr_tr = (B["ask_c"] - B["bid_c"]) / Rtr
        okbar = np.isfinite(B["atr"]) & (B["atr"] > 0) & ~np.isin(hr, thin)
        pull = np.r_[0, np.sign(mc[:-1] - mo[:-1])]
        trigL = okbar & (B["trend"] == 1) & (pull < 0) & (mc > np.r_[np.inf, mh[:-1]]) & (spr_tr <= SPR_R)
        trigS = okbar & (B["trend"] == -1) & (pull > 0) & (mc < np.r_[-np.inf, ml[:-1]]) & (spr_tr <= SPR_R)
    # session-end exit: an exit mark on the bar before the first bar with t >= end - 5
    eend = np.searchsorted(t, W.end.to_numpy() - 5)
    flipL = B["flip"].copy(); flipS = B["flip"].copy()
    mk = eend[(eend >= 1) & (eend < n)] - 1
    flipL[mk] = -1; flipS[mk] = 1
    Bmid = dict(B); Bmid.update({f"{s}_{k}": B[f"mid_{k}"] for s in ("bid", "ask") for k in "ohlc"})
    rows = []
    for cp in POL_CPS:
        days = W.index.to_numpy()
        okc = W[f"ok_{cp}"].to_numpy()
        ci = W[f"ci_{cp}"].to_numpy(); dl = np.searchsorted(t, W.end.to_numpy() - DEADLINE - 5, side="right")  # bars with t + 5 <= end - 60
        # trend continuation
        T = []
        for r in np.flatnonzero(okc & (W[f"dir_{cp}"].to_numpy() != 0)):
            x, y, d = int(ci[r]), int(dl[r]), int(W[f"dir_{cp}"].iloc[r])
            if y <= x:
                continue
            hit = np.flatnonzero((trigL if d > 0 else trigS)[x:y])
            if len(hit):
                T.append((r, x + hit[0], d))
        if T:
            r_, k_, s_ = map(np.array, zip(*T))
            res = {}
            for mode, BB, opt in (("net", B, False), ("opt", B, True), ("gross", Bmid, False)):
                net = np.full(len(k_), np.nan); ok = np.zeros(len(k_), bool)
                for sd, fl in ((1, flipL), (-1, flipS)):
                    m = s_ == sd
                    if m.any():
                        S_ = simulate(BB, k_[m], s_[m], B["atr"][k_[m]], fl, POLICY, optimistic=opt)
                        net[m] = S_["net_R"]; ok[m] = S_["ok"]
                res[mode] = (net, ok)
            for j in range(len(k_)):
                rows.append(dict(day=days[r_[j]], cp=cp, pol="trend", side=int(s_[j]), k=int(k_[j]), t=int(t[k_[j]]),
                                 net=res["net"][0][j], opt=res["opt"][0][j], gross=res["gross"][0][j],
                                 ok=bool(res["net"][1][j] and res["opt"][1][j] and res["gross"][1][j]), spr=float(spr_tr[k_[j]])))
        # range fade to the checkpoint-range midpoint or the session VWAP
        for tgt_kind in ("rmid", "rvwap"):
            F = []
            for r in np.flatnonzero(okc):
                x, y = int(ci[r]), int(dl[r])
                if y <= x:
                    continue
                H0, L0 = W[f"hi_{cp}"].iloc[r], W[f"lo_{cp}"].iloc[r]
                rg = H0 - L0
                if not rg > 0:
                    continue
                runH = np.maximum.accumulate(np.maximum(mh[x:y], H0)); runL = np.minimum.accumulate(np.minimum(ml[x:y], L0))
                atr = B["atr"][x:y]
                stS = runH + STOP_BUF * atr; stL = runL - STOP_BUF * atr
                tg = np.full(y - x, (H0 + L0) / 2) if tgt_kind == "rmid" else vw[x:y]
                sp = B["ask_c"][x:y] - B["bid_c"][x:y]
                with np.errstate(invalid="ignore", divide="ignore"):
                    cS = (mh[x:y] >= H0 - FADE_ZONE * rg) & (mc[x:y] < mo[x:y]) & (mc[x:y] < H0) & (B["bid_c"][x:y] > tg) & \
                         (sp <= SPR_R * (stS - mc[x:y])) & okbar[x:y]
                    cL = (ml[x:y] <= L0 + FADE_ZONE * rg) & (mc[x:y] > mo[x:y]) & (mc[x:y] > L0) & (B["ask_c"][x:y] < tg) & \
                         (sp <= SPR_R * (mc[x:y] - stL)) & okbar[x:y]
                hit = np.flatnonzero(cS | cL)
                if len(hit):
                    j = hit[0]; sd = -1 if cS[j] else 1
                    F.append((r, x + j, sd, stS[j] if sd < 0 else stL[j], tg[j]))
            if F:
                r_, k_, s_, st_, tg_ = map(np.array, zip(*F))
                e = k_ + 1; ee = eend[r_]
                res = {m: range_sim(B, e, s_, st_, tg_, ee, optimistic=o, mid=md) for m, o, md in
                       (("net", False, False), ("opt", True, False), ("gross", False, True))}
                for j in range(len(k_)):
                    rows.append(dict(day=days[r_[j]], cp=cp, pol=tgt_kind, side=int(s_[j]), k=int(k_[j]), t=int(t[k_[j]]),
                                     net=res["net"][0][j], opt=res["opt"][0][j], gross=res["gross"][0][j],
                                     ok=bool(res["net"][1][j] and res["opt"][1][j] and res["gross"][1][j]),
                                     spr=float((B["ask_c"][k_[j]] - B["bid_c"][k_[j]]) / abs(mc[k_[j]] - st_[j]))))
    TR = pd.DataFrame(rows)
    W.to_pickle(os.path.join(OUT, f"day_{TAG(inst)}.pkl")); TR.to_pickle(os.path.join(OUT, f"trd_{TAG(inst)}.pkl"))
    msg = dict(inst=inst, days=int(W.valid.sum()), trades={f"{p}_{c}": int(((TR.pol == p) & (TR.cp == c)).sum()) for p in ("trend", "rmid", "rvwap") for c in POL_CPS},
               secs=round(time.time() - t0), m1=src, thin=thin)
    print(json.dumps(msg), flush=True)


# ------------------------------------------------------------------ classifier
def hgb_fit(X, y):
    return HistGradientBoostingClassifier(max_iter=150, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=50,
                                          l2_regularization=1.0, random_state=0).fit(X, y)


def lr_p(M, X):
    return 1 / (1 + np.exp(-de.e2_lr_raw(M, X)))


def walk(day, X, y):
    """Quarterly expanding refit from 2019 (train rows with day < quarter start - EMB). OOS scores + per-quarter
    prediction threshold: the (1 - training base rate) quantile of the current model's scores over the trailing
    TRAIL days (no labels), so the predicted-type rate tracks the training base rate."""
    n = len(y); P = {k: np.full(n, np.nan) for k in ("lr", "hgb", "base_rv")}
    thr = np.full(n, np.nan); base = np.full(n, np.nan); qid = np.full(n, -1)
    ix_rv = [FEATS.index(k) for k in BASE["rv"]]
    for qi, (qs, qd) in enumerate(abs11.quarters(int(day.max()))):
        nxt = abs11.quarters(int(day.max()))
        qe = nxt[qi + 1][1] if qi + 1 < len(nxt) else int(day.max()) + 1
        tr = day < qd - EMB; te = (day >= qd) & (day < qe)
        if tr.sum() < 150 or y[tr].sum() < 15 or not te.any():
            continue
        M = de.e2_lr_fit(X[tr], y[tr], np.ones(int(tr.sum())))
        P["lr"][te] = lr_p(M, X[te])
        P["hgb"][te] = hgb_fit(X[tr], y[tr]).predict_proba(X[te])[:, 1]
        P["base_rv"][te] = lr_p(de.e2_lr_fit(X[tr][:, ix_rv], y[tr], np.ones(int(tr.sum()))), X[te][:, ix_rv])
        b = float(y[tr].mean()); trl = (day >= qd - TRAIL) & (day < qd)
        thr[te] = float(np.quantile(lr_p(M, X[trl]), 1 - b)); base[te] = b; qid[te] = qi
    return P, thr, base, qid


def auc(y, s):
    return float(roc_auc_score(y, s)) if 0 < y.sum() < len(y) else np.nan


def auc_ci(y, s, day, rng, nb=200):
    return abs11.auc_ci(y, s, day, rng, nb)


# ------------------------------------------------------------------ run
def wins(last_day):
    w = {"dev": (year_start_day(2019), year_start_day(2023)), "w2023": (year_start_day(2023), last_day + 1)}
    w.update({c: (dnum(a), min(dnum(b), last_day + 1)) for c, (a, b) in CRISES.items()})
    return w


def classify(inst, W, rng, res):
    """Per checkpoint: trend and range classifiers; returns predicted type per day (1, -1, 0, NaN = not scoreable)."""
    preds = {}
    for cp in CHECKPOINTS:
        cols = [k if k in W.columns else f"{k}_{cp}" for k in FEATS]
        X = W[cols].to_numpy(float)
        m = W.valid.to_numpy() & W[f"ok_{cp}"].to_numpy() & np.isfinite(X).all(1)
        d = W.index.to_numpy()[m]; Xm = X[m]; lab = W.label.to_numpy()[m]
        sc, thr = {}, {}
        for tgt, val in (("trend", 1), ("range", -1)):
            y = (lab == val).astype(int)
            P, th, base, qid = walk(d, Xm, y)
            eff = W[f"so_eff_{cp}"].to_numpy()[m]
            P["naive_eff"] = eff if tgt == "trend" else -eff
            sc[tgt] = (P, th, base, y, qid)
            ok = np.isfinite(P["lr"])
            for w, (lo, hi) in wins(int(d.max())).items():
                mm = ok & (d >= lo) & (d < hi)
                if mm.sum() < 50 or y[mm].sum() < 5 or y[mm].sum() == mm.sum():
                    continue
                a = {k: (auc_ci(y[mm], P[k][mm], d[mm], rng) if w in ("dev", "w2023") else [auc(y[mm], P[k][mm])]) for k in P}
                cal = {k: dict(citl=float(P[k][mm].mean() - y[mm].mean()), brier=float(np.mean((P[k][mm] - y[mm]) ** 2)),
                               brier_base=float(y[mm].mean() * (1 - y[mm].mean()))) for k in ("lr", "hgb")}
                pr = mm & (P["lr"] >= th)
                res.setdefault("classifier", {}).setdefault(inst, {}).setdefault(str(cp), {}).setdefault(tgt, {})[w] = dict(
                    n=int(mm.sum()), base=float(y[mm].mean()), auc=a, cal=cal, pred_rate=float(pr.sum() / mm.sum()),
                    precision=float(y[pr].mean()) if pr.any() else None, recall=float(y[pr].sum() / y[mm].sum()))
                for k in a:
                    de.log_trial({"exp": EXP, "inst": inst, "cp": cp, "target": tgt, "window": w, "model": k, "auc": a[k][0],
                                  "mode": "dev" if w == "dev" else "devwindow", "dt14_sha256": CODE["dt14.py"]})
            yrs = {}
            for yv in range(2019, 2023):
                mm = ok & (d >= year_start_day(yv)) & (d < year_start_day(yv + 1))
                if mm.any():
                    yrs[str(yv)] = float(P["lr"][mm].mean() - y[mm].mean())
            res["classifier"][inst][str(cp)][tgt]["citl_dev_years"] = yrs
        pt, tt, bt, _, qid = sc["trend"]; prr, trr, br, _, _ = sc["range"]
        okp = np.isfinite(pt["lr"]) & np.isfinite(prr["lr"])
        isT = okp & (pt["lr"] >= tt); isR = okp & (prr["lr"] >= trr)
        both = isT & isR
        pick_t = (pt["lr"] / bt) >= (prr["lr"] / br)
        pred = np.where(~okp, np.nan, np.where(isT & (~both | pick_t), 1, np.where(isR, -1, 0))).astype(float)
        s = pd.Series(np.nan, index=W.index); s.loc[d] = pred
        q = pd.Series(-1, index=W.index); q.loc[d] = qid
        preds[cp] = (s, q)
    return preds


def run():
    t0 = time.time()
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    cur = reg["amendments"][-1]["code_sha256"] if reg.get("amendments") else reg["code_sha256"]
    assert cur["dt14.py"] == CODE["dt14.py"], "dt14.py changed after registration (amend first)"
    rng = np.random.default_rng(14)
    res = dict(code=CODE, note="development evidence; 2023+ is a development window, not a holdout; nothing qualified")
    rows = []
    for ii, inst in enumerate(INSTS):
        W = pd.read_pickle(os.path.join(OUT, f"day_{TAG(inst)}.pkl")); TR = pd.read_pickle(os.path.join(OUT, f"trd_{TAG(inst)}.pkl"))
        preds = classify(inst, W, rng, res)
        for cp in POL_CPS:
            pr, qid = preds[cp]
            base = pd.DataFrame({"inst": ii, "day": W.index, "label": W.label.to_numpy(), "pred": pr.to_numpy(), "qid": qid.to_numpy(), "cp": cp})
            base = base[np.isfinite(base.pred) & (base.label > -9)]
            for pol in ("trend", "rmid", "rvwap"):
                T = TR[(TR.cp == cp) & (TR.pol == pol) & TR.ok].set_index("day")
                for k in ("net", "opt", "gross"):
                    base[f"{pol}_{k}"] = T[k].reindex(base.day).to_numpy()
            rows.append(base)
        print("classified", inst, round(time.time() - t0), flush=True)
    A = pd.concat(rows, ignore_index=True)
    A.to_pickle(os.path.join(OUT, "pooled.pkl"))
    last = int(A.day.max())
    res["policies"] = policies(A, wins(last), rng)
    res["secs"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    print("done secs", res["secs"], flush=True)


def outcome(A, var, sel, k="net"):
    """Per row: R of the policy's trade on the row (NaN when no trade), given the selection vector sel (pred type)."""
    pol, cp = var.rsplit("_", 1)
    if pol == "switch":
        return np.where(sel == 1, A[f"trend_{k}"], np.where(sel == -1, A[f"rmid_{k}"], np.nan))
    want = 1 if pol == "trend" else -1
    return np.where(sel == want, A[f"{pol}_{k}"], np.nan)


def alldays(A, var, k="net", ix=slice(None)):
    pol, cp = var.rsplit("_", 1)
    if pol == "switch":
        return np.r_[A[f"trend_{k}"][ix], A[f"rmid_{k}"][ix]]
    return A[f"{pol}_{k}"][ix]


def policies(A, W, rng):
    out = {}
    for var in VARIANTS:
        cp = int(var.rsplit("_", 1)[1])
        S = A[A.cp == cp].reset_index(drop=True)
        pred = S.pred.to_numpy(); lab = S.label.to_numpy().astype(float)
        grp = (S.inst.to_numpy() * 1000 + S.qid.to_numpy()).astype(np.int64)
        o = {}
        for w, (lo, hi) in W.items():
            m = ((S.day >= lo) & (S.day < hi)).to_numpy()
            if m.sum() < 30:
                continue
            Sm = {c: S[c].to_numpy()[m] for c in S.columns}
            x = outcome(Sm, var, pred[m]); xo = outcome(Sm, var, pred[m], "opt"); xg = outcome(Sm, var, pred[m], "gross")
            xor = outcome(Sm, var, lab[m])  # oracle: true label
            al = alldays(Sm, var); al = al[np.isfinite(al)]
            day = Sm["day"]
            pol = var.rsplit("_", 1)[0]

            def stat(ix):
                xx = x[ix]; tr = np.isfinite(xx)
                ad = alldays(Sm, var, ix=ix); ad = ad[np.isfinite(ad)]
                pt = xx[tr].mean() if tr.any() else np.nan
                return np.array([pt, np.nansum(xx) / len(ix), pt - (ad.mean() if len(ad) else np.nan),
                                 ad.mean() if len(ad) else np.nan, np.nanmean(xor[ix]) if np.isfinite(xor[ix]).any() else np.nan])
            Tst = stat(np.arange(len(x)))
            bt = day_boot(day, np.arange(day.min(), day.max() + 1), stat, NBOOT if w in ("dev", "w2023") else 300, seed=14)
            ci = lambda j: [float(Tst[j]), float(np.nanpercentile(bt[:, j], 2.5)), float(np.nanpercentile(bt[:, j], 97.5))]
            # random day assignment at the same rates (within instrument x quarter)
            rnd_t, rnd_d = [], []
            for _ in range(NRAND if w in ("dev", "w2023") else 200):
                pp = permute_within(grp[m], pred[m], rng)
                xr = outcome(Sm, var, pp)
                rnd_t.append(np.nanmean(xr) if np.isfinite(xr).any() else np.nan); rnd_d.append(np.nansum(xr) / len(xr))
            rnd_t, rnd_d = np.array(rnd_t), np.array(rnd_d)
            by_type = {}
            for lv, nm in ((1, "trend"), (-1, "range"), (0, "mixed")):
                if pol == "switch":
                    continue
                v = Sm[f"{pol}_net"][lab[m] == lv]; v = v[np.isfinite(v)]
                g = Sm[f"{pol}_gross"][lab[m] == lv]; g = g[np.isfinite(g)]
                by_type[nm] = dict(n=int(len(v)), net=float(v.mean()) if len(v) else None, gross=float(g.mean()) if len(g) else None)
            pa = pred[m]
            o[w] = dict(rows=int(m.sum()), pred_trend=float((pa == 1).mean()), pred_range=float((pa == -1).mean()),
                        trades=int(np.isfinite(x).sum()), net_per_trade=ci(0), net_per_day=ci(1), delta_vs_alldays=ci(2),
                        alldays_per_trade=ci(3), alldays_trades=int(len(al)), oracle_per_trade=ci(4),
                        oracle_trades=int(np.isfinite(xor).sum()),
                        gross_per_trade=float(np.nanmean(xg)) if np.isfinite(xg).any() else None,
                        opt_per_trade=float(np.nanmean(xo)) if np.isfinite(xo).any() else None,
                        alldays_gross=float(np.nanmean(alldays(Sm, var, "gross"))),
                        se_per_trade=float(np.nanstd(bt[:, 0])),
                        p_trade_le0=float((np.sum(bt[:, 0] <= 0) + 1) / (np.isfinite(bt[:, 0]).sum() + 1)),
                        p_delta_le0=float((np.sum(bt[:, 2] <= 0) + 1) / (np.isfinite(bt[:, 2]).sum() + 1)),
                        random=dict(per_trade_mean=float(np.nanmean(rnd_t)), per_trade_q=[float(np.nanquantile(rnd_t, 0.025)), float(np.nanquantile(rnd_t, 0.975))],
                                    per_day_mean=float(rnd_d.mean()), pct_of_actual=float((rnd_t < Tst[0]).mean()),
                                    p=float((np.sum(rnd_t >= Tst[0]) + 1) / (len(rnd_t) + 1))),
                        by_actual_type_alldays=by_type)
            de.log_trial({"exp": EXP, "variant": var, "window": w, "net_per_trade": float(Tst[0]), "trades": o[w]["trades"],
                          "mode": "dev" if w == "dev" else "devwindow", "dt14_sha256": CODE["dt14.py"]})
            print(var, w, json.dumps({k: o[w][k] for k in ("trades", "net_per_trade", "delta_vs_alldays", "oracle_per_trade")}), flush=True)
        out[var] = o
    # Holm across the 8 variants, per window, for the positive-R test and the beats-random test
    for w in ("dev", "w2023"):
        for key in ("p_trade_le0", "p_rand"):
            ps = [out[v][w][key] if key != "p_rand" else out[v][w]["random"]["p"] for v in VARIANTS]
            adj = nt12.holm(ps)
            for v, a in zip(VARIANTS, adj):
                out[v][w][f"holm_{key}"] = float(a)
    for v in VARIANTS:
        d, z = out[v]["dev"], out[v]["w2023"]
        sup = all(o["net_per_trade"][1] > 0 and o["holm_p_trade_le0"] < 0.05 and o["holm_p_rand"] < 0.05 and o["delta_vs_alldays"][1] > 0
                  for o in (d, z))
        rej = all(o["net_per_trade"][2] < 0 for o in (d, z))
        out[v]["disposition"] = "SUPPORTED (development only)" if sup else ("REJECTED" if rej else "INCONCLUSIVE")
        out[v]["mde_dev"] = 2.8 * d["se_per_trade"]; out[v]["mde_w2023"] = 2.8 * z["se_per_trade"]
    return out


def register(amend=None):
    f = os.path.join(HERE, "prereg.json")
    if amend:
        reg = json.load(open(f))
        reg.setdefault("amendments", []).append(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"), reason=amend, code_sha256=CODE))
        json.dump(reg, open(f, "w"), indent=1); print("amended"); return
    assert not os.path.exists(f), "prereg.json exists (use amend)"
    th = json.load(open(os.path.join(OUT, "thresholds.json")))
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="daytype14: day-type classifier (trend / range, side-free) with a regime-conditional policy; queue v2 item 14, issue 310",
        before_registration=("Computed before this file: only the 2018-2022 main-window range-% distribution (q60) per instrument and the "
                             "2018-2022 label base rates (out/thresholds.json), to fix the label. No feature, model, score, trade or post-2022 "
                             "outcome was computed. Prior knowledge: abs11 (A1 day level learnable), notrade12 (spread/thin filters), "
                             "limit13 (passive entries fail on adverse selection), risk8, and the general finding that direction is at chance."),
        declared="Development evidence only. No test ledger, nothing qualified. 2023+ is a development window, not a holdout. "
                 "Binding confirmation for any survivor is prospective (issue 313) or post-2026-10-07 data.",
        evaluator=dict(version="v2", digest=de.CODE_SHA, note="labels_v2.simulate, fills.resolve, validate.day_boot imported unchanged"),
        data="engine/cache M1 bid/ask via nt12.load_m1c (cut 2026-10-07T18:30 UTC); M5 bid/ask/mid by bars.resample; production supertrend (de_v2.supertrend) on M5 mid",
        instruments=INSTS,
        windows=dict(main_open={k: f"{v[1]:02d}:{v[2]:02d} {v[0]} (DST-aware)" for k, v in MAIN_OPEN.items()},
                     end="21:00 UTC on the same calendar date (session day key = (t+120)//1440, 22:00 UTC roll)",
                     valid=f">= {MIN_COVER:.0%} of the expected M5 bars in [main open, 21:00 UTC); Mon-Fri dates only"),
        labels=dict(definition=f"eff = |C-O|/(H-L), range% = 100 (H-L)/O on mid M5 bars of the main window. TREND: eff >= {EFF_TREND} AND range% >= q{int(RNG_Q*100)} "
                               f"of 2018-2022 valid windows (per instrument, fixed). RANGE: eff <= {EFF_RANGE}. MIXED: otherwise.",
                    range_q60_pct={k: v["range_q60_pct"] for k, v in th.items()},
                    base_rates_2018_22={k: dict(trend=v["trend_rate_2018_22"], range=v["range_rate_2018_22"], mixed=v["mixed_rate_2018_22"]) for k, v in th.items()}),
        features=dict(list=FEATS, definitions={
            "rv1/rv5/rv22, gap, stress": "abs11 definitions (30-min HAR realized vol of previous sessions, |session open - prev close| %, cross-instrument stress share), known at the 22:00 UTC open",
            "dow_s/dow_c": "abs11 day of week",
            "pre_rng_norm": "log(range % of 22:00 UTC .. main open / trailing 60-day (min 20) median of the same)",
            "pre_eff": "|C-O|/(H-L) of 22:00 UTC .. main open",
            "so_rng_norm": "log(range % main open .. checkpoint / trailing 60-day median at the same checkpoint)",
            "so_rv_norm": "log(M5 realized vol main open .. checkpoint / trailing 60-day median at the same checkpoint)",
            "so_eff": "|c - O| / (h - l) so far (directional efficiency, side-free)",
            "so_peff": "|c - O| / sum |dclose| so far (path efficiency)",
            "so_disp": "log(|c - O| % / trailing 60-day median full-window range %)",
            "so_loc": "|2 (c - l)/(h - l) - 1| (close at an extreme of the range so far)"}),
        checkpoints_min=list(CHECKPOINTS), policy_checkpoints_min=list(POL_CPS),
        models=dict(lr="de_v2.e2_lr_fit (standardized L2 LR, C=0.1), one row per day, exportable; one binary model per type (trend vs rest, range vs rest) per checkpoint",
                    hgb="HistGradientBoosting comparator (150 iter, lr 0.05, 15 leaves, min leaf 50, l2 1.0)",
                    baselines="rv LR (rv1, rv5, rv22, so_rv_norm); naive efficiency so far (trend: so_eff; range: -so_eff)",
                    refit="quarterly expanding from 2019-01-01, training rows with day < quarter start - 5 days, from data start (2018)",
                    prediction="predicted TREND if p_trend >= the (1 - training trend base rate) quantile of the current model's p_trend over the trailing 365 days (no labels); "
                               "same for RANGE; both -> the larger p/base ratio; neither -> MIXED (no trade)"),
        policies=dict(
            common=f"entry at the open of the bar after the signal bar (long ask, short bid); signal bar starts at or after the checkpoint and closes >= {DEADLINE} min before 21:00 UTC; "
                   "signal hour not in the instrument's 4 thin hours (nt12.thin_hours); spread (ask_c - bid_c) at the signal bar <= 0.2 R; one trade per day per policy (first qualifying bar); "
                   "equal cash risk (results in R); session-end exit at the open of the first M5 bar with t >= 20:55 UTC",
            trend="P-trend: direction d = sign(close at checkpoint - main open). Signal: M5 supertrend trend == d, previous bar closed against d (pullback), signal bar closes beyond "
                  "the previous bar's high (long) / low (short) (price confirmation). Management: labels_v2 POLICY (stop 1.5 ATR, arm +1R -> breakeven, target 3R, opposite flip exit, 72 bars) + session-end exit. R = 1.5 ATR",
            range=f"P-range: checkpoint range [L0, H0] of the main window. Short signal: bar high >= H0 - {FADE_ZONE} (H0-L0), bar closes down (mid c < o) and below H0; long mirrored. "
                  f"Stop = running extreme since the checkpoint (incl. H0/L0) +/- {STOP_BUF} ATR(M5) at the signal bar; target = midpoint (H0+L0)/2 (rmid) or the session VWAP at the signal bar (rvwap); "
                  "the target must be on the profit side of the signal-bar quote; R = |entry - stop|; exits: stop, target, session end (fills.resolve, stop first when both touch)",
            switch="P-switch: P-trend on predicted trend days, P-range (midpoint) on predicted range days, no trade on predicted mixed days",
            variants=VARIANTS),
        baselines=dict(alldays="the same entry rules on ALL scoreable days (no classifier)",
                       random="random day assignment at the same predicted rates: predicted types permuted within instrument x quarter (1000 draws)",
                       no_trade="0 R", oracle="true-label assignment (upper bound for classifier skill, uses the outcome window; diagnosis only)"),
        metrics=dict(net="net R per trade and per scoreable instrument-day, moving-block day bootstrap (block 5, 1000 reps), pooled over instruments",
                     paired="delta net R/trade vs the all-days rule (same bootstrap); percentile of actual vs random assignment",
                     bounds="intrabar ordering: pessimistic (stop first, decision) and optimistic (target first) R/trade",
                     layers="classifier skill (AUC, calibration, precision of the predicted type), policy conversion (all-days net and gross R by actual day type; oracle), costs (gross mid fills vs net bid/ask)",
                     classifier="AUC with day-cluster bootstrap CI (200) per instrument, checkpoint, type; calibration-in-the-large per dev year; Brier vs base",
                     crisis="abs11 windows 2020H1, 2022H1, 2025Q4-26Q1: stress tests, reported only",
                     power="MDE = 2.8 x bootstrap SE of net R/trade"),
        decision_rule=("A policy variant is SUPPORTED (development evidence only, eligible to propose a shadow registration under issue 313) iff in BOTH dev 2019-2022 and 2023+: "
                       "net R/trade 95% CI lower bound > 0; Holm-adjusted (8 variants) one-sided p (R/trade <= 0) < 0.05; Holm-adjusted p vs random assignment < 0.05; "
                       "and delta vs the all-days rule CI lower bound > 0. REJECTED iff the net R/trade CI upper bound < 0 in both windows. Otherwise INCONCLUSIVE (with MDE). "
                       "Classifier skill alone qualifies nothing."),
        budget=dict(policy_candidates=len(VARIANTS), checkpoints=len(CHECKPOINTS), models=2, baselines_classifier=2, tuned_hyperparameters=0,
                    fixed_constants=dict(EFF_TREND=EFF_TREND, EFF_RANGE=EFF_RANGE, RNG_Q=RNG_Q, FADE_ZONE=FADE_ZONE, STOP_BUF=STOP_BUF, DEADLINE=DEADLINE)),
        code_sha256=CODE)
    json.dump(reg, open(f, "w"), indent=1)
    print("registered", reg["created"])


if __name__ == "__main__":
    MODE = sys.argv[1] if len(sys.argv) > 1 else ""
    if MODE == "check":
        check()
    elif MODE == "thresholds":
        thresholds()
    elif MODE == "register":
        register()
    elif MODE == "amend":
        register(amend=sys.argv[2])
    elif MODE == "build":
        build(sys.argv[2])
    elif MODE == "run":
        run()
