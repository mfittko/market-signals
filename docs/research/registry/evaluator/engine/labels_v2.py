"""Path labels and net R under one frozen management policy, with bid/ask fills.

Policy (all levels from the entry fill, R = k x ATR at the signal bar, R stays the denominator):
  entry   at the open of the bar after the signal bar; long at the ask, short at the bid
  stop0   entry - R (exit side: long bid, short ask)
  arm     entry + m R  -> armed; the managed stop moves to breakeven-plus-costs = the entry fill
          price on the exit side (long: bid back to the entry ask nets 0 after the spread).
          The move takes effect from the NEXT bar (one-bar modification latency).
  target  entry + T R (the runner target)
  flip    an opposite supertrend flip at bar f exits at the open of bar f+1
  time    still open after H bars -> exit at the close of bar e+H-1
Bar resolution: fills.resolve (gap first, then stop before target when both touch).
Labels: arm = reached +mR before the stop within H (p_arm); runner = armed and reached T R
before the managed stop (p_runner = runner / arm); net_R = realized R.
`optimistic=True` resolves both-touched bars in favour of the favourable level (upper path bound), using only
admissible orders: a bar that touches the arm level AND stop0 (no gap) can end only at stop0 (the breakeven move is
effective from the next bar), or at the runner target if the high also reached it.
Evaluator v2 (correction D1): v1 treated such a bar as armed and alive, an impossible path (audit fixture F8).
Run `python labels_v2.py` for the self-check.
"""
import numpy as np
from fills import resolve, STOP, TARGET

FLIP, TIME = 3, 4
POLICY = dict(k=1.5, m=1.0, T=3.0, H=72)  # frozen before any data was scored


def simulate(B, i, side, atr, flip, P=POLICY, optimistic=False):
    i = np.asarray(i, np.int64); s = np.asarray(side, np.int64); n = len(B["bid_o"])
    N = len(i)
    e = i + 1
    lo = s > 0
    ec = np.clip(e, 0, n - 1)

    def bar(b):
        return (np.where(lo, B["bid_o"][b], -B["ask_o"][b]), np.where(lo, B["bid_h"][b], -B["ask_l"][b]),
                np.where(lo, B["bid_l"][b], -B["ask_h"][b]), np.where(lo, B["bid_c"][b], -B["ask_c"][b]))

    entry = np.where(lo, B["ask_o"][ec], -B["bid_o"][ec])
    R = P["k"] * np.asarray(atr, float)
    stop0, arm, tgt, be = entry - R, entry + P["m"] * R, entry + P["T"] * R, entry
    alive = (e < n) & np.isfinite(R) & (R > 0)
    cens = ~alive.copy()
    armed = np.zeros(N, bool); amb = np.zeros(N, bool)
    reason = np.zeros(N, np.int8); xp = np.full(N, np.nan); xb = np.full(N, -1); armbar = np.full(N, -1)

    def close(mask, price, why, j):
        xp[mask] = price[mask]; reason[mask] = why; xb[mask] = e[mask] + j; alive[mask] = False

    for j in range(P["H"]):
        b = e + j
        out = alive & (b >= n)
        cens |= out; alive &= ~out
        bc = np.clip(b, 0, n - 1)
        o, h, l, c = bar(bc)
        if j >= 1:
            close(alive & (flip[bc - 1] == -s), o, FLIP, j)
        # already armed before this bar: managed stop at breakeven-plus-costs
        a1 = alive & armed
        r, p, am = resolve(o, h, l, be, tgt)
        if optimistic:
            r = np.where(am, TARGET, r); p = np.where(am, tgt, p)
        amb |= a1 & am
        close(a1 & (r == STOP), p, STOP, j); close(a1 & (r == TARGET), p, TARGET, j)
        # not armed yet: the upper barrier is the arm level
        a0 = alive & ~armed
        r, p, am = resolve(o, h, l, stop0, arm)
        if optimistic:  # favourable admissible order: arm first, then the target if reached, else stop0 still fires
            armed |= a0 & am
            r = np.where(am & (h >= tgt), TARGET, r)
        amb |= a0 & am
        close(a0 & (r == STOP), p, STOP, j)
        newly = a0 & (r == TARGET)
        armed |= newly; armbar[newly] = j
        gap = newly & (o >= arm)  # armed at the open: stop0 still active inside this bar
        r2, p2, am2 = resolve(o, h, l, stop0, tgt)
        if optimistic:
            r2 = np.where(am2, TARGET, r2); p2 = np.where(am2, tgt, p2)
        amb |= gap & am2
        close(gap & (r2 == STOP), p2, STOP, j); close(gap & (r2 == TARGET), p2, TARGET, j)
        intra = newly & ~gap & alive & (h >= tgt)  # armed intrabar with no stop touch, then the target
        close(intra, tgt, TARGET, j)
        if j == P["H"] - 1:
            close(alive.copy(), c, TIME, j)
    net = (xp - entry) / R
    return dict(entry=entry, R=R, arm=armed, runner=armed & (reason == TARGET), reason=reason, exit_bar=xb,
                arm_bar=armbar, net_R=net, amb=amb, censored=cens, ok=~cens & np.isfinite(net))


def _selfcheck():
    def mk(rows, spread=0.0):
        a = np.array(rows, float)  # bid o h l c
        return {"bid_o": a[:, 0], "bid_h": a[:, 1], "bid_l": a[:, 2], "bid_c": a[:, 3],
                "ask_o": a[:, 0] + spread, "ask_h": a[:, 1] + spread, "ask_l": a[:, 2] + spread, "ask_c": a[:, 3] + spread}
    P = dict(k=1.0, m=1.0, T=3.0, H=5)
    nof = np.zeros(10, int)
    one = lambda B, side=1, flip=nof, P=P, **kw: {k: v[0] for k, v in simulate(B, [0], [side], [1.0], flip, P, **kw).items()}
    # 1 straight to target (entry 100, R 1, arm 101, target 103)
    r = one(mk([[100] * 4, [100, 101.5, 99.5, 101], [101, 103.5, 100.5, 103]]))
    assert r["arm"] and r["runner"] and r["reason"] == TARGET and r["net_R"] == 3.0
    # 2 arm, then back to breakeven -> 0 R, managed stop
    r = one(mk([[100] * 4, [100, 101.2, 99.5, 101], [100.5, 100.8, 99.8, 100]]))
    assert r["arm"] and not r["runner"] and r["reason"] == STOP and r["net_R"] == 0.0
    # 3 spread: entry at the ask 100.2, stop on the bid at 99.2 -> exactly -1 R
    r = one(mk([[100] * 4, [100, 100.1, 99.0, 99.5]], spread=0.2))
    assert r["reason"] == STOP and abs(r["net_R"] + 1) < 1e-12 and abs(r["entry"] - 100.2) < 1e-12
    # 4 arm and stop0 in one bar, no gap -> stop, ambiguous; optimistic bound arms instead
    B = mk([[100] * 4, [100, 101.5, 98.5, 100], [100, 100.2, 99.9, 100], [100] * 4, [100] * 4, [100] * 4, [100] * 4])
    r = one(B); assert r["amb"] and not r["arm"] and r["net_R"] == -1
    r = one(B, optimistic=True); assert r["arm"] and r["reason"] == STOP and r["net_R"] == -1.0  # D1: stop0 still active
    # 4b same bar with the high at the runner target: the optimistic bound takes the target (+3R)
    r = one(mk([[100] * 4, [100, 103.5, 98.5, 100]] + [[100] * 4] * 5), optimistic=True)
    assert r["runner"] and r["reason"] == TARGET and r["net_R"] == 3.0
    # 5 opposite flip at bar 2 (the bar after entry) -> exit at the open of bar 3
    B = mk([[100] * 4, [100, 100.5, 99.5, 100], [100, 100.5, 99.5, 100.2], [100.4, 100.6, 100.3, 100.5]] + [[100] * 4] * 3)
    fl = nof.copy(); fl[2] = -1
    r = one(B, flip=fl); assert r["reason"] == FLIP and abs(r["net_R"] - 0.4) < 1e-12
    # 6 time stop after H bars at the close
    B = mk([[100] * 4] + [[100, 100.5, 99.5, 100.3]] * 6)
    r = one(B); assert r["reason"] == TIME and abs(r["net_R"] - 0.3) < 1e-12 and r["exit_bar"] == 5
    # 7 short mirrored: entry at the bid 100, stop on the ask at 101, target 97
    r = one(mk([[100] * 4, [100, 100.5, 98.5, 99], [99, 99.5, 96.5, 97]], spread=0.0), side=-1)
    assert r["arm"] and r["reason"] == TARGET and r["net_R"] == 3.0
    # 8 censored: data ends before the exit
    r = one(mk([[100] * 4, [100, 100.5, 99.5, 100]])); assert r["censored"] and not r["ok"]
    # 9 gap-arm: opens above the arm level, then trades to stop0 in the same bar -> stop0 (latency), armed
    r = one(mk([[100] * 4, [100, 100.5, 99.5, 100], [101.2, 101.4, 98.9, 99], [99] * 4]))
    assert r["arm"] and r["reason"] == STOP and r["net_R"] == -1.0
    # 10 gap through the stop -> fill at the open (worse than -1 R)
    r = one(mk([[100] * 4, [100, 100.2, 99.8, 100], [98.5, 98.7, 98.2, 98.4]])); assert r["reason"] == STOP and r["net_R"] == -1.5
    # 11 entry bar itself counts: a stop touch in the entry bar exits there
    r = one(mk([[100] * 4, [100, 100.2, 98.9, 99.5]])); assert r["exit_bar"] == 1
    print("labels_v2 self-check OK: 12 synthetic paths (target, breakeven, spread, ambiguity + optimistic bound, flip, "
          "time, short, censoring, gap-arm latency, stop gap, entry bar)")


if __name__ == "__main__":
    _selfcheck()
