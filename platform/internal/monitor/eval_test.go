package monitor

import (
	"testing"

	"github.com/mfittko/market-signals/platform/internal/domain"
)

func f(v float64) *float64       { return &v }
func bar(o, h, l, c float64) Bar { return Bar{Open: o, High: h, Low: l, Close: c, Volume: 10} }

func long() Position  { return Position{ID: 1, Side: "long", Entry: 100, Stop: 98, Target: f(105)} }
func short() Position { return Position{ID: 2, Side: "short", Entry: 100, Stop: 102, Target: f(95)} }

func TestFills(t *testing.T) {
	cases := []struct {
		name   string
		p      Position
		b      Bar
		reason string
		price  float64
	}{
		{"long stop", long(), bar(99, 99.5, 97.5, 98.5), "stop", 98},
		{"long target", long(), bar(101, 105.5, 100.5, 105), "target", 105},
		{"long stop wins when both touch", long(), bar(100, 106, 97, 101), "stop", 98},
		{"long gap through the stop fills at the open", long(), bar(96, 97, 95, 96.5), "stop", 96},
		{"short stop", short(), bar(101, 102.5, 100.5, 101.5), "stop", 102},
		{"short target", short(), bar(99, 99.5, 94.5, 95), "target", 95},
		{"short stop wins when both touch", short(), bar(100, 103, 94, 99), "stop", 102},
		{"short gap through the stop fills at the open", short(), bar(104, 105, 103, 104), "stop", 104},
	}
	for _, c := range cases {
		r := Step(c.p, c.b, Env{})
		if r.Exit == nil || r.Exit.Reason != c.reason || r.Exit.Price != c.price {
			t.Errorf("%s: got %+v want %s @ %v", c.name, r.Exit, c.reason, c.price)
		}
	}
	if r := Step(long(), bar(100, 101, 99, 100.5), Env{}); r.Exit != nil || r.Pos.BarsHeld != 1 {
		t.Fatalf("a quiet bar must hold: %+v", r)
	}
}

func TestKillSwitchTimeStopAndInvalidation(t *testing.T) {
	if r := Step(long(), bar(100, 101, 99, 100.5), Env{Halted: true}); r.Exit == nil || r.Exit.Reason != "kill_switch" || r.Exit.Price != 100.5 {
		t.Fatalf("halt closes at the bar close: %+v", r.Exit)
	}
	// a stop hit in the same bar still wins over the kill switch
	if r := Step(long(), bar(99, 99, 97, 98), Env{Halted: true}); r.Exit.Reason != "stop" {
		t.Fatalf("stop first: %+v", r.Exit)
	}
	p := long()
	p.Plan.MaxBars = 3
	p.BarsHeld = 2
	if r := Step(p, bar(100, 101, 99.5, 100.2), Env{}); r.Exit == nil || r.Exit.Reason != "time_stop" {
		t.Fatalf("time stop: %+v", r.Exit)
	}
	p = long()
	p.Plan.Invalidation = f(99)
	if r := Step(p, bar(99.5, 100, 98.5, 98.8), Env{}); r.Exit == nil || r.Exit.Reason != "invalidated" || r.Exit.Price != 98.8 {
		t.Fatalf("invalidation on a close beyond the level: %+v", r.Exit)
	}
	if r := Step(p, bar(99.5, 100, 98.5, 99.2), Env{}); r.Exit != nil {
		t.Fatalf("touching below the level without closing beyond it does not void the idea: %+v", r.Exit)
	}
}

func TestTrailingOnlyTightensAndNeverCrossesPrice(t *testing.T) {
	p := long()
	p.Plan.Trail = &domain.Trail{Kind: "atr", Mult: 2}
	env := Env{ATR: 1}
	r := Step(p, bar(100, 104, 100, 104), env) // best close 104 -> candidate 102
	if r.Pos.Stop != 102 || !r.Trailed {
		t.Fatalf("stop should trail to 102, got %v", r.Pos.Stop)
	}
	r2 := Step(r.Pos, bar(103, 103.5, 102.5, 103), env) // price falls back: best stays 104
	if r2.Pos.Stop != 102 || r2.Trailed {
		t.Fatalf("stop must not move away: %v", r2.Pos.Stop)
	}
	r3 := Step(r2.Pos, bar(103, 103, 101, 101.5), env) // low 101 <= 102 -> stopped out
	if r3.Exit == nil || r3.Exit.Reason != "stop" || r3.Exit.Price != 102 {
		t.Fatalf("trailed stop fills: %+v", r3.Exit)
	}
	// a candidate at or beyond the close is refused
	p = long()
	p.Plan.Trail = &domain.Trail{Kind: "supertrend"}
	if r := Step(p, bar(100, 101, 100, 100.5), Env{Supertrend: 100.6}); r.Trailed || r.Pos.Stop != 98 {
		t.Fatalf("supertrend above the close is refused: %v", r.Pos.Stop)
	}
	// the trail takes effect from the next bar: this bar may not fill against it
	p = long()
	p.Plan.Trail = &domain.Trail{Kind: "atr", Mult: 1}
	if r := Step(p, bar(100, 104, 98.5, 104), Env{ATR: 1}); r.Exit != nil {
		t.Fatalf("no lookahead: %+v", r.Exit)
	}
	// shorts mirror
	s := short()
	s.Plan.Trail = &domain.Trail{Kind: "atr", Mult: 2}
	if r := Step(s, bar(100, 100, 96, 96), Env{ATR: 1}); r.Pos.Stop != 98 {
		t.Fatalf("short stop should trail down to 98, got %v", r.Pos.Stop)
	}
}

func TestTripwires(t *testing.T) {
	p := long()
	p.Plan.Tripwires = []domain.Tripwire{
		{Kind: "close_beyond", Level: 103, Dir: "above"},
		{Kind: "adverse_atr", ATR: 1.5},
		{Kind: "opposite_flip"},
	}
	if r := Step(p, bar(100, 104, 100, 103.5), Env{ATR: 1}); len(r.Fired) != 1 || r.Fired[0].Kind != "close_beyond" {
		t.Fatalf("close_beyond: %+v", r.Fired)
	}
	if r := Step(p, bar(99.5, 99.6, 98.6, 98.7), Env{ATR: 1}); len(r.Fired) != 0 {
		t.Fatalf("1.3 ATR adverse must not fire: %+v", r.Fired)
	}
	if r := Step(p, bar(99, 99, 98.3, 98.4), Env{ATR: 1}); len(r.Fired) != 1 || r.Fired[0].Kind != "adverse_atr" {
		t.Fatalf("1.6 ATR adverse fires: %+v", r.Fired)
	}
	if r := Step(p, bar(99, 99, 98.4, 98.4), Env{ATR: 1, OppositeFlip: true}); len(r.Fired) != 2 {
		t.Fatalf("adverse 1.6 ATR and a flip: %+v", r.Fired)
	}
	// cooldown: the same tripwire stays quiet for CooldownBars held bars
	r := Step(p, bar(100, 104, 100, 103.5), Env{ATR: 1})
	quiet := 0
	for i := 0; i < CooldownBars-1; i++ {
		r = Step(r.Pos, bar(103.5, 104, 103.2, 103.6), Env{ATR: 1})
		if len(r.Fired) > 0 {
			t.Fatalf("fired again inside the cooldown at bar %d", i)
		}
		quiet++
	}
	if r = Step(r.Pos, bar(103.5, 104, 103.2, 103.6), Env{ATR: 1}); len(r.Fired) != 1 {
		t.Fatalf("should fire again after the cooldown: %+v", r.Fired)
	}
	// price_cross needs the previous close on the other side
	c := long()
	c.Plan.Tripwires = []domain.Tripwire{{Kind: "price_cross", Level: 101, Dir: "up"}}
	if r := Step(c, bar(100, 101.5, 99.9, 100.4), Env{}); len(r.Fired) != 1 {
		t.Fatalf("price_cross up: %+v", r.Fired)
	}
	c.LastClose = 102
	if r := Step(c, bar(102, 103, 101.5, 102.5), Env{}); len(r.Fired) != 0 {
		t.Fatalf("already above the level: %+v", r.Fired)
	}
	// no_progress fires once, and only after enough bars without profit
	n := long()
	n.Plan.Tripwires = []domain.Tripwire{{Kind: "no_progress", Bars: 3}}
	r = Step(n, bar(100, 100.4, 99.6, 100.1), Env{ATR: 1})
	r = Step(r.Pos, bar(100.1, 100.4, 99.6, 100.1), Env{ATR: 1})
	if len(r.Fired) != 0 {
		t.Fatal("too early")
	}
	r = Step(r.Pos, bar(100.1, 100.4, 99.6, 100.1), Env{ATR: 1})
	if len(r.Fired) != 1 {
		t.Fatalf("no_progress after 3 flat bars: %+v", r.Fired)
	}
	for i := 0; i < 20; i++ {
		if r = Step(r.Pos, bar(100.1, 100.4, 99.6, 100.1), Env{ATR: 1}); len(r.Fired) != 0 {
			t.Fatal("no_progress fires once per trade")
		}
	}
	// feed_stale
	fs := long()
	fs.Plan.Tripwires = []domain.Tripwire{{Kind: "feed_stale", Minutes: 10}}
	if r := Step(fs, bar(100, 100.5, 99.5, 100), Env{FeedStaleMinutes: 12}); len(r.Fired) != 1 {
		t.Fatalf("feed_stale: %+v", r.Fired)
	}
}

func TestPnL(t *testing.T) {
	if got := PnL("long", 1000, 100, 101); got != 10 {
		t.Fatal(got)
	}
	if got := PnL("short", 1000, 100, 101); got != -10 {
		t.Fatal(got)
	}
}
