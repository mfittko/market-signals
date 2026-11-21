package fill

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"github.com/mfittko/market-signals/platform/internal/golden"
)

func ptr(x float64) *float64 { return &x }

// TestSpecCases is the case table of docs/fill-spec.md. Long: stop 95, target 105. Short: stop 105, target 95.
func TestSpecCases(t *testing.T) {
	cases := []struct {
		name            string
		long            bool
		target          *float64
		open, high, low float64
		price           float64
		reason          string
	}{
		{"long gap stop", true, ptr(105), 94, 96, 93, 94, "stop"},
		{"long gap target", true, ptr(105), 106, 107, 105.5, 106, "target"},
		{"long gap target, stop touched intrabar", true, ptr(105), 106, 107, 94, 106, "target"},
		{"long both touched intrabar", true, ptr(105), 100, 106, 94, 95, "stop"},
		{"long stop only", true, ptr(105), 100, 101, 94, 95, "stop"},
		{"long target only", true, ptr(105), 100, 106, 99, 105, "target"},
		{"long no target", true, nil, 100, 200, 96, 0, ""},
		{"long no target, stop touched", true, nil, 100, 200, 94, 95, "stop"},
		{"long no touch", true, ptr(105), 100, 104, 96, 0, ""},
		{"long open exactly at the stop", true, ptr(105), 95, 106, 94, 95, "stop"},
		{"long open exactly at the target", true, ptr(105), 105, 106, 94, 105, "target"},
		{"short gap stop", false, ptr(95), 106, 107, 104, 106, "stop"},
		{"short gap target", false, ptr(95), 94, 94.5, 93, 94, "target"},
		{"short gap target, stop touched intrabar", false, ptr(95), 94, 106, 93, 94, "target"},
		{"short both touched intrabar", false, ptr(95), 100, 106, 94, 105, "stop"},
		{"short stop only", false, ptr(95), 100, 106, 99, 105, "stop"},
		{"short target only", false, ptr(95), 100, 101, 94, 95, "target"},
		{"short no target", false, nil, 100, 104, 1, 0, ""},
		{"short no target, stop touched", false, nil, 100, 106, 1, 105, "stop"},
		{"short no touch", false, ptr(95), 100, 104, 96, 0, ""},
		{"short open exactly at the stop", false, ptr(95), 105, 106, 94, 105, "stop"},
		{"short open exactly at the target", false, ptr(95), 95, 106, 94, 95, "target"},
	}
	for _, c := range cases {
		stop := 95.0
		if !c.long {
			stop = 105
		}
		price, reason := Check(c.long, stop, c.target, c.open, c.high, c.low)
		if price != c.price || reason != c.reason {
			t.Errorf("%s: got %v %q, want %v %q", c.name, price, reason, c.price, c.reason)
		}
	}
}

// TestPortfolioGoldenFills replays the fills steps of the Node reference case through Check
// and compares the close price and reason of every recorded trade.
func TestPortfolioGoldenFills(t *testing.T) {
	data, err := os.ReadFile("../../../test/golden/portfolio.json")
	if err != nil {
		t.Fatal(err)
	}
	f, err := golden.Decode(data, "portfolio")
	if err != nil {
		t.Fatal(err)
	}
	type closed struct {
		ID     int64   `json:"position_id"`
		Price  float64 `json:"close_price"`
		Reason string  `json:"close_reason"`
	}
	for _, c := range f.Cases {
		if c.Name != "fills-stop-target-gap" {
			continue
		}
		var in struct {
			Steps []struct {
				Op, Instrument, Side string
				Stop                 float64
				Target               *float64
				Candle               struct{ Open, High, Low float64 }
			}
		}
		var exp struct {
			Final struct {
				Trades []closed
			}
		}
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(c.Expected, &exp); err != nil {
			t.Fatal(err)
		}
		type open struct {
			id               int64
			instrument, side string
			stop             float64
			target           *float64
		}
		var positions []open
		var got []closed
		nextID := int64(1)
		for _, s := range in.Steps {
			switch s.Op {
			case "open":
				positions = append(positions, open{nextID, s.Instrument, s.Side, s.Stop, s.Target})
				nextID++
			case "fills":
				var keep []open
				for _, p := range positions {
					if p.instrument == s.Instrument {
						if price, reason := Check(p.side == "long", p.stop, p.target, s.Candle.Open, s.Candle.High, s.Candle.Low); reason != "" {
							got = append(got, closed{p.id, price, reason})
							continue
						}
					}
					keep = append(keep, p)
				}
				positions = keep
			default:
				t.Fatalf("unexpected op %q", s.Op)
			}
		}
		want, err := json.Marshal(exp.Final.Trades)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) == 0 {
			t.Fatal("no trades replayed")
		}
		if err := golden.Match(got, want); err != nil {
			t.Fatal(fmt.Errorf("%s: %w", c.Name, err))
		}
		return
	}
	t.Fatal("case fills-stop-target-gap not found")
}
