// Package monitor watches shadow positions without a model. Step is the pure
// core: one completed bar in, fills, trailing, time stop, kill switch and fired
// tripwires out. The service around it fetches bars, persists and wakes agents.
package monitor

import (
	"encoding/json"
	"math"
	"time"

	"github.com/mfittko/market-signals/platform/internal/domain"
)

// CooldownBars is how many held bars must pass before the same tripwire may fire again.
const CooldownBars = 5

type Bar struct {
	Time                           time.Time
	Open, High, Low, Close, Volume float64
}

// Position is the state Step needs and returns. It carries no clock and no I/O.
type Position struct {
	ID        int64
	Side      string // long | short
	Entry     float64
	Stop      float64
	Target    *float64
	Plan      domain.Plan // Plan.Tripwires are the live wake conditions
	BarsHeld  int
	Best      float64        // best close since entry: highest for a long, lowest for a short; 0 means Entry
	LastClose float64        // previous bar's close; 0 means Entry
	LastFired map[string]int // tripwire key -> BarsHeld when it last fired
}

// Env is what the service knows about the market at this bar.
type Env struct {
	ATR              float64 // 0 when unknown
	Supertrend       float64 // 0 when unknown
	Halted           bool    // the engine's kill switch
	OppositeFlip     bool
	Impulse          bool
	NewsEscalation   bool
	FeedStaleMinutes float64
}

type Exit struct {
	Price  float64
	Reason string // stop | target | invalidated | time_stop | kill_switch
}

type Result struct {
	Pos     Position
	Exit    *Exit
	Trailed bool // the trail moved the stop this bar
	Fired   []domain.Tripwire
}

func (p Position) dir() float64 {
	if p.Side == "short" {
		return -1
	}
	return 1
}

// Key identifies a tripwire for cooldown purposes.
func Key(t domain.Tripwire) string { b, _ := json.Marshal(t); return string(b) }

// Step applies one completed bar. Order matters and is fixed:
// fills (the stop wins when both touch), kill switch, invalidation, time stop,
// trailing, tripwires. The trailed stop takes effect from the next bar, so a
// bar never fills against a stop it could not have known about.
func Step(p Position, b Bar, env Env) Result {
	if p.Best == 0 {
		p.Best = p.Entry
	}
	prevClose := p.LastClose
	if prevClose == 0 {
		prevClose = p.Entry
	}
	fired := make(map[string]int, len(p.LastFired))
	for k, v := range p.LastFired {
		fired[k] = v
	}
	p.LastFired = fired
	res := Result{Pos: p}
	exit := func(price float64, reason string) Result {
		res.Pos.LastClose = b.Close
		res.Exit = &Exit{Price: price, Reason: reason}
		return res
	}
	long := p.Side != "short"

	// 1. fills against the stop in force when the bar opened. A gap through the stop fills at the open.
	if long && b.Low <= p.Stop {
		return exit(math.Min(p.Stop, b.Open), "stop")
	}
	if !long && b.High >= p.Stop {
		return exit(math.Max(p.Stop, b.Open), "stop")
	}
	if p.Target != nil {
		if long && b.High >= *p.Target {
			return exit(*p.Target, "target")
		}
		if !long && b.Low <= *p.Target {
			return exit(*p.Target, "target")
		}
	}
	// 2. the engine's kill switch closes everything at the bar close
	if env.Halted {
		return exit(b.Close, "kill_switch")
	}
	// 3. invalidation: a close beyond the level against the position voids the idea
	if inv := p.Plan.Invalidation; inv != nil {
		if (long && b.Close < *inv) || (!long && b.Close > *inv) {
			return exit(b.Close, "invalidated")
		}
	}
	// the bar is held
	p.BarsHeld++
	if (long && b.Close > p.Best) || (!long && b.Close < p.Best) {
		p.Best = b.Close
	}
	// 4. time stop
	if p.Plan.MaxBars > 0 && p.BarsHeld >= p.Plan.MaxBars {
		res.Pos = p
		return exit(b.Close, "time_stop")
	}
	// 5. trailing: the stop moves toward price only, and stays behind the close
	if tr := p.Plan.Trail; tr != nil {
		var cand float64
		switch {
		case tr.Kind == "atr" && env.ATR > 0:
			cand = p.Best - p.dir()*tr.Mult*env.ATR
		case tr.Kind == "supertrend" && env.Supertrend > 0:
			cand = env.Supertrend
		}
		if cand > 0 && ((long && cand > p.Stop && cand < b.Close) || (!long && cand < p.Stop && cand > b.Close)) {
			p.Stop = cand
			res.Trailed = true
		}
	}
	// 6. tripwires, each on its own cooldown
	for _, t := range p.Plan.Tripwires {
		if !tripped(t, p, b, env, prevClose) {
			continue
		}
		k := Key(t)
		last, seen := p.LastFired[k]
		if seen && (t.Kind == "no_progress" || p.BarsHeld-last < CooldownBars) {
			continue
		}
		p.LastFired[k] = p.BarsHeld
		res.Fired = append(res.Fired, t)
	}
	p.LastClose = b.Close
	res.Pos = p
	return res
}

func tripped(t domain.Tripwire, p Position, b Bar, env Env, prevClose float64) bool {
	adverse := -p.dir() * (b.Close - p.Entry) // positive when the close is against the position
	switch t.Kind {
	case "close_beyond":
		return (t.Dir == "above" && b.Close > t.Level) || (t.Dir == "below" && b.Close < t.Level)
	case "price_cross":
		return (t.Dir == "up" && prevClose < t.Level && b.High >= t.Level) || (t.Dir == "down" && prevClose > t.Level && b.Low <= t.Level)
	case "adverse_pct":
		return p.Entry > 0 && adverse/p.Entry*100 >= t.Pct
	case "adverse_atr":
		return env.ATR > 0 && adverse/env.ATR >= t.ATR
	case "no_progress":
		min := t.MinProfitATR
		if min == 0 {
			min = 0.5
		}
		return env.ATR > 0 && p.BarsHeld >= t.Bars && -adverse/env.ATR < min
	case "opposite_flip":
		return env.OppositeFlip
	case "impulse":
		return env.Impulse
	case "news_escalation":
		return env.NewsEscalation
	case "feed_stale":
		return env.FeedStaleMinutes >= float64(t.Minutes)
	}
	return false
}

// PnL is the realized result of a shadow position. See domain.PnL.
func PnL(side string, notional, entry, exit float64) float64 {
	return domain.PnL(side, notional, entry, exit)
}
