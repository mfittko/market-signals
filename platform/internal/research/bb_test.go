package research

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"math/rand/v2"
	"os"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/mfittko/market-signals/platform/internal/backtest"
)

const frozenBB = "../../../docs/research/experiments/bb/spec.json"

// The pinned sha256 is the F316 fixture report from the code before the trade and
// bootstrap extractions, so the extractions must leave the report byte for byte unchanged.
func TestExtractionsLeaveTheF316FixtureReportUnchanged(t *testing.T) {
	r, err := RunF316(f316Inputs(t))
	if err != nil {
		t.Fatal(err)
	}
	// Both hashes come from the pre-extraction code; the F316 report is the same on both arches.
	pinned := map[string]string{
		"arm64": "993ab09fd7571da8908e357456b96afaeca8d3ddd59d2cb06abc9ad2b9bb9652",
		"amd64": "993ab09fd7571da8908e357456b96afaeca8d3ddd59d2cb06abc9ad2b9bb9652",
	}
	want, ok := pinned[runtime.GOARCH]
	if !ok {
		t.Skipf("no pinned fixture report sha256 for GOARCH %s", runtime.GOARCH)
	}
	if got := sha(r); got != want {
		t.Fatalf("fixture report sha256 %s, want %s", got, want)
	}
}

func TestDecideMapsTheIntervalToThePreregisteredDecision(t *testing.T) {
	for _, c := range []struct {
		d    Interval
		want string
	}{
		{Interval{Lo: 0.1, Hi: 0.3, OK: true}, "up"},
		{Interval{Lo: -0.3, Hi: -0.1, OK: true}, "down"},
		{Interval{Lo: -0.1, Hi: 0.1, OK: true}, "insufficient evidence"},
		{Interval{Lo: 0, Hi: 0.2, OK: true}, "insufficient evidence"},
		{Interval{Lo: -0.2, Hi: 0, OK: true}, "insufficient evidence"},
		{Interval{Lo: 0.1, Hi: 0.3, OK: false}, "insufficient evidence"},
	} {
		if got := decide(c.d, "up", "down"); got != c.want {
			t.Errorf("decide(%+v) = %q, want %q", c.d, got, c.want)
		}
	}
}

func TestFrozenBBSpecPinsE0AndTheWTIExport(t *testing.T) {
	b, err := os.ReadFile(frozenBB)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ParseBBSpec(b)
	if err != nil {
		t.Fatal(err)
	}
	e0, err := os.ReadFile("../../../" + s.E0Spec.Path)
	if err != nil {
		t.Fatal(err)
	}
	if sha(e0) != s.E0Spec.SHA256 {
		t.Fatalf("e0 spec sha256 is not the reference %s", s.E0Spec.SHA256)
	}
	var names []string
	for _, inst := range s.Instruments {
		names = append(names, inst.Instrument)
		h := inst.Dataset.SHA256
		if inst.Instrument == "WTICO/USD" {
			if h == nil || *h != "4177965517fb5697dd8579844c3960cc030f20bd5800d45fac46b1f38b26f488" {
				t.Errorf("WTICO/USD dataset sha256 %v is not the verified export", h)
			}
		}
	}
	if want := []string{"NAS100/USD", "SPX500/USD", "US30/USD", "DE30/EUR", "WTICO/USD"}; !slices.Equal(names, want) {
		t.Fatalf("instruments %v, want %v", names, want)
	}
}

// bbSpec is the frozen spec with fewer replicates, for the fixtures.
func bbSpec(t *testing.T) BBSpec {
	t.Helper()
	b, err := os.ReadFile(frozenBB)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ParseBBSpec(b)
	if err != nil {
		t.Fatal(err)
	}
	s.Analysis.BootstrapReps.Value = 20
	return s
}

func TestParseBBSpecRefusals(t *testing.T) {
	good, err := os.ReadFile(frozenBB)
	if err != nil {
		t.Fatal(err)
	}
	for name, edit := range map[string][2]string{
		"unknown field": {`"id": "BB",`, `"id": "BB", "extra": 1,`},
		"unlabelled": {`"value": 424,
      "label": "assumed"`, `"value": 424,
      "label": "guessed"`},
		"decision count": {`"value": 9,`, `"value": 8,`},
		"fractional N":   {`"values": [3, 5, 8]`, `"values": [3, 5.5, 8]`},
		"repeated N":     {`"values": [3, 5, 8]`, `"values": [3, 3, 8]`},
		"descending N":   {`"values": [3, 5, 8]`, `"values": [8, 5, 3]`},
		"thresholds":     {`"values": [2, 4, 8]`, `"values": [4, 2, 8]`},
		"band sd":        {`"value": 2,`, `"value": 0,`},
		"squeeze share":  {`"value": 0.2,`, `"value": 1,`},
		"seed":           {`"value": 424,`, `"value": 4.5,`},
	} {
		bad := strings.Replace(string(good), edit[0], edit[1], 1)
		if bad == string(good) {
			t.Fatalf("%s: edit did not change the spec", name)
		}
		if _, err := ParseBBSpec([]byte(bad)); err == nil {
			t.Errorf("%s: want a refusal", name)
		}
	}
}

func TestBollingerUsesThePopulationStandardDeviation(t *testing.T) {
	var bid []backtest.Candle
	for k := 1; k <= 21; k++ {
		bid = append(bid, backtest.Candle{Close: float64(k)})
	}
	mid, width := bollinger(bid, 20, 2)
	if !math.IsNaN(mid[18]) || !math.IsNaN(width[18]) {
		t.Fatal("bar 19 has a band")
	}
	sd := math.Sqrt(399.0 / 12) // population sd of 20 consecutive integers
	if math.Abs(mid[19]-10.5) > 1e-12 || math.Abs(width[19]-4*sd) > 1e-12 || math.Abs(mid[20]-11.5) > 1e-12 {
		t.Fatalf("mid %v %v width %v, want 10.5 11.5 %v", mid[19], mid[20], width[19], 4*sd)
	}
}

// walkBars is a synthetic M1 series: 1,600 closes that alternate around 100 with an
// amplitude that shrinks (so the walk starts from a squeeze) or grows, then ten closes
// that rise faster each bar, then 40 closes flat at the top. It returns the first rising bar.
func walkBars(shrink bool) (bid, ask []backtest.Candle, first int) {
	var closes []float64
	for k := range 1600 {
		amp := 0.001 + 0.009*float64(k)/1600
		if shrink {
			amp = 0.02 - 0.01*float64(k)/1600
		}
		closes = append(closes, 100+amp*float64(1-2*(k%2)))
	}
	first = len(closes)
	for m := 1; m <= 10; m++ {
		closes = append(closes, 100+0.05*(math.Pow(2, float64(m))-1))
	}
	for range 40 {
		closes = append(closes, closes[len(closes)-1])
	}
	bid, ask = series(closes, nil)
	return bid, ask, first
}

// series builds M1 bars from 2024-03-04 00:00 UTC on: each bid bar opens at the previous
// close (100 for the first bar) unless opens sets its open, and the ask is 0.002 above.
func series(closes []float64, opens map[int]float64) (bid, ask []backtest.Candle) {
	t0 := time.Date(2024, 3, 4, 0, 0, 0, 0, time.UTC)
	prev := 100.0
	for k, c := range closes {
		if o, ok := opens[k]; ok {
			prev = o
		}
		tm := t0.Add(time.Duration(k) * time.Minute)
		h, l := max(prev, c)+0.005, min(prev, c)-0.005
		bid = append(bid, backtest.Candle{Time: tm, Open: prev, High: h, Low: l, Close: c, Volume: 1})
		ask = append(ask, backtest.Candle{Time: tm, Open: prev + 0.002, High: h + 0.002, Low: l + 0.002, Close: c + 0.002, Volume: 1})
		prev = c
	}
	return bid, ask
}

// alternate appends n closes that alternate by amp around level.
func alternate(closes []float64, n int, level, amp float64) []float64 {
	for k := range n {
		closes = append(closes, level+amp*float64(1-2*(k%2)))
	}
	return closes
}

// rise appends a walk of length 3 above level: closes 1, 3 and 7 steps up.
func rise(closes []float64, level, step float64) []float64 {
	return append(closes, level+step, level+3*step, level+7*step)
}

// walkSpec is the fixture BB spec with one walk length, 3.
func walkSpec(t *testing.T) BBSpec {
	t.Helper()
	s := bbSpec(t)
	s.Analysis.WalkLengths.Values = []float64{3}
	return s
}

// twoWalks is a walk whose signal is bar 102, then closes that hold at its top, then a
// second, smaller walk whose signal is bar second. The first trade meets neither its stop
// nor its target, so it ends on its time stop.
func twoWalks(second int) (bid, ask []backtest.Candle) {
	closes := rise(alternate(nil, 100, 100, 0.01), 100, 0.05)
	top := closes[len(closes)-1]
	closes = alternate(closes, second-2-len(closes), top, 0.001)
	closes = rise(closes, top, 0.01)
	return series(alternate(closes, 300, top+0.07, 0.001), nil)
}

// walkExit is the exit bar of the long walk trade that AnalyzeBB plans for signal bar sig.
func walkExit(t *testing.T, s BBSpec, e0 Spec, bid, ask []backtest.Candle, sig int) int {
	t.Helper()
	a := s.Analysis
	mid, _ := bollinger(bid, int(a.BandPeriod.Value), a.BandStdDevs.Value)
	ws := e0
	ws.Experiment.Strategy.RR, ws.Experiment.Strategy.MaxBars = a.WalkTargetR.Value, int(a.WalkMaxBars.Value)
	decision := bid[sig].Time.Add(time.Duration(e0.Feed.BarSeconds)*time.Second + time.Duration(e0.Experiment.Timing.DecisionDelayMs.Value*float64(time.Millisecond)))
	j := actAt(bid, sig+1, decision)
	tr, last := simulate(ws, bid, ask, nil, plan{i: sig, j: j, dir: 1, dist: entryPrice(bid, ask, j, 1) - mid[sig], decision: decision})
	if tr.Reason != "time" {
		t.Fatalf("first walk trade ends on %q, want its time stop", tr.Reason)
	}
	return last
}

func TestAnalyzeBBSkipsAWalkInsideTheOpenTradeUpToItsExitBar(t *testing.T) {
	s, e0 := walkSpec(t), fixtureE0(t)
	bid, ask := twoWalks(1000)
	exit := walkExit(t, s, e0, bid, ask, 102)
	for _, c := range []struct{ second, busy, trades int }{{exit, 1, 1}, {exit + 1, 0, 2}} {
		bid, ask := twoWalks(c.second)
		w := AnalyzeBB(s, e0, bid, ask).Walks[0]
		if w.Signals != 2 || w.Busy != c.busy || w.Groups[0].Trades != c.trades {
			t.Errorf("second walk on bar %d, first exit %d: signals %d, busy %d, trades %d; want 2, %d, %d", c.second, exit, w.Signals, w.Busy, w.Groups[0].Trades, c.busy, c.trades)
		}
	}
}

func TestAnalyzeBBSkipsAWalkWithoutAStopDistanceOrAnEntryBar(t *testing.T) {
	s, e0 := walkSpec(t), fixtureE0(t)
	walk := rise(alternate(nil, 100, 100, 0.01), 100, 0.05) // signal bar 102, entry bar 104
	// the entry bar opens below the middle band, so the long has no stop distance
	bid, ask := series(alternate(walk, 50, 100.35, 0.001), map[int]float64{104: 99})
	if w := AnalyzeBB(s, e0, bid, ask).Walks[0]; w.Signals != 1 || w.NoStop != 1 || w.Groups[0].Trades != 0 {
		t.Errorf("entry below the middle band: signals %d, no_stop %d, trades %d; want 1, 1, 0", w.Signals, w.NoStop, w.Groups[0].Trades)
	}
	// the series ends on the signal bar, so no bar opens after the decision
	bid, ask = series(walk, nil)
	if w := AnalyzeBB(s, e0, bid, ask).Walks[0]; w.Signals != 1 || w.NoEntryBar != 1 || w.Groups[0].Trades != 0 {
		t.Errorf("no bar after the signal: signals %d, no_entry_bar %d, trades %d; want 1, 1, 0", w.Signals, w.NoEntryBar, w.Groups[0].Trades)
	}
}

func TestRandomPlanDrawsFromTheWalkEntryHourWithItsSideAndStop(t *testing.T) {
	bid, _ := series(alternate(nil, 120, 100, 0.01), nil) // bars 0-59 in UTC hour 0, 60-119 in hour 1
	hours := barsByHour(bid)
	rng := rand.New(rand.NewPCG(1, 2))
	for _, p := range []plan{{i: 10, j: 12, dir: 1, dist: 0.25}, {i: 70, j: 75, dir: -1, dist: 0.4}} {
		seen := map[int]bool{}
		for range 200 {
			r := randomPlan(rng, bid, &hours, p)
			if bid[r.j].Time.Hour() != bid[p.j].Time.Hour() || r.dir != p.dir || r.dist != p.dist || r.i != r.j || !r.decision.Equal(bid[r.j].Time) {
				t.Fatalf("walk plan %+v: random plan %+v", p, r)
			}
			seen[r.j] = true
		}
		if len(seen) < 30 {
			t.Errorf("walk plan %+v: 200 draws hit %d bars of its 60-bar hour", p, len(seen))
		}
	}
}

func TestWalkSignalsFindTheKnownBandWalk(t *testing.T) {
	bid, _, first := walkBars(true)
	mid, width := bollinger(bid, 20, 2)
	for _, n := range []int{3, 5, 8} {
		got := walkSignals(bid, mid, width, n)
		if want := [][2]int{{first + n - 1, 1}}; !slices.Equal(got, want) {
			t.Errorf("N=%d: signals %v, want %v", n, got, want)
		}
	}
}

func TestSqueezeStartReadsTheLowestShareOfThePreviousWidths(t *testing.T) {
	for _, shrink := range []bool{true, false} {
		bid, _, first := walkBars(shrink)
		_, width := bollinger(bid, 20, 2)
		if got := squeezeStart(width, first-1, 1440, 20, 0.2); got != shrink {
			t.Errorf("shrinking amplitude %v: squeeze %v", shrink, got)
		}
	}
	width := []float64{math.NaN(), 1, 2}
	if squeezeStart(width, 2, 2, 2, 0.5) {
		t.Error("a lookback bar without a band gives a squeeze start")
	}
}

func fixtureE0(t *testing.T) Spec {
	t.Helper()
	specJSON, _ := fixture(t)
	e0, err := ParseSpec(specJSON)
	if err != nil {
		t.Fatal(err)
	}
	return e0
}

func TestAnalyzeBBClassifiesTheKnownSqueezeStartWalk(t *testing.T) {
	for _, shrink := range []bool{true, false} {
		bid, ask, _ := walkBars(shrink)
		r := AnalyzeBB(bbSpec(t), fixtureE0(t), bid, ask)
		if len(r.Walks) != 3 {
			t.Fatalf("%d walk lengths, want 3", len(r.Walks))
		}
		for _, w := range r.Walks {
			trades := map[string]int{}
			for _, g := range w.Groups {
				trades[g.Name] = g.Trades
			}
			sq := 0
			if shrink {
				sq = 1
			}
			if w.Signals != 1 || trades["all walks"] != 1 || trades["longs"] != 1 || trades["shorts"] != 0 || trades["squeeze-start walks"] != sq || trades["other walks"] != 1-sq {
				t.Errorf("shrink %v, N=%d: signals %d, trades %v", shrink, w.N, w.Signals, trades)
			}
			if d := w.Groups[0].Decision; d == "" {
				t.Errorf("N=%d: all walks carry no decision", w.N)
			}
			if w.Groups[2].Decision != "" || w.Groups[3].Decision != "" || w.Groups[4].Decision != "" {
				t.Errorf("N=%d: a descriptive group carries a decision", w.N)
			}
		}
	}
}

// The walk fixture has one walk trade on two days, so every replicate weights both days
// and each replicate delta is the walk net R minus the net R of one random draw.
func TestAnalyzeBBWalkDeltaIsWalkMinusRandom(t *testing.T) {
	s, e0 := walkSpec(t), fixtureE0(t)
	bid, ask, first := walkBars(true)
	r := AnalyzeBB(s, e0, bid, ask)
	g := r.Walks[0].Groups[0]
	if g.Name != "all walks" || g.Trades != 1 || r.Days != 2 {
		t.Fatalf("group %q, trades %d, days %d; want all walks, 1, 2", g.Name, g.Trades, r.Days)
	}
	// replay the stream: the day blocks first, then one random twin of the walk trade per replicate
	a := s.Analysis
	rng := rand.New(rand.NewPCG(uint64(a.Seed.Value), uint64(a.Seed.Value)))
	reps := dayBlocks(rng, r.Days, int(a.BlockDays.Value), int(a.BootstrapReps.Value))
	mid, _ := bollinger(bid, int(a.BandPeriod.Value), a.BandStdDevs.Value)
	sig := first + 2
	decision := bid[sig].Time.Add(time.Duration(e0.Feed.BarSeconds)*time.Second + time.Duration(e0.Experiment.Timing.DecisionDelayMs.Value*float64(time.Millisecond)))
	j := actAt(bid, sig+1, decision)
	p := plan{i: sig, j: j, dir: 1, dist: entryPrice(bid, ask, j, 1) - mid[sig], decision: decision}
	ws := e0
	ws.Experiment.Strategy.RR, ws.Experiment.Strategy.MaxBars = a.WalkTargetR.Value, int(a.WalkMaxBars.Value)
	hours := barsByHour(bid)
	sum, below := 0.0, 0
	var ds []float64
	for range reps {
		tr, _ := simulate(ws, bid, ask, nil, randomPlan(rng, bid, &hours, p))
		sum += tr.NetR
		ds = append(ds, g.WalkMean-tr.NetR)
		if tr.NetR < g.WalkMean {
			below++
		}
	}
	want := interval(g.WalkMean-sum/float64(len(reps)), ds, 100-5/a.Decisions.Value)
	if g.Delta != want {
		t.Errorf("all walks delta %+v, want walk mean minus mean draw %+v", g.Delta, want)
	}
	if pct := 100 * float64(below) / float64(len(reps)); g.RandomPct != pct || pct < 0 || pct > 100 {
		t.Errorf("random percentile %v, want %v in [0, 100]", g.RandomPct, pct)
	}
}

// The frozen thresholds keep every fixture trade, so every delta is 0 and shows no sign;
// thresholds 8, 16 and 32 keep k=8 and split the fixture trades at 16 and 32.
func TestAnalyzeBBGateDeltaIsKeptMinusAll(t *testing.T) {
	s, bid, ask := load(t)
	sp := bbSpec(t)
	sp.Analysis.WidthThresholds.Values = []float64{8, 16, 32}
	r := AnalyzeBB(sp, s, bid, ask)
	sum, n := 0.0, 0
	for _, b := range r.Buckets {
		sum += b.Net.Est * float64(b.Trades)
		n += b.Trades
	}
	signed := false
	for g, gate := range r.Gates {
		ksum, kept := 0.0, 0
		for _, b := range r.Buckets[g+1:] {
			ksum += b.Net.Est * float64(b.Trades)
			kept += b.Trades
		}
		if kept == 0 || gate.Kept != kept {
			t.Fatalf("k=%g keeps %d, buckets above hold %d; want kept trades", gate.K, gate.Kept, kept)
		}
		want := ksum/float64(kept) - sum/float64(n)
		if math.Abs(gate.Delta.Est-want) > 1e-9 {
			t.Errorf("k=%g delta %v, want kept mean minus all mean %v", gate.K, gate.Delta.Est, want)
		}
		// the replicates are kept minus all too, so the interval holds the estimate
		if !gate.Delta.OK || gate.Delta.Lo > gate.Delta.Est+1e-12 || gate.Delta.Hi < gate.Delta.Est-1e-12 {
			t.Errorf("k=%g delta interval %+v does not hold its estimate", gate.K, gate.Delta)
		}
		signed = signed || math.Abs(want) > 0.1
	}
	if r.Gates[0].K != 8 || !signed {
		t.Fatalf("gates %+v: want k=8 first and a gate with a nonzero delta", r.Gates)
	}
}

func TestBucketNetIsGrossMinusSpreadMinusFinancing(t *testing.T) {
	s, bid, ask := load(t)
	r := AnalyzeBB(bbSpec(t), s, bid, ask)
	n := r.NoBand
	for _, b := range r.Buckets {
		n += b.Trades
		if b.Trades == 0 {
			continue
		}
		if d := b.Gross.Est - b.Spread.Est - b.Financing - b.Net.Est; math.Abs(d) > 1e-9 {
			t.Errorf("bucket %s: gross - spread - financing - net = %g", b.Name, d)
		}
		if !b.Net.OK || b.Net.Lo > b.Net.Est+1e-12 || b.Net.Hi < b.Net.Est-1e-12 {
			t.Errorf("bucket %s: net interval %+v does not hold its estimate", b.Name, b.Net)
		}
	}
	if r.E0Trades < 3 || n != r.E0Trades {
		t.Fatalf("buckets and no-band trades %d, E0 trades %d", n, r.E0Trades)
	}
	if names := []string{r.Buckets[0].Name, r.Buckets[1].Name, r.Buckets[2].Name, r.Buckets[3].Name}; !slices.Equal(names, []string{"below 2", "2 to 4", "4 to 8", "8 or more"}) {
		t.Fatalf("bucket names %v", names)
	}
	// a gate at k keeps the buckets at or above k
	for g, gate := range r.Gates {
		kept := 0
		for _, b := range r.Buckets[g+1:] {
			kept += b.Trades
		}
		if gate.Kept != kept {
			t.Errorf("k=%g keeps %d, buckets above hold %d", gate.K, gate.Kept, kept)
		}
	}
}

// bbInputs runs the frozen spec on the E0 fixture as WTICO/USD, with NAS100/USD missing
// and SPX500/USD present but without a sha256.
func bbInputs(t *testing.T, minRows float64) BBInputs {
	t.Helper()
	s := bbSpec(t)
	e0JSON, data := fixture(t)
	s.E0Spec.Path, s.E0Spec.SHA256 = "platform/internal/research/testdata/spec.json", sha(e0JSON)
	s.Analysis.MinRows.Value = minRows
	files := map[string][]byte{}
	for k := range s.Instruments {
		inst := &s.Instruments[k]
		inst.Dataset.SHA256 = nil
		switch inst.Instrument {
		case "WTICO/USD":
			h := sha(data)
			inst.Dataset.SHA256 = &h
			files[inst.Dataset.Path] = data
		case "SPX500/USD":
			files[inst.Dataset.Path] = data
		}
	}
	bbJSON, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return BBInputs{BBJSON: bbJSON, E0JSON: e0JSON, Platform: "go-test test/arch", Open: func(p string) (io.ReadCloser, error) {
		b, ok := files[p]
		if !ok {
			return nil, os.ErrNotExist
		}
		return io.NopCloser(bytes.NewReader(b)), nil
	}}
}

func TestRunBBIsByteIdenticalAndReportsEveryDecisionAndSkip(t *testing.T) {
	var reports, arts [2][]byte
	for k := range reports {
		r, a, err := RunBB(bbInputs(t, 100))
		if err != nil {
			t.Fatal(err)
		}
		reports[k], arts[k] = r, a
	}
	if !bytes.Equal(reports[0], reports[1]) || !bytes.Equal(arts[0], arts[1]) {
		t.Fatal("two runs on the same inputs give different bytes")
	}
	r := string(reports[0])
	for _, want := range []string{
		"claims no edge",
		"| Artifact sha256 | `" + sha(arts[0]) + "` |",
		"| Go version and platform | `go-test test/arch` |",
		"| NAS100/USD | `tmp/research-export/nas100-usd-m1-ba-2023-2026q3.csv` | null | not run: no export |",
		"| SPX500/USD | `tmp/research-export/spx500-usd-m1-ba-2023-2026q3.csv` | null | not run: no dataset sha256 in the spec |",
		"| WTICO/USD | `tmp/research-export/wtico-usd-m1-ba-2023-2026q3.csv` | `" + sha(mustRead(t, "testdata/fixture.csv")) + "` | run |",
		"## WTICO/USD\n\n720 rows",
		"| Width in spreads | Trades | Net R [CI] |",
		"| k | Kept | Kept share | Kept minus all net R [interval] | Decision |",
		"#### N = 3",
		"| squeeze-start walks |",
		"| other walks |",
		"| longs |",
		"| shorts |",
		"- Question 1, k = 2: ",
		"- Question 1, k = 8: ",
		"- Question 2, N = 8, squeeze-start walks: ",
		"no correction runs across instruments",
		"- US30/USD: no export.",
		"- DE30/EUR: no export.",
		"| seed | 424 | assumed |",
	} {
		if !strings.Contains(r, want) {
			t.Errorf("report lacks %q", want)
		}
	}
	if strings.Contains(r, "NaN") || strings.Contains(r, "Inf") {
		t.Error("report prints NaN or Inf")
	}
	if got := strings.Count(r, "\n- Question "); got != 9 {
		t.Errorf("report states %d decisions, want 9", got)
	}
}

func TestRunBBSkipsAnExportUnderMinRows(t *testing.T) {
	r, _, err := RunBB(bbInputs(t, 1000))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(r), "| WTICO/USD | `tmp/research-export/wtico-usd-m1-ba-2023-2026q3.csv` | `") || !strings.Contains(string(r), "not run: 720 rows, under 1000 |") {
		t.Fatalf("report does not skip the short export:\n%s", r)
	}
	if !strings.Contains(string(r), "No instrument was run, so there is no decision.") {
		t.Error("report states a decision without a run")
	}
}

func TestRunBBRefusesAChangedE0SpecAndAChangedExport(t *testing.T) {
	in := bbInputs(t, 100)
	in.E0JSON = append(slices.Clone(in.E0JSON), ' ')
	if _, _, err := RunBB(in); err == nil || !strings.Contains(err.Error(), "e0 spec: sha256") {
		t.Fatalf("want an e0 sha256 refusal, got %v", err)
	}
	in = bbInputs(t, 100)
	open := in.Open
	in.Open = func(p string) (io.ReadCloser, error) {
		rc, err := open(p)
		if err != nil {
			return nil, err
		}
		b, _ := io.ReadAll(rc)
		return io.NopCloser(bytes.NewReader(bytes.Replace(b, []byte("80.0"), []byte("80.1"), 1))), nil
	}
	if _, _, err := RunBB(in); err == nil || !strings.Contains(err.Error(), "WTICO/USD: data: sha256") {
		t.Fatalf("want a dataset sha256 refusal, got %v", err)
	}
}

func mustRead(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
