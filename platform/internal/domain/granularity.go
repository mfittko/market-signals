package domain

import (
	"fmt"
	"regexp"
	"strconv"
	"time"
)

// The engine's shapes: M<n> is n minutes and H<n> is n hours (scripts/supertrend.mjs granularityMs).
var granularityShape = regexp.MustCompile(`^([MH])([1-9][0-9]{0,3})$`)

// InstrumentShape is the engine's instrument symbol rule.
var InstrumentShape = regexp.MustCompile(`^[A-Za-z0-9/]{3,20}$`)

// GranularityDuration is the candle length of an engine granularity. Any other string is an error.
func GranularityDuration(g string) (time.Duration, error) {
	m := granularityShape.FindStringSubmatch(g)
	if m == nil {
		return 0, fmt.Errorf("granularity %q is not M<n> or H<n>", g)
	}
	n, _ := strconv.Atoi(m[2])
	if m[1] == "H" {
		return time.Duration(n) * time.Hour, nil
	}
	return time.Duration(n) * time.Minute, nil
}
