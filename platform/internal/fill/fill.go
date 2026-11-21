// Package fill decides whether one bar closes a position at its stop or target,
// and at which price. The rules are in docs/fill-spec.md.
package fill

// Check returns the exit price and reason ("stop" or "target") for one bar, or
// reason "" when the bar touches neither level. A nil target means no target.
// Order: a gap through the stop at the open, a gap through the target at the open
// (both fill at the open), the stop touched intrabar, the target touched intrabar.
// So when both levels trade inside the bar without a gap, the stop wins.
func Check(long bool, stop float64, target *float64, open, high, low float64) (float64, string) {
	hasTarget := target != nil
	var tgt float64
	if hasTarget {
		tgt = *target
	}
	if long {
		switch {
		case open <= stop:
			return open, "stop"
		case hasTarget && open >= tgt:
			return open, "target"
		case low <= stop:
			return stop, "stop"
		case hasTarget && high >= tgt:
			return tgt, "target"
		}
		return 0, ""
	}
	switch {
	case open >= stop:
		return open, "stop"
	case hasTarget && open <= tgt:
		return open, "target"
	case high >= stop:
		return stop, "stop"
	case hasTarget && low <= tgt:
		return tgt, "target"
	}
	return 0, ""
}
