package backtest

import (
	"math"
	"testing"
	"time"
)

var t0 = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

// series builds candles from closes with a fixed 1.0 range around each close.
func series(closes []float64) []Candle {
	c := make([]Candle, len(closes))
	for i, x := range closes {
		o := x
		if i > 0 {
			o = closes[i-1]
		}
		c[i] = Candle{Time: t0.Add(time.Duration(i) * 5 * time.Minute), Open: o, High: math.Max(o, x) + 0.5, Low: math.Min(o, x) - 0.5, Close: x, Volume: 100}
	}
	return c
}

func ramp(n int, from, step float64) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = from + step*float64(i)
	}
	return out
}

func TestATRAndADXOnASteadyTrend(t *testing.T) {
	c := series(ramp(120, 100, 1))
	f := indicators(c)
	// every bar moves 1.0 and spans 2.0 wide with the wicks, so ATR settles at 2
	if math.Abs(f.atr[100]-2) > 0.1 {
		t.Fatalf("atr %v", f.atr[100])
	}
	// a straight trend has no opposing movement: ADX is high
	if f.adx[100] < 50 {
		t.Fatalf("adx %v", f.adx[100])
	}
	if f.vol[100] < 0.99 || f.vol[100] > 1.01 {
		t.Fatalf("vol ratio %v", f.vol[100])
	}
}

func TestTargetStopAndReversalExits(t *testing.T) {
	// a long trend up: a buy flip at bar 60 reaches a 1.5 ATR x 2 target
	c := series(ramp(200, 100, 1))
	flip := []Flip{{Time: c[60].Time, Dir: 1}}
	tr := Run(c, flip, Params{StopATR: 1.5, RR: 2, Direction: "both"})
	if len(tr) != 1 || tr[0].Reason != "target" || math.Abs(tr[0].R-2) > 1e-9 {
		t.Fatalf("%+v", tr)
	}
	// the same buy against a falling market stops out for exactly -1R
	d := series(ramp(200, 300, -1))
	tr = Run(d, []Flip{{Time: d[60].Time, Dir: 1}}, Params{StopATR: 1.5, RR: 2, Direction: "both"})
	if len(tr) != 1 || tr[0].Reason != "stop" || math.Abs(tr[0].R+1) > 1e-9 {
		t.Fatalf("%+v", tr)
	}
	// with no target and no stop hit, an opposite flip closes the trade
	tr = Run(c, []Flip{{Time: c[60].Time, Dir: 1}, {Time: c[70].Time, Dir: -1}}, Params{StopATR: 5, RR: 0, Direction: "both"})
	if len(tr) != 1 || tr[0].Reason != "reversal" {
		t.Fatalf("%+v", tr)
	}
	// an opposite flip at the close of the entry bar closes the trade on that bar
	tr = Run(c, []Flip{{Time: c[60].Time, Dir: 1}, {Time: c[61].Time, Dir: -1}, {Time: c[62].Time, Dir: 1}}, Params{StopATR: 5, RR: 0, Direction: "both"})
	if len(tr) != 2 || tr[0].Reason != "reversal" || !tr[1].Entry.Equal(c[63].Time) {
		t.Fatalf("%+v", tr)
	}
}

func TestFiltersAndOnePositionAtATime(t *testing.T) {
	c := series(ramp(200, 100, 1))
	flips := []Flip{{Time: c[60].Time, Dir: 1}, {Time: c[61].Time, Dir: 1}}
	if n := len(Run(c, flips, Params{StopATR: 1.5, RR: 50, MaxBars: 30, Direction: "both"})); n != 1 {
		t.Fatalf("a flip inside an open trade must be ignored, got %d trades", n)
	}
	if n := len(Run(c, flips, Params{StopATR: 1.5, RR: 2, MinADX: 101, Direction: "both"})); n != 0 {
		t.Fatal("ADX filter should reject")
	}
	if n := len(Run(c, flips, Params{StopATR: 1.5, RR: 2, Direction: "short"})); n != 0 {
		t.Fatal("direction filter should reject longs")
	}
	if n := len(Run(c, []Flip{{Time: c[5].Time, Dir: 1}}, Params{StopATR: 1.5, RR: 2, Direction: "both"})); n != 0 {
		t.Fatal("flips inside the indicator warm-up are skipped")
	}
}

func TestSummarizeSplitAndHolds(t *testing.T) {
	trades := []Trade{{R: 2}, {R: -1}, {R: 2}, {R: -1}, {R: -1}}
	s := Summarize(trades)
	if s.Trades != 5 || math.Abs(s.TotalR-1) > 1e-9 || math.Abs(s.ProfitFac-4.0/3) > 1e-9 || s.MaxDD != 2 {
		t.Fatalf("%+v", s)
	}
	for i := range trades {
		trades[i].Entry = t0.Add(time.Duration(i) * time.Hour)
	}
	tr, te := SplitAt(trades, trades[3].Entry)
	if len(tr) != 3 || len(te) != 2 || !tr[2].Entry.Before(te[0].Entry) {
		t.Fatal("split must be chronological")
	}
	r := Report{Baseline: Candidate{Test: Stats{Expectancy: 0.1}}}
	if r.Holds(Candidate{Test: Stats{Trades: 5, Expectancy: 0.9}}) {
		t.Fatal("too few test trades must not count")
	}
	if !r.Holds(Candidate{Test: Stats{Trades: 12, Expectancy: 0.3}}) || r.Holds(Candidate{Test: Stats{Trades: 12, Expectancy: 0.05}}) {
		t.Fatal("beat the baseline out of sample")
	}
}

func TestSearchRanksOnTrainingOnly(t *testing.T) {
	c := series(ramp(1500, 100, 0.2))
	var flips []Flip
	for i := 60; i < 1400; i += 25 {
		flips = append(flips, Flip{Time: c[i].Time, Dir: 1})
	}
	r := Search(c, flips, 3)
	if r.Tried != len(Grid()) || len(r.Candidates) == 0 || len(r.Candidates) > 3 {
		t.Fatalf("tried %d candidates %d", r.Tried, len(r.Candidates))
	}
	for i := 1; i < len(r.Candidates); i++ {
		if r.Candidates[i].Train.Expectancy > r.Candidates[i-1].Train.Expectancy {
			t.Fatal("candidates must be ordered by training expectancy")
		}
	}
	for _, cd := range r.Candidates {
		if cd.Train.Trades < MinTrain {
			t.Fatal("candidates need enough training trades")
		}
	}
}

func TestEveryCandidateIsSplitAtTheSameDate(t *testing.T) {
	flips := []Flip{{Time: t0.Add(1 * time.Hour)}, {Time: t0.Add(2 * time.Hour)}, {Time: t0.Add(3 * time.Hour)}, {Time: t0.Add(4 * time.Hour)}, {Time: t0.Add(5 * time.Hour)}}
	cut := cutTime(flips, 0.6)
	if !cut.Equal(t0.Add(4 * time.Hour)) {
		t.Fatalf("cut must be a flip time on the shared timeline, got %v", cut)
	}
	// trades of different candidates land on the same side of the same date
	a := []Trade{{Entry: t0.Add(3 * time.Hour)}, {Entry: t0.Add(5 * time.Hour)}}
	b := []Trade{{Entry: t0.Add(1 * time.Hour)}, {Entry: t0.Add(4 * time.Hour)}}
	for _, ts := range [][]Trade{a, b} {
		tr, te := SplitAt(ts, cut)
		for _, x := range tr {
			if !x.Entry.Before(cut) {
				t.Fatal("training trade at or after the cut")
			}
		}
		for _, x := range te {
			if x.Entry.Before(cut) {
				t.Fatal("test trade before the cut")
			}
		}
	}
}

func TestAGapThroughTheStopFillsAtTheOpen(t *testing.T) {
	c := series(ramp(200, 100, 1))
	// bar 65 gaps far below any long stop from a buy at bar 60
	c[65].Open, c[65].High, c[65].Low, c[65].Close = 90, 90.5, 89, 90
	tr := Run(c, []Flip{{Time: c[60].Time, Dir: 1}}, Params{StopATR: 1.5, RR: 0, Direction: "both"})
	if len(tr) != 1 || tr[0].Reason != "stop" {
		t.Fatalf("%+v", tr)
	}
	// entry is bar 61's open (160), 1R is 1.5 ATR (about 3): a fill at 90 is far worse than -1R
	if tr[0].R > -10 {
		t.Fatalf("a gap through the stop must fill at the open, got R %v", tr[0].R)
	}
}
