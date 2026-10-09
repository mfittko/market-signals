"""news24: does a strong, high-volume candle continue more often when it coincides with a burst of relevant news?
Usage: python news24.py selfcheck | plumb | run
  plumb: event, NEWS, CONTROL and no-data counts only (no outcome is computed).
  run:   outcomes (gross mid R primary per amendment 1, bid/ask net R secondary, at 3/6/12 bars), bootstrap CIs, decision; writes out/results.json and logs trials."""
import os, sys, json, sqlite3, hashlib
HERE = os.path.dirname(os.path.abspath(__file__)); ENG = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE); sys.path.insert(0, ENG)
import numpy as np
import events as ev
from labels_v2 import simulate
from validate import day_boot, ci, day_of, log_trial

INSTS = ["WTICO/USD", "XAU/USD", "XAG/USD", "EUR/USD", "SPX500/USD", "NATGAS/USD"]
TFS = ["M5", "M1", "M15"]  # M5 primary
HS = [3, 6, 12]
Z_BURST, MIN_REL = 2.0, 5        # NEWS: share z >= 2.0 AND >= 5 relevant articles in the two windows
BASE_DAYS, BASE_MIN = 14, 40     # baseline: 4-hourly grid files in the 14 days before the older window, >= 40 files
GRID = 240
W23 = int(np.datetime64("2023-01-01", "m").astype(np.int64))
REPS, BLOCK, SEED = 1000, 5, 24
P = lambda h: dict(k=1.5, m=1.0, T=3.0, H=h)


def news_table(db=os.path.join(HERE, "news24.db")):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    cols = [c.replace("/", "_") for c in INSTS]
    rows = con.execute(f"select ts, total, {','.join(cols)} from files where status='ok' and total > 0 order by ts").fetchall()
    a = np.array(rows, float) if rows else np.zeros((0, 2 + len(cols)))
    return {"ts": a[:, 0].astype(np.int64), "total": a[:, 1], **{c: a[:, 2 + k] for k, c in enumerate(cols)}}


def news_features(close, inst, N):
    """Per event close time (epoch min): z of the relevant share in the two newest GDELT files whose timestamp is
    <= close, against the 4-hourly grid in the prior 14 days. Lookahead guard asserted here."""
    col = inst.replace("/", "_")
    pos = {t: k for k, t in enumerate(N["ts"])}
    gmask = N["ts"] % GRID == 0
    gts, gsh = N["ts"][gmask], N[col][gmask] / N["total"][gmask]
    out = np.full((len(close), 3), np.nan)  # z, rel, share
    for k, c in enumerate(close):
        e1 = c // 15 * 15; e2 = e1 - 15
        assert e1 <= c and e2 < e1, "lookahead guard: GDELT file timestamp must be <= bar close"
        if e1 not in pos or e2 not in pos:
            continue
        j1, j2 = pos[e1], pos[e2]
        rel, tot = N[col][j1] + N[col][j2], N["total"][j1] + N["total"][j2]
        lo, hi = np.searchsorted(gts, e2 - BASE_DAYS * 1440), np.searchsorted(gts, e2)  # grid strictly before e2
        b = gsh[lo:hi]
        assert hi == 0 or gts[hi - 1] < e2
        if len(b) < BASE_MIN or tot <= 0:
            continue
        sd = b.std(ddof=1)
        out[k] = [((rel / tot) - b.mean()) / sd if sd > 0 else np.nan, rel, rel / tot]
    return out


def classify(F):
    z, rel = F[:, 0], F[:, 1]
    ok = np.isfinite(z)
    news = ok & (z >= Z_BURST) & (rel >= MIN_REL)
    return ok, news, ok & ~news


def window_of(close):
    return np.where(close < W23, "dev", "w2023")


def collect(inst, tf, N, outcomes=False):
    B = ev.load(inst, tf)
    E = ev.candidates(B)
    F = news_features(E["close"], inst, N)
    ok, news, ctrl = classify(F)
    R = {"i": E["i"], "side": E["side"], "close": E["close"], "ok": ok, "news": news, "ctrl": ctrl, "F": F,
         "win": window_of(E["close"]), "day": day_of(E["close"] - 1)}
    if outcomes:
        flip0 = np.zeros(len(B["t"]), int)  # time exit only; the opposite-flip exit is not used here
        # amendment 1 (gross primary): the same simulation on mid prices (bid = ask = mid), entry at the next bar open
        Bm = {f"{s}_{k}": B["mid_" + k] for s in ("bid", "ask") for k in "ohlc"}
        for h in HS:
            for key, BB in (("net", B), ("gross", Bm)):
                S = simulate(BB, E["i"], E["side"], B["atr"][E["i"]], flip0, P(h))
                R[f"{key}{h}"] = np.where(S["ok"], S["net_R"], np.nan)
        R["all_days"] = np.unique(day_of(B["t"][B["t"] >= ev.START]))
    return R


def stats(R, w, h, key):
    m = (R["win"] == w) & R["ok"] & np.isfinite(R[f"{key}{h}"])
    x, nw, cl, d = R[f"{key}{h}"][m], R["news"][m], R["ctrl"][m], R["day"][m]
    days = R["all_days"]; days = days[(days >= d.min()) & (days <= d.max())] if len(d) else days
    out = {"n_news": int(nw.sum()), "n_ctrl": int(cl.sum()), "news_mean": float(x[nw].mean()) if nw.any() else None,
           "ctrl_mean": float(x[cl].mean()) if cl.any() else None,
           "news_cont": float((x[nw] > 0).mean()) if nw.any() else None, "ctrl_cont": float((x[cl] > 0).mean()) if cl.any() else None}
    if nw.sum() < 2 or cl.sum() < 2:
        return out

    def st(idx):
        a, b = nw[idx], cl[idx]
        if not a.any() or not b.any():
            return np.array([np.nan] * 3)
        return np.array([x[idx][a].mean(), x[idx][b].mean(), x[idx][a].mean() - x[idx][b].mean()])
    bs = day_boot(d, days, st, reps=REPS, block=BLOCK, seed=SEED)
    out["news_ci"], out["ctrl_ci"], out["diff_ci"] = ci(bs[:, 0]), ci(bs[:, 1]), ci(bs[:, 2])
    out["diff"] = out["news_mean"] - out["ctrl_mean"]
    out["p_news_le0"] = float(np.mean(bs[:, 0][np.isfinite(bs[:, 0])] <= 0))
    out["p_diff_le0"] = float(np.mean(bs[:, 2][np.isfinite(bs[:, 2])] <= 0))
    return out


def sha(f):
    return hashlib.sha256(open(os.path.join(HERE, f), "rb").read()).hexdigest()


def selfcheck():
    t0 = W23
    ts = np.arange(t0 - 20 * 1440, t0 + 1440, 15)
    tot = np.full(len(ts), 1000.0); rel = np.full(len(ts), 50.0) + (np.arange(len(ts)) % 3)
    k = np.searchsorted(ts, t0 + 600)
    rel[k] = 200  # burst in the file stamped t0+600
    N = {"ts": ts, "total": tot, "WTICO_USD": rel}
    F = news_features(np.array([t0 + 599, t0 + 600, t0 + 614, t0 + 629, t0 + 630]), "WTICO/USD", N)
    ok, news, ctrl = classify(F)
    # close 599 cannot see the file stamped 600; closes 600..629 see it; close 630 sees files 630 and 615 only
    assert list(news) == [False, True, True, True, False], (F, news)
    assert ok.all()
    print("news24 self-check OK (lookahead boundary, burst classification)")


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "selfcheck":
        selfcheck(); ev._selfcheck(); sys.exit()
    N = news_table()
    print("news files ok", len(N["ts"]), "grid", int((N["ts"] % GRID == 0).sum()))
    res = {"meta": {"code_sha256": {f: sha(f) for f in ("news24.py", "events.py", "relevance.py", "relevance.json", "fetch.py")}}}
    for tf in TFS:
        for inst in INSTS:
            R = collect(inst, tf, N, outcomes=(mode == "run"))
            for w in ("dev", "w2023"):
                m = R["win"] == w
                c = dict(n_events=int(m.sum()), n_nodata=int((m & ~R["ok"]).sum()), n_news=int((m & R["news"]).sum()),
                         n_ctrl=int((m & R["ctrl"]).sum()))
                if mode == "run":
                    c.update({f"{key}_H{h}": stats(R, w, h, key) for key in ("gross", "net") for h in HS})
                    for key in ("gross", "net"):
                      for h in HS:
                        r = c[f"{key}_H{h}"]
                        log_trial(dict(exp="news24", cell=f"{tf}|{key}|H{h}", unit=inst, window=w,
                                       decision=(inst == "WTICO/USD" and tf == "M5" and h == 6 and key == "gross"),
                                       n_news=r["n_news"], n_ctrl=r["n_ctrl"], news_mean=r["news_mean"], diff=r.get("diff"),
                                       mode="dev" if w == "dev" else "devwindow2023",
                                       news24_sha256=res["meta"]["code_sha256"]["news24.py"]))
                res.setdefault(tf, {}).setdefault(inst, {})[w] = c
                print(tf, inst, w, {k: v for k, v in c.items() if not k[:1] in "gn" or k.startswith("n_")}, flush=True)
    if mode == "run":
        d = {w: res["M5"]["WTICO/USD"][w]["gross_H6"] for w in ("dev", "w2023")}
        passed = all(d[w].get("news_ci") and d[w]["news_ci"][0] > 0 and d[w]["diff_ci"][0] > 0 for w in d)
        res["decision"] = {"cell": "WTICO/USD M5 gross H6 (amendment 1)", "pass": bool(passed)}
        os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
        json.dump(res, open(os.path.join(HERE, "out", "results.json"), "w"), indent=1, default=float)
        print("DECISION", res["decision"])
