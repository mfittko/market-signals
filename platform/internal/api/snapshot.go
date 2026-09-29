package api

import (
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
		if ok, _ := c["complete"].(bool); ok {
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
	if n := len(chart.Supertrend); n > 0 {
		snap["supertrend"], snap["trend"] = chart.Supertrend[n-1].Value, chart.Supertrend[n-1].Trend
	}
	return json.Marshal(snap)
}
