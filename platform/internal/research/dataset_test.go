package research

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func fixtureManifest(t *testing.T) (Manifest, string) {
	t.Helper()
	b, err := os.ReadFile("testdata/dataset.csv")
	if err != nil {
		t.Fatal(err)
	}
	m, err := Describe("testdata/dataset.csv", "WTICO/USD", "M1", strings.NewReader(string(b)))
	if err != nil {
		t.Fatal(err)
	}
	return m, string(b)
}

func utcAt(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

// The fixture has a Thursday daily halt, a 4-minute mid-week gap, a skipped Friday session
// and the weekend across the 2025-03-09 US DST start; only the weekend is not a gap.
func TestDescribeCountsHaltAndMidWeekGapButNotTheDSTWeekend(t *testing.T) {
	m, _ := fixtureManifest(t)
	want := Manifest{
		ID: m.ID, Path: "testdata/dataset.csv", Instrument: "WTICO/USD", Granularity: "M1", Rows: 10,
		First: utcAt("2025-03-06T21:58:00Z"), Last: utcAt("2025-03-09T22:01:00Z"), Gaps: 3,
		LongestGap: []time.Time{utcAt("2025-03-06T23:06:00Z"), utcAt("2025-03-07T21:58:00Z")},
	}
	if len(m.ID) != 64 || !reflect.DeepEqual(m, want) {
		t.Fatalf("manifest\n%+v\nwant\n%+v", m, want)
	}
}

func TestWeeklyClose(t *testing.T) {
	for _, c := range []struct {
		name, a, b string
		want       bool
	}{
		{"weekend across the DST start", "2025-03-07T21:59:00Z", "2025-03-09T22:00:00Z", true},
		{"weekend across the DST end", "2025-10-31T20:59:00Z", "2025-11-02T23:00:00Z", true},
		{"daily halt", "2025-03-06T21:59:00Z", "2025-03-06T23:00:00Z", false},
		{"mid-week gap", "2025-03-05T14:00:00Z", "2025-03-05T14:04:00Z", false},
		{"saturday after noon to sunday open", "2025-03-08T18:00:00Z", "2025-03-09T22:00:00Z", false},
	} {
		if got := weeklyClose(utcAt(c.a), utcAt(c.b)); got != c.want {
			t.Errorf("%s: weeklyClose = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestDescribeRefusesNonM1AndEmptyExports(t *testing.T) {
	_, csv := fixtureManifest(t)
	if _, err := Describe("x", "WTICO/USD", "M5", strings.NewReader(csv)); err == nil || !strings.Contains(err.Error(), "only M1") {
		t.Fatalf("M5: err %v", err)
	}
	head := strings.SplitAfter(csv, "\n")[0]
	if _, err := Describe("x", "WTICO/USD", "M1", strings.NewReader(head)); err == nil || !strings.Contains(err.Error(), "no rows") {
		t.Fatalf("empty: err %v", err)
	}
}

func TestVerifyPassesOnTheUnchangedExport(t *testing.T) {
	m, csv := fixtureManifest(t)
	// round-trip through JSON as a committed manifest would
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	var back Manifest
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	diffs, err := Verify(back, strings.NewReader(csv))
	if err != nil || len(diffs) != 0 {
		t.Fatalf("diffs %v, err %v", diffs, err)
	}
}

func TestVerifyNamesTheChangedField(t *testing.T) {
	m, csv := fixtureManifest(t)
	lines := strings.SplitAfter(csv, "\n")
	for _, c := range []struct {
		name, csv, field string
	}{
		{"changed byte", strings.Replace(csv, "80.000,80.050", "80.001,80.050", 1), "id:"},
		{"missing row", strings.Replace(csv, lines[5], "", 1), "rows:"},
		{"changed range", strings.Join(lines[:len(lines)-2], ""), "last:"},
	} {
		diffs, err := Verify(m, strings.NewReader(c.csv))
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if !strings.Contains(strings.Join(diffs, "\n"), c.field) {
			t.Errorf("%s: diffs %v, want a %s line", c.name, diffs, c.field)
		}
	}
}

// Every dataset a frozen spec pins by sha256 has a committed manifest with that id.
func TestEveryPinnedDatasetHasAManifest(t *testing.T) {
	ids := map[string]bool{}
	manifests, _ := filepath.Glob("../../../docs/research/datasets/*.json")
	for _, p := range manifests {
		var m Manifest
		b, err := os.ReadFile(p)
		if err == nil {
			err = json.Unmarshal(b, &m)
		}
		if err != nil {
			t.Fatalf("%s: %v", p, err)
		}
		ids[m.ID] = true
	}
	specs, _ := filepath.Glob("../../../docs/research/experiments/*/spec.json")
	if len(specs) == 0 {
		t.Fatal("no specs found")
	}
	pinned := 0
	for _, p := range specs {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		var v any
		if err := json.Unmarshal(b, &v); err != nil {
			t.Fatalf("%s: %v", p, err)
		}
		for _, sum := range datasetSums(v, false) {
			pinned++
			if !ids[sum] {
				t.Errorf("%s pins dataset sha256 %s with no manifest in docs/research/datasets", p, sum)
			}
		}
	}
	if pinned == 0 {
		t.Fatal("no pinned dataset found")
	}
}

// datasetSums collects the non-null sha256 values of objects under a "dataset" key.
func datasetSums(v any, underDataset bool) []string {
	var out []string
	switch x := v.(type) {
	case map[string]any:
		if s, ok := x["sha256"].(string); ok && underDataset {
			out = append(out, s)
		}
		for k, c := range x {
			out = append(out, datasetSums(c, k == "dataset")...)
		}
	case []any:
		for _, c := range x {
			out = append(out, datasetSums(c, false)...)
		}
	}
	return out
}
