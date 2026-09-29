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

func TestWakeMayOnlyHoldCloseTightenOrResetTripwires(t *testing.T) {
	long := WakePosition{ID: 7, Side: "long", Entry: 100, Stop: 98, Price: 101}
	short := WakePosition{ID: 8, Side: "short", Entry: 100, Stop: 102, Price: 99}
	at := time.Now()
	f := func(v float64) *float64 { return &v }
	cases := []struct {
		name string
		d    Decision
		w    WakePosition
		ok   bool
	}{
		{"hold", Decision{Action: "hold"}, long, true},
		{"close own position", Decision{Action: "close", PositionID: 7}, long, true},
		{"close someone else's position", Decision{Action: "close", PositionID: 9}, long, false},
		{"tighten long stop up", Decision{Action: "tighten_stop", PositionID: 7, NewStop: f(99.5)}, long, true},
		{"widen long stop", Decision{Action: "tighten_stop", PositionID: 7, NewStop: f(97)}, long, false},
		{"same stop is not a tightening", Decision{Action: "tighten_stop", PositionID: 7, NewStop: f(98)}, long, false},
		{"stop through the price", Decision{Action: "tighten_stop", PositionID: 7, NewStop: f(101.5)}, long, false},
		{"tighten short stop down", Decision{Action: "tighten_stop", PositionID: 8, NewStop: f(100.5)}, short, true},
		{"widen short stop", Decision{Action: "tighten_stop", PositionID: 8, NewStop: f(103)}, short, false},
		{"open from a wake", Decision{Action: "open", Side: "long", Notional: 10, Stop: 90}, long, false},
		{"valid tripwires", Decision{Action: "set_tripwires", PositionID: 7, Tripwires: []Tripwire{{Kind: "adverse_atr", ATR: 2}}}, long, true},
		{"unknown tripwire", Decision{Action: "set_tripwires", PositionID: 7, Tripwires: []Tripwire{{Kind: "vibes"}}}, long, false},
	}
	for _, c := range cases {
		v := ValidateWake(c.d, c.w, at, at, time.Minute)
		if v.Valid != c.ok {
			t.Errorf("%s: valid=%v want %v (%v)", c.name, v.Valid, c.ok, v.Reasons)
		}
	}
}

func TestWakeActionsAreRefusedOutsideAWake(t *testing.T) {
	v := ValidateProposal(Decision{Action: "tighten_stop", PositionID: 1, NewStop: func() *float64 { x := 1.0; return &x }()}, SnapshotFacts{Instrument: "X", Price: 2, TakenAt: time.Now()}, time.Now(), 0)
	if v.Valid {
		t.Fatal("tighten_stop must not stand outside a tripwire wake")
	}
}

func TestPlanValidation(t *testing.T) {
	bad := []Plan{
		{Trail: &Trail{Kind: "atr"}},
		{Trail: &Trail{Kind: "moon"}},
		{Tripwires: []Tripwire{{Kind: "close_beyond", Level: 1}}},
		{Tripwires: []Tripwire{{Kind: "no_progress", Bars: 1}}},
		{Tripwires: make([]Tripwire, MaxTripwires+1)},
	}
	for i, p := range bad {
		if err := p.Check("long"); err == nil {
			t.Errorf("bad plan %d accepted", i)
		}
	}
	good := Plan{Trail: &Trail{Kind: "atr", Mult: 2}, MaxBars: 60, Tripwires: []Tripwire{{Kind: "close_beyond", Level: 93.4, Dir: "above"}, {Kind: "opposite_flip"}, {Kind: "feed_stale", Minutes: 10}}}
	if err := good.Check("long"); err != nil {
		t.Fatal(err)
	}
}

func TestParseDecisionTakesTheLastObjectNotTheFirst(t *testing.T) {
	d, err := ParseDecision(`I considered {"action":"open","side":"long","notional":1000,"stop":70} but the gate vetoes it. Final: {"action":"hold","reasoning":"vetoed"}`)
	if err != nil || d.Action != "hold" {
		t.Fatalf("the final object is the decision: %+v %v", d, err)
	}
	// an invalid last object must fail safe, not fall back to an earlier valid open
	if d, err := ParseDecision(`{"action":"open","side":"long","notional":1000,"stop":70} then {"action":"open","side":"sideways"}`); err == nil {
		t.Fatalf("an invalid final object must be an error, got %+v", d)
	}
	if _, err := ParseDecision(`no json here`); err == nil {
		t.Fatal("no object is an error")
	}
}
