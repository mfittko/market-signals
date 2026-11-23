package research

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/mfittko/market-signals/platform/internal/backtest"
)

var update = flag.Bool("update", false, "rewrite testdata/fixture.csv from the generator")

// fixtureCSV is a synthetic WTICO/USD M1 series: two sine waves, a varying spread, a
// ten-minute gap and a New York rollover. It holds no exported market data.
func fixtureCSV() []byte {
	var b bytes.Buffer
	b.WriteString(strings.Join(header, ",") + "\n")
	t := time.Date(2024, 3, 8, 19, 6, 0, 0, time.UTC)
	prev := 80.0
	for k := 0; k < 720; k++ {
		if k == 300 {
			t = t.Add(10 * time.Minute)
		}
		c := 80 + 1.5*math.Sin(2*math.Pi*float64(k)/90) + 0.3*math.Sin(2*math.Pi*float64(k)/17) + 0.9*math.Sin(2*math.Pi*float64(k)/233)
		o := prev
		h, l := math.Max(o, c)+0.05, math.Min(o, c)-0.05
		s := 0.03 + 0.01*float64(k%3)
		fmt.Fprintf(&b, "WTICO/USD,M1,%s,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%d\n",
			t.Format("2006-01-02T15:04:05.000000000Z"), o, h, l, c, o+s, h+s, l+s, c+s, k%50+1)
		prev = c
		t = t.Add(time.Minute)
	}
	return b.Bytes()
}

func fixture(t *testing.T) (specJSON, data []byte) {
	t.Helper()
	if *update {
		if err := os.WriteFile("testdata/fixture.csv", fixtureCSV(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var err error
	if data, err = os.ReadFile("testdata/fixture.csv"); err != nil {
		t.Fatal(err)
	}
	if specJSON, err = os.ReadFile("testdata/spec.json"); err != nil {
		t.Fatal(err)
	}
	return specJSON, data
}

func load(t *testing.T) (Spec, []backtest.Candle, []backtest.Candle) {
	t.Helper()
	specJSON, data := fixture(t)
	s, err := ParseSpec(specJSON)
	if err != nil {
		t.Fatal(err)
	}
	bid, ask, err := Load(s, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	return s, bid, ask
}

func TestFrozenSpecParses(t *testing.T) {
	b, err := os.ReadFile("../../../docs/research/experiments/e0/spec.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseSpec(b); err != nil {
		t.Fatal(err)
	}
}

func TestTwoRunsGiveIdenticalArtifacts(t *testing.T) {
	specJSON, data := fixture(t)
	var sums [2]string
	for k := range sums {
		art, err := Execute(specJSON, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(art)
		sums[k] = hex.EncodeToString(sum[:])
	}
	if sums[0] != sums[1] {
		t.Fatalf("artifact sha256 differs between runs: %s and %s", sums[0], sums[1])
	}
	s, bid, ask := load(t)
	if n := len(Run(s, bid, ask).Trades); n < 3 {
		t.Fatalf("fixture gives %d trades, want at least 3 so the rule tests exercise something", n)
	}
}

func TestLoadRefusesAChangedFile(t *testing.T) {
	specJSON, data := fixture(t)
	changed := bytes.Replace(data, []byte("80.0"), []byte("80.1"), 1)
	if bytes.Equal(changed, data) {
		t.Fatal("test edit did not change the fixture")
	}
	if _, err := Execute(specJSON, bytes.NewReader(changed)); err == nil || !strings.Contains(err.Error(), "sha256") {
		t.Fatalf("want a sha256 refusal, got %v", err)
	}
}

func TestParseSpecRefusesAnUnlabelledValue(t *testing.T) {
	specJSON, _ := fixture(t)
	for _, edit := range []struct{ from, to string }{
		{`"label": "measured"`, `"label": "guessed"`},
		{`"label": "assumed"`, `"label": ""`},
	} {
		b := bytes.Replace(specJSON, []byte(edit.from), []byte(edit.to), 1)
		if _, err := ParseSpec(b); err == nil || !strings.Contains(err.Error(), "assumed or measured") {
			t.Fatalf("%s: want a label refusal, got %v", edit.to, err)
		}
	}
}

func TestNoFillBeforeTheDecisionExisted(t *testing.T) {
	s, bid, ask := load(t)
	bar := time.Duration(s.Feed.BarSeconds) * time.Second
	delay := time.Duration(s.Experiment.Timing.DecisionDelayMs.Value * float64(time.Millisecond))
	idx := map[time.Time]int{}
	for i, c := range bid {
		idx[c.Time] = i
	}
	for _, tr := range Run(s, bid, ask).Trades {
		decided := tr.Flip.Add(bar + delay)
		if !tr.Decision.Equal(decided) || tr.Entry.Before(decided) {
			t.Fatalf("trade %+v enters before its decision at %s", tr, decided)
		}
		// a long buys at the ask open of its entry bar, a short sells at the bid open
		want := bid[idx[tr.Entry]].Open
		if tr.Dir > 0 {
			want = ask[idx[tr.Entry]].Open
		}
		if math.Abs(tr.EntryPrice-want) > 1e-9 {
			t.Fatalf("trade %+v enters at %v, want %v", tr, tr.EntryPrice, want)
		}
		// the entry is the first bar at or after the decision, never a later one
		if prev := bid[idx[tr.Entry]-1]; !prev.Time.Before(decided) {
			t.Fatalf("trade %+v skips the bar at %s", tr, prev.Time)
		}
		if tr.Reason != "reversal" {
			continue
		}
		flip, ok := oppositeFlip(s, bid, tr)
		if !ok || tr.Exit.Before(flip.Add(bar+delay)) {
			t.Fatalf("reversal exit %+v acts before its opposite flip at %s could be known", tr, flip)
		}
	}
}

// oppositeFlip returns the open time of the first flip against the trade after its flip bar.
func oppositeFlip(s Spec, bid []backtest.Candle, tr Trade) (time.Time, bool) {
	st := s.Experiment.Strategy
	flips, _ := backtest.Supertrend(bid, st.SupertrendPeriod, st.SupertrendMult)
	for _, f := range flips {
		if f.Dir == -tr.Dir && f.Time.After(tr.Flip) {
			return f.Time, true
		}
	}
	return time.Time{}, false
}

// heldReversal returns the first reversal trade that holds at least one bar between its
// opposite flip and its fill, with the entry bar and the flip bar.
func heldReversal(t *testing.T, s Spec, bid, ask []backtest.Candle) (tr Trade, entry, flip int) {
	t.Helper()
	idx := map[time.Time]int{}
	for i, c := range bid {
		idx[c.Time] = i
	}
	for _, tr := range Run(s, bid, ask).Trades {
		if tr.Reason != "reversal" {
			continue
		}
		ft, ok := oppositeFlip(s, bid, tr)
		if !ok {
			t.Fatalf("reversal %+v has no opposite flip", tr)
		}
		if k := idx[ft]; bid[k+1].Time.Before(tr.Exit) {
			return tr, idx[tr.Entry], k
		}
	}
	t.Fatal("no fixture reversal holds a bar between its flip and its fill")
	return Trade{}, 0, 0
}

func tradeAt(t *testing.T, art Artifact, entry time.Time) Trade {
	t.Helper()
	for _, tr := range art.Trades {
		if tr.Entry.Equal(entry) {
			return tr
		}
	}
	t.Fatalf("no trade enters at %s", entry)
	return Trade{}
}

// reversalLoad loads the fixture with a wide stop and no target, so trades end on reversals.
func reversalLoad(t *testing.T) (Spec, []backtest.Candle, []backtest.Candle) {
	s, bid, ask := load(t)
	s.Experiment.Strategy.StopATR, s.Experiment.Strategy.RR = 100, 0
	return s, bid, ask
}

func TestAStopBeforeTheReversalFillWins(t *testing.T) {
	s, bid, ask := reversalLoad(t)
	tr, _, k := heldReversal(t, s, bid, ask)
	bid2 := append([]backtest.Candle(nil), bid...)
	ask2 := append([]backtest.Candle(nil), ask...)
	// the bar after the flip touches the stop on the side the trade exits on
	if tr.Dir > 0 {
		bid2[k+1].Low = 0
	} else {
		ask2[k+1].High = 1000
	}
	got := tradeAt(t, Run(s, bid2, ask2), tr.Entry)
	if got.Reason != "stop" || !got.Exit.Equal(bid[k+1].Time) {
		t.Fatalf("got %+v, want a stop at %s before the reversal fill at %s", got, bid[k+1].Time, tr.Exit)
	}
}

func TestATimeStopBeforeTheReversalFillWins(t *testing.T) {
	s, bid, ask := reversalLoad(t)
	tr, j, k := heldReversal(t, s, bid, ask)
	s.Experiment.Strategy.MaxBars = k + 1 - j + 1 // the time stop falls on the bar after the flip
	got := tradeAt(t, Run(s, bid, ask), tr.Entry)
	if want := bid[k+1].Time.Add(time.Duration(s.Feed.BarSeconds) * time.Second); got.Reason != "time" || !got.Exit.Equal(want) {
		t.Fatalf("got %+v, want a time stop at %s before the reversal fill at %s", got, want, tr.Exit)
	}
}

func TestAWhipsawBeforeTheEntryReverses(t *testing.T) {
	s, bid, ask := reversalLoad(t)
	bar := time.Duration(s.Feed.BarSeconds) * time.Second
	delay := time.Duration(s.Experiment.Timing.DecisionDelayMs.Value * float64(time.Millisecond))
	idx := map[time.Time]int{}
	for i, c := range bid {
		idx[c.Time] = i
	}
	tr := Run(s, bid, ask).Trades[0]
	i := idx[tr.Flip]
	bid2 := append([]backtest.Candle(nil), bid...)
	// the bar after the flip bar closes far through the band, so it flips the other way
	if tr.Dir > 0 {
		bid2[i+1].Low, bid2[i+1].Close = 0, 0
	} else {
		bid2[i+1].High, bid2[i+1].Close = 1000, 1000
	}
	flips, _ := backtest.Supertrend(bid2, s.Experiment.Strategy.SupertrendPeriod, s.Experiment.Strategy.SupertrendMult)
	whipsaw := false
	for _, f := range flips {
		whipsaw = whipsaw || (f.Time.Equal(bid[i+1].Time) && f.Dir == -tr.Dir)
	}
	if !whipsaw || idx[tr.Entry] != i+2 {
		t.Fatalf("test setup: want an opposite flip at bar %d and an entry at bar %d, got flip %v and entry %d", i+1, i+2, whipsaw, idx[tr.Entry])
	}
	fill := i + 2
	for bid[fill].Time.Before(bid[i+1].Time.Add(bar + delay)) {
		fill++
	}
	got := tradeAt(t, Run(s, bid2, ask), tr.Entry)
	if got.Reason != "reversal" || !got.Exit.Equal(bid[fill].Time) {
		t.Fatalf("got %+v, want a reversal at %s", got, bid[fill].Time)
	}
}

func TestRefusals(t *testing.T) {
	specJSON, _ := fixture(t)
	s, err := ParseSpec(specJSON)
	if err != nil {
		t.Fatal(err)
	}
	head := strings.Join(header, ",") + "\n"
	row := func(inst, gran, at, open string) string {
		return inst + "," + gran + "," + at + "," + open + ",1,1,1,1,1,1,1,1\n"
	}
	good := row("WTICO/USD", "M1", "2024-03-08T19:06:00Z", "1")
	for _, c := range []struct{ name, csv, want string }{
		{"bad header", strings.Replace(head, "volume", "vol", 1) + good, "header"},
		{"wrong instrument", head + row("BCO/USD", "M1", "2024-03-08T19:06:00Z", "1"), "instrument and granularity"},
		{"wrong granularity", head + row("WTICO/USD", "M5", "2024-03-08T19:06:00Z", "1"), "instrument and granularity"},
		{"times not ascending", head + good + good, "not after the previous row"},
		{"unparsable time", head + row("WTICO/USD", "M1", "yesterday", "1"), "cannot parse"},
		{"unparsable number", head + row("WTICO/USD", "M1", "2024-03-08T19:06:00Z", "x"), "invalid syntax"},
	} {
		_, _, err := Load(s, strings.NewReader(c.csv))
		if err == nil || !strings.Contains(err.Error(), c.want) || !strings.Contains(err.Error(), "re-export the file") {
			t.Errorf("%s: want %q and the re-export recovery, got %v", c.name, c.want, err)
		}
	}
	for _, c := range []struct{ name, from, to, want string }{
		{"commission", `"value": 0,`, `"value": 0.5,`, "commission must be 0"},
		{"negative decision delay", `"value": 2212`, `"value": -1`, "decision delay must be >= 0"},
		{"invalid strategy", `"stopAtr": 1.5`, `"stopAtr": 0`, "rr must be >= 0 and the other strategy settings > 0"},
		{"negative rr", `"rr": 2`, `"rr": -1`, "rr must be >= 0 and the other strategy settings > 0"},
		{"unknown field", `"financingMarkup"`, `"financingMarkupRate"`, "unknown field"},
		{"empty source", `"source": "the export's bid and ask OHLC, per bar"`, `"source": ""`, "with a source"},
	} {
		b := bytes.Replace(specJSON, []byte(c.from), []byte(c.to), 1)
		if bytes.Equal(b, specJSON) {
			t.Fatalf("%s: test edit did not change the spec", c.name)
		}
		if _, err := ParseSpec(b); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: want %q, got %v", c.name, c.want, err)
		}
	}
}

func TestALaterRevisionDoesNotReachAnEarlierDecision(t *testing.T) {
	s, bid, ask := load(t)
	cut := bid[450].Time
	before := Run(s, bid, ask)
	revBid := append([]backtest.Candle(nil), bid...)
	revAsk := append([]backtest.Candle(nil), ask...)
	for i := 450; i < len(bid); i++ {
		for _, c := range []*backtest.Candle{&revBid[i], &revAsk[i]} {
			c.Open, c.High, c.Low, c.Close = 2*c.Open-70, 2*c.High-70, 2*c.Low-70, 2*c.Close-70
		}
	}
	after := Run(s, revBid, revAsk)
	if reflect.DeepEqual(before, after) {
		t.Fatal("the revision changed nothing; the test proves nothing")
	}
	var early []Trade
	for _, tr := range before.Trades {
		if tr.Exit.Before(cut) {
			early = append(early, tr)
		}
	}
	if len(early) == 0 || len(after.Trades) < len(early) {
		t.Fatalf("want trades closed before the cut in both runs, got %d and %d", len(early), len(after.Trades))
	}
	if !reflect.DeepEqual(early, after.Trades[:len(early)]) {
		t.Fatal("a revision after the cut changed a trade decided and closed before it")
	}
}

func TestRollovers(t *testing.T) {
	at := func(s string) time.Time {
		v, err := time.Parse(time.RFC3339, s)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"2024-03-08T21:00:00Z", "2024-03-08T21:59:00Z", 0}, // EST: rollover is 22:00 UTC
		{"2024-03-08T21:59:00Z", "2024-03-08T22:00:00Z", 1},
		{"2024-03-08T22:00:00Z", "2024-03-08T23:00:00Z", 0}, // the opening instant is not crossed
		{"2024-03-11T20:30:00Z", "2024-03-11T21:00:00Z", 1}, // EDT: rollover is 21:00 UTC
		{"2024-03-08T21:00:00Z", "2024-03-11T13:00:00Z", 3}, // a weekend hold pays three days
	} {
		if got := rollovers(at(c.a), at(c.b)); got != c.want {
			t.Errorf("rollovers(%s, %s) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestFinancingSign(t *testing.T) {
	s, bid, ask := load(t)
	crossed := 0
	art := Run(s, bid, ask)
	if sum := art.Summary; math.Abs(sum.GrossR-sum.SpreadR-sum.FinancingR-sum.Net.TotalR) > 1e-9 {
		t.Fatalf("summary %+v: gross minus spread minus financing is not net", sum)
	}
	for _, tr := range art.Trades {
		if tr.SpreadR <= 0 || math.Abs(tr.GrossR-tr.SpreadR-tr.FinancingR-tr.NetR) > 1e-9 {
			t.Fatalf("trade %+v: want a positive spread and gross minus spread minus financing equal to net", tr)
		}
		switch {
		case tr.Rollovers == 0 && tr.FinancingR != 0:
			t.Fatalf("trade %+v pays financing without a rollover", tr)
		case tr.Rollovers > 0 && tr.Dir > 0 && tr.FinancingR <= 0, tr.Rollovers > 0 && tr.Dir < 0 && tr.FinancingR >= 0:
			t.Fatalf("trade %+v: a long pays and a short receives at basis 4.7%% and markup 2.5%%", tr)
		}
		if tr.Rollovers > 0 {
			crossed++
		}
		if math.Abs(tr.NetR-(tr.R-tr.FinancingR)) > 1e-12 {
			t.Fatalf("trade %+v: net is not R minus financing", tr)
		}
	}
	if crossed == 0 {
		t.Fatal("no fixture trade crosses the rollover")
	}
}
