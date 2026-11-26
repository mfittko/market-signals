package research

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/mfittko/market-signals/platform/internal/backtest"
)

func pullbackSpec(t *testing.T) (PullbackSpec, []byte) {
	t.Helper()
	b, err := os.ReadFile("../../../docs/research/experiments/pullback/spec.json")
	if err != nil {
		t.Fatal(err)
	}
	s, err := ParsePullbackSpec(b)
	if err != nil {
		t.Fatal(err)
	}
	return s, b
}

// opens gives the open times of n daily bars on consecutive weekday trading dates,
// starting with Monday 2025-01-06; each bar opens at 17:00 New York the day before.
func opens(n int) []time.Time {
	var out []time.Time
	for d := time.Date(2025, 1, 6, 0, 0, 0, 0, newYork); len(out) < n; d = d.AddDate(0, 0, 1) {
		if d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
			continue
		}
		p := d.AddDate(0, 0, -1)
		out = append(out, time.Date(p.Year(), p.Month(), p.Day(), 17, 0, 0, 0, newYork).UTC())
	}
	return out
}

// flat turns closes into bars with open, high, low and close equal, so the true range is
// the close change.
func flat(closes ...float64) []backtest.Candle {
	ts := opens(len(closes))
	out := make([]backtest.Candle, len(closes))
	for i, c := range closes {
		out[i] = backtest.Candle{Time: ts[i], Open: c, High: c, Low: c, Close: c}
	}
	return out
}

// rising gives closes 100, 101, ... for n bars.
func rising(n int) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = 100 + float64(i)
	}
	return out
}

func TestPullbackSpecPinsTheFrozenRule(t *testing.T) {
	s, b := pullbackSpec(t)
	st := s.Strategy
	if st.TrendSMA != 200 || st.DownCloses != 3 || st.ExitSMA != 5 || st.MaxBars != 10 || st.ATRPeriod != 14 || st.StopATR != 10 ||
		s.Costs.SpreadBps.Value != 4 || s.Costs.NightBps.Value != 0.822 || s.Timing.ExpiryDays.Value != 14 || s.Experiment != "PB1" {
		t.Fatalf("frozen rule changed: %+v", s)
	}
	want := []string{"SPX500/USD", "NAS100/USD", "US30/USD", "DE30/EUR", "UK100/GBP", "JP225/USD", "FR40/EUR"}
	if !slices.Equal(s.Symbols, want) {
		t.Fatalf("symbols %v, want %v", s.Symbols, want)
	}
	sum := sha256.Sum256(b)
	if s.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("spec sha256 %s", s.SHA256)
	}
}

func TestPullbackSpecRefusesAnUnlabelledValue(t *testing.T) {
	_, b := pullbackSpec(t)
	// the first assumed label in the file is costs.spreadBps
	_, err := ParsePullbackSpec([]byte(strings.Replace(string(b), `"assumed"`, `""`, 1)))
	if err == nil || !strings.Contains(err.Error(), "costs.spreadBps must be labelled") {
		t.Fatalf("err = %v, want an unlabelled costs.spreadBps refusal", err)
	}
}

func TestPullbackSpecRefusesAnInvalidValue(t *testing.T) {
	_, b := pullbackSpec(t)
	const symbols = `"symbols": ["SPX500/USD", "NAS100/USD", "US30/USD", "DE30/EUR", "UK100/GBP", "JP225/USD", "FR40/EUR"]`
	for name, c := range map[string]struct{ old, new, err string }{
		"zero trend SMA":      {`"trendSma": 200`, `"trendSma": 0`, "must be > 0"},
		"missing down closes": {`"downCloses": 3,`, ``, "must be > 0"},
		"zero exit SMA":       {`"exitSma": 5`, `"exitSma": 0`, "must be > 0"},
		"zero max bars":       {`"maxBars": 10`, `"maxBars": 0`, "must be > 0"},
		"zero ATR period":     {`"atrPeriod": 14`, `"atrPeriod": 0`, "must be > 0"},
		"zero stop ATR":       {`"stopAtr": 10`, `"stopAtr": 0`, "must be > 0"},
		"empty symbols":       {symbols, `"symbols": []`, "symbols must be set"},
		"zero expiry":         {`"value": 14`, `"value": 0`, "must be > 0"},
		"negative expiry":     {`"value": 14`, `"value": -1`, "must be > 0"},
		"unknown field":       {`"experiment": "PB1",`, `"experiment": "PB1", "extra": 1,`, `unknown field "extra"`},
		"hourly granularity":  {`"granularity": "D"`, `"granularity": "H1"`, `feed.granularity "H1"`},
		"missing granularity": {`"granularity": "D",`, ``, `feed.granularity ""`},
	} {
		if !strings.Contains(string(b), c.old) {
			t.Fatalf("%s: the spec has no %s", name, c.old)
		}
		_, err := ParsePullbackSpec([]byte(strings.Replace(string(b), c.old, c.new, 1)))
		if err == nil || !strings.Contains(err.Error(), c.err) {
			t.Errorf("%s: err = %v, want %q", name, err, c.err)
		}
	}
}

func TestPullbackSetupParity(t *testing.T) {
	s, _ := pullbackSpec(t)
	// bars 0..199 rise from 100 to 299
	closes := append(rising(200),
		300, 299, 298, 297, 296, // 200..204: down from 201 on; 203 and 204 have 3 lower closes
		300, 299, 298, 297, // 205..208: 208 has 3 lower closes
		298, 297, 296, 150, // 209..212: 212 has 3 lower closes but 150 is below its SMA200
	)
	c := flat(closes...)
	// by hand: 202 fails on 300 < 299 at bar 200; 203: 297 > SMA200 40688/200 = 203.44;
	// 204: 296 > 40880/200 = 204.40; 208: 297 > 41648/200 = 208.24; 211 fails on 298 < 297
	// at bar 209; 212: 150 < 42247/200 = 211.235
	want := []int{203, 204, 208}
	var got []int
	for i := range c {
		if s.setup(c, i) {
			got = append(got, i)
		}
	}
	if !slices.Equal(got, want) {
		t.Fatalf("setups %v, want %v", got, want)
	}
}

func TestPullbackTradeExits(t *testing.T) {
	s, _ := pullbackSpec(t)
	// bars 0..202 rise by 1, so the Wilder ATR14 at the setup bar 205 is 1 and the stop is
	// 10 below the entry; 203..205 are the three lower closes
	base := append(rising(203), 301, 300, 299)
	bar := func(o, h, l, c float64) backtest.Candle { return backtest.Candle{Open: o, High: h, Low: l, Close: c} }
	var down []backtest.Candle
	for k := range 10 {
		c := 298.5 - 0.5*float64(k)
		down = append(down, bar(c+0.5, c+0.5, c, c))
	}
	// entry 299, stop distance 10, 4 bps round trip and 0.822 bps a night
	netR := func(exit float64, nights int) float64 {
		return (math.Log(exit/299) - (4+float64(nights)*0.822)/1e4) / (10.0 / 299)
	}
	for name, c := range map[string]struct {
		after []backtest.Candle
		exit  string
		last  int
		netR  float64
	}{
		// SMA5 of 302, 301, 300, 299, 305 is 301.4
		"sma5": {[]backtest.Candle{bar(299, 306, 299, 305)}, "sma5", 206, netR(305, 1)},
		// Tuesday 2025-10-21 open to the Monday 2025-11-03 close holds 14 nights
		"time":       {down, "time", 215, netR(294, 14)},
		"low stop":   {[]backtest.Candle{bar(299, 300, 285, 298)}, "stop", 206, netR(289, 0)},
		"gap stop":   {[]backtest.Candle{bar(299, 299, 298.5, 298.5), bar(280, 281, 279, 280)}, "stop", 207, netR(280, 1)},
		"stop wins":  {[]backtest.Candle{bar(299, 310, 280, 310)}, "stop", 206, netR(289, 0)},
		"open trade": {[]backtest.Candle{bar(299, 299, 298.5, 298.5)}, "", 0, 0},
	} {
		t.Run(name, func(t *testing.T) {
			bars := flat(base...)
			ts := opens(len(base) + len(c.after))
			for k, b := range c.after {
				b.Time = ts[len(base)+k]
				bars = append(bars, b)
			}
			if !s.setup(bars, 205) {
				t.Fatal("bar 205 is no setup")
			}
			_, atr := backtest.Supertrend(bars, 14, 1)
			last, o, ok := s.trade(bars, atr, 205)
			if c.exit == "" {
				if ok {
					t.Fatalf("an open trade resolved: %+v", o)
				}
				return
			}
			if !ok || o.Exit != c.exit || last != c.last || math.Abs(o.NetR-c.netR) > 1e-12 {
				t.Fatalf("got ok %v exit %q bar %d net R %v, want %q bar %d net R %v", ok, o.Exit, last, o.NetR, c.exit, c.last, c.netR)
			}
			// every exit kind matures at the close of its exit bar
			if _, closed := session(bars[c.last].Time); !o.Matured.Equal(closed) {
				t.Fatalf("matured %s, want the exit bar close %s", o.Matured, closed)
			}
		})
	}
}

type fakeFeed struct {
	bars  map[string][]DailyCandle
	errs  map[string]error
	calls int
}

func (f *fakeFeed) Daily(_ context.Context, sym string) ([]DailyCandle, error) {
	f.calls++
	return f.bars[sym], f.errs[sym]
}

func TestPullbackTickJournalsTheOtherSymbolsWhenOneFails(t *testing.T) {
	s, _ := pullbackSpec(t)
	s.Symbols = []string{"NAS100/USD", "SPX500/USD"}
	// bar 205 is a setup whose trade is still open
	var raw []DailyCandle
	for _, c := range flat(append(rising(203), 301, 300, 299)...) {
		raw = append(raw, DailyCandle{c, true})
	}
	feed := &fakeFeed{bars: map[string][]DailyCandle{"SPX500/USD": raw}, errs: map[string]error{"NAS100/USD": errors.New("HTTP 503")}}
	_, start := session(raw[204].Time)
	path := filepath.Join(t.TempDir(), "pullback.jsonl")
	p := &Pullback{Spec: s, Feed: feed, Journal: path, Start: start}
	err := p.Tick(context.Background(), func() time.Time { return time.Date(2025, 10, 30, 12, 0, 0, 0, time.UTC) })
	if err == nil || !strings.Contains(err.Error(), "pullback NAS100/USD: HTTP 503") {
		t.Fatalf("err = %v, want the NAS100/USD failure", err)
	}
	if j := read(t, path); len(j.Attempts) != 1 || j.Attempts[0].ID != "PB1/SPX500/USD/2025-10-20" || j.Attempts[0].Status != "forecast" {
		t.Fatalf("attempts %+v, want the SPX500/USD forecast", j.Attempts)
	}
}

func TestPullbackTickNamesAnEmptyWindow(t *testing.T) {
	s, _ := pullbackSpec(t)
	s.Symbols = []string{"DE30/EUR", "SPX500/USD"}
	var raw []DailyCandle
	for _, c := range flat(append(rising(203), 301, 300, 299)...) {
		raw = append(raw, DailyCandle{c, true})
	}
	// a 200 response with no candles
	feed := &fakeFeed{bars: map[string][]DailyCandle{"DE30/EUR": {}, "SPX500/USD": raw}}
	_, start := session(raw[204].Time)
	path := filepath.Join(t.TempDir(), "pullback.jsonl")
	p := &Pullback{Spec: s, Feed: feed, Journal: path, Start: start}
	err := p.Tick(context.Background(), func() time.Time { return time.Date(2025, 10, 30, 12, 0, 0, 0, time.UTC) })
	if err == nil || !strings.Contains(err.Error(), "pullback DE30/EUR: 0 completed daily bars, need 200") {
		t.Fatalf("err = %v, want the DE30/EUR empty window", err)
	}
	if j := read(t, path); len(j.Attempts) != 1 || j.Attempts[0].ID != "PB1/SPX500/USD/2025-10-20" {
		t.Fatalf("attempts %+v, want the SPX500/USD forecast", j.Attempts)
	}
}

func TestPullbackReceivedIsReadAfterTheFetch(t *testing.T) {
	s, _ := pullbackSpec(t)
	s.Symbols = []string{"SPX500/USD"}
	var raw []DailyCandle
	for _, c := range flat(append(rising(203), 301, 300, 299)...) {
		raw = append(raw, DailyCandle{c, true})
	}
	feed := &fakeFeed{bars: map[string][]DailyCandle{"SPX500/USD": raw}}
	_, start := session(raw[204].Time)
	_, decision := session(raw[205].Time)
	// the tick starts before the decision; the fetch returns after it
	clock := func() time.Time {
		if feed.calls == 0 {
			return decision.Add(-5 * time.Second)
		}
		return decision.Add(3 * time.Second)
	}
	path := filepath.Join(t.TempDir(), "pullback.jsonl")
	p := &Pullback{Spec: s, Feed: feed, Journal: path, Start: start}
	if err := p.Tick(context.Background(), clock); err != nil {
		t.Fatal(err)
	}
	j := read(t, path)
	if len(j.Attempts) != 1 || !j.Attempts[0].Decision.Equal(decision) || !j.Attempts[0].Received.Equal(decision.Add(3*time.Second)) {
		t.Fatalf("attempts %+v, want Received 3 s after decision %s", j.Attempts, decision)
	}
}

func TestPullbackJournalsEachSetupOnceAcrossARestart(t *testing.T) {
	s, _ := pullbackSpec(t)
	s.Symbols = []string{"SPX500/USD"}
	// 203..205 are a setup before go-live. 210 is a setup only when the weekend stub after
	// Friday bar 209 is dropped, and 211 is a setup while 210's trade is open.
	closes := append(rising(203), 301, 300, 299, 310, 311, 309, 308, 307, 306)
	var raw []DailyCandle
	for i, c := range flat(closes...) {
		raw = append(raw, DailyCandle{c, true})
		if i == 209 {
			stub := c.Time.In(newYork).AddDate(0, 0, 1).UTC()
			raw = append(raw, DailyCandle{backtest.Candle{Time: stub, Open: 300, High: 300, Low: 300, Close: 300}, true})
		}
	}
	next := opens(217)
	// the forming bar would exit 210's trade above its SMA5
	forming := DailyCandle{backtest.Candle{Time: next[212], Open: 306, High: 400, Low: 306, Close: 400}, false}
	feed := &fakeFeed{bars: map[string][]DailyCandle{"SPX500/USD": append(slices.Clone(raw), forming)}}
	_, start := session(next[205])
	path := filepath.Join(t.TempDir(), "pullback.jsonl")
	now := time.Date(2025, 10, 30, 12, 0, 0, 0, time.UTC)
	tick := func() []byte {
		t.Helper()
		p := &Pullback{Spec: s, Feed: feed, Journal: path, Start: start} // a new value per tick is a restart
		if err := p.Tick(context.Background(), func() time.Time { return now }); err != nil {
			t.Fatal(err)
		}
		b, _ := os.ReadFile(path)
		return b
	}

	first := tick()
	j := read(t, path)
	_, d210 := session(next[210])
	_, d211 := session(next[211])
	want := []Attempt{
		{ID: "PB1/SPX500/USD/2025-10-27", Mode: "prospective", Experiment: "PB1", SpecSHA256: s.SHA256, Decision: d210,
			Status: "forecast", Dir: 1, Expiry: d210.AddDate(0, 0, 14), Received: now},
		{ID: "PB1/SPX500/USD/2025-10-28", Mode: "prospective", Experiment: "PB1", SpecSHA256: s.SHA256, Decision: d211,
			Status: "hold", Reason: "busy", Expiry: d211.AddDate(0, 0, 14), Received: now},
	}
	for k := range j.Attempts {
		j.Attempts[k].Decision = j.Attempts[k].Decision.In(newYork)
		j.Attempts[k].Expiry = j.Attempts[k].Expiry.In(newYork)
	}
	if !reflect.DeepEqual(j.Attempts, want) || len(j.Outcomes) != 0 {
		t.Fatalf("journal %+v, want attempts %+v and no outcome", j, want)
	}
	if again := tick(); string(again) != string(first) {
		t.Fatalf("a restart changed the journal:\n%s", again)
	}

	// bar 212 completes above its SMA5, so 210's trade exits at its close
	done := DailyCandle{backtest.Candle{Time: next[212], Open: 306, High: 320, Low: 306, Close: 320}, true}
	feed.bars["SPX500/USD"] = append(slices.Clone(raw), done, DailyCandle{backtest.Candle{Time: next[213], Open: 320, High: 320, Low: 320, Close: 320}, false})
	resolved := tick()
	j = read(t, path)
	_, d212 := session(next[212])
	if len(j.Outcomes) != 1 || j.Outcomes[0].Attempt != want[0].ID || j.Outcomes[0].Exit != "sma5" ||
		!j.Outcomes[0].Matured.Equal(d212) || j.Outcomes[0].Label != "win" || j.Outcomes[0].LabelVersion != LabelVersion {
		t.Fatalf("outcomes %+v, want one sma5 win for %s at %s", j.Outcomes, want[0].ID, d212)
	}
	if again := tick(); string(again) != string(resolved) {
		t.Fatalf("a restart after the outcome changed the journal:\n%s", again)
	}

	// 215 is a setup after 210's exit bar 212, so it trades. Bar 216 stops it out and is a
	// setup too, which is busy because the trade holds through its exit bar.
	later := slices.Clone(raw)
	later = append(later, done)
	for k, c := range []float64{319, 318, 317} {
		later = append(later, DailyCandle{backtest.Candle{Time: next[213+k], Open: c, High: c, Low: c, Close: c}, true})
	}
	later = append(later, DailyCandle{backtest.Candle{Time: next[216], Open: 317, High: 317, Low: 250, Close: 316}, true})
	feed.bars["SPX500/USD"] = later
	now = time.Date(2025, 11, 5, 12, 0, 0, 0, time.UTC)
	stopped := tick()
	j = read(t, path)
	_, d215 := session(next[215])
	_, d216 := session(next[216])
	if n := len(j.Attempts); n != 4 || j.Attempts[2].ID != "PB1/SPX500/USD/2025-11-03" || j.Attempts[2].Status != "forecast" ||
		!j.Attempts[2].Decision.Equal(d215) || j.Attempts[3].ID != "PB1/SPX500/USD/2025-11-04" || j.Attempts[3].Status != "hold" ||
		j.Attempts[3].Reason != "busy" || !j.Attempts[3].Decision.Equal(d216) {
		t.Fatalf("attempts %+v, want a 215 forecast and a busy 216 hold", j.Attempts)
	}
	if len(j.Outcomes) != 2 || j.Outcomes[1].Attempt != j.Attempts[2].ID || j.Outcomes[1].Exit != "stop" || !j.Outcomes[1].Matured.Equal(d216) {
		t.Fatalf("outcomes %+v, want a stop for %s at %s", j.Outcomes, j.Attempts[2].ID, d216)
	}
	if again := tick(); string(again) != string(stopped) {
		t.Fatalf("a restart after the stop changed the journal:\n%s", again)
	}
}

func TestPullbackRecordedForecastStandsAfterARevisedClose(t *testing.T) {
	s, _ := pullbackSpec(t)
	s.Symbols = []string{"SPX500/USD"}
	days := func(c []backtest.Candle) []DailyCandle {
		var out []DailyCandle
		for _, b := range c {
			out = append(out, DailyCandle{b, true})
		}
		return out
	}
	// bar 205 is a setup whose trade is still open
	feed := &fakeFeed{bars: map[string][]DailyCandle{"SPX500/USD": days(flat(append(rising(203), 301, 300, 299)...))}}
	_, start := session(feed.bars["SPX500/USD"][204].Time)
	path := filepath.Join(t.TempDir(), "pullback.jsonl")
	tick := func(now time.Time) {
		t.Helper()
		p := &Pullback{Spec: s, Feed: feed, Journal: path, Start: start}
		if err := p.Tick(context.Background(), func() time.Time { return now }); err != nil {
			t.Fatal(err)
		}
	}
	tick(time.Date(2025, 10, 21, 12, 0, 0, 0, time.UTC))
	j := read(t, path)
	if len(j.Attempts) != 1 || j.Attempts[0].Status != "forecast" {
		t.Fatalf("attempts %+v, want the 205 forecast", j.Attempts)
	}
	forecast := j.Attempts[0].ID

	// the feed revises bar 204 to 305, so 205 is no setup any more; 207 is a setup inside
	// 205's trade, and 208 closes above its SMA5
	c := flat(append(rising(203), 301, 305, 299, 298, 297, 320)...)
	if s.setup(c, 205) || !s.setup(c, 207) {
		t.Fatal("want no setup at 205 and a setup at 207")
	}
	feed.bars["SPX500/USD"] = days(c)
	tick(time.Date(2025, 10, 24, 12, 0, 0, 0, time.UTC))
	j = read(t, path)
	_, d207 := session(c[207].Time)
	if len(j.Attempts) != 2 || j.Attempts[1].Status != "hold" || j.Attempts[1].Reason != "busy" || !j.Attempts[1].Decision.Equal(d207) {
		t.Fatalf("attempts %+v, want a busy 207 hold", j.Attempts)
	}
	if len(j.Outcomes) != 1 || j.Outcomes[0].Attempt != forecast || j.Outcomes[0].Exit != "sma5" {
		t.Fatalf("outcomes %+v, want the sma5 exit of %s", j.Outcomes, forecast)
	}
}

func TestProspectiveRecordsAreChecked(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	a := attempt("PB1/x", "forecast")
	a.Mode = "prospective"
	if err := Append(path, []Attempt{a}, nil); err == nil || !strings.Contains(err.Error(), "received time") {
		t.Fatalf("err = %v, want a missing received time refusal", err)
	}
	a.Received = a.Decision.Add(-time.Second)
	if err := Append(path, []Attempt{a}, nil); err == nil || !strings.Contains(err.Error(), "before its decision") {
		t.Fatalf("err = %v, want a received-before-decision refusal", err)
	}
	a.Received = a.Decision.Add(time.Minute)
	o := Outcome{Attempt: a.ID, LabelVersion: LabelVersion, Matured: a.Expiry, NetR: 1, Label: "win", Exit: "target"}
	if err := Append(path, []Attempt{a}, []Outcome{o}); err == nil || !strings.Contains(err.Error(), `exit "target"`) {
		t.Fatalf("err = %v, want an exit kind refusal", err)
	}
	o.Exit = "time"
	if err := Append(path, []Attempt{a}, []Outcome{o}); err != nil {
		t.Fatal(err)
	}
	if j := read(t, path); !j.Attempts[0].Received.Equal(a.Received) || j.Outcomes[0].Exit != "time" {
		t.Fatalf("read back %+v", j)
	}
}

func TestParseCandlesAcceptsStringAndNumberPrices(t *testing.T) {
	got, err := parseCandles(strings.NewReader(`{"candles":[
		{"time":"2025-10-26T21:00:00.000000000Z","complete":true,"volume":5,"mid":{"o":"1.5","h":"2","l":"1","c":"1.75"}},
		{"time":"2025-10-27T21:00:00.000000000Z","complete":false,"mid":{"o":1.75,"h":2,"l":1.5,"c":1.8}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	want := []DailyCandle{
		{backtest.Candle{Time: time.Date(2025, 10, 26, 21, 0, 0, 0, time.UTC), Open: 1.5, High: 2, Low: 1, Close: 1.75}, true},
		{backtest.Candle{Time: time.Date(2025, 10, 27, 21, 0, 0, 0, time.UTC), Open: 1.75, High: 2, Low: 1.5, Close: 1.8}, false},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseCandlesRefusesANonPositivePrice(t *testing.T) {
	for _, p := range []string{`"0"`, `-1`} {
		_, err := parseCandles(strings.NewReader(`{"candles":[
			{"time":"2025-10-26T21:00:00.000000000Z","complete":true,"mid":{"o":` + p + `,"h":"2","l":"1","c":"1.75"}}]}`))
		if err == nil || !strings.Contains(err.Error(), "is not > 0") {
			t.Errorf("open %s: err = %v, want a non-positive price refusal", p, err)
		}
	}
}
