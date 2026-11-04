"""Evaluator audit v1, item 3: accounting and ordering falsification fixtures, plus an independent scalar reference
simulator (`ref_one`) of the 308 management policy used to cross-check labels.simulate on real trades.

  python fixtures.py      run all fixtures; prints PASS/FAIL per fixture and exits non-zero on an unexpected result

Modes of ref_one for a bar where both barriers are touched without a gap (intrabar order unknown):
  pess     stop first (the harness convention, labels.simulate default)
  hopt     replicates labels.simulate(optimistic=True) exactly (for the equality check only)
  adm      admissible favourable order: the target/milestone first, but an active stop that the bar touched still fires
           (a stop modification is effective from the NEXT bar, so a bar that arms AND touches stop0 can only end at
           stop0, or at the runner target if the high reached it)
  m1       resolve each ambiguous M5 bar by walking its M1 sub-bars (same rules, one-M5-bar modification latency kept);
           a sub-bar that is still ambiguous falls back to pess
"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))
import numpy as np
from labels import simulate, POLICY, FLIP, TIME
from fills import STOP, TARGET, NONE


def _res(o, h, l, stop, tgt):
    if o <= stop:
        return STOP, o, False
    if o >= tgt:
        return TARGET, o, False
    if l <= stop:
        return STOP, stop, h >= tgt
    if h >= tgt:
        return TARGET, tgt, False
    return NONE, np.nan, False


def _lsbar(B, b, s):
    if s > 0:
        return B["bid_o"][b], B["bid_h"][b], B["bid_l"][b], B["bid_c"][b]
    return -B["ask_o"][b], -B["ask_l"][b], -B["ask_h"][b], -B["ask_c"][b]


def _subbars(M1, first, b, s):
    a, z = first[b], (first[b + 1] if b + 1 < len(first) else len(M1["t"]))
    return [_lsbar(M1, k, s) for k in range(a, z)]


def ref_one(B, i, s, atr, flip, P=POLICY, mode="pess", M1=None, first=None):
    """One trade, scalar. Returns dict(net_R, reason, exit_bar, arm, amb, censored, m1_resolved, m1_residual)."""
    n = len(B["bid_o"]); e = i + 1
    R = P["k"] * atr
    out = dict(net_R=np.nan, reason=0, exit_bar=-1, arm=False, amb=False, censored=True, m1_resolved=False, m1_residual=False)
    if e >= n or not np.isfinite(R) or R <= 0:
        return out
    entry = B["ask_o"][e] if s > 0 else -B["bid_o"][e]
    stop0, arm, tgt, be = entry - R, entry + P["m"] * R, entry + P["T"] * R, entry
    armed = False

    def done(price, why, j):
        out.update(net_R=(price - entry) / R, reason=why, exit_bar=e + j, arm=armed, censored=False)
        return out

    for j in range(P["H"]):
        b = e + j
        if b >= n:
            return out
        o, h, l, c = _lsbar(B, b, s)
        if j >= 1 and flip[b - 1] == -s:
            return done(o, FLIP, j)
        if armed:
            r, p, am = _res(o, h, l, be, tgt)
            if am:
                out["amb"] = True
                if mode in ("hopt", "adm"):
                    r, p = TARGET, tgt
                elif mode == "m1":
                    r, p = _walk_armed(_subbars(M1, first, b, s), be, tgt, out)
            if r != NONE:
                return done(p, r, j)
        else:
            r, p, am = _res(o, h, l, stop0, arm)
            if am:
                out["amb"] = True
                if mode == "hopt":
                    r = TARGET  # the harness then treats the trade as armed and alive (see the defect fixture)
                elif mode == "adm":
                    return done(tgt, TARGET, j) if h >= tgt else done(stop0, STOP, j)
                elif mode == "m1":
                    rr, pp, arm_now = _walk_unarmed(_subbars(M1, first, b, s), stop0, arm, tgt, out)
                    if rr != NONE:
                        armed = arm_now or armed
                        return done(pp, rr, j)
                    armed = arm_now
                    if j == P["H"] - 1:
                        return done(c, TIME, j)
                    continue
            if r == STOP:
                return done(p, STOP, j)
            if r == TARGET:
                armed = True
                if o >= arm:  # armed at the open: stop0 stays active inside this bar
                    r2, p2, am2 = _res(o, h, l, stop0, tgt)
                    if am2:
                        out["amb"] = True
                        if mode in ("hopt", "adm"):
                            r2, p2 = TARGET, tgt
                        elif mode == "m1":
                            r2, p2 = _walk_armed(_subbars(M1, first, b, s), stop0, tgt, out)
                    if r2 != NONE:
                        return done(p2, r2, j)
                elif h >= tgt:
                    return done(tgt, TARGET, j)
        if j == P["H"] - 1:
            return done(c, TIME, j)
    return out


def _walk_armed(subs, stop, tgt, out):
    out["m1_resolved"] = True
    for o, h, l, c in subs:
        r, p, am = _res(o, h, l, stop, tgt)
        if am:
            out["m1_residual"] = True
        if r != NONE:
            return r, p
    return NONE, np.nan  # M1 extrema did not reach either level (M5 bar extrema came from the other side's quotes)


def _walk_unarmed(subs, stop0, arm, tgt, out):
    """Within one M5 bar: stop0 active throughout; the upper level is arm until touched, then the runner target."""
    out["m1_resolved"] = True
    armed = False
    for o, h, l, c in subs:
        if not armed:
            r, p, am = _res(o, h, l, stop0, arm)
            if am:
                out["m1_residual"] = True
            if r == STOP:
                return STOP, p, armed
            if r == TARGET:
                armed = True
                if o >= arm:
                    r2, p2, am2 = _res(o, h, l, stop0, tgt)
                    if am2:
                        out["m1_residual"] = True
                    if r2 != NONE:
                        return r2, p2, armed
                elif h >= tgt:
                    return TARGET, tgt, armed
        else:
            r, p, am = _res(o, h, l, stop0, tgt)
            if am:
                out["m1_residual"] = True
            if r != NONE:
                return r, p, armed
    return NONE, np.nan, armed


# ------------------------------------------------------------------ fixtures
def mk(bid_rows, spread):
    a = np.array(bid_rows, float)
    return {"bid_o": a[:, 0], "bid_h": a[:, 1], "bid_l": a[:, 2], "bid_c": a[:, 3],
            "ask_o": a[:, 0] + spread, "ask_h": a[:, 1] + spread, "ask_l": a[:, 2] + spread, "ask_c": a[:, 3] + spread}


def sim1(B, side, atr=1.0, P=dict(k=1.0, m=1.0, T=3.0, H=5), flip=None, optimistic=False, i=0):
    flip = np.zeros(len(B["bid_o"]), int) if flip is None else flip
    r = simulate(B, [i], [side], [atr], flip, P, optimistic=optimistic)
    return {k: (v[0] if hasattr(v, "__len__") else v) for k, v in r.items()}


RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


def fixtures():
    P = dict(k=1.0, m=1.0, T=3.0, H=3)
    # F1 elementary round trip: bid 100.00 / ask 100.10 fixed, unit size, no other fees -> exactly -0.10 per unit
    flat = mk([[100.0] * 4] * 6, 0.10)
    for side in (1, -1):
        r = sim1(flat, side, P=P)
        per_unit = r["net_R"] * r["R"]
        check(f"F1 round trip {'long' if side > 0 else 'short'} loses exactly 0.10/unit (not 0.20)",
              abs(per_unit + 0.10) < 1e-9 and r["reason"] == TIME, f"per-unit {per_unit:+.10f}, entry {r['entry'] * side:.2f}, R {r['R']}")
    # F1b the R denominator is applied once and separately: -0.10 / R with R = k * ATR = 2.0
    r = sim1(flat, 1, atr=2.0, P=P)
    check("F1b R denominator separate: net_R = -0.10 / 2.0", abs(r["net_R"] + 0.05) < 1e-9, f"net_R {r['net_R']:+.6f}")
    # F2 no fill before the decision: the decision bar 0 has a huge range and closes at 105; the entry is bar 1's ask open
    B = mk([[100, 110, 90, 105], [101, 101.5, 100.5, 101], [101] * 4, [101] * 4, [101] * 4], 0.10)
    r = sim1(B, 1, P=P)
    check("F2 entry at the next bar's executable open, never inside the decision bar",
          abs(r["entry"] - 101.10) < 1e-12 and r["exit_bar"] >= 1, f"entry {r['entry']:.2f}, exit_bar {r['exit_bar']}")
    # F2b a stop-level touch in the decision bar itself does not stop the trade (position does not exist yet)
    B = mk([[100, 100, 95, 100], [100, 100.4, 99.6, 100.2], [100.2] * 4, [100.2] * 4, [100.2] * 4], 0.0)
    r = sim1(B, 1, P=P)
    check("F2b decision-bar range cannot trigger the stop", r["reason"] == TIME and r["exit_bar"] == 3, f"reason {r['reason']}, exit {r['exit_bar']}")
    # F3 no retroactive stop modification: bar 1 arms (high 101.5) and later dips to 99.5 (< breakeven 100, > stop0 99);
    #    the breakeven stop is not yet effective in bar 1; bar 2 touches breakeven -> exit there at 0R
    B = mk([[100] * 4, [100, 101.5, 99.5, 100.6], [100.6, 100.8, 99.8, 100], [100] * 4, [100] * 4], 0.0)
    r = sim1(B, 1, P=P)
    check("F3 no retroactive modification: not stopped in the arming bar; breakeven fires from the next bar",
          r["arm"] and r["exit_bar"] == 2 and r["reason"] == STOP and abs(r["net_R"]) < 1e-12, f"exit_bar {r['exit_bar']}, net {r['net_R']:+.3f}")
    # F4 correct active stop while the modification is pending: armed at the open (gap), then trades to 98.9 < stop0
    B = mk([[100] * 4, [100, 100.5, 99.5, 100], [101.2, 101.4, 98.9, 99], [99] * 4], 0.0)
    r = sim1(B, 1, P=P)
    check("F4 pending modification: stop0 (not breakeven) is the active stop inside the arming bar",
          r["arm"] and r["reason"] == STOP and abs(r["net_R"] + 1) < 1e-12, f"net {r['net_R']:+.3f}")
    B = mk([[100] * 4, [100, 100.5, 99.5, 100], [101.2, 101.4, 99.5, 100.1], [100.2, 100.5, 99.9, 100.4], [100.4] * 4], 0.0)
    r = sim1(B, 1, P=P)
    check("F4b pending modification: a dip below breakeven but above stop0 in the arming bar does not exit",
          r["arm"] and r["exit_bar"] == 3 and abs(r["net_R"]) < 1e-12, f"exit_bar {r['exit_bar']}, net {r['net_R']:+.3f}")
    # F5 no favourable movement after an earlier stop
    B = mk([[100] * 4, [100, 100.5, 98.9, 99.2], [99.2, 104, 99, 103.9], [104] * 4], 0.0)
    r = sim1(B, 1, P=P)
    check("F5 stop in bar 1, later rally ignored", r["reason"] == STOP and r["exit_bar"] == 1 and abs(r["net_R"] + 1) < 1e-12
          and not r["runner"], f"net {r['net_R']:+.3f}")
    # F6 price breakeven vs net-of-cost breakeven (spread 0.10): the managed stop is the entry fill on the exit side
    for side in (1, -1):
        if side > 0:  # long: entry ask 100.10, arm on the bid at 101.10, then the bid returns to 100.05 (between price-BE 100.00 and net-BE 100.10)
            B = mk([[100] * 4, [100, 101.2, 99.8, 101], [101, 101, 100.05, 100.05], [100.05] * 4, [100.05] * 4], 0.10)
        else:  # short: entry bid 100.00, arm on the ask at 99.00 (bid 98.90), then the ask returns to 100.05 (bid 99.95)
            B = mk([[100] * 4, [100, 100.2, 98.85, 98.9], [98.9, 99.95, 98.9, 99.95], [99.95] * 4, [99.95] * 4], 0.10)
        r = sim1(B, side, P=P)
        xp = r["entry"] + r["net_R"] * r["R"]
        check(f"F6 {'long' if side > 0 else 'short'} breakeven is net of the spread: exit at the entry fill, 0R exactly",
              r["arm"] and r["reason"] == STOP and abs(r["net_R"]) < 1e-9, f"net {r['net_R']:+.6f}, exit {abs(xp):.2f}")
    # F7 losses beyond 1R from an adverse gap are kept against the planned risk
    B = mk([[100] * 4, [100, 100.2, 99.8, 100], [98.5, 98.7, 98.2, 98.4], [98.4] * 4], 0.0)
    r = sim1(B, 1, P=P)
    check("F7 gap through the stop: -1.5R kept", r["reason"] == STOP and abs(r["net_R"] + 1.5) < 1e-12, f"net {r['net_R']:+.3f}")
    # F8 (defect regression) admissible optimistic bound when one bar arms AND touches stop0 without reaching the target.
    #    With a one-bar modification latency, stop0 is active for the whole bar, so every intrabar ordering ends at -1R.
    #    labels.simulate(optimistic=True) treats the trade as armed and alive and later returns 0R: an inadmissible path.
    B = mk([[100] * 4, [100, 101.5, 98.5, 100], [100, 100.2, 99.9, 100], [100] * 4, [100] * 4, [100] * 4, [100] * 4], 0.0)
    Pq = dict(k=1.0, m=1.0, T=3.0, H=5)
    h = sim1(B, 1, P=Pq, optimistic=True)
    a = ref_one(B, 0, 1, 1.0, np.zeros(7, int), Pq, mode="adm")
    check("F8 admissible optimistic bound = -1R for arm+stop0 in one bar without target (reference)", abs(a["net_R"] + 1) < 1e-12,
          f"reference {a['net_R']:+.3f}")
    check("F8 labels.simulate(optimistic=True) meets the admissible bound", abs(h["net_R"] + 1) < 1e-12,
          f"harness {h['net_R']:+.3f}: CONFIRMED DEFECT, the optimistic bound includes an inadmissible path" if abs(h["net_R"] + 1) >= 1e-12 else "")
    # F9 both orders admissible when the high reached the runner target too: bound = +3R, pessimistic = -1R
    B = mk([[100] * 4, [100, 103.5, 98.5, 100], [100] * 4, [100] * 4, [100] * 4, [100] * 4, [100] * 4], 0.0)
    h = sim1(B, 1, P=Pq, optimistic=True); p = sim1(B, 1, P=Pq)
    check("F9 arm+target+stop0 in one bar: pessimistic -1R, optimistic +3R", abs(p["net_R"] + 1) < 1e-12 and abs(h["net_R"] - 3) < 1e-12,
          f"pess {p['net_R']:+.1f}, opt {h['net_R']:+.1f}")
    # F10 the reference simulator reproduces labels.simulate on the fixtures (pess and harness-optimistic)
    rng = np.random.default_rng(0)
    bad = 0
    for _ in range(3000):
        n = 12
        mid = 100 + np.cumsum(rng.normal(0, 0.6, n))
        o = mid + rng.normal(0, 0.3, n); c = mid + rng.normal(0, 0.3, n)
        hh = np.maximum(o, c) + rng.exponential(0.4, n); ll = np.minimum(o, c) - rng.exponential(0.4, n)
        B = mk(np.c_[o, hh, ll, c], rng.choice([0.0, 0.05, 0.2]))
        fl = rng.choice([0, 0, 0, 0, 1, -1], n)
        side = rng.choice([1, -1])
        Pr = dict(k=1.0, m=1.0, T=rng.choice([2.0, 3.0]), H=int(rng.integers(3, 10)))
        for opt, mode in ((False, "pess"), (True, "hopt")):
            v = simulate(B, [0], [side], [1.0], fl, Pr, optimistic=opt)
            rr = ref_one(B, 0, side, 1.0, fl, Pr, mode=mode)
            same = (v["censored"][0] == rr["censored"]) and (v["censored"][0] or (abs(v["net_R"][0] - rr["net_R"]) < 1e-12 and
                                                                                v["reason"][0] == rr["reason"] and v["exit_bar"][0] == rr["exit_bar"]))
            bad += not same
    check("F10 independent scalar reference == labels.simulate on 6000 random paths (pess + harness-optimistic)", bad == 0, f"mismatches {bad}")
    nfail = sum(not ok for n, ok, _ in RESULTS if not n.startswith("F8 labels.simulate"))
    return nfail


if __name__ == "__main__":
    nf = fixtures()
    print(f"{len(RESULTS)} checks, {sum(ok for _, ok, _ in RESULTS)} pass; unexpected failures: {nf}")
    sys.exit(1 if nf else 0)
