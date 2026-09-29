package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"math"

	"github.com/mfittko/market-signals/platform/internal/domain"
)

// Mock is a deterministic, offline runtime. It follows supertrend flips the
// way the default strategy prose does, reads only through the tool gateway and
// defers when the price comes from a forming candle. It makes the whole
// pipeline testable without a model or a network.
type Mock struct{}

func (Mock) Name() string               { return "mock" }
func (Mock) Capabilities() Capabilities { return caps(true, true, true) }

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

func has(in Input, name string) bool {
	for _, d := range in.Tools.Defs() {
		if d.Name == name {
			return true
		}
	}
	return false
}

func (Mock) Run(ctx context.Context, in Input) (*Output, error) {
	out := &Output{Usage: map[string]float64{"toolCalls": 0}}
	call := func(name string, args string) (string, bool, error) {
		out.Usage["toolCalls"]++
		in.Emit("step", map[string]any{"text": "calling " + name})
		return in.Tools.Call(ctx, name, json.RawMessage(args))
	}
	raw, isErr, err := call("get_snapshot", "{}")
	if err != nil {
		return nil, err
	}
	if isErr {
		return nil, fmt.Errorf("snapshot unavailable: %s", raw)
	}
	s, err := parseSnap(raw)
	if err != nil {
		return nil, fmt.Errorf("bad snapshot: %w", err)
	}
	hold := func(why string) (*Output, error) {
		d := domain.Hold(why)
		out.Proposal, out.StopReason = &d, "hold"
		in.Emit("step", map[string]any{"text": "decision: hold — " + why})
		return out, nil
	}

	pf := s.Portfolio
	if has(in, "get_portfolio") {
		if txt, isErr, err := call("get_portfolio", "{}"); err != nil {
			return nil, err
		} else if !isErr {
			var live portfolio
			if json.Unmarshal([]byte(txt), &live) == nil {
				pf = live
				in.Emit("step", map[string]any{"text": "using the live portfolio from the engine"})
			}
		} else {
			in.Emit("step", map[string]any{"text": "engine portfolio unavailable, using the snapshot copy: " + txt})
		}
	}
	if pf.Halted {
		return hold("portfolio is halted")
	}
	if s.Flip == nil || (s.Flip.Signal != "buy" && s.Flip.Signal != "sell") {
		return hold("no supertrend flip to follow")
	}
	if s.Flip.Fresh != nil && !*s.Flip.Fresh {
		return hold(fmt.Sprintf("latest flip is %d bars old, not a live event", s.Flip.BarsAgo))
	}
	if s.Backtest != nil && s.Backtest.WinRate > 0 && s.Backtest.WinRate < 40 {
		return hold(fmt.Sprintf("flip backtest win rate %.0f%% is below 40%%", s.Backtest.WinRate))
	}
	side := map[string]string{"buy": "long", "sell": "short"}[s.Flip.Signal]
	for _, p := range pf.Positions {
		if p.Instrument != s.Instrument {
			continue
		}
		if p.Side != side {
			d := domain.Decision{Action: "close", PositionID: p.ID, Reasoning: "opposite flip: close the " + p.Side + " position"}
			out.Proposal, out.StopReason = &d, "close"
			return out, nil
		}
		return hold("already positioned " + side)
	}
	price := s.price()
	if price <= 0 {
		return hold("snapshot carries no price")
	}
	if s.Quote.Provisional && in.Claim.Run.FollowupsUsed == 0 && has(in, "schedule_followup") {
		if _, isErr, err := call("schedule_followup", `{"seconds":15,"reason":"price is from a forming candle; re-check after it closes"}`); err != nil {
			return nil, err
		} else if !isErr {
			return hold("deferring: price is from a forming candle, follow-up scheduled")
		}
	}
	stop := round3(price * 0.995)
	if side == "short" {
		stop = round3(price * 1.005)
	}
	if side == "long" && s.Supertrend > 0 && s.Supertrend < price {
		stop = round3(s.Supertrend - 0.01*price/100)
	}
	if side == "short" && s.Supertrend > price {
		stop = round3(s.Supertrend + 0.01*price/100)
	}
	risk := math.Abs(price - stop)
	target := round3(price + 1.5*risk)
	if side == "short" {
		target = round3(price - 1.5*risk)
	}
	notional := math.Round(math.Min(pf.Equity*0.05, pf.Cash)*100) / 100
	if notional <= 0 {
		return hold("no cash to size a position")
	}
	d := domain.Decision{Action: "open", Side: side, Notional: notional, Stop: stop, Target: &target,
		Reasoning: fmt.Sprintf("follow the %s flip; stop beyond the supertrend line, target 1.5R", s.Flip.Signal)}
	out.Proposal, out.StopReason = &d, "open"
	in.Emit("step", map[string]any{"text": fmt.Sprintf("decision: open %s @ ~%v stop %v target %v", side, price, stop, target)})
	return out, nil
}
