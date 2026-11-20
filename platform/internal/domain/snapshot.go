package domain

import (
	"bytes"
	"encoding/json"
)

// SnapshotFields are the fields every run path shares. A nil field is left out.
type SnapshotFields struct {
	Instrument, Granularity, Event string

	AsOf, Close, Quote, Flip, Trend, Supertrend, Candles, Portfolio any
	AxisGate, TraderMemories, Sentinel, Indicators, EngineStrategy  any
}

// Snapshot builds the shared snapshot fields. Engine events, operator triggers and
// position wakes all build through it, so every run hands the agent one shape; a
// path adds its own fields to the returned map. The governing strategy is not a
// snapshot field: the queue sets it per run when a worker claims the run.
func Snapshot(f SnapshotFields) map[string]any {
	m := map[string]any{"instrument": f.Instrument, "granularity": f.Granularity, "event": f.Event}
	for k, v := range map[string]any{
		"asOf": f.AsOf, "close": f.Close, "quote": f.Quote, "flip": f.Flip, "trend": f.Trend, "supertrend": f.Supertrend,
		"candles": f.Candles, "portfolio": f.Portfolio, "axisGate": f.AxisGate, "traderMemories": f.TraderMemories,
		"sentinel": f.Sentinel, "indicators": f.Indicators, "engineStrategy": f.EngineStrategy,
	} {
		if v != nil {
			m[k] = v
		}
	}
	return m
}

// EncodeSnapshot encodes a snapshot payload without HTML escaping. json.Marshal
// would grow each <, > and & in a prompt to 6 bytes and can push it over the size cap.
func EncodeSnapshot(v any) (json.RawMessage, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}
