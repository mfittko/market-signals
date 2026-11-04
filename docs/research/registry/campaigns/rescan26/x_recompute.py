"""rescan26 recompute for campaigns without persisted per-trade gross. Each campaign's own functions are imported unchanged;
gross = the same entries simulated on a bar copy whose bid/ask fields equal the mid (zero spread). Entry selection (spread
rules, confirmation) is always taken from the real bid/ask bars. One subcommand per campaign, run serially:
  python x_recompute.py pairs16 | mw6 | xvol9 | xvol10 | lean21 | wave23 | nt12 | dev2
Output: out/tr_<name>.pkl with columns camp, variant, inst, day, win, gross, net."""
import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__))
A = os.path.dirname(HERE); ENG = os.path.dirname(A)
OUT = os.path.join(HERE, "out")
sys.path.insert(0, ENG)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from validate import year_start_day, day_of  # noqa: E402

Y = year_start_day
OHLC = "ohlc"


def mid(B):
    M = dict(B)
    for s in ("bid", "ask"):
        for k in OHLC:
            M[f"{s}_{k}"] = B["mid_" + k]
    return M


def wins(day, dev_from):
    w = np.full(len(day), None, object)
    w[(day >= Y(dev_from)) & (day < Y(2023))] = "dev"; w[day >= Y(2023)] = "w2023"
    return w


def frame(camp, variant, inst, day, gross, net, dev_from=2018):
    day = np.asarray(day, np.int64)
    return pd.DataFrame({"camp": camp, "variant": variant, "inst": inst, "day": day, "gross": np.asarray(gross, float),
                         "net": np.asarray(net, float), "win": wins(day, dev_from)})


def add_path(*c):
    for x in c:
        sys.path.insert(0, os.path.join(A, x))


# ------------------------------------------------------------------ pairs16 (next open, both legs; gross = mid opens)
def pairs16():
    add_path("pairs16", "notrade12", "mw6", "abs11", "xvol9")
    import pairs16 as P16
    rows = []
    for h in P16.HZ:
        for p, (a, b) in P16.PAIRS.items():
            P = P16.pair_frame(a, b, h); T = P16.find_trades(P, h)
            net, gross = P16.outcome(P, T["i"], T["e"], T["x"], T["side"])
            d = P["day"][T["e"]]
            for v in (f"{p}_{h}", f"pooled_{h}"):
                rows.append(frame("pairs16", v, p if v.startswith(p) else "POOLED_PAIRS", d, gross, net))
            print(p, h, len(d), flush=True)
    return pd.concat(rows, ignore_index=True)


# ------------------------------------------------------------------ mw6 (D1, next open; gross = bid/ask gross + spread, full size)
def mw6():
    add_path("mw6", "notrade12", "abs11", "xvol9")
    import mw6 as M
    reg = json.load(open(os.path.join(A, "mw6", "prereg.json")))
    rows = []
    for inst in M.INSTS:
        D = M.build(inst); big = M.big_state(D, reg["floors"][inst])
        for name in M.POLICIES:
            tr = M.policy_trades(D, name, big)
            if not tr:
                continue
            r, _, _ = M.net_pnl(D, tr, M.FIN_BASE)
            mult = M.H_of(name) if name.startswith(("B1", "B2", "B3", "C2")) else 1
            e = np.array([t["e"] for t in r]); N = np.array([t["N"] for t in r])
            g = np.array([t["gross"] + t["spread"] for t in r]) * mult   # tranche R x H tranches = full-size R (mw6 N0)
            n = np.array([t["netR"] for t in r]) * mult
            rows.append(frame("mw6", name, inst, day_of(D["t"][e]), g, n, 2019))
        print(inst, flush=True)
    return pd.concat(rows, ignore_index=True)


# ------------------------------------------------------------------ xvol9 (K=3 primary; M72 / M12 management)
def xvol9():
    add_path("xvol9")
    import xvol9 as X
    D = X.load(); G = X.grid(D); ev = X.events(G, X.K_MAIN)
    Dm = {k: mid(v) for k, v in D.items()}
    CH = {"H1": X.h1h3(G, ev, "ext", 1), "H2": X.h2(G, ev), "H3": X.h1h3(G, ev, "mid", -1)}
    rows = []
    for hyp, C in CH.items():
        for mg, P in X.MANAGE.items():
            Tn = X.trades(D, C, P); Tg = X.trades(Dm, C, P)
            ok = Tn["ok"] & Tg["ok"] & (Tn["sig"] == Tg["sig"]) & (Tn["sig"] >= 0)
            for inst in X.INSTS:
                m = ok & (C["inst"] == inst)
                if m.any():
                    rows.append(frame("xvol9", f"K3_{hyp}_{mg}", inst, Tn["day"][m], Tg["net"][m], Tn["net"][m]))
            print(hyp, mg, int(ok.sum()), flush=True)
    return pd.concat(rows, ignore_index=True)


# ------------------------------------------------------------------ xvol10 (M1 event study, K=3, confirmed, exit +h min)
def xvol10():
    add_path("xvol10", "xvol9")
    import xvol10 as X
    D1, M1, A5 = X.load_m1()
    G = X.X9.grid(D1); ev = X.X9.events(G, X.K_MAIN); C = X.X9.h1h3(G, ev, "ext", 1)
    del G
    Sn = X.study(C, M1, A5, 1)
    Sg = X.study(C, {k: mid(v) for k, v in M1.items()}, A5, 1)
    m = Sn["conf"] & Sn["entry"]
    rows = []
    for k, h in enumerate(X.EXEC_MIN):
        for inst in X.INSTS:
            mi = m & (Sn["inst"] == inst) & np.isfinite(Sg["ex"][:, k]) & np.isfinite(Sn["ex"][:, k])
            if mi.any():
                rows.append(frame("xvol10", f"K3_conf_exit{h}m", inst, day_of(Sn["t"][mi]), Sg["ex"][mi, k], Sn["ex"][mi, k]))
    return pd.concat(rows, ignore_index=True)


# ------------------------------------------------------------------ lean21 (entry i+1 open, exit close i+H, no stop)
def lean21():
    add_path("lean21", "abs11", "pprofit20")
    import lean21 as L
    rows = []
    for inst in L.INSTS:
        AR = L.alert_rows(inst); B, _ = L.m5(inst)
        Dn = L.decision_rows(inst, B, AR)
        Bm = dict(B); Bm["bid_c"] = np.full(len(B["t"]), np.nan)       # lean21's own mid branch (outcomes only)
        Dg = L.decision_rows(inst, Bm, AR)
        assert np.array_equal(Dn["i"], Dg["i"])
        alert = Dn["P"] >= L.ALERT_X * Dn["base"]
        mv = np.abs(Dn["move"]) >= L.K_MAIN * Dn["T1"]
        for H in L.HS:
            netL, netS = Dn[f"netL{H}"], Dn[f"netS{H}"]
            gL = Dg[f"netL{H}"]
            base_ok = (Dn["state"] >= 1) & (Dn["side"] != 0) & (Dn["spr"] <= L.SPR_MAX) & np.isfinite(netL) & np.isfinite(netS)
            scored = base_ok & (Dn["state"] == 1)
            net = np.where(Dn["side"] > 0, netL, netS); gross = Dn["side"] * gL
            for nm, m in (("main", scored & alert & mv), ("B1_move_noalert", scored & ~alert & mv),
                          ("B2_alert_nomove", scored & alert & ~mv), ("B3_all_scored", scored)):
                rows.append(frame("lean21", f"{nm}_H{H}", inst, Dn["day"][m], gross[m], net[m], 2019))
        print(inst, flush=True)
    return pd.concat(rows, ignore_index=True)


# ------------------------------------------------------------------ wave23 (primary cells flip|st|noexit, armed days)
def wave23():
    add_path("wave23", "lean21", "abs11", "pprofit20")
    import wave23 as W
    rows = []
    cfgs = [c for c in W.configs() if c["trig"] == "flip" and c["trail"] == "st" and not c["sess"]]
    allc = W.configs()
    for ii, inst in enumerate(W.INSTS):
        AR = W.L.alert_rows(inst); starts, arms = W.day_starts(AR)
        m1, _ = W.PP.load_m1c(inst); thin = W.thin_hours(m1)
        Bs = {tf: W.frame(inst, m1, tf, thin) for tf in W.TFS}
        for c in cfgs:
            ci = allc.index(c); B = Bs[c["tf"]]; Bm = mid(B)
            rng = np.random.default_rng([W.SEED, ii, ci])
            _, tr = W.run_policy(Bm, starts, arms, "armed", c["k"], c["trig"], c["trail"], c["sess"], W.CAP[c["tf"]], rng)
            idx = {int(tc): j for j, tc in enumerate(B["tc"])}
            g, n, d = [], [], []
            for day, tc, s, R, _ in tr:
                i = idx[tc]
                res = W.sim_trade(B, i, s, c["k"], c["trail"], W.CAP[c["tf"]], None)   # net of the same trade (bid/ask)
                if res is None:
                    continue
                g.append(R); n.append(res[0]); d.append(day)
            rows.append(frame("wave23", W.cell_name(c) + "|armed", inst, d, g, n, 2019))
        print(inst, flush=True)
    return pd.concat(rows, ignore_index=True)


# ------------------------------------------------------------------ notrade12 / limit13 market baseline (flips, impulses)
def nt12():
    add_path("notrade12", "xvol9", "abs11")
    import nt12 as N
    from labels_v2 import simulate, POLICY
    rows = []
    for inst in N.INSTS:
        m1, _ = N.load_m1c(inst); H1 = N.h1(inst, m1)
        B5 = N.frame(inst, m1, "M5", H1); thin, _ = N.thin_hours(B5)
        for g in ("M5", "M15"):
            B = B5 if g == "M5" else N.frame(inst, m1, g, H1); Bm = mid(B)
            for kind in ("flip", "impulse"):
                if kind == "flip":
                    i = np.where(B["flip"] != 0)[0]; s = B["flip"][i]
                else:
                    i, s = N.impulses(B)
                good = np.isfinite(B["atr"][i]) & (B["atr"][i] > 0)
                i, s = i[good], s[good]
                sn = simulate(B, i, s, B["atr"][i], B["flip"], POLICY); sg = simulate(Bm, i, s, B["atr"][i], B["flip"], POLICY)
                ok = sn["ok"] & sg["ok"]
                filt = ok & ~(B["spr"][i] > N.SPR_R) & ~np.isin((B["c"][i] % 1440) // 60, thin)
                rows.append(frame("notrade12", f"{g}_{kind}_all", inst, B["day"][i][ok], sg["net_R"][ok], sn["net_R"][ok]))
                rows.append(frame("limit13", f"{g}_{kind}_mkt_filtered", inst, B["day"][i][filt], sg["net_R"][filt], sn["net_R"][filt]))
        print(inst, flush=True)
    return pd.concat(rows, ignore_index=True)


# ------------------------------------------------------------------ evaluator-v2 entry populations (ladder A, de_v2 D, bench1, ablate4, risk8)
def dev2():
    import de_v2 as de
    fz = json.load(open(os.path.join(ENG, "frozen_de.json")))
    rows = []
    for inst in ("WTICO/USD", "XAU/USD"):
        m1, B, O, L = de.prep(inst, None)
        Bm = mid(B); Om = de.outcomes(Bm)
        cfg = fz[inst]["d_cfg"]; cfg = ((cfg[0][0], cfg[0][1]), cfg[1], cfg[2])
        GS = de.gate_states(B, L, fz[inst]["gate"])
        sets = {"flipsA_spr02 (ladder A, risk8 flipsA)": np.where((B["flip"] != 0) & (B["spr"] <= de.SPR_MAX))[0],
                "cfgX none|h1|12 (bench1 cfgX, ablate4 P2, risk8 cfgX)": de.run_d(B, O, None, (("none", None), "h1", 12))["entries"],
                f"D_frozen {cfg[0][0]}{cfg[0][1]}|{cfg[1]}|{cfg[2]} (de_v2 D, bench1 frozenD, ablate4 P1)": de.run_d(B, O, GS, cfg)["entries"]}
        for nm, i in sets.items():
            Tn = de.trades(B, O, i); Tg = de.trades(B, Om, i)
            if nm.startswith("flipsA"):
                Tn = {**Tn, "net": np.array([O[False][s]["net_R"][j] for j, s in zip(i, B["flip"][i])])}
                Tg = {**Tg, "net": np.array([Om[False][s]["net_R"][j] for j, s in zip(i, B["flip"][i])])}
            ok = np.isfinite(Tn["net"]) & np.isfinite(Tg["net"])
            rows.append(frame("dev2", nm, inst, Tn["day"][ok], Tg["net"][ok], Tn["net"][ok]))
            print(inst, nm, int(ok.sum()), flush=True)
    return pd.concat(rows, ignore_index=True)


if __name__ == "__main__":
    nm = sys.argv[1]
    R = globals()[nm]()
    R.to_pickle(os.path.join(OUT, f"tr_{nm}.pkl"))
    print(nm, len(R), R.groupby("win").size().to_dict(), R.variant.nunique(), flush=True)
