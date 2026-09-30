package domain

import (
	"fmt"
	"math"
)

// Plan is the exit plan an agent attaches to an entry. The monitor enforces it
// without a model. Everything here is data with a small fixed vocabulary.
type Plan struct {
	// Invalidation is a price level: the trade idea is void once a bar closes beyond it against the position.
	Invalidation *float64 `json:"invalidation,omitempty"`
	// Trail moves the stop toward price by a deterministic rule. A stop never moves away.
	Trail *Trail `json:"trail,omitempty"`
	// MaxBars is the time stop, counted in monitor bars held.
	MaxBars   int        `json:"maxBars,omitempty"`
	Tripwires []Tripwire `json:"tripwires,omitempty"`
}

// Trail kinds: "atr" trails the best close by Mult times ATR; "supertrend" follows the Supertrend line.
type Trail struct {
	Kind string  `json:"kind"`
	Mult float64 `json:"mult,omitempty"`
}

// Tripwire is a declarative condition that wakes the agent. Kinds and their fields:
//
//	close_beyond   level, dir above|below   a bar closes beyond the level
//	price_cross    level, dir up|down       price crosses the level within a bar
//	adverse_pct    pct                      close is pct percent against entry
//	adverse_atr    atr                      close is atr ATRs against entry
//	no_progress    bars, minProfitAtr       held bars without minProfitAtr (default 0.5) of profit
//	opposite_flip                           the engine prints a flip against the position
//	impulse                                 the engine records a volume impulse
//	news_escalation                         the sentinel flags an escalation
//	feed_stale     minutes                  no new complete bar for that long
type Tripwire struct {
	Kind         string  `json:"kind"`
	Level        float64 `json:"level,omitempty"`
	Dir          string  `json:"dir,omitempty"`
	Pct          float64 `json:"pct,omitempty"`
	ATR          float64 `json:"atr,omitempty"`
	Bars         int     `json:"bars,omitempty"`
	MinProfitATR float64 `json:"minProfitAtr,omitempty"`
	Minutes      int     `json:"minutes,omitempty"`
}

// MaxTripwires bounds a plan so a model cannot buy itself unlimited wake-ups.
const MaxTripwires = 8

func pos(v float64) bool { return v > 0 && !math.IsInf(v, 0) && !math.IsNaN(v) }

// Check rejects a tripwire the monitor could not evaluate.
func (t Tripwire) Check() error {
	switch t.Kind {
	case "close_beyond":
		if !pos(t.Level) || (t.Dir != "above" && t.Dir != "below") {
			return fmt.Errorf("close_beyond needs level and dir above|below")
		}
	case "price_cross":
		if !pos(t.Level) || (t.Dir != "up" && t.Dir != "down") {
			return fmt.Errorf("price_cross needs level and dir up|down")
		}
	case "adverse_pct":
		if !pos(t.Pct) || t.Pct > 50 {
			return fmt.Errorf("adverse_pct needs pct between 0 and 50")
		}
	case "adverse_atr":
		if !pos(t.ATR) || t.ATR > 50 {
			return fmt.Errorf("adverse_atr needs atr between 0 and 50")
		}
	case "no_progress":
		if t.Bars < 2 || t.Bars > 1000 {
			return fmt.Errorf("no_progress needs bars between 2 and 1000")
		}
		if t.MinProfitATR < 0 || t.MinProfitATR > 20 {
			return fmt.Errorf("no_progress minProfitAtr must be between 0 and 20")
		}
	case "opposite_flip", "impulse", "news_escalation":
	case "feed_stale":
		if t.Minutes < 2 || t.Minutes > 1440 {
			return fmt.Errorf("feed_stale needs minutes between 2 and 1440")
		}
	default:
		return fmt.Errorf("unknown tripwire %q", t.Kind)
	}
	return nil
}

// CheckTripwires validates a list and its size.
func CheckTripwires(ts []Tripwire) error {
	if len(ts) > MaxTripwires {
		return fmt.Errorf("at most %d tripwires", MaxTripwires)
	}
	for i, t := range ts {
		if err := t.Check(); err != nil {
			return fmt.Errorf("tripwire %d: %w", i+1, err)
		}
	}
	return nil
}

// Check validates a plan for an entry on the given side. The monitor reads
// invalidation and adverse moves against the side, so the side must be known.
func (p Plan) Check(side string) error {
	if side != "long" && side != "short" {
		return fmt.Errorf("plan needs side long|short, got %q", side)
	}
	if p.Invalidation != nil && !pos(*p.Invalidation) {
		return fmt.Errorf("invalidation must be a positive price")
	}
	if p.Trail != nil {
		switch p.Trail.Kind {
		case "atr":
			if !pos(p.Trail.Mult) || p.Trail.Mult > 20 {
				return fmt.Errorf("atr trail needs mult between 0 and 20")
			}
		case "supertrend":
		default:
			return fmt.Errorf("unknown trail %q", p.Trail.Kind)
		}
	}
	if p.MaxBars < 0 || p.MaxBars > 100000 {
		return fmt.Errorf("maxBars out of range")
	}
	return CheckTripwires(p.Tripwires)
}

// PnL is the realized result of a shadow position: notional times the return, signed by side.
func PnL(side string, notional, entry, exit float64) float64 {
	if entry <= 0 {
		return 0
	}
	d := 1.0
	if side == "short" {
		d = -1
	}
	return math.Round(notional*d*(exit-entry)/entry*10000) / 10000
}
