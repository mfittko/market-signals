package monitor

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/mfittko/market-signals/platform/internal/domain"
	"github.com/mfittko/market-signals/platform/internal/queue"
)

// Market is what the feed knows about one instrument right now.
type Market struct {
	Bars       []Bar     // completed M1 bars, ascending
	ATR        float64   // on the position's own timeframe; 0 when unknown
	Supertrend float64   // current line; 0 when unknown
	Halted     bool      // the engine's kill switch
	Flips      []Event   // supertrend flips on the position's timeframe
	Impulses   []Event   // volume impulses on the position's timeframe
	Price      float64   // last quote, for a wake snapshot
	AsOf       time.Time // when the feed answered
}

type Event struct {
	Time time.Time
	Dir  int // +1 buy, -1 sell; 0 for an impulse
}

// Feed supplies market data. The engine is the production source; tests use a fake.
type Feed interface {
	Market(ctx context.Context, instrument, granularity string) (Market, error)
}

// Limits keep the model's cost flat while a position is quiet.
const (
	MaxWakesPer24h   = 6
	MaxWakesPerTrade = 20
)

// Service advances every open shadow position by the bars it has not seen, applies
// the exit plan without a model, and wakes the owning agent when a tripwire fires.
type Service struct {
	Store *queue.Store
	Feed  Feed
	Log   *slog.Logger
	Now   func() time.Time
	// Enrich adds the strategy and indicators to a wake snapshot. Optional.
	Enrich func(ctx context.Context, a queue.Agent, payload json.RawMessage) (json.RawMessage, error)
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Run ticks until the context ends.
func (s *Service) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := s.Tick(ctx); err != nil && ctx.Err() == nil {
			s.Log.Error("monitor tick", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func fromQueue(p queue.Position) Position {
	best, last := p.Best, p.LastClose
	return Position{ID: p.ID, Side: p.Side, Entry: p.EntryPrice, Stop: p.Stop, Target: p.Target, Plan: p.Plan, BarsHeld: p.BarsHeld, Best: best, LastClose: last, LastFired: p.LastFired}
}

// Tick handles all open positions once. A feed error skips that instrument this tick:
// the positions keep their state and are caught up on the next one.
func (s *Service) Tick(ctx context.Context) error {
	open, err := s.Store.ListPositions(ctx, "open", 500)
	if err != nil {
		return err
	}
	markets := map[string]*Market{}
	failed := map[string]bool{}
	for _, p := range open {
		if _, err := s.Store.ReconcileFailedWakes(ctx, p.ID); err != nil {
			s.Log.Error("reconcile wakes", "position", p.ID, "err", err)
		}
		key := p.Instrument + "|" + p.Granularity
		if failed[key] {
			continue
		}
		m, ok := markets[key]
		if !ok {
			mk, err := s.Feed.Market(ctx, p.Instrument, p.Granularity)
			if err != nil {
				s.Log.Warn("monitor feed", "instrument", p.Instrument, "err", err)
				failed[key] = true
				continue
			}
			m = &mk
			markets[key] = m
		}
		if err := s.advance(ctx, p, m); err != nil {
			s.Log.Error("monitor advance", "position", p.ID, "err", err)
		}
	}
	return nil
}

// advance replays the completed bars a position has not seen, one at a time.
func (s *Service) advance(ctx context.Context, q queue.Position, m *Market) error {
	pos := fromQueue(q)
	var lastBar time.Time
	if q.LastBarTime != nil {
		lastBar = *q.LastBarTime
	}
	prevBar := lastBar
	if prevBar.IsZero() {
		prevBar = q.EntryTime
	}
	newBars := 0
	for _, b := range m.Bars {
		// the first bar to judge opens at or after the entry, so no bar is judged against a stop it could not have known
		if (!lastBar.IsZero() && !b.Time.After(lastBar)) || (lastBar.IsZero() && b.Time.Before(q.EntryTime)) {
			continue
		}
		newBars++
		env := Env{ATR: m.ATR, Supertrend: m.Supertrend, Halted: m.Halted}
		// a signal on the position's timeframe is known when its candle closes, not when it opens;
		// it counts on the one M1 bar during which it became known
		barEnd, prevEnd := b.Time.Add(time.Minute), prevBar.Add(time.Minute)
		if lastBar.IsZero() && prevBar.Equal(q.EntryTime) {
			prevEnd = q.EntryTime
		}
		becameKnown := func(e Event) bool {
			k := e.Time.Add(granDur(q.Granularity))
			return k.After(prevEnd) && !k.After(barEnd) && k.After(q.EntryTime)
		}
		for _, f := range m.Flips {
			if f.Dir == -int(pos.dir()) && becameKnown(f) {
				env.OppositeFlip = true
			}
		}
		for _, f := range m.Impulses {
			if becameKnown(f) {
				env.Impulse = true
			}
		}
		res := Step(pos, b, env)
		pos = res.Pos
		bt := b.Time
		q.LastBarTime = &bt
		prevBar = b.Time
		if res.Exit != nil {
			won, err := s.Store.ClosePosition(ctx, q.ID, res.Exit.Price, b.Time, res.Exit.Reason)
			if err != nil {
				return err
			}
			if won {
				s.Log.Info("position closed", "position", q.ID, "reason", res.Exit.Reason, "price", res.Exit.Price)
			}
			return nil
		}
		q.Stop, q.Plan, q.BarsHeld, q.Best, q.LastClose, q.LastFired = pos.Stop, pos.Plan, pos.BarsHeld, pos.Best, pos.LastClose, pos.LastFired
		if err := s.Store.SavePosition(ctx, q); err != nil {
			return err
		}
		if res.Trailed {
			_ = s.Store.AddPositionEvent(ctx, q.ID, "trail", map[string]any{"stop": pos.Stop, "bar": b.Time})
		}
		for _, tw := range res.Fired {
			s.wake(ctx, q, tw, b.Time, b.Close, m)
		}
	}
	// a silent feed still matters: feed_stale tripwires look at the age of the newest complete bar
	if newBars == 0 && len(m.Bars) > 0 {
		age := s.now().Sub(m.Bars[len(m.Bars)-1].Time.Add(time.Minute)).Minutes()
		for _, tw := range pos.Plan.Tripwires {
			if tw.Kind != "feed_stale" || age < float64(tw.Minutes) {
				continue
			}
			k := Key(tw)
			if last, seen := pos.LastFired[k]; seen && pos.BarsHeld-last < CooldownBars {
				continue
			}
			pos.LastFired[k] = pos.BarsHeld
			q.LastFired = pos.LastFired
			if err := s.Store.SavePosition(ctx, q); err != nil {
				return err
			}
			s.wake(ctx, q, tw, m.Bars[len(m.Bars)-1].Time, m.Price, m)
		}
	}
	return nil
}

// wake enqueues one run for the owning agent, inside the wake limits. It never blocks the
// deterministic rules: a skipped or failed wake leaves the stop in force.
func (s *Service) wake(ctx context.Context, q queue.Position, tw domain.Tripwire, barTime time.Time, price float64, m *Market) {
	skip := func(why string) {
		_ = s.Store.AddPositionEvent(ctx, q.ID, "wake_skipped", map[string]any{"tripwire": tw.Kind, "why": why, "bar": barTime})
	}
	agent, err := s.Store.GetAgent(ctx, q.AgentID)
	if err != nil || !agent.Enabled {
		skip("the agent is off; the exit plan still applies")
		return
	}
	ws, err := s.Store.WakeState(ctx, q.ID, s.now())
	if err != nil {
		s.Log.Error("wake state", "position", q.ID, "err", err)
		return
	}
	switch {
	case ws.InFlight:
		skip("an earlier wake has not finished")
		return
	case ws.Last24h >= MaxWakesPer24h:
		skip(fmt.Sprintf("%d wakes in 24 hours already", ws.Last24h))
		return
	case q.Wakes >= MaxWakesPerTrade:
		skip(fmt.Sprintf("%d wakes for this trade already", q.Wakes))
		return
	}
	if price <= 0 {
		price = q.LastClose
	}
	body := map[string]any{
		"instrument": q.Instrument, "granularity": q.Granularity, "event": "tripwire",
		"close": price, "quote": map[string]any{"last": price},
		"portfolio": map[string]any{"halted": m.Halted},
		"wake":      map[string]any{"positionId": q.ID, "side": q.Side, "entry": q.EntryPrice, "stop": q.Stop, "price": price, "tripwire": tw.Kind},
		"position": map[string]any{
			"id": q.ID, "side": q.Side, "entry": q.EntryPrice, "stop": q.Stop, "initialStop": q.InitialStop, "target": q.Target,
			"barsHeld": q.BarsHeld, "bestClose": q.Best, "lastClose": q.LastClose, "plan": q.Plan,
			"unrealizedPct": pct(q.Side, q.EntryPrice, price), "openedByRun": q.RunID,
		},
		"tripwire": tw,
	}
	raw, _ := json.Marshal(body)
	if s.Enrich != nil {
		if e, err := s.Enrich(ctx, agent, raw); err == nil {
			raw = e
		}
	}
	res, err := s.Store.Ingest(ctx, queue.IngestInput{
		IdemKey: fmt.Sprintf("wake:%d:%s:%d", q.ID, Key(tw), barTime.Unix()), Instrument: q.Instrument, Granularity: q.Granularity,
		Event: "tripwire", Source: "monitor", Trigger: "tripwire:" + tw.Kind, Payload: raw, AgentID: q.AgentID,
	})
	if err != nil || len(res.Runs) == 0 {
		s.Log.Error("wake ingest", "position", q.ID, "err", err)
		return
	}
	if !res.Runs[0].Created { // the same bar and tripwire were already woken for
		return
	}
	_ = s.Store.RecordWake(ctx, q.ID, res.Runs[0].RunID, map[string]any{"tripwire": tw.Kind, "bar": barTime, "price": price})
}

func pct(side string, entry, price float64) float64 {
	if entry <= 0 {
		return 0
	}
	d := 1.0
	if side == "short" {
		d = -1
	}
	return float64(int(d*(price-entry)/entry*1e6)) / 1e4
}

// SortBars orders bars ascending; feeds call it before returning.
func SortBars(b []Bar) { sort.Slice(b, func(i, j int) bool { return b[i].Time.Before(b[j].Time) }) }

func granDur(g string) time.Duration {
	switch g {
	case "M5":
		return 5 * time.Minute
	case "M15":
		return 15 * time.Minute
	case "M30":
		return 30 * time.Minute
	case "H1":
		return time.Hour
	case "H4":
		return 4 * time.Hour
	}
	return time.Minute
}
