"""Ladder steps D-E on M5 with M1 bid/ask underneath. EVALUATOR v2 (copy of de.py v1, which stays frozen).

v2 changes (audit/v2): D1 labels_v2 (admissible optimistic bound); D2 an E that was never fitted is "undefined: no
support", not "rejected"; D3 every trial and ledger record carries EVALUATOR_VERSION and the code SHA-256; D4 the
freeze checks E support before fitting; E redesign (E2_*: pooled windows, coverage rule, sign-safe calibration,
family-matched Bonferroni), selected variant in audit/v2/selected.json.

  python de_v2.py check         fixtures + no-lookahead (as v1)
  python de_v2.py dev  INST     development (writes results/de2_dev_*, frozen_de_v2.json)
  python de_v2.py final INST    one test look per frozen variant (ledger test_ledger_de_v2.jsonl)

v1 description follows.

  python de.py check            fixtures (episode lifecycle, no-entry, startup discovery) + no-lookahead on real data
  python de.py dev  INST        develop on 2018-2022 only (M1 truncated at 2023-01-01), walk-forward 2019-2022,
                                writes results/de_dev_<inst>.{json,md} and freezes the variants in frozen_de.json
  python de.py final INST       score 2023-01-01..newest ONCE per frozen variant (ledger test_ledger_de.jsonl)

D: sequential wait/confirm entry. Volatility gate (spike 4: day regime P(big day) at the open, intraday checkpoint
   P(big day), trailing-rank cutoffs) opens an episode; the follower side is the established M5 supertrend trend
   (no recent flip needed). It waits for confirmation (H1 or M15 supertrend agrees, or a break of the day's range),
   enters at the next open (bid/ask), with the frozen 308 management policy (labels.POLICY: stop -1R, breakeven
   after +1R, 3R runner target, exit on the opposite M5 flip = supertrend trail, 72-bar horizon).
   Episode = maximal run of active bars with one trend side inside one trading day. Cadence: every M5 close.
   Window: W bars after discovery, then EXPIRED. Invalidation: trend flip, day end or gate close.
   One entry per episode, no rearm, no overlap (a decision bar before the open position's exit bar is REJECTED busy).
   Carried constraint from 309: no entry when spread at the decision bar > 0.2 R (REJECTED spread).
E: calibrated accept/skip (L2 logistic regression + Platt calibration) over every D candidate bar
   (all confirmed bars inside the window, not only the first), episode-weighted; the D+E policy takes the first
   candidate with calibrated p >= p*, p* chosen on a separate later window, and p* = no entries unless the
   threshold window's mean R at p* is > 0.
"""
import sys, os, json, time, hashlib, sqlite3, subprocess
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from bars import load_m1, resample, coverage, iso, DB, CACHE, F as FIELDS, MIN
from labels_v2 import POLICY, simulate
from nulls import BarIndex
from validate import day_of, tod_of, year_start_day, day_boot, ci, trial_count, config_hash
import validate
import gate
from ladder import feats as cfeats, summarize, maxdd, look, window_bars, NWIN

sys.path.insert(0, "/Users/mfittko/github/market-signals/data/research/modellab/spike4")
from data import build_days, day_stats, thresholds, day_features, checkpoint_raw, checkpoint_norms, CPS, NCP  # noqa

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "results")
FROZEN = os.path.join(HERE, "frozen_de_v2.json")
LEDGER = os.path.join(HERE, "test_ledger_de_v2.jsonl")
EXP = "ladder-de-v2"
EVALUATOR_VERSION = "v2"
CODE_FILES = ["de_v2.py", "labels_v2.py", "fills.py", "bars.py", "nulls.py", "validate.py", "gate.py", "ladder.py", "flips.mjs",
              "../modellab/spike4/data.py"]


def code_sha256():
    """Per-file SHA-256 of the evaluator code and one digest over them (recorded in every trial and ledger record)."""
    files = {f: hashlib.sha256(open(os.path.join(HERE, f), "rb").read()).hexdigest() for f in CODE_FILES}
    return files, hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()


CODE_FILES_SHA, CODE_SHA = code_sha256()


def log_trial(rec, path=None):
    validate.log_trial({**rec, "evaluator": EVALUATOR_VERSION, "code_sha256": CODE_SHA}, path)


def outcomes(B):
    """ladder.outcomes with labels_v2 (corrected optimistic bound)."""
    n = len(B["t"]); idx = np.arange(n)
    return {opt: {s: simulate(B, idx, np.full(n, s), B["atr"], B["flip"], POLICY, optimistic=opt) for s in (1, -1)}
            for opt in (False, True)}
DEV_END, DEV_YEARS, EMB = "2023-01-01", [2019, 2020, 2021, 2022], 5
SPR_MAX = 0.2
GATES = [("none", None), ("armed", 0.6), ("armed", 0.8), ("fired", 0.8), ("fired", 0.9)]
CONFIRMS = ["imm", "h1", "m15", "brk"]
WAITS = [12, 48]
MIN_TRAIN_TRADES = 100
STATE_Q = dict(armed=0.8, fired=0.9)  # fixed state definition for the chop split (off / armed / fired)
PGRID = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65]
MIN_THR_TRADES = 30
MUE = 0.05  # minimum useful effect, R per trade
NBOOT = 2000
WAIT, REJ_SPREAD, REJ_BUSY, ENTER, HOLD, EXPIRED = 1, 2, 3, 4, 5, 6
K = NCP - 1
PREREG = dict(
    version=2,  # v2 (dev only, before any test look): E label arm (was net_R > 0), p grid 0.40-0.65, E windows by quarter
    e_label="arm: +1R before the stop within H (308 label contract)",
    objective="mean net R per entered trade (1R risk per trade, bid/ask fills), 95% moving-block day bootstrap",
    references=["no-trade (0 R)", "frozen immediate-entry A (every flip)", "D-imm: same gate and episodes, enter at discovery",
                "D-nogate: same follower always on", "execution-matched nulls (same-time-of-day, circular)",
                "E: same D without selection"],
    mue_R=MUE, risk=dict(max_share_below_minus_1_5R=0.02, maxdd_R_per_year_max=None),
    coverage=">= 30 entries per test year (guards against winning by blocking; no quota)",
    runner_retention="p_runner of selected >= 0.8 x comparator p_runner",
    sample="independent episodes; test >= 100 entries",
    multiple_comparisons="dev is development data; test: one look per frozen variant, verdict on the Bonferroni interval "
                         "over the frozen variants of the instrument; confirmation by prospective shadow (313)",
    schedule="dev walk-forward 2019..2022, freeze, single test look 2023-01-01..newest",
    grid=dict(gates=GATES, confirms=CONFIRMS, waits=WAITS, spr_max=SPR_MAX, e_pgrid=PGRID),
    policy=POLICY)


# ------------------------------------------------------------------ data
def prefetch(inst):
    """Fill the bars.load_m1 cache with per-year read-only queries, so no single read holds the db lock for long."""
    n, t0, tmax = coverage(inst)
    f = os.path.join(CACHE, f"{inst.replace('/', '_')}_{n}_{tmax[:16].replace(':', '')}.npz")
    if os.path.exists(f):
        return
    rows = []
    for y in range(int(t0[:4]), int(tmax[:4]) + 1):
        con = sqlite3.connect(DB, uri=True, timeout=1)
        rows += con.execute("select cast(strftime('%s', substr(time,1,19)) as integer)/60, " + ", ".join(FIELDS) +
                            " from candles_ba where instrument=? and granularity='M1' and time>=? and time<? order by time",
                            (inst, f"{y}", f"{y + 1}")).fetchall()
        con.close()
    assert len(rows) == n, (len(rows), n)
    a = np.array(rows, dtype=np.float64)
    np.savez(f, t=a[:, 0].astype(np.int64), **{k: a[:, i + 1] for i, k in enumerate(FIELDS)})


def supertrend(inst, G):
    """Production supertrend (flips.mjs) on mid bars; cached by a hash of the inputs."""
    h = hashlib.sha1(G["t"].tobytes() + G["mid_c"].tobytes() + G["mid_h"].tobytes() + G["mid_l"].tobytes()).hexdigest()[:12]
    base = os.path.join(CACHE, f"st_{inst.replace('/', '_')}_{h}")
    if not os.path.exists(base + ".out.csv"):
        pd.DataFrame({"time": G["t"], "open": G["mid_o"], "high": G["mid_h"], "low": G["mid_l"], "close": G["mid_c"]}).to_csv(base + ".in.csv", index=False)
        subprocess.run(["node", os.path.join(HERE, "flips.mjs"), base + ".in.csv", base + ".out.csv"], check=True, capture_output=True)
        os.remove(base + ".in.csv")
    fl = pd.read_csv(base + ".out.csv")
    return {k: fl[k].to_numpy(float) for k in ("trend", "flip", "atr", "st")}


def build(inst, m1):
    B = resample(m1, "M5")
    S = supertrend(inst, B)
    for k in ("trend", "atr", "st"):
        B[k] = S[k]
    B["trend"] = np.nan_to_num(B["trend"]).astype(int)
    B["flip"] = np.nan_to_num(S["flip"]).astype(int)
    for g in ("M15", "H1"):  # higher-timeframe trend from COMPLETED bars only: bar T usable when T + len <= t + 5
        Gb = resample(m1, g)
        tr = np.nan_to_num(supertrend(inst, Gb)["trend"]).astype(int)
        j = np.searchsorted(Gb["t"] + MIN[g], B["t"] + 5, side="right") - 1
        B["tr_" + g] = np.where(j >= 0, tr[np.clip(j, 0, None)], 0)
    c, h, l = (pd.Series(B["mid_" + k]) for k in "chl")
    B["de"] = ((c - c.shift(NWIN)).abs() / c.diff().abs().rolling(NWIN).sum()).to_numpy()
    inter = (np.minimum(h, h.shift()) - np.maximum(l, l.shift())).clip(lower=0)
    union = np.maximum(h, h.shift()) - np.minimum(l, l.shift())
    B["ovl"] = (inter / union).rolling(NWIN).mean().to_numpy()
    B["ema"] = c.ewm(span=20, adjust=False).mean().to_numpy()
    B["day"] = day_of(B["t"]); B["tod"] = tod_of(B["t"])
    d = pd.Series(B["day"])
    B["nday"] = d.groupby(d).cumcount().to_numpy()  # bars of this day before this one
    B["dopen"] = pd.Series(B["mid_o"]).groupby(d).transform("first").to_numpy()
    B["dhi"] = h.groupby(d).cummax().groupby(d).shift(1).to_numpy()  # day range of the PRIOR bars of the day
    B["dlo"] = l.groupby(d).cummin().groupby(d).shift(1).to_numpy()
    B["brk"] = np.where(B["nday"] >= 12, np.where(B["mid_c"] > B["dhi"], 1, np.where(B["mid_c"] < B["dlo"], -1, 0)), 0)
    a = pd.Series(B["atr"])
    B["atr_ratio"] = (a / a.rolling(2880, min_periods=576).median()).to_numpy()
    B["spr"] = (B["ask_c"] - B["bid_c"]) / (POLICY["k"] * B["atr"])
    tr = B["trend"]
    B["since_flip"] = np.arange(len(tr)) - np.maximum.accumulate(np.where(np.r_[True, tr[1:] != tr[:-1]], np.arange(len(tr)), 0))
    return B


# ------------------------------------------------------------------ volatility gate (spike 4 design)
def gate_layer(m1):
    raw = {"t": m1["t"], **{k: (m1["bid_" + k] + m1["ask_" + k]) / 2 for k in "ohlc"}}
    D = build_days(raw); S = day_stats(D); thr = thresholds(S["exc"])
    Fd, _, _ = day_features(D, S, thr)
    R = checkpoint_raw(D); nr, nv = checkpoint_norms(R)
    valid = ~np.isnan(Fd[:, gate.HAR]).any(1) & ~np.isnan(thr) & ~np.isnan(nr).any(1)
    th = thr[:, None]
    with np.errstate(divide="ignore", invalid="ignore"):
        CX = np.stack([R[:, :K, 2] / th, np.abs(R[:, :K, 4]) / th, np.where(nr[:, :K] > 0, R[:, :K, 3] / nr[:, :K], 1.0),
                       np.where(nv[:, :K] > 0, R[:, :K, 5] / nv[:, :K], 1.0), np.repeat(CPS[None, :K] / 1440.0, len(thr), 0)], -1)
    return dict(day=D["day"].astype(np.int64), X=Fd[:, gate.HAR], y=(S["exc"] >= thr).astype(int), valid=valid,
                CX=CX, nyb=R[:, :K, 2] < th)


def logit(p):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


def cp_matrix(L, M):
    lreg = logit(np.nan_to_num(gate.score(L, M), nan=0.5))
    return np.concatenate([np.repeat(lreg[:, None, None], K, 1), L["CX"]], -1)


def fit_gate(L, end_day):
    """Day model + checkpoint model on days < end_day only."""
    M = gate.fit(L, L["day"] < end_day)
    tr = (L["day"] < end_day) & L["valid"]
    X = cp_matrix(L, M)
    rows = tr[:, None] & L["nyb"]
    Xr, yr = X[rows], np.repeat(L["y"][:, None], K, 1)[rows]
    mu, sd = Xr.mean(0), Xr.std(0) + 1e-12
    lr = LogisticRegression(C=1.0, max_iter=2000).fit((Xr - mu) / sd, yr)
    return dict(day=M, cp=dict(mean=mu.tolist(), scale=sd.tolist(), coef=lr.coef_[0].tolist(), b=float(lr.intercept_[0])),
                end_day=int(end_day))


def daily_rank(P, ok, valid, n=252, minn=126):
    """rank[d, k] = share of the prior n valid days whose max alertable P is below P[d, k] (prior days only)."""
    dm = np.where(ok, P, 0.0).max(1)
    vi = np.where(valid)[0]
    out = np.full(P.shape, np.nan)
    for j, d in enumerate(vi):
        if j >= minn:
            hist = np.sort(dm[vi[max(0, j - n):j]])
            out[d] = np.searchsorted(hist, P[d], side="left") / len(hist)
    return out


def gate_states(B, L, GM):
    """Per-bar gate information available at the bar's close."""
    p_open = gate.score(L, GM["day"])
    arank_d = gate.trailing_rank(p_open)
    c = GM["cp"]
    P = 1 / (1 + np.exp(-(((cp_matrix(L, GM["day"]) - np.array(c["mean"])) / np.array(c["scale"])) @ np.array(c["coef"]) + c["b"])))
    P = np.where(L["valid"][:, None], P, np.nan)
    crank = daily_rank(P, L["nyb"], L["valid"])
    dpos = np.clip(np.searchsorted(L["day"], B["day"]), 0, len(L["day"]) - 1)
    have = (L["day"][dpos] == B["day"]) & L["valid"][dpos]
    k = (B["tod"] + 5) // 30 - 1  # last checkpoint completed at the bar close
    kc = np.clip(k, 0, K - 1)
    out = dict(avail=have & np.isfinite(arank_d[dpos]), arank=np.where(have, arank_d[dpos], np.nan),
               lreg=np.where(have, logit(np.nan_to_num(p_open[dpos], nan=0.5)), np.nan),
               cpP=np.where(have & (k >= 0), P[dpos, kc], np.where(have, p_open[dpos], np.nan)), fired={})
    for q in sorted({g[1] for g in GATES if g[0] == "fired"} | {STATE_Q["fired"]}):
        f = np.maximum.accumulate(((crank >= q) | ~L["nyb"]) & L["valid"][:, None] & np.isfinite(crank), axis=1)
        out["fired"][q] = have & (k >= 0) & f[dpos, kc] & out["avail"]
    st = np.full(len(B["t"]), -1)
    st[out["avail"]] = 0
    st[out["avail"] & (out["arank"] >= STATE_Q["armed"])] = 1
    st[out["fired"][STATE_Q["fired"]]] = 2
    out["state"] = st  # -1 unavailable, 0 off, 1 armed, 2 fired
    return out


# ------------------------------------------------------------------ D replay
def episodes(trend, day, active):
    a = active & (trend != 0)
    prev_same = np.r_[False, a[:-1]] & (trend == np.r_[0, trend[:-1]]) & (day == np.r_[-1, day[:-1]])
    ep = np.cumsum(a & ~prev_same) - 1
    return np.where(a, ep, -1)


def replay(ep, side, confirm, spr_ok, W, exit_bar, gate_open_next=None):
    """Causal first-permitted-entry replay. Bar i decides at its close with data <= i; entry fills at bar i+1's open.
    Returns per-bar states, entry bars, and one record per episode (all episodes, including no-entry ones)."""
    n = len(ep)
    state = np.zeros(n, np.int8)
    idx = np.where(ep >= 0)[0]
    if not len(idx):
        return state, np.zeros(0, np.int64), []
    _, first, cnt = np.unique(ep[idx], return_index=True, return_counts=True)
    last_exit, entries, recs = -1, [], []
    for f, c in zip(first, cnt):
        bars = idx[f:f + c]
        win = bars[:W]
        conf = confirm[win]
        busy = win < last_exit
        st = np.where(conf, np.where(~spr_ok[win], REJ_SPREAD, np.where(busy, REJ_BUSY, ENTER)), WAIT)
        ok = st == ENTER
        nxt = bars[-1] + 1
        end = ("data_end" if nxt >= n else "flip" if side[nxt] != side[bars[-1]] else "day_end_or_gate_close")
        rec = dict(disc=int(bars[0]), last=int(bars[-1]), side=int(side[bars[0]]), n_eval=0, n_wait=0, n_rej_spread=0,
                   n_rej_busy=0, entry=-1, outcome="")
        if ok.any():
            j = int(np.argmax(ok)); i = int(win[j])
            state[win[:j]] = st[:j]; state[i] = ENTER; state[bars[j + 1:]] = HOLD
            entries.append(i); rec["entry"] = i; rec["outcome"] = "entered"
            if exit_bar[i] >= 0:
                last_exit = int(exit_bar[i])
            seen = st[:j]
        else:
            state[win] = st; state[bars[W:]] = EXPIRED
            rec["outcome"] = "expired" if c > W else ("invalidated_" + end)
            seen = st
        rec.update(n_eval=int(len(seen) + (rec["entry"] >= 0)), n_wait=int((seen == WAIT).sum()),
                   n_rej_spread=int((seen == REJ_SPREAD).sum()), n_rej_busy=int((seen == REJ_BUSY).sum()))
        recs.append(rec)
    return state, np.array(entries, np.int64), recs


def gate_open(B, GS, g):
    if g[0] == "none":
        return np.ones(len(B["t"]), bool)
    if g[0] == "armed":
        return GS["avail"] & (GS["arank"] >= g[1])
    return GS["fired"][g[1]]


def confirm_mask(B, conf):
    s = B["trend"]
    return {"imm": np.ones(len(s), bool), "h1": B["tr_H1"] == s, "m15": B["tr_M15"] == s, "brk": (B["brk"] == s) & (s != 0)}[conf]


def base_active(B, O):
    s = B["trend"]
    ok = np.where(s > 0, O[False][1]["ok"], O[False][-1]["ok"])
    return (s != 0) & np.isfinite(B["atr"]) & (B["atr"] > 0) & np.isfinite(B["spr"]) & ok


def run_d(B, O, GS, cfg, extra=None):
    g, conf, W = cfg
    act = base_active(B, O) & gate_open(B, GS, g)
    ep = episodes(B["trend"], B["day"], act)
    cm = confirm_mask(B, conf)
    if extra is not None:
        cm = cm & extra
    xb = np.where(B["trend"] > 0, O[False][1]["exit_bar"], O[False][-1]["exit_bar"])
    st, ent, recs = replay(ep, B["trend"], cm, B["spr"] <= SPR_MAX, W, xb)
    return dict(ep=ep, state=st, entries=ent, recs=recs, confirm=cm, act=act)


def trades(B, O, i):
    i = np.asarray(i, np.int64); s = B["trend"][i]
    T = {"i": i, "s": s, "day": B["day"][i], "net": look(O[False], i, s, "net_R"), "net_opt": look(O[True], i, s, "net_R"),
         "arm": look(O[False], i, s, "arm"), "runner": look(O[False], i, s, "runner"), "amb": look(O[False], i, s, "amb"),
         "reason": look(O[False], i, s, "reason"), "entry": look(O[False], i, s, "entry"), "R": look(O[False], i, s, "R")}
    T["exit_day"] = B["day"][np.clip(look(O[False], i, s, "exit_bar"), 0, len(B["t"]) - 1)]
    return T


def sel(T, m):
    return {k: v[m] for k, v in T.items()}


def cat(Ts):
    return {k: np.concatenate([T[k] for T in Ts]) for k in Ts[0]}


# ------------------------------------------------------------------ E
VOLF = ["lreg", "cpP", "arank", "atr_ratio"]
BASEF = ["spr", "de", "ovl", "ext", "dinv", "tod_s", "tod_c", "since_flip", "since_disc", "h1", "m15", "brk", "daymv"]


def e_features(B, GS, ep):
    s = B["trend"]; a = B["atr"]
    idx = np.where(ep >= 0)[0]
    disc = np.full(len(ep), -1); _, f = np.unique(ep[idx], return_index=True)
    starts = idx[f]; disc[idx] = starts[np.searchsorted(ep[starts], ep[idx])] if len(idx) else 0
    ang = 2 * np.pi * (B["tod"] + 5) / 1440
    F = dict(spr=B["spr"], de=B["de"], ovl=B["ovl"], ext=s * (B["mid_c"] - B["ema"]) / a, dinv=s * (B["mid_c"] - B["st"]) / a,
             tod_s=np.sin(ang), tod_c=np.cos(ang), since_flip=np.log1p(B["since_flip"]),
             since_disc=np.log1p(np.maximum(np.arange(len(ep)) - disc, 0)), h1=(B["tr_H1"] == s).astype(float),
             m15=(B["tr_M15"] == s).astype(float), brk=(B["brk"] == s).astype(float), daymv=s * (B["mid_c"] - B["dopen"]) / a,
             lreg=GS["lreg"], cpP=GS["cpP"], arank=GS["arank"], atr_ratio=B["atr_ratio"])
    return F


def e_fit(X, y, w, Xc, yc):
    """Standardize + L2 LR on the fit window; Platt calibration on a later window. Coefficients only (exportable)."""
    mu, sd = X.mean(0), X.std(0) + 1e-12
    lr = LogisticRegression(C=0.1, max_iter=3000).fit((X - mu) / sd, y, sample_weight=w)
    z = (Xc - mu) / sd @ lr.coef_[0] + lr.intercept_[0]
    pl = LogisticRegression(C=1e6, max_iter=1000).fit(z[:, None], yc)
    return dict(mean=mu.tolist(), scale=sd.tolist(), coef=lr.coef_[0].tolist(), b=float(lr.intercept_[0]),
                platt=[float(pl.coef_[0][0]), float(pl.intercept_[0])])


def e_score(M, X):
    z = (X - np.array(M["mean"])) / np.array(M["scale"]) @ np.array(M["coef"]) + M["b"]
    return 1 / (1 + np.exp(-(M["platt"][0] * z + M["platt"][1])))


def candidates(B, O, R, W):
    """E population: every D candidate bar (confirmed, spread ok, inside the window), with its label and episode."""
    ep = R["ep"]
    idx = np.where(ep >= 0)[0]
    _, f, c = np.unique(ep[idx], return_index=True, return_counts=True)
    pos = np.zeros(len(ep), int); pos[idx] = np.arange(len(idx)) - np.repeat(f, c)
    m = (ep >= 0) & (pos < W) & R["confirm"] & (B["spr"] <= SPR_MAX)
    i = np.where(m)[0]
    T = trades(B, O, i)
    T["ep"] = ep[i]
    T["w"] = 1.0 / np.bincount(ep[i])[ep[i]]
    T["y"] = T["arm"].astype(int)  # 308 label contract: reached +1R before the stop (p_arm); dev v1 used net_R > 0 (base 0.18)
    return T


def e_windows(C, a, b, c, d):
    """fit: exit < b-EMB ; cal: start >= b, exit < c-EMB ; thr: start >= c, exit < d-EMB. Episodes never straddle."""
    fit = (C["exit_day"] < b - EMB) & (C["day"] >= a)
    cal = (C["day"] >= b) & (C["exit_day"] < c - EMB)
    thr = (C["day"] >= c) & (C["exit_day"] < d - EMB)
    for x, y in ((fit, cal), (cal, thr), (fit, thr)):
        assert not (x & y).any() and not np.isin(C["ep"][x], C["ep"][y]).any()
    if fit.any() and cal.any():
        assert C["exit_day"][fit].max() < C["day"][cal].min()
    if cal.any() and thr.any():
        assert C["exit_day"][cal].max() < C["day"][thr].min()
    return fit, cal, thr


def choose_p(B, O, GS, cfg, pbar, lo_day, hi_day, tag):
    best = (np.inf, -np.inf, 0)
    for p in PGRID:
        R = run_d(B, O, GS, cfg, extra=pbar >= p)
        T = trades(B, O, R["entries"])
        m = (T["day"] >= lo_day) & (T["exit_day"] < hi_day - EMB)
        mr = float(T["net"][m].mean()) if m.sum() >= MIN_THR_TRADES else -np.inf
        log_trial({"exp": EXP, "mode": "dev", **tag, "variant": "E-threshold", "p": p, "trades": int(m.sum()), "meanR": mr})
        if mr > best[1]:
            best = (p, mr, int(m.sum()))
    return best[0] if best[1] > 0 else float("inf"), best  # absolute requirement: mean R > 0 at p*, else no entries


def e_matrix(F, cols, i):
    return np.column_stack([F[c][i] for c in cols])


# ------------------------------------------------------------------ E, evaluator v2 (registered redesign, audit/v2/prereg.json)
# All variants share: learner fit on purged earlier rows; the accept rule is a raw-score cutoff at a coverage quantile of
# the threshold window's candidate rows (subset-admitting); support guard BEFORE any fit (D4); calibration can only
# make E unavailable, never invert a ranking; qualification is Bonferroni over the verdicts issued in the look.
E2_QGRID = (0.5, 0.35, 0.2, 0.1)  # accepted share of threshold-window candidate rows; 0.10 is the predeclared minimum coverage
E2_MIN_THR_TRADES = 30            # policy trades at q inside the pooled threshold window
E2_MIN_FIT, E2_MIN_CAL = 200, 100
E2_POOL_MONTHS = 6                # split6: one model, pooled calibration+threshold window = the last 6 months
E2_BLOCK_MONTHS, E2_MAX_BLOCKS = 3, 8  # crossfit: quarterly blocks, at most the last 8 quarters (2 years) pooled
E2_VARIANTS = {
    "V1": dict(windows="crossfit", gate="abs", calib="platt_ci"),
    "V2": dict(windows="crossfit", gate="vsD", calib="platt_ci"),
    "V3": dict(windows="crossfit", gate="vsD", calib="isotonic"),
    "V4": dict(windows="split6", gate="vsD", calib="platt_ci"),
}
E2_SELECTED = os.path.join(HERE, "audit", "v2", "selected.json")


def e2_lr_fit(X, y, w):
    """Frozen E learner without its calibrator: standardized L2 LR (C=0.1), episode weights."""
    mu, sd = X.mean(0), X.std(0) + 1e-12
    lr = LogisticRegression(C=0.1, max_iter=3000).fit((X - mu) / sd, y, sample_weight=w)
    return dict(mean=mu.tolist(), scale=sd.tolist(), coef=lr.coef_[0].tolist(), b=float(lr.intercept_[0]))


def e2_lr_raw(M, X):
    return (X - np.array(M["mean"])) / np.array(M["scale"]) @ np.array(M["coef"]) + M["b"]


def platt_ci(z, y, grp):
    """Platt fit (unpenalized) with an episode-clustered sandwich 95% CI of the slope."""
    pl = LogisticRegression(C=1e6, max_iter=1000).fit(z[:, None], y)
    a, b = float(pl.coef_[0][0]), float(pl.intercept_[0])
    X = np.column_stack([z, np.ones(len(z))]); p = 1 / (1 + np.exp(-(X @ [a, b])))
    H = (X * (p * (1 - p))[:, None]).T @ X
    _, inv = np.unique(grp, return_inverse=True)
    S = np.zeros((inv.max() + 1, 2)); np.add.at(S, inv, X * (y - p)[:, None])
    Hi = np.linalg.pinv(H); V = Hi @ (S.T @ S) @ Hi
    se = float(np.sqrt(max(V[0, 0], 0)))
    return dict(kind="platt", slope=a, intercept=b, slope_ci=[a - 1.96 * se, a + 1.96 * se])


def e2_calibrate(z, y, grp, kind):
    """Returns (calibrator dict, ok, reason). platt_ci: unavailable unless the slope CI is above 0.
    isotonic: monotone non-decreasing by construction; unavailable only when the fit is constant (no positive association)."""
    if kind == "platt_ci":
        c = platt_ci(z, y, grp)
        return c, c["slope_ci"][0] > 0, "calibration slope CI not above 0" if c["slope_ci"][0] <= 0 else ""
    from sklearn.isotonic import IsotonicRegression
    ir = IsotonicRegression(increasing=True, out_of_bounds="clip").fit(z, y)
    c = dict(kind="isotonic", x=ir.X_thresholds_.tolist(), y=ir.y_thresholds_.tolist())
    flat = (max(c["y"]) - min(c["y"])) < 1e-9
    return c, not flat, "isotonic calibration constant" if flat else ""


def e2_prob(cal, z):
    if cal["kind"] == "platt":
        return 1 / (1 + np.exp(-(cal["slope"] * z + cal["intercept"])))
    return np.interp(z, cal["x"], cal["y"])


def e2_threshold(B, O, GS, cfg, sbar, zthr, lo_day, hi_day, gate):
    """Coverage rule: for each q, accept bars with raw score >= the (1-q) quantile of the threshold-window candidate
    scores; q* maximizes the window's policy mean R among q with >= E2_MIN_THR_TRADES trades. Gate: abs -> mean R > 0;
    vsD -> mean R > D's mean R in the same window (D = same policy without selection)."""
    win = lambda T: (T["day"] >= lo_day) & (T["exit_day"] < hi_day - EMB)
    TD = trades(B, O, run_d(B, O, GS, cfg)["entries"]); mD = win(TD)
    ref = float(TD["net"][mD].mean()) if mD.any() else float("nan")
    grid = []
    for q in E2_QGRID:
        cut = float(np.quantile(zthr, 1 - q))
        T = trades(B, O, run_d(B, O, GS, cfg, extra=sbar >= cut)["entries"]); m = win(T)
        grid.append(dict(q=q, cut=cut, trades=int(m.sum()), meanR=float(T["net"][m].mean()) if m.any() else float("nan")))
    elig = [g for g in grid if g["trades"] >= E2_MIN_THR_TRADES]
    info = dict(grid=grid, D_meanR=ref, D_trades=int(mD.sum()))
    if not elig:
        return np.inf, dict(info, cause="threshold: support < 30 trades at every q")
    best = max(elig, key=lambda g: g["meanR"])
    bar = 0.0 if gate == "abs" else ref
    info.update(q=best["q"], cut=best["cut"], thr_meanR=best["meanR"], thr_trades=best["trades"])
    if not best["meanR"] > bar:
        return np.inf, dict(info, cause="threshold: gate (window mean R at q* <= " + ("0" if gate == "abs" else "D") + ")")
    return best["cut"], dict(info, cause="")


def month_back(day, months):
    m = np.datetime64(int(day), "D").astype("datetime64[M]") - np.timedelta64(months, "M")
    return int(day_of(np.datetime64(m, "m").astype(np.int64)))


def ecdf(sc, ref):
    """Percentile rank of each score within ref (the model's own fit-row scores). Comparable across cross-fit models,
    ties kept (a z-score is not: block-specific means and sds move a discrete score's level between models)."""
    r = np.sort(ref[np.isfinite(ref)]); out = np.full(len(sc), np.nan); m = np.isfinite(sc)
    out[m] = np.searchsorted(r, sc[m], side="right") / len(r)
    return out


def e2_blocks(test_day):
    """Quarterly cross-fit blocks ending at test_day, newest last: [(start_day, end_day)] x E2_MAX_BLOCKS."""
    ends = [month_back(test_day, E2_BLOCK_MONTHS * j) if j else test_day for j in range(E2_MAX_BLOCKS + 1)]
    return [(ends[j + 1], ends[j]) for j in range(E2_MAX_BLOCKS)][::-1]


def e2_select(spec, fitter, B, O, GS, cfg, C, ok, a_day, test_day):
    """One registered E-v2 procedure. fitter(row_mask over C) -> per-bar raw score (nan where features are missing).
    split6:   one model fit on rows exiting < test - 6 months - EMB; calibration and threshold pooled on rows starting in
              the last 6 months and exiting < test - EMB (the v1 Q3 + Q4 windows merged); the same model is the test model.
    crossfit: quarterly blocks over the last 2 years; each block is scored by a model fit on rows exiting before the
              block start - EMB (blocks with < E2_MIN_FIT fit rows are skipped); each model's scores are mapped to percentile ranks
              within its own fit-row scores; calibration and threshold are pooled over the scored blocks; the test model is fit
              on every row exiting < test - EMB.
    Returns dict(available, cause, rows, cal, std, info, cut, sbar (test-time score per bar, -inf where missing))."""
    out = dict(available=False, sbar=None, cut=np.inf, cal=None)
    fitrows = lambda end: (C["exit_day"] < end - EMB) & (C["day"] >= a_day) & ok
    if spec["windows"] == "split6":
        lo = month_back(test_day, E2_POOL_MONTHS)
        fit = fitrows(lo)
        pool = (C["day"] >= lo) & (C["exit_day"] < test_day - EMB) & ok
        rows = dict(fit=int(fit.sum()), cal=int(pool.sum()))
        if rows["fit"] < E2_MIN_FIT or rows["cal"] < E2_MIN_CAL:  # D4: support guard before any fit
            return dict(out, rows=rows, cause="support: fit rows %d, calibration rows %d" % (rows["fit"], rows["cal"]))
        sbar = fitter(fit); sthr = sbar; ref = None
    else:
        sthr = np.full(len(B["t"]), np.nan); nfit, lo = [], None
        for da, db in e2_blocks(test_day):
            f = fitrows(da)
            nfit.append(int(f.sum()))
            if f.sum() < E2_MIN_FIT:
                continue
            lo = da if lo is None else lo
            sc = fitter(f)
            blk = (B["day"] >= da) & (B["day"] < db)
            sthr[blk] = ecdf(sc[blk], sc[C["i"][f]])
        fit = fitrows(test_day)
        pool = (C["exit_day"] < test_day - EMB) & ok & np.isfinite(sthr[C["i"]])
        rows = dict(fit=int(fit.sum()), cal=int(pool.sum()), block_fit=nfit)
        if rows["fit"] < E2_MIN_FIT or rows["cal"] < E2_MIN_CAL:
            return dict(out, rows=rows, cause="support: fit rows %d, calibration rows %d" % (rows["fit"], rows["cal"]))
        sc = fitter(fit); ref = np.sort(sc[C["i"][fit]][np.isfinite(sc[C["i"][fit]])])
        sbar = ecdf(sc, ref)
    z = sthr[C["i"][pool]]
    cal, cok, why = e2_calibrate(z, C["y"][pool], C["ep"][pool], spec["calib"])
    out.update(rows=rows, cal=cal, ref=None if ref is None else ref.tolist())
    if not cok:
        return dict(out, cause="calibration: " + why)
    cut, info = e2_threshold(B, O, GS, cfg, np.nan_to_num(sthr, nan=-np.inf), z, lo, test_day, spec["gate"])
    out.update(info=dict(info, window_start_day=int(lo)), cut=cut, sbar=np.nan_to_num(sbar, nan=-np.inf))
    if not np.isfinite(cut):
        return dict(out, cause=info["cause"])
    return dict(out, available=True, cause="")


def e2_spec():
    """The selected registered variant (audit/v2/selected.json, written by audit/v2/select_v2.py)."""
    sel_ = json.load(open(E2_SELECTED))
    return sel_["variant"], E2_VARIANTS[sel_["variant"]]


def lr_fitter(B, F, cols, C):
    """fitter for e2_select with the frozen E learner; the last fitted model is kept in fit.last (the test model)."""
    Xa = np.column_stack([F[c] for c in cols]); fin = np.isfinite(Xa).all(1)
    Xc = e_matrix(F, cols, C["i"])

    def fit(mask):
        M = e2_lr_fit(Xc[mask], C["y"][mask], C["w"][mask]); fit.last = M
        sc = np.full(len(B["t"]), np.nan); sc[fin] = e2_lr_raw(M, Xa[fin])
        return sc
    return fit


def e2_frozen_score(B, F, E):
    """Test-time score per bar of a frozen E-v2 (standardized as frozen), -inf where features are missing."""
    Xa = np.column_stack([F[c] for c in E["cols"]]); fin = np.isfinite(Xa).all(1)
    sc = np.full(len(B["t"]), -np.inf); raw = e2_lr_raw(E["model"], Xa[fin])
    sc[fin] = raw if E["ref"] is None else ecdf(raw, np.array(E["ref"]))
    return sc


def boot_bs(T, all_days):
    return day_boot(T["day"], all_days, lambda ix: T["net"][ix].mean(), NBOOT)


def diff_bs(Ta, Tb, all_days):
    day = np.r_[Ta["day"], Tb["day"]]; net = np.r_[Ta["net"], Tb["net"]]; g = np.r_[np.ones(len(Ta["day"])), np.zeros(len(Tb["day"]))]

    def st(ix):
        a, b = g[ix] == 1, g[ix] == 0
        return net[ix][a].mean() - net[ix][b].mean() if a.any() and b.any() else np.nan
    return day_boot(day, all_days, st, NBOOT)


def e2_verdicts(TE, TD, all_days, years, runner_ref, ks):
    """Verdict of an E policy for each Bonferroni family size in ks (same bootstrap draws). The registered rule uses
    k = number of verdicts issued for the instrument in the look (references without a verdict are not counted)."""
    if len(TE["i"]) < 2:
        return {k: "abstain" for k in ks}, {}
    bm, bd = boot_bs(TE, all_days), diff_bs(TE, TD, all_days)
    tail = float((TE["net"] < -1.5).mean()); prun = float(TE["runner"].sum() / max(1, TE["arm"].sum()))
    v = {k: verdict(ci(bm, (2.5 / k, 100 - 2.5 / k)), ci(bd, (2.5 / k, 100 - 2.5 / k)), tail, prun, runner_ref, len(TE["i"]), years) for k in ks}
    return v, dict(meanR=float(TE["net"].mean()), inc_vs_D=float(TE["net"].mean() - TD["net"].mean()), tail=tail, p_runner=prun,
                   ci={k: ci(bm, (2.5 / k, 100 - 2.5 / k)) for k in ks}, inc_ci={k: ci(bd, (2.5 / k, 100 - 2.5 / k)) for k in ks})


# ------------------------------------------------------------------ reporting
def row(T, name, all_days, X, O, lo_i, hi_i, donors, rng):
    if len(T["i"]) < 2:
        return dict(variant=name, trades=int(len(T["i"])), empty=True)
    r = summarize(T, np.ones(len(T["i"]), bool), all_days, X, O, lo_i, hi_i, donors, rng, "A")  # "A": no subset branch
    r["variant"] = name
    r["tail_share"] = float((T["net"] < -1.5).mean())
    return r


def diff_ci(Ta, Tb, all_days, k=1):
    day = np.r_[Ta["day"], Tb["day"]]; net = np.r_[Ta["net"], Tb["net"]]; g = np.r_[np.ones(len(Ta["day"])), np.zeros(len(Tb["day"]))]

    def st(ix):
        a, b = g[ix] == 1, g[ix] == 0
        return net[ix][a].mean() - net[ix][b].mean() if a.any() and b.any() else np.nan
    bs = day_boot(day, all_days, st, NBOOT)
    return float(Ta["net"].mean() - Tb["net"].mean()), ci(bs), ci(bs, (2.5 / k, 100 - 2.5 / k))


def boot_mean(T, all_days, k=1):
    bs = day_boot(T["day"], all_days, lambda ix: T["net"][ix].mean(), NBOOT)
    return ci(bs), ci(bs, (2.5 / k, 100 - 2.5 / k))


def waiting(B, recD, recI, TD, TI):
    """Per-episode comparison of D against D-imm (same gate, same episodes)."""
    eI = {r["disc"]: r for r in recI}
    netD = dict(zip(TD["i"].tolist(), TD["net"].tolist())); netI = dict(zip(TI["i"].tolist(), TI["net"].tolist()))
    entD = dict(zip(TD["i"].tolist(), TD["entry"].tolist())); entI = dict(zip(TI["i"].tolist(), TI["entry"].tolist()))
    RI = dict(zip(TI["i"].tolist(), TI["R"].tolist()))
    out = dict(both=0, fill_change_R=[], avoided=0, avoided_R=0.0, missed=0, missed_R=0.0, d_only=0, rem_D=[], rem_I=[])
    for r in recD:
        ri = eI.get(r["disc"])
        if ri is None:
            continue
        a, b = r["entry"], ri["entry"]
        if a >= 0 and b >= 0 and a in netD and b in netI:
            out["both"] += 1
            out["fill_change_R"].append(r["side"] * (entI[b] - entD[a]) / RI[b])
            for e, lst, rr in ((a, out["rem_D"], None), (b, out["rem_I"], None)):
                seg = slice(e + 1, r["last"] + 2)
                ex = (B["mid_h"][seg].max() - B["mid_c"][e]) if r["side"] > 0 else (B["mid_c"][e] - B["mid_l"][seg].min())
                lst.append(ex / RI[b])
        elif a < 0 and b >= 0 and b in netI:
            if netI[b] < 0:
                out["avoided"] += 1; out["avoided_R"] += netI[b]
            else:
                out["missed"] += 1; out["missed_R"] += netI[b]
        elif a >= 0 and b < 0:
            out["d_only"] += 1
    f = lambda v: float(np.mean(v)) if v else float("nan")
    return dict(episodes_both=out["both"], fill_change_R=f(out["fill_change_R"]), losses_avoided=out["avoided"],
                losses_avoided_R=out["avoided_R"], winners_missed=out["missed"], winners_missed_R=out["missed_R"],
                d_only=out["d_only"], remaining_R_D=f(out["rem_D"]), remaining_R_imm=f(out["rem_I"]))


def outcome_counts(recs):
    o = pd.Series([r["outcome"] for r in recs]).value_counts().to_dict() if recs else {}
    return dict(episodes=len(recs), **{k: int(v) for k, v in o.items()},
                waits=int(sum(r["n_wait"] for r in recs)), rej_spread=int(sum(r["n_rej_spread"] for r in recs)),
                rej_busy=int(sum(r["n_rej_busy"] for r in recs)))


def state_split(T, state, all_days):
    out = {}
    for name, v in (("off", 0), ("armed", 1), ("fired", 2), ("unavailable", -1)):
        m = state[T["i"]] == v
        if m.sum() >= 2:
            S = sel(T, m)
            out[name] = dict(trades=int(m.sum()), meanR=float(S["net"].mean()), ci=boot_mean(S, all_days)[0])
        else:
            out[name] = dict(trades=int(m.sum()))
    return out


def reliability(p, y, bands=(0, 0.3, 0.4, 0.5, 0.6, 1.01)):
    out = []
    for a, b in zip(bands[:-1], bands[1:]):
        m = (p >= a) & (p < b)
        n = int(m.sum())
        if n == 0:
            out.append(dict(band=f"[{a:.1f},{min(b, 1):.1f})", n=0)); continue
        k = y[m].sum(); ph = k / n; z = 1.96
        den = 1 + z * z / n; cen = (ph + z * z / (2 * n)) / den; hw = z * np.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / den
        out.append(dict(band=f"[{a:.1f},{min(b, 1):.1f})", n=n, mean_p=float(p[m].mean()), obs=float(ph), wilson=[float(cen - hw), float(cen + hw)],
                        sparse=n < 50))
    return out


def scores(p, y):
    p = np.clip(p, 1e-6, 1 - 1e-6); base = y.mean()
    ll = float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
    llb = float(-np.mean(y * np.log(base) + (1 - y) * np.log(1 - base))) if 0 < base < 1 else float("nan")
    from sklearn.metrics import roc_auc_score
    auc = float(roc_auc_score(y, p)) if 0 < y.sum() < len(y) else float("nan")
    return dict(n=int(len(y)), base=float(base), brier=float(np.mean((p - y) ** 2)), brier_base=float(base * (1 - base)),
                logloss=ll, logloss_base=llb, auc=auc)


def fmt_rows(rows, k=1):
    c2 = lambda v: f"[{v[0]:+.3f}, {v[1]:+.3f}]"
    hdr = ("| Variant | Trades | R/trade [95% CI] | Total R | MaxDD R | p_arm | p_runner | Losers | <-1.5R | "
           "vs same-tod null [CI] | vs circular null [CI] |")
    out = [hdr, "|" + "---|" * (hdr.count("|") - 1)]
    for r in rows:
        if r.get("empty"):
            out.append(f"| {r['variant']} | {r['trades']} | - | - | - | - | - | - | - | - | - |"); continue
        out.append("| " + " | ".join([r["variant"], str(r["trades"]), f"{r['meanR']:+.3f} {c2(r['meanR_ci'])}", f"{r['totalR']:+.1f}",
                                      f"{r['maxddR']:.1f}", f"{r['p_arm']:.3f}", f"{r['p_runner']:.3f}", f"{r['loser_share']:.3f}",
                                      f"{r['tail_share']:.3f}", f"{r['meanR'] - r['null_tod_meanR']:+.3f} {c2(r['vs_null_tod_ci'])}",
                                      f"{r['meanR'] - r['null_circ_meanR']:+.3f} {c2(r['vs_null_circ_ci'])}"]) + " |")
    return "\n".join(out)


def fmt_split(sp):
    out = ["| Trade set | off | armed | fired | unavailable |", "|---|---|---|---|---|"]
    for name, s in sp.items():
        cell = lambda d: (f"{d['trades']}: {d['meanR']:+.3f} [{d['ci'][0]:+.3f}, {d['ci'][1]:+.3f}]" if "meanR" in d else f"{d['trades']}")
        out.append(f"| {name} | " + " | ".join(cell(s[k]) for k in ("off", "armed", "fired", "unavailable")) + " |")
    return "\n".join(out)


def verdict(meanR_ci_bonf, inc_ci_bonf, tail, runner, runner_ref, n, years):
    risk_ok = tail <= 0.02 and (runner_ref is None or runner >= 0.8 * runner_ref) and n >= max(100, 30 * years)
    if meanR_ci_bonf[0] > MUE and (inc_ci_bonf is None or inc_ci_bonf[0] > 0) and risk_ok:
        return "supported"
    if meanR_ci_bonf[1] < MUE or tail > 0.02:
        return "rejected"
    return "inconclusive"


def cfg_name(cfg):
    g, conf, W = cfg
    return f"gate={g[0]}{'' if g[1] is None else g[1]} confirm={conf} W={W}"


def as_cfg(c):
    return (tuple(c[0]), c[1], int(c[2]))


# ------------------------------------------------------------------ modes
def prep(inst, until):
    prefetch(inst)
    m1 = load_m1(inst, until)
    B = build(inst, m1)
    O = outcomes(B)
    L = gate_layer(m1)
    return m1, B, O, L


def dev(inst):
    t0 = time.time()
    tag = {"inst": inst}
    if not trial_count(exp=EXP, mode="prereg", inst=inst, version=PREREG["version"]):
        log_trial({"exp": EXP, "mode": "prereg", "inst": inst, **PREREG})
    m1, B, O, L = prep(inst, DEV_END)
    assert B["t"][-1] < np.datetime64(DEV_END, "m").astype(np.int64)
    grid = [(g, c, w) for g in GATES for c in CONFIRMS for w in WAITS]
    lo_day, hi_day = year_start_day(DEV_YEARS[0]), year_start_day(DEV_YEARS[-1] + 1)
    lo_i, hi_i, all_days = window_bars(B, lo_day, hi_day)
    X = BarIndex(B["t"]); rng = np.random.default_rng(31)
    folds, oof = [], {"D": [], "D_imm": [], "D_nogate": [], "A": []}
    wait_f, rec_f, split_A, split_N, state_all = [], {"D": [], "D_imm": [], "D_nogate": []}, [], [], np.full(len(B["t"]), -9)
    GSf = {}
    for y in DEV_YEARS + ["freeze"]:
        ys = year_start_day(2023 if y == "freeze" else y)
        GM = fit_gate(L, ys - EMB)
        GS = gate_states(B, L, GM)
        GSf[y] = (GM, GS)
        best = None
        for cfg in grid:
            R = run_d(B, O, GS, cfg)
            T = trades(B, O, R["entries"])
            tr = (T["exit_day"] < ys - EMB) & ((T["day"] >= lo_day) if y == "freeze" else True)
            mr = float(T["net"][tr].mean()) if tr.sum() >= MIN_TRAIN_TRADES else -np.inf
            log_trial({"exp": EXP, "mode": "dev" if y != "freeze" else "freeze", **tag, "variant": "D", "fold": y,
                       "cfg": cfg_name(cfg), "train_trades": int(tr.sum()), "train_meanR": mr})
            if best is None or mr > best[0]:
                best = (mr, cfg)
        folds.append(dict(fold=y, cfg=cfg_name(best[1]), train_meanR=best[0]))
        if y == "freeze":
            dcfg = best[1]; break
        cfg = best[1]
        te = lambda T: sel(T, (T["day"] >= ys) & (T["day"] < year_start_day(y + 1)))
        RD = run_d(B, O, GS, cfg); RI = run_d(B, O, GS, (cfg[0], "imm", cfg[2])); RN = run_d(B, O, GS, (("none", None), cfg[1], cfg[2]))
        TD, TI, TN = te(trades(B, O, RD["entries"])), te(trades(B, O, RI["entries"])), te(trades(B, O, RN["entries"]))
        fi = np.where(B["flip"] != 0)[0]
        fi = fi[np.where(B["flip"][fi] > 0, O[False][1]["ok"][fi], O[False][-1]["ok"][fi])]
        TA = te(a_trades(B, O, fi))
        inyr = lambda recs: [r for r in recs if ys <= B["day"][r["disc"]] < year_start_day(y + 1)]
        for k, T in (("D", TD), ("D_imm", TI), ("D_nogate", TN), ("A", TA)):
            oof[k].append(T)
        for k, Rr in (("D", RD), ("D_imm", RI), ("D_nogate", RN)):
            rec_f[k] += inyr(Rr["recs"])
        wait_f.append(waiting(B, inyr(RD["recs"]), inyr(RI["recs"]), TD, TI))
        yr = (B["day"] >= ys) & (B["day"] < year_start_day(y + 1))
        state_all[yr] = GS["state"][yr]
    T = {k: cat(v) for k, v in oof.items()}
    donors = None
    rows = [row(T["A"], "A: every flip, immediate (frozen baseline)", all_days, X, O, lo_i, hi_i, None, rng),
            row(T["D_nogate"], "D-nogate: same follower, always on", all_days, X, O, lo_i, hi_i, None, rng),
            row(T["D_imm"], "D-imm: same gate, enter at discovery", all_days, X, O, lo_i, hi_i, donors, rng),
            row(T["D"], "D: walk-forward selected", all_days, X, O, lo_i, hi_i, donors, rng)]
    inc = {c: diff_ci(T["D"], T[c], all_days) for c in ("A", "D_imm", "D_nogate")}
    wsum = {k: (float(np.nansum([w[k] for w in wait_f])) if k in ("episodes_both", "losses_avoided", "losses_avoided_R", "winners_missed",
                                                                    "winners_missed_R", "d_only") else float(np.nanmean([w[k] for w in wait_f])))
            for k in wait_f[0]}
    split = state_split(T["A"], state_all, all_days), state_split(T["D_nogate"], state_all, all_days)
    # ---- E-v2 dev folds on the frozen D configuration: test year y, registered pooled windows before y
    spec_name, spec = e2_spec()
    e_rows, e_scores, e_rel, e_oof = {}, {}, {}, {"E": [], "E_novol": [], "D": []}
    e_info = []
    for y in DEV_YEARS[1:]:
        GM, GS = GSf[y]
        R = run_d(B, O, GS, dcfg)
        F = e_features(B, GS, R["ep"])
        C = candidates(B, O, R, dcfg[2])
        ok = np.isfinite(e_matrix(F, BASEF + VOLF, C["i"])).all(1)
        ys, ye = year_start_day(y), year_start_day(y + 1)
        TD = trades(B, O, R["entries"]); TD = sel(TD, (TD["day"] >= ys) & (TD["day"] < ye))
        e_oof["D"].append(TD)
        for name, cols in (("E", BASEF + VOLF), ("E_novol", BASEF)):
            S = e2_select(spec, lr_fitter(B, F, cols, C), B, O, GS, dcfg, C, ok, int(B["day"][0]), ys)
            rec = dict(fold=y, variant=name, spec=spec_name, rows=S["rows"], cause=S["cause"], cut=S["cut"], cal=S["cal"], thr=S.get("info"))
            if S["available"]:
                TE = trades(B, O, run_d(B, O, GS, dcfg, extra=S["sbar"] >= S["cut"])["entries"]); TE = sel(TE, (TE["day"] >= ys) & (TE["day"] < ye))
                e_oof[name].append(TE)
                hm = (C["day"] >= ys) & (C["day"] < ye) & ok
                pp = e2_prob(S["cal"], S["sbar"][C["i"][hm]])
                rec.update(test_trades=int(len(TE["i"])), held_scores=scores(pp, C["y"][hm]))
                e_scores.setdefault(name, []).append((pp, C["y"][hm], C["s"][hm]))
            e_info.append(rec)
            log_trial({"exp": EXP, "mode": "dev", **tag, "variant": name, "fold": y, "e2": spec_name, "cause": S["cause"], "cut": S["cut"],
                       "thr_grid": (S.get("info") or {}).get("grid"), "test_trades": rec.get("test_trades", 0)})
    lo_e = year_start_day(DEV_YEARS[1])
    lo_ie, hi_ie, days_e = window_bars(B, lo_e, hi_day)
    for name in ("D", "E", "E_novol"):
        if e_oof[name]:
            TT = cat(e_oof[name])
            e_rows[name] = row(TT, {"D": "D (frozen cfg), E folds", "E": "D+E", "E_novol": "D+E without vol features"}[name],
                               days_e, X, O, lo_ie, hi_ie, None, rng)
            if name != "D" and len(TT["i"]) and len(cat(e_oof["D"])["i"]):
                e_rows[name]["inc_vs_D"] = diff_ci(TT, cat(e_oof["D"]), days_e)
    for name, lst in e_scores.items():
        p = np.concatenate([a for a, _, _ in lst]); yy = np.concatenate([b for _, b, _ in lst]); ss = np.concatenate([c for _, _, c in lst])
        e_rel[name] = dict(all=dict(scores=scores(p, yy), rel=reliability(p, yy)),
                           **{f"side{s:+d}": dict(scores=scores(p[ss == s], yy[ss == s]), rel=reliability(p[ss == s], yy[ss == s])) for s in (1, -1)})
    # ---- freeze D, D-imm, D-nogate (gate fit on all dev days) and E, E_novol (registered E-v2, pooled windows before 2023)
    GM, GS = GSf["freeze"]
    R = run_d(B, O, GS, dcfg)
    F = e_features(B, GS, R["ep"])
    C = candidates(B, O, R, dcfg[2])
    ok = np.isfinite(e_matrix(F, BASEF + VOLF, C["i"])).all(1)
    frozen_e = {}
    for name, cols in (("E", BASEF + VOLF), ("E_novol", BASEF)):
        fitter = lr_fitter(B, F, cols, C)
        S = e2_select(spec, fitter, B, O, GS, dcfg, C, ok, int(B["day"][0]), year_start_day(2023))
        log_trial({"exp": EXP, "mode": "freeze", **tag, "variant": name, "e2": spec_name, "cause": S["cause"], "cut": S["cut"],
                   "thr_grid": (S.get("info") or {}).get("grid")})
        base_ = dict(cols=cols, spec=spec_name, rows=S["rows"], cal=S["cal"], thr=S.get("info"))
        if not S["available"]:  # support, calibration or threshold abstention: E has no test policy
            frozen_e[name] = dict(base_, unavailable=S["cause"])
            continue
        frozen_e[name] = dict(base_, model=fitter.last, ref=S["ref"], cut=S["cut"])
    fz = json.load(open(FROZEN)) if os.path.exists(FROZEN) else {}
    fz[inst] = dict(policy=POLICY, spr_max=SPR_MAX, d_cfg=list(dcfg), gate=GM, state_q=STATE_Q, E=frozen_e,
                    evaluator=EVALUATOR_VERSION, code_sha256=CODE_SHA, code_files_sha256=CODE_FILES_SHA,
                    frozen_at=time.strftime("%Y-%m-%dT%H:%M:%S"), dev_data_last=str(iso(B["t"][-1])))
    json.dump(fz, open(FROZEN, "w"), indent=1, default=float)
    res = dict(inst=inst, window=f"{DEV_YEARS[0]}..2022 walk-forward out-of-fold", folds=folds, frozen_d=cfg_name(dcfg), rows=rows,
               inc={k: v[:2] for k, v in inc.items()}, waiting=wsum, episodes={k: outcome_counts(v) for k, v in rec_f.items()},
               split={"A (flips)": split[0], "D-nogate": split[1]}, e_rows=e_rows, e_rel=e_rel, e_info=e_info,
               frozen_e={k: {x: v[x] for x in ("spec", "cut", "rows", "thr", "cal", "unavailable") if x in v} for k, v in frozen_e.items()},
               trials=trial_count(exp=EXP, inst=inst), secs=round(time.time() - t0))
    os.makedirs(RES, exist_ok=True)
    f = inst.replace("/", "_")
    json.dump(res, open(os.path.join(RES, f"de_dev_{f}.json"), "w"), indent=1, default=float)
    md = report(res, "development years (walk-forward out-of-fold)")
    open(os.path.join(RES, f"de_dev_{f}.md"), "w").write(md + "\n")
    print(md)


def a_trades(B, O, fi):
    s = B["flip"][fi]
    T = {"i": fi, "s": s, "day": B["day"][fi], "net": look(O[False], fi, s, "net_R"), "net_opt": look(O[True], fi, s, "net_R"),
         "arm": look(O[False], fi, s, "arm"), "runner": look(O[False], fi, s, "runner"), "amb": look(O[False], fi, s, "amb"),
         "reason": look(O[False], fi, s, "reason"), "entry": look(O[False], fi, s, "entry"), "R": look(O[False], fi, s, "R")}
    T["exit_day"] = B["day"][np.clip(look(O[False], fi, s, "exit_bar"), 0, len(B["t"]) - 1)]
    return T


def report(res, label):
    c2 = lambda v: f"[{v[0]:+.3f}, {v[1]:+.3f}]"
    md = [f"# Ladder D-E, {res['inst']} M5, {label}", "", f"Window: {res['window']}. Frozen D: `{res.get('frozen_d', '')}`.", ""]
    if res.get("folds"):
        md += ["Walk-forward D selection: " + "; ".join(f"{f['fold']}: {f['cfg']} (train {f['train_meanR']:+.3f})" for f in res["folds"]), ""]
    md += ["## D", "", fmt_rows(res["rows"]), ""]
    md += ["Incremental R/trade of D (95% CI" + (", Bonferroni CI" if res.get("bonf_k") else "") + "): " +
           "; ".join(f"vs {k}: {v[0]:+.3f} {c2(v[1])}" + (f" bonf {c2(v[2])}" if len(v) > 2 else "") for k, v in res["inc"].items()), ""]
    w = res["waiting"]
    md += [f"Waiting (D vs D-imm, same episodes): both entered {w['episodes_both']:.0f}, fill change {w['fill_change_R']:+.3f} R "
           f"(positive = better price), losses avoided {w['losses_avoided']:.0f} ({w['losses_avoided_R']:+.1f} R), winners missed "
           f"{w['winners_missed']:.0f} ({w['winners_missed_R']:+.1f} R), D-only entries {w['d_only']:.0f}, remaining opportunity after "
           f"entry (MFE to episode end) D {w['remaining_R_D']:.2f} R vs imm {w['remaining_R_imm']:.2f} R.", ""]
    md += ["Episode outcomes: " + "; ".join(f"{k}: {json.dumps(v)}" for k, v in res["episodes"].items()), ""]
    md += ["## Chop-filter question: R/trade by gate state at signal time (armed = open rank >= 0.8, fired = intraday rank >= 0.9)", "",
           fmt_split(res["split"]), ""]
    md += ["## E", "", fmt_rows([r for r in res["e_rows"].values()]), ""]
    for k, r in res["e_rows"].items():
        if "inc_vs_D" in r:
            v = r["inc_vs_D"]
            md.append(f"{k} incremental vs D without selection: {v[0]:+.3f} {c2(v[1])}" + (f" bonf {c2(v[2])}" if len(v) > 2 else ""))
    md.append("")
    for k, r in res["e_rel"].items():
        for sd, x in r.items():
            s = x["scores"]
            md.append(f"{k} {sd}: n {s['n']}, base {s['base']:.3f}, Brier {s['brier']:.4f} (base {s['brier_base']:.4f}), "
                      f"log loss {s['logloss']:.4f} (base {s['logloss_base']:.4f}), AUC {s['auc']:.3f}; reliability " +
                      ", ".join(f"{b['band']} n={b['n']}" + (f" p={b['mean_p']:.2f} obs={b['obs']:.2f} [{b['wilson'][0]:.2f},{b['wilson'][1]:.2f}]"
                                                              + (" sparse" if b["sparse"] else "") if b["n"] else "") for b in x["rel"]))
    if res.get("curve"):
        md += ["", "Risk vs coverage (E, test, accepted share q of threshold-window candidates): " + "; ".join(f"q={c['p']:.2f}: {c['n']} trades, {c['meanR']:+.3f} R, losers {c['losers']:.2f}" for c in res["curve"])]
    if res.get("verdicts"):
        md += ["", "## Dispositions", ""] + [f"- {k}: {v}" for k, v in res["verdicts"].items()]
    md += ["", f"Trials logged for {res['inst']} (exp {EXP}): {res['trials']}."]
    if res.get("e_info"):
        md += ["", "E folds: " + json.dumps(res["e_info"], default=float)]
    return "\n".join(md)


def final(inst):
    # DE_DRYRUN=1: exercise this code path on dev data only (window 2022, data < 2023), scratch ledger and outputs
    dry = bool(os.environ.get("DE_DRYRUN"))
    ledger = os.path.join(CACHE, "dryrun_ledger.jsonl") if dry else LEDGER
    n, _, tmax = coverage(inst)
    if not dry and np.datetime64(tmax[:16], "m") < np.datetime64("now", "m") - np.timedelta64(4, "D"):
        sys.exit(f"{inst} has not caught up: newest M1 bar {tmax}. Not scoring the test.")
    if dry and os.path.exists(ledger):
        os.remove(ledger)
    fz = json.load(open(FROZEN))[inst]
    names = ["D", "D_imm", "D_nogate", "E", "E_novol"]
    hashes = {v: config_hash({"inst": inst, "v": v, "policy": fz["policy"], "d": fz["d_cfg"], "gate": fz["gate"],
                              "E": fz["E"].get(v) if v.startswith("E") else None}) for v in names}
    done = {json.loads(l)["hash"] for l in open(ledger)} if os.path.exists(ledger) else set()
    todo = [v for v in names if hashes[v] not in done]
    if not todo:
        sys.exit("All frozen D-E variants of this instrument were already scored on the test. Refusing a second look.")
    with open(ledger, "a") as f:  # record the look before computing, so a crash cannot turn into a retry
        for v in todo:
            f.write(json.dumps({"inst": inst, "variant": v, "hash": hashes[v], "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "data_to": tmax,
                                "evaluator": EVALUATOR_VERSION, "code_sha256": CODE_SHA, "code_files_sha256": CODE_FILES_SHA}) + "\n")
    m1, B, O, L = prep(inst, DEV_END if dry else None)
    GS = gate_states(B, L, fz["gate"])
    dcfg = as_cfg(fz["d_cfg"])
    lo_day, hi_day = year_start_day(2022 if dry else 2023), int(B["day"][-1]) + 1
    lo_i, hi_i, all_days = window_bars(B, lo_day, hi_day)
    years = (hi_day - lo_day) / 365.25
    X = BarIndex(B["t"]); rng = np.random.default_rng(47)
    # v2: Bonferroni over the verdicts issued in this look (D and every available E); references get no verdict
    k = max(1, sum(v in todo and not (v.startswith("E") and "unavailable" in fz["E"][v]) for v in ("D", "E", "E_novol")))
    te = lambda T: sel(T, T["day"] >= lo_day)
    inw = lambda recs: [r for r in recs if B["day"][r["disc"]] >= lo_day]
    RD, RI, RN = run_d(B, O, GS, dcfg), run_d(B, O, GS, (dcfg[0], "imm", dcfg[2])), run_d(B, O, GS, (("none", None), dcfg[1], dcfg[2]))
    TD, TI, TN = (te(trades(B, O, r["entries"])) for r in (RD, RI, RN))
    fi = np.where(B["flip"] != 0)[0]
    fi = fi[np.where(B["flip"][fi] > 0, O[False][1]["ok"][fi], O[False][-1]["ok"][fi])]
    TA = te(a_trades(B, O, fi))
    rows = [row(TA, "A: every flip, immediate (frozen baseline)", all_days, X, O, lo_i, hi_i, None, rng)]
    T = {"D": TD, "D_imm": TI, "D_nogate": TN, "A": TA}
    lab = {"D_nogate": "D-nogate: same follower, always on", "D_imm": "D-imm: same gate, enter at discovery", "D": "D: frozen"}
    for v in ("D_nogate", "D_imm", "D"):
        if v in todo:
            rows.append(row(T[v], lab[v], all_days, X, O, lo_i, hi_i, None, rng))
    inc = {c: diff_ci(TD, T[c], all_days, k) for c in ("A", "D_imm", "D_nogate")}
    wsum = waiting(B, inw(RD["recs"]), inw(RI["recs"]), TD, TI)
    split = {"A (flips)": state_split(TA, GS["state"], all_days), "D-nogate": state_split(TN, GS["state"], all_days)}
    # E
    F = e_features(B, GS, RD["ep"])
    C = candidates(B, O, RD, dcfg[2]); C = sel(C, C["day"] >= lo_day)
    TEs = {}
    e_rows, e_rel, curve = {"D": row(TD, "D (same policy, no selection)", all_days, X, O, lo_i, hi_i, None, rng)}, {}, []
    for name in ("E", "E_novol"):
        if name not in todo:
            continue
        E = fz["E"][name]
        if "unavailable" in E:
            e_rows[name] = dict(variant=name, trades=0, empty=True, unavailable=E["unavailable"])
            continue
        sbar = e2_frozen_score(B, F, E)
        pbar = np.full(len(B["t"]), -1.0); fin = np.isfinite(sbar); pbar[fin] = e2_prob(E["cal"], sbar[fin])
        RE = run_d(B, O, GS, dcfg, extra=sbar >= E["cut"])
        TE = te(trades(B, O, RE["entries"])); TEs[name] = TE
        e_rows[name] = row(TE, "D+E" if name == "E" else "D+E without vol features", all_days, X, O, lo_i, hi_i, None, rng)
        if len(TE["i"]) >= 2:
            e_rows[name]["inc_vs_D"] = diff_ci(TE, TD, all_days, k)
        okc = pbar[C["i"]] >= 0
        p, yy, ss = pbar[C["i"]][okc], C["y"][okc], C["s"][okc]
        e_rel[name] = dict(all=dict(scores=scores(p, yy), rel=reliability(p, yy)),
                           **{f"side{s:+d}": dict(scores=scores(p[ss == s], yy[ss == s]), rel=reliability(p[ss == s], yy[ss == s])) for s in (1, -1)})
        if name == "E":
            for g_ in E["thr"]["grid"]:
                Tq = te(trades(B, O, run_d(B, O, GS, dcfg, extra=sbar >= g_["cut"])["entries"]))
                curve.append(dict(p=g_["q"], n=int(len(Tq["i"])), meanR=float(Tq["net"].mean()) if len(Tq["i"]) else float("nan"),
                                  losers=float((Tq["net"] < 0).mean()) if len(Tq["i"]) else float("nan")))
    # verdicts on the Bonferroni interval over the frozen variants scored in this look
    v = {}
    rD = next(r for r in rows if r["variant"] == "D: frozen") if "D" in todo else None
    if rD:
        b = boot_mean(TD, all_days, k)[1]
        v["D"] = verdict(b, inc["D_imm"][2], rD["tail_share"], rD["p_runner"], None, rD["trades"], years) + \
            f" (R/trade {rD['meanR']:+.3f}, Bonferroni CI [{b[0]:+.3f}, {b[1]:+.3f}], vs D-imm {inc['D_imm'][0]:+.3f} bonf [{inc['D_imm'][2][0]:+.3f}, {inc['D_imm'][2][1]:+.3f}])"
    for name in ("E", "E_novol"):
        r = e_rows.get(name)
        if r and not r.get("empty"):
            bb = boot_mean(TEs[name], all_days, k)[1]
            v[name] = verdict(bb, r["inc_vs_D"][2], r["tail_share"], r["p_runner"], rD["p_runner"] if rD else None, r["trades"], years) + \
                f" (R/trade {r['meanR']:+.3f}, Bonferroni CI [{bb[0]:+.3f}, {bb[1]:+.3f}], vs D bonf [{r['inc_vs_D'][2][0]:+.3f}, {r['inc_vs_D'][2][1]:+.3f}])"
        elif r is not None and r.get("unavailable"):  # D2: never fitted -> no test of E happened
            v[name] = f"undefined: E unavailable ({r['unavailable']}); no test of E, no verdict"
        elif r is not None:
            v[name] = f"no entries ({r['trades']} trades): rejected. The frozen D+E is the no-trade policy (0 R exactly), which cannot exceed the MUE against no-trade"
    res = dict(inst=inst, window=f"{np.datetime64(int(lo_day), 'D')}..{iso(B['t'][-1])}", frozen_d=cfg_name(dcfg), rows=rows, inc=inc, waiting=wsum,
               episodes={"D": outcome_counts(inw(RD["recs"])), "D_imm": outcome_counts(inw(RI["recs"])), "D_nogate": outcome_counts(inw(RN["recs"]))},
               split=split, e_rows=e_rows, e_rel=e_rel, curve=curve, verdicts=v, bonf_k=k, hashes=hashes, scored=todo,
               trials=trial_count(exp=EXP, inst=inst))
    f = inst.replace("/", "_")
    out = os.path.join(CACHE, f"dryrun_{f}") if dry else os.path.join(RES, f"de_test_{f}")
    json.dump(res, open(out + ".json", "w"), indent=1, default=float)
    md = report(res, "DRY RUN on 2022 dev data (in-sample, plumbing only)" if dry else "test 2023+ (scored once)")
    open(out + ".md", "w").write(md + "\n")
    print(md)


# ------------------------------------------------------------------ self-checks
def check():
    # fixture 1: flip at bar 3 rejected (no confirmation), WAIT evaluations without a new event, confirmation at 7 -> ENTER,
    #            position held, then invalidated by the next flip. Second episode: no confirmation ever -> EXPIRED.
    n = 30
    trend = np.r_[[-1] * 3, [1] * 12, [-1] * 15]
    day = np.zeros(n, int)
    conf = np.zeros(n, bool); conf[7] = True; conf[9] = True
    spr = np.ones(n, bool)
    xb = np.full(n, -1); xb[7] = 15
    act = np.ones(n, bool)
    ep = episodes(trend, day, act)
    st, ent, recs = replay(ep, trend, conf, spr, 6, xb)
    assert list(ent) == [7], ent
    assert recs[1]["disc"] == 3 and list(st[3:7]) == [WAIT] * 4 and st[7] == ENTER and all(st[8:15] == HOLD)
    assert recs[1]["outcome"] == "entered" and recs[1]["n_wait"] == 4
    assert recs[2]["disc"] == 15 and recs[2]["outcome"] == "expired" and all(st[15:21] == WAIT) and all(st[21:] == EXPIRED)
    assert recs[0]["outcome"] == "invalidated_flip"  # first episode (bars 0-2) ended by the flip without an entry
    # spread rejection then entry; busy rejection while a position is open
    spr2 = spr.copy(); spr2[7] = False
    st2, ent2, _ = replay(ep, trend, conf, spr2, 10, xb)
    assert st2[7] == REJ_SPREAD and list(ent2) == [9]
    conf3 = conf.copy(); conf3[16] = True; xb3 = xb.copy(); xb3[7] = 18
    st3, ent3, _ = replay(ep, trend, conf3, spr, 10, xb3)
    assert st3[16] == REJ_BUSY and 16 not in ent3
    # fixture 2: an episode where no qualifying entry ever occurs (confirmation only after the window)
    conf4 = np.zeros(n, bool); conf4[14] = True
    st4, ent4, recs4 = replay(ep, trend, conf4, spr, 6, xb)
    assert len(ent4) == 0 and all(r["outcome"] != "entered" for r in recs4) and len(recs4) == 3
    # fixture 3: discovery after startup without a recent flip: trend is +1 from bar 0, the gate opens at bar 10
    trend5 = np.ones(n, int); act5 = np.arange(n) >= 10; conf5 = np.zeros(n, bool); conf5[12] = True
    ep5 = episodes(trend5, day, act5)
    st5, ent5, recs5 = replay(ep5, trend5, conf5, spr, 6, xb)
    assert recs5[0]["disc"] == 10 and list(ent5) == [12] and st5[10] == WAIT
    # day boundary splits an episode (rearm only on a new day or a flip)
    ep6 = episodes(np.ones(n, int), np.r_[[0] * 15, [1] * 15], np.ones(n, bool))
    assert ep6[14] == 0 and ep6[15] == 1
    # future data cannot change a decision: alter everything after the entry bar
    conf7 = conf.copy(); conf7[8:] = ~conf7[8:]; trend7 = trend.copy()
    st7, ent7, _ = replay(episodes(trend7, day, act), trend7, conf7, spr, 6, xb)
    assert ent7[0] == 7 and np.array_equal(st7[:8], st[:8])
    print("D fixtures OK: flip rejected -> WAIT x4 -> ENTER -> HOLD -> flip; no-entry expiry; spread/busy rejection; "
          "startup discovery without a flip; day split; post-entry changes do not alter the decision")
    # no lookahead on real data: perturb every M1 bar after a cut; every decision-time input up to the cut is unchanged
    for inst in ("WTICO/USD", "XAU/USD"):
        prefetch(inst)
        m1 = load_m1(inst, "2020-01-01")
        L = gate_layer(m1)
        cut = int(m1["t"][len(m1["t"]) * 3 // 4])
        GM = fit_gate(L, day_of(cut) - EMB)
        B = build(inst, m1); O = outcomes(B); GS = gate_states(B, L, GM)
        m2 = {k: v.copy() for k, v in m1.items()}
        late = m2["t"] >= cut
        noise = np.random.default_rng(5).normal(1, 0.03, late.sum())
        for f in ("bid_o", "bid_h", "bid_l", "bid_c", "ask_o", "ask_h", "ask_l", "ask_c"):
            m2[f][late] *= noise
        m2["volume"][late] *= 3
        B2 = build(inst, m2); O2 = outcomes(B2); L2 = gate_layer(m2); GS2 = gate_states(B2, L2, GM)
        keep = B["t"] + 5 <= cut
        assert keep.sum() > 1000 and np.array_equal(B["t"], B2["t"])
        for kk in ("trend", "flip", "atr", "st", "tr_M15", "tr_H1", "de", "ovl", "ema", "brk", "dhi", "dlo", "dopen", "atr_ratio", "spr", "since_flip"):
            assert np.allclose(B[kk][keep], B2[kk][keep], equal_nan=True), (inst, kk)
        for kk in ("arank", "lreg", "cpP", "state"):
            assert np.allclose(GS[kk][keep], GS2[kk][keep], equal_nan=True), (inst, kk)
        for q in GS["fired"]:
            assert np.array_equal(GS["fired"][q][keep], GS2["fired"][q][keep]), (inst, "fired", q)
        for cfg in ((("fired", 0.9), "h1", 48), (("armed", 0.6), "brk", 12), (("none", None), "m15", 12)):
            R1, R2 = run_d(B, O, GS, cfg), run_d(B2, O2, GS2, cfg)
            # decisions are causal; only the exit bar of an earlier open position (an outcome) may differ, so compare
            # decisions made before the first position whose exit lies beyond the cut
            e1 = R1["entries"]; xb = np.where(B["trend"][e1] > 0, O[False][1]["exit_bar"][e1], O[False][-1]["exit_bar"][e1])
            lim = min([int(i) for i, x in zip(e1, xb) if B["t"][min(x, len(B["t"]) - 1)] + 5 > cut] + [int(keep.sum())])
            assert np.array_equal(R1["state"][:lim], R2["state"][:lim]), (inst, cfg)
            F1, F2 = e_features(B, GS, R1["ep"]), e_features(B2, GS2, R2["ep"])
            for kk in F1:
                assert np.allclose(F1[kk][:lim], F2[kk][:lim], equal_nan=True), (inst, kk)
        # a planted leak must be caught: a feature that reads the next bar's close changes under the perturbation
        leak1, leak2 = np.r_[B["mid_c"][1:], np.nan], np.r_[B2["mid_c"][1:], np.nan]
        assert not np.allclose(leak1[keep], leak2[keep], equal_nan=True)
        print(f"no-lookahead OK on {inst}: {keep.sum()} M5 decision bars before the cut; trend, H1/M15 trend, day range, "
              f"gate states, replay states and E features unchanged; a planted next-bar leak is detected")
    # E windows: disjoint, chronological, purged, episode-grouped
    C = dict(day=np.arange(100), exit_day=np.arange(100) + 3, ep=np.arange(100) // 2)
    fit, cal, thr = e_windows(C, 0, 40, 60, 80)
    assert C["exit_day"][fit].max() < 40 - EMB and C["day"][cal].min() >= 40 and C["exit_day"][cal].max() < 60 - EMB
    try:
        e_windows(dict(day=np.arange(100), exit_day=np.arange(100) + 3, ep=np.zeros(100, int)), 0, 40, 60, 80)
        raise RuntimeError("episode straddling windows was not detected")
    except AssertionError:
        pass
    print("E windows OK: fit/cal/threshold disjoint, chronological, purged + embargoed, one episode never in two windows")


if __name__ == "__main__":
    {"check": lambda: check(), "dev": lambda: dev(sys.argv[2]), "final": lambda: final(sys.argv[2])}[sys.argv[1]]()
