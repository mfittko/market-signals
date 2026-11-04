"""trend49 amendment, written AFTER seeing the registered run. Descriptive, hindsight-selected episodes, not a test.

Why: the registered episode metric divides by the start-to-end move of the operator's window. For the two NATGAS spikes
the window starts and ends near the same price (2025-10..2026-02: move 0.0%, ratio undefined; 2022-06..09: the window
first falls 34%, so the extreme found is the trough, not the spike). For falls the registered ratio has the wrong sign
for reading (a long that loses the whole fall shows +100%).
Amendment: (1) capture = rule log P&L / |B&H log move|, positive = profit. (2) The leg: for a rally or spike, the
highest close in the window and the lowest close before it inside the window; for a fall, the lowest close and the
highest close before it. Capture over the leg, and giveback from the leg extreme to extreme + 126 bars as share of |leg|.
trend49.py is imported unchanged.

  python trend49_amend.py      out/episodes_amended.json, out/episodes_amended.md
"""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trend49 as E  # noqa: E402

ENG = E.ENG


def leg(f, f_bh, start, end, up):
    x = f_bh.loc[start:end]
    lc = np.log(x["c"].values)
    k1 = int(np.argmax(lc)) if up else int(np.argmin(lc))
    k0 = int(np.argmin(lc[:k1 + 1])) if up else int(np.argmax(lc[:k1 + 1]))
    d0, d1 = x.index[k0], x.index[k1]
    mv = lc[k1] - lc[k0]
    ip = f.index.get_loc(d1)
    after = f.index[ip + 1: ip + 1 + E.POST_PEAK_BARS]
    o = {"leg_start": str(d0.date()), "leg_end": str(d1.date()), "leg_move_pct": float(np.exp(mv) - 1), "post_bars": len(after),
         "bh_after_pct": float(f_bh["c"].loc[after].iloc[-1] / x["c"].iloc[k1] - 1) if len(after) else None}
    for k in E.COSTS:
        lr = np.log1p(f[k])
        o[k] = {"leg_capture": float(lr.loc[f.index[f.index.get_loc(d0) + 1]:d1].sum() / abs(mv)),
                "giveback": float(-lr.loc[after].sum() / abs(mv)) if len(after) >= 20 else None}
    return o


def main():
    res = {}
    for name, inst, a, b in E.EPISODES:
        d = E.load(inst)
        side = E.T.spreads_bps()[inst]["median_spread_bps"] / 2 / 1e4
        frames = {r: E.sim(d, r, side) for r in E.RULES}
        x = frames["BH"].loc[a:b]
        i0 = frames["BH"].index.get_loc(x.index[0])
        move = float(np.log(x["c"].iloc[-1] / frames["BH"]["c"].iloc[i0 - 1]))
        up = "fall" not in name
        res[name] = {"inst": inst, "window_move_pct": float(np.exp(move) - 1)}
        for r, f in frames.items():
            lr = {k: float(np.log1p(f[k]).loc[x.index].sum()) for k in E.COSTS}
            res[name][r] = {"window_pnl_pct": {k: float(np.exp(v) - 1) for k, v in lr.items()},
                            "window_capture_abs": {k: (v / abs(move) if abs(move) > 0.05 else None) for k, v in lr.items()},
                            **leg(f, frames["BH"], a, b, up)}
    json.dump(res, open(os.path.join(E.OUT, "episodes_amended.json"), "w"), indent=1)
    L = ["| episode | leg (B&H) | rule | leg capture gross / CFD / fut | window P&L CFD (B&H window move) | giveback after leg extreme, CFD (B&H move after) |",
         "|---|---|---|---|---|---|"]
    f1 = lambda v: "n/a" if v is None else f"{100 * v:.0f}%"
    for name, e in res.items():
        for r in E.RULES:
            o = e[r]
            gb = "n/a (< 20 bars)" if o["cfd"]["giveback"] is None else f"{f1(o['cfd']['giveback'])} ({100 * o['bh_after_pct']:+.0f}%, {o['post_bars']} bars)"
            L.append(f"| {name} | {o['leg_start']} to {o['leg_end']}, {100 * o['leg_move_pct']:+.0f}% | {r} | "
                     f"{f1(o['gross']['leg_capture'])} / {f1(o['cfd']['leg_capture'])} / {f1(o['fut']['leg_capture'])} | "
                     f"{100 * o['window_pnl_pct']['cfd']:+.0f}% ({100 * e['window_move_pct']:+.0f}%) | {gb} |")
    open(os.path.join(E.OUT, "episodes_amended.md"), "w").write("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
