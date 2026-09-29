package domain

import (
	"testing"
	"time"
)

func facts() SnapshotFacts {
	return SnapshotFacts{Instrument: "WTICO/USD", Price: 100, Positions: map[int64]string{7: "WTICO/USD", 8: "XAU/USD"}, TakenAt: time.Now()}
}

func TestParseDecision(t *testing.T) {
	d, err := ParseDecision(`sure: {"action":"open","side":"long","notional":500,"stop":99,"target":103,"reasoning":"x"} done`)
	if err != nil || d.Action != "open" || *d.Target != 103 {
		t.Fatalf("got %+v %v", d, err)
	}
	for _, bad := range []string{
		`no json`, `{"action":"buy"}`, `{"action":"open","side":"long","notional":5}`,
		`{"action":"open","side":"up","notional":5,"stop":1}`, `{"action":"close"}`,
	} {
		if _, err := ParseDecision(bad); err == nil {
			t.Errorf("expected error for %s", bad)
		}
	}
}

func TestValidateProposal(t *testing.T) {
	now := time.Now()
	target := 101.0
	cases := []struct {
		name  string
		d     Decision
		f     func(SnapshotFacts) SnapshotFacts
		valid bool
	}{
		{"hold", Decision{Action: "hold"}, nil, true},
		{"long ok", Decision{Action: "open", Side: "long", Notional: 100, Stop: 99, Target: &target}, nil, true},
		{"long stop above entry", Decision{Action: "open", Side: "long", Notional: 100, Stop: 101}, nil, false},
		{"short stop below entry", Decision{Action: "open", Side: "short", Notional: 100, Stop: 99}, nil, false},
		{"long target below entry", Decision{Action: "open", Side: "long", Notional: 100, Stop: 99, Target: floatp(99.5)}, nil, false},
		{"close own", Decision{Action: "close", PositionID: 7}, nil, true},
		{"close other instrument", Decision{Action: "close", PositionID: 8}, nil, false},
		{"close unknown", Decision{Action: "close", PositionID: 99}, nil, false},
		{"halted open", Decision{Action: "open", Side: "long", Notional: 100, Stop: 99}, func(f SnapshotFacts) SnapshotFacts { f.Halted = true; return f }, false},
		{"halted hold", Decision{Action: "hold"}, func(f SnapshotFacts) SnapshotFacts { f.Halted = true; return f }, true},
		{"stale", Decision{Action: "hold"}, func(f SnapshotFacts) SnapshotFacts { f.TakenAt = now.Add(-time.Hour); return f }, false},
	}
	for _, c := range cases {
		f := facts()
		if c.f != nil {
			f = c.f(f)
		}
		v := ValidateProposal(c.d, f, now, 15*time.Minute)
		if v.Valid != c.valid {
			t.Errorf("%s: valid=%v reasons=%v", c.name, v.Valid, v.Reasons)
		}
		if v.Committed {
			t.Errorf("%s: shadow proposals are never committed", c.name)
		}
	}
}

func floatp(v float64) *float64 { return &v }

func TestCompare(t *testing.T) {
	if Compare(Decision{Action: "hold"}, Decision{Action: "hold"}) != "agree" {
		t.Error("hold/hold")
	}
	if Compare(Decision{Action: "open", Side: "long"}, Decision{Action: "open", Side: "short"}) != "differ" {
		t.Error("side differs")
	}
	if Compare(Decision{Action: "open", Side: "long"}, Decision{Action: "hold"}) != "differ" {
		t.Error("action differs")
	}
}
