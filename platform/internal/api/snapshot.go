package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"time"

	"github.com/mfittko/market-signals/platform/fixtures"
	"github.com/mfittko/market-signals/platform/internal/domain"
	"github.com/mfittko/market-signals/platform/internal/queue"
	"github.com/mfittko/market-signals/platform/internal/tools"
)

func demoSnapshot(a queue.Agent) (json.RawMessage, error) {
	var m map[string]any
	if err := json.Unmarshal(fixtures.DemoFlip, &m); err != nil {
		return nil, err
	}
	m["instrument"], m["granularity"] = a.Instrument, a.Granularity
	m["capturedAt"] = time.Now().UTC().Format(time.RFC3339)
	return json.Marshal(m)
}

// operatorSnapshot freezes the engine's current view for one agent. Only
// COMPLETE candles enter the snapshot; the forming candle is excluded and the
// quote is labelled so it can never pass as a completed-bar price.
func operatorSnapshot(ctx context.Context, eng *tools.Engine, a queue.Agent) (json.RawMessage, error) {
	var chart struct {
		Candles    []map[string]any `json:"candles"`
		Signal     map[string]any   `json:"signal"`
		Supertrend []struct {
			Value float64 `json:"value"`
			Trend string  `json:"trend"`
		} `json:"supertrend"`
		AxisGate any            `json:"axisGate"`
		Quote    map[string]any `json:"quote"`
		BotState map[string]any `json:"botState"`
	}
	q := url.Values{"instrument": {a.Instrument}, "granularity": {a.Granularity}}
	if err := eng.Get(ctx, "/api/chart", q, &chart); err != nil {
		return nil, err
	}
	var pf struct {
		Portfolio map[string]any `json:"portfolio"`
	}
	if err := eng.Get(ctx, "/api/portfolio", nil, &pf); err != nil {
		return nil, err
	}
	done := []map[string]any{}
	for _, c := range chart.Candles {
		if tools.Formed(c) {
			done = append(done, c)
		}
	}
	if len(done) == 0 {
		return nil, errors.New("engine returned no complete candles")
	}
	last := done[len(done)-1]
	// a flip's age is measured in complete bars since it printed
	if sigTime, _ := chart.Signal["time"].(string); sigTime != "" {
		barsAgo := 0
		for _, c := range done {
			if t, _ := c["time"].(string); t > sigTime {
				barsAgo++
			}
		}
		chart.Signal["barsAgo"], chart.Signal["fresh"] = barsAgo, barsAgo <= 3
	}
	if len(done) > 30 {
		done = done[len(done)-30:]
	}
	f := domain.SnapshotFields{
		Instrument: a.Instrument, Granularity: a.Granularity, Event: "operator",
		AsOf: last["time"], Close: last["close"], Candles: done,
		Quote: map[string]any{"last": chart.Quote["last"], "provisional": chart.Quote["partial"]},
		Flip:  chart.Signal,
		Portfolio: map[string]any{
			"equity": pf.Portfolio["equity"], "cash": pf.Portfolio["cash"], "halted": pf.Portfolio["halted"], "positions": pf.Portfolio["positions"],
		},
		AxisGate:       chart.AxisGate,
		EngineStrategy: map[string]any{"name": chart.BotState["strategyRef"]},
	}
	if chart.Signal == nil {
		f.Flip = nil // a nil map in an interface is not nil
	}
	// indicator levels a strategy prompt refers to (ATR, EMAs, Bollinger, recent extremes); a failure only omits them
	var ind struct {
		Indicators any `json:"indicators"`
	}
	if err := eng.Get(ctx, "/api/indicators", q, &ind); err == nil {
		f.Indicators = ind.Indicators
	}
	// advisory context the old bot also saw; a failure only omits it
	var dc struct {
		TraderMemories any `json:"traderMemories"`
		Sentinel       any `json:"sentinel"`
	}
	if err := eng.Get(ctx, "/api/decision-context", url.Values{"instrument": {a.Instrument}}, &dc); err == nil {
		f.TraderMemories, f.Sentinel = dc.TraderMemories, dc.Sentinel
	}
	if n := len(chart.Supertrend); n > 0 {
		f.Supertrend, f.Trend = chart.Supertrend[n-1].Value, chart.Supertrend[n-1].Trend
	}
	snap := domain.Snapshot(f)
	snap["capturedAt"] = time.Now().UTC().Format(time.RFC3339)
	return domain.EncodeSnapshot(snap)
}

// engineEventSnapshot maps the Node engine's payload into the shared shape: the
// fields under context move to top level and its strategy becomes engineStrategy.
// Fields outside the shared set stay as the engine sent them. A payload that is not
// a JSON object is returned unchanged.
func engineEventSnapshot(instrument, granularity, event string, payload json.RawMessage) json.RawMessage {
	var n map[string]any
	if json.Unmarshal(payload, &n) != nil || n == nil {
		return payload
	}
	c, _ := n["context"].(map[string]any)
	snap := domain.Snapshot(domain.SnapshotFields{
		Instrument: instrument, Granularity: granularity, Event: event,
		AsOf: n["asOf"], Close: n["close"], Quote: n["quote"], Flip: n["flip"], Trend: n["trend"], Supertrend: n["supertrend"],
		Candles: n["candles"], Portfolio: n["portfolio"], Indicators: n["indicators"], EngineStrategy: n["strategy"],
		AxisGate: c["axisGate"], TraderMemories: c["traderMemories"], Sentinel: c["sentinel"],
	})
	for k, v := range n {
		if _, set := snap[k]; !set && k != "context" && k != "strategy" {
			snap[k] = v
		}
	}
	out, err := domain.EncodeSnapshot(snap)
	if err != nil {
		return payload
	}
	return out
}

type chartCandle struct {
	Time   string  `json:"time"`
	Open   float64 `json:"open"`
	High   float64 `json:"high"`
	Low    float64 `json:"low"`
	Close  float64 `json:"close"`
	Volume float64 `json:"volume"`
}

// chartCandles returns complete candles only. It prefers the frozen copy in the
// snapshot; without one it reads the engine's current window, labelled as live.
// When the snapshot's time lies outside that window it returns no candles and a
// reason; the error is kept for an unreachable engine.
func chartCandles(ctx context.Context, eng *tools.Engine, instrument, granularity string, payload json.RawMessage) ([]chartCandle, string, string, error) {
	var snap struct {
		AsOf    string        `json:"asOf"`
		Candles []chartCandle `json:"candles"`
	}
	if json.Unmarshal(payload, &snap) == nil && len(snap.Candles) >= 5 {
		return snap.Candles, "snapshot", "", nil
	}
	var raw struct {
		Candles []struct {
			chartCandle
			Complete *bool `json:"complete"`
			Partial  bool  `json:"partial"`
		} `json:"candles"`
	}
	q := url.Values{"instrument": {instrument}, "granularity": {granularity}}
	if err := eng.Get(ctx, "/api/chart", q, &raw); err != nil {
		return nil, "", "", err
	}
	out := []chartCandle{}
	for _, c := range raw.Candles {
		if (c.Complete == nil || *c.Complete) && !c.Partial {
			out = append(out, c.chartCandle)
		}
	}
	if len(out) > 60 {
		out = out[len(out)-60:]
	}
	// A snapshot without candles (the bundled demo) refers to a moment the live
	// window may not cover. Drawing its levels over unrelated candles misleads.
	if snap.AsOf != "" && (len(out) == 0 || snap.AsOf < out[0].Time || snap.AsOf > out[len(out)-1].Time) {
		return []chartCandle{}, "none", "this snapshot's time is outside the engine's current candle window and the snapshot holds no candles", nil
	}
	return out, "engine", "", nil
}

// withIndicators adds the engine's indicator levels to a snapshot that lacks them.
// Complete-candle values hold until the bar closes, so a fetch moments after the
// event matches the moment it describes. A failure leaves the payload unchanged.
func (s *Server) withIndicators(ctx context.Context, instrument, granularity string, payload json.RawMessage) json.RawMessage {
	var m map[string]any
	if json.Unmarshal(payload, &m) != nil || m == nil { // a null payload has no map to extend
		return payload
	}
	if _, has := m["indicators"]; has {
		return payload
	}
	var ind struct {
		Indicators map[string]any `json:"indicators"`
	}
	q := url.Values{"instrument": {instrument}, "granularity": {granularity}}
	if err := s.eng.Get(ctx, "/api/indicators", q, &ind); err != nil || ind.Indicators == nil {
		return payload
	}
	m["indicators"] = ind.Indicators
	if out, err := domain.EncodeSnapshot(m); err == nil {
		return out
	}
	return payload
}

// WakeEnricher gives the position monitor the same indicator context an entry
// check gets, so a tripwire wake judges with the numbers the entry used. The
// strategy comes from the run, which the queue freezes at enqueue time.
func (s *Server) WakeEnricher() func(context.Context, queue.Agent, json.RawMessage) (json.RawMessage, error) {
	return func(ctx context.Context, a queue.Agent, p json.RawMessage) (json.RawMessage, error) {
		return s.withIndicators(ctx, a.Instrument, a.Granularity, p), nil
	}
}
