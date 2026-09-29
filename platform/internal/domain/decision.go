// Package domain holds the deterministic rules an agent proposal must pass
// before anything could ever be committed. Agents propose; this code judges.
package domain

import (
	"errors"
	"fmt"
	"math"
	"time"
)

// Decision is the typed proposal. Field names match the engine's journal.
type Decision struct {
	Action     string   `json:"action"`
	Side       string   `json:"side,omitempty"`
	Notional   float64  `json:"notional,omitempty"`
	Stop       float64  `json:"stop,omitempty"`
	Target     *float64 `json:"target,omitempty"`
	PositionID int64    `json:"positionId,omitempty"`
	Reasoning  string   `json:"reasoning,omitempty"`
}

func finitePositive(v float64) bool { return v > 0 && !math.IsInf(v, 0) && !math.IsNaN(v) }

// CheckShape mirrors the engine's parseDecision rules.
func (d Decision) CheckShape() error {
	switch d.Action {
	case "hold":
		return nil
	case "open":
		if d.Side != "long" && d.Side != "short" {
			return errors.New("open needs side long|short")
		}
		if !finitePositive(d.Notional) {
			return errors.New("open needs a positive notional")
		}
		if !finitePositive(d.Stop) {
			return errors.New("open needs a stop")
		}
		if d.Target != nil && !finitePositive(*d.Target) {
			return errors.New("target must be positive")
		}
		return nil
	case "close":
		if d.PositionID <= 0 {
			return errors.New("close needs a positionId")
		}
		return nil
	}
	return fmt.Errorf("unknown action %q", d.Action)
}

// Hold builds a fail-safe hold.
func Hold(reason string) Decision {
	if len(reason) > 200 {
		reason = reason[:200]
	}
	return Decision{Action: "hold", Reasoning: reason}
}

// Validation is the deterministic verdict on a proposal. Committed is always
// false in shadow mode: no proposal reaches the ledger.
type Validation struct {
	Valid            bool     `json:"valid"`
	Reasons          []string `json:"reasons"`
	FreshnessSeconds float64  `json:"freshnessSeconds"`
	PriceUsed        float64  `json:"priceUsed"`
	Committed        bool     `json:"committed"`
}

// SnapshotFacts is what validation needs from the frozen snapshot.
type SnapshotFacts struct {
	Instrument string
	Price      float64
	Halted     bool
	Positions  map[int64]string // position id -> instrument
	TakenAt    time.Time
}

// FactsFromPayload pulls validation inputs out of a snapshot payload.
func FactsFromPayload(instrument string, payload map[string]any, takenAt time.Time) SnapshotFacts {
	f := SnapshotFacts{Instrument: instrument, Positions: map[int64]string{}, TakenAt: takenAt}
	if q, ok := payload["quote"].(map[string]any); ok {
		if v, ok := q["last"].(float64); ok {
			f.Price = v
		}
	}
	if f.Price == 0 {
		if v, ok := payload["close"].(float64); ok {
			f.Price = v
		}
	}
	if pf, ok := payload["portfolio"].(map[string]any); ok {
		if h, ok := pf["halted"].(bool); ok {
			f.Halted = h
		}
		if ps, ok := pf["positions"].([]any); ok {
			for _, p := range ps {
				pm, _ := p.(map[string]any)
				id, _ := pm["id"].(float64)
				inst, _ := pm["instrument"].(string)
				if id > 0 {
					f.Positions[int64(id)] = inst
				}
			}
		}
	}
	return f
}

// ValidateProposal applies freshness, halt, side/stop and ownership checks.
func ValidateProposal(d Decision, f SnapshotFacts, now time.Time, maxAge time.Duration) Validation {
	v := Validation{Valid: true, Reasons: []string{}, PriceUsed: f.Price, Committed: false}
	v.FreshnessSeconds = math.Round(now.Sub(f.TakenAt).Seconds()*10) / 10
	fail := func(msg string) { v.Valid = false; v.Reasons = append(v.Reasons, msg) }
	if err := d.CheckShape(); err != nil {
		fail(err.Error())
		return v
	}
	if maxAge > 0 && now.Sub(f.TakenAt) > maxAge {
		fail(fmt.Sprintf("snapshot is %.0fs old, over the %.0fs freshness limit", now.Sub(f.TakenAt).Seconds(), maxAge.Seconds()))
	}
	if d.Action == "hold" {
		return v
	}
	if f.Halted {
		fail("portfolio is halted; only hold is allowed")
	}
	switch d.Action {
	case "open":
		if f.Price <= 0 {
			fail("snapshot has no price to size against")
			break
		}
		long := d.Side == "long"
		if (long && d.Stop >= f.Price) || (!long && d.Stop <= f.Price) {
			fail(fmt.Sprintf("stop %v is on the wrong side of entry %v for %s", d.Stop, f.Price, d.Side))
		}
		if d.Target != nil && ((long && *d.Target <= f.Price) || (!long && *d.Target >= f.Price)) {
			fail(fmt.Sprintf("target %v is on the wrong side of entry %v for %s", *d.Target, f.Price, d.Side))
		}
	case "close":
		inst, ok := f.Positions[d.PositionID]
		if !ok {
			fail(fmt.Sprintf("unknown position %d", d.PositionID))
		} else if inst != f.Instrument {
			fail(fmt.Sprintf("position %d belongs to %s, not %s", d.PositionID, inst, f.Instrument))
		}
	}
	return v
}

// Compare classifies the agent proposal against the engine's own decision.
func Compare(proposal, legacy Decision) string {
	if proposal.Action != legacy.Action {
		return "differ"
	}
	if proposal.Action == "open" && proposal.Side != legacy.Side {
		return "differ"
	}
	return "agree"
}
