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
	delay := time.Duration(s.Experiment.Timing.DecisionDelayMs.Value) * time.Millisecond
	idx := map[time.Time]int{}
	for i, c := range bid {
		idx[c.Time] = i
	}
	for _, tr := range Run(s, bid, ask).Trades {
		decided := tr.Flip.Add(bar + delay)
		if !tr.Decision.Equal(decided) || tr.Entry.Before(decided) {
			t.Fatalf("trade %+v enters before its decision at %s", tr, decided)
		}
		// the entry is the first bar at or after the decision, never a later one
		if prev := bid[idx[tr.Entry]-1]; !prev.Time.Before(decided) {
			t.Fatalf("trade %+v skips the bar at %s", tr, prev.Time)
		}
		if tr.Reason == "reversal" && tr.Exit.Before(tr.Entry.Add(bar+delay)) {
			t.Fatalf("reversal exit %+v acts before its flip could be known", tr)
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
	for _, tr := range Run(s, bid, ask).Trades {
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
