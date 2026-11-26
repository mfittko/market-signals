package research

import (
	"errors"
	"fmt"
	"io"
	"time"
)

// Manifest describes one owner export. Restoration is hand-kept; every other field is
// computed by Describe and checked by Verify.
type Manifest struct {
	ID          string      `json:"id"` // the export's sha256
	Path        string      `json:"path"`
	Instrument  string      `json:"instrument"`
	Granularity string      `json:"granularity"`
	Rows        int         `json:"rows"`
	First       time.Time   `json:"first"`
	Last        time.Time   `json:"last"`
	Gaps        int         `json:"gaps"`
	LongestGap  []time.Time `json:"longestGap"` // the bar times of the two rows around the longest gap; null without gaps
	Restoration string      `json:"restoration,omitempty"`
}

// Describe reads an export through the same checks as Load and computes its manifest fields.
func Describe(path, instrument, granularity string, r io.Reader) (Manifest, error) {
	if granularity != "M1" {
		return Manifest{}, fmt.Errorf("granularity %q: only M1 is supported", granularity)
	}
	var s Spec
	s.Instrument.Name, s.Feed.Granularity = instrument, granularity
	bid, _, sum, err := loadHashed(s, r)
	if err != nil {
		return Manifest{}, err
	}
	if len(bid) == 0 {
		return Manifest{}, errors.New("data: no rows; re-export the file")
	}
	m := Manifest{ID: sum, Path: path, Instrument: instrument, Granularity: granularity,
		Rows: len(bid), First: bid[0].Time, Last: bid[len(bid)-1].Time}
	var longest time.Duration
	for i := 1; i < len(bid); i++ {
		a, b := bid[i-1].Time, bid[i].Time
		if b.Sub(a) <= time.Minute || weeklyClose(a, b) {
			continue
		}
		m.Gaps++
		if b.Sub(a) > longest {
			longest, m.LongestGap = b.Sub(a), []time.Time{a, b}
		}
	}
	return m, nil
}

// weeklyClose reports whether the first Saturday 12:00 New York after a lies before b,
// so the missing bars between the rows a and b span the weekly close.
func weeklyClose(a, b time.Time) bool {
	l := a.In(newYork)
	sat := time.Date(l.Year(), l.Month(), l.Day()+int(time.Saturday-l.Weekday()), 12, 0, 0, 0, newYork)
	if !sat.After(a) {
		sat = sat.AddDate(0, 0, 7)
	}
	return sat.Before(b)
}

// Verify recomputes the manifest's computed fields from the export and returns one line
// per field that differs.
func Verify(m Manifest, r io.Reader) ([]string, error) {
	got, err := Describe(m.Path, m.Instrument, m.Granularity, r)
	if err != nil {
		return nil, err
	}
	var diffs []string
	for _, f := range []struct {
		name      string
		got, want any
	}{
		{"id", got.ID, m.ID}, {"rows", got.Rows, m.Rows},
		{"first", got.First.UTC(), m.First.UTC()}, {"last", got.Last.UTC(), m.Last.UTC()},
		{"gaps", got.Gaps, m.Gaps}, {"longestGap", utc(got.LongestGap), utc(m.LongestGap)},
	} {
		if g, w := fmt.Sprint(f.got), fmt.Sprint(f.want); g != w {
			diffs = append(diffs, fmt.Sprintf("%s: file %s, manifest %s", f.name, g, w))
		}
	}
	return diffs, nil
}

func utc(ts []time.Time) []time.Time {
	out := make([]time.Time, len(ts))
	for i, t := range ts {
		out[i] = t.UTC()
	}
	return out
}
