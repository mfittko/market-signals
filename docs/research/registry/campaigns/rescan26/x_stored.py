"""rescan26 extractor for campaigns that persisted per-trade gross (mid) R: orb15, daytype14, season17.
Each campaign's own trade_table / outcome / side rules are imported unchanged. Output: out/tr_<camp>.pkl with columns
camp, variant, inst, day, win, gross, net (one row per trade; win in dev / w2023 by the campaign's own window bounds)."""
import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__))
A = os.path.dirname(HERE); ENG = os.path.dirname(A)
for p in (ENG, *(os.path.join(A, c) for c in ("notrade12", "abs11", "limit13", "xvol9", "daytype14", "orb15", "season17"))):
    sys.path.insert(0, p)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from validate import year_start_day  # noqa: E402

OUT = os.path.join(HERE, "out")
TAG = lambda i: i.replace("/", "_")


def tag_win(day, bounds):
    w = np.full(len(day), None, object)
    for nm, (lo, hi) in bounds.items():
        w[(day >= lo) & (day < hi)] = nm
    return w


def orb():
    import orb15
    rows = []
    for inst in orb15.INSTS:
        z = pd.read_pickle(os.path.join(A, "orb15", "out", f"ev_{TAG(inst)}.pkl"))["res"]
        for var, D in z.items():
            D = D.copy(); D["inst"] = inst
            T = orb15.trade_table(var, D)
            rows.append(pd.DataFrame({"camp": "orb15", "variant": var, "inst": inst, "day": T.day.to_numpy(), "gross": T.gross.to_numpy(),
                                      "net": T.net.to_numpy()}))
        del z
    R = pd.concat(rows, ignore_index=True)
    R["win"] = tag_win(R.day.to_numpy(), {"dev": (year_start_day(2018), year_start_day(2023)), "w2023": (year_start_day(2023), 10 ** 9)})
    return R


def dt():
    import dt14
    P = pd.read_pickle(os.path.join(A, "daytype14", "out", "pooled.pkl"))
    rows = []
    for var in dt14.VARIANTS:
        cp = int(var.rsplit("_", 1)[1])
        S = P[P.cp == cp].reset_index(drop=True)
        Sm = {c: S[c].to_numpy() for c in S.columns}
        g = dt14.outcome(Sm, var, S.pred.to_numpy(), "gross"); n = dt14.outcome(Sm, var, S.pred.to_numpy(), "net")
        m = np.isfinite(g) & np.isfinite(n)
        rows.append(pd.DataFrame({"camp": "daytype14", "variant": var, "inst": [dt14.INSTS[i] for i in S.inst.to_numpy()[m]],
                                  "day": S.day.to_numpy()[m], "gross": g[m], "net": n[m]}))
    R = pd.concat(rows, ignore_index=True)
    R["win"] = tag_win(R.day.to_numpy(), {"dev": (year_start_day(2019), year_start_day(2023)), "w2023": (year_start_day(2023), 10 ** 9)})
    return R


def season():
    import season17 as s17
    res = json.load(open(os.path.join(A, "season17", "out", "results.json")))
    T = pd.concat([pd.read_pickle(os.path.join(A, "season17", "out", f"tr_{TAG(i)}.pkl")) for i in s17.INSTS], ignore_index=True)
    T = T[T.spr <= s17.SPR_R]
    dl, dh = s17.span(*s17.DEV); vl, vh = s17.span(*s17.VAL); wl, wh = s17.span(*s17.W23)
    rows = []
    for key, o in res["selected"].items():          # selected on 2018-2020 gross: dev window = validation 2021-2022 only
        X = T[(T.inst == o["inst"]) & (T.cand == o["cand"])]
        sd = int(o["side"])
        d = X.day.to_numpy()
        rows.append(pd.DataFrame({"camp": "season17", "variant": f"sel:{o['cand']}", "inst": o["inst"], "day": d, "gross": sd * X.gl.to_numpy(),
                                  "net": s17.side_net(X, sd), "win": tag_win(d, {"dev": (vl, vh), "w2023": (wl, wh)})}))
    for name, (inst, sd, _) in s17.NAMED.items():
        X = T[(T.inst == inst) & (T.cand == name)]
        if not len(X):
            print("named missing", name); continue
        d = X.day.to_numpy()
        rows.append(pd.DataFrame({"camp": "season17", "variant": name, "inst": inst, "day": d, "gross": sd * X.gl.to_numpy(),
                                  "net": s17.side_net(X, sd), "win": tag_win(d, {"dev": (dl, dh), "w2023": (wl, wh)})}))
    return pd.concat(rows, ignore_index=True)


if __name__ == "__main__":
    for nm, f in (("orb15", orb), ("daytype14", dt), ("season17", season)):
        R = f()
        R.to_pickle(os.path.join(OUT, f"tr_{nm}.pkl"))
        print(nm, len(R), R.groupby("win").size().to_dict(), R.variant.nunique(), flush=True)
