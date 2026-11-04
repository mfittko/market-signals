"""One-bar fill resolution with the conservative semantics of simulateFills (scripts/bot.mjs).

Everything is in "long semantics": the caller passes the exit-side bar of the position
(long: bid o/h/l; short: the ask bar negated, i.e. o=-ask_o, h=-ask_l, l=-ask_h) and the
stop/target levels negated the same way. Then stop < price < target for both sides.

Order inside one bar:
  1. open at or through the stop  -> stop, filled at the open (gap)
  2. open at or through the target -> target, filled at the open (gap)
  3. low touches the stop          -> stop at the level (also when the high touched the target: ambiguous, stop wins)
  4. high touches the target       -> target at the level
Vectorized over numpy arrays. Run `python fills.py` for the ported bot.test.mjs fixtures.
"""
import numpy as np

NONE, STOP, TARGET = 0, 1, 2


def resolve(o, h, l, stop, target):
    """Returns (reason, price, ambiguous). target may be +inf (none), stop may be -inf (none)."""
    o, h, l, stop, target = np.broadcast_arrays(*(np.asarray(x, float) for x in (o, h, l, stop, target)))
    gs = o <= stop
    gt = ~gs & (o >= target)
    st = ~gs & ~gt & (l <= stop)
    tt = ~gs & ~gt & ~st & (h >= target)
    reason = np.select([gs | st, gt | tt], [STOP, TARGET], NONE)
    price = np.select([gs | gt, st, tt], [o, stop, target], np.nan)
    amb = st & (h >= target)
    return reason, price, amb


def side_bar(side, bid_o, bid_h, bid_l, ask_o, ask_h, ask_l):
    """Exit-side bar in long semantics: long exits on the bid, short on the ask (negated)."""
    if side > 0:
        return bid_o, bid_h, bid_l
    return -ask_o, -ask_l, -ask_h


def _selfcheck():
    def fill(side, stop, target, o, h, l):
        """bot.test.mjs passes one mid candle; use it as both bid and ask (zero spread) like the fixture."""
        so, sh, sl = side_bar(side, o, h, l, o, h, l)
        s = side
        r, p, a = resolve(so, sh, sl, s * stop if stop is not None else -np.inf, s * target if target is not None else np.inf)
        return int(r), float(p) * s, bool(a)
    # long 87, stop 86.5, target 88: candle dips through the stop intraday -> stop at the level
    assert fill(1, 86.5, 88, 86.9, 87.0, 86.3) == (STOP, 86.5, False)
    # gap-through: opens beyond the stop -> fill at the open
    assert fill(1, 86.5, None, 85.9, 86.2, 85.5) == (STOP, 85.9, False)
    # both touched with a gap above the target: target at the open beats a later stop touch
    assert fill(1, 95, 105, 106, 107, 94) == (TARGET, 106, False)
    # intrabar both touched, no gap: stop (pessimistic), flagged ambiguous
    assert fill(1, 95, 105, 100, 106, 94) == (STOP, 95, True)
    # short target, price gaps down through it -> open fill
    assert fill(-1, None, 86, 85.8, 86.1, 85.6) == (TARGET, 85.8, False)
    # short stop intrabar, and short both-touched ambiguity
    assert fill(-1, 88, 86, 87, 88.2, 86.9) == (STOP, 88, False)
    assert fill(-1, 88, 86, 87, 88.2, 85.9) == (STOP, 88, True)
    # nothing touched
    assert fill(1, 95, 105, 100, 104, 96)[0] == NONE
    # bid/ask: a long's stop is checked on the bid; an ask-only dip does not stop it
    r, p, a = resolve(*side_bar(1, 100, 101, 99.6, 100.2, 101.2, 99.4)[0:3], 99.5, np.inf)
    assert int(r) == NONE
    r, p, a = resolve(*side_bar(-1, 100, 101, 99.6, 100.2, 101.2, 99.4), -101.1, np.inf)
    assert int(r) == STOP and -float(p) == 101.1, "short stop is checked on the ask high"
    print("fills self-check OK: 5 ported bot.test.mjs fixtures + 5 extra (short stop, short ambiguity, no touch, bid/ask sides)")


if __name__ == "__main__":
    _selfcheck()
