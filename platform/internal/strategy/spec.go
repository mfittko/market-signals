// Package strategy holds the Go strategy store rules: spec validation, the mirror of
// the engine strategies, and per-combo strategy resolution.
package strategy

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"regexp"
	"slices"
	"strings"
)

// ErrInvalidSpec wraps every spec validation error.
var ErrInvalidSpec = errors.New("invalid strategy spec")

// The rules port validateSpec in scripts/strategy-spec.mjs. Go also rejects unknown fields.
var (
	axisVerdicts = map[string][]string{
		"trendStrength": {"trending", "ranging", "neutral"},
		"direction":     {"aligned", "counter", "mixed"},
		"impulse":       {"impulsive", "thin", "neutral"},
		"location":      {"aligned", "counter"},
		"exhaustion":    {"veto", "clear"},
	}
	specFields = map[string][]string{
		"spec":       {"schema_version", "entry", "exit", "risk"},
		"spec.entry": {"minAxesAligned", "require", "enforceExhaustionVeto"},
		"spec.exit":  {"stopAtr", "targetAtr", "timeStopBars"},
		"spec.risk":  {"riskPct"},
	}
	dateRe   = regexp.MustCompile(`\d{4}-\d{2}-\d{2}|\d{2}[./]\d{2}[./]\d{2,4}`)
	symbolRe = regexp.MustCompile(`(?i)[A-Z]{3,6}/[A-Z]{3,6}|WTICO|SPX500|XAU|BTC`)
)

// ValidateSpec checks a declarative strategy spec. The error lists every problem and names each field path.
// It also rejects a non-object `risk`, which the engine validator ignores.
func ValidateSpec(raw json.RawMessage) error {
	_, err := NormalizeSpec(raw)
	return err
}

// NormalizeSpec validates raw like ValidateSpec and returns the validated value re-encoded.
// Store these bytes, never raw: the decoder keeps the last of duplicate keys and turns a lone
// surrogate or invalid UTF-8 into U+FFFD, so raw can hold a value that was never checked and
// that Postgres jsonb rejects.
func NormalizeSpec(raw json.RawMessage) (json.RawMessage, error) {
	if t := bytes.TrimLeft(raw, " \t\r\n"); len(t) == 0 || t[0] != '{' {
		return nil, fmt.Errorf("%w: spec must be an object", ErrInvalidSpec)
	}
	var spec map[string]any
	if err := json.Unmarshal(raw, &spec); err != nil {
		// an object that still fails to decode, such as a number outside float64 range; the decoder text names the field
		return nil, fmt.Errorf("%w: %v", ErrInvalidSpec, err)
	}
	var errs []string
	add := func(format string, a ...any) { errs = append(errs, fmt.Sprintf(format, a...)) }
	for _, path := range slices.Sorted(maps.Keys(specFields)) {
		obj := spec
		if path != "spec" {
			obj, _ = spec[strings.TrimPrefix(path, "spec.")].(map[string]any)
		}
		for _, k := range slices.Sorted(maps.Keys(obj)) {
			if !slices.Contains(specFields[path], k) {
				add("%s.%s: unknown field", path, k)
			}
		}
	}
	if v, ok := spec["schema_version"].(float64); !ok || v != 1 {
		add("schema_version must be 1")
	}

	if entry, ok := spec["entry"].(map[string]any); !ok {
		add("entry required")
	} else {
		if n, ok := entry["minAxesAligned"].(float64); !ok || !isInt(n) || n < 1 || n > 5 {
			add("entry.minAxesAligned must be an integer 1-5 (N-of-axes voting)")
		}
		switch req := entry["require"].(type) {
		case nil:
		case map[string]any:
			for _, axis := range slices.Sorted(maps.Keys(req)) {
				allowed, known := axisVerdicts[axis]
				if !known {
					add("entry.require.%s: unknown axis", axis)
					continue
				}
				list, isList := req[axis].([]any)
				if !isList {
					list = []any{req[axis]}
				}
				for _, v := range list {
					if s, ok := v.(string); !ok || !slices.Contains(allowed, s) {
						add("entry.require.%s: '%v' is not a valid %s verdict", axis, v, axis)
					}
				}
			}
		default:
			add("entry.require must be an object")
		}
		if v, set := entry["enforceExhaustionVeto"]; set {
			if _, ok := v.(bool); !ok {
				add("entry.enforceExhaustionVeto must be boolean")
			}
		}
	}

	if exit, ok := spec["exit"].(map[string]any); !ok {
		add("exit required")
	} else {
		if n, ok := exit["stopAtr"].(float64); !ok || n <= 0 {
			add("exit.stopAtr must be a positive number (ATR multiple)")
		}
		if v := exit["targetAtr"]; v != nil {
			if n, ok := v.(float64); !ok || n <= 0 {
				add("exit.targetAtr must be a positive number when set")
			}
		}
		if v := exit["timeStopBars"]; v != nil {
			if n, ok := v.(float64); !ok || !isInt(n) || n < 1 {
				add("exit.timeStopBars must be a positive integer when set")
			}
		}
	}

	switch risk := spec["risk"].(type) {
	case nil:
	case map[string]any:
		if v := risk["riskPct"]; v != nil {
			if n, ok := v.(float64); !ok || n <= 0 || n > 100 {
				add("risk.riskPct must be a number in (0,100]")
			}
		}
	default:
		add("risk must be an object")
	}

	scanStrings(spec, "spec", add)
	if len(errs) > 0 {
		return nil, fmt.Errorf("%w: %s", ErrInvalidSpec, strings.Join(errs, "; "))
	}
	return json.Marshal(spec)
}

// scanStrings rejects raw dates and instrument symbols in any string, keys included, so a spec stays anonymous.
// It also rejects a NUL character, which Postgres jsonb cannot store.
func scanStrings(v any, path string, add func(string, ...any)) {
	switch x := v.(type) {
	case string:
		if strings.ContainsRune(x, 0) {
			add("%s: a NUL character is not allowed", path)
		}
		if dateRe.MatchString(x) {
			add("%s: raw dates are forbidden in specs (anonymization)", path)
		}
		if symbolRe.MatchString(x) {
			add("%s: instrument symbols are forbidden in specs (anonymization)", path)
		}
	case []any:
		for i, e := range x {
			scanStrings(e, fmt.Sprintf("%s[%d]", path, i), add)
		}
	case map[string]any:
		for _, k := range slices.Sorted(maps.Keys(x)) {
			scanStrings(k, path+".<key>", add)
			scanStrings(x[k], path+"."+k, add)
		}
	}
}

func isInt(n float64) bool { return n == math.Trunc(n) }
