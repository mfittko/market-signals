"""filter316 (issue 316): score the live LLM alert filter's verdicts against realized outcomes.

Evaluator v2 (labels_v2.simulate, validate.day_boot, de_v2.supertrend) is imported, never edited.

  python f316.py check       self-checks (reason mapping, gate, time parsing)
  python f316.py explore     counts, category mapping, live/research flip agreement (NO outcomes)
  python f316.py register    write prereg.json (refuses to overwrite)
  python f316.py run         outcomes + statistics -> out/results.json, out/signals.csv
"""
import os, sys, re, json, time, glob, sqlite3, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ENG)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import de_v2 as de  # noqa: E402
from bars import resample, CACHE  # noqa: E402
from labels_v2 import simulate, POLICY  # noqa: E402
from validate import day_of, day_boot  # noqa: E402

EXP = "filter316"
OUT = os.path.join(HERE, "out")
LIVE = "file:/Users/mfittko/github/market-signals/data/candles.db?mode=ro"
GMIN = {"M1": 1, "M5": 5, "M15": 15, "H1": 60}
WARM = "2026-04-01"              # research frame starts here (supertrend/ATR warmup ~3.5 months before the first live signal)
SPR_R = 0.2                      # issue 315 spread rule
THIN = {"WTICO/USD": [4, 5, 22, 23], "XAU/USD": [4, 21, 22, 23], "XAG/USD": [0, 21, 22, 23],
        "NATGAS/USD": [3, 4, 22, 23], "SPX500/USD": [3, 4, 5, 6], "EUR/USD": [4, 21, 22, 23]}  # issue 315 lists; others: spread only
NBOOT, NNULL = 1000, 500
MIN_N = 30                       # fewer tagged suppressions than this -> insufficient evidence
# Reason categories: multi-label, case-insensitive regex on the filter's free-text reason. Order = priority list for display only.
CATS = {
    "late_chasing": r"\blate\b|chas|extended|stretch|exhaust|blow-?off|overbought|oversold|\brsi\b|wrong[- ]extreme|range[- ]extreme"
                    r"|session (high|low|top|bottom|floor|extreme)|day('s)? (high|low)|(at|near|into|to) (the |a )?(session |day |local |recent "
                    r"|range |window |new )?(highs?|lows?|top|bottom|floor|ceiling|extremes?)\b|atr (above|below|from|past) (vwap|ema)"
                    r"|far (above|below|from)|already (moved|ran|run)|after (an? )?(extended|big|sharp|large)",
    "against_trend": r"counter|against|opposite|htf (down|up|bear|bull)|vs\.? (bull|bear|m15|m5|h1|h4|htf|ema)|(m15|h1|htf) (still )?(up|down)trend",
    "low_volume": r"thin|low[- ]vol|weak[- ]vol|sub-?average|below[- ]av(era)?ge?|light vol|avg vol|average vol|\b0?\.\d+ ?[x×]|\(0\.\d+\)"
                  r"|ratio 0|vol(ume)? (only |of )?(0|1\.[0-4])\d*|no volume|volume not",
    "chop_weak_setup": r"chop|ranging|range-?bound|\badx\b|conviction|impulse|flip-?flop|whipsaw|mid-?range|mid-?bar|indecis|follow[- ]?through"
                       r"|reject|wick|failure|decisive|no (lower low|higher high|break)|backtest|win ?rate|% ?wr|\bwr\b|rapid|\d(rd|th|nd) flip",
    "news_event": r"news|headline|\beia\b|\bnfp\b|fomc|\bcpi\b|release|sentinel|inventor|opec|\bfed\b|event|tariff|geopolit",
}
CAT_RE = {k: re.compile(v, re.I) for k, v in CATS.items()}
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
CODE = {"f316.py": sha(os.path.join(HERE, "f316.py"))}


def tag(reason):
    """Multi-label tags and the first-mentioned category ('other' when nothing matches)."""
    r = reason if isinstance(reason, str) else ""
    hits = {k: (m.start() if (m := rx.search(r)) else None) for k, rx in CAT_RE.items()}
    tags = {k: v is not None for k, v in hits.items()}
    pos = [(v, k) for k, v in hits.items() if v is not None]
    return tags, (min(pos)[1] if pos else "other")


def tmin(iso):
    return int(np.datetime64(iso[:16], "m").astype(np.int64))


# ------------------------------------------------------------------ live verdicts
def live_rows():
    con = sqlite3.connect(LIVE, uri=True, timeout=5)
    q = ("select s.instrument, s.granularity, s.time, s.signal, s.verdict, s.reason, ss.filter_verdict, ss.filter_model, "
         "ss.filter_prompt_version from signals s left join signal_snapshots ss on ss.instrument=s.instrument and "
         "ss.granularity=s.granularity and ss.time=s.time where s.kind='supertrend-flip' and s.verdict in ('alert','suppress') "
         "order by s.time")
    df = pd.DataFrame(con.execute(q).fetchall(), columns=["inst", "g", "time", "signal", "verdict", "reason", "snap_verdict",
                                                          "model", "prompt_version"])
    con.close()
    df["fail_open"] = df["reason"].fillna("").str.startswith("filter error")
    df["snap_mismatch"] = df["snap_verdict"].notna() & (df["snap_verdict"] != df["verdict"])
    df["t"] = [tmin(x) for x in df["time"]]
    df["side"] = np.where(df["signal"] == "buy", 1, -1)
    df["model"] = df["model"].fillna("unknown")
    T = [tag(r) for r in df["reason"]]
    for k in CATS:
        df["c_" + k] = [t[0][k] for t in T]
    df["primary"] = [t[1] for t in T]
    df.loc[df["verdict"] == "alert", [f"c_{k}" for k in CATS]] = False   # categories describe suppressions only
    df.loc[df["verdict"] == "alert", "primary"] = "allowed"
    return df


def load_m1c(inst):
    fs = glob.glob(os.path.join(CACHE, inst.replace("/", "_") + "_*.npz"))
    if not fs:
        return None, None
    f = sorted(fs, key=lambda p: int(p.split("_")[-2]))[-1]
    z = np.load(f); m = z["t"] >= np.datetime64(WARM, "m").astype(np.int64)
    return {k: z[k][m] for k in z.files}, os.path.basename(f)


def frames(insts_g):
    """{(inst, g): B} research bid/ask frames with production supertrend, from WARM to the cache end."""
    F, src = {}, {}
    for inst in sorted({i for i, _ in insts_g}):
        m1, s = load_m1c(inst)
        src[inst] = s
        if m1 is None:
            continue
        for g in sorted({g for i, g in insts_g if i == inst}):
            B = m1 if g == "M1" else resample(m1, g)
            if g == "M1":
                B = dict(B)
                for k in ("o", "h", "l", "c"):
                    B["mid_" + k] = (B["bid_" + k] + B["ask_" + k]) / 2
            S = de.supertrend(inst, B)
            for k in ("trend", "atr", "st"):
                B[k] = S[k]
            B["flip"] = np.nan_to_num(S["flip"]).astype(int)
            B["spr"] = (B["ask_c"] - B["bid_c"]) / (POLICY["k"] * B["atr"])
            F[(inst, g)] = B
    return F, src


def match(df, F):
    """Bar index of each live signal in its research frame (-1 when absent), research flip at that bar, 315 gate flags."""
    idx = np.full(len(df), -1); rflip = np.zeros(len(df), int); spr = np.full(len(df), np.nan)
    for (inst, g), B in F.items():
        m = ((df["inst"] == inst) & (df["g"] == g)).to_numpy()
        t = df["t"].to_numpy()[m]
        p = np.clip(np.searchsorted(B["t"], t), 0, len(B["t"]) - 1)
        ok = B["t"][p] == t
        ii = np.where(ok, p, -1)
        idx[m] = ii; rflip[m] = np.where(ok, B["flip"][p], 0); spr[m] = np.where(ok, B["spr"][p], np.nan)
    df["bar"] = idx; df["rflip"] = rflip; df["spr"] = spr
    close = df["t"] + df["g"].map(GMIN)
    hr = (close % 1440) // 60
    df["g_spread"] = df["spr"] > SPR_R
    df["g_thin"] = [h in THIN.get(i, []) for i, h in zip(df["inst"], hr)]
    df["gate315"] = df["g_spread"] | df["g_thin"]
    return df


def population(df):
    """Scored population: LLM-judged (not fail-open), instrument with bid/ask history, bar matched."""
    return df[~df["fail_open"] & (df["bar"] >= 0)].copy()


# ------------------------------------------------------------------ statistics
def holm(p):
    p = np.asarray(p, float); o = np.argsort(p); m = len(p); adj = np.empty(m); run = 0.0
    for r, k in enumerate(o):
        run = max(run, min(1.0, (m - r) * p[k])); adj[k] = run
    return adj


def pct(a):
    a = a[np.isfinite(a)]
    return [float(np.percentile(a, 2.5)), float(np.percentile(a, 97.5))] if len(a) else [None, None]


def block_test(net, day, all_days, blocked, rng, nboot=NBOOT, nnull=NNULL):
    """Blocking `blocked` signals: delta = mean kept - mean all; blocked-minus-all; kept-minus-blocked; random-thinning null."""
    n, nb = len(net), int(blocked.sum())
    if nb == 0 or nb == n:
        return dict(n=int(n), blocked=nb)

    def stat(ix):
        x, b = net[ix], blocked[ix]
        if b.all() or not b.any():
            return [np.nan] * 4
        return [x[~b].mean() - x.mean(), x[b].mean() - x.mean(), x[~b].mean() - x[b].mean(), x[~b].mean()]
    T = stat(np.arange(n)); bt = day_boot(day, all_days, stat, nboot)
    null = np.array([net[~np.isin(np.arange(n), rng.choice(n, nb, replace=False))].mean() - net.mean() for _ in range(nnull)])
    se = float(np.nanstd(bt[:, 0]))
    return dict(n=int(n), blocked=nb, block_share=nb / n, meanR_all=float(net.mean()),
                meanR_blocked=float(net[blocked].mean()), meanR_kept=float(net[~blocked].mean()),
                delta_kept_vs_all=[float(T[0]), pct(bt[:, 0])], blocked_minus_all=[float(T[1]), pct(bt[:, 1])],
                kept_minus_blocked=[float(T[2]), pct(bt[:, 2])], meanR_kept_ci=[float(T[3]), pct(bt[:, 3])],
                p_one_sided=float((np.sum(bt[:, 0] <= 0) + 1) / (len(bt) + 1)), se_delta=se, mde80=2.8 * se,
                null=dict(q025=float(np.quantile(null, 0.025)), q50=float(np.median(null)), q975=float(np.quantile(null, 0.975)),
                          pct_of_null=float((null < T[0]).mean())),
                losses_avoided_R=float(-net[blocked & (net < 0)].sum()), winners_missed_R=float(net[blocked & (net > 0)].sum()))


def mean_ci(net, day, all_days, nboot=NBOOT):
    if len(net) == 0:
        return dict(n=0)
    bt = day_boot(day, all_days, lambda ix: [net[ix].mean()], nboot)
    return dict(n=int(len(net)), meanR=float(net.mean()), ci=pct(bt[:, 0]))


def classify(o):
    """Preregistered decision rule for one blocking rule (see prereg.json decision_rule)."""
    if o.get("blocked", 0) < MIN_N or "delta_kept_vs_all" not in o:
        return "insufficient evidence"
    d, (lo, hi) = o["delta_kept_vs_all"][0], o["delta_kept_vs_all"][1]
    if lo > 0 and d > o["null"]["q975"] and o.get("p_holm", 0) < 0.05:
        return "keep"
    if hi < 0 or d < o["null"]["q025"]:
        return "drop"
    return "insufficient evidence"


def better_worse(o):
    lo, hi = o["blocked_minus_all"][1]
    return "better than average" if lo > 0 else "worse than average" if hi < 0 else "not distinguishable from average"


# ------------------------------------------------------------------ modes
def explore():
    df = live_rows()
    F, src = frames(set(zip(df["inst"], df["g"])))
    df = match(df, F)
    P = population(df)
    agree = (P["rflip"] == P["side"]).mean()
    sup = P[P["verdict"] == "suppress"]
    ex = dict(
        rows_flip_alert_or_suppress=int(len(df)), fail_open=int(df["fail_open"].sum()), snap_mismatch=int(df["snap_mismatch"].sum()),
        no_bidask_history=df[~df["inst"].isin([i for i, _ in F])].groupby("inst").size().to_dict(),
        unmatched_bar=int(((df["bar"] < 0) & ~df["fail_open"]).sum()), population=int(len(P)),
        verdict_counts=P["verdict"].value_counts().to_dict(), src=src,
        research_flip_same_side_at_bar=float(agree),
        research_flip_any_at_bar=float((P["rflip"] != 0).mean()),
        cat_tag_counts={k: int(sup["c_" + k].sum()) for k in CATS}, primary_counts=sup["primary"].value_counts().to_dict(),
        untagged_examples=sup[sup["primary"] == "other"]["reason"].head(25).tolist(),
        gate315_share=float(P["gate315"].mean()), gate315_spread=float(P["g_spread"].mean()), gate315_thin=float(P["g_thin"].mean()),
        by_model=P.groupby(["model", "verdict"]).size().unstack(fill_value=0).to_dict("index"),
        by_stream={f"{a}/{b}": v for (a, b), v in P.groupby(["inst", "g", "verdict"]).size().unstack(fill_value=0).to_dict("index").items()},
        last_signal=str(P["time"].max()), first_signal=str(P["time"].min()))
    for k in CATS:
        ex["examples_" + k] = sup[sup["c_" + k]]["reason"].sample(min(8, int(sup["c_" + k].sum())), random_state=1).tolist()
    os.makedirs(OUT, exist_ok=True)
    json.dump(ex, open(os.path.join(OUT, "explore.json"), "w"), indent=1, default=str)
    print(json.dumps({k: v for k, v in ex.items() if not k.startswith("examples")}, indent=1, default=str))


def run():
    t0 = time.time()
    reg = json.load(open(os.path.join(HERE, "prereg.json")))
    assert reg["code_sha256"]["f316.py"] == CODE["f316.py"], "f316.py changed after registration (amend first)"
    assert reg["code_sha256"]["evaluator"] == de.CODE_SHA
    df = live_rows()
    F, src = frames(set(zip(df["inst"], df["g"])))
    df = match(df, F)
    P = population(df)
    net = np.full(len(P), np.nan); xr = np.zeros(len(P), int)
    for (inst, g), B in F.items():
        m = ((P["inst"] == inst) & (P["g"] == g)).to_numpy()
        if not m.any():
            continue
        i = P["bar"].to_numpy()[m]
        sm = simulate(B, i, P["side"].to_numpy()[m], B["atr"][i], B["flip"], POLICY)
        net[m] = np.where(sm["ok"], sm["net_R"], np.nan)
    P["net_R"] = net
    P["day"] = day_of(P["t"].to_numpy())
    P.to_csv(os.path.join(OUT, "signals.csv"), index=False)
    S = P[np.isfinite(P["net_R"])].reset_index(drop=True)
    x, d = S["net_R"].to_numpy(), S["day"].to_numpy()
    AD = np.arange(d.min(), d.max() + 1)
    sup = (S["verdict"] == "suppress").to_numpy()
    rng = np.random.default_rng(316)
    res = dict(created=time.strftime("%Y-%m-%dT%H:%M:%S%z"), evaluator=de.CODE_SHA, f316=CODE["f316.py"], src=src,
               censored=int(len(P) - len(S)), n=int(len(S)), days=int(len(np.unique(d))), first=str(S["time"].min()), last=str(S["time"].max()))
    res["overall"] = block_test(x, d, AD, sup, rng)
    res["allowed"] = mean_ci(x[~sup], d[~sup], AD); res["suppressed"] = mean_ci(x[sup], d[sup], AD); res["all"] = mean_ci(x, d, AD)
    res["categories"] = {k: block_test(x, d, AD, S["c_" + k].to_numpy(), rng) for k in CATS}
    res["categories"]["other_untagged"] = block_test(x, d, AD, (sup & (S["primary"] == "other")).to_numpy(), rng)
    res["primary"] = {k: mean_ci(x[(S["primary"] == k).to_numpy()], d[(S["primary"] == k).to_numpy()], AD)
                      for k in list(CATS) + ["other", "allowed"]}
    names = ["overall"] + list(CATS)
    ps = holm([res["overall"]["p_one_sided"]] + [res["categories"][k].get("p_one_sided", 1.0) for k in CATS])
    for nm, p in zip(names, ps):
        (res["overall"] if nm == "overall" else res["categories"][nm])["p_holm"] = float(p)
    g = S["gate315"].to_numpy()
    res["gate315"] = dict(gate=block_test(x, d, AD, g, rng), spread=block_test(x, d, AD, S["g_spread"].to_numpy(), rng),
                          thin=block_test(x, d, AD, S["g_thin"].to_numpy(), rng), combined=block_test(x, d, AD, g | sup, rng))
    k = ~g  # LLM incremental among 315-kept signals
    AD2 = AD
    res["gate315"]["llm_within_gate_kept"] = block_test(x[k], d[k], AD2, sup[k], rng)
    res["gate315"]["late_within_gate_kept"] = block_test(x[k], d[k], AD2, S["c_late_chasing"].to_numpy()[k], rng)
    res["gate315"]["overlap"] = dict(gate_share_of_suppressed=float(g[sup].mean()), gate_share_of_allowed=float(g[~sup].mean()))
    # breakdowns (points + CIs where n allows)
    def brk(col):
        out = {}
        for key, ix in S.groupby(col).groups.items():
            ix = np.asarray(list(ix))
            s = sup[ix]
            out[" / ".join(map(str, key)) if isinstance(key, tuple) else str(key)] = dict(
                n=int(len(ix)), suppress_share=float(s.mean()),
                allowed=mean_ci(x[ix][~s], d[ix][~s], AD, 300), suppressed=mean_ci(x[ix][s], d[ix][s], AD, 300))
        return out
    S["tf"] = np.where(S["g"] == "M1", "M1", "M5+")
    S["week"] = pd.to_datetime(S["t"], unit="m").dt.to_period("W").astype(str)
    S["month"] = pd.to_datetime(S["t"], unit="m").dt.to_period("M").astype(str)
    res["by_model"] = brk("model"); res["by_stream"] = brk(["inst", "g"]); res["by_tf"] = brk("tf"); res["by_month"] = brk("month")
    res["by_week_counts"] = S.groupby("week").agg(n=("net_R", "size"), suppress_share=("verdict", lambda v: float((v == "suppress").mean())),
                                                  meanR=("net_R", "mean")).reset_index().to_dict("records")
    for tf in ("M1", "M5+"):
        m = (S["tf"] == tf).to_numpy()
        res.setdefault("by_tf_tests", {})[tf] = dict(overall=block_test(x[m], d[m], AD, sup[m], rng),
                                                      late_chasing=block_test(x[m], d[m], AD, S["c_late_chasing"].to_numpy()[m], rng))
    res["decisions"] = {nm: classify(res["overall"] if nm == "overall" else res["categories"][nm]) for nm in names}
    res["decisions"]["other_untagged"] = classify(res["categories"]["other_untagged"])
    res["late_chasing_vs_average"] = better_worse(res["categories"]["late_chasing"])
    res["role"] = ("judge" if res["decisions"]["overall"] == "keep" and
                   res["gate315"]["llm_within_gate_kept"].get("delta_kept_vs_all", [0, [0, 0]])[1][0] > 0 else "annotator")
    res["secs"] = round(time.time() - t0)
    for nm in names:
        o = res["overall"] if nm == "overall" else res["categories"][nm]
        de.log_trial({"exp": EXP, "mode": "live-log", "rule": nm, "block_share": o.get("block_share"),
                      "delta": (o.get("delta_kept_vs_all") or [None])[0], "p_holm": o.get("p_holm"), "f316_sha256": CODE["f316.py"]})
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
    print("done", res["secs"], "s")


def check():
    t, p = tag("Buy flip near session high on weak volume (1.03x), ranging/countertrend tape")
    assert t["late_chasing"] and t["low_volume"] and t["chop_weak_setup"] and t["against_trend"] and not t["news_event"], t
    assert p == "late_chasing", p
    t, p = tag("Thin volume (0.64) and countertrend flip vs HTF down; weak impulse, no conviction.")
    assert p == "low_volume" and t["against_trend"] and t["chop_weak_setup"] and not t["late_chasing"], (t, p)
    t, p = tag("Counter-HTF sell, price 4.48 ATR below VWAP at session low - late wrong-extreme entry, vol only 1.8x")
    assert t["late_chasing"] and t["against_trend"] and p == "against_trend", (t, p)
    t, p = tag("EIA draw headline risk; oil news pending")
    assert t["news_event"] and not t["late_chasing"], t
    assert tag("xyz")[1] == "other"
    assert tmin("2026-07-22T10:15:00.000000000Z") == int(np.datetime64("2026-07-22T10:15", "m").astype(np.int64))
    assert holm([0.01, 0.04, 0.03]).round(3).tolist() == [0.03, 0.06, 0.06]
    print("f316 self-check OK: reason tags + first-mention primary, time parse, holm")


def register():
    Pf = os.path.join(HERE, "prereg.json")
    assert not os.path.exists(Pf), "prereg.json exists"
    ex = json.load(open(os.path.join(OUT, "explore.json")))
    reg = dict(
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        title="filter316: score the live LLM alert filter's verdicts against realized outcomes (issue 316)",
        before_registration="explore mode only: verdict/model/stream counts, reason-category tag counts and examples, live-vs-research "
                            "flip agreement, 315 gate block shares (out/explore.json). No outcome (net R, fill, label) computed before this file.",
        evaluator=dict(version="v2", digest=de.CODE_SHA, note="labels_v2.simulate, validate.day_boot, de_v2.supertrend unchanged"),
        data=dict(verdicts="data/candles.db read-only: signals (kind supertrend-flip, verdict alert|suppress) left-joined to signal_snapshots "
                           "(filter_model, prompt version). Impulse alerts are never LLM-filtered and are excluded.",
                  outcomes=f"engine/cache M1 bid/ask npz (newest per instrument, from history.db), sliced from {WARM}; M5/M15/H1 by "
                           "bars.resample; production supertrend (flips.mjs) per timeframe on that slice"),
        population="LLM-judged flips: verdict alert|suppress, reason not 'filter error...' (fail-open, no judgment), instrument with bid/ask "
                   "history (DE30/EUR has none: excluded and counted), live signal time equal to a research bar start of the same "
                   "timeframe; signals whose outcome is censored at the data end are dropped and counted. Side = live signal (buy/sell). "
                   "Rows refiltered by refilter-signals.mjs cannot be told apart and are kept (signals.verdict is the verdict of record).",
        management="308 baseline: labels_v2.simulate POLICY (k=1.5 ATR stop = 1R, breakeven after +1R, 3R target, opposite research "
                   "flip of the same timeframe exits, H=72 bars), entry at the next bar open on ask (buy) / bid (sell), research ATR at the "
                   "signal bar, equal cash risk (1 unit per trade, cash = net R); matched-entry, overlap allowed",
        taxonomy=dict(verdicts="allow (signals.verdict='alert') / suppress (signals.verdict='suppress')",
                      categories=CATS, rule="multi-label, case-insensitive regex search on the suppression reason; a suppression can "
                      "carry several categories; 'primary' = category whose first match appears earliest in the text (display/counts only); "
                      "no match -> other. Allowed signals carry no category."),
        gate315=dict(spread=f"(ask_c - bid_c)/(1.5 ATR) at the signal bar > {SPR_R}", thin_hours=THIN,
                     note="hour of the signal close (UTC); instruments without a list: spread rule only (issue 315)"),
        metrics=dict(
            blocking_rule="for each rule (overall LLM suppress; each category's tagged suppressions; untagged 'other'; 315 gate, its "
                          "spread and thin parts; 315 OR LLM): delta = mean net R of kept minus mean net R of all scored signals; "
                          "blocked-minus-all (better/worse than average); kept-minus-blocked; kept mean with CI; losses avoided vs winners missed",
            ci=f"5-day moving-block bootstrap over trading days (validate.day_boot, {NBOOT} reps)",
            null=f"random thinning: {NNULL} uniform draws of the same blocked count; percentile of the observed delta",
            power="bootstrap SE of delta and MDE80 = 2.8 SE",
            breakdowns="by model, instrument/timeframe, M1 vs M5+, month, week (counts, suppress share, allowed/suppressed mean R with CI)",
            incremental="LLM suppress and late_chasing among 315-gate-kept signals"),
        decision_rule=dict(
            per_rule=f"keep iff blocked >= {MIN_N}, delta CI lower > 0, delta above null q97.5 and Holm-adjusted one-sided p < 0.05 "
                     "(Holm over overall + the 5 categories); drop iff blocked >= MIN_N and (delta CI upper < 0 or delta below null q2.5); "
                     "else insufficient evidence",
            late_chasing_vs_average="blocked-minus-all CI lower > 0: blocks better-than-average signals; upper < 0: worse; else not "
                                    "distinguishable from average (point estimate reported)",
            role="LLM stays a judge iff overall verdict is 'keep' AND its delta among 315-gate-kept signals has CI lower > 0; "
                 "otherwise it becomes an annotator (alert everything that passes the deterministic gate, show the reason)",
            caveat="live log covers ~2.5 months: development evidence; any 'keep' needs prospective confirmation (313)"),
        explore_summary={k: ex[k] for k in ("population", "verdict_counts", "fail_open", "unmatched_bar", "no_bidask_history",
                                             "research_flip_same_side_at_bar", "cat_tag_counts", "primary_counts", "gate315_share")},
        rules="QUEUE.md shared rules; no git-tracked edits, no commits, no GitHub posts; trials logged with exp filter316",
        code_sha256=dict(evaluator=de.CODE_SHA, evaluator_files=de.CODE_FILES_SHA, **CODE))
    json.dump(reg, open(Pf, "w"), indent=1, default=str)
    print("registered", reg["created"])


if __name__ == "__main__":
    {"check": check, "explore": explore, "register": register, "run": run}[sys.argv[1]]()
