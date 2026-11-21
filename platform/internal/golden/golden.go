// Package golden reads the shared fixture files in test/golden and compares a
// Go result with a recorded expected value under the format's tolerance. The
// format is described in test/golden/README.md.
package golden

import (
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"reflect"
	"slices"
)

// Version is the fixture format version this reader understands.
const Version = 1

// Case is one recorded case. Input and Expected stay raw so each area decodes its own shape.
type Case struct {
	Name     string          `json:"name"`
	Input    json.RawMessage `json:"input"`
	Expected json.RawMessage `json:"expected"`
}

type File struct {
	Version int    `json:"version"`
	Area    string `json:"area"`
	Cases   []Case `json:"cases"`
}

// Decode parses a fixture file and rejects another format version or area.
func Decode(data []byte, area string) (File, error) {
	var f File
	if err := json.Unmarshal(data, &f); err != nil {
		return f, err
	}
	if f.Version != Version {
		return f, fmt.Errorf("golden: version %d, want %d", f.Version, Version)
	}
	if f.Area != area {
		return f, fmt.Errorf("golden: area %q, want %q", f.Area, area)
	}
	if len(f.Cases) == 0 {
		return f, fmt.Errorf("golden: %s has no cases", area)
	}
	return f, nil
}

// Encode writes a file in the layout of the committed fixtures: one-space indent and a final newline.
func Encode(f File) ([]byte, error) {
	b, err := json.MarshalIndent(f, "", " ")
	return append(b, '\n'), err
}

// Close applies the format tolerance: relative 1e-9, absolute 1e-12 near zero.
func Close(a, b float64) bool {
	d := math.Abs(a - b)
	return d <= 1e-12 || d <= 1e-9*math.Max(math.Abs(a), math.Abs(b))
}

// Match marshals got and compares it with the recorded JSON value. Numbers compare
// with Close; every other value, key set and list length must be equal.
func Match(got any, want json.RawMessage) error {
	b, err := json.Marshal(got)
	if err != nil {
		return err
	}
	var g, w any
	if err := json.Unmarshal(b, &g); err != nil {
		return err
	}
	if err := json.Unmarshal(want, &w); err != nil {
		return err
	}
	return diff("$", g, w)
}

func diff(path string, g, w any) error {
	mismatch := fmt.Errorf("%s: got %v, want %v", path, g, w)
	switch wv := w.(type) {
	case float64:
		if gv, ok := g.(float64); !ok || !Close(gv, wv) {
			return mismatch
		}
	case map[string]any:
		gv, ok := g.(map[string]any)
		if !ok || !slices.Equal(slices.Sorted(maps.Keys(gv)), slices.Sorted(maps.Keys(wv))) {
			return mismatch
		}
		for _, k := range slices.Sorted(maps.Keys(wv)) {
			if err := diff(path+"."+k, gv[k], wv[k]); err != nil {
				return err
			}
		}
	case []any:
		gv, ok := g.([]any)
		if !ok || len(gv) != len(wv) {
			return mismatch
		}
		for i := range wv {
			if err := diff(fmt.Sprintf("%s[%d]", path, i), gv[i], wv[i]); err != nil {
				return err
			}
		}
	default:
		if !reflect.DeepEqual(g, w) {
			return mismatch
		}
	}
	return nil
}
