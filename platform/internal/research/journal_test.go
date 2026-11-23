package research

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func attempt(id, status string) Attempt {
	d := time.Date(2024, 3, 8, 19, 21, 2, 212_000_000, time.UTC)
	a := Attempt{ID: id, Mode: "retrospective", Experiment: "E0", DataSHA256: "d", SpecSHA256: "s",
		Decision: d, Status: status, Expiry: d.Add(200 * time.Minute)}
	if status == "forecast" {
		a.Dir = -1
	} else {
		a.Reason = "busy"
	}
	return a
}

func read(t *testing.T, path string) Journal {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	j, err := ReadJournal(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func TestAppendReadsBackIdenticalValues(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	a := attempt("E0/a", "forecast")
	o := Outcome{Attempt: a.ID, LabelVersion: LabelVersion, Matured: a.Decision.Add(7 * time.Minute), NetR: -1.25, Label: "loss"}
	if err := Append(path, []Attempt{a}, []Outcome{o}); err != nil {
		t.Fatal(err)
	}
	want := Journal{Attempts: []Attempt{a}, Outcomes: []Outcome{o}}
	if got := read(t, path); !reflect.DeepEqual(got, want) {
		t.Fatalf("read back %+v, want %+v", got, want)
	}
}

func TestAppendRefusesARewrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	a := attempt("E0/a", "forecast")
	o := Outcome{Attempt: a.ID, LabelVersion: LabelVersion, Matured: a.Expiry, NetR: 2, Label: "win"}
	if err := Append(path, []Attempt{a}, []Outcome{o}); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	for name, c := range map[string]struct {
		a    []Attempt
		o    []Outcome
		want string
	}{
		"existing id":       {[]Attempt{attempt("E0/b", "hold"), a}, nil, "already in the journal"},
		"id twice in batch": {[]Attempt{attempt("E0/b", "hold"), attempt("E0/b", "hold")}, nil, "already in the journal"},
		"second outcome":    {nil, []Outcome{o}, "already has an outcome"},
		"unknown attempt":   {nil, []Outcome{{Attempt: "E0/x", LabelVersion: LabelVersion, Label: "win"}}, "no attempt"},
		"forecast, no dir":  {[]Attempt{{ID: "E0/c", Mode: "retrospective", Status: "forecast"}}, nil, "direction"},
		"hold, no reason":   {[]Attempt{{ID: "E0/c", Mode: "retrospective", Status: "hold"}}, nil, "reason"},
		"unknown status":    {[]Attempt{{ID: "E0/c", Mode: "retrospective", Status: "maybe", Reason: "x"}}, nil, "status"},
		"unknown mode":      {[]Attempt{{ID: "E0/c", Mode: "live", Status: "hold", Reason: "x"}}, nil, "mode"},
		"unknown label":     {[]Attempt{attempt("E0/c", "forecast")}, []Outcome{{Attempt: "E0/c", LabelVersion: LabelVersion, Label: "draw"}}, "label"},
		"wrong version":     {[]Attempt{attempt("E0/c", "forecast")}, []Outcome{{Attempt: "E0/c", LabelVersion: "v0", Label: "win"}}, "label version"},
		"outcome for hold":  {[]Attempt{attempt("E0/h", "hold")}, []Outcome{{Attempt: "E0/h", LabelVersion: LabelVersion, Label: "win"}}, "only a forecast"},
	} {
		err := Append(path, c.a, c.o)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: want a refusal with %q, got %v", name, c.want, err)
		}
		if after, _ := os.ReadFile(path); !bytes.Equal(before, after) {
			t.Fatalf("%s: the refused append changed the file", name)
		}
	}
}

func TestHoldsTimeoutsAndErrorsAreKept(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	var want []Attempt
	for _, s := range []string{"hold", "timeout", "error"} {
		a := attempt("E0/"+s, s)
		a.Reason = s + " reason"
		want = append(want, a)
	}
	if err := Append(path, want, nil); err != nil {
		t.Fatal(err)
	}
	if got := read(t, path).Attempts; !reflect.DeepEqual(got, want) {
		t.Fatalf("read back %+v, want %+v", got, want)
	}
}

func TestReadRefusesATornLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	if err := Append(path, []Attempt{attempt("E0/a", "forecast"), attempt("E0/b", "hold")}, nil); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	torn := b[:len(b)-20]
	lines := strings.SplitAfter(string(b), "\n")
	forecast, hold := lines[0], lines[1]
	outcome := func(id, version, label string) string {
		return `{"kind":"outcome","attempt":"` + id + `","labelVersion":"` + version + `","matured":"2024-03-08T19:28:02Z","netR":1,"label":"` + label + `"}` + "\n"
	}
	win := outcome("E0/a", LabelVersion, "win")
	for name, c := range map[string]struct {
		in   string
		line string
		want string
	}{
		"torn":                {string(torn), "line 2", ""},
		"unknown kind":        {`{"kind":"guess"}` + "\n", "line 1", "kind"},
		"invalid status":      {forecast + `{"kind":"attempt","id":"E0/c","mode":"retrospective","status":"maybe","reason":"x"}` + "\n", "line 2", "status"},
		"unknown field":       {forecast + `{"kind":"attempt","id":"E0/c","mode":"retrospective","status":"hold","reason":"x","extra":1}` + "\n", "line 2", "unknown field"},
		"duplicate attempt":   {forecast + forecast, "line 2", "already in the journal"},
		"outcome, no attempt": {forecast + outcome("E0/x", LabelVersion, "win"), "line 2", "no attempt"},
		"outcome for a hold":  {forecast + hold + outcome("E0/b", LabelVersion, "win"), "line 3", "only a forecast"},
		"second outcome":      {forecast + win + win, "line 3", "already has an outcome"},
		"unknown label":       {forecast + outcome("E0/a", LabelVersion, "draw"), "line 2", "label"},
		"wrong label version": {forecast + outcome("E0/a", "v0", "win"), "line 2", "label version"},
		"overlong line":       {forecast + strings.Repeat("x", 2<<20), "line 2", "token too long"},
	} {
		_, err := ReadJournal(strings.NewReader(c.in))
		if err == nil || !strings.Contains(err.Error(), c.line) || !strings.Contains(err.Error(), c.want) || !strings.Contains(err.Error(), "new journal from the same spec and data at a new path") {
			t.Errorf("%s: want a refusal naming %s, %q and the recovery, got %v", name, c.line, c.want, err)
		}
	}
	if _, err := ReadJournal(strings.NewReader(forecast + hold + win)); err != nil {
		t.Fatalf("a valid journal: %v", err)
	}
	if err := os.WriteFile(path, torn, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Append(path, []Attempt{attempt("E0/c", "hold")}, nil); err == nil || !strings.Contains(err.Error(), "line 2") {
		t.Fatalf("append to a torn journal: want a refusal, got %v", err)
	}
}

func TestLabel(t *testing.T) {
	for _, c := range []struct {
		tr   Trade
		want string
	}{
		{Trade{NetR: 0.1, Reason: "target"}, "win"},
		{Trade{NetR: 0, Reason: "reversal"}, "loss"},
		{Trade{NetR: -1, Reason: "stop"}, "loss"},
		{Trade{NetR: 3, Reason: "end"}, "ambiguous"},
	} {
		if got := Label(c.tr); got != c.want {
			t.Errorf("%+v: label %s, want %s", c.tr, got, c.want)
		}
	}
}

func TestEveryFlipIsOneAttempt(t *testing.T) {
	s, bid, ask := load(t)
	bar := time.Duration(s.Feed.BarSeconds) * time.Second
	art := Run(s, bid, ask)
	// cut the series just after a late flip bar, so at least that flip has no entry bar
	last := art.Trades[len(art.Trades)-1]
	cut := 0
	for i, c := range bid {
		if c.Time.Equal(last.Flip) {
			cut = i + 1
		}
	}
	// on reversals the opposite flip fills while the trade is open, so it is a busy hold
	rs, rbid, rask := reversalLoad(t)
	for name, art := range map[string]Artifact{"full": art, "cut": Run(s, bid[:cut], ask[:cut]), "reversal": Run(rs, rbid, rask)} {
		attempts, outcomes := Reconstruct(s, art)
		if len(attempts) != art.Flips || len(outcomes) != len(art.Trades) {
			t.Fatalf("%s: %d attempts and %d outcomes, want %d flips and %d trades", name, len(attempts), len(outcomes), art.Flips, len(art.Trades))
		}
		reasons := map[string]int{}
		for k, a := range attempts {
			if k > 0 && !a.Decision.After(attempts[k-1].Decision) {
				t.Fatalf("%s: attempt %s is not after %s", name, a.ID, attempts[k-1].ID)
			}
			if !a.Expiry.Equal(a.Decision.Add(time.Duration(s.Experiment.Strategy.MaxBars) * bar)) {
				t.Fatalf("%s: attempt %+v expiry is not decision plus maxBars bars", name, a)
			}
			// no series reaches a no_atr hold: Supertrend flips only after bar period, and an
			// ATR of 0 there needs every true range so far to be 0, a flat series that never flips
			if a.Status == "hold" {
				reasons[a.Reason]++
			}
		}
		if name == "reversal" && reasons["busy"] == 0 {
			t.Fatalf("reversal: no busy hold in %v", reasons)
		}
		if name == "cut" && reasons["no_entry_bar"] == 0 {
			t.Fatalf("cut: no no_entry_bar hold in %v", reasons)
		}
		path := filepath.Join(t.TempDir(), "journal.jsonl")
		if err := Append(path, attempts, outcomes); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestAppendRefusesALastLineWithoutALineEnd(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	if err := Append(path, []Attempt{attempt("E0/a", "forecast")}, nil); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	cut := b[:len(b)-1]
	if err := os.WriteFile(path, cut, 0o644); err != nil {
		t.Fatal(err)
	}
	err := Append(path, []Attempt{attempt("E0/b", "hold")}, nil)
	if err == nil || !strings.Contains(err.Error(), "new journal from the same spec and data at a new path") {
		t.Fatalf("want a refusal with the recovery, got %v", err)
	}
	if after, _ := os.ReadFile(path); !bytes.Equal(after, cut) {
		t.Fatal("the refused append changed the file")
	}
}
