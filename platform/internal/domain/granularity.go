package domain

import (
	"fmt"
	"regexp"
	"strconv"
	"time"
)

// M<n> is n minutes and H<n> is n hours, n is 1 to 99 with no leading zero. This rule is stricter
// than the engine regex /^[MH]\d{1,2}$/ in scripts/strategies.mjs, which also accepts M0, M05 and H00.
var granularityShape = regexp.MustCompile(`^([MH])([1-9][0-9]?)$`)

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

// PredictionGranularity reports whether the engine's prediction endpoint accepts g. The set mirrors
// GRAN_WORDS in scripts/jev.mjs, less D, which GranularityDuration refuses.
func PredictionGranularity(g string) bool {
	switch g {
	case "M1", "M5", "M15", "M30", "H1", "H4":
		return true
	}
	return false
}
