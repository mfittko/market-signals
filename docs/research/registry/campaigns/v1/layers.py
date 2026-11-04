"""Evaluator audit v1, item 5: D on WTICO/USD split into three layers (development diagnostic, no verdict, no ledger).

  L1 market-path predictability: mid prices, zero spread, no management: P(+1R before -1R within 72 bars) and the
     signed mid drift after 12 and 72 bars, in R units (R = 1.5 x ATR at the decision bar).
  L2 conversion by the frozen management policy: the 308 policy (breakeven after +1R, 3R target, flip exit, 72 bars) on
     mid prices with zero spread (gross R).
  L3 net execution economics: the same policy with bid/ask fills (the published net R). L2 - L3 = executable cost.
Each layer is reported for the frozen D entries, D-nogate, A (every flip) and execution-matched same-time-of-day null
entries (same side, policy, horizon; 200 draws), on dev 2019-2022 (the D configuration is in-sample there) and on the
already-scored test window 2023+.
Dependence: row and episode counts, lag-1 autocorrelation of net R in entry order, within-day intraclass correlation,
overlap share, and the moving-block bootstrap CI half-width for block lengths 1..40 trading days with the implied
effective number of independent trades.

  python layers.py      writes out/layers.json and out/layers.md
"""
import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.environ["ENGINE_TRIALS"] = os.path.join(OUT, "diag_trials.jsonl")
ENGINE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ENGINE)
import numpy as np
import de
from labels import simulate, POLICY
from nulls import BarIndex
from validate import year_start_day, day_boot, ci

INST = "WTICO/USD"
BLOCKS = [1, 2, 5, 10, 20, 40]


def midbars(B):
    Z = dict(B)
    for k in "ohlc":
        Z["bid_" + k] = B["mid_" + k]; Z["ask_" + k] = B["mid_" + k]
    return Z


def layer_vals(B, Z, i, s):
    n = len(B["t"]); nof = np.zeros(n, int)
    fp = simulate(Z, i, s, B["atr"][i], nof, dict(POLICY, T=1.0))  # symmetric first passage +1R / -1R, no flip exit
    R = POLICY["k"] * B["atr"][i]
    e = np.clip(i + 1, 0, n - 1)
    d12 = s * (B["mid_c"][np.clip(i + 12, 0, n - 1)] - B["mid_o"][e]) / R
    d72 = s * (B["mid_c"][np.clip(i + 72, 0, n - 1)] - B["mid_o"][e]) / R
    g = simulate(Z, i, s, B["atr"][i], B["flip"], POLICY)
    net = simulate(B, i, s, B["atr"][i], B["flip"], POLICY)
    ok = fp["ok"] & g["ok"] & net["ok"]
    return dict(up_first=np.where(fp["ok"], fp["net_R"] > 0, False).astype(float), d12=d12, d72=d72, gross=g["net_R"], net=net["net_R"],
                exit_bar=net["exit_bar"], ok=ok)


def dependence(T, day, exit_bar, all_days):
    net = T["net"]; n = len(net)
    order = np.argsort(T["i"], kind="stable"); x = net[order]
    ac1 = float(np.corrcoef(x[:-1], x[1:])[0, 1]) if n > 3 else float("nan")
    # one-way ICC within trading days
    u, inv, cnt = np.unique(day, return_inverse=True, return_counts=True)
    gm = np.bincount(inv, net) / cnt
    k0 = (n - (cnt ** 2).sum() / n) / max(1, len(u) - 1)
    msb = (cnt * (gm - net.mean()) ** 2).sum() / max(1, len(u) - 1)
    msw = ((net - gm[inv]) ** 2).sum() / max(1, n - len(u))
    icc = float((msb - msw) / (msb + (k0 - 1) * msw)) if msb + (k0 - 1) * msw > 0 else float("nan")
    ii = T["i"][order]; xb = exit_bar[order]
    overlap = float(np.mean(ii[1:] < np.maximum.accumulate(xb)[:-1])) if n > 1 else 0.0
    se_iid = net.std(ddof=1) / np.sqrt(n)
    blk = {}
    for b in BLOCKS:
        bs = day_boot(day, all_days, lambda ix: net[ix].mean(), 1000, block=b, seed=5)
        lo, hi = ci(bs)
        se = np.std(bs, ddof=1)
        blk[b] = dict(ci=[lo, hi], half_width=(hi - lo) / 2, n_eff=float(n * (se_iid / se) ** 2) if se > 0 else float("nan"))
    return dict(rows=n, days_with_trades=int(len(u)), max_per_day=int(cnt.max()), lag1_autocorr=ac1, icc_within_day=icc,
                overlap_share=overlap, se_iid=float(se_iid), blocks=blk)


def run(window):
    fz = json.load(open(de.FROZEN))[INST]
    m1, B, O, L = de.prep(INST, de.DEV_END if window == "dev" else None)
    GS = de.gate_states(B, L, fz["gate"])
    Z = midbars(B)
    lo, hi = (year_start_day(2019), year_start_day(2023)) if window == "dev" else (year_start_day(2023), int(B["day"][-1]) + 1)
    _, _, all_days = de.window_bars(B, lo, hi)
    X = BarIndex(B["t"]); rng = np.random.default_rng(91)
    cfg = de.as_cfg(fz["d_cfg"])
    sets = {}
    RD = de.run_d(B, O, GS, cfg)
    sets["D"] = (RD["entries"], RD)
    RN = de.run_d(B, O, GS, (("none", None), cfg[1], cfg[2]))
    sets["D_nogate"] = (RN["entries"], RN)
    fi = np.where(B["flip"] != 0)[0]
    sets["A"] = (fi, None)
    out = {}
    for name, (idx, R) in sets.items():
        s = B["flip"][idx] if name == "A" else B["trend"][idx]
        V = layer_vals(B, Z, idx, s)
        m = V["ok"] & (B["day"][idx] >= lo) & (B["day"][idx] < hi)
        i, s = idx[m], s[m]; day = B["day"][i]
        Vm = {k: v[m] for k, v in V.items()}
        res = dict(trades=int(m.sum()))
        if R is not None:
            recs = [r for r in R["recs"] if lo <= B["day"][r["disc"]] < hi]
            res["episodes"] = len(recs); res["episodes_entered"] = sum(r["entry"] >= 0 for r in recs)
        for k in ("up_first", "d12", "d72", "gross", "net"):
            x = Vm[k]
            res[k] = dict(mean=float(np.mean(x)), ci=ci(day_boot(day, all_days, lambda ix: x[ix].mean(), 1000)))
        res["cost_per_trade"] = float(np.mean(Vm["gross"] - Vm["net"]))
        # execution-matched same-time-of-day null: same sides, same policy and horizon, 200 donor draws
        nl = {k: [] for k in ("up_first", "d12", "gross", "net")}
        for _ in range(200):
            j = X.same_tod(i, rng)
            okj = j >= 0
            W = layer_vals(B, Z, j[okj], s[okj])
            for k in nl:
                nl[k].append(float(np.mean(W[k][W["ok"]])))
        res["null_tod"] = {k: dict(mean=float(np.mean(v)), sd=float(np.std(v))) for k, v in nl.items()}
        res["minus_null"] = {k: res[k]["mean"] - res["null_tod"][k]["mean"] for k in nl}
        res["dependence"] = dependence(dict(i=i, net=Vm["net"]), day, Vm["exit_bar"], all_days)
        out[name] = res
    return out


def main():
    res = {"dev 2019-2022 (D cfg in-sample)": run("dev"), "test 2023+ (diagnostic)": run("test")}
    json.dump(res, open(os.path.join(OUT, "layers.json"), "w"), indent=1, default=float)
    c = lambda v: f"[{v[0]:+.3f}, {v[1]:+.3f}]"
    md = []
    for w, R in res.items():
        md += [f"### {w}", "", "| Set | Trades | Episodes (entered) | L1 P(+1R first) [CI] (null) | L1 drift 12 bars R (null) | L2 gross policy R [CI] (null) | L3 net R [CI] (null) | cost/trade R |",
               "|" + "---|" * 8]
        for name, r in R.items():
            md.append(f"| {name} | {r['trades']} | {r.get('episodes', '-')} ({r.get('episodes_entered', '-')}) | {r['up_first']['mean']:.3f} {c(r['up_first']['ci'])} ({r['null_tod']['up_first']['mean']:.3f}) | "
                      f"{r['d12']['mean']:+.3f} ({r['null_tod']['d12']['mean']:+.3f}) | {r['gross']['mean']:+.3f} {c(r['gross']['ci'])} ({r['null_tod']['gross']['mean']:+.3f}) | "
                      f"{r['net']['mean']:+.3f} {c(r['net']['ci'])} ({r['null_tod']['net']['mean']:+.3f}) | {r['cost_per_trade']:.3f} |")
        md += ["", "| Set | lag-1 autocorr | ICC within day | overlap share | days | max/day | " + " | ".join(f"block {b}: half-width, n_eff" for b in BLOCKS) + " |",
               "|" + "---|" * (6 + len(BLOCKS))]
        for name, r in R.items():
            d = r["dependence"]
            md.append(f"| {name} | {d['lag1_autocorr']:+.3f} | {d['icc_within_day']:+.3f} | {d['overlap_share']:.3f} | {d['days_with_trades']} | {d['max_per_day']} | " +
                      " | ".join(f"{d['blocks'][b]['half_width']:.3f}, {d['blocks'][b]['n_eff']:.0f}" for b in BLOCKS) + " |")
        md.append("")
    open(os.path.join(OUT, "layers.md"), "w").write("\n".join(md) + "\n")
    print("\n".join(md))


if __name__ == "__main__":
    main()
