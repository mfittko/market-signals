package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"time"

	"github.com/mfittko/market-signals/platform/fixtures"
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

// buildEngineSnapshot freezes the engine's current view for one agent. Only
// COMPLETE candles enter the snapshot; the forming candle is excluded and the
// quote is labelled so it can never pass as a completed-bar price.
func buildEngineSnapshot(ctx context.Context, eng *tools.Engine, a queue.Agent) (json.RawMessage, error) {
	var chart struct {
		Candles    []map[string]any `json:"candles"`
		Signal     map[string]any   `json:"signal"`
		Supertrend []struct {
			Value float64 `json:"value"`
			Trend string  `json:"trend"`
		} `json:"supertrend"`
		AxisGate map[string]any `json:"axisGate"`
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
	snap := map[string]any{
		"instrument": a.Instrument, "granularity": a.Granularity, "event": "operator",
		"asOf": last["time"], "close": last["close"], "candles": done,
		"quote": map[string]any{"last": chart.Quote["last"], "provisional": chart.Quote["partial"]},
		"flip":  chart.Signal,
		"portfolio": map[string]any{
			"equity": pf.Portfolio["equity"], "cash": pf.Portfolio["cash"], "halted": pf.Portfolio["halted"], "positions": pf.Portfolio["positions"],
		},
		"strategy":   map[string]any{"name": chart.BotState["strategyRef"]},
		"capturedAt": time.Now().UTC().Format(time.RFC3339),
	}
	if chart.AxisGate != nil {
		snap["axisGate"] = chart.AxisGate
	}
	// indicator levels a strategy prompt refers to (ATR, EMAs, Bollinger, recent extremes); a failure only omits them
	var ind struct {
		Indicators map[string]any `json:"indicators"`
	}
	if err := eng.Get(ctx, "/api/indicators", q, &ind); err == nil && ind.Indicators != nil {
		snap["indicators"] = ind.Indicators
	}
	// advisory context the old bot also saw; a failure only omits it
	var dc struct {
		TraderMemories any `json:"traderMemories"`
		Sentinel       any `json:"sentinel"`
	}
	if err := eng.Get(ctx, "/api/decision-context", url.Values{"instrument": {a.Instrument}}, &dc); err == nil {
		if dc.TraderMemories != nil {
			snap["traderMemories"] = dc.TraderMemories
		}
		if dc.Sentinel != nil {
			snap["sentinel"] = dc.Sentinel
		}
	}
	if n := len(chart.Supertrend); n > 0 {
		snap["supertrend"], snap["trend"] = chart.Supertrend[n-1].Value, chart.Supertrend[n-1].Trend
	}
	return json.Marshal(snap)
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

// withStrategy puts the agent's strategy into a snapshot. The agent's strategy
// name picks the active, unarchived version from the imported history, so a
// research run judges entry conditions with the same rules the old bot used.
func (s *Server) withStrategy(ctx context.Context, payload json.RawMessage, a queue.Agent) (json.RawMessage, error) {
	if a.StrategyName == "" {
		return payload, nil
	}
	var name, prompt string
	var version int
	err := s.st.Pool.QueryRow(ctx, `SELECT name, version, prompt FROM strategies WHERE name=$1 AND NOT archived ORDER BY active DESC, version DESC LIMIT 1`, a.StrategyName).Scan(&name, &version, &prompt)
	if err != nil {
		return payload, nil // no imported strategy of that name: keep the engine's own label
	}
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		return nil, err
	}
	if m == nil {
		return nil, errors.New("snapshot payload must be a JSON object")
	}
	m["strategy"] = map[string]any{"name": name, "version": version, "prompt": prompt}
	return marshalSnapshot(m)
}

// marshalSnapshot encodes a snapshot payload without HTML escaping. json.Marshal
// would grow each <, > and & in a prompt to 6 bytes and can push it over the size cap.
func marshalSnapshot(m map[string]any) (json.RawMessage, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(m); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
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
	if out, err := marshalSnapshot(m); err == nil {
		return out
	}
	return payload
}

// WakeEnricher gives the position monitor the same strategy and indicator context
// an entry check gets, so a tripwire wake judges with the numbers the entry used.
func (s *Server) WakeEnricher() func(context.Context, queue.Agent, json.RawMessage) (json.RawMessage, error) {
	return func(ctx context.Context, a queue.Agent, p json.RawMessage) (json.RawMessage, error) {
		out, err := s.withStrategy(ctx, p, a)
		if err != nil {
			return p, err
		}
		return s.withIndicators(ctx, a.Instrument, a.Granularity, out), nil
	}
}
